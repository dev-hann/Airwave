"""Phase-5 coverage: engine control flows that previously had no tests.

All tests use the existing fakes (no network, no real subprocesses) and the
injected clock/sleeper where timing matters.
"""

from __future__ import annotations

from threading import Thread
import time

from app.db.models import QueueStatus
from app.db.repository import NewQueueItem, Repository
from app.services.stream_engine import PlaybackMode, RepeatMode, StreamEngine

from tests.test_stream_engine import FakeFfmpeg, FakeProc, FakeSegmenter, FakeYtDlp


def _engine(repo: Repository, ffmpeg=None, yt=None, **kwargs) -> StreamEngine:
    defaults = {
        "repository": repo,
        "yt_dlp_service": yt or FakeYtDlp(),
        "ffmpeg_pipeline": ffmpeg or FakeFfmpeg(),
        "hls_segmenter": FakeSegmenter(),
        "chunk_size": 2,
        "queue_poll_seconds": 0.01,
    }
    defaults.update(kwargs)
    return StreamEngine(**defaults)


def _one_item(tmp_path, db_name: str, *, duration: int | None = None):
    repo = Repository(f"sqlite+pysqlite:///{tmp_path}/{db_name}.db")
    repo.init_db()
    created = repo.enqueue_items(
        [NewQueueItem(source_url="u", normalized_url="u", source_type="video", title="Song", duration_seconds=duration)]
    )
    assert repo.dequeue_next() is not None
    return repo, created[0]


# ------------------------------------------------------------------- seek

def test_seek_offset_restarts_playback_at_requested_position(tmp_path):
    repo, item = _one_item(tmp_path, "seek-restart")
    spawns: list[float] = []

    class OffsetFfmpeg(FakeFfmpeg):
        def spawn_for_source(self, source_url: str, start_at_seconds: float = 0.0) -> FakeProc:
            spawns.append(start_at_seconds)
            return FakeProc(b"abc123")

    engine = _engine(repo, ffmpeg=OffsetFfmpeg())
    engine._set_pending_seek_seconds(30.0)  # noqa: SLF001 - control-path coverage

    engine._play_item(item.id)  # noqa: SLF001

    assert 30.0 in spawns  # playback began from the seek offset, not 0


def test_seek_to_percent_requires_duration_and_mode(tmp_path):
    repo, _item = _one_item(tmp_path, "seek-invalid")
    engine = _engine(repo)

    assert engine.seek_to_percent(50.0) is False  # idle mode refuses
    engine.state.mode = PlaybackMode.playing
    assert engine.seek_to_percent(50.0) is False  # no duration known either


# --------------------------------------------------------------- repeat-one

def test_repeat_one_reenqueues_completed_track_at_front(tmp_path):
    repo, item = _one_item(tmp_path, "repeat-one", duration=120)
    engine = _engine(repo)
    engine.set_repeat_mode("one")

    engine._play_item(item.id)  # noqa: SLF001

    assert repo.get_item(item.id).status == QueueStatus.completed
    queued_ids = repo.list_queued_ids()
    assert len(queued_ids) == 1
    requeued = repo.get_item(queued_ids[0])
    assert requeued.title == "Song"
    assert requeued.source_url == "u"


def test_set_repeat_mode_rejects_unknown_mode(tmp_path):
    repo, _item = _one_item(tmp_path, "repeat-invalid")
    engine = _engine(repo)
    try:
        engine.set_repeat_mode("banana")
    except ValueError as exc:
        assert "Invalid repeat mode" in str(exc)
    else:
        raise AssertionError("expected ValueError")
    assert engine.state.repeat_mode == RepeatMode.off


# --------------------------------------------------------------- repeat-all

