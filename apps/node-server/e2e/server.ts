/**
 * E2E server bootstrap: real app + real built bundle + stub track source.
 * Runs on a fixed port (8917) so Playwright's webServer health check finds it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { createApp } from "../src/app.ts";

const dir = mkdtempSync(join(tmpdir(), "airwave-e2e-ui-"));
const app = createApp({
  dbPath: join(dir, "e2e.db"),
  ffmpegPath: process.env.AIRWAVE_FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.AIRWAVE_FFPROBE_PATH ?? "ffprobe",
  hlsDirectory: join(dir, "hls"),
  staticDir: resolvePath("static-dist"),
  trackSource: {
    // Deterministic stub — no network, no yt-dlp. Resolves everything to a
    // locally-generated lavfi source so playback scenarios work offline.
    resolveVideo: async (url) => ({
      sourceUrl: url,
      normalizedUrl: url,
      title: "E2E Test Track",
      channel: "E2E Channel",
      durationSeconds: 120,
      thumbnailUrl: null,
      streamUrl: "anullsrc=channel_layout=stereo:sample_rate=44100",
      isLive: false,
    }),
  },
});

const port = Number(process.env.AIRWAVE_E2E_PORT ?? 8917);
app.start(port, "127.0.0.1").then(
  () => console.log(`[e2e] server on http://127.0.0.1:${port}`),
  (error) => {
    console.error("[e2e] failed to start", error);
    process.exit(1);
  },
);

const shutdown = async () => {
  await app.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
