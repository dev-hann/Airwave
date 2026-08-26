# apps/web — Vue 3 + TypeScript + Pinia frontend

Read the root `AGENTS.md` first; frontend doc routing lives there (`docs/frontend/*`).

## Package facts

- Vue 3 (`<script setup lang="ts">`, strict), Pinia setup stores, file-based routing (vite-plugin-pages), `@nuxt/ui` v4 + Tailwind 4, Vitest + vue-tsc.
- pnpm workspace member `@airwave/web`; run pnpm commands from the **repo root**, not here.
- Build output goes to `../node-server/static-dist` (entry forced to `app.js`/`app.css`). The Node server serves that directory — **the served app is the build output, not this source tree**.

## Dev loop

```bash
pnpm run build                          # repo root — required after any change here (CI builds too)
pnpm --filter @airwave/web dev          # vite dev server (backend on :8000)
pnpm --filter @airwave/web typecheck    # vue-tsc --noEmit
pnpm --filter @airwave/web test         # vitest (stores/lib/utils)
```

- New page = new file in `src/pages/`; no manual route registration.
- API calls go through the shared client in `src/lib/api/` — payload types come from `@airwave/shared/contracts` (zod). Both sides import the same module; there is no codegen step.
- State: Pinia stores in `src/stores/` (see `docs/frontend/architecture.md`); do not add module-level god-state.

## Gotchas

- Wire-format changes: edit `packages/shared/src/contracts.ts` and the web consumers in one commit (hard rule 4).
- Frontend has unit tests (Vitest) for stores/lib/utils only — no component tests; don't claim DOM coverage.
- The single `<audio>` element in `App.vue` + the playback wiring is the only allowed playback path (ADR-0003).
