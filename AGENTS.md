# AGENTS.md

Core working guide for code agents in this repo. This file is the **index** — detailed docs live under `docs/` and must be read when the task matches (see table below). Keep changes small, targeted, and easy to verify.

## Purpose

**Airwave**: FastAPI backend + Vue/Vite frontend exposing **one shared live MP3 stream** for all clients. Users add YouTube URLs or playlists to a shared queue (Spotify playlists are importable via YouTube matching; SoundCloud/Mixcloud support was removed in this fork); browsers play the live stream directly via an `<audio>` element. (Sonos support was also removed in this fork; WLED/LedFX integration is external, not built in.)

Historical note: upstream had a SendSpin synchronized-playback subsystem (server + browser client); this fork removed it entirely — browsers play `/stream/live.mp3` directly. Do not reintroduce per-client audio paths.

This is a maintained fork (`dev-hann/Airwave`); upstream is inactive. See `docs/maintenance.md` for fork/license policy.

## Stack

- Backend: Python 3.12+, FastAPI, SQLAlchemy 2, pydantic-settings
- Frontend: Vue 3 (`<script setup>`), file-based routing (vite-plugin-pages), `@nuxt/ui`, Vite
- Runtime tools: `yt-dlp`, `ffmpeg`/`ffprobe`, `deno` (managed by BinariesService)
- Storage: SQLite via `AIRWAVE_DB_URL`

## Doc routing — MUST read before these tasks

| Task | Read first |
|---|---|
| Structural backend change (StreamEngine, Repository, API/DB structure) | `docs/backend/architecture.md` |
| Writing/modifying backend code | `docs/backend/conventions.md` |
| Frontend structure/state/build changes | `docs/frontend/structure.md` |
| Writing/modifying Vue components | `docs/frontend/conventions.md` |
| Adding or changing themes | `docs/frontend/themes.md` |
| yt-dlp/ffmpeg/deno updates, incidents, upstream, releases | `docs/maintenance.md` |

**Doc-sync rule**: if a code change conflicts with any doc above, update that doc in the same commit.

## Repository map (condensed)

- `app/main.py` — composition root: service wiring, lifespan
- `app/api/` — 19 domain sub-routers mounted by `app/api/routes.py` (45-line aggregator); shared models/serializers in `app/api/common/`
- `app/services/` — business logic (StreamEngine, PlaylistService, YtDlpService, FfmpegPipeline, BinariesService, …)
- `app/db/` — SQLAlchemy models + `repository.py` (all persistence, manual migrations)
- `app/core/config.py` — `AIRWAVE_*` settings
- `frontend/src/` — Vue app; builds to `app/static/dist` (served by FastAPI)
- `tests/` — pytest, 159 tests. `tests_e2e/` does **not** exist.

## Hard rules

1. Preserve the shared-stream model: `/stream/live.mp3` stays ONE stream for all listeners. No per-client transcoding.
2. Layering: `db ← services ← api ← main`. No reverse imports, no business logic in route handlers, DB access only via `Repository`.
3. Subprocesses use list-argv only. Never `shell=True`, never interpolate URLs/paths into command strings.
4. Shared services come from `request.app.state` (via `_services(request)`). No ad-hoc globals.
5. Keep API payload shapes stable; contract changes update backend + frontend in one commit.
6. Env-driven behavior goes through `app/core/config.py` (`AIRWAVE_*`), not hardcoded values.
7. New DB columns follow the existing `_ensure_*_column` migration pattern in `repository.py` (no Alembic, no third migration path).
8. Vue changes require `npm run build` before finishing (CI does not build the frontend).
9. Client disconnects/shutdown in streaming code are normal cases — handle gracefully, don't log-spam.
10. Match existing style in touched files; no unrelated refactors.

## Known constraints (do not silently "fix")

- **No authentication** — trust model is private LAN. Auth middleware is planned; don't expose to the internet meanwhile.
- `POST /api/binaries/install` is unauthenticated and replaces executables the server runs (known critical gap).
- Single process, in-process StreamEngine: no horizontal scaling; restart always breaks the live stream.
- God files needing care: `stream_engine.py` (~1330), `repository.py` (~950).
- Direct-URL ingestion has an SSRF surface (no internal-IP blocklist yet).
- Frontend has zero tests and zero lint config.

## Setup & validation

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"     # MUST be editable; non-editable breaks static tests
npm install
./scripts/setup_binaries.sh           # optional: local bare-metal dev only (Docker bakes binaries in)
./scripts/run_dev.sh                  # dev launcher (builds frontend if missing)
```

- Backend tests: `python -m pytest` (venv python only — assume no global pytest)
- Frontend build check: `npm run build`
- Smoke: `uvicorn app.main:create_app --factory` then open `/` (UI) and `/docs` (OpenAPI)

## Before finishing

- Run the smallest relevant validation for what you changed (`pytest` subset, `npm run build`, …).
- Backend behavior changed → run `python -m pytest`.
- Call out any validation you could not run.
- Never commit secrets, `.env`, binaries, or DB files.
- Doc-sync rule applies (see above).
