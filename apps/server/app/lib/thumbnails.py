from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlparse


def resolved_thumbnail(item: Any) -> str | None:
    """Best-effort thumbnail URL: stored URL > YouTube provider id > parsed source URL."""
    thumbnail_url = getattr(item, "thumbnail_url", None)
    if thumbnail_url:
        return thumbnail_url
    provider_item_id = getattr(item, "provider_item_id", None)
    if provider_item_id:
        return f"https://i.ytimg.com/vi/{provider_item_id}/hqdefault.jpg"
    source_url = getattr(item, "source_url", None) or ""
    parsed = urlparse(source_url)
    host = (parsed.netloc or "").lower()
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}:
        video_id = (parse_qs(parsed.query).get("v") or [None])[0]
        if video_id:
            return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    if host in {"youtu.be", "www.youtu.be"}:
        video_id = (parsed.path or "").strip("/")
        if video_id:
            return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return None
