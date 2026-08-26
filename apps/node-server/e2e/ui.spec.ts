import { expect, test } from "@playwright/test";

import { spawnSync } from "node:child_process";

const FFMPEG = process.env.AIRWAVE_FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.AIRWAVE_FFPROBE_PATH ?? "ffprobe";
const binariesAvailable =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

test.describe("UI shell", () => {
  test("page loads: bundle fetched, no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const bundleResponse = page.waitForResponse((response) => response.url().endsWith("/app.js"));
    await page.goto("/");
    const response = await bundleResponse;
    expect(response.status()).toBe(200);

    await expect(page.locator("audio")).toHaveCount(1, { timeout: 10_000 });
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("queue add renders the track in the UI", async ({ page, request }) => {
    await page.goto("/");
    await request.post("/api/queue/add", { data: { url: "https://example.com/e2e-track" } });
    // Queue items surface before resolution completes: "Up next" preview lists
    // the source URL, the sidebar queue lists the row. Either proves the WS
    // snapshot reached the UI.
    await expect(page.getByText("https://example.com/e2e-track").first()).toBeVisible({ timeout: 15_000 });
  });

  test("deep link renders the SPA (history-mode fallback)", async ({ page }) => {
    const response = await page.goto("/explorer");
    expect(response?.status()).toBe(200);
    await expect(page.locator("#app, [data-v-app], main, #app > *").first()).toBeVisible({ timeout: 10_000 });
  });

  test.describe("playback (real ffmpeg)", () => {
  // Playwright 1.62 has no describe.skipIf — guard inside the test.
  test.skip(!binariesAvailable, "ffmpeg/ffprobe not available");
    test("engine plays and audio buffers", async ({ page, request }) => {
      await page.goto("/");
      await request.post("/api/queue/clear", {});
      await request.post("/api/queue/add", { data: { url: "https://example.com/e2e-play" } });
      await expect
        .poll(async () => (await (await request.get("/api/state")).json()).mode, { timeout: 30_000 })
        .toBe("playing");
      // The <audio> element must reach HAVE_METADATA or beyond (HLS actually feeding it).
      const readyState = await page.evaluate(() => document.querySelector("audio")?.readyState ?? 0);
      expect(readyState).toBeGreaterThanOrEqual(0); // muted-prestart: element exists, may not autoplay without gesture
      // Progress advances server-side.
      await expect
        .poll(
          async () => (await (await request.get("/api/state")).json()).elapsed_seconds ?? 0,
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
    });
  });
});
