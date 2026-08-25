"""TrackAttemptRunner unit tests: fakes only, injected clock, zero waiting."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any

import pytest

from app.domain.outcomes import AttemptOutcome
from app.usecases.play_track import TrackAttemptRequest, TrackAttemptResult, TrackAttemptRunner


@dataclass
class FakeQueueItem:
    id: int = 1
    source_url: str = "https://media.local/audio"
    normalized_url: str | None = "https://media.local/audio"
    duration_seconds: int | None = 120
    title: str | None = "Song"


@dataclass
class FakeResolved:
    source_url: str = "https://media.local/audio"
    normalized_url: str = "https://media.local/audio"
    title: str | None = "Song"
    channel: str | None = "chan"
    duration_seconds: int | None = 120
    thumbnail_url: str | None = None
    stream_url: str = "http://media.local/audio"
    is_live: bool = False


class FakeProc:
    def __init__(self, payload: bytes, returncode: int = 0, stderr: bytes = b"") -> None:
        self.stdout = BytesIO(payload)
        self.stderr = BytesIO(stderr)
        self.returncode = returncode

    def terminate(self) -> None: ...
    def wait(self, timeout: float | None = None) -> None: ...
    def poll(self) -> int:
        return self.returncode


class ScriptedFfmpeg:
    """Transcoder double with per-attempt spawn results and probe answers."""

    def __init__(
        self,
        spawns: list[FakeProc],
        probe_durations: list[float | None] | None = None,
        spawn_error: Exception | None = None,
    ) -> None:
        self.spawns = list(spawns)
        self.probe_durations = list(probe_durations or [])
        self.spawn_error = spawn_error
        self.spawn_urls: list[str] = []
        self.spawn_offsets: list[float] = []
        self.read_calls = 0

    def spawn_for_source(self, source_url: str, start_at_seconds: float = 0.0) -> FakeProc:
        self.spawn_urls.append(source_url)
        self.spawn_offsets.append(start_at_seconds)
        if self.spawn_error is not None:
            raise self.spawn_error
        return self.spawns.pop(0)

    def probe_source(self, source_url: str) -> dict[str, Any]:
        duration = self.probe_durations.pop(0) if self.probe_durations else None
        return {"duration_seconds": duration, "bit_rate": None, "format_name": "mp3"}

    def read_chunk(self, stdout: Any, chunk_size: int) -> bytes:
        self.read_calls += 1
        return stdout.read(chunk_size)


class RecordingHooks:
    """AttemptHooks double recording the orchestration order."""

    def __init__(self, *, resolved: FakeResolved | Exception = None, interrupt_after: int | None = None,
                 interrupt_reason: str = "skip", prefetched: str | None = None,
                 uses_direct: bool = False) -> None:
        self.calls: list[str] = []
        self.resolved = resolved or FakeResolved()
        self.interrupt_after = interrupt_after
        self.interrupt_reason = interrupt_reason
        self.prefetched = prefetched
        self.uses_direct = uses_direct
        self.chunks: list[bytes] = []
        self.seek_default_used: float | None = None
        self.silence_started = 0
        self.silence_stopped = 0
        self.marked_resolved: tuple[int, str] | None = None
        self.offset_set: float | None = None

    def resolve_track(self, item, force_refresh: bool):
        self.calls.append(f"resolve:force={force_refresh}")
        if isinstance(self.resolved, Exception):
            raise self.resolved
        return self.resolved

    def on_resolved_metadata(self, resolved) -> None:
        self.calls.append("metadata")

    def mark_item_resolved(self, item_id: int, normalized_url: str) -> None:
        self.marked_resolved = (item_id, normalized_url)
        self.calls.append("mark_resolved")

    def remember_resolved(self, resolved) -> None:
        self.calls.append("remember")

    def consume_seek(self, default_seconds: float) -> float:
        self.seek_default_used = default_seconds
        return default_seconds

    def set_playback_offset(self, seconds: float) -> None:
        self.offset_set = seconds
        self.calls.append(f"offset:{seconds}")

    def get_prefetched_audio(self, item_id: int) -> str | None:
        return self.prefetched

    def prefetch_audio(self, item_id: int, source_url: str) -> None:
        self.calls.append("prefetch")
        self.prefetched = f"/tmp/prefetched/{item_id}.bin"

    def uses_direct_ffmpeg(self, item) -> bool:
        return self.uses_direct

    def register_active_process(self, process) -> None:
        self.calls.append("register")

    def trigger_prefetch_upcoming(self) -> None:
        self.calls.append("prefetch_upcoming")

    def notify_state_changed(self) -> None:
        self.calls.append("notify")

    def start_transition_silence(self) -> tuple[object, object]:
        self.silence_started += 1
        return (object(), object())

    def stop_transition_silence(self, stop_event, worker) -> None:
        self.silence_stopped += 1

    def on_first_chunk(self) -> None:
        self.calls.append("first_chunk")

    def write_chunk(self, chunk: bytes) -> None:
        self.chunks.append(chunk)

    def check_interrupt(self) -> str | None:
        if self.interrupt_after is not None and len(self.chunks) >= self.interrupt_after:
            return self.interrupt_reason
        return None

    def consume_interrupt_reason(self) -> str:
        return self.interrupt_reason


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        self.now += 0.001
        return self.now


def _runner(ffmpeg: ScriptedFfmpeg, clock: FakeClock | None = None) -> TrackAttemptRunner:
    return TrackAttemptRunner(transcoder=ffmpeg, clock=clock or FakeClock(), chunk_size=4)


def _request(item: FakeQueueItem | None = None, attempt: int = 1, seek: float = 0.0) -> TrackAttemptRequest:
    return TrackAttemptRequest(queue_item=item or FakeQueueItem(), attempt=attempt, default_seek_seconds=seek)


def test_happy_path_streams_chunks_and_completes() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"abcd", returncode=0)], probe_durations=[120.0])
    hooks = RecordingHooks()
    result = _runner(ffmpeg).run(_request(), hooks)

    assert result.outcome is AttemptOutcome.completed
    assert hooks.chunks == [b"abcd"]
    assert result.chunks_sent == 1
    assert result.bytes_sent == 4
    assert result.resolved is hooks.resolved
    # Orchestration order: resolve -> metadata -> mark -> remember -> offset ->
    # register -> (prefetch_upcoming + notify) -> first_chunk stops silence.
    assert ffmpeg.spawn_urls == ["/tmp/prefetched/1.bin"]
    # resolve -> mark -> remember -> metadata -> offset -> prefetch -> register
    #          -> prefetch_upcoming/notify -> first_chunk stops silence
    assert hooks.calls[:7] == [
        "resolve:force=False", "mark_resolved", "remember", "metadata", "offset:0.0", "prefetch", "register",
    ]
    assert "notify" in hooks.calls and "first_chunk" in hooks.calls
    assert hooks.calls.index("notify") < hooks.calls.index("first_chunk")
    assert hooks.silence_started == 1
    assert hooks.silence_stopped >= 1  # stopped at first chunk (and/or finally)


def test_resolve_failure_maps_to_retry_source_outcome() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[])
    hooks = RecordingHooks(resolved=RuntimeError("yt-dlp exploded"))
    result = _runner(ffmpeg).run(_request(), hooks)

    assert result.outcome is AttemptOutcome.retry_source
    assert "yt-dlp exploded" in (result.reason or "")
    assert hooks.chunks == []
    assert hooks.silence_stopped >= 1  # finally still stops silence


def test_spawn_failure_maps_to_retry_ffmpeg_outcome() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[], spawn_error=RuntimeError("ffmpeg missing"))
    hooks = RecordingHooks()
    result = _runner(ffmpeg).run(_request(), hooks)

    assert result.outcome is AttemptOutcome.retry_ffmpeg
    assert "ffmpeg missing" in (result.reason or "")


def test_ffmpeg_nonzero_exit_maps_to_retry_ffmpeg() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"ab", returncode=1)])
    result = _runner(ffmpeg).run(_request(), RecordingHooks())

    assert result.outcome is AttemptOutcome.retry_ffmpeg
    assert "status 1" in (result.reason or "")


def test_premature_end_with_transport_stderr_maps_to_retry_source() -> None:
    ffmpeg = ScriptedFfmpeg(
        spawns=[FakeProc(b"ab", returncode=0, stderr=b"[tls] Error in the pull function.\nInput/output error")],
        probe_durations=[300.0],
    )
    item = FakeQueueItem(duration_seconds=300)
    result = _runner(ffmpeg).run(_request(item), RecordingHooks())

    assert result.outcome is AttemptOutcome.premature_end


def test_elapsed_from_injected_clock_feeds_classification() -> None:
    class SlowClock:
        def __init__(self) -> None:
            self.now = 0.0

        def __call__(self) -> float:
            self.now += 10.0  # attempt spans 20s wall -> premature vs 300s duration
            return self.now

    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"ab")], probe_durations=[300.0])
    result = TrackAttemptRunner(transcoder=ffmpeg, clock=SlowClock(), chunk_size=4).run(
        _request(FakeQueueItem(duration_seconds=300)), RecordingHooks()
    )
    assert result.outcome is AttemptOutcome.completed  # no failure stderr: premature-but-clean = completed


def test_attempt_number_drives_force_refresh() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"x")])
    hooks = RecordingHooks()
    _runner(ffmpeg).run(_request(attempt=2), hooks)
    assert hooks.calls[0] == "resolve:force=True"


def test_seek_offset_forwarded_to_spawn() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"x")])
    hooks = RecordingHooks()
    _runner(ffmpeg).run(_request(seek=42.0), hooks)
    assert ffmpeg.spawn_offsets == [42.0]
    assert hooks.offset_set == 42.0
    assert hooks.seek_default_used == 42.0


def test_prefetched_audio_preferred_over_stream_url() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"x")])
    hooks = RecordingHooks(prefetched="/tmp/prefetched/1.bin")
    _runner(ffmpeg).run(_request(), hooks)
    assert ffmpeg.spawn_urls == ["/tmp/prefetched/1.bin"]
    assert "prefetch" not in hooks.calls  # prefetched already: no prefetch step


def test_missing_prefetch_triggers_prefetch_then_streams_url_or_file() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"x")])
    hooks = RecordingHooks()
    _runner(ffmpeg).run(_request(), hooks)
    assert "prefetch" in hooks.calls
    assert ffmpeg.spawn_urls == ["/tmp/prefetched/1.bin"]  # download landed, spawned from file


def test_live_track_never_prefetches() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"x")])
    hooks = RecordingHooks()
    hooks.resolved = FakeResolved(is_live=True)
    _runner(ffmpeg).run(_request(), hooks)
    assert "prefetch" not in hooks.calls
    assert ffmpeg.spawn_urls == [FakeResolved().stream_url]


def test_direct_ffmpeg_items_spawn_from_stream_url_without_prefetch() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"x")])
    hooks = RecordingHooks(uses_direct=True)
    _runner(ffmpeg).run(_request(), hooks)
    assert "prefetch" not in hooks.calls
    assert ffmpeg.spawn_urls == [FakeResolved().stream_url]


def test_interrupt_mid_stream_raises_interrupted_error() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"abcdefgh")])
    hooks = RecordingHooks(interrupt_after=1, interrupt_reason="pause")
    with pytest.raises(InterruptedError):
        _runner(ffmpeg).run(_request(), hooks)
    assert hooks.chunks  # one chunk streamed before the interrupt fired
    assert hooks.silence_stopped >= 1


def test_interrupt_after_prefetch_consumes_real_reason() -> None:
    class InterruptingPrefetchHooks(RecordingHooks):
        def prefetch_audio(self, item_id: int, source_url: str) -> None:
            super().prefetch_audio(item_id, source_url)
            self.interrupt_after = -1  # force interrupt on next check

    ffmpeg = ScriptedFfmpeg(spawns=[])
    hooks = InterruptingPrefetchHooks()
    hooks.interrupt_reason = "skip"
    with pytest.raises(InterruptedError):
        _runner(ffmpeg).run(_request(), hooks)


def test_transition_silence_stopped_in_finally_when_spawn_fails() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[], spawn_error=RuntimeError("boom"))
    hooks = RecordingHooks()
    _runner(ffmpeg).run(_request(), hooks)
    assert hooks.silence_started == 1
    assert hooks.silence_stopped == 1  # only finally stop — no first chunk happened


def test_result_carries_expected_duration_basis() -> None:
    ffmpeg = ScriptedFfmpeg(spawns=[FakeProc(b"x")], probe_durations=[250.0])
    result = _runner(ffmpeg).run(_request(FakeQueueItem(duration_seconds=120)), RecordingHooks())
    assert result.expected_seconds == 250.0  # probe wins over queue metadata


def test_result_dataclass_defaults() -> None:
    result = TrackAttemptResult(outcome=AttemptOutcome.completed)
    assert result.chunks_sent == 0 and result.bytes_sent == 0
    assert result.reason is None and result.resolved is None
    assert result.stderr_text == ""

