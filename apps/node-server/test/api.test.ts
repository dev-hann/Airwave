/** API integration tests — boot the real Express app with a stub track source. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { ResolvedTrackLike } from "@airwave/domain";

let dir: string;
let app: Awaited<ReturnType<typeof createApp>>;

const stubTrack = (url: string): ResolvedTrackLike => ({
  sourceUrl: url,
  normalizedUrl: url,
  title: "Resolved Song",
  channel: "chan",
  durationSeconds: 120,
  thumbnailUrl: null,
  streamUrl: "http://media.local/audio",
  isLive: false,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "airwave-api-"));
  app = createApp({
    dbPath: join(dir, "api.db"),
    ffmpegPath: process.env.AIRWAVE_FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.AIRWAVE_FFPROBE_PATH ?? "ffprobe",
    hlsDirectory: join(dir, "hls"),
    trackSource: {
      resolveVideo: async (url) => stubTrack(url),
      normalizeUrl: (url) => url,
    },
  });
  await app.start(0, "127.0.0.1");
  // Engine idle-silence spawns ffmpeg; if absent, those paths no-op via catch.
}, 20_000);

afterAll(async () => {
  await app.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

describe("API", () => {
  it("health returns ok", async () => {
    const res = await request(base()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("state shape matches the contract (relative stream_url)", async () => {
    const res = await request(base()).get("/api/state");
    expect(res.status).toBe(200);
    expect(res.body.stream_url).toBe("/stream/live.m3u8");
    expect(res.body.mode).toBeOneOf(["idle", "playing"]);
    expect(typeof res.body.now_playing_is_liked).toBe("boolean");
    expect(Object.keys(res.body).sort()).toEqual([
      "can_seek", "duration_seconds", "elapsed_seconds", "mode", "now_playing_channel",
      "now_playing_id", "now_playing_is_liked",
      "now_playing_is_live", "now_playing_thumbnail_url", "now_playing_title", "paused",
      "progress_percent", "repeat_mode", "shuffle_enabled", "started_at", "stream_url",
    ]);
  });

  it("queue add/list/remove roundtrip", async () => {
    const add = await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/abc" });
    expect(add.status).toBe(200);
    expect(add.body.queued).toBe(1);

    const list = await request(base()).get("/api/queue");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].source_url).toBe("https://youtu.be/abc");
    expect(list.body[0].queue_position).toBe(1);
    // Server-resolved thumbnail from parsed source URL:
    expect(list.body[0].thumbnail_url).toBe("https://i.ytimg.com/vi/abc/hqdefault.jpg");

    const remove = await request(base()).post(`/api/queue/remove/${list.body[0].id}`).send({});
    expect(remove.status).toBe(200);
    expect(remove.body.ok).toBe(true);
    expect((await request(base()).get("/api/queue")).body).toHaveLength(0);
  });

  it("queue add rejects missing url", async () => {
    const res = await request(base()).post("/api/queue/add").send({});
    expect(res.status).toBe(400);
  });

  it("playback repeat validates mode", async () => {
    const bad = await request(base()).post("/api/playback/repeat").send({ mode: "banana" });
    expect(bad.status).toBe(400);
    const good = await request(base()).post("/api/playback/repeat").send({ mode: "all" });
    expect(good.status).toBe(200);
    expect(good.body.repeat_mode).toBe("all");
    await request(base()).post("/api/playback/repeat").send({ mode: "off" });
  });

  it("playlists CRUD + entries with resolved thumbnails", async () => {
    const created = await request(base()).post("/api/playlists").send({ title: "Roadtrip" });
    expect(created.status).toBe(200);
    const playlistId = created.body.id;

    const entry = await request(base()).post(`/api/playlists/${playlistId}/entries`).send({
      url: "https://www.youtube.com/watch?v=xyz",
      title: "Song X",
    });
    expect(entry.status).toBe(200);
    expect(entry.body.thumbnail_url).toBe("https://i.ytimg.com/vi/xyz/hqdefault.jpg");

    const entries = await request(base()).get(`/api/playlists/${playlistId}/entries`);
    expect(entries.body).toHaveLength(1);
    expect(entries.body[0].position).toBe(1);

    const patch = await request(base()).patch(`/api/playlists/${playlistId}`).send({ pinned: true, title: "Roadtrip 2" });
    expect(patch.status).toBe(200);
    expect(patch.body.pinned).toBe(true);
    expect(patch.body.title).toBe("Roadtrip 2");

    const removed = await request(base()).delete(`/api/playlists/${playlistId}`);
    expect(removed.body.ok).toBe(true);
    expect((await request(base()).get("/api/playlists")).body.find((p: { id: string }) => p.id === playlistId)).toBeUndefined();
  });

  it("liked songs seeded; like/unlike roundtrip via queue item", async () => {
    const playlists = await request(base()).get("/api/playlists");
    const liked = playlists.body.find((p: { source_url: string }) => p.source_url === "custom://liked_songs");
    expect(liked).toBeDefined();
    expect(liked.can_edit).toBe(false);

    // Enqueue + mark playing directly through repo (engine control is P6).
    const repo = app.repository;
    const created = repo.enqueueItems([
      {
        sourceUrl: "https://u", normalizedUrl: "https://u", sourceType: "video",
        title: "Like me", provider: null, providerItemId: null,
        durationSeconds: null, thumbnailUrl: null, playlistId: null,
      },
    ]);
    app.engine.state.nowPlayingId = created[0]!.id;

    const like = await request(base()).post("/api/state/like").send({});
    expect(like.status).toBe(200);
    expect(like.body.liked).toBe(true);

    const unlike = await request(base()).post("/api/state/unlike").send({});
    expect(unlike.status).toBe(200);
    expect(unlike.body.removed).toBe(true);

    app.engine.state.nowPlayingId = null;
  });

  it("settings get/put/delete", async () => {
    await request(base()).put("/api/settings/test-key").send({ value: "v1" });
    const got = await request(base()).get("/api/settings/test-key");
    expect(got.body.value).toBe("v1");
    await request(base()).delete("/api/settings/test-key");
    expect((await request(base()).get("/api/settings/test-key")).body.value).toBeNull();
  });

  it("history clear works", async () => {
    const res = await request(base()).post("/api/history/clear").send({});
    expect(res.status).toBe(200);
  });

  it("WS snapshot on connect carries the full payload", async () => {
    const WebSocket = (await import("ws")).default;
    const port = (app.server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/events`);
      const timeout = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.on("message", (raw) => {
        const payload = JSON.parse(String(raw)) as { type: string; state: object; queue: unknown[]; history: unknown[]; playlists: unknown[] };
        expect(payload.type).toBe("snapshot");
        expect(payload.state).toHaveProperty("stream_url", "/stream/live.m3u8");
        expect(Array.isArray(payload.queue)).toBe(true);
        expect(Array.isArray(payload.playlists)).toBe(true);
        clearTimeout(timeout);
        ws.close();
        resolve();
      });
      ws.on("error", reject);
    });
  });

  it("playlist m3u8 endpoint serves the live header", async () => {
    const res = await request(base()).get("/stream/live.m3u8");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    expect(res.text.startsWith("#EXTM3U")).toBe(true);
  });

  it("unknown segment 404s", async () => {
    const res = await request(base()).get("/stream/seg0000000042.ts");
    expect(res.status).toBe(404);
  });
});
