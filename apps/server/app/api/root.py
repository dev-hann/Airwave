from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

from app.api.common.dependencies import _services
from app.api.common.serializers import render_frontend_shell

root_router = APIRouter()

_PLAYLIST_NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


@root_router.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    return render_frontend_shell(request)


@root_router.get("/stream/live.m3u8")
def stream_playlist(request: Request) -> Response:
    engine = _services(request)["engine"]
    client = request.client
    listener_key = f"{client.host}:{client.port}" if client else request.headers.get("user-agent", "unknown")
    engine.note_stream_listener(listener_key)
    return Response(
        content=engine.hls_playlist_text(),
        media_type="application/vnd.apple.mpegurl",
        headers=_PLAYLIST_NO_STORE_HEADERS,
    )


@root_router.get("/stream/{segment_name}")
def stream_segment(segment_name: str, request: Request) -> FileResponse:
    engine = _services(request)["engine"]
    path = engine.hls_segment_path(segment_name)
    if path is None:
        raise HTTPException(status_code=404, detail="Unknown stream segment")
    return FileResponse(
        path,
        media_type=engine.hls_segment_mime_type(),
        # Segment files are immutable once published; safe to cache briefly.
        headers={"Cache-Control": "public, max-age=60"},
    )
