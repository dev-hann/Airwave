# AGENTS.md

Core working guide for code agents in this repo. This file is the **index** — detailed docs live under `docs/` and must be read when the task matches (see table below). Keep changes small, targeted, and easy to verify.

## Purpose

**Airwave**: Node.js backend + Vue/Vite frontend exposing **one shared live HLS stream** for all clients. Users add YouTube URLs or playlists to a shared queue; browsers play the live stream (`/stream/live.m3u8`) via hls.js (native HLS on iOS Safari). v2.0.0 migrated the backend from Python/FastAPI to Node/Express — the wire format is unchanged.

## Stack

- Backend: Node.js 22 (TypeScript, `--experimental-strip-types`), Express 5, `ws`, zod
- Data: SQLite via drizzle-orm + better-sqlite3 (clean-start schema; manual DDL in `Repository.init()`)
- Frontend: Vue 3 (`<script setup lang="ts">`, strict), Pinia setup stores, file-based routing (vite-plugin-pages), `@nuxt/ui` v4, Tailwind 4, Vitest + vue-tsc
- Runtime tools: `yt-dlp`, `ffmpeg`/`ffprobe`, `deno` (downloaded in Docker build)
- Monorepo: npm workspaces — `apps/node-server`, `apps/web`, `packages/{domain,usecases,db,shared}`

## Repository map

- `apps/node-server/src/` — Express app, composition root (main.ts), StreamEngine, FfmpegPipeline, HlsSegmenter, yt-dlp adapter, serializers, WS broker
- `packages/domain/` — pure playback rules (no I/O, no clock) shared by server AND web
- `packages/usecases/` — play-track orchestration (AttemptHooks contract)
- `packages/db/` — Drizzle schema + Repository facade
- `packages/shared/` — zod wire contracts + enums (single source for both sides)
- `apps/web/` — Vue app (`@airwave/web`); builds to `apps/node-server/static-dist`
- `docs/` — routed documentation (see table)

## Hard rules

1. `/stream/live.m3u8` stays ONE HLS stream for all listeners. No per-client transcoding.
2. Subprocesses use list-argv `spawn` only — never `shell`, never string interpolation.
3. Shared services come from the app instance (composition root). No ad-hoc globals.
4. Wire payloads are defined by `packages/shared/src/contracts.ts` (zod) — server and web import the SAME module; breaking changes ship in one commit with web consumers.
5. Env-driven behavior via `AIRWAVE_*` env vars (see main.ts), not hardcoded values.
6. New DB columns: extend the Drizzle schema in `packages/db/src/schema.ts` + DDL in `Repository.init()`. No ORM-generated migration tooling beyond that.
7. Vue changes require `npm run build` before finishing; frontend unit tests (`npm run test -w apps/web`) and typecheck (`npm run typecheck -w apps/web`) must pass (CI runs all three).
8. Client disconnects in streaming code are normal — handle gracefully, don't log-spam.
9. Domain layer stays pure: no I/O, wall clock, or framework imports in `packages/domain`.
10. Match existing style in touched files; no unrelated refactors.

## Known constraints (do not silently "fix")

- **No authentication** — trust model is private LAN.
- Single process, in-process engine: no horizontal scaling; restart breaks the live stream.
- Direct-URL ingestion has an SSRF surface (no internal-IP blocklist yet).
- Frontend has unit tests (stores/lib) but no component/DOM tests and no lint config.
- `--experimental-strip-types`: no TS parameter properties; type-only re-exports need `import type`.

## Setup & validation

```bash
npm install                          # workspace root
npm test --workspaces --if-present   # vitest: server packages + web stores/api
npm run build                        # frontend build check
# per-package typecheck:
for pkg in packages/domain packages/usecases packages/db apps/node-server; do (cd "$pkg" && npx tsc --noEmit); done
# smoke:
AIRWAVE_FFMPEG_PATH=... AIRWAVE_FFPROBE_PATH=... node --experimental-strip-types apps/node-server/src/main.ts
```

## Before finishing

- Run the smallest relevant validation (vitest subset, `npm run build`, tsc).
- Call out any validation you could not run.
- Never commit secrets, `.env`, binaries, or DB files.
