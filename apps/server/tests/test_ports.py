"""Port conformance tests: production adapters must satisfy the domain
Protocols they implement. Drift (renamed method, missing capability) fails
here instead of exploding in the worker thread at runtime.
"""

from __future__ import annotations

from typing import Any

from app.domain.ports import Clock, PlaybackStore, Sleeper, StreamSink, TrackSource, Transcoder
from app.services.ffmpeg_pipeline import FfmpegPipeline
from app.services.hls_segmenter import HlsSegmenter
from app.services.yt_dlp_service import YtDlpService
from app.db.repository import Repository


def _hls_segmenter(tmp_path: Any) -> HlsSegmenter:
    def _spawn(playlist_path: str, segment_pattern: str, *, start_number: int) -> object:
        return object()

    return HlsSegmenter(_spawn, directory=str(tmp_path / "ports-hls"))


def test_ffmpeg_pipeline_satisfies_transcoder() -> None:
    pipeline = FfmpegPipeline("ffmpeg", "ffprobe", bitrate="192k")
    assert isinstance(pipeline, Transcoder)


def test_hls_segmenter_satisfies_stream_sink(tmp_path: Any) -> None:
    segmenter = _hls_segmenter(tmp_path)
    assert isinstance(segmenter, StreamSink)


def test_yt_dlp_service_satisfies_track_source(tmp_path: Any) -> None:
    repo = Repository(f"sqlite+pysqlite:///{tmp_path}/ports-ytdlp.db")
    repo.init_db()
    service = YtDlpService("yt-dlp", "ffmpeg", "deno", repository=repo)
    assert isinstance(service, TrackSource)


def test_repository_satisfies_playback_store(tmp_path: Any) -> None:
    repo = Repository(f"sqlite+pysqlite:///{tmp_path}/ports-repo.db")
    repo.init_db()
    assert isinstance(repo, PlaybackStore)


def test_time_callables_satisfy_clock_and_sleeper() -> None:
    import time

    assert isinstance(time.monotonic, Clock)
    assert isinstance(time.sleep, Sleeper)


def test_stream_engine_surface_used_by_api_matches_facade(tmp_path: Any) -> None:
    """The HLS facade methods the root router calls must exist with the
    expected signatures (regression guard for the facade freeze)."""
    from inspect import signature

    from app.services.stream_engine import StreamEngine

    for method in ("hls_playlist_text", "hls_segment_path", "note_stream_listener", "hls_segment_mime_type"):
        assert callable(getattr(StreamEngine, method, None)), f"StreamEngine.{method} missing"
    assert list(signature(StreamEngine.hls_segment_path).parameters) == ["self", "name"]
    assert list(signature(StreamEngine.note_stream_listener).parameters) == ["self", "client_key"]
