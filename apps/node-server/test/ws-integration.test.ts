/**
 * API→WS integration tests: mutating a REST route must push the RIGHT
 * domains to connected WS clients — and only once (the double-fire the
 * playback routes used to have is a regression these tests pin).
 *
 * Real Express app + real ws clients. The engine's async notifies use a
 * generous settle window; assertions poll with deadlines (playnow-regression
 * pattern).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as tmp } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import WebSocket from "ws";

import { createApp } from "../src/app.ts";

const FFMPEG = process.env.AIRWAVE_FFMPEG_PATH ?? "ffmpeg";
const binariesAvailable = spawnSync(FFMPEG, ["-version"]).status === 0;

let dir: string;
let app: Awaited<ReturnType<typeof createApp>>;
let wsUrl: string;

interface Received {
  timestamp: number;
  type: string;
  data: Record<string, unknown>;
}

const stubTrack = (url: string) => ({
  sourceUrl: url,
  normalizedUrl: url,
  title: "WS Test Track",
  channel: "chan",
  durationSeconds: 120,
  thumbnailUrl: null,
  streamUrl: "anullsrc=channel_layout=stereo:sample_rate=44100",
  isLive: false,
});

/** Connect a recording WS client; returns messages + a close() helper. */
function connectClient(): { messages: Received[]; close: () => void; opened: Promise<void> } {
  const messages: Received[] = [];
  const ws = new WebSocket(wsUrl);
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    try {
      messages.push(JSON.parse(String(raw)) as Received);
    } catch {
      // ignore malformed
    }
  });
  return { messages, opened, close: () => ws.close() };
}

async function waitForMessages(client: { messages: Received[] }, count: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (client.messages.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Wait until a message matching the predicate arrives after fromIndex.
 * Engine notifies interleave async FULL pushes; assertions target domain
 * SHAPES, not strict message counts. */
async function waitForDomainMessage(
  client: { messages: Received[] },
  predicate: (m: Received) => boolean,
  timeoutMs = 15_000,
  fromIndex = 0,
): Promise<Received | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = client.messages.slice(fromIndex).find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function domainKeys(m: Received): string[] {
  return Object.keys(m.data).sort();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmp(), "airwave-ws-int-"));
  app = createApp({
    dbPath: join(dir, "ws-int.db"),
    staticDir: join(dir, "no-dist"),
    trackSource: {
      resolveVideo: async (url) => stubTrack(url),
      normalizeUrl: (url) => url,
    },
    search: async () => [],
    isPlaylistUrl: (url) => url.includes("list="),
  });
  await app.start(0, "127.0.0.1");
  const port = (app.server.address() as { port: number }).port;
  wsUrl = `ws://127.0.0.1:${port}/api/ws/events`;
}, 20_000);

