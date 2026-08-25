from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlparse

from app.lib.thumbnails import resolved_thumbnail
from fastapi import Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from app.services.stream_engine import StreamEngine

from .dependencies import _services

templates = Jinja2Templates(directory="app/templates")


def _stream_path(request: Request) -> str:
    """Browser-facing stream reference. Relative path only: the UI and the
    stream are served from the same origin, so this works regardless of the
    host the client used to reach the server (LAN IP, Tailscale IP, ...)."""
    return _services(request)["settings"].stream_path


def _prefer_youtube_hq_thumbnail(url: str | None) -> str | None:
    """Map maxres YouTube CDN thumbs to hqdefault (yt-dlp often returns maxresdefault)."""
    if not url or "maxresdefault" not in url:
        return url
    host = (urlparse(url).netloc or "").lower()
    if "ytimg.com" not in host and host not in {"img.youtube.com", "www.img.youtube.com"}:
        return url
    return url.replace("maxresdefault.jpg", "hqdefault.jpg").replace("maxresdefault.webp", "hqdefault.webp")


def _serialize_state(
    state: Any,
    progress: dict[str, Any],
    stream_url: str,
    *,
    repo: Any | None = None,
) -> dict[str, Any]:
    """Shape the UI-facing playback state dict.

    `state` should be an engine.state_snapshot() copy (consistent multi-field
    view) and `progress` the matching engine.playback_progress() result —
    callers own cross-thread consistency.
    """
    now_playing_is_liked = False
    if repo is not None and getattr(state, "now_playing_id", None) is not None:
        try:
            liked = repo.get_playlist_by_source_url("custom://liked_songs")
            if liked is not None:
                item = repo.get_item(state.now_playing_id)
                if item is not None:
                    now_playing_is_liked = repo.playlist_contains_track(
                        liked.id,
                        normalized_url=getattr(item, "normalized_url", None),
                        provider_item_id=getattr(item, "provider_item_id", None),
                    )
        except Exception:
            now_playing_is_liked = False
    return {
        "mode": state.mode.value,
        "paused": state.paused,
        "repeat_mode": state.repeat_mode.value,
        "shuffle_enabled": state.shuffle_enabled,
        "can_seek": bool(state.now_playing_duration_seconds and state.now_playing_duration_seconds > 0),
        "now_playing_id": state.now_playing_id,
        "now_playing_title": state.now_playing_title,
        "now_playing_channel": getattr(state, "now_playing_channel", None),
        "now_playing_thumbnail_url": _prefer_youtube_hq_thumbnail(
            getattr(state, "now_playing_thumbnail_url", None)
        ),
        "now_playing_is_live": getattr(state, "now_playing_is_live", False),
        "now_playing_is_liked": now_playing_is_liked,
        "stream_url": stream_url,
        **progress,
    }


def _serialize_queue_items(items: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "id": item.id,
            "title": item.title,
            "source_url": item.source_url,
            "provider": item.provider,
            "provider_item_id": item.provider_item_id,
            "status": item.status.value,
            "queue_position": item.queue_position,
            "source_type": item.source_type,
            "channel": item.channel,
            "duration_seconds": item.duration_seconds,
            "thumbnail_url": resolved_thumbnail(item),
            "playlist_id": item.playlist_id,
        }
        for item in items
    ]


def _serialize_history_rows(rows: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "id": row.id,
            "queue_item_id": row.queue_item_id,
            "title": row.title,
            "source_url": row.source_url,
            "provider": row.provider,
            "provider_item_id": row.provider_item_id,
            "thumbnail_url": resolved_thumbnail(row),
            "status": row.status,
            "started_at": row.started_at,
            "finished_at": row.finished_at,
            "error_message": row.error_message,
        }
        for row in rows
    ]


def build_ui_snapshot(app) -> dict[str, Any]:
    settings = app.state.settings
    engine: StreamEngine = app.state.stream_engine
    repo = app.state.repository
    playlist = app.state.playlist_service
    return {
        "type": "snapshot",
        "state": _serialize_state(
            engine.state_snapshot(), engine.playback_progress(), settings.stream_path, repo=repo
        ),
        "queue": _serialize_queue_items(repo.list_queue()),
        "history": _serialize_history_rows(repo.list_history(limit=settings.history_limit)),
        "playlists": playlist.list_playlists(),
    }


def _publish_ui_snapshot(request: Request) -> None:
    services = _services(request)
    services["ui_events"].publish_snapshot()


def render_frontend_shell(request: Request) -> HTMLResponse:
    services = _services(request)
    response = templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "app_name": services["settings"].app_name,
        },
    )
    # The shell references the (unhashed) bundle by fixed URL; it must always
    # be revalidated so clients pick up new builds instead of a stale UI.
    response.headers["Cache-Control"] = "no-cache"
    return response
