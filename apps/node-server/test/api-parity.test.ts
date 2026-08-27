/**
 * Web↔Server API parity contract.
 *
 * Every /api/* endpoint the web app calls (extracted from apps/web/src) must
 * exist as a route on the Node server. This is the regression net for the
 * v2.1.x incident class: "server green, UI dead because a route was missing".
 *
 * KEEP IN SYNC with apps/web/src — when the web gains a new endpoint, add it
 * here in the same commit (hard rule 4).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.ts";
import { resolveAppVersion } from "../src/version.ts";

let dir: string;
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "airwave-parity-"));
  app = createApp({
    dbPath: join(dir, "parity.db"),
    staticDir: join(dir, "no-dist"),
    localMediaRoots: [dir],
    appVersion: "9.9.9-test",
    trackSource: {
      resolveVideo: async (url) => stubTrack(url),
      normalizeUrl: (url) => url,
    },
    search: async () => [],
    previewPlaylist: async (url) => ({
      provider: "youtube",
      sourceUrl: url,
      title: "Stub Playlist",
      channel: null,
      thumbnailUrl: null,
      entries: [
        {
          provider: "youtube",
          provider_item_id: "v1",
          source_url: "https://www.youtube.com/watch?v=v1",
          normalized_url: "https://www.youtube.com/watch?v=v1",
          title: "Entry 1",
          channel: null,
          duration_seconds: 100,
          thumbnail_url: null,
        },
      ],
    }),
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

/**
 * The wire contract: method + path (with sample path params) the web uses.
 * A request that hits a MISSING route returns the SPA fallback or a 404 —
 * the assertion below fails on both.
 */
const WEB_API_CONTRACT: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [
  // state / playback
  { method: "GET", path: "/api/state" },
  { method: "GET", path: "/api/system/version" },
  { method: "POST", path: "/api/playback/play" },
  { method: "POST", path: "/api/playback/previous", body: {} },
  { method: "POST", path: "/api/playback/toggle-pause", body: {} },
  { method: "POST", path: "/api/playback/repeat", body: { mode: "off" } },
  { method: "POST", path: "/api/playback/shuffle", body: { enabled: false } },
  { method: "POST", path: "/api/playback/seek", body: { percent: 10 } },
  { method: "POST", path: "/api/state/like", body: {} },
  { method: "POST", path: "/api/state/unlike", body: {} },
  // queue
  { method: "GET", path: "/api/queue" },
  { method: "POST", path: "/api/queue/add", body: { url: "https://youtu.be/x" } },
  { method: "POST", path: "/api/queue/add-local", body: { path: "/x" } },
  { method: "POST", path: "/api/queue/add-local-folder", body: { path: "/x", recursive: true } },
  { method: "POST", path: "/api/queue/play-now", body: { url: "https://youtu.be/x" } },
  { method: "POST", path: "/api/queue/play-now-local", body: { path: "/x" } },
  { method: "POST", path: "/api/queue/play-now-local-folder", body: { path: "/x", recursive: true } },
  { method: "POST", path: "/api/queue/skip", body: {} },
  { method: "POST", path: "/api/queue/7/reorder", body: { new_position: 1 } },
  { method: "DELETE", path: "/api/queue/7" },
  { method: "DELETE", path: "/api/queue" },
  // history
  { method: "GET", path: "/api/history" },
  // search
  { method: "GET", path: "/api/search", query: { q: "test" } },
  // local media
  { method: "GET", path: "/api/media/local/roots" },
  { method: "GET", path: "/api/media/local/browse", query: { path: "/x" } },
  // playlists
  { method: "GET", path: "/api/playlists" },
  { method: "POST", path: "/api/playlists/custom", body: { title: "P" } },
  { method: "GET", path: "/api/playlists/00000000-0000-0000-0000-000000000000" },
  { method: "GET", path: "/api/playlists/00000000-0000-0000-0000-000000000000/entries" },
  { method: "POST", path: "/api/playlists/00000000-0000-0000-0000-000000000000/entries", body: { url: "https://youtu.be/x" } },
  { method: "POST", path: "/api/playlists/00000000-0000-0000-0000-000000000000/entries/local", body: { path: "/x" } },
  { method: "POST", path: "/api/playlists/00000000-0000-0000-0000-000000000000/entries/local-folder", body: { path: "/x" } },
  {
    method: "POST",
    path: "/api/playlists/00000000-0000-0000-0000-000000000000/entries/batch",
    body: { entries: [{ source_url: "https://youtu.be/x", normalized_url: "https://youtu.be/x" }] },
  },
  { method: "POST", path: "/api/playlists/00000000-0000-0000-0000-000000000000/queue", body: {} },
  { method: "POST", path: "/api/playlists/00000000-0000-0000-0000-000000000000/play-now", body: {} },
  { method: "PATCH", path: "/api/playlists/00000000-0000-0000-0000-000000000000", body: { pinned: true } },
  { method: "DELETE", path: "/api/playlists/00000000-0000-0000-0000-000000000000" },
  { method: "POST", path: "/api/playlists/reorder", body: { playlist_id: "x", new_position: 1, pinned: false } },
  { method: "POST", path: "/api/playlists/entries/1/queue", body: {} },
  { method: "DELETE", path: "/api/playlists/entries/1" },
  { method: "POST", path: "/api/playlists/entries/1/reorder", body: { new_position: 1 } },
  // import (YouTube only — Spotify removed by decision)
  { method: "POST", path: "/api/playlist/import", body: { url: "https://www.youtube.com/playlist?list=x" } },
];

describe("web↔server API parity", () => {
  it("every endpoint the web calls exists (no 404/HTML fallback)", async () => {
    const failures: string[] = [];
    for (const entry of WEB_API_CONTRACT) {
      const req = request(base())[entry.method.toLowerCase() as "get"](entry.path);
      if (entry.query) req.query(entry.query);
      if (entry.body !== undefined) req.send(entry.body as object);
      const res = await req;
      // Parity bug signatures:
      //  - HTML response: the SPA fallback swallowed an unknown route.
      //  - 404 WITHOUT a JSON {detail} body: Express's default "Cannot ..." —
      //    the route itself is missing. (A handler 404 — entity not found —
      //    carries {detail} and is a PASS: the route exists.)
      const contentType = String(res.headers["content-type"] ?? "");
      const swallowed = contentType.includes("text/html");
      const hasDetail = typeof res.body === "object" && res.body !== null && "detail" in res.body;
      if (swallowed || (res.status === 404 && !hasDetail)) {
        failures.push(`${entry.method} ${entry.path} -> ${res.status}${swallowed ? " (HTML fallback)" : " (no route)"}`);
      }
    }
    expect(failures, `Missing routes:\n${failures.join("\n")}`).toEqual([]);
  });

  it("contract table has no duplicates", () => {
    const keys = WEB_API_CONTRACT.map((entry) => `${entry.method} ${entry.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("GET /api/system/version returns the injected build identity", async () => {
    const res = await request(base()).get("/api/system/version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: "9.9.9-test" });
  });

  it("resolveAppVersion reads the root package.json (single source of truth)", () => {
    expect(resolveAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("resolveAppVersion: package.json wins over env — branch builds must not fake a drift", () => {
    expect(resolveAppVersion({ AIRWAVE_APP_VERSION: "v0.0.0-env" })).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
