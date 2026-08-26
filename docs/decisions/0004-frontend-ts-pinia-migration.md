# 0004. Frontend migration: TypeScript (strict) + Pinia stores + service layer

- Status: Accepted (in progress)
- Date: 2026-08-26

## Context

The frontend (`apps/web`) is plain JS with zero tests and zero lint. State lives in `useLibraryState.js` — an 805-line module mixing seven concerns (queue, history, playlists CRUD, playback transport, likes, local-media explorer actions, import orchestration) with 44 `fetchJson` calls and five copy-pasted duplicate-modal branches. Transport actions (skip/pause/repeat/shuffle) live in the library file but write into `usePlaybackState`'s state — split brain. `eventBus` exists but has exactly one real subscriber (`ws:snapshot` → `useLibraryState`); the WS send path is dead code. `@airwave/shared` generates a full OpenAPI `schema.d.ts` that the frontend never uses.

Constraints: solo/AI-maintained fork, no frontend tests today, served artifact is the Vite build.

Alternatives considered:

- **Keep JS, split modules only** — rejected: no type safety net, API contract stays unused.
- **Plain composables split instead of Pinia** — rejected: Pinia is the Vue-standard store with devtools and a generation of documented patterns; setup stores map 1:1 from current singletons.
- **shadcn-vue instead of `@nuxt/ui`** — rejected: `@nuxt/ui` v4 is already token-based on Reka UI (the same foundation), and shadcn-style vendoring transfers component maintenance cost into this repo.
- **Two-phase (restructure in JS, then convert to TS)** — rejected: double churn over the same files.

## Decision

Migrate in one pass, per-module, with a build gate after each phase:

1. **Strict TS** everywhere (`tsconfig.json`, `vue-tsc --noEmit` as a CI gate).
2. **Pinia setup stores, one per domain**: `playback` (state + transport + likes + optimistic rollback), `queue`, `history`, `playlists` (CRUD + import + one `withDuplicateCheck` helper collapsing the five modal branches), `explorer`, `ui` (incl. theme), `notifications`.
3. **Service layer** `lib/api/`: typed `http.ts` (`fetchJson<T>`/`postJson<T>`, `ApiError`), receive-only `ws.ts`, `sync.ts` applying snapshots to stores. `eventBus` and the dead WS send path are deleted.
4. **Types from the OpenAPI contract** (`@airwave/shared` `schema.d.ts`, aliased in `types/`), not hand-written shapes.
5. **Vitest** unit tests co-located with stores/lib/utils; no component tests yet.
6. Instance-scoped logic stays in `composables/` (`useLocalPlayback`, `useMediaSession`, `useBreakpoint`, …); pure functions in `utils/`.

## Consequences

- `useLibraryState.js`, `usePlaybackState.js`, `useUiState.js`, `useTheme.js`, `useNotifications.js`, `useDuplicateModal.js`, `useApi.js`, `websocketBus.js`, `eventBus.js` are deleted; ~22 components/pages get mechanical import rewrites.
- Frontend docs (`structure`, `conventions`, new `architecture` + `testing`) are rewritten in the same change (doc-sync).
- New-code rule: new store/util ships with tests; API calls only through `lib/api/http.ts`.
- Runtime behavior must not change — types are erased, logic moved verbatim (optimistic rollback, init order, WS-before-init snapshot loss covered by REST fallback are preserved).
