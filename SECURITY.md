# Security Policy

## Trust model

Airwave is designed for **private LAN deployment**. There is no authentication: anyone who can reach the server can control playback, queue content, read all API state, and (on bare metal) trigger binary updates. Auth middleware is planned (tracked in `AGENTS.md` known constraints) — until it ships, do not expose an instance to the internet.

## Known gaps (accepted risks under the LAN trust model)

- **No authentication** on any endpoint.
- `POST /api/binaries/install` is unauthenticated and replaces the executables the server runs (`yt-dlp`, `ffmpeg`, `ffprobe`, `deno`). On Docker deployments binaries are baked at build time, which limits the impact.
- Direct-URL ingestion has an SSRF surface (no internal-IP blocklist yet) — the server will fetch URLs handed to it by any client.

Details in `docs/backend/architecture.md` and `AGENTS.md` (Known constraints).

## Reporting

Open a private security advisory on GitHub (Security → Report a vulnerability) or an issue marked `[security]`. Include the Docker image tag / commit and a reproduction. Do not open PRs that add auth middleware ad hoc — the auth design gets an ADR first.
