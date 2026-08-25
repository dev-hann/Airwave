from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from app.api.common.dependencies import _services
from app.api.common.models import PlaybackStateContract, UiSnapshotContract
from app.api.common.serializers import _publish_ui_snapshot, _serialize_state, _stream_path
from app.core.config import Settings
from app.db.repository import NewPlaylistEntry
from app.services.stream_engine import StreamEngine

router = APIRouter()

# GitHub Releases lookup for the app-update badge. Cached to avoid hammering the API.
_GITHUB_REPO = "dev-hann/Airwave"
_UPDATES_CACHE_TTL_SECONDS = 300.0
_updates_cache: dict[str, Any] = {"at": 0.0, "latest": None}


def _parse_version(value: str | None) -> tuple[int, ...] | None:
    """Parse 'v1.2.3' / '1.2.3' into a comparable tuple; None when unparsable
    (e.g. 'dev', 'dev-abc1234', custom strings)."""
    if not value:
        return None
    text = value.strip().lstrip("vV")
    parts = text.split(".")
    if not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def _has_newer_version(current: str | None, latest: str | None) -> bool:
    current_parts = _parse_version(current)
    latest_parts = _parse_version(latest)
    if current_parts is None or latest_parts is None:
        # Unparsable current (dev builds) or unparsable latest: never flag an update.
        return False
    return latest_parts > current_parts


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
        "has_update": _has_newer_version(current, latest),
        "can_upgrade": bool(settings.watchtower_url),
        "releases_url": f"https://github.com/{_GITHUB_REPO}/releases",
    }


@router.post("/system/upgrade", status_code=202)
async def upgrade_app(request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    settings: Settings = _services(request)["settings"]
    if not settings.watchtower_url:
        raise HTTPException(status_code=503, detail="App upgrade is not configured (no Watchtower URL)")

    def trigger_watchtower() -> None:
        headers = {}
        if settings.watchtower_token:
            headers["Authorization"] = f"Bearer {settings.watchtower_token}"
        try:
            # Fire-and-forget: Watchtower runs its session asynchronously (can
            # take a minute) and may replace this very container meanwhile.
            httpx.post(
                f"{settings.watchtower_url.rstrip('/')}/v1/update",
                headers=headers,
                timeout=5.0,
            )
        except httpx.HTTPError:
            pass

    background_tasks.add_task(trigger_watchtower)
    return {"ok": True, "status": "update_triggered"}


@router.get("/state", response_model=PlaybackStateContract)
def state(request: Request) -> dict[str, Any]:
    services = _services(request)
    engine: StreamEngine = services["engine"]
    return _serialize_state(
        engine.state_snapshot(), engine.playback_progress(), _stream_path(request), repo=services["repo"]
    )


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
        "state": _serialize_state(
            engine.state_snapshot(), engine.playback_progress(), _stream_path(request), repo=repo
        ),
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
        "state": _serialize_state(
            engine.state_snapshot(), engine.playback_progress(), _stream_path(request), repo=repo
        ),
    }


@router.get("/_contracts/snapshot", response_model=UiSnapshotContract, include_in_schema=True)
def contracts_snapshot(request: Request) -> dict[str, Any]:
    """Synthetic route exposing the WS snapshot payload shape in the OpenAPI
    schema for codegen (openapi-typescript). Served data is real; the endpoint
    is documented but not used by the UI."""
    import time as _time

    from app.api.common.serializers import build_ui_snapshot

    snapshot = build_ui_snapshot(request.app)
    snapshot.setdefault("timestamp", _time.time())
    return snapshot
