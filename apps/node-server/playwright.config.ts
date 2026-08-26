import { defineConfig } from "@playwright/test";

/**
 * Browser E2E for the UI shell. The server under test boots with the real
 * frontend bundle (built to static-dist) and a stub track source; scenarios
 * needing real audio (play/buffering) additionally require ffmpeg + yt-dlp
 * and are skipped without them.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.AIRWAVE_E2E_BASE_URL ?? "http://127.0.0.1:8917",
    // Desktop-class viewport so the queue sidebar (max-xl:hidden) is visible.
    viewport: { width: 1536, height: 960 },
  },
  webServer: process.env.AIRWAVE_E2E_BASE_URL
    ? undefined
    : {
        command: "node --experimental-strip-types e2e/server.ts",
        url: "http://127.0.0.1:8917/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
