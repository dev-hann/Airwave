# 0003. Remove the SendSpin synchronized-playback subsystem

- Status: Accepted (retroactive; recorded 2026-08-26)
- Date: 2026-05/06 (fork divergence)

## Context

Upstream shipped SendSpin: a server + browser-client subsystem that synchronized *per-client* playback so separate browsers could stay in sync. In this fork's model — one shared HLS stream that everyone plays — that is redundant: synchronization comes from the single server-side stream, not from coordinating clients. Sonos speaker support and SoundCloud/Mixcloud ingestion were removed for the same reason (out of scope for a LAN shared radio).

## Decision

Delete SendSpin entirely (server and browser client). Browsers play the shared HLS stream directly through a single `<audio>` element. Do not reintroduce per-client audio paths, per-client transcoding, or client-side sync protocols.

## Consequences

- One audio path: `/stream/live.m3u8` → `<audio>` (hls.js or native). Any feature that needs "what is playing everywhere" reads playback state, never a per-client stream.
- Client-side mixing, per-user volume on the server, or multi-room sync would need a new ADR reversing this one.
- Smaller surface: no sync protocol, no per-client player state to keep consistent.
