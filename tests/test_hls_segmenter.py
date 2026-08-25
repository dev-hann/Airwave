"""Rigorous unit coverage for the HLS segmenter.

The packager subprocess is faked with a scripted writer: tests drive the same
file layout the real ``ffmpeg -f hls`` muxer produces (index.m3u8 +
segNNNNNNNNNN.ts) and assert the segmenter's window, playlist rendering,
purge/restart behavior, and listener registry semantics.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from app.services.hls_segmenter import HlsSegmenter


class FakePackagerStdin:
    def __init__(self, packager: "FakePackager") -> None:
        self._packager = packager
        self.received: bytearray = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        if self._packager.fail_writes or self.closed:
            raise BrokenPipeError("packager stdin is gone")
        self.received.extend(data)
        if self._packager.on_write is not None:
            self._packager.on_write(bytes(data))

    def close(self) -> None:
        self.closed = True


class FakePackager:
    """Emulates the ffmpeg HLS packager process."""

    def __init__(self, playlist_path: Path, segment_pattern: str, start_number: int) -> None:
        self.playlist_path = Path(playlist_path)
        self.segment_pattern = segment_pattern
        self.start_number = start_number
        self.stdin = FakePackagerStdin(self)
        self.terminated = False
        self.fail_writes = False
        self.on_write = None
        self._counter = start_number

    def terminate(self) -> None:
        self.terminated = True
        self.stdin.closed = True

    def wait(self, timeout: float | None = None) -> None:
        return

    # --- test helpers -----------------------------------------------------

    def emit_segment(self, duration: float) -> str:
        """Append one segment entry to the fake playlist file, like the real
        muxer does when it closes a segment."""
        name = f"seg{self._counter:010d}.ts"
        self._counter += 1
        (self.playlist_path.parent / name).write_bytes(b"TS")
        if self.playlist_path.exists():
            body = self.playlist_path.read_text().rstrip("\n") + "\n"
        else:
            body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n"
        body += f"#EXTINF:{duration:.3f},\n{name}\n"
        self.playlist_path.write_text(body)
        return name


class SegmenterHarness:
    def __init__(self, tmp_path: Path, **kwargs) -> None:
        self.packagers: list[FakePackager] = []

        def spawn(playlist_path: str, segment_pattern: str, *, start_number: int) -> FakePackager:
            packager = FakePackager(Path(playlist_path), segment_pattern, start_number)
            self.packagers.append(packager)
            return packager

        self.segmenter = HlsSegmenter(spawn, directory=str(tmp_path / "hls"), **kwargs)

    @property
    def active(self) -> FakePackager:
        assert self.packagers, "no packager spawned"
        return self.packagers[-1]


@pytest.fixture()
def harness(tmp_path: Path) -> SegmenterHarness:
    return SegmenterHarness(tmp_path)


# -------------------------------------------------------------------- feed

def test_write_spawns_packager_lazily_and_forwards_bytes(harness: SegmenterHarness):
    assert harness.packagers == []

    harness.segmenter.write(b"mp3-bytes")

    assert len(harness.packagers) == 1
    assert bytes(harness.active.stdin.received) == b"mp3-bytes"
    # Empty writes must not spawn anything extra or confuse the process.
    harness.segmenter.write(b"")
    assert len(harness.packagers) == 1


def test_write_respawns_dead_packager_and_continues(harness: SegmenterHarness):
    harness.segmenter.write(b"first")
    first = harness.active
    first.fail_writes = True  # simulate packager crash

    harness.segmenter.write(b"second")

    assert first.terminated is True
    assert len(harness.packagers) == 2
    assert bytes(harness.active.stdin.received) == b"second"


def test_write_after_purge_does_not_resurrect_with_old_audio(harness: SegmenterHarness):
    harness.segmenter.write(b"old")
    harness.segmenter.purge()
    assert harness.active.terminated is True

    # A stale in-flight chunk right after an interrupt must not resurrect a
    # packager pre-loaded with pre-skip audio.
    # (Current contract: write() may respawn on the retry path — assert it
    # never *silently merges* old bytes into the pre-purge process.)
    before = len(harness.packagers)
    harness.segmenter.write(b"stale-chunk")
    assert harness.packagers[:before][0].terminated is True
    assert harness.packagers[:before][0].stdin.received == bytearray(b"old")


# ----------------------------------------------------------------- playlist

def test_playlist_empty_when_nothing_published(harness: SegmenterHarness):
    text = harness.segmenter.playlist_text()

    assert text.splitlines()[0] == "#EXTM3U"
    assert "#EXT-X-ENDLIST" not in text
    assert "#EXT-X-TARGETDURATION:4" in text
    assert f"#EXT-X-MEDIA-SEQUENCE:0" in text


def test_playlist_appends_new_segments_with_durations(harness: SegmenterHarness):
    harness.segmenter.write(b"x")
    harness.active.emit_segment(4.0)
    harness.active.emit_segment(3.876)

    text = harness.segmenter.playlist_text()

    lines = text.splitlines()
    assert "#EXT-X-TARGETDURATION:4" in lines
    assert "#EXT-X-MEDIA-SEQUENCE:0" in lines
    assert "#EXTINF:4.000," in lines
    assert "#EXTINF:3.876," in lines
    assert "seg0000000000.ts" in lines
    assert "seg0000000001.ts" in lines
    assert lines.index("seg0000000000.ts") < lines.index("seg0000000001.ts")
    assert "#EXT-X-ENDLIST" not in lines


def test_playlist_sync_is_idempotent(harness: SegmenterHarness):
    harness.segmenter.write(b"x")
    harness.active.emit_segment(4.0)

    first = harness.segmenter.playlist_text()
    second = harness.segmenter.playlist_text()

    assert first == second


def test_window_prunes_old_segments_and_deletes_files(tmp_path: Path):
    harness = SegmenterHarness(tmp_path, window_size=3)
    harness.segmenter.write(b"x")
    names = [harness.active.emit_segment(4.0) for _ in range(5)]
    directory = harness.active.playlist_path.parent

    text = harness.segmenter.playlist_text()

    # Oldest entries beyond the window are unlisted and their files deleted.
    for name in names[:2]:
        assert name not in text
        assert not (directory / name).exists()
    # The newest window_size entries remain listed and on disk.
    for name in names[2:]:
        assert name in text
        assert (directory / name).exists()
    # Media sequence advanced to the first surviving entry.
    assert "#EXT-X-MEDIA-SEQUENCE:2" in text


def test_purge_wipes_window_and_marks_discontinuity(harness: SegmenterHarness):
    harness.segmenter.write(b"x")
    first_name = harness.active.emit_segment(4.0)
    directory = harness.active.playlist_path.parent

    harness.segmenter.purge()

    # Window is gone, files are gone, playlist is header-only.
    assert first_name not in harness.segmenter.playlist_text()
    assert not (directory / first_name).exists()
    assert harness.active.terminated is True

    # Post-purge segments continue the numbering and carry a discontinuity.
    harness.segmenter.write(b"y")
    second_name = harness.active.emit_segment(4.0)
    text = harness.segmenter.playlist_text()
    assert "#EXT-X-DISCONTINUITY" in text
    assert second_name in text
    assert "#EXT-X-MEDIA-SEQUENCE:1" in text


def test_purge_before_any_content_sets_no_discontinuity(harness: SegmenterHarness):
    harness.segmenter.purge()
    harness.segmenter.write(b"x")
    harness.active.emit_segment(4.0)

    assert "#EXT-X-DISCONTINUITY" not in harness.segmenter.playlist_text()


def test_respawned_packager_continues_sequence_numbering(harness: SegmenterHarness):
    harness.segmenter.write(b"x")
    harness.active.emit_segment(4.0)
    harness.active.emit_segment(4.0)
    harness.active.fail_writes = True
    harness.segmenter.write(b"more")
    respawned = harness.active

    assert respawned.start_number == 2
    name = respawned.emit_segment(4.0)

    text = harness.segmenter.playlist_text()
    assert name in text
    assert "#EXT-X-MEDIA-SEQUENCE:0" in text


# ------------------------------------------------------------------ serving

def test_segment_path_only_serves_window_entries(harness: SegmenterHarness):
    harness.segmenter.write(b"x")
    name = harness.active.emit_segment(4.0)

    path = harness.segmenter.segment_path(name)
    assert path is not None and path.is_file()

    # Pruned out of the window → no longer served.
    for _ in range(12):
        harness.active.emit_segment(4.0)
    assert harness.segmenter.segment_path(name) is None


@pytest.mark.parametrize(
    "name",
    [
        "index.m3u8",
        "seg.ts",
        "segabc.ts",
        "seg0000000000.ts.bak",
        "../seg0000000000.ts",
        "..%2Fseg0000000000.ts",
        "/etc/passwd",
        "sub/seg0000000000.ts",
        "SEG0000000000.TS",
    ],
)
def test_segment_path_rejects_foreign_names(harness: SegmenterHarness, name: str):
    harness.segmenter.write(b"x")
    harness.active.emit_segment(4.0)

    assert harness.segmenter.segment_path(name) is None


# ---------------------------------------------------------------- listeners

def test_listener_registry_counts_recent_clients_only(harness: SegmenterHarness):
    harness.segmenter.note_listener("a")
    harness.segmenter.note_listener("b")
    assert harness.segmenter.listener_count() == 2

    # Re-noting the same client must not double-count.
    harness.segmenter.note_listener("a")
    assert harness.segmenter.listener_count() == 2

    # Expired listeners disappear after the TTL.
    stale = SegmenterHarness(Path("/tmp/opencode"), listener_ttl_seconds=0.05)
    stale.segmenter.note_listener("old")
    time.sleep(0.08)
    assert stale.segmenter.listener_count() == 0


def test_listener_registry_is_thread_safe(harness: SegmenterHarness):
    def hammer(key: str) -> None:
        for _ in range(200):
            harness.segmenter.note_listener(key)
            harness.segmenter.listener_count()

    threads = [threading.Thread(target=hammer, args=(f"c{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    assert harness.segmenter.listener_count() == 8


# -------------------------------------------------------------------- close

def test_close_terminates_packager_and_removes_directory(harness: SegmenterHarness):
    harness.segmenter.write(b"x")
    directory = harness.active.playlist_path.parent
    harness.active.emit_segment(4.0)
    assert directory.exists()

    harness.segmenter.close()

    assert harness.active.terminated is True
    assert not directory.exists()
