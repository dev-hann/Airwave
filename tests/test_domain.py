"""Domain unit tests — no fakes, no I/O, no waiting. These run in milliseconds."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.domain.outcomes import (
    AttemptFacts,
    AttemptOutcome,
    classify_attempt,
    completed_unusually_fast,
    ended_prematurely,
    expected_duration_seconds,
    slow_chunk_read,
    stderr_indicates_stream_failure,
)
from app.domain.playback_state import PlaybackMode, PlaybackState, RepeatMode
from app.domain.progress import playback_progress
from app.domain.repeat_cycle import RepeatCycleItem, new_item_fields, replay_item_from, repeat_cycle_item_from
from app.domain.seek import clamp_seek_seconds, seconds_from_percent
from app.domain.shuffle_order import restore_order, shuffled_order


# ----------------------------------------------------------------- fixtures

@dataclass
class FakeRow:
    source_url: str = "https://s"
    provider: str | None = "youtube"
    provider_item_id: str | None = "abc"
    normalized_url: str = "https://n"
    source_type: str = "youtube"
    title: str | None = "Song"
    duration_seconds: int | None = 200
    thumbnail_url: str | None = "https://t"
    playlist_id: int | None = 7


# ------------------------------------------------------------ outcome rules

@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        ("[tls] Error in the pull function.\nInput/output error", True),
        ("Session has been invalidated", True),
        ("Connection reset by peer", True),
        ("read error 123", True),
        ("at end of file", True),
        ("", False),
        ("everything fine", False),
        (None, False),  # type: ignore[arg-type] - robustness against None
    ],
)
def test_stderr_failure_markers(stderr: str, expected: bool) -> None:
    assert stderr_indicates_stream_failure(stderr) is expected


@pytest.mark.parametrize(
    ("probed", "resolved", "queued", "expected"),
    [
        (120.0, 100, 90, 120.0),   # probe wins
        (None, 100, 90, 100.0),    # yt-dlp metadata next
        (None, None, 90, 90.0),    # queue item last
        (None, None, None, 0.0),   # nothing known
        (0.0, 100, 90, 100.0),     # falsy probe skipped
        (0.0, 0, 0, 0.0),          # all falsy
    ],
)
def test_expected_duration_precedence(probed: float | None, resolved: int | None, queued: int | None, expected: float) -> None:
    assert expected_duration_seconds(probed, resolved, queued) == expected


@pytest.mark.parametrize(
    ("elapsed", "duration", "expected"),
    [
        (10.0, 200.0, True),    # 5% of a long track
        (185.0, 200.0, False),  # 92.5% — fine
        (180.0, 200.0, False),  # exactly 90% boundary -> NOT premature (strict <)
        (5.0, 20.0, False),     # short track: heuristic disabled
        (5.0, 0.0, False),      # unknown duration
    ],
)
def test_ended_prematurely(elapsed: float, duration: float, expected: bool) -> None:
    assert ended_prematurely(elapsed, duration) is expected


def test_fast_completion_threshold() -> None:
    assert completed_unusually_fast(10.0, 200.0) is True
    assert completed_unusually_fast(100.0, 200.0) is False
    assert completed_unusually_fast(1.0, 10.0) is False  # short track exempt


def test_slow_chunk_read_threshold() -> None:
    assert slow_chunk_read(0.3) is True    # boundary inclusive
    assert slow_chunk_read(0.2999) is False
    assert slow_chunk_read(0.5, threshold_seconds=1.0) is False
    assert slow_chunk_read(2.0, threshold_seconds=1.0) is True   # custom threshold


# --------------------------------------------------------- attempt verdicts

def _facts(**overrides: object) -> AttemptFacts:
    defaults: dict[str, object] = {
        "ffmpeg_return_code": 0,
        "source_return_code": 0,
        "elapsed_seconds": 195.0,
        "expected_seconds": 200.0,
        "stderr_text": "",
    }
    defaults.update(overrides)
    return AttemptFacts(**defaults)  # type: ignore[arg-type]


def test_completed_verdict_when_healthy() -> None:
    verdict = classify_attempt(_facts())
    assert verdict.outcome is AttemptOutcome.completed
    assert verdict.reason is None


def test_ffmpeg_nonzero_exit_always_fails_even_with_stderr_failure() -> None:
    verdict = classify_attempt(_facts(ffmpeg_return_code=1, stderr_text="Input/output error"))
    assert verdict.outcome is AttemptOutcome.retry_ffmpeg
    assert "status 1" in verdict.reason


def test_source_nonzero_exit_fails() -> None:
    verdict = classify_attempt(_facts(source_return_code=2))
    assert verdict.outcome is AttemptOutcome.retry_source


def test_premature_end_requires_both_conditions() -> None:
    # premature + failure stderr -> retryable
    assert classify_attempt(_facts(elapsed_seconds=10.0, stderr_text="connection reset")).outcome is AttemptOutcome.premature_end
    # premature but clean stderr -> completed (may be legit short)
    assert classify_attempt(_facts(elapsed_seconds=10.0)).outcome is AttemptOutcome.completed
    # failure stderr but full runtime -> completed
    assert classify_attempt(_facts(stderr_text="connection reset")).outcome is AttemptOutcome.completed


def test_none_return_codes_treated_as_success() -> None:
    assert classify_attempt(_facts(ffmpeg_return_code=None, source_return_code=None)).outcome is AttemptOutcome.completed


# ---------------------------------------------------------------- progress

def test_progress_idle_has_no_elapsed() -> None:
    state = PlaybackState()
    out = playback_progress(state, now_monotonic=1000.0)
    assert out["elapsed_seconds"] is None
    assert out["progress_percent"] is None
    assert out["started_at"] is None


def test_progress_playing_computes_from_started_at() -> None:
    state = PlaybackState(
        mode=PlaybackMode.playing,
        started_at_epoch_seconds=100.0,
        started_at_monotonic_seconds=900.0,
        now_playing_duration_seconds=200,
    )
    out = playback_progress(state, now_monotonic=1000.0)
    assert out["elapsed_seconds"] == pytest.approx(100.0)
    assert out["progress_percent"] == pytest.approx(50.0)
    assert out["started_at"] == 100.0


def test_progress_paused_uses_frozen_elapsed() -> None:
    state = PlaybackState(
        mode=PlaybackMode.playing,
        paused=True,
        paused_elapsed_seconds=42.0,
        started_at_monotonic_seconds=900.0,
        now_playing_duration_seconds=200,
    )
    # Wall clock advanced 500s but paused clock must not move.
    out = playback_progress(state, now_monotonic=1400.0)
    assert out["elapsed_seconds"] == 42.0
    assert out["progress_percent"] == pytest.approx(21.0)


def test_progress_never_negative_and_caps_at_100() -> None:
    state = PlaybackState(
        mode=PlaybackMode.playing,
        started_at_monotonic_seconds=1500.0,
        now_playing_duration_seconds=100,
    )
    assert playback_progress(state, 1000.0)["elapsed_seconds"] == 0.0
    out = playback_progress(state, 5000.0)
    assert out["elapsed_seconds"] == 3500.0
    assert out["progress_percent"] == 100.0


def test_progress_without_duration_still_reports_elapsed() -> None:
    state = PlaybackState(mode=PlaybackMode.playing, started_at_monotonic_seconds=0.0)
    out = playback_progress(state, 33.0)
    assert out["elapsed_seconds"] == 33.0
    assert out["progress_percent"] is None


def test_progress_without_started_at_reports_none() -> None:
    state = PlaybackState(mode=PlaybackMode.playing)
    assert playback_progress(state, 10.0)["elapsed_seconds"] is None


# ------------------------------------------------------------- repeat cycle

def test_repeat_cycle_roundtrip_preserves_fields() -> None:
    item = repeat_cycle_item_from(FakeRow())
    assert isinstance(item, RepeatCycleItem)
    fields = new_item_fields(item)
    assert fields["source_url"] == "https://s"
    assert fields["provider"] == "youtube"
    assert fields["playlist_id"] == 7
    assert set(fields) == {
        "source_url", "provider", "provider_item_id", "normalized_url",
        "source_type", "title", "duration_seconds", "thumbnail_url", "playlist_id",
    }


def test_repeat_cycle_defaults_playlist_id_to_none_when_absent() -> None:
    @dataclass
    class NoPlaylistRow:
        source_url: str = "s"
        provider: str | None = None
        provider_item_id: str | None = None
        normalized_url: str = "n"
        source_type: str = "youtube"
        title: str | None = None
        duration_seconds: int | None = None
        thumbnail_url: str | None = None

    assert repeat_cycle_item_from(NoPlaylistRow()).playlist_id is None


def test_replay_item_coalesces_missing_source_url() -> None:
    row = FakeRow(source_url="")
    assert replay_item_from(row)["source_url"] == "unknown"


def test_repeat_cycle_items_are_frozen() -> None:
    item = repeat_cycle_item_from(FakeRow())
    import dataclasses

    with pytest.raises(dataclasses.FrozenInstanceError):
        item.title = "x"  # type: ignore[misc]


# ---------------------------------------------------------------------- seek

@pytest.mark.parametrize(
    ("percent", "duration", "expected"),
    [
        (50.0, 200.0, 100.0),
        (0.0, 200.0, 0.0),
        (100.0, 200.0, 200.0),
        (150.0, 200.0, 200.0),   # clamp high
        (-20.0, 200.0, 0.0),     # clamp low
        (50.0, 0.0, 0.0),        # unknown duration
        (50.0, None, 0.0),
    ],
)
def test_seconds_from_percent(percent: float, duration: float | None, expected: float) -> None:
    assert seconds_from_percent(percent, duration) == expected


def test_clamp_seek_seconds() -> None:
    assert clamp_seek_seconds(-5.0, 200.0) == 0.0
    assert clamp_seek_seconds(500.0, 200.0) == 200.0
    assert clamp_seek_seconds(50.0, 200.0) == 50.0
    assert clamp_seek_seconds(999.0, None) == 999.0  # no cap without duration


# ------------------------------------------------------------------- shuffle

def test_shuffled_order_permutes_deterministically_with_injected_rng() -> None:
    ids = [1, 2, 3, 4, 5]
    rng = type("R", (), {"shuffle": staticmethod(lambda seq: seq.reverse())})()
    assert shuffled_order(ids, rng=rng) == [5, 4, 3, 2, 1]  # type: ignore[arg-type]
    assert ids == [1, 2, 3, 4, 5]  # input untouched


def test_restore_order_keeps_only_surviving_ids_in_saved_sequence() -> None:
    assert restore_order(current=[3, 1, 2], restore=[2, 1, 5]) == [2, 1]
    assert restore_order(current=[1], restore=None) is None
    assert restore_order(current=[1], restore=[9, 9]) is None  # nothing survives


# -------------------------------------------------------------------- state

def test_playback_state_defaults() -> None:
    state = PlaybackState()
    assert state.mode is PlaybackMode.idle
    assert state.repeat_mode is RepeatMode.off
    assert state.shuffle_enabled is False
    assert state.now_playing_id is None
    assert state.started_at_monotonic_seconds is None
