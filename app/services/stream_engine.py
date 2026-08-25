from __future__ import annotations

import logging
import os
import random
import subprocess
import tempfile
import threading
import time
from collections import deque
from typing import Callable

from app.db.models import QueueStatus
from app.db.repository import NewQueueItem, Repository
from app.domain.outcomes import (
    AttemptOutcome,
    completed_unusually_fast,
)
from app.domain.playback_state import PlaybackMode, PlaybackState, RepeatMode
from app.domain.progress import playback_progress as _domain_playback_progress
from app.domain.repeat_cycle import RepeatCycleItem, new_item_fields, repeat_cycle_item_from
from app.domain.seek import seconds_from_percent
from app.lib.tools import format_byte_size
from app.services.ffmpeg_pipeline import FfmpegError, FfmpegPipeline
from app.services.hls_segmenter import HlsSegmenter
from app.services.yt_dlp_service import ResolvedTrack, YtDlpError, YtDlpService
from app.usecases.play_track import TrackAttemptRequest, TrackAttemptRunner

# Compatibility re-exports: external code imports these from stream_engine.
__all__ = ["StreamEngine", "PlaybackMode", "PlaybackState", "RepeatMode"]

logger = logging.getLogger(__name__)


class _EngineAttemptHooks:
    """Adapter exposing StreamEngine capabilities to TrackAttemptRunner
    under the AttemptHooks protocol (clean-architecture boundary)."""

    def __init__(self, engine: StreamEngine) -> None:
        self._engine = engine

    def resolve_track(self, item, force_refresh: bool) -> ResolvedTrack:
        return self._engine._resolve_track_for_item(item, force_refresh=force_refresh)  # noqa: SLF001

    def on_resolved_metadata(self, resolved: ResolvedTrack) -> None:
        engine = self._engine
        if resolved.thumbnail_url:
            engine.state.now_playing_thumbnail_url = resolved.thumbnail_url
        if resolved.channel:
            engine.state.now_playing_channel = resolved.channel
        engine.state.now_playing_is_live = resolved.is_live

    def mark_item_resolved(self, item_id: int, normalized_url: str) -> None:
        self._engine.repository.mark_item_resolved(item_id, normalized_url)

    def remember_resolved(self, resolved: ResolvedTrack) -> None:
        self._engine._remember_recent_resolved_track(resolved)  # noqa: SLF001

    def consume_seek(self, default_seconds: float) -> float:
        return self._engine._consume_pending_seek_seconds(default=default_seconds)  # noqa: SLF001

    def set_playback_offset(self, seconds: float) -> None:
        self._engine._set_playback_offset_seconds(seconds)  # noqa: SLF001

    def get_prefetched_audio(self, item_id: int) -> str | None:
        return self._engine._get_prefetched_audio_path(item_id)  # noqa: SLF001

    def prefetch_audio(self, item_id: int, source_url: str) -> None:
        self._engine._prefetch_audio_for_item(item_id, source_url, register_active=True)  # noqa: SLF001

    def uses_direct_ffmpeg(self, item) -> bool:
        return self._engine._item_uses_direct_ffmpeg(item)  # noqa: SLF001

    def register_active_process(self, process: object) -> None:
        self._engine._set_active_processes(process, None)  # noqa: SLF001

    def trigger_prefetch_upcoming(self) -> None:
        self._engine._trigger_prefetch_upcoming_tracks()  # noqa: SLF001

    def notify_state_changed(self) -> None:
        self._engine._notify_state_changed()  # noqa: SLF001

    def start_transition_silence(self) -> tuple[object, object]:
        stop_event, worker = self._engine._start_transition_silence()  # noqa: SLF001
        return (stop_event, worker) if stop_event is not None and worker is not None else (None, None)

    def stop_transition_silence(self, stop_event: object, worker: object) -> None:
        self._engine._stop_transition_silence(stop_event, worker)  # type: ignore[arg-type]  # noqa: SLF001

    def on_first_chunk(self) -> None:
        self._engine._trigger_prefetch_upcoming_tracks()  # noqa: SLF001

    def write_chunk(self, chunk: bytes) -> None:
        self._engine._write_stream(chunk)  # noqa: SLF001

    def check_interrupt(self) -> str | None:
        engine = self._engine
        if engine._stop_event.is_set():  # noqa: SLF001
            return "stop"
        if engine._skip_event.is_set():  # noqa: SLF001
            return "skip"
        return None

    def consume_interrupt_reason(self) -> str:
        return self._engine._consume_interrupt_reason()  # noqa: SLF001


