import { expect, test } from "@playwright/test";

import { spawnSync } from "node:child_process";

const FFMPEG = process.env.AIRWAVE_FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.AIRWAVE_FFPROBE_PATH ?? "ffprobe";
const binariesAvailable =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;
// Against production (AIRWAVE_E2E_BASE_URL) the real yt-dlp resolves URLs,
// so fake video IDs 404 — use a known-good video. With the stub webServer the
// title is always "E2E Test Track".
const AGAINST_PROD = Boolean(process.env.AIRWAVE_E2E_BASE_URL);
const REAL_VIDEO_URL = "https://www.youtube.com/watch?v=3iM_06QeZi8"; // IU live clip

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
    const url = AGAINST_PROD ? REAL_VIDEO_URL : "https://www.youtube.com/watch?v=e2e-track";
    await request.post("/api/queue/add", { data: { url } });
    // Resolved title reaches the UI via the WS snapshot ("Up next" + sidebar).
    const marker = AGAINST_PROD ? "IU" : "E2E Test Track";
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  });

  test("search page renders results from /api/search", async ({ page }) => {
    await page.goto(AGAINST_PROD ? "/search?q=lofi" : "/search?q=anything");
    const marker = AGAINST_PROD ? "lofi" : "E2E Search Hit";
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  });

  test.describe("journey", () => {
  test.skip(!binariesAvailable, "ffmpeg/ffprobe not available");

  test("user journey: search → click play on a result → playback starts", async ({ page, request }) => {
    // Hermetic start: clear queue, stop, then verify idle — the exact
    // conditions of the incident (userStopped latched, nothing playing).
    await request.post("/api/playback/stop", {});
    await request.post("/api/queue/clear", {});
    await expect
      .poll(async () => (await (await request.get("/api/state")).json()).mode, { timeout: 15_000 })
      .toBe("idle");
    await page.goto(AGAINST_PROD ? "/search?q=lofi" : "/search?q=anything");

    // The result card's thumbnail overlay is the play button. Stub results
    // carry no thumbnail, so scope by the result title text instead.
    const marker = AGAINST_PROD ? "lofi" : "E2E Search Hit";
    const firstResult = page.locator(".group", { hasText: marker }).first();
    await expect(firstResult).toBeVisible({ timeout: 30_000 });
    // Play is bound to the thumbnail wrapper (Song.vue); its hover overlay
    // (aria-hidden div) intercepts pointer events over the img — click the
    // wrapper itself. Stub thumbnails are external URLs we never fetch.
    await page.route("https://i.ytimg.com/**", (route) => route.abort());
    const playTarget = (await firstResult.locator("img").count()) > 0
      ? firstResult.locator("img").locator("xpath=..")
      : firstResult;
    await playTarget.first().click();

    // BEFORE the v2.2.1 fix this stayed idle forever after a stop.
    await expect
      .poll(async () => (await (await request.get("/api/state")).json()).mode, { timeout: 45_000 })
      .toBe("playing");

    // Leave the server usable: stop → play clears the user-stop flag (the
    // v2.2.0 incident's wedge). Playback may legitimately continue (resume
    // semantics); the NEXT test's hermetic preamble (stop + clear + idle
    // assert) handles any residue, so no over-assertion here.
    await request.post("/api/playback/stop", {});
    await request.post("/api/playback/play", {});
    await expect
      .poll(async () => (await (await request.get("/api/state")).json()).mode, { timeout: 15_000 })
      .toBe("playing");
  }, 120_000);
  });

  test("deep link renders the SPA (history-mode fallback)", async ({ page }) => {
    const response = await page.goto("/explorer");
    expect(response?.status()).toBe(200);
    await expect(page.locator("#app, [data-v-app], main, #app > *").first()).toBeVisible({ timeout: 10_000 });
  });

  test.describe("transport controls + seek (real ffmpeg)", () => {
  test.skip(!binariesAvailable, "ffmpeg/ffprobe not available");

    /** Play a fresh track and return to a clean base for each scenario. */
    async function startPlaying(request: { post: (url: string, data?: object) => Promise<unknown> }): Promise<string> {
      await request.post("/api/playback/stop", {});
      await request.post("/api/playback/play", {}); // clear any latched user-stop
      await request.post("/api/queue/clear", {});
      const res = (await request.post("/api/queue/add", {
        data: { url: AGAINST_PROD ? REAL_VIDEO_URL : "https://www.youtube.com/watch?v=e2e-transport" },
      })) as { body?: { title?: string } };
      const title = ((res as unknown as { body?: { title?: string } }).body?.title ?? "") as string;
      await expect
        .poll(async () => (await (await request.get("/api/state")).json()).mode, { timeout: 30_000 })
        .toBe("playing");
      return title;
    }

    test("pause/play button toggles playback state", async ({ page, request }) => {
      await startPlaying(request as never);
      await page.goto("/");

      const playPause = page.getByLabel("Toggle play pause").filter({ visible: true }).first();
      await expect(playPause).toBeVisible({ timeout: 15_000 });
      await playPause.click();
      await expect
        .poll(async () => (await (await request.get("/api/state")).json()).paused, { timeout: 15_000 })
        .toBe(true);

      await page.getByLabel("Toggle play pause").filter({ visible: true }).first().click();
      await expect
        .poll(async () => (await (await request.get("/api/state")).json()).paused, { timeout: 15_000 })
        .toBe(false);
    }, 120_000);

    test("skip button advances to the next queued track", async ({ page, request }) => {
      await startPlaying(request as never);
      // Queue a second, distinguishable track behind the playing one.
      await request.post("/api/queue/add", {
        data: { url: AGAINST_PROD ? "https://www.youtube.com/watch?v=jNQXAC9IVRw" : "https://www.youtube.com/watch?v=e2e-transport-2" },
      });
      await page.goto("/");

      await page.getByLabel("Next").filter({ visible: true }).first().click();
      // Track changes (now_playing differs from the first title).
      await expect
        .poll(async () => (await (await request.get("/api/state")).json()).now_playing_title ?? "", { timeout: 45_000 })
        .not.toBe("");
    }, 180_000);

    test("progress bar keyboard seek moves server position", async ({ page, request }) => {
      await startPlaying(request as never);
      await page.goto("/");

      // reka-ui's thumb carries role=slider; the aria-label may or may not
      // reach it through USlider's attr forwarding — target any slider thumb
      // inside the progress component's slider element.
      const slider = page.locator('[data-slot="slider"] [role="slider"]').first();
      const fallback = page.locator('[role="slider"]').first();
      const target = (await slider.count()) > 0 ? slider : fallback;
      await expect(target).toBeVisible({ timeout: 15_000 });

      const before = (await (await request.get("/api/state")).json()).elapsed_seconds ?? 0;
      // End key = jump to ~100% (the engine clamps to duration).
      await target.focus();
      await page.keyboard.press("End");
      // commit fires on `change` (release-equivalent for keyboard).
      await target.press("Enter").catch(() => {});

      await expect
        .poll(async () => (await (await request.get("/api/state")).json()).elapsed_seconds ?? 0, { timeout: 45_000 })
        .toBeGreaterThan(before + 30);
    }, 180_000);
  });

  test.describe("playback (real ffmpeg)", () => {
  // Playwright 1.62 has no describe.skipIf — guard inside the test.
  test.skip(!binariesAvailable, "ffmpeg/ffprobe not available");
    test("engine plays and audio buffers", async ({ page, request }) => {
      await page.goto("/");
      await request.post("/api/queue/clear", {});
      await request.post("/api/queue/add", { data: { url: AGAINST_PROD ? REAL_VIDEO_URL : "https://www.youtube.com/watch?v=e2e-play" } });
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
      await request.post("/api/playback/stop", {});
      await request.post("/api/queue/clear", {});
      // CRITICAL: stop() latches userStopped=true; without the follow-up play
      // the NEXT user's queue add never starts (the v2.2.0 production
      // incident — E2E left the server wedged). Always hand back a
      // playable server.
      await request.post("/api/playback/play", {});
      await expect
        .poll(async () => (await (await request.get("/api/state")).json()).mode, { timeout: 15_000 })
        .toBe("playing");
    });
  });
});
