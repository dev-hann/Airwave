# packages/shared — wire contracts + enums

Single source of truth for the wire format, imported by BOTH the Node server and the web app (no codegen, no OpenAPI pipeline).

## Contents

- `src/contracts.ts` — zod schemas (`PlaybackStateSchema`, `QueueItemSchema`, `HistoryRowSchema`, `PlaylistSchema`, `UiSnapshotSchema`, …). Inferred types (`z.infer`) are the payload types used across the codebase.
- `src/enums.js` — `RepeatMode`/`PlaybackMode` constants (JS, importable from the pre-TS parts of the app).

## Rules

- Field names are frozen to the v1.x wire format; breaking changes ship with every consumer in one commit (hard rule 4).
- Adding a field is additive; keep serializers (`apps/node-server/src/serializers.ts`) and this module in sync in the same change.
- This package has no tests of its own — the server's API integration tests assert the shapes.
