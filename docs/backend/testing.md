# Backend Testing

How the Node server's test suites are organized and run. Frontend tests: `docs/frontend/testing.md`.

## Running

```bash
npm install                      # workspace root, once
npm test --workspaces --if-present   # all packages (server + web)
# focused:
npx vitest run --root packages/domain
npx vitest run --root packages/usecases
npx vitest run --root packages/db
npx vitest run --root apps/node-server
# typecheck (CI gate, run all four):
for pkg in packages/domain packages/usecases packages/db apps/node-server; do (cd "$pkg" && npx tsc --noEmit); done
```

Real-ffmpeg E2E (in `apps/node-server/test/e2e-pipeline.test.ts`) auto-skip when `ffmpeg`/`ffprobe` are not on `PATH`; point `AIRWAVE_FFMPEG_PATH`/`AIRWAVE_FFPROBE_PATH` at binaries to enable.

## Layout

| Package | Focus |
|---|---|
| `packages/domain/test` | Pure playback rules: outcome classification, progress math, repeat-cycle, seek/shuffle — no fakes, sub-ms |
| `packages/usecases/test` | TrackAttemptRunner orchestration with injected clock + fake transcoder/hooks |
| `packages/db/test` | Repository invariants on real SQLite files (tmp dirs): sequential positions, single-playing self-heal, transactional history writes, Liked Songs seed |
| `apps/node-server/test` | HLS segmenter (fake packager, real FS), engine control flows (fake pipeline), API integration on a live Express app (supertest), real-ffmpeg E2E |

## Conventions

- **No network in unit tests.** yt-dlp/ffmpeg are faked (`RecordingHooks`, `ScriptedFfmpeg`, fake packager writing real playlist files). Only the E2E file touches real binaries.
- **Injected time everywhere.** Clocks (`() => number`) and sleepers are constructor options on the runner/engine — retry and backoff paths test in microseconds, no real waits. Polling loops in engine tests use generous deadlines (CI runners are slow).
- **Live app for API tests.** `test/api.test.ts` boots the real `createApp` on an ephemeral port with a stub track source and asserts wire shapes (field-for-field against the v1.x contract).
- **Fakes must mirror the real interface exactly** — a lagging fake silently gates coverage (the Python-era `FakeYtDlp.normalize_url` gap is the canonical example; see the WS-snapshot/contracts history).
- Style: strict TypeScript, double quotes, `.ts` import specifiers (`allowImportingTsExtensions`; runtime is `node --experimental-strip-types` — no parameter properties, `import type` for type-only re-exports).
