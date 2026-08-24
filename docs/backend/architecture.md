# Backend Architecture

Read this before touching `app/services/stream_engine.py`, `app/db/repository.py`, `app/services/sendspin_service.py`, or any structural backend change.

## Runtime topology

Single process, single host:

```
Queue (SQLite) ──▶ StreamEngine (worker thread)
                      │  resolves next track
                      ▼
                  YtDlpService ──▶ yt-dlp subprocess (binary at AIRWAVE_YT_DLP_PATH)
                      │  yields direct media URL / local path
                      ▼
                  FfmpegPipeline ──▶ ffmpeg subprocess → MP3 bytes on stdout
                      │
                      ▼
                  SharedMp3Hub (in-memory fan-out buffer)
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
  HTTP listeners  SendSpinServer  (Sonos pulls the
  /stream/live.mp3  PCM clients    same /stream URL)
```

- Ports: `8000` FastAPI (API + UI + stream), `8927` SendSpin server (optional, `AIRWAVE_SENDSPIN_ENABLED`).
- Docker `network_mode: host` is required for Sonos SSDP discovery — do not switch to bridge networking without solving that.
- StreamEngine runs in-process. Restarting the app always breaks the live stream. Horizontal scaling is impossible by design; do not add per-client transcoding.

## Module map (with sizes — bigger = more care)

| Module | Lines | Responsibility |
|---|---|---|
| `services/stream_engine.py` | ~1330 | Playback loop, prefetch, seek/shuffle/repeat, SharedMp3Hub fan-out. **God file, ~60 methods** |
| `db/repository.py` | ~956 | All DB access + hand-rolled migrations. **God file** |
| `services/sendspin_service.py` | ~939 | SendSpin server, PCM feed, synced playback. **God file** |
| `services/binaries_service.py` | ~715 | yt-dlp/ffmpeg/ffprobe/deno download, install, update |
| `services/playlist_service.py` | ~687 | URL ingestion, playlist preview/import, queue construction |
| `services/spotify_import_service.py` | ~506 | Spotify → YouTube/SoundCloud matching |
| `services/yt_dlp_service.py` | ~440 | Metadata, source resolution, playlist inspection |
| `services/sonos_service.py` | ~422 | soco discovery/grouping/control |
| `services/ffmpeg_pipeline.py` | ~352 | ffmpeg/ffprobe spawn, transcode, probe |
| `services/source_resolver.py` | ~313 | Local media allowlist + direct HTTP media |
| `services/sync_service.py` | ~307 | Background playlist auto-sync |
| `extractors/` | ~520 | youtube / soundcloud / mixcloud / base / dispatcher |
| `core/config.py` | 155 | pydantic-settings, `AIRWAVE_*` env vars |
| `main.py` | 194 | Composition root: constructs all 13 services, wires `app.state.*` |

## API surface

- `app/api/routes.py` is a 45-line aggregator mounting **19 domain sub-routers** under `/api`.
- Route domains live in `app/api/{system,binaries,settings,queue,media,playback,history,playlist,playlists,ws,search,sonos,sendspin,spotify}/`.
- Shared helpers: `app/api/common/` — `models.py` (Pydantic schemas), `serializers.py` (`_serialize_*`, UI snapshot), `dependencies.py` (`_services(request)` accessor), `responses.py` (`GracefulStreamingResponse`).
- 73 endpoints under `/api` (72 HTTP + 1 WS) plus root routes in `app/api/root.py` (`/` and `/stream/live.mp3`).
- OpenAPI docs at `/docs` (auto-generated).

## Layering rules (verified, keep it this way)

```
db  ←  services  ←  api  ←  main
```

No reverse imports. Services import `db.models`/`db.repository`/`lib.tools` and each other downward only. `main.py:74-80` has a forward reference via closure (`notify_ui_state_changed` uses `sendspin_service` before assignment) — works, but fragile; don't copy the pattern.

## Database

- SQLAlchemy 2.0 declarative, typed `Mapped[]` columns (`app/db/models.py`). 6 tables: `playlists`, `queue_items`, `playlist_entries`, `play_history`, `settings`, `sendspin_clients`.
- **No Alembic.** Migrations run at startup via `_ensure_*_column` helpers in
  `repository.py` (`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`).
  Adding a column → extend the `_ensure_*` pattern. This is the only migration path.
- "Liked Songs" playlist is auto-seeded (`repository.py`), `can_edit/can_delete=False`.
- Thread lock guards queue mutations (`repository.py`).
- SQLite file at `data/airwave.db` (gitignored).

## Known gaps (do not "fix" silently — decisions pending)

- **No auth anywhere.** Trust model is a private LAN. An authentication middleware is planned; until then, do not expose the app to the internet.
- `POST /api/binaries/install` replaces executables the server runs — unauthenticated. Treated as a known critical gap.
- Direct-URL ingestion allows server-side ffprobe fetches of arbitrary http(s) URLs (SSRF surface). No internal-IP blocklist yet.
- `main.py` has silent `except Exception: pass` blocks in the lifespan (~lines 79, 163, 172).
- Cookie blobs (yt-dlp) stored via settings API, written to plaintext temp files — acceptable for self-host, don't log them.
