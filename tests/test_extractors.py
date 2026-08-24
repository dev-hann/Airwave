from app.services.extractors.dispatcher import ExtractorDispatcher
from app.services.extractors.youtube import YouTubeExtractor


def test_dispatcher_provider_and_playlist_detection():
    dispatcher = ExtractorDispatcher()
    assert dispatcher.detect_provider("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "youtube"
    assert dispatcher.is_playlist_url("https://www.youtube.com/playlist?list=PL123") is True
    assert dispatcher.is_playlist_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ") is False


def test_dispatcher_rejects_retired_providers():
    dispatcher = ExtractorDispatcher()
    for url in (
        "https://soundcloud.com/artist/track",
        "https://soundcloud.com/artist/sets/party",
        "https://www.mixcloud.com/user/show/",
    ):
        try:
            dispatcher.detect_provider(url)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Expected {url} to be rejected")


def test_youtube_single_and_playlist_extraction():
    extractor = YouTubeExtractor()
    single_raw = {
        "id": "dQw4w9WgXcQ",
        "title": "Never Gonna Give You Up",
        "uploader": "Rick Astley",
        "duration": 213,
        "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        "webpage_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    }
    single = extractor.extract_single("https://youtu.be/dQw4w9WgXcQ", single_raw)
    assert single.provider == "youtube"
    assert single.provider_item_id == "dQw4w9WgXcQ"
    assert single.source_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert single.duration_seconds == 213

    playlist_raw = {
        "title": "Sample Playlist",
        "entries": [
            {"id": "abc123", "title": "Track A", "uploader": "Channel A", "duration": 100},
            {"id": "def456", "title": "Track B", "uploader": "Channel B", "duration": 200},
            {"title": "Missing id"},
        ],
    }
    collection = extractor.extract_playlist("https://www.youtube.com/playlist?list=PL123", playlist_raw)
    assert collection.provider == "youtube"
    assert collection.title == "Sample Playlist"
    assert len(collection.items) == 2
    assert collection.items[0].source_url == "https://www.youtube.com/watch?v=abc123"
