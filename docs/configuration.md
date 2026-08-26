# Configuration

All runtime configuration is env-driven with the `AIRWAVE_` prefix. **The source of truth is [`apps/node-server/src/main.ts`](../apps/node-server/src/main.ts)** and the modules it wires (`stream-engine.ts`, `hls-segmenter.ts`, `ffmpeg-pipeline.ts`) — this page is a map, not a copy; defaults and constraints live in code only (a duplicated table would drift).

## Groups

- **Server**: `AIRWAVE_HOST` (default `0.0.0.0`), `AIRWAVE_PORT` (default `8000`), `AIRWAVE_DB_URL` (SQLite; accepts python-style `sqlite:///…` URLs or plain paths — normalized in `main.ts`), `AIRWAVE_STATIC_DIR` (frontend bundle directory; default `apps/node-server/static-dist`), `AIRWAVE_HLS_DIR` (segment scratch directory; default `/tmp/airwave-hls-*`).
- **Media binaries**: `AIRWAVE_YT_DLP_PATH`, `AIRWAVE_FFMPEG_PATH`, `AIRWAVE_FFPROBE_PATH`, `AIRWAVE_DENO_PATH` (Docker bakes them at `/app/bin`; bare-metal runs typically point at `./bin/` — see `docs/maintenance.md`).
- **App identity**: `AIRWAVE_APP_VERSION` — injected by CI (`dev-<sha>` locally, tag name in releases).

## In-code tunables (not env yet — constants at construction sites)

These were `AIRWAVE_*` settings in the Python era and are currently hardcoded defaults passed to the engine/segmenter constructors in `app.ts`:

| Constant | Default | Where |
|---|---|---|
| Intermediate MP3 bitrate | `320k` | `FfmpegPipeline` construction (`app.ts`) |
| HLS AAC bitrate | `192k` | `spawnHlsPackager` options |
| Segment seconds | `4` | `HlsSegmenter` options |
| Window size | `12` segments | `HlsSegmenter` options |
| Queue poll seconds | `1` | `StreamEngine` options |
| Playback retry count | `2` | `StreamEngine` options |
| Chunk size | `4096` B | `StreamEngine` options |

Promoting any of these back to env = read it in `main.ts`, pass through `createApp` options, update this table in the same commit.

## Rules

- New behavior reads config from `process.env` **only in `main.ts`** (the composition root); services receive values via constructor options — no ad-hoc `process.env` sprinkled through modules.
- Adding a setting: read it in `main.ts` with a comment explaining the tradeoff; update this page's group list in the same commit.

## Python-era settings not carried over

`AIRWAVE_MP3_BITRATE`, `AIRWAVE_HLS_*`, `AIRWAVE_STREAM_QUEUE_SIZE`, `AIRWAVE_HUB_STALL_EVICTION_SECONDS`, `AIRWAVE_PLAYLIST_SYNC_*`, `AIRWAVE_LOCAL_MEDIA_ROOTS`, `AIRWAVE_HISTORY_LIMIT`, `AIRWAVE_WATCHTOWER_*` — the features either moved into the in-code tunables above, or (playlist sync, local media roots, watchtower-triggered upgrades) are not yet reimplemented on Node. Reintroduce on demand.
