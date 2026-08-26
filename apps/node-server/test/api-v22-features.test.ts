/** Functional integration tests for the v2.2.0 parity routes (search, dup-check, import, media, queue signatures). */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.ts";

const FFMPEG = process.env.AIRWAVE_FFMPEG_PATH ?? "ffmpeg";
const binariesAvailable = spawnSync(FFMPEG, ["-version"]).status === 0;

let dir: string;
let mediaDir: string;
let app: Awaited<ReturnType<typeof createApp>>;
let base: () => string;

const stubTrack = (url: string) => ({
  sourceUrl: url,
  normalizedUrl: url,
  title: "Stub Track",
  channel: "chan",
  durationSeconds: 120,
  thumbnailUrl: null,
  streamUrl: url,
  isLive: false,
});

const SEARCH_RESULTS = [
  {
    provider: "youtube",
    provider_item_id: "vid1",
    source_url: "https://www.youtube.com/watch?v=vid1",
    normalized_url: "https://www.youtube.com/watch?v=vid1",
    title: "Search Result One",
    channel: "Chan A",
    duration_seconds: 100,
    thumbnail_url: "https://i.ytimg.com/vi/vid1/hqdefault.jpg",
  },
];

const PLAYLIST_PREVIEW = (url: string) => ({
  provider: "youtube",
  sourceUrl: url,
  title: "Imported Mix",
  channel: "Mix Channel",
  thumbnailUrl: null,
  entries: [
    { provider: "youtube", provider_item_id: "p1", source_url: "https://www.youtube.com/watch?v=p1", normalized_url: "https://www.youtube.com/watch?v=p1", title: "Mix 1", channel: "c", duration_seconds: 10, thumbnail_url: null },
    { provider: "youtube", provider_item_id: "p2", source_url: "https://www.youtube.com/watch?v=p2", normalized_url: "https://www.youtube.com/watch?v=p2", title: "Mix 2", channel: "c", duration_seconds: 20, thumbnail_url: null },
  ],
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "airwave-routes-"));
  mediaDir = join(dir, "media");
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(mediaDir, "song-a.mp3"), Buffer.from("fake"));
  mkdirSync(join(mediaDir, "sub"), { recursive: true });
  writeFileSync(join(mediaDir, "sub", "song-b.flac"), Buffer.from("fake"));
  writeFileSync(join(mediaDir, "ignored.txt"), Buffer.from("nope"));

  app = createApp({
    dbPath: join(dir, "routes.db"),
    staticDir: join(dir, "no-dist"),
    localMediaRoots: [mediaDir],
    trackSource: {
      resolveVideo: async (url) => stubTrack(url),
      normalizeUrl: (url) => url,
    },
    search: async (query, limit) => SEARCH_RESULTS.slice(0, limit),
    previewPlaylist: async (url) => PLAYLIST_PREVIEW(url),
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

describe("search", () => {
  it("returns results in the Python wire shape", async () => {
    const res = await request(base()).get("/api/search").query({ q: "mix", limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.query).toBe("mix");
    expect(res.body.count).toBe(1);
    expect(res.body.results[0]).toMatchObject({
      provider: "youtube",
      provider_item_id: "vid1",
      title: "Search Result One",
      duration_seconds: 100,
    });
  });

  it("youtube alias returns the same shape", async () => {
    const res = await request(base()).get("/api/search/youtube").query({ q: "x" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it("rejects empty q", async () => {
    const res = await request(base()).get("/api/search");
    expect(res.status).toBe(400);
  });
});

describe("queue signature parity", () => {
  it("DELETE /api/queue/:id removes the item", async () => {
    const add = await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/sig-1" });
    expect(add.status).toBe(200);
    const id = add.body.item_ids[0];
    const res = await request(base()).delete(`/api/queue/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect((await request(base()).get("/api/queue")).body).toHaveLength(0);
  });

  it("DELETE /api/queue/:id on missing item is a JSON 404", async () => {
    const res = await request(base()).delete("/api/queue/999999");
    expect(res.status).toBe(404);
    expect(res.body.detail).toBeDefined();
  });

  it("POST /api/queue/:id/reorder moves items", async () => {
    const a = await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/r-a" });
    const b = await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/r-b" });
    const idB = b.body.item_ids[0];
    const res = await request(base()).post(`/api/queue/${idB}/reorder`).send({ new_position: 1 });
    expect(res.status).toBe(200);
    const queue = (await request(base()).get("/api/queue")).body;
    expect(queue[0].id).toBe(idB);
    void a;
  });

  it("DELETE /api/queue clears and reports ok", async () => {
    await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/c-1" });
    const res = await request(base()).delete("/api/queue");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("play-now puts the item at the front and skips", async () => {
    await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/first" });
    const res = await request(base()).post("/api/queue/play-now").send({ url: "https://youtu.be/second" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("video");
    const queue = (await request(base()).get("/api/queue")).body;
    expect(queue[0].source_url).toContain("second");
    await request(base()).delete("/api/queue");
  });
});

describe("playlist import + duplicates", () => {
  it("imports a YouTube playlist into the library", async () => {
    const res = await request(base()).post("/api/playlist/import").send({ url: "https://www.youtube.com/playlist?list=MIX1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, count: 2, title: "Imported Mix" });

    const playlists = (await request(base()).get("/api/playlists")).body;
    const imported = playlists.find((p: { title: string }) => p.title === "Imported Mix");
    expect(imported).toBeDefined();
    expect(imported.entry_count).toBe(2);

    const entries = (await request(base()).get(`/api/playlists/${imported.id}/entries`)).body;
    expect(entries.map((e: { title: string }) => e.title)).toEqual(["Mix 1", "Mix 2"]);
  });

  it("re-import updates the same playlist (idempotent by source_url)", async () => {
    const again = await request(base()).post("/api/playlist/import").send({ url: "https://www.youtube.com/playlist?list=MIX1" });
    expect(again.status).toBe(200);
    const playlists = (await request(base()).get("/api/playlists")).body;
    expect(playlists.filter((p: { title: string }) => p.title === "Imported Mix")).toHaveLength(1);
  });

  it("add-to-playlist duplicate flow: check → has_duplicates, skip_duplicates → skipped", async () => {
    const created = await request(base()).post("/api/playlists/custom").send({ title: "DupFlow" });
    const pid = created.body.id;
    const url = "https://www.youtube.com/watch?v=dup1";

    const first = await request(base()).post(`/api/playlists/${pid}/entries`).send({ url });
    expect(first.status).toBe(200);

    const check = await request(base()).post(`/api/playlists/${pid}/entries`).send({ url, import_mode: "check" });
    expect(check.body).toMatchObject({ has_duplicates: true, duplicate_count: 1, new_count: 0 });

    const skip = await request(base()).post(`/api/playlists/${pid}/entries`).send({ url, import_mode: "skip_duplicates" });
    expect(skip.body).toMatchObject({ ok: true, skipped_duplicates: true, count: 0 });

    const entries = (await request(base()).get(`/api/playlists/${pid}/entries`)).body;
    expect(entries).toHaveLength(1);
  });

  it("batch add with duplicates reports and skips", async () => {
    const created = await request(base()).post("/api/playlists/custom").send({ title: "Batch" });
    const pid = created.body.id;
    const entry = { source_url: "https://youtu.be/b1", normalized_url: "https://youtu.be/b1", provider: "youtube", provider_item_id: "b1", title: "B1", channel: null, duration_seconds: null, thumbnail_url: null };

    await request(base()).post(`/api/playlists/${pid}/entries/batch`).send({ entries: [entry] });
    const check = await request(base()).post(`/api/playlists/${pid}/entries/batch`).send({ entries: [entry, { ...entry, source_url: "https://youtu.be/b2", normalized_url: "https://youtu.be/b2", provider_item_id: "b2", title: "B2" }], import_mode: "check" });
    expect(check.body).toMatchObject({ has_duplicates: true, duplicate_count: 1, total: 2, new_count: 1 });

    const skip = await request(base()).post(`/api/playlists/${pid}/entries/batch`).send({ entries: [entry, { ...entry, source_url: "https://youtu.be/b2", normalized_url: "https://youtu.be/b2", provider_item_id: "b2", title: "B2" }], import_mode: "skip_duplicates" });
    expect(skip.body.count).toBe(1);
    expect((await request(base()).get(`/api/playlists/${pid}/entries`)).body).toHaveLength(2);
  });

  it("sidebar reorder persists and pin toggles", async () => {
    const a = await request(base()).post("/api/playlists/custom").send({ title: "SideA" });
    const b = await request(base()).post("/api/playlists/custom").send({ title: "SideB" });
    const res = await request(base()).post("/api/playlists/reorder").send({ playlist_id: b.body.id, new_position: 0, pinned: true });
    expect(res.status).toBe(200);
    const updated = (await request(base()).get("/api/playlists")).body.find((p: { id: string }) => p.id === b.body.id);
    expect(updated.pinned).toBe(true);
    void a;
  });

  it("entries CRUD: queue single entry, reorder, delete (204)", async () => {
    const created = await request(base()).post("/api/playlists/custom").send({ title: "CRUD" });
    const pid = created.body.id;
    const e1 = await request(base()).post(`/api/playlists/${pid}/entries`).send({ url: "https://youtu.be/c1" });
    const e2 = await request(base()).post(`/api/playlists/${pid}/entries`).send({ url: "https://youtu.be/c2" });

    const queueRes = await request(base()).post(`/api/playlists/entries/${e2.body.id}/queue`).send({});
    expect(queueRes.body).toMatchObject({ ok: true, count: 1 });
    await request(base()).delete("/api/queue");

    const reorder = await request(base()).post(`/api/playlists/entries/${e2.body.id}/reorder`).send({ new_position: 1 });
    expect(reorder.status).toBe(200);
    const entries = (await request(base()).get(`/api/playlists/${pid}/entries`)).body;
    expect(entries[0].id).toBe(e2.body.id);

    const del = await request(base()).delete(`/api/playlists/entries/${e1.body.id}`);
    expect(del.status).toBe(204);
  });

  it("playlist queue + play-now queue all entries", async () => {
    const created = await request(base()).post("/api/playlists/custom").send({ title: "QAll" });
    const pid = created.body.id;
    await request(base()).post(`/api/playlists/${pid}/entries`).send({ url: "https://youtu.be/q1" });
    await request(base()).post(`/api/playlists/${pid}/entries`).send({ url: "https://youtu.be/q2" });
    const res = await request(base()).post(`/api/playlists/${pid}/queue`).send({});
    expect(res.body).toMatchObject({ ok: true, count: 2 });
    await request(base()).delete("/api/queue");
  });

  it("liked songs cannot be renamed or deleted", async () => {
    const playlists = (await request(base()).get("/api/playlists")).body;
    const liked = playlists.find((p: { source_url: string }) => p.source_url === "custom://liked_songs");
    const rename = await request(base()).patch(`/api/playlists/${liked.id}`).send({ title: "Hacked" });
    expect(rename.status).toBe(403);
    const del = await request(base()).delete(`/api/playlists/${liked.id}`);
    expect(del.status).toBe(403);
  });
});

describe("local media", () => {
  it("lists configured roots", async () => {
    const res = await request(base()).get("/api/media/local/roots");
    expect(res.status).toBe(200);
    expect(res.body.roots).toHaveLength(1);
    expect(res.body.roots[0].path).toBe(mediaDir);
  });

  it("browses directories with audio filtering", async () => {
    const res = await request(base()).get("/api/media/local/browse").query({ path: mediaDir });
    expect(res.status).toBe(200);
    const kinds = res.body.entries.map((e: { name: string; kind: string }) => [e.name, e.kind]);
    expect(kinds).toContainEqual(["sub", "directory"]);
    expect(kinds).toContainEqual(["song-a.mp3", "file"]);
    expect(kinds.some(([name]: [string]) => name === "ignored.txt")).toBe(false);
  });

  it("rejects paths outside the allowlist", async () => {
    const res = await request(base()).get("/api/media/local/browse").query({ path: "/etc" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("outside allowed");
  });

  it("add-local-folder queues only audio files (recursive)", async () => {
    const res = await request(base()).post("/api/queue/add-local-folder").send({ path: mediaDir, recursive: true });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2); // song-a.mp3 + sub/song-b.flac
    expect(res.body.item_ids).toHaveLength(2);
    await request(base()).delete("/api/queue");
  });

  it("play-now-local brings the file to the front", async () => {
    await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/other" });
    const res = await request(base()).post("/api/queue/play-now-local").send({ path: join(mediaDir, "song-a.mp3") });
    expect(res.status).toBe(200);
    const queue = (await request(base()).get("/api/queue")).body;
    expect(queue[0].source_url).toContain("song-a.mp3");
    await request(base()).delete("/api/queue");
  });
});

describe("playback aliases", () => {
  it("POST /api/playback/play behaves like resume", async () => {
    const res = await request(base()).post("/api/playback/play").send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("outcome");
  });
});

describe("seek API", () => {
  it("rejects non-numeric percent with 400", async () => {
    const res = await request(base()).post("/api/playback/seek").send({ percent: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("Invalid percent");
  });

  it("returns ok:false (HTTP 200) when nothing seekable is playing", async () => {
    const res = await request(base()).post("/api/playback/seek").send({ percent: 50 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });

  it.skipIf(process.env.CI && !binariesAvailable)("accepts a seek while a track plays and reports elapsed moving", async () => {
    await request(base()).delete("/api/queue");
    await request(base()).post("/api/queue/add").send({ url: "https://youtu.be/seek-target" });
    await expect
      .poll(async () => (await request(base()).get("/api/state")).body.mode, { timeout: 20_000 })
      .toBe("playing");

    const res = await request(base()).post("/api/playback/seek").send({ percent: 50 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // After the restart the server position sits at/after 50% (duration 120 → ≥60).
    await expect
      .poll(
        async () => (await request(base()).get("/api/state")).body.elapsed_seconds ?? 0,
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(55);
  }, 60_000);
});
