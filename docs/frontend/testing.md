# Frontend Testing

Vitest unit tests for `stores/`, `lib/api/`, and `utils/`. No component/DOM tests (decided in ADR-0004) — don't claim component coverage.

## Commands

```bash
npm run test -w apps/web          # vitest run (CI gate)
npm run test:watch -w apps/web    # watch mode
```

## Layout

Tests are co-located with the code under test: `foo.ts` ↔ `foo.test.ts` in the same directory (`src/stores/playback.test.ts`, `src/lib/api/http.test.ts`, …).

## What gets tested

| Layer | Approach |
|---|---|
| `utils/*` | Pure-function edge cases (durations, debounce with fake timers, error formatting). |
| `lib/api/http.ts` | `fetch` stubbed via `vi.stubGlobal`; 204/JSON/text/error-path behavior, `ApiError.detail` parsing. |
| `lib/api/sync.ts` | Real Pinia stores (`setActivePinia(createPinia())`); snapshots replace store state wholesale. |
| stores | `vi.mock("../lib/api/http")` for `postJson`/`deleteJson`/`fetchJson`; assert request payloads, optimistic updates, rollback on rejected mocks, duplicate-modal branch behavior. |

## Patterns

```ts
import { createPinia, setActivePinia } from "pinia";
import { postJson } from "../lib/api/http";
import { usePlaybackStore } from "./playback";

vi.mock("../lib/api/http", () => ({
  postJson: vi.fn().mockResolvedValue({}),
  fetchJson: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(postJson).mockReset().mockResolvedValue({});
});
```

- Rollback tests: `mockRejectedValueOnce(new Error("boom"))` → assert state reverted + correct endpoint called.
- In-flight preview tests: return a pending promise from the mock, assert optimistic state, then resolve.
- No network, no timers left running (fake timers for debounce), no DOM.

## Rules

- New store action or util with logic → test in the same change (regression risk areas: optimistic rollback, `withDuplicateCheck` branches, snapshot application).
- Bug fix in stores/lib → add the failing test first.
- Component tests would require `@vue/test-utils` + jsdom; only add with an ADR.
