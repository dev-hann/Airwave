# packages/shared — cross-stack contract package

Read the root `AGENTS.md` first.

## Package facts

- npm-workspace member `@airwave/shared`; consumed by `apps/web` and the OpenAPI pipeline.
- Contents: `src/enums.js` (hand-written enums shared by backend codegen consumers) + `src/generated/schema.d.ts` (TS types generated from the backend's OpenAPI dump).
- **`schema.d.ts` is generated — never hand-edit.** Regenerate with `npm run contracts:gen` (repo root) after any backend response-model change. CI regenerates and fails on drift.

## Dev loop

```bash
npm run contracts:gen   # repo root: dumps OpenAPI from FastAPI app → openapi-typescript
git diff -- packages/shared/src/generated/schema.d.ts   # review before committing
```

## Gotchas

- Contract changes are hard rule 5: backend response model + regenerated types + frontend consumer update in **one commit**.
- The frontend imports types from here (`@airwave/shared/generated/schema.d.ts`); breaking a rename here is a frontend build break.
