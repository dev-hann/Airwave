# Frontend Structure

Read this before touching frontend structure, state, or the build. For how state flows, see `docs/frontend/architecture.md`; for code rules, `docs/frontend/conventions.md`.

## Layout

- Source: `apps/web/src/` (TypeScript, strict). npm-workspace member `@airwave/web`; vite config sits at `apps/web/vite.config.ts`. The repo is an npm-workspaces monorepo (`apps/*`, `packages/*`).
- Build output goes to `apps/node-server/static-dist/` (entry files forced to `app.js` / `app.css`). The Node server serves that directory — **the served app is the build output, not `apps/web/src`**.
- After changing any Vue file, store, composable, or router behavior: run `npm run build` (workspace root). CI also builds + typechecks + runs unit tests.
- Shared code: `@airwave/shared` (`packages/shared`) — enums + OpenAPI-generated `schema.d.ts` (regenerate with `npm run contracts:gen`; CI fails on drift).

## Tree

```
apps/web/src/
  main.ts            # app bootstrap: pinia → router → @nuxt/ui → WS connect → mount
  router.ts          # createRouter + file-based routes from vite-plugin-pages
  types/api.ts       # payload types: schema.d.ts aliases + serializer-derived shapes
  lib/api/
    http.ts          # typed fetch client (fetchJson/postJson/patchJson/deleteJson/getJson, ApiError)
    ws.ts            # receive-only WS client (reconnect backoff, onSnapshot registry)
    sync.ts          # snapshot → stores; initializeLibraryData()
  stores/            # Pinia setup stores — one per domain (see architecture.md)
    playback.ts      # playback state + transport + likes + 1s ticker + optimistic rollback
    queue.ts         # queue list + add/remove/reorder/clear
    history.ts       # history list + clear
    playlists.ts     # playlists CRUD + import + duplicate-check modal + reorder
    explorer.ts      # stateless local-media actions (browse/queue/play)
    ui.ts            # sidebar/tabs/search/mobile view/theme (localStorage-persisted)
    notifications.ts # toast plumbing (initialize(useToast()) in App.vue)
  composables/       # instance-scoped (no global state here)
    useLocalPlayback.ts  # the single <audio> element: HLS engine, rejoin, volume/mute
    useMediaSession.ts   # OS media controls → playback store transport
    useBreakpoint.ts     # isMobile / isTabletLayout
    usePlaylistSelector.ts # playlist dropdown filtering (pure helper)
  utils/             # pure functions: duration.ts, debounce.ts, errors.ts
  components/        # 15 components; primitives live here too (SongProgress, explorer/*)
  pages/             # 12 file-based pages via vite-plugin-pages
```

## State management

Pinia setup stores, one per domain. **Do not add module-level god-state** — new domain state = new store. Instance-scoped concerns (an audio element, a media session) stay in `composables/`. See `docs/frontend/architecture.md` for the store map and data-flow rules.

`App.vue` is the composition root: owns the `<audio>` element (`useLocalPlayback`), registers media-session handlers, wires ui-store route watchers, and kicks off `initializeLibraryData()` + `initializePlayback()` on mount.

## API access

All requests go through `lib/api/http.ts` (`fetchJson<T>` / `postJson<T>` / …) — never raw `fetch` outside it (settings/update.vue's binary-install + upgrade endpoints are the historical exception; don't copy them). Payload types come from `types/api.ts`; verify shapes against the generated contract or backend serializers, don't invent fields.

## Known gaps

- No component/DOM tests (unit tests cover stores/lib/utils only — see `docs/frontend/testing.md`).
- No ESLint/prettier config; match surrounding style manually.
