from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request

from app.api.common.dependencies import _services
from app.api.common.serializers import _publish_ui_snapshot, _serialize_state, _stream_url
from app.core.config import Settings
from app.db.repository import NewPlaylistEntry
from app.services.stream_engine import StreamEngine

router = APIRouter()

# GitHub Releases lookup for the app-update badge. Cached to avoid hammering the API.
_GITHUB_REPO = "dev-hann/Airwave"
_UPDATES_CACHE_TTL_SECONDS = 300.0
_updates_cache: dict[str, Any] = {"at": 0.0, "latest": None}


@router.get("/health")
def health(request: Request) -> dict[str, str]:
    services = _services(request)
    return {"status": "ok", "mode": services["engine"].state.mode.value}


@router.get("/system/version")
def app_version(request: Request) -> dict[str, Any]:
    settings: Settings = _services(request)["settings"]
    version = settings.app_version
    return {"version": version, "is_release": version.startswith("v") and version[1:2].isdigit()}


@router.get("/system/updates")
def app_updates(request: Request) -> dict[str, Any]:
    settings: Settings = _services(request)["settings"]
    now = time.monotonic()
    latest = _updates_cache["latest"]
    if now - _updates_cache["at"] > _UPDATES_CACHE_TTL_SECONDS:
        try:
            response = httpx.get(
                f"https://api.github.com/repos/{_GITHUB_REPO}/releases/latest",
                timeout=5.0,
                headers={"Accept": "application/vnd.github+json"},
            )
            response.raise_for_status()
            latest = response.json().get("tag_name") or None
        except Exception:
            latest = None
        _updates_cache["at"] = now
        _updates_cache["latest"] = latest
    current = settings.app_version
    return {
        "current": current,
        "latest": latest,
        "has_update": bool(latest) and latest != current,
        "can_upgrade": bool(settings.watchtower_url),
        "releases_url": f"https://github.com/{_GITHUB_REPO}/releases",
    }


@router.post("/system/upgrade")
def upgrade_app(request: Request) -> dict[str, Any]:
    settings: Settings = _services(request)["settings"]
    if not settings.watchtower_url:
        raise HTTPException(status_code=503, detail="App upgrade is not configured (no Watchtower URL)")
    headers = {}
    if settings.watchtower_token:
        headers["Authorization"] = f"Bearer {settings.watchtower_token}"
    try:
        # Fire-and-observe: Watchtower applies the update asynchronously; the app
        # container may be replaced before this response reaches the client.
        response = httpx.post(
            f"{settings.watchtower_url.rstrip('/')}/v1/update",
            headers=headers,
            timeout=10.0,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Watchtower is unreachable")
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Watchtower returned {response.status_code}")
    return {"ok": True}


@router.get("/state")
def state(request: Request) -> dict[str, Any]:
    services = _services(request)
    engine: StreamEngine = services["engine"]
    return _serialize_state(engine, _stream_url(request), repo=services["repo"])


@router.post("/state/like")
def like_current_song(request: Request) -> dict[str, Any]:
    services = _services(request)
    engine: StreamEngine = services["engine"]
    now_playing_id = engine.state.now_playing_id
    if now_playing_id is None:
        raise HTTPException(status_code=409, detail="No active track")

    repo = services["repo"]
    playlist_service = services["playlist"]
    liked_playlist = repo.get_playlist_by_source_url("custom://liked_songs")
    if liked_playlist is None:
        raise HTTPException(status_code=500, detail="Liked Songs playlist is missing")

    item = repo.get_item(now_playing_id)
    if item is None:
        raise HTTPException(status_code=409, detail="Active track is missing")

    entry = {
        "source_url": item.source_url,
        "provider": getattr(item, "provider", None),
        "provider_item_id": getattr(item, "provider_item_id", None),
        "normalized_url": getattr(item, "normalized_url", None) or item.source_url,
        "title": getattr(item, "title", None),
        "channel": getattr(item, "channel", None),
        "duration_seconds": getattr(item, "duration_seconds", None),
        "thumbnail_url": getattr(item, "thumbnail_url", None),
    }

    created = playlist_service.add_entries_to_playlist(
        liked_playlist.id,
        entries=[NewPlaylistEntry(**entry)],
        import_mode="skip_duplicates",
    )
    _publish_ui_snapshot(request)
    return {
        "ok": True,
        "liked": True,
        "skipped_duplicates": bool(created.get("skipped_duplicates")),
        "state": _serialize_state(engine, _stream_url(request), repo=repo),
    }


@router.post("/state/unlike")
def unlike_current_song(request: Request) -> dict[str, Any]:
    services = _services(request)
    engine: StreamEngine = services["engine"]
    now_playing_id = engine.state.now_playing_id
    if now_playing_id is None:
        raise HTTPException(status_code=409, detail="No active track")

    repo = services["repo"]
    liked_playlist = repo.get_playlist_by_source_url("custom://liked_songs")
    if liked_playlist is None:
        raise HTTPException(status_code=500, detail="Liked Songs playlist is missing")

    item = repo.get_item(now_playing_id)
    if item is None:
        raise HTTPException(status_code=409, detail="Active track is missing")

    removed = repo.remove_playlist_track(
        liked_playlist.id,
        normalized_url=getattr(item, "normalized_url", None) or item.source_url,
        provider_item_id=getattr(item, "provider_item_id", None),
    )
    _publish_ui_snapshot(request)
    return {
        "ok": True,
        "unliked": True,
        "removed": removed,
        "state": _serialize_state(engine, _stream_url(request), repo=repo),
    }
