# Frontend Conventions

Read this before writing or modifying Vue code.

## Style

- `<script setup>` + composition API primitives everywhere.
- Double quotes, matching the existing files. Follow the style of the file you touch — don't normalize whole files.
- Presentational logic lives in components; shared request/state utilities live in composables.
- UI action logic stays in the component that renders the control when behavior is local; emit events when parent coordination is needed (shared state, navigation, cross-component side effects).

## Patterns

- Use `fetchJson` from `composables/useApi.js` for API calls.
- Global state: composables (`useLibraryState`, `usePlaybackState`, …) + `eventBus` — see `docs/frontend/structure.md`. `App.vue` is the coordinator; children emit upward.
- File-based routing (`vite-plugin-pages`): new page = new file in `pages/`. No manual route registration.

## UX rules

- In-app modals (`UModal`) for confirmations and editing flows. Never use browser `confirm()`, `alert()`, `prompt()`.
- When adding UI that depends on backend payloads, verify the shape against the real API response.

## Build discipline

- After any Vue/composable/router change: `npm run build`. The app serves `app/static/dist`, not source.
- For cross-stack changes (API contract + Vue consumer), update both sides in one commit.
