"""Domain types for shared playback state.

Pure Python: no framework, no I/O, no wall clock (timestamps are plain data
set by adapters). Moved from app/services/stream_engine.py during the
clean-architecture migration; app.services.stream_engine re-exports these for
compatibility.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class PlaybackMode(StrEnum):
    idle = "idle"
    playing = "playing"


class RepeatMode(StrEnum):
    off = "off"
    all = "all"
    one = "one"


@dataclass
class PlaybackState:
    mode: PlaybackMode = PlaybackMode.idle
    now_playing_id: int | None = None
    now_playing_title: str | None = None
    now_playing_channel: str | None = None
    now_playing_thumbnail_url: str | None = None
    now_playing_duration_seconds: int | None = None
    now_playing_is_live: bool = False
    started_at_epoch_seconds: float | None = None
    started_at_monotonic_seconds: float | None = None
    paused: bool = False
    paused_elapsed_seconds: float | None = None
    repeat_mode: RepeatMode = RepeatMode.off
    shuffle_enabled: bool = False
