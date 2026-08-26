# @airwave/web

Vue 3 + Vite frontend for Airwave: queue management, playlists, live-listener UI. Browsers play the shared HLS stream (`/stream/live.m3u8`) directly — there is no per-client audio path.

Builds into `../server/app/static/dist` (FastAPI serves the build output). Run npm commands from the repo root.

See `AGENTS.md` here for the agent guide; `docs/frontend/` (repo root) for structure, conventions, architecture, and testing.
