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

## Mobile background playback (scenario #2, verified 2026-08)

Symptom: audio stops after a while when the browser goes to background / screen off.

Diagnosed root cause on Android: **OS battery optimization kills the browser's
background audio fetch** — the stream connection stays open but the phone stops
reading data (server logs fill with `MP3 hub client queue full`). The web app's
recovery logic (v0.2.2+) cannot help when the OS blocks the data itself.

Fix (per phone): disable battery optimization for the browser
(e.g. Settings → Apps → Firefox → Battery → Unrestricted). Verified working on
Firefox Android after this change — background playback survives.

Related notes:
- Chrome Android shows the media notification; Firefox Android may not show a
  media-session notification at all — an acknowledged Firefox limitation:
  Firefox Android uses its own media-control component, unrelated to the
  desktop MediaControl implementation (see bugzil.la/1648100 comment 9;
  caniuse lists Firefox for Android as "partial" MediaSession support).
  Playback itself is unaffected; nothing to fix in the web app.
- Accessing the server through a VPN tunnel (e.g. Tailscale 100.x addresses)
  adds another throttling layer in the background — prefer direct LAN URLs at
  home.
- Server-side stall evidence: `docker logs airwave | grep "queue full"`.


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

- `.github/workflows/ci.yml`: pytest (Python 3.12) → docker build & push to GHCR (on push to any branch/tag).
- No frontend build job (known gap). If frontend build breaks, CI stays green — run `npm run build` locally before pushing frontend changes.