def test_repeat_all_replays_cycle_when_queue_drains(tmp_path):
    repo = Repository(f"sqlite+pysqlite:///{tmp_path}/repeat-all.db")
    repo.init_db()
    repo.enqueue_items(
        [
            NewQueueItem(source_url="u1", normalized_url="u1", source_type="video", title="A"),
            NewQueueItem(source_url="u2", normalized_url="u2", source_type="video", title="B"),
        ]
    )
    engine = _engine(repo, playback_retry_count=0)
    engine.set_repeat_mode("all")

    # Drive the worker loop until both tracks completed AND the cycle replayed.
    worker = Thread(target=engine._run, daemon=True)  # noqa: SLF001 - loop coverage
    worker.start()
    deadline = time.monotonic() + 8.0
    while time.monotonic() < deadline:
        stats = engine.runtime_stats()
        if stats["tracks_completed"] >= 4:  # A, B completed, then replayed A, B
            break
        time.sleep(0.02)
    engine._request_interrupt("stop")  # noqa: SLF001
    worker.join(timeout=3)

    assert engine.runtime_stats()["tracks_completed"] >= 4


# ------------------------------------------------------------------ resume

def test_resume_playback_four_branches(tmp_path):
    repo, item = _one_item(tmp_path, "resume-branches", duration=120)
    engine = _engine(repo)

    # 1) paused -> unpause
    engine.state.mode = PlaybackMode.playing
    engine.state.paused = True
    assert engine.resume_playback() == "resumed"
    assert engine.state.paused is False

    # 2) user-stopped idle -> wake
    engine.state.mode = PlaybackMode.idle
    engine.state.paused = False
    engine._user_stopped = True  # noqa: SLF001
    assert engine.resume_playback() == "resumed_from_stop"
    assert engine._user_stopped is False  # noqa: SLF001

    # 3) idle + empty queue + history -> re-enqueue last media
    engine._repeat_cycle_items = []  # noqa: SLF001
    repo.mark_playback_finished(item.id, status=QueueStatus.completed)
    outcome = engine.resume_playback()
    assert outcome == "resume_last"
    assert len(repo.list_queued_ids()) == 1

    # 4) idle + empty queue + empty history -> noop
    repo.clear_queue()
    repo.clear_history()
    assert engine.resume_playback() == "noop"


# --------------------------------------------------------------- user stop

def test_user_stop_reenqueues_current_track_at_front(tmp_path):
    repo, item = _one_item(tmp_path, "user-stop", duration=120)

    class InterruptingFfmpeg(FakeFfmpeg):
        """Spawns fine; a side thread fires user_stop once chunks flow."""

        def __init__(self) -> None:
            super().__init__()
            self.fired = False

        def read_chunk(self, stdout, chunk_size: int) -> bytes:
            data = stdout.read(chunk_size)
            if data and not self.fired:
                self.fired = True
                engine_ref.stop_playback()
            return data

    ffmpeg = InterruptingFfmpeg()
    engine_ref = _engine(repo, ffmpeg=ffmpeg, playback_retry_count=0)
    engine_ref._play_item(item.id)  # noqa: SLF001

    assert repo.get_item(item.id).status == QueueStatus.skipped
    queued = repo.list_queued_ids()
    assert len(queued) == 1
    assert repo.get_item(queued[0]).source_url == "u"


# ---------------------------------------------------------------- shuffle

def test_shuffle_toggle_restores_order(tmp_path):
    repo = Repository(f"sqlite+pysqlite:///{tmp_path}/shuffle-restore.db")
    repo.init_db()
    created = repo.enqueue_items(
        [NewQueueItem(source_url=f"u{i}", normalized_url=f"u{i}", source_type="video", title=f"S{i}") for i in range(4)]
    )
    original = [item.id for item in created]
    engine = _engine(repo)

    engine.set_shuffle_enabled(True)
    assert repo.list_queued_ids() != []  # still queued (order may equal original by chance)
    assert engine.state.shuffle_enabled is True

    engine.set_shuffle_enabled(False)
    assert repo.list_queued_ids() == original  # canonical order restored exactly


def test_shuffle_single_item_is_noop(tmp_path):
    repo = Repository(f"sqlite+pysqlite:///{tmp_path}/shuffle-single.db")
    repo.init_db()
    repo.enqueue_items([NewQueueItem(source_url="u", normalized_url="u", source_type="video", title="S")])
    engine = _engine(repo)
    assert engine.set_shuffle_enabled(True) is True
    assert len(repo.list_queued_ids()) == 1
    assert engine.set_shuffle_enabled(False) is False
    assert len(repo.list_queued_ids()) == 1
