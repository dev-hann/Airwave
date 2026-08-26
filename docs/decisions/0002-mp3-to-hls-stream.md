# 0002. Replace the raw-MP3 stream with HLS (v1.3.0)

- Status: Accepted (retroactive; recorded 2026-08-26)
- Date: 2026-08 (v1.3.0)

## Context

The engine originally pushed one continuous MP3 byte stream (`/stream/live.mp3`) to every listener through `SharedMp3Hub`, an in-process fan-out with a bounded queue per subscriber. Two problems:

1. **Slow clients backpressured the engine.** A stalled subscriber filled its queue, logged `MP3 hub client queue full` forever, and (before stall eviction) leaked a threadpool token — the zombie-subscriber bug.
2. **Mobile background playback broke.** Android battery optimization throttles background fetches; dropped bytes on a raw stream are unrecoverable, so audio died when the screen went off.

## Decision

Serve one live HLS stream (`/stream/live.m3u8`, segments over plain HTTP) via `HlsSegmenter`; delete `SharedMp3Hub` and the raw-MP3 machinery. Browsers play via hls.js or native HLS with a deep forward buffer (~30s) that absorbs background throttling.

## Consequences

- Slow clients can no longer backpressure the engine — HTTP serves segments at each client's pace.
- Hard rule 1 (`/stream/live.m3u8` stays ONE stream for all listeners) is the direct descendant of this decision.
- `AIRWAVE_STREAM_QUEUE_SIZE` / `AIRWAVE_HUB_STALL_EVICTION_SECONDS` no longer exist; do not reintroduce per-subscriber server queues.
- Segment latency (live edge) replaces byte latency; `hls_stream_listeners` (playlist polls in last 30s) is the listener metric.
