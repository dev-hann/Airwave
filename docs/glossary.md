# Glossary

Canonical vocabulary for code, docs, and discussions. Use these terms exactly; when adding a concept, add it here in the same commit.

## Streaming & playback

- **Shared stream** — the single live HLS stream (`/stream/live.m3u8`) every listener hears. One server-side encoder, no per-client paths (ADR-0002, ADR-0003).
- **HLS** — HTTP Live Streaming: playlist (`.m3u8`) + media segments fetched over plain HTTP. Served by `HlsSegmenter` on the backend, played by hls.js or native HLS on the client.
- **Segment** — one chunk of AAC/MP3 media in the HLS stream (see `HlsSegmenter`).
- **Live edge** — the newest segment; listeners play ~`liveSyncDurationCount` segments behind it.
- **hls_stream_listeners** — server metric: clients that polled the playlist in the last 30s.
- **Muted-prestart** — client playback model: the `<audio>` element starts *muted* to satisfy autoplay policy, then unmutes on first user gesture (see `stores/` + `useLocalPlayback.ts`).
- **Rejoin** — client-side recovery: reset `src`, re-attach the engine, and resume at the live edge after fatal media errors or foreground/background transitions.
- **Engine session** — one playback run in `StreamEngine`: resolving a queue item, starting the ffmpeg pipeline, segmenting, advancing to the next track.

## Queue & library

- **Queue** — the ordered play list driving the live stream. Items resolve (via yt-dlp) when they reach the head.
- **History** — played items, newest first.
- **Queue item** — one entry: URL/title/status/thumbnail/duration as exposed by the queue API.
- **Snapshot** — full-state WS payload (`{type: "snapshot", ...}`) replacing queue + history + playlists + playback state on the client. The only sync mechanism; no delta events.
- **Play-track orchestration** — `app/usecases/` pipeline turning a queue item into an engine session.

## Playlists

- **Playlist** — a saved list; `kind` distinguishes:
  - `custom` — locally curated entries.
  - `remote_youtube` — mirrors a YouTube playlist (imported by URL).
- **Duplicate check** — pre-add comparison that may open the duplicate modal (add all vs. add only new tracks). One shared helper (`withDuplicateCheck`) owns the flow.
- **Import** — ingesting a YouTube playlist URL or a Spotify playlist (matched to YouTube tracks; see `docs/maintenance.md` for what was removed).

## Frontend state

- **Store** — Pinia setup store in `apps/web/src/stores/`, one per domain (playback, queue, history, playlists, explorer, ui, notifications).
- **Optimistic update / rollback** — transport actions flip UI state immediately, POST to the server, and revert on failure (see `docs/frontend/architecture.md`).
- **Ticker** — 1s client interval recomputing elapsed/progress from the snapshot's `started_at`.
- **Local playback** — the browser's *audio element* concerns only (volume/mute, HLS engine, rejoin). Distinct from *transport* (play/pause/skip — server-side).

## Backend

- **Repository (facade)** — the only DB access surface (`app/db/repository/`); routes never touch SQLAlchemy directly.
- **Ports/Protocols** — engine collaborator interfaces (Transcoder, StreamSink, TrackSource, PlaybackStore); satisfaction enforced by `tests/test_ports.py`.
- **Binaries** — yt-dlp / ffmpeg / ffprobe / deno managed by `BinariesService` into `bin/` (Docker images bake them at build time).
- **Contract types** — the zod schemas in `packages/shared/src/contracts.ts`; server and web import the same module (no codegen).

## Ops

- **Watchtower (manual mode)** — in-Docker update path behind Settings → Update; pulls `:latest` and recreates the container.
- **Baseline** — fork point of upstream (`v0.1.0-baseline`, upstream `f63265b`).
