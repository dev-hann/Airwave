# Backend Conventions

Read this before writing or modifying backend code (`app/`).

## Layering (hard rule)

```
db  ←  services  ←  api  ←  main
```

- `routes` validate input, call services/repository, shape responses. No business logic in handlers.
- `services/` own business logic and orchestration.
- `repository.py` owns all database reads/writes.
- No reverse imports. No ad-hoc globals — shared services come from `request.app.state` via `app/api/common/dependencies.py::_services(request)`.

## Adding an endpoint

1. Create/extend the route file in the matching domain package under `app/api/<domain>/`. New domain → new package with `__init__.py` + `routes.py`, mount it in `app/api/routes.py`.
2. Pydantic request models go in `app/api/common/models.py` near related models.
3. Response shaping reuses the `_serialize_*` helpers in `app/api/common/serializers.py`. Extend existing helpers before adding parallel ones.
4. Keep API payload shapes stable unless the task explicitly requires a contract change. If the contract changes, update consuming Vue code in the same commit.
5. Error mapping convention (already widespread — follow it):
   - `ValueError` → `HTTPException(400, str(e))`
   - missing/None → `404`
   - avoid new `except Exception → 500 detail=str(e)` blocks; they leak internals. Don't add string-match dispatch on error messages.

## Services

- Queue/playlist ingestion logic belongs in `PlaylistService`, never in route handlers.
- YouTube resolution and playlist inspection belong in `YtDlpService`.
- DB mutations flow through `Repository` methods with typed helper objects (`NewQueueItem`, `NewPlaylistEntry`).
- Environment-dependent behavior goes through `app/core/config.py` + `AIRWAVE_*` vars. No hardcoded paths or URLs.

## Subprocess safety (keep)

All spawns (yt-dlp, ffmpeg, ffprobe, deno) use list-argv `subprocess.Popen` — no `shell=True`, no string interpolation into commands. URLs/paths are passed as single argv elements. Never regress this.

## Streaming code

Client disconnects and shutdown are expected cases, not exceptions. Long-running/streaming code must tolerate `asyncio.CancelledError` and closed transports without log-spamming errors.

## Preserve the shared-stream model

`/stream/live.mp3` is ONE shared MP3 stream for all listeners. Never turn it into per-client transcoding or per-client offsets. SendSpin handles synchronized per-client playback on its own channel.

## Config

New settings: add to `Settings` in `app/core/config.py` (env prefix `AIRWAVE_`, defaults in code, documented in README's Configuration section). `get_settings()` is `lru_cache`d — don't call `Settings()` ad hoc.

## Tests

- Test file per module in `tests/`, pytest style, `--timeout=300` enforced.
- Mock subprocesses and soco discovery (see `test_stream_engine.py` fake ffmpeg, `test_sonos_service.py` monkeypatched `soco.discover`) — tests must not need network or real speakers.
- Run: `source .venv/bin/activate && python -m pytest` (or focused subset). CI runs the same.
- Install deps editable: `pip install -e ".[dev]"`. Non-editable installs break static-file tests (`app/static` missing in site-packages).