class StreamEngine:
    def __init__(
        self,
        repository: Repository,
        yt_dlp_service: YtDlpService,
        ffmpeg_pipeline: FfmpegPipeline,
        chunk_size: int = 4096,
        queue_poll_seconds: float = 1.0,
        playback_retry_count: int = 2,
        stats_log_seconds: float = 15.0,
        hls_segment_seconds: float = 4.0,
        hls_window_size: int = 12,
        hls_bitrate: str = "192k",
        hls_segmenter: HlsSegmenter | None = None,
        on_state_change: Callable[[], None] | None = None,
        clock: Callable[[], float] | None = None,
        sleeper: Callable[[float], None] | None = None,
    ) -> None:
        self.repository = repository
        self.yt_dlp_service = yt_dlp_service
        self.ffmpeg_pipeline = ffmpeg_pipeline
        self.chunk_size = chunk_size
        self.queue_poll_seconds = queue_poll_seconds
        self.playback_retry_count = max(0, playback_retry_count)
        self.stats_log_seconds = max(1.0, stats_log_seconds)
        self.state = PlaybackState()
        self._clock = clock or time.monotonic
        self._sleeper = sleeper or time.sleep
        self._attempt_runner = TrackAttemptRunner(
            transcoder=ffmpeg_pipeline,
            clock=self._clock,
            chunk_size=chunk_size,
        )
        self._attempt_hooks = _EngineAttemptHooks(self)
        self.segmenter = hls_segmenter or HlsSegmenter(
            lambda playlist_path, segment_pattern, *, start_number: ffmpeg_pipeline.spawn_hls_packager(
                playlist_path,
                segment_pattern,
                start_number=start_number,
                segment_seconds=hls_segment_seconds,
                hls_bitrate=hls_bitrate,
            ),
            segment_seconds=hls_segment_seconds,
            window_size=hls_window_size,
        )
        self._stop_event = threading.Event()
        self._skip_event = threading.Event()
        self._control_lock = threading.Lock()
        self._control_reason: str | None = None
        self._pending_seek_seconds: float | None = None
        self._worker: threading.Thread | None = None
        self._stats_worker: threading.Thread | None = None
        self._process_lock = threading.Lock()
        self._active_process: subprocess.Popen[bytes] | None = None
        self._active_source_process: subprocess.Popen[bytes] | None = None
        self._stats_lock = threading.Lock()
        self._total_bytes_streamed = 0
        self._total_chunks_streamed = 0
        self._tracks_completed = 0
        self._tracks_failed = 0
        self._tracks_skipped = 0
        self._on_state_change = on_state_change
        self._repeat_cycle_items: list[RepeatCycleItem] = []
        self._shuffle_restore_order: list[int] | None = None
        self._prefetch_next_count = 2
        self._prefetch_previous_count = 2
        self._resolved_cache_lock = threading.Lock()
        self._resolved_track_cache: dict[int, ResolvedTrack] = {}
        self._recent_resolved_by_url: dict[str, ResolvedTrack] = {}
        self._recent_resolved_order: deque[str] = deque()
        self._prefetched_audio_cache: dict[int, str] = {}
        self._prefetched_audio_dir = tempfile.mkdtemp(prefix="airwave-prefetch-")
        self._prefetch_thread: threading.Thread | None = None
        self._user_stopped = False

    def _notify_state_changed(self) -> None:
        if self._on_state_change is None:
            return
        try:
            self._on_state_change()
        except Exception:
            logger.exception("Failed to publish stream state change event")

    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._stop_event.clear()
        self._worker = threading.Thread(target=self._run, daemon=True, name="stream-engine")
        self._worker.start()
        self._stats_worker = threading.Thread(target=self._log_stats_loop, daemon=True, name="stream-engine-stats")
        self._stats_worker.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._request_interrupt("stop")
        if self._worker:
            self._worker.join(timeout=3)
        if self._stats_worker:
            self._stats_worker.join(timeout=3)
        self._clear_prefetched_audio_cache()
        try:
            self.segmenter.close()
        except Exception:
            logger.exception("Failed to close HLS segmenter")

    def skip_current(self) -> None:
        self._request_interrupt("skip")

    def stop_playback(self) -> None:
        """Halt playback without advancing to the next track.

        The currently-playing item is re-enqueued at the front so a
        subsequent ``resume_playback`` picks it up.  The engine
        transitions to an idle cycle that stays silent until explicitly
        resumed.
        """
        self._user_stopped = True
        self._request_interrupt("user_stop")

    def resume_playback(self) -> str:
        """Resume playback from a pause.

        * If paused: unpause.
        * If user-stopped (idle with queue): clear the stop flag and
          wake the idle cycle so the next queued item starts.
        * If idle with an empty queue: re-enqueue the last history item
          and wake the idle cycle (\"resume last media\").

        Returns a short label describing what happened.
        """
        if self.state.paused:
            self.toggle_pause()
            return "resumed"

        if self._user_stopped:
            self._user_stopped = False
            self._request_interrupt("resume_from_stop")
            return "resumed_from_stop"

        if self.state.mode == PlaybackMode.idle:
            history = self.repository.list_history(limit=1)
            if not history:
                return "noop"
            previous = history[0]
            queued = self.repository.enqueue_items(
                [
                    NewQueueItem(
                        source_url=previous.source_url or "unknown",
                        provider=getattr(previous, "provider", None),
                        provider_item_id=getattr(previous, "provider_item_id", None),
                        normalized_url=getattr(previous, "normalized_url", None)
                        or previous.source_url,
                        source_type=getattr(previous, "source_type", None) or "unknown",
                        title=getattr(previous, "title", None) or previous.source_url,
                        channel=getattr(previous, "channel", None),
                        duration_seconds=getattr(previous, "duration_seconds", None),
                        thumbnail_url=getattr(previous, "thumbnail_url", None),
                    )
                ]
            )
            if queued:
                self.repository.move_item_to_front(queued[0].id)
                self._seed_resolved_cache_from_recent(queued[0].id, previous.source_url)
            self._request_interrupt("resume_from_stop")
            self._notify_state_changed()
            return "resume_last"

        return "noop"

    def set_repeat_mode(self, mode: str) -> str:
        try:
            repeat_mode = RepeatMode(mode)
        except ValueError as exc:
            raise ValueError("Invalid repeat mode") from exc
        self.state.repeat_mode = repeat_mode
        self._notify_state_changed()
        return self.state.repeat_mode.value

    def set_shuffle_enabled(self, enabled: bool) -> bool:
        enabled = bool(enabled)
        queued_ids = self.repository.list_queued_ids()

        if enabled and not self.state.shuffle_enabled:
            self._shuffle_restore_order = list(queued_ids)
            shuffled_ids = list(queued_ids)
            if len(shuffled_ids) > 1:
                random.shuffle(shuffled_ids)
                self.repository.reorder_queued_items(shuffled_ids)
        elif not enabled and self.state.shuffle_enabled:
            restore_ids = list(self._shuffle_restore_order or [])
            if restore_ids:
                self.repository.reorder_queued_items(restore_ids)
            self._shuffle_restore_order = None

        self.state.shuffle_enabled = enabled
        self._notify_state_changed()
        return self.state.shuffle_enabled

    def toggle_pause(self) -> bool:
        if self.state.mode != PlaybackMode.playing:
            return False
        if self.state.paused:
            elapsed = self.playback_progress()["elapsed_seconds"]
            target = float(elapsed or 0.0)
            self.state.paused = False
            self.state.paused_elapsed_seconds = None
            self._set_playback_offset_seconds(target)
            self._set_pending_seek_seconds(target)
            self._notify_state_changed()
            self._request_interrupt("resume")
            return False
        elapsed = self.playback_progress()["elapsed_seconds"]
        self.state.paused = True
        self.state.paused_elapsed_seconds = float(elapsed or 0.0)
        self._notify_state_changed()
        self._request_interrupt("pause")
        return True

    def seek_to_percent(self, percent: float) -> bool:
        duration_seconds = self.state.now_playing_duration_seconds
        if duration_seconds is None or duration_seconds <= 0:
            return False
        return self.seek_to_seconds(seconds_from_percent(percent, float(duration_seconds)))

    def seek_to_seconds(self, seconds: float) -> bool:
        if self.state.mode != PlaybackMode.playing:
            return False
        duration_seconds = self.state.now_playing_duration_seconds
        target_seconds = max(0.0, float(seconds))
        if duration_seconds is not None and duration_seconds > 0:
            target_seconds = min(target_seconds, float(duration_seconds))
        self._set_pending_seek_seconds(target_seconds)
        self._set_playback_offset_seconds(target_seconds)
        if self.state.paused:
            self.state.paused_elapsed_seconds = target_seconds
            self._notify_state_changed()
            return True
        self._notify_state_changed()
        self._request_interrupt("seek")
        return True

    def play_previous_or_restart(self, restart_threshold_seconds: float = 5.0) -> str:
        elapsed = float(self.playback_progress()["elapsed_seconds"] or 0.0)
        if self.state.mode == PlaybackMode.playing and elapsed > restart_threshold_seconds:
            self.seek_to_seconds(0.0)
            return "restarted"
        history = self.repository.list_history(limit=1)
        if not history:
            if self.state.mode == PlaybackMode.playing:
                self.seek_to_seconds(0.0)
                return "restarted"
            return "noop"
        previous = history[0]
        queued = self.repository.enqueue_items(
            [
                NewQueueItem(
                    source_url=previous.source_url,
                    provider=getattr(previous, "provider", None),
                    provider_item_id=getattr(previous, "provider_item_id", None),
                    normalized_url=getattr(previous, "normalized_url", None) or previous.source_url,
                    source_type=getattr(previous, "source_type", None) or "unknown",
                    title=previous.title,
                    channel=getattr(previous, "channel", None),
                    duration_seconds=getattr(previous, "duration_seconds", None),
                    thumbnail_url=getattr(previous, "thumbnail_url", None),
                )
            ]
        )
        if queued:
            self.repository.move_item_to_front(queued[0].id)
            self._seed_resolved_cache_from_recent(queued[0].id, previous.source_url)
        if self.state.mode == PlaybackMode.playing:
            self._request_interrupt("previous")
        self._notify_state_changed()
        return "previous"

    def _cache_resolved_track(self, item_id: int, resolved: ResolvedTrack) -> None:
        with self._resolved_cache_lock:
            self._resolved_track_cache[item_id] = resolved

    def _get_cached_resolved_track(self, item_id: int) -> ResolvedTrack | None:
        with self._resolved_cache_lock:
            return self._resolved_track_cache.get(item_id)

    def _drop_cached_resolved_track(self, item_id: int) -> None:
        with self._resolved_cache_lock:
            self._resolved_track_cache.pop(item_id, None)

    def _cache_prefetched_audio_path(self, item_id: int, path: str) -> None:
        with self._resolved_cache_lock:
            previous = self._prefetched_audio_cache.get(item_id)
            self._prefetched_audio_cache[item_id] = path
        if previous and previous != path:
            self._remove_prefetched_audio_file(previous)

    def _get_prefetched_audio_path(self, item_id: int) -> str | None:
        with self._resolved_cache_lock:
            path = self._prefetched_audio_cache.get(item_id)
        if path is None:
            return None
        if os.path.exists(path):
            return path
        with self._resolved_cache_lock:
            self._prefetched_audio_cache.pop(item_id, None)
        return None

    def _drop_prefetched_audio_path(self, item_id: int) -> None:
        with self._resolved_cache_lock:
            path = self._prefetched_audio_cache.pop(item_id, None)
        if path is not None:
            self._remove_prefetched_audio_file(path)

    @staticmethod
    def _remove_prefetched_audio_file(path: str) -> None:
        try:
            os.remove(path)
        except FileNotFoundError:
            return
        except Exception:
            logger.debug("Failed removing prefetched audio file %s", path, exc_info=True)

    def _clear_prefetched_audio_cache(self) -> None:
        with self._resolved_cache_lock:
            cached_paths = list(self._prefetched_audio_cache.values())
            self._prefetched_audio_cache.clear()
        for path in cached_paths:
            self._remove_prefetched_audio_file(path)
        try:
            os.rmdir(self._prefetched_audio_dir)
        except OSError:
            return

    def _prefetch_audio_for_item(
        self,
        queue_item_id: int,
        source_url: str,
        *,
        register_active: bool = False,
    ) -> None:
        if self._get_prefetched_audio_path(queue_item_id) is not None:
            logger.debug("Prefetch skip item %s (already cached)", queue_item_id)
            return
        temp_path = os.path.join(self._prefetched_audio_dir, f"{queue_item_id}.bin")
        logger.debug("Prefetching audio for item %s from %s to %s", queue_item_id, source_url, temp_path)
        source_process = self.yt_dlp_service.spawn_audio_download(source_url, temp_path)
        if register_active:
            self._set_active_processes(None, source_process)
        try:
            while True:
                if register_active and (self._stop_event.is_set() or self._skip_event.is_set()):
                    raise InterruptedError(self._consume_interrupt_reason("stop"))
                return_code = self._process_return_code(source_process)
                if return_code is not None:
                    break
                self._sleeper(0.05)
            stderr_pipe = getattr(source_process, "stderr", None)
            stderr_text = (
                stderr_pipe.read().decode("utf-8", errors="replace").strip()
                if stderr_pipe is not None
                else ""
            )
            if return_code != 0:
                raise YtDlpError(stderr_text or f"yt-dlp exited with status {return_code}")
            if not os.path.exists(temp_path) or os.path.getsize(temp_path) <= 0:
                raise YtDlpError("yt-dlp prefetch returned empty audio stream")
            self._cache_prefetched_audio_path(queue_item_id, temp_path)
            logger.debug("Prefetched audio for item %s from %s to %s successfully", queue_item_id, source_url, temp_path)
        except Exception:
            self._remove_prefetched_audio_file(temp_path)
            logger.debug("Failed prefetching audio for item %s from %s to %s", queue_item_id, source_url, temp_path)
            raise
        finally:
            self._terminate_process(source_process)
            if register_active:
                self._set_active_processes(None, None)

    def _remember_recent_resolved_track(self, resolved: ResolvedTrack) -> None:
        key = resolved.normalized_url
        with self._resolved_cache_lock:
            if key in self._recent_resolved_order:
                self._recent_resolved_order.remove(key)
            self._recent_resolved_order.append(key)
            self._recent_resolved_by_url[key] = resolved
            while len(self._recent_resolved_order) > self._prefetch_previous_count:
                stale_key = self._recent_resolved_order.popleft()
                self._recent_resolved_by_url.pop(stale_key, None)

    def _seed_resolved_cache_from_recent(self, item_id: int, source_url: str) -> None:
        normalized_url = self.yt_dlp_service.normalize_url(source_url)
        with self._resolved_cache_lock:
            cached = self._recent_resolved_by_url.get(normalized_url)
            if cached is None:
                return
            self._resolved_track_cache[item_id] = cached

    @staticmethod
    def _item_uses_direct_ffmpeg(queue_item) -> bool:
        provider = getattr(queue_item, "provider", None)
        if provider in ("direct", "local"):
            return True
        source_type = getattr(queue_item, "source_type", None)
        return source_type in ("remote_audio", "local_file")

    def _resolve_track_for_item(self, queue_item, *, force_refresh: bool) -> ResolvedTrack:
        if not force_refresh:
            cached = self._get_cached_resolved_track(queue_item.id)
            if cached is not None:
                return cached
        if self._item_uses_direct_ffmpeg(queue_item):
            direct_stream_url = queue_item.normalized_url or queue_item.source_url
            resolved = ResolvedTrack(
                source_url=queue_item.source_url,
                normalized_url=queue_item.normalized_url,
                title=queue_item.title,
                channel=queue_item.channel,
                duration_seconds=queue_item.duration_seconds,
                thumbnail_url=queue_item.thumbnail_url,
                stream_url=direct_stream_url,
                provider=queue_item.provider or "direct",
                provider_item_id=queue_item.provider_item_id,
                is_live=False,
                item_source_type=getattr(queue_item, "source_type", None),
            )
            self._cache_resolved_track(queue_item.id, resolved)
            return resolved
        resolved = self.yt_dlp_service.resolve_video(queue_item.source_url, force_refresh=force_refresh)
        self._cache_resolved_track(queue_item.id, resolved)
        return resolved

    def _prefetch_upcoming_tracks(self) -> None:
        try:
            queue_items = self.repository.list_queue()
            queued_items = [item for item in queue_items if item.status == QueueStatus.queued][: self._prefetch_next_count]
            for queued_item in queued_items:
                if self._get_cached_resolved_track(queued_item.id) is not None:
                    continue
                if self._item_uses_direct_ffmpeg(queued_item):
                    try:
                        resolved = self._resolve_track_for_item(queued_item, force_refresh=False)
                    except Exception:
                        logger.debug("Failed prefetching direct item %s", queued_item.id, exc_info=True)
                        continue
                    self._remember_recent_resolved_track(resolved)
                    continue
                try:
                    resolved = self.yt_dlp_service.resolve_video(queued_item.source_url)
                except Exception:
                    logger.debug("Failed prefetching queued track %s", queued_item.id, exc_info=True)
                    continue
                self._cache_resolved_track(queued_item.id, resolved)
                try:
                    self._prefetch_audio_for_item(queued_item.id, queued_item.source_url)
                except Exception:
                    logger.debug("Failed prefetching queued audio %s", queued_item.id, exc_info=True)
        finally:
            with self._resolved_cache_lock:
                self._prefetch_thread = None

    def _trigger_prefetch_upcoming_tracks(self) -> None:
        with self._resolved_cache_lock:
            if self._prefetch_thread is not None and self._prefetch_thread.is_alive():
                return
            self._prefetch_thread = threading.Thread(
                target=self._prefetch_upcoming_tracks,
                daemon=True,
                name="stream-engine-prefetch",
            )
            self._prefetch_thread.start()

    def playback_progress(self) -> dict[str, float | int | None]:
        return _domain_playback_progress(self.state, self._clock())

    def runtime_stats(self) -> dict[str, float | int | str | None]:
        progress = self.playback_progress()
        stream_listeners = self.segmenter.listener_count()
        with self._stats_lock:
            total_bytes_streamed = self._total_bytes_streamed
            total_chunks_streamed = self._total_chunks_streamed
            tracks_completed = self._tracks_completed
            tracks_failed = self._tracks_failed
            tracks_skipped = self._tracks_skipped
        with self._resolved_cache_lock:
            cached_track_count = len(self._resolved_track_cache)
            recent_cache_count = len(self._recent_resolved_by_url)
            prefetched_audio_count = len(self._prefetched_audio_cache)
        return {
            "mode": self.state.mode.value,
            "queued_count": self.repository.queued_count(),
            "hls_stream_listeners": stream_listeners,
            "now_playing_id": self.state.now_playing_id,
            "now_playing_title": self.state.now_playing_title,
            "elapsed_seconds": progress["elapsed_seconds"],
            "duration_seconds": progress["duration_seconds"],
            "total_bytes_streamed": total_bytes_streamed,
            "total_chunks_streamed": total_chunks_streamed,
            "tracks_completed": tracks_completed,
            "tracks_failed": tracks_failed,
            "tracks_skipped": tracks_skipped,
            "cached_track_count": cached_track_count,
            "recent_cache_count": recent_cache_count,
            "prefetched_audio_count": prefetched_audio_count,
        }

    def get_current_stream_url(self) -> str | None:
        item_id = self.state.now_playing_id
        if item_id is None:
            return None

        cached = self._get_cached_resolved_track(item_id)
        if cached:
            return cached.stream_url

        item = self.repository.get_item(item_id)
        if not item:
            return None
        return item.resolved_stream_url or item.normalized_url or item.source_url

    def get_current_ffmpeg_input(self) -> str | None:
        """Prefer prefetched on-disk audio (same as live MP3) so PCM avoids a second remote demux."""
        item_id = self.state.now_playing_id
        if item_id is None:
            return None
        prefetched = self._get_prefetched_audio_path(item_id)
        if prefetched is not None:
            return prefetched
        return self.get_current_stream_url()

    def _record_streamed_chunk(self, chunk_size: int) -> None:
        with self._stats_lock:
            self._total_chunks_streamed += 1
            self._total_bytes_streamed += chunk_size

    def _write_stream(self, chunk: bytes) -> None:
        self.segmenter.write(chunk)
        self._record_streamed_chunk(len(chunk))

    # -------------------------------------------------------------- HLS facade

    def hls_playlist_text(self) -> str:
        return self.segmenter.playlist_text()

    def hls_segment_path(self, name: str) -> str | None:
        path = self.segmenter.segment_path(name)
        return str(path) if path is not None else None

    def note_stream_listener(self, client_key: str) -> None:
        self.segmenter.note_listener(client_key)

    def hls_segment_mime_type(self) -> str:
        return self.segmenter.segment_mime_type()

    def _record_track_outcome(self, *, completed: bool = False, failed: bool = False, skipped: bool = False) -> None:
        with self._stats_lock:
            if completed:
                self._tracks_completed += 1
            if failed:
                self._tracks_failed += 1
            if skipped:
                self._tracks_skipped += 1

    def _log_stats_loop(self) -> None:
        while not self._stop_event.wait(self.stats_log_seconds):
            stats = self.runtime_stats()
            track_label = (
                f'{stats["now_playing_id"]}:{stats["now_playing_title"]}'
                if stats["now_playing_id"] is not None
                else "none"
            )
            elapsed_seconds = stats["elapsed_seconds"]
            duration_seconds = stats["duration_seconds"]
            total_bytes = stats["total_bytes_streamed"]
            total_human = format_byte_size(total_bytes)
            if elapsed_seconds is None:
                progress_label = "n/a"
            elif duration_seconds:
                progress_label = f"{elapsed_seconds:.1f}s/{duration_seconds}s"
            else:
                progress_label = f"{elapsed_seconds:.1f}s"
            logger.info(
                "Engine stats mode=%s track=%s progress=%s hls_stream_listeners=%s queued=%s cache=%s recent_cache=%s prefetched_audio=%s total_bytes=%s (%s) total_chunks=%s completed=%s skipped=%s failed=%s",
                stats["mode"],
                track_label,
                progress_label,
                stats["hls_stream_listeners"],
                stats["queued_count"],
                stats["cached_track_count"],
                stats["recent_cache_count"],
                stats["prefetched_audio_count"],
                total_bytes,
                total_human,
                stats["total_chunks_streamed"],
                stats["tracks_completed"],
                stats["tracks_skipped"],
                stats["tracks_failed"],
            )

    def _set_active_processes(
        self,
        transcode_process: subprocess.Popen[bytes] | None,
        source_process: subprocess.Popen[bytes] | None = None,
    ) -> None:
        with self._process_lock:
            self._active_process = transcode_process
            self._active_source_process = source_process

    @staticmethod
    def _terminate_process(process: subprocess.Popen[bytes] | None) -> None:
        if process is None:
            return
        try:
            process.terminate()
            process.wait(timeout=1)
        except Exception:
            pass

    def _terminate_active_process(self) -> None:
        with self._process_lock:
            transcode_process = self._active_process
            source_process = self._active_source_process
        self._terminate_process(transcode_process)
        self._terminate_process(source_process)

    def _start_transition_silence(self) -> tuple[threading.Event | None, threading.Thread | None]:
        if self._stop_event.is_set() or self._skip_event.is_set():
            return None, None
        stop_event = threading.Event()

        def _publish_silence() -> None:
            while not stop_event.is_set() and not self._stop_event.is_set():
                if self._skip_event.is_set():
                    return
                try:
                    process = self.ffmpeg_pipeline.spawn_silence()
                except FfmpegError as exc:
                    logger.error("%s", exc)
                    return
                try:
                    while not stop_event.is_set() and not self._stop_event.is_set():
                        if self._skip_event.is_set():
                            return
                        chunk = self.ffmpeg_pipeline.read_chunk(process.stdout, self.chunk_size)
                        if not chunk:
                            break
                        if stop_event.is_set() or self._stop_event.is_set() or self._skip_event.is_set():
                            return
                        self._write_stream(chunk)
                finally:
                    self._terminate_process(process)

        worker = threading.Thread(
            target=_publish_silence,
            daemon=True,
            name="stream-engine-transition-silence",
        )
        worker.start()
        return stop_event, worker

    @staticmethod
    def _stop_transition_silence(
        stop_event: threading.Event | None,
        worker: threading.Thread | None,
    ) -> None:
        if stop_event is not None:
            stop_event.set()
        if worker is not None and worker.is_alive():
            worker.join(timeout=1)

    def _set_playback_offset_seconds(self, seconds: float) -> None:
        offset = max(0.0, float(seconds))
        self.state.started_at_epoch_seconds = time.time() - offset
        self.state.started_at_monotonic_seconds = self._clock() - offset

    def _set_pending_seek_seconds(self, seconds: float) -> None:
        with self._control_lock:
            self._pending_seek_seconds = max(0.0, float(seconds))

    def _consume_pending_seek_seconds(self, default: float = 0.0) -> float:
        with self._control_lock:
            pending = self._pending_seek_seconds
            self._pending_seek_seconds = None
        return max(0.0, float(default if pending is None else pending))

    def _request_interrupt(self, reason: str, *, terminate: bool = True) -> None:
        with self._control_lock:
            self._control_reason = reason
            self._skip_event.set()
        # This is a shared live stream, so control changes should drop any
        # already-buffered audio from the previous playback position/source.
        if terminate:
            self.segmenter.purge()
        if terminate:
            self._terminate_active_process()

    def _consume_interrupt_reason(self, default: str = "skip") -> str:
        with self._control_lock:
            reason = self._control_reason
            self._control_reason = None
            self._skip_event.clear()
        return reason or default

    @staticmethod
    def _process_return_code(process: subprocess.Popen[bytes]) -> int | None:
        poll = getattr(process, "poll", None)
        if callable(poll):
            code = poll()
            if code is not None:
                return code
        wait = getattr(process, "wait", None)
        if callable(wait):
            try:
                wait(timeout=0.2)
            except Exception:
                pass
        if callable(poll):
            return poll()
        return getattr(process, "returncode", None)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                if self._user_stopped:
                    self._stream_idle_cycle()
                    continue

                queue_item = self.repository.dequeue_next()
                if queue_item is None:
                    if self.state.repeat_mode == RepeatMode.all and self._repeat_cycle_items:
                        replay_items = [NewQueueItem(**new_item_fields(item)) for item in self._repeat_cycle_items]
                        self._repeat_cycle_items = []
                        self.repository.enqueue_items(replay_items)
                        continue
                    if self.state.repeat_mode != RepeatMode.all:
                        self._repeat_cycle_items = []
                    self._stream_idle_cycle()
                    continue
                self._play_item(queue_item.id)
            except Exception:
                logger.exception("Stream engine loop failed; retrying")
                self._sleeper(self.queue_poll_seconds)

    def _stream_idle_cycle(self) -> None:
        self.state.mode = PlaybackMode.idle
        self.state.now_playing_id = None
        self.state.now_playing_title = None
        self.state.now_playing_channel = None
        self.state.now_playing_thumbnail_url = None
        self.state.now_playing_duration_seconds = None
        self.state.now_playing_is_live = False
        self.state.started_at_epoch_seconds = None
        self.state.started_at_monotonic_seconds = None
        self.state.paused = False
        self.state.paused_elapsed_seconds = None
        self._notify_state_changed()
        try:
            process = self.ffmpeg_pipeline.spawn_silence()
        except FfmpegError as exc:
            logger.error("%s", exc)
            self._sleeper(self.queue_poll_seconds)
            return
        self._set_active_processes(process)
        idle_start = self._clock()
        try:
            while not self._stop_event.is_set():
                if self._skip_event.is_set():
                    reason = self._consume_interrupt_reason()
                    if reason == "resume_from_stop":
                        return
                    if reason == "user_stop":
                        continue
                chunk = self.ffmpeg_pipeline.read_chunk(process.stdout, self.chunk_size)
                if not chunk:
                    break
                self._write_stream(chunk)
                if self._clock() - idle_start >= self.queue_poll_seconds:
                    idle_start = self._clock()
                    if not self._user_stopped and self.repository.has_queued_items():
                        break
        finally:
            self._set_active_processes(None, None)
            self._terminate_process(process)

    def _play_item(self, item_id: int) -> None:
        queue_item = self.repository.get_item(item_id)
        if queue_item is None:
            return
        self.state.mode = PlaybackMode.playing
        self.state.now_playing_id = queue_item.id
        self.state.now_playing_title = queue_item.title
        self.state.now_playing_channel = queue_item.channel
        self.state.now_playing_thumbnail_url = queue_item.thumbnail_url
        self.state.now_playing_duration_seconds = queue_item.duration_seconds
        start_offset_seconds = self._consume_pending_seek_seconds()
        self._set_playback_offset_seconds(start_offset_seconds)
        self.state.paused = False
        self.state.paused_elapsed_seconds = None
        total_bytes_sent = 0
        total_chunks_sent = 0
        while not self._stop_event.is_set():
            self._skip_event.clear()
            total_attempts = self.playback_retry_count + 1
            try:
                for attempt in range(1, total_attempts + 1):
                    if self._stop_event.is_set():
                        raise InterruptedError("stop")
                    try:
                        result = self._attempt_runner.run(
                            TrackAttemptRequest(
                                queue_item=queue_item,
                                attempt=attempt,
                                default_seek_seconds=start_offset_seconds,
                            ),
                            self._attempt_hooks,
                        )
                        start_offset_seconds = result.seek_seconds
                        total_chunks_sent += result.chunks_sent
                        total_bytes_sent += result.bytes_sent

                        if result.outcome is AttemptOutcome.completed:
                            if completed_unusually_fast(result.elapsed_seconds, result.expected_seconds):
                                logger.warning(
                                    "Track %s (%s) completed unusually fast (elapsed=%.2fs expected=%.0fs bytes=%s chunks=%s)",
                                    queue_item.id,
                                    queue_item.title or queue_item.source_url,
                                    result.elapsed_seconds,
                                    result.expected_seconds,
                                    result.bytes_sent,
                                    result.chunks_sent,
                                )
                            self.repository.mark_playback_finished(queue_item.id, status=QueueStatus.completed)
                            if self.state.repeat_mode == RepeatMode.one:
                                repeated = self.repository.enqueue_items(
                                    [NewQueueItem(**new_item_fields(repeat_cycle_item_from(queue_item)))]
                                )
                                if repeated:
                                    self.repository.move_item_to_front(repeated[0].id)
                            self._repeat_cycle_items.append(repeat_cycle_item_from(queue_item))
                            self._record_track_outcome(completed=True)
                            self._drop_prefetched_audio_path(queue_item.id)
                            self._trigger_prefetch_upcoming_tracks()
                            self._notify_state_changed()
                            logger.info(
                                "Track %s completed on attempt %s/%s (elapsed=%.2fs bytes=%s chunks=%s)",
                                queue_item.id,
                                attempt,
                                total_attempts,
                                result.elapsed_seconds,
                                result.bytes_sent,
                                result.chunks_sent,
                            )
                            return

                        failure_exc: Exception
                        if result.outcome is AttemptOutcome.retry_ffmpeg:
                            failure_exc = FfmpegError(result.reason or "ffmpeg failed")
                        else:
                            failure_exc = YtDlpError(result.reason or "playback failed")
                        if attempt >= total_attempts:
                            logger.error(
                                "Track %s failed after %s/%s attempts (%s): %s",
                                queue_item.id,
                                attempt,
                                total_attempts,
                                type(failure_exc).__name__,
                                failure_exc,
                            )
                            raise failure_exc
                        self._drop_prefetched_audio_path(queue_item.id)
                        self._drop_cached_resolved_track(queue_item.id)
                        logger.warning(
                            "Playback attempt %s/%s failed on track %s (%s): %s",
                            attempt,
                            total_attempts,
                            queue_item.id,
                            type(failure_exc).__name__,
                            failure_exc,
                        )
                        self._sleeper(min(0.5, self.queue_poll_seconds))
                    finally:
                        self._terminate_active_process()
                        self._set_active_processes(None, None)
            except InterruptedError as exc:
                reason = str(exc)
                if reason in {"pause", "resume"} or (reason == "seek" and self.state.paused):
                    self._stream_paused_cycle()
                    if self._stop_event.is_set():
                        break
                    start_offset_seconds = self._consume_pending_seek_seconds(
                        default=float(self.playback_progress()["elapsed_seconds"] or 0.0)
                    )
                    self.state.paused = False
                    self.state.paused_elapsed_seconds = None
                    self._set_playback_offset_seconds(start_offset_seconds)
                    self._notify_state_changed()
                    continue
                if reason == "seek":
                    start_offset_seconds = self._consume_pending_seek_seconds(
                        default=float(self.playback_progress()["elapsed_seconds"] or 0.0)
                    )
                    continue
                if reason == "stop":
                    break
                if reason == "user_stop":
                    logger.info(
                        "Track %s user-stopped; re-enqueueing. streamed_bytes=%s streamed_chunks=%s",
                        queue_item.id,
                        total_bytes_sent,
                        total_chunks_sent,
                    )
                    self.repository.mark_playback_finished(queue_item.id, status=QueueStatus.skipped)
                    self._record_track_outcome(skipped=True)
                    self._drop_prefetched_audio_path(queue_item.id)
                    re_queued = self.repository.enqueue_items(
                        [NewQueueItem(**new_item_fields(repeat_cycle_item_from(queue_item)))]
                    )
                    if re_queued:
                        self.repository.move_item_to_front(re_queued[0].id)
                        self._seed_resolved_cache_from_recent(re_queued[0].id, queue_item.source_url)
                    self._notify_state_changed()
                    return
                logger.info(
                    "Track %s interrupted (%s). streamed_bytes=%s streamed_chunks=%s",
                    queue_item.id,
                    reason or "skip",
                    total_bytes_sent,
                    total_chunks_sent,
                )
                self.repository.mark_playback_finished(queue_item.id, status=QueueStatus.skipped)
                self._record_track_outcome(skipped=True)
                self._drop_prefetched_audio_path(queue_item.id)
                self._notify_state_changed()
                return
            except YtDlpError as exc:
                logger.warning(
                    "Failed resolving track %s (%s): %s",
                    queue_item.id,
                    queue_item.source_url,
                    exc,
                )
                self.repository.mark_playback_finished(queue_item.id, status=QueueStatus.failed, error_message=str(exc))
                self._record_track_outcome(failed=True)
                self._drop_prefetched_audio_path(queue_item.id)
                self._notify_state_changed()
                self._notify_state_changed()
                return
            except FfmpegError as exc:
                logger.error(
                    "ffmpeg error on track %s (%s): %s [bytes=%s chunks=%s]",
                    queue_item.id,
                    queue_item.title or queue_item.source_url,
                    exc,
                    total_bytes_sent,
                    total_chunks_sent,
                )
                self.repository.mark_playback_finished(queue_item.id, status=QueueStatus.failed, error_message=str(exc))
                self._record_track_outcome(failed=True)
                self._drop_prefetched_audio_path(queue_item.id)
                self._notify_state_changed()
                self._notify_state_changed()
                return
            except Exception as exc:
                logger.exception(
                    "Playback failure on track %s (%s): %s",
                    queue_item.id,
                    queue_item.title or queue_item.source_url,
                    exc,
                )
                self.repository.mark_playback_finished(queue_item.id, status=QueueStatus.failed, error_message=str(exc))
                self._record_track_outcome(failed=True)
                self._drop_prefetched_audio_path(queue_item.id)
                self._notify_state_changed()
                return
        if self._stop_event.is_set():
            return
        try:
            logger.info(
                "Track %s interrupted (%s). streamed_bytes=%s streamed_chunks=%s",
                queue_item.id,
                "stopped",
                total_bytes_sent,
                total_chunks_sent,
            )
            self.repository.mark_playback_finished(queue_item.id, status=QueueStatus.skipped)
            self._record_track_outcome(skipped=True)
            self._drop_prefetched_audio_path(queue_item.id)
            self._notify_state_changed()
        except Exception:
            logger.exception("Failed updating playback state after stop")

    def _stream_paused_cycle(self) -> None:
        while not self._stop_event.is_set():
            if self._skip_event.is_set():
                reason = self._consume_interrupt_reason()
                if reason == "pause":
                    if not self.state.paused:
                        return
                elif reason == "resume":
                    return
                else:
                    raise InterruptedError(reason)
            if not self.state.paused:
                return
            try:
                process = self.ffmpeg_pipeline.spawn_silence()
            except FfmpegError as exc:
                logger.error("%s", exc)
                self._sleeper(min(0.1, self.queue_poll_seconds))
                continue
            self._set_active_processes(process)
            try:
                while not self._stop_event.is_set():
                    if self._skip_event.is_set():
                        reason = self._consume_interrupt_reason()
                        if reason == "pause":
                            if not self.state.paused:
                                return
                            continue
                        if reason == "resume":
                            return
                        raise InterruptedError(reason)
                    if not self.state.paused:
                        return
                    chunk = self.ffmpeg_pipeline.read_chunk(process.stdout, self.chunk_size)
                    if not chunk:
                        break
                    self._write_stream(chunk)
            finally:
                self._set_active_processes(None, None)
                self._terminate_process(process)
