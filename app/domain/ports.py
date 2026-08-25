"""Ports (driven-capability Protocols) required by the playback domain/usecases.

Minimal by design: only the capabilities the playback pipeline calls directly
get a port (see docs/backend/clean-architecture.md "Port creation rule").
Adapters implement these structurally; tests/test_ports.py asserts the
production adapters still conform.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, runtime_checkable


@runtime_checkable
class ResolvedTrackLike(Protocol):
    source_url: str
    normalized_url: str
    title: str | None
    channel: str | None
    duration_seconds: int | None
    thumbnail_url: str | None
    stream_url: str
    is_live: bool


@runtime_checkable
class TrackSource(Protocol):
    """yt-dlp adapter surface used by playback."""

    def resolve_video(self, url: str, force_refresh: bool = False) -> ResolvedTrackLike: ...

    def spawn_audio_download(self, url: str, output_path: str) -> object: ...


@runtime_checkable
class Transcoder(Protocol):
    """ffmpeg adapter surface used by playback."""

    def spawn_for_source(self, source_url: str, start_at_seconds: float = 0.0) -> object: ...

    def spawn_silence(self) -> object: ...

    def probe_source(self, source_url: str) -> dict[str, str | float | None]: ...


@runtime_checkable
class StreamSink(Protocol):
    """HLS segmenter surface: where encoded audio bytes go."""

    def write(self, data: bytes) -> None: ...

    def purge(self) -> None: ...

    def close(self) -> None: ...


@runtime_checkable
class PlaybackStore(Protocol):
    """Repository surface the playback session depends on (subset)."""

    def mark_playback_finished(self, item_id: int, status: object, error_message: str | None = None) -> None: ...

    def enqueue_items(self, items: list[object]) -> list[object]: ...

    def move_item_to_front(self, item_id: int) -> None: ...


@runtime_checkable
class Clock(Protocol):
    """Monotonic time source; production adapter is time.monotonic."""

    def __call__(self) -> float: ...


@runtime_checkable
class Sleeper(Protocol):
    """Blocking sleep; tests inject a no-op so retry paths run instantly."""

    def __call__(self, seconds: float) -> None: ...


# Convenience re-export for typing injection bundles.
ClockFn = Callable[[], float]
SleeperFn = Callable[[float], None]

__all__ = [
    "Clock",
    "ClockFn",
    "PlaybackStore",
    "ResolvedTrackLike",
    "Sleeper",
    "SleeperFn",
    "StreamSink",
    "TrackSource",
    "Transcoder",
]
