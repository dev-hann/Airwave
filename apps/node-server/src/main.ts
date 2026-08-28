/**
 * Composition root — builds and starts the Node server.
 * Env contract mirrors the Python AIRWAVE_* settings.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.ts";
import { YtDlpService } from "./yt-dlp-service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const dbPath = (() => {
  const raw = env.AIRWAVE_DB_URL ?? "./data/airwave.db";
  // Accept python-style URLs (sqlite:///path) and plain paths; better-sqlite3
  // needs a filesystem path, never a scheme.
  const stripped = raw.replace(/^sqlite(\+pysqlite)?:\/\//, "").replace(/^sqlite:/, "");
  const normalized = stripped.replace(/\/(\.\/)+/g, "/").replace(/^\.\/+/, "");
  return normalized.startsWith("/") ? normalized : `./${normalized}`;
})();
mkdirSync(dirname(dbPath) || ".", { recursive: true });

const ytDlpSettingsBridge = { getSetting: (_key: string): string | null => null };
const ytDlp = new YtDlpService(env.AIRWAVE_YT_DLP_PATH ?? "yt-dlp", {
  cookieValueFor: (provider) => ytDlpSettingsBridge.getSetting(`cookies:${provider}`),
});
const localMediaRoots = (env.AIRWAVE_LOCAL_MEDIA_ROOTS ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter((part) => part.length > 0);

const app = createApp({
  dbPath,
  ffmpegPath: env.AIRWAVE_FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: env.AIRWAVE_FFPROBE_PATH ?? "ffprobe",
  ytDlpPath: env.AIRWAVE_YT_DLP_PATH ?? "yt-dlp",
  denoPath: env.AIRWAVE_DENO_PATH ?? "deno",
  hlsDirectory: env.AIRWAVE_HLS_DIR,
  staticDir: env.AIRWAVE_STATIC_DIR ?? resolvePath(here, "../static-dist"),
  localMediaRoots,
  trackSource: ytDlp,
  search: (query, limit) => ytDlp.search(query, limit),
  previewPlaylist: (url) => ytDlp.previewPlaylist(url),
  isPlaylistUrl: (url) => ytDlp.isPlaylistUrl(url),
  watchtowerUrl: env.AIRWAVE_WATCHTOWER_URL,
  watchtowerToken: env.AIRWAVE_WATCHTOWER_TOKEN,
  bindSettingsReader: (read) => {
    ytDlpSettingsBridge.getSetting = read;
  },
});

const port = Number(env.AIRWAVE_PORT ?? 8000);
const host = env.AIRWAVE_HOST ?? "0.0.0.0";

app.start(port, host).then(
  () => console.log(`Airwave Node server listening on http://${host}:${port}`),
  (error) => {
    console.error("Failed to start server", error);
    process.exit(1);
  },
);

const shutdown = async (signal: string) => {
  console.log(`${signal} received; shutting down`);
  await app.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