afterAll(async () => {
  await app.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

describe("API mutations → WS domain pushes", () => {
  it("connect snapshot is a full state message with an integer monotonic timestamp", async () => {
    const client = connectClient();
    await client.opened;
    await waitForMessages(client, 1);
    client.close();

    const message = client.messages[0]!;
    expect(message.type).toBe("state");
    expect(Number.isInteger(message.timestamp)).toBe(true);
    expect(Object.keys(message.data).sort()).toEqual(["history", "playlists", "queue", "state"]);
  });

  it.skipIf(process.env.CI && !binariesAvailable)("like/unlike pushes ONLY the state domain (needs playback)", async () => {
    // Seed: a playing track so like has a target.
    await request(base()).post("/api/queue/play-now").send({ url: "https://youtu.be/like-ws" });
    await expect
      .poll(async () => (await request(base()).get("/api/state")).body.mode, { timeout: 15_000 })
      .toBe("playing");

    const client = connectClient();
    await client.opened;
    // Let the engine's async traffic from the play-now settle first.
    await new Promise((r) => setTimeout(r, 1_500));
    const startIndex = client.messages.length;

    const res = await request(base()).post("/api/state/like").send({});
    expect(res.status).toBe(200);

    // The like push carries exactly [state]; the engine's async FULL pushes
    // (if any race in) carry all four keys — match the domain shape.
    const pushed = await waitForDomainMessage(
      client,
      (m) =>
        domainKeys(m).join() === "state" &&
        (m.data.state as { now_playing_is_liked?: boolean }).now_playing_is_liked === true,
      15_000,
      startIndex,
    );
    client.close();
    expect(pushed).not.toBeNull();
  });

  it("queue add pushes queue+history (completed moves to history)", async () => {
    const client = connectClient();
    await client.opened;
    const startIndex = client.messages.length;

    const res = await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/queue-ws" });
    expect(res.status).toBe(200);

    const pushed = await waitForDomainMessage(client, (m) => domainKeys(m).join() === "history,queue", 15_000, startIndex);
    client.close();
    expect(pushed).not.toBeNull();
    expect(Array.isArray(pushed!.data.queue)).toBe(true);
  });

  it("playlist CRUD pushes ONLY the playlists domain", async () => {
    const client = connectClient();
    await client.opened;
    const startIndex = client.messages.length;

    const res = await request(base()).post("/api/playlists/custom").send({ title: "WS Push" });
    expect(res.status).toBe(200);

    const pushed = await waitForDomainMessage(client, (m) => domainKeys(m).join() === "playlists", 15_000, startIndex);
    client.close();
    expect(pushed).not.toBeNull();
  });

  it("history clear pushes ONLY the history domain", async () => {
    const client = connectClient();
    await client.opened;
    const startIndex = client.messages.length;

    const res = await request(base()).post("/api/history/clear").send({});
    expect(res.status).toBe(200);

    const pushed = await waitForDomainMessage(client, (m) => domainKeys(m).join() === "history", 15_000, startIndex);
    client.close();
    expect(pushed).not.toBeNull();
  });

  it.skipIf(process.env.CI && !binariesAvailable)("pause toggle pushes EXACTLY ONE full message (needs playback)", async () => {
    await expect
      .poll(async () => (await request(base()).get("/api/state")).body.mode, { timeout: 15_000 })
      .toBe("playing");

    const client = connectClient();
    await client.opened;
    // Drain any connect/late engine traffic: settle first.
    await new Promise((r) => setTimeout(r, 1_500));
    const startIndex = client.messages.length;

    const res = await request(base()).post("/api/playback/toggle-pause").send({});
    expect(res.status).toBe(200);

    // Engine notify is async: wait for the paused push, then a settle
    // window to prove no SECOND paused push (the old double-fire) arrives.
    const pushed = await waitForDomainMessage(
      client,
      (m) => (m.data.state as { paused?: boolean } | undefined)?.paused === true,
      15_000,
      startIndex,
    );
    expect(pushed).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1_500));
    client.close();

    const pausedPushes = client.messages
      .slice(startIndex)
      .filter((m) => (m.data.state as { paused?: boolean } | undefined)?.paused === true);
    expect(pausedPushes.length).toBe(1);
  }, 60_000);

  it("pushed timestamps are non-decreasing across a burst of mutations", async () => {
    const client = connectClient();
    await client.opened;
    const startIndex = client.messages.length;

    await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/burst-1" });
    await request(base()).post("/api/playlists/custom").send({ title: "Burst" });
    await request(base()).post("/api/history/clear").send({});

    const queuePush = await waitForDomainMessage(client, (m) => domainKeys(m).join() === "history,queue", 15_000, startIndex);
    const playlistPush = await waitForDomainMessage(client, (m) => domainKeys(m).join() === "playlists", 15_000, startIndex);
    const historyPush = await waitForDomainMessage(client, (m) => domainKeys(m).join() === "history", 15_000, startIndex);
    await new Promise((r) => setTimeout(r, 500));
    client.close();

    expect(queuePush && playlistPush && historyPush).toBeTruthy();
    const stamps = client.messages.slice(startIndex).map((m) => m.timestamp);
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]!);
    }
  }, 60_000);
});
