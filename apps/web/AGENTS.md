# apps/web — Vue 3 + Vite frontend

Read the root `AGENTS.md` first; frontend doc routing lives there (`docs/frontend/*`).

## Package facts

- Vue 3 (`<script setup>`), file-based routing (vite-plugin-pages), `@nuxt/ui` v4 + Tailwind 4.
- npm-workspace member `@airwave/web`; run npm commands from the **repo root**, not here.
- Build output goes to `../server/app/static/dist` (entry forced to `app.js`/`app.css`). FastAPI serves that directory — **the served app is the build output, not this source tree**.

## Dev loop

```bash
npm run build      # repo root — required after any change here (CI builds too)
npm run dev        # vite dev server (proxy expectations: backend on :8000)
```

- New page = new file in `src/pages/`; no manual route registration.
- API calls go through the shared client in `src/lib/api/` (see `docs/frontend/conventions.md`) — payload types come from `@airwave/shared`'s generated `schema.d.ts`.
- State: Pinia stores in `src/stores/` (see `docs/frontend/architecture.md`); do not add module-level god-state.

## Gotchas

- After changing backend response models: regenerate contracts (`npm run contracts:gen` at root) or CI fails on drift.
- Frontend has unit tests (Vitest) for stores/lib/utils only — no component tests; don't claim DOM coverage.
- The single `<audio>` element in `App.vue` + `composables/useLocalPlayback.ts` is the only allowed playback path (ADR-0003).
