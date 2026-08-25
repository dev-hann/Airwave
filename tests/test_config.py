from app.core.config import Settings


def test_chunk_size_default_uses_streaming_safe_baseline():
    settings = Settings()

    assert settings.chunk_size == 4096


def test_stream_path_default_is_shared_live_hls():
    settings = Settings()

    assert settings.stream_path == "/stream/live.m3u8"


def test_hls_defaults():
    settings = Settings()

    assert settings.hls_bitrate == "192k"
    assert settings.hls_segment_seconds == 4.0
    assert settings.hls_window_size == 12
