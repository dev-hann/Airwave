# Runbook

Operational incident playbooks. For fork policy, releases, and CI, see `docs/maintenance.md`. When you diagnose a new failure mode, record it here in the same session.

## Scenario #1 — yt-dlp breakage (most likely incident)

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
4. **Verify**: `npm test --workspaces --if-present` still green; queue a known track end-to-end.
5. **Rollback**: keep the previous binary/image tag before updating (Docker: previous GHCR tag; bare metal: copy `bin/yt-dlp` aside first).

## Scenario #2 — Mobile background playback stops (verified 2026-08)

Symptom: audio stops after a while when the browser goes to background / screen off.

Root cause (Android): **OS battery optimization throttles the browser's background network fetch**, so the phone falls behind the live edge. The HLS deep client-side buffer rides most of this out (since v1.3.0); raw-MP3 drops were unrecoverable (ADR-0002).

Fix (per phone): disable battery optimization for the browser (e.g. Settings → Apps → Firefox → Battery → Unrestricted).

Related notes:

- Chrome Android shows the media notification; Firefox Android may not (acknowledged Firefox limitation, bugzil.la/1648100 comment 9) — playback is unaffected, nothing to fix in the web app.
- VPN tunnels (e.g. Tailscale 100.x addresses) add another background throttling layer — prefer direct LAN URLs at home.
- Server-side evidence of listeners: `Engine stats ... hls_stream_listeners=N` counts clients that polled the playlist in the last 30s.

## Scenario #3 — Live stream stalls for everyone (template, unverified)

1. Symptom: all listeners buffered/stalled; one listener fine = client-side (see #2).
2. Check engine logs for pipeline exit / segmenter stalls; `ffprobe` the current media URL manually.
3. Restart = stream break for a few seconds (in-process engine, unavoidable). `POST /api/playback/skip` first — cheaper than restart.
4. If ffmpeg died on a malformed source: remove the queue item, skip, verify next track segments.
5. Record what happened below (replace this template).

## Scenario #4 — WebSocket not connecting (template, unverified)

1. Symptom: UI state frozen but audio keeps playing (stream is independent of WS).
2. Client reconnects automatically (1s doubling → 10s cap). Check browser console for ws errors; check reverse proxy timeouts for `/api/ws/events` if fronted by one.
3. State self-heals on next snapshot; hard reload forces a REST refresh.

## Scenario #5 — SQLite corruption / DB errors (template, unverified)

1. Symptom: repository errors in logs, API 500s on state reads.
2. Stop server, `sqlite3 $AIRWAVE_DB_URL "PRAGMA integrity_check;"`.
3. Restore the file from backup if corrupt (DB files are disposable — queue/history/playlists are the only loss).
4. If migrations failed mid-write (`_ensure_*_column`), inspect schema before restarting.
