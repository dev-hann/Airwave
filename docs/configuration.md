# Configuration

All runtime configuration is env-driven via pydantic-settings with the `AIRWAVE_` prefix. **The source of truth is [`apps/server/app/core/config.py`](../apps/server/app/core/config.py)** — this page is a map, not a copy; defaults and constraints live in code only (a duplicated table would drift). `.env` files are honored (repo root, gitignored).

## Groups

- **Server**: `AIRWAVE_HOST`, `AIRWAVE_PORT`, `AIRWAVE_DB_URL` (SQLite default `./data/airwave.db`), `AIRWAVE_LOG_LEVEL`, `AIRWAVE_APP_VERSION` (injected by CI; `dev` locally).
- **Stream / HLS**: `AIRWAVE_MP3_BITRATE` (intermediate pipe; keep well above `hls_bitrate`), `AIRWAVE_HLS_BITRATE` (listener-facing AAC), `AIRWAVE_HLS_SEGMENT_SECONDS` (default 4s — latency vs. reload tradeoff), `AIRWAVE_HLS_WINDOW_SIZE` (live-window segment count; drives how much history joining listeners fetch and how much buffer mobile clients can ride out), `AIRWAVE_CHUNK_SIZE` (ffmpeg read size; small chunks underrun), `AIRWAVE_STREAM_PATH`.
- **Engine cadence**: `AIRWAVE_QUEUE_POLL_SECONDS`, `AIRWAVE_STREAM_STATS_LOG_SECONDS` (the `Engine stats ... hls_stream_listeners=N` log), `AIRWAVE_HISTORY_LIMIT`.
- **Binaries**: `AIRWAVE_YT_DLP_PATH`, `AIRWAVE_FFMPEG_PATH`, `AIRWAVE_FFPROBE_PATH`, `AIRWAVE_DENO_PATH` (defaults under `./bin/`; Docker bakes them at build time — see `docs/maintenance.md`).
- **Playlists**: `AIRWAVE_PLAYLIST_SYNC_INTERVAL_SECONDS`, `AIRWAVE_PLAYLIST_SYNC_MAX_CONCURRENT`.
- **Local media**: `AIRWAVE_LOCAL_MEDIA_ROOTS` — **deliberately a string** (comma-separated paths or a JSON-array string), parsed via `Settings.local_media_roots_list`. Do not convert to `list[str]`: pydantic-settings JSON-decodes list fields from env before validators run and rejects plain `a,b` values (comment in `config.py`).
- **Updates**: `AIRWAVE_WATCHTOWER_URL`, `AIRWAVE_WATCHTOWER_TOKEN` — both empty by default; the upgrade endpoint returns 503 and the UI hides the update button.

## Rules

- New behavior reads config through `Settings` (`get_settings()` / injected) — never `os.environ` directly (hard rule 6).
- Adding a setting = adding it to `config.py` with a comment explaining the tradeoff; update this page's group list in the same commit.
- Precedence: real env vars beat `.env`.
