"""PlaybackState locking regression tests.

The API thread and worker loop both mutate engine.state; serializers and
stats read it from broadcast threads. These tests prove multi-field reads
never observe a torn (half-old, half-new) state: the writer mirrors the
engine's internal locked-pair pattern (same `_state_lock`), so a snapshot
that bypassed the lock would interleave and tear with high probability
under the tight loop below.
"""

from __future__ import annotations

import threading

from app.db.repository import Repository
from app.services.stream_engine import PlaybackMode, StreamEngine

from tests.test_stream_engine import FakeFfmpeg, FakeSegmenter, FakeYtDlp


def _engine(tmp_path, name: str) -> StreamEngine:
    repo = Repository(f"sqlite+pysqlite:///{tmp_path}/{name}.db")
    repo.init_db()
    return StreamEngine(
        repository=repo,
        yt_dlp_service=FakeYtDlp(),
        ffmpeg_pipeline=FakeFfmpeg(),
        hls_segmenter=FakeSegmenter(),
        queue_poll_seconds=0.01,
    )


def test_state_snapshot_never_tears_under_concurrent_writes(tmp_path) -> None:
    engine = _engine(tmp_path, "snap-tear")
    engine.state.mode = PlaybackMode.playing
    iterations = 2000
    done = threading.Event()
    reader_ready = threading.Event()

    def writer() -> None:
        reader_ready.wait(timeout=5)
        # Same locked paired-write pattern _play_item uses internally.
        with engine._state_lock:  # noqa: SLF001 - mirrors engine's internal pattern
            engine.state.now_playing_id = 0
            engine.state.now_playing_title = "title-0"
        for i in range(1, iterations + 1):
            with engine._state_lock:  # noqa: SLF001
                engine.state.now_playing_id = i
                engine.state.now_playing_title = f"title-{i}"
        done.set()

    t = threading.Thread(target=writer, daemon=True)
    t.start()

    torn = 0
    reads = 0
    snap = engine.state_snapshot()  # prime: id/title pair exists before racing
    assert snap.now_playing_title == "title-0" or snap.now_playing_id is None
    reader_ready.set()
    while not done.is_set():
        snap = engine.state_snapshot()
        reads += 1
        if snap.now_playing_id is not None and snap.now_playing_title != f"title-{snap.now_playing_id}":
            torn += 1
    t.join(timeout=5)

    assert torn == 0, f"{torn}/{reads} snapshots observed torn state"
    assert reads > 100, "reader loop starved; test proves nothing"


def test_playback_progress_consistent_with_snapshot(tmp_path) -> None:
    engine = _engine(tmp_path, "progress-snap")
    engine.state.mode = PlaybackMode.playing
    engine._set_playback_offset_seconds(10.0)  # noqa: SLF001

    progress = engine.playback_progress()
    snap = engine.state_snapshot()

    assert progress["started_at"] == snap.started_at_epoch_seconds
    assert snap.started_at_monotonic_seconds is not None
    elapsed = progress["elapsed_seconds"]
    assert elapsed is not None and elapsed >= 10.0


def test_dead_public_methods_stay_removed() -> None:
    assert not hasattr(StreamEngine, "get_current_stream_url")
    assert not hasattr(StreamEngine, "get_current_ffmpeg_input")
