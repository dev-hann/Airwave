from app.core.config import Settings


def test_chunk_size_default_uses_streaming_safe_baseline():
    settings = Settings()

    assert settings.chunk_size == 4096


def test_stream_path_default_is_shared_live_mp3():
    settings = Settings()

    assert settings.stream_path == "/stream/live.mp3"
