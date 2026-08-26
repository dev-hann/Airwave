# Contributing to Airwave (dev-hann fork)

This fork is maintained primarily by AI agents with human review. The working guide for agents is [`AGENTS.md`](./AGENTS.md) — read it (and the doc it routes you to) before touching code. This file covers the human/PR side.

## Ground rules

1. **Follow `AGENTS.md` hard rules.** The short version: preserve the one-shared-stream model, keep the layering (`db ← services ← api ← main`), list-argv subprocesses only, API access only via the Repository, payload changes ship backend + frontend together.
2. **Doc-sync**: if your change conflicts with any doc under `docs/`, update that doc in the same commit. Structural decisions get an ADR in `docs/decisions/` first (see its README).
3. **Never commit** secrets, `.env`, binaries, or DB files.

## Validation before opening a PR

```bash
source .venv/bin/activate
cd apps/server && python -m pytest      # backend suite (270 tests)
cd ../.. && npm run build               # frontend build (contract types must be current)
npm run contracts:gen && git diff --exit-code -- packages/shared/src/generated/schema.d.ts
```

Frontend changes additionally: `npm run test` (Vitest) and `npm run typecheck` (vue-tsc) once the TS migration lands — CI enforces both.

## Commits & pull requests

- One logical change per commit; contract-breaking changes (API shape, DB schema, generated types) are a single commit covering backend + frontend + docs.
- Commit message style: imperative subject line, body explains *why* when non-obvious (`git log --oneline -20` for the local convention).
- PRs: describe what + why, list validation actually run. Don't pad with screenshots of the OpenAPI docs.

## Branches & releases

- Branch pushes build CI + Docker `main-<sha>` / `<branch>-<sha>` images; **`latest` moves only on tag pushes**.
- Release = push a `vX.Y.Z` tag. CI builds the GHCR image, moves `latest`, and **creates the GitHub Release automatically** — never create releases manually (this caused the v1.0.0/v1.1.0 gap).
- Rollback: see `docs/maintenance.md`.

## Bug reports

Open an issue with: description, steps to reproduce, expected vs actual, environment (Docker image tag or bare metal + browser). For streaming problems include the log excerpt around the incident and `GET /api/system/version`.

## License note

Upstream has no license yet (see `docs/maintenance.md` — fork/license policy). Until that resolves, treat this fork's code as private-use.
