# Maintenance & Fork Policy

Read this before yt-dlp/ffmpeg/deno updates, upstream merges, or releases. Incident playbooks live in `docs/runbook.md`.

## Fork context

- Upstream: `76696265636f646572/Airwave` — **inactive since 2026-05-13**. Remote `upstream` is configured locally.
- Baseline at fork time: tag `v0.1.0-baseline` (upstream `f63265b`, 238 tests passing).
- **License: upstream has none.** License request pending at upstream discussions #116. Until granted: private use is the safe mode. Public GHCR images (`ghcr.io/dev-hann/airwave`) are published at the owner's explicit choice — if policy changes, make the package private before further pushes.

## Incident playbooks

Moved to `docs/runbook.md`:

- yt-dlp breakage playbook (diagnose via direct binary run, update paths, rollback)
- Mobile background playback (battery optimization, VPN throttling notes, `hls_stream_listeners`)

## Binary management

- BinariesService (`app/services/binaries_service.py`) downloads/updates yt-dlp, ffmpeg, ffprobe, deno into `bin/` (paths via `AIRWAVE_*_PATH`).
- Docker images bake binaries at build time from upstream release channels — runtime install endpoints are irrelevant inside the container.
- `POST /api/binaries/install` is unauthenticated (known gap; documented in `docs/backend/architecture.md`).

## Upstream tracking

- Occasionally: `git fetch upstream` and check `upstream/main`.
- If upstream revives: review new commits, cherry-pick or merge selectively. Upstream has no license — merging their new code keeps the same restrictions; nothing gets worse, but the license request should be re-evaluated then.

## Releases (this fork)

- Release = git tag (`v0.2.0` style) pushed to `origin`. CI builds and pushes `ghcr.io/dev-hann/airwave:<tag>` **and moves `:latest` only on tag pushes** (main pushes get `main-<sha>` tags only).
- CI also **creates the GitHub Release automatically** on tag pushes (`release` job: `gh release create --generate-notes --latest`). Do not create releases manually — that caused the v1.0.0/v1.1.0 gap where `releases/latest` pointed at v0.2.5 while `:latest` had moved.
- App version is baked into the image (`AIRWAVE_APP_VERSION` env, from the CI build-arg); `GET /api/system/version` exposes it.
- The update badge (`GET /api/system/updates`) compares versions **semver-style** (`_has_newer_version` in `app/api/system/routes.py`): a local build newer than `releases/latest`, or an unparsable version (`dev`, `dev-<sha>`), never flags an update.

### Deploying updates (Docker + Watchtower, manual trigger)

`docker-compose.yml` ships a Watchtower service in **manual-trigger mode** (no polling): the in-app
"Settings → Update → Update now" button calls `POST /api/system/upgrade`, which proxies to
Watchtower's HTTP API; Watchtower pulls `:latest` and recreates the `airwave` container.

Setup (once, on the Docker host):

```bash
echo "WATCHTOWER_TOKEN=$(openssl rand -hex 16)" >> .env
docker compose up -d
```

- The button is hidden when `AIRWAVE_WATCHTOWER_URL` is unset (bare-metal deployments).
- Restart breaks the live stream for a few seconds (in-process engine — unavoidable).

### Rollback

```bash
docker tag ghcr.io/dev-hann/airwave:v0.2.0 ghcr.io/dev-hann/airwave:latest
docker compose up -d   # recreates airwave on the rolled-back image
```

GHCR keeps every release tag; `WATCHTOWER_CLEANUP` only prunes old images on the host.

## CI

- `.github/workflows/ci.yml` (single `python-tests` job, then `docker`/`release`):
  1. pytest (Python 3.12, JUnit report published to the PR)
  2. Frontend build check (`npm ci` + `npm run build`)
  3. Frontend typecheck (`vue-tsc --noEmit`) + unit tests (`vitest run`)
  4. Contracts drift check — regenerates `packages/shared/src/generated/schema.d.ts` from the OpenAPI dump and fails on diff (run `npm run contracts:gen` locally after response-model changes)
  5. Docker build & push to GHCR (pushes only), 6. GitHub Release (tag pushes only)
