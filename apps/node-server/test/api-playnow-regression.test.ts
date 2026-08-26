/**
 * Regression: "play now" must start playback from ANY engine state.
 *
 * The v2.2.0 incident: E2E cleanup left userStopped=true in production;
 * search ▶ (queue/play-now) added the item but the engine stayed idle
 * forever — skip() alone never clears the user-stop flag. These tests pin
 * the full user journey: stop → queue → play-now → PLAYING.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.ts";

let dir: string;
let localMediaRoot: string;
let app: Awaited<ReturnType<typeof createApp>>;
let base: () => string;

const stubTrack = (url: string) => ({
  sourceUrl: url,
  normalizedUrl: url,
  title: "PlayNow Track",
  channel: "chan",
  durationSeconds: 120,
  thumbnailUrl: null,
  streamUrl: "anullsrc=channel_layout=stereo:sample_rate=44100",
  isLive: false,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "airwave-playnow-"));
  localMediaRoot = join(dir, "media");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(localMediaRoot, { recursive: true });
  writeFileSync(join(localMediaRoot, "song.mp3"), Buffer.from("x"));

  app = createApp({
    dbPath: join(dir, "playnow.db"),
    staticDir: join(dir, "no-dist"),
    localMediaRoots: [localMediaRoot],
    trackSource: {
      resolveVideo: async (url) => stubTrack(url),
      normalizeUrl: (url) => url,
    },
    search: async () => [],
    isPlaylistUrl: (url) => url.includes("list="),
  });
  await app.start(0, "127.0.0.1");
  const port = (app.server.address() as { port: number }).port;
  base = () => `http://127.0.0.1:${port}`;
}, 20_000);

afterAll(async () => {
  await app.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const stateMode = async (): Promise<string> =>
  (await (await request(base()).get("/api/state")).body).mode;

describe("play-now resumes from user-stopped state (v2.2.0 regression)", () => {
  it("stop → add → play-now → engine plays (the exact user journey)", async () => {
    // Seed: one track playing, then the user stops playback.
    await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/first" });
    await expect
      .poll(async () => (await (await request(base()).get("/api/state")).body).mode, { timeout: 15_000 })
      .toBe("playing");

    await request(base()).post("/api/playback/stop").send({});
    await expect
      .poll(async () => (await (await request(base()).get("/api/state")).body).mode, { timeout: 15_000 })
      .toBe("idle");

    // The incident state: userStopped=true, a queued item sits untouched.
    const res = await request(base()).post("/api/queue/play-now").send({ url: "https://youtu.be/wanted" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("video");

    // BEFORE the fix this stayed "idle" forever. Now it must play.
    await expect.poll(stateMode, { timeout: 20_000 }).toBe("playing");
    const state = (await request(base()).get("/api/state")).body;
    expect(state.now_playing_title).toBe("PlayNow Track");
  }, 60_000);

  it("play-now works from a fresh idle server too", async () => {
    await request(base()).delete("/api/queue");
    await request(base()).post("/api/playback/stop").send({});
    const res = await request(base()).post("/api/queue/play-now").send({ url: "https://youtu.be/fresh" });
    expect(res.status).toBe(200);
    await expect.poll(stateMode, { timeout: 20_000 }).toBe("playing");
  }, 60_000);

  it("queue add after stop stays idle (add ≠ play request) and play button starts it", async () => {
    await request(base()).delete("/api/queue");
    await request(base()).post("/api/playback/stop").send({});
    await expect.poll(stateMode, { timeout: 15_000 }).toBe("idle");

    // Plain add must NOT clear the user-stop (stop is an explicit user intent).
    await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/hold" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await stateMode()).toBe("idle");

    // The play button (resume) starts the queue.
    await request(base()).post("/api/playback/play").send({});
    await expect.poll(stateMode, { timeout: 20_000 }).toBe("playing");
  }, 60_000);

  it("play-now-local also resumes from user-stopped", async () => {
    await request(base()).delete("/api/queue");
    await request(base()).post("/api/playback/stop").send({});
    await expect.poll(stateMode, { timeout: 15_000 }).toBe("idle");

    const res = await request(base())
      .post("/api/queue/play-now-local")
      .send({ path: join(localMediaRoot, "song.mp3") });
    expect(res.status).toBe(200);
    await expect.poll(stateMode, { timeout: 20_000 }).toBe("playing");
  }, 60_000);
});
