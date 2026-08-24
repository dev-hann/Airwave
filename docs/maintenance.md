# Maintenance & Fork Policy

Read this before yt-dlp/ffmpeg/deno updates, incident response, upstream merges, or releases.

## Fork context

- Upstream: `76696265636f646572/Airwave` — **inactive since 2026-05-13**. Remote `upstream` is configured locally.
- Baseline at fork time: tag `v0.1.0-baseline` (upstream `f63265b`, 238 tests passing).
- **License: upstream has none.** License request pending at upstream discussions #116. Until granted: private use is the safe mode. Public GHCR images (`ghcr.io/dev-hann/airwave`) are published at the owner's explicit choice — if policy changes, make the package private before further pushes.

## yt-dlp breakage playbook (scenario #1)

YouTube extractor changes are the most likely incident.

1. **Symptom**: queue items fail to resolve/start; yt-dlp extraction errors in logs (`AIRWAVE_LOG_LEVEL=debug` helps).
2. **Diagnose**: run the configured binary directly:
   ```bash
   $AIRWAVE_YT_DLP_PATH --version
   $AIRWAVE_YT_DLP_PATH -f bestaudio "https://youtube.com/watch?v=<id>"
   ```
   If the direct run fails with extractor errors → upstream yt-dlp fix needed, not an Airwave bug.
3. **Update binary** (pick one):
   - Runtime (non-Docker): settings UI update, or `POST /api/binaries/install` (`{"name":"yt-dlp"}`), or replace the binary at `AIRWAVE_YT_DLP_PATH` with a release from github.com/yt-dlp/yt-dlp.
   - Docker: rebuild the image (binaries are baked in at build time), then redeploy.
4. **Verify**: `.venv/bin/python -m pytest` still green; queue a known track end-to-end.
5. **Rollback**: keep the previous binary/image tag before updating (Docker: previous GHCR tag; bare metal: copy `bin/yt-dlp` aside first).

## Binary management

- BinariesService (`app/services/binaries_service.py`) downloads/updates yt-dlp, ffmpeg, ffprobe, deno into `bin/` (paths via `AIRWAVE_*_PATH`).
- Docker images bake binaries at build time from upstream release channels — runtime install endpoints are irrelevant inside the container.
- `POST /api/binaries/install` is unauthenticated (known gap; documented in `docs/backend/architecture.md`).

## Upstream tracking

- Occasionally: `git fetch upstream` and check `upstream/main`.
- If upstream revives: review new commits, cherry-pick or merge selectively. Upstream has no license — merging their new code keeps the same restrictions; nothing gets worse, but the license request should be re-evaluated then.

## Releases (this fork)

- Release = git tag (`v0.2.0` style) pushed to `origin`. CI builds and pushes `ghcr.io/dev-hann/airwave:<tag>` **and moves `:latest` only on tag pushes** (main pushes get `main-<sha>` tags only).
- App version is baked into the image (`AIRWAVE_APP_VERSION` env, from the CI build-arg); `GET /api/system/version` exposes it.

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

- `.github/workflows/ci.yml`: pytest (Python 3.12) → docker build & push to GHCR (on push to any branch/tag).
- No frontend build job (known gap). If frontend build breaks, CI stays green — run `npm run build` locally before pushing frontend changes.
