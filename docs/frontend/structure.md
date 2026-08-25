# Frontend Structure

Read this before touching frontend structure, state, or the build.

## Layout

- Source: `frontend/src/` (~8,700 lines, 53 files). Vite root is `frontend/`; build config lives in the repo-root `vite.config.js`.
- Build output goes to `app/static/dist/` (entry files forced to `app.js` / `app.css`). FastAPI serves that directory — **the served app is the build output, not `frontend/src`**.
- After changing any Vue file, composable, or router behavior: run `npm run build` so `app/static/dist` stays in sync. CI does not build the frontend (known gap) — the sync duty is yours.

## State management

No Pinia/Vuex. Plain composables + a hand-rolled event bus:

- `composables/useLibraryState.js` (~810 lines) — central library/queue/playlist state. Biggest state file; be surgical when editing.
- `composables/useLocalPlayback.js` — browser playback of the shared HLS stream (`/stream/live.m3u8`) via a shared `<audio>` element in `App.vue`: hls.js with a ~30s forward buffer on MSE engines, native HLS on iOS Safari (volume persisted in localStorage).
- `composables/websocketBus.js` — WS snapshot updates from the backend.
- `composables/eventBus.js` — tiny global emitter for cross-component events.

`App.vue` is the coordinator for queue, history, playlists, and playback state. Avoid duplicating global state in multiple components — share via composables/events instead.

## Components & pages

- 17 components in `components/`. Largest: `SpeakerPanel.vue` (~980), `TopBar.vue` (~470), `SidebarPlaylists.vue` (~390), `PlayerBar.vue` (~310).
- 13 file-based pages via `vite-plugin-pages` (`pages/`): `index`, `explorer`, `playlist/[id]` (~530), `fullscreen-player`, `search`, `spotify-import/[id]`, `settings`, `cookies`, `update`, … Router is `router.js` (7 lines) — routes come from the file tree.

## API access

All requests go through `fetchJson` in `composables/useApi.js` (unless there's a strong reason not to). Verify backend payload shapes against actual API responses — don't assume fields.

## Known gaps

- Zero frontend tests, zero lint config. Don't pretend otherwise in docs; if you add vitest/eslint, record it here and in AGENTS.md.
