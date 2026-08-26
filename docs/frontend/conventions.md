# Frontend Conventions

Read this before writing or modifying frontend code. Structure overview: `structure.md`; state flow: `architecture.md`; tests: `testing.md`.

## TypeScript rules

- Strict mode, no `any` in new code; prefer precise types from `types/api.ts` (contract-backed) over invented shapes.
- SFCs use `<script setup lang="ts">`. Props: `defineProps<{...}>()` (+ `withDefaults` when needed, inlined, never on a variable). Emits: `defineEmits<{ eventName: [payload] }>()`.
- Wire-format changes: edit `packages/shared/src/contracts.ts` (zod) and update consumers in the same commit — there is no codegen step.
- Adding an endpoint whose payload isn't in the contract: derive the type in `types/api.ts` with a comment naming the backend source of truth.

## Patterns

- **API calls** only via `lib/api/http.ts` (`postJson` etc. — JSON headers handled). No raw `fetch` in components/stores.
- **State**: Pinia stores in `src/stores/`, one per domain. Components read state via `storeToRefs(store)` and call actions on the store instance. New domain state = new store, not a module-level ref.
- **Store-to-store** use is allowed inside actions (`useQueueStore()` inside playback actions); never at module import time in a cycle.
- **Duplicate-check flows**: always `withDuplicateCheck` in the playlists store — don't re-implement the modal branches.
- **Optimistic transport**: follow the capture→apply→POST→revert-on-error pattern (see `architecture.md`).
- **File-based routing**: new page = new file under `src/pages/`. No manual route registration.
- Presentational logic lives in components; shared request/state logic in stores; pure functions in `utils/`.
- UI action logic stays in the component that renders the control when behavior is local; emit events when parent coordination is needed.

## Style

- Double quotes, matching existing files. Follow the style of the file you touch — don't normalize whole files.
- No comments unless explaining a non-obvious decision (existing files show the bar).

## UX rules

- In-app modals (`UModal`) for confirmations and editing flows. Never browser `confirm()`/`alert()`/`prompt()`.
- UI depending on backend payloads: verify the shape against the contract or the real API response — don't assume fields.

## Build discipline

- After any Vue/store/composable/router change: `npm run build` (workspace root). The app serves `app/static/dist`, not source.
- Before finishing: `npm run typecheck -w apps/web` and `npm run test -w apps/web` (CI enforces both).
- Cross-stack changes (API contract + frontend consumer) land in one commit including regenerated contract types.
