# @airwave/shared

Wire contracts shared by the Airwave server and web app.

- `contracts.ts` — zod schemas; `z.infer` types are the payload types both sides use.
- `enums.js` — `RepeatMode`, `PlaybackMode` constants.

Import from `@airwave/shared/contracts` (types) or `@airwave/shared` (enums). Single source of truth — the retired Python/OpenAPI codegen pipeline is not coming back; change the schemas here, not generated files.
