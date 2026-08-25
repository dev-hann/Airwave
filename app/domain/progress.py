"""Playback progress math, extracted from StreamEngine.playback_progress.

Pure function of (state, now): `now` is a monotonic clock reading supplied by
the caller so tests never wait or sleep.
"""

from __future__ import annotations

from typing import Any

from app.domain.playback_state import PlaybackMode, PlaybackState


def playback_progress(state: PlaybackState, now_monotonic: float) -> dict[str, Any]:
    if state.mode != PlaybackMode.playing:
        return {
            "duration_seconds": state.now_playing_duration_seconds,
            "started_at": state.started_at_epoch_seconds,
            "elapsed_seconds": None,
            "progress_percent": None,
        }

    duration = state.now_playing_duration_seconds
    if state.paused and state.paused_elapsed_seconds is not None:
        elapsed_seconds: float | None = state.paused_elapsed_seconds
    elif state.started_at_monotonic_seconds is not None:
        elapsed_seconds = max(0.0, now_monotonic - state.started_at_monotonic_seconds)
    else:
        elapsed_seconds = None

    progress_percent: float | None = None
    if elapsed_seconds is not None and duration:
        progress_percent = min(100.0, elapsed_seconds / duration * 100.0)
    return {
        "duration_seconds": duration,
        "started_at": state.started_at_epoch_seconds,
        "elapsed_seconds": elapsed_seconds,
        "progress_percent": progress_percent,
    }
