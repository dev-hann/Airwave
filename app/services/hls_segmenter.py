from __future__ import annotations

import logging
import re
import shutil
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.services.ffmpeg_pipeline import FfmpegError

logger = logging.getLogger(__name__)

# Only filenames the packager itself produces may be served back; this also
# blocks path traversal ("..", absolute paths, subdirectories).
_SEGMENT_NAME_RE = re.compile(r"^seg[0-9]{1,12}\.ts$")
_EXTINF_RE = re.compile(r"^#EXTINF:([0-9]+(?:\.[0-9]+)?)")
_SEGMENT_FILE_RE = re.compile(r"^seg[0-9]{1,12}\.ts$")

_HLS_MIME = "application/vnd.apple.mpegurl"


@dataclass
class _WindowEntry:
    sequence: int
    filename: str
    duration: float
    discontinuity: bool


class _PackagerSpawner(Protocol):
    def __call__(self, playlist_path: str, segment_pattern: str, *, start_number: int) -> object: ...


class HlsSegmenter:
    """Owns the single HLS packager that turns the engine's continuous MP3
    byte stream into a sliding window of AAC MPEG-TS segments.

    The engine feeds one long-running ``ffmpeg -f mp3 -i pipe:0 ... -f hls``
    process. Because every per-track decoder emits the same codec parameters,
    the packager sees one seamless MP3 stream and track switches need no
    discontinuity handling. Control interrupts (skip/seek/stop) call
    :meth:`purge` so listeners jump to the new position immediately.
    """

    def __init__(
        self,
        spawn_packager: _PackagerSpawner,
        *,
        segment_seconds: float = 4.0,
        window_size: int = 12,
        listener_ttl_seconds: float = 30.0,
        directory: str | None = None,
    ) -> None:
        self._spawn_packager = spawn_packager
        self._segment_seconds = max(0.5, float(segment_seconds))
        self._window_size = max(3, int(window_size))
        self._listener_ttl_seconds = float(listener_ttl_seconds)
        self._dir = Path(directory or tempfile.mkdtemp(prefix="airwave-hls-"))
        self._dir.mkdir(parents=True, exist_ok=True)
        self._playlist_path = self._dir / "index.m3u8"
        self._segment_pattern = str(self._dir / "seg%010d.ts")

        self._lock = threading.Lock()
        self._packager: object | None = None
        self._entries: deque[_WindowEntry] = deque()
        self._next_sequence = 0
        self._parsed_filenames: set[str] = set()
        self._discontinuity_pending = False

        self._listener_lock = threading.Lock()
        self._listeners: dict[str, float] = {}

    # ------------------------------------------------------------------ feed

    def write(self, data: bytes) -> None:
        """Feed MP3 bytes into the packager (spawning it on first use)."""
        if not data:
            return
        with self._lock:
            if self._packager is None:
                self._spawn_packager_locked()
            stdin = getattr(self._packager, "stdin", None)
            try:
                stdin.write(data)  # type: ignore[union-attr]
            except (BrokenPipeError, ValueError, OSError):
                # Packager died (crash or purge racing this write). One stale
                # chunk may land at the head of the restarted packager right
                # after an interrupt; that is <=0.1s of audio and preferable
                # to dropping the whole live pipeline.
                self._respawn_packager_locked()
                stdin = getattr(self._packager, "stdin", None)
                if stdin is None:
                    return
                try:
                    stdin.write(data)  # type: ignore[union-attr]
                except (BrokenPipeError, ValueError, OSError):
                    logger.error("HLS packager refused write after respawn; dropping chunk")

    def purge(self) -> None:
        """Drop the visible window (control interrupt): kill the packager,
        wipe segments, and mark the next segment with a discontinuity so
        players reset their timeline to the new playback position."""
        with self._lock:
            # Capture final playlist state first so global sequence numbering
            # stays ahead of anything the packager already emitted.
            self._sync_packager_playlist_locked()
            had_content = bool(self._entries) or self._next_sequence > 0
            self._terminate_packager_locked()
            self._entries.clear()
            self._parsed_filenames.clear()
            self._delete_segment_files_locked()
            try:
                self._playlist_path.unlink(missing_ok=True)
            except OSError:
                pass
            if had_content:
                self._discontinuity_pending = True

    def close(self) -> None:
        with self._lock:
            self._terminate_packager_locked()
            self._entries.clear()
        shutil.rmtree(self._dir, ignore_errors=True)

    # -------------------------------------------------------------- playlist

    def playlist_text(self) -> str:
        with self._lock:
            self._sync_packager_playlist_locked()
            return self._render_playlist_locked()

    def segment_path(self, name: str) -> Path | None:
        if not _SEGMENT_NAME_RE.match(name):
            return None
        with self._lock:
            self._sync_packager_playlist_locked()
            for entry in self._entries:
                if entry.filename == name:
                    path = self._dir / entry.filename
                    return path if path.is_file() else None
        return None

    def segment_mime_type(self) -> str:
        return "video/mp2t"

    # ------------------------------------------------------------- listeners

    def note_listener(self, client_key: str) -> None:
        now = time.monotonic()
        with self._listener_lock:
            self._listeners[client_key] = now
            self._prune_listeners_locked(now)

    def listener_count(self) -> int:
        now = time.monotonic()
        with self._listener_lock:
            self._prune_listeners_locked(now)
            return len(self._listeners)

    def _prune_listeners_locked(self, now: float) -> None:
        expired = [key for key, seen_at in self._listeners.items() if now - seen_at > self._listener_ttl_seconds]
        for key in expired:
            self._listeners.pop(key, None)

    # -------------------------------------------------------------- internals

    def _spawn_packager_locked(self) -> None:
        try:
            self._packager = self._spawn_packager(
                str(self._playlist_path),
                self._segment_pattern,
                start_number=self._next_sequence,
            )
        except FfmpegError:
            logger.exception("Failed to spawn HLS packager")
            self._packager = None

    def _respawn_packager_locked(self) -> None:
        # Sync before replacing the corpse: the dead packager's playlist file
        # may reference segments we have not folded into global numbering yet.
        self._sync_packager_playlist_locked()
        logger.warning("HLS packager died mid-stream; respawning at sequence %s", self._next_sequence)
        self._terminate_packager_locked()
        self._spawn_packager_locked()

    def _terminate_packager_locked(self) -> None:
        packager = self._packager
        self._packager = None
        if packager is None:
            return
        stdin = getattr(packager, "stdin", None)
        if stdin is not None:
            try:
                stdin.close()
            except (BrokenPipeError, ValueError, OSError):
                pass
        try:
            packager.terminate()  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            packager.wait(timeout=1)  # type: ignore[attr-defined]
        except Exception:
            pass

    def _delete_segment_files_locked(self) -> None:
        try:
            children = list(self._dir.iterdir())
        except OSError:
            return
        for child in children:
            if child.is_file() and _SEGMENT_FILE_RE.match(child.name):
                try:
                    child.unlink(missing_ok=True)
                except OSError:
                    logger.debug("Could not delete segment file %s", child)

    def _sync_packager_playlist_locked(self) -> None:
        """Diff the packager's own index.m3u8 into our window state."""
        if self._packager is None or not self._playlist_path.is_file():
            return
        try:
            text = self._playlist_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        pending_duration: float | None = None
        for line in text.splitlines():
            line = line.strip()
            match = _EXTINF_RE.match(line)
            if match:
                try:
                    pending_duration = float(match.group(1))
                except ValueError:
                    pending_duration = None
                continue
            if not _SEGMENT_FILE_RE.match(line):
                continue
            filename = line
            if filename in self._parsed_filenames:
                pending_duration = None
                continue
            self._parsed_filenames.add(filename)
            duration = self._segment_seconds if pending_duration is None else pending_duration
            discontinuity = self._discontinuity_pending
            self._discontinuity_pending = False
            self._entries.append(
                _WindowEntry(
                    sequence=self._next_sequence,
                    filename=filename,
                    duration=duration,
                    discontinuity=discontinuity,
                )
            )
            self._next_sequence += 1
            pending_duration = None
        while len(self._entries) > self._window_size:
            dropped = self._entries.popleft()
            try:
                (self._dir / dropped.filename).unlink(missing_ok=True)
            except OSError:
                logger.debug("Could not delete pruned segment %s", dropped.filename)

    def _render_playlist_locked(self) -> str:
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-INDEPENDENT-SEGMENTS",
        ]
        if self._entries:
            target = max(int(round(entry.duration)) for entry in self._entries) or 1
            lines.append(f"#EXT-X-TARGETDURATION:{target}")
            lines.append(f"#EXT-X-MEDIA-SEQUENCE:{self._entries[0].sequence}")
            for entry in self._entries:
                if entry.discontinuity:
                    lines.append("#EXT-X-DISCONTINUITY")
                lines.append(f"#EXTINF:{entry.duration:.3f},")
                lines.append(entry.filename)
        else:
            target = max(1, int(round(self._segment_seconds)))
            lines.append(f"#EXT-X-TARGETDURATION:{target}")
            lines.append(f"#EXT-X-MEDIA-SEQUENCE:{self._next_sequence}")
        # No #EXT-X-ENDLIST: this is a live window.
        return "\n".join(lines) + "\n"
