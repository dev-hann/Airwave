# Backend Architecture

Read this before touching `apps/node-server/src/`, `packages/domain`, `packages/usecases`, `packages/db`, or any structural backend change. Layer rules for the domain/usecase layers live in `docs/backend/clean-architecture.md` (lint- and test-enforced).

Historical note: upstream shipped a SendSpin synchronized-playback subsystem (`sendspin_service.py`, `/api/sendspin/*`, PCM paths in FfmpegPipeline). This fork removed it entirely; browsers play the shared HLS stream via a plain `<audio>` element (hls.js on MSE engines, native HLS on iOS Safari). Do not reintroduce per-client audio paths. The earlier raw-MP3 endpoint `/stream/live.mp3` was replaced by `/stream/live.m3u8` + segment files in v1.3.0.

## Runtime topology

Single process, single host:

```
Queue (SQLite) ──▶ StreamEngine (worker thread)
                      │  resolves next track
                      ▼
                   YtDlpService ──▶ yt-dlp subprocess (binary at AIRWAVE_YT_DLP_PATH)
                      │  yields direct media URL / local path
                      ▼
                   FfmpegPipeline ──▶ per-track ffmpeg → continuous MP3 on stdout
                      │
                      ▼
                   HlsSegmenter ──▶ ONE long-running packager ffmpeg
                      │               (MP3 stdin → AAC 192k MPEG-TS segments
                      │                + sliding window on disk)
                      ▼
                   HTTP: /stream/live.m3u8 + /stream/segNNNNNNNNNN.ts
                      (plain-file serving; browsers buffer via hls.js /
                       native HLS, so slow clients never backpressure the
                       engine — the zombie-subscriber problem is structurally
                       gone)
```

- Ports: `8000` Express (API + UI + stream).
- Browser-facing `stream_url` (API state, WS snapshots) is a **relative path** (`settings.stream_path`, default `/stream/live.m3u8`). The UI and the stream share one origin, so this works no matter which host (LAN IP, VPN IP, localhost) a client used. There is no absolute-URL computation and no `AIRWAVE_PUBLIC_BASE_URL`.
- The compose file keeps Docker `network_mode: host` for simplicity (historically required for Sonos SSDP discovery; Sonos support has since been removed).
- StreamEngine runs in-process. Restarting the app always breaks the live stream. Horizontal scaling is impossible by design; do not add per-client transcoding.

## Module map (with sizes — bigger = more care)

| Module | Lines | Responsibility |
|---|---|---|
| `services/stream_engine.py` | ~900 | Playback session: retry policy, interrupt dispatch, prefetch, HLS facade. Attempt body delegated to `usecases/play_track.py` |
| `domain/` | ~450 | Pure playback rules: state types, attempt-outcome classification, progress math, repeat-cycle items, seek/shuffle math, ports |
| `usecases/play_track.py` | ~300 | One playback attempt: resolve → probe → spawn → chunk loop → verdict (clock injected, unit-tested without waiting) |
| `services/hls_segmenter.py` | ~290 | HLS packager lifecycle, sliding window, playlist rendering, listener registry |
| `db/repository/` (package) | ~950 | Facade `Repository` composing store mixins: base (plumbing + shared `_queue_lock`), migrations, queue_store, history_store, playlist_store, settings_store. Import surface frozen (`Repository`, `NewQueueItem`, `NewPlaylistEntry`) |
| `services/binaries_service.py` | ~715 | yt-dlp/ffmpeg/ffprobe/deno download, install, update |
| `services/playlist_service.py` | ~687 | URL ingestion, playlist preview/import, queue construction |
| `services/spotify_import_service.py` | ~506 | Spotify → YouTube matching |
| `services/yt_dlp_service.py` | ~440 | Metadata, source resolution, playlist inspection |
| `services/ffmpeg_pipeline.py` | ~352 | ffmpeg/ffprobe spawn, transcode, probe |
| `services/source_resolver.py` | ~313 | Local media allowlist + direct HTTP media |
| `services/sync_service.py` | ~307 | Background playlist auto-sync |
| `extractors/` | ~300 | youtube / base / dispatcher (SoundCloud & Mixcloud extractors removed in this fork) |
| `core/config.py` | 155 | pydantic-settings, `AIRWAVE_*` env vars |
| `main.py` | 194 | Composition root: constructs all 13 services, wires `app.state.*` |

## API surface

- `apps/node-server/src/app.ts` is the Express composition: domain-grouped route handlers (health/state/playback/queue/history/playlists/settings + HLS endpoints + ws). Handlers stay thin — validate → stores/engine → serialize.
- Route domains live in `app/api/{system,binaries,settings,queue,media,playback,history,playlist,playlists,ws,search,spotify}/`.
- Shared helpers: `app/api/common/` — `models.py` (Pydantic schemas), `serializers.py` (`_serialize_*`, UI snapshot), `dependencies.py` (`_services(request)` accessor). (`responses.py` was removed with the raw-MP3 endpoint.)
- 73 endpoints under `/api` (72 HTTP + 1 WS) plus root routes in `app/api/root.py` (`/`, `/stream/live.m3u8`, `/stream/{segment}`).
- OpenAPI docs at `/docs` (auto-generated).

## Layering rules (verified, keep it this way)

```
db  ←  services/adapters  ←  api  ←  main          (plain services)
domain  ←  usecases  ←  services(engine)            (playback pipeline)
```

No reverse imports. Services import `db.models`/`db.repository`/`lib.tools` and each other downward only.

## Database

- SQLAlchemy 2.0 declarative, typed `Mapped[]` columns (`app/db/models.py`). 5 tables: `playlists`, `queue_items`, `playlist_entries`, `play_history`, `settings`. (Legacy DBs may still contain an unused `sendspin_clients` table — harmless.)
- **No Alembic.** Migrations run at startup via `_ensure_*_column` helpers in
  `repository/migrations.py` (`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`).
  Adding a column → extend the `_ensure_*` pattern. This is the only migration path.
- "Liked Songs" playlist is auto-seeded (`repository/migrations.py`), `can_edit/can_delete=False`.
- Thread lock guards queue mutations (`repository/base.py`; spans queue ops + `mark_playback_finished`).
- SQLite file at `data/airwave.db` (gitignored).

## Known gaps (do not "fix" silently — decisions pending)

- **No auth anywhere.** Trust model is a private LAN. An authentication middleware is planned; until then, do not expose the app to the internet.
- `POST /api/binaries/install` replaces executables the server runs — unauthenticated. Treated as a known critical gap.
- Direct-URL ingestion allows server-side ffprobe fetches of arbitrary http(s) URLs (SSRF surface). No internal-IP blocklist yet.
- `main.py` has silent `except Exception: pass` blocks in the lifespan (~lines 79, 163, 172).
- Cookie blobs (yt-dlp) stored via settings API, written to plaintext temp files — acceptable for self-host, don't log them.
