# @airwave/shared

Cross-stack contract package: shared enums (`src/enums.js`) and OpenAPI-generated TypeScript types (`src/generated/schema.d.ts`) consumed by `apps/web`.

Regenerate after backend response-model changes (repo root):

```bash
npm run contracts:gen
```

CI fails on drift. Never hand-edit generated files — see `AGENTS.md` here.
