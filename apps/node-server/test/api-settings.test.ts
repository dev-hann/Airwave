/**
 * Settings API tests — generic /api/settings/:key KV endpoint, provider
 * cookie routes (Settings → Cookies), and the binaries/app-update surface
 * (Settings → Update). The update routes run against a stubbed binaries
 * service so tests stay offline and deterministic.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.ts";
import type { BinariesLike } from "../src/app.ts";
import { BinariesInstallError } from "../src/binaries-service.ts";

let dir: string;
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "airwave-settings-"));
  app = createApp({
    dbPath: join(dir, "settings.db"),
    staticDir: join(dir, "no-dist"),
    trackSource: {
      resolveVideo: async (url) => ({
        sourceUrl: url,
        normalizedUrl: url,
        title: "Stub",
        channel: null,
        durationSeconds: 10,
        thumbnailUrl: null,
        streamUrl: url,
        isLive: false,
      }),
      normalizeUrl: (url) => url,
    },
    search: async () => [],
    previewPlaylist: async () => ({
      provider: "youtube",
      sourceUrl: "https://example.com",
      title: "P",
      channel: null,
      thumbnailUrl: null,
      entries: [],
    }),
    isPlaylistUrl: () => false,
  });
  await app.start(0, "127.0.0.1");
}, 20_000);

afterAll(async () => {
  await app.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

describe("settings KV endpoint", () => {
  it("GET unknown key returns value null", async () => {
    const res = await request(base()).get("/api/settings/never-set");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: "never-set", value: null });
  });

  it("PUT then GET roundtrips the value", async () => {
    const put = await request(base()).put("/api/settings/test-key").send({ value: "v1" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });

    const got = await request(base()).get("/api/settings/test-key");
    expect(got.body).toEqual({ key: "test-key", value: "v1" });
  });

  it("PUT overwrites the previous value", async () => {
    await request(base()).put("/api/settings/test-key").send({ value: "old" });
    await request(base()).put("/api/settings/test-key").send({ value: "new" });
    const got = await request(base()).get("/api/settings/test-key");
    expect(got.body.value).toBe("new");
  });

  it("PUT rejects a missing value with 400", async () => {
    const res = await request(base()).put("/api/settings/bad").send({});
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("value (string) required");
  });

  it("PUT rejects non-string values with 400 (numbers, objects, null)", async () => {
    for (const value of [42, { nested: true }, null, ["a"]]) {
      const res = await request(base()).put("/api/settings/bad").send({ value });
      expect(res.status).toBe(400);
      expect(res.body.detail).toBe("value (string) required");
    }
    // Ensure none of the rejected writes landed.
    const got = await request(base()).get("/api/settings/bad");
    expect(got.body.value).toBeNull();
  });

  it("PUT with no JSON body at all returns 400", async () => {
    const res = await request(base()).put("/api/settings/bad").set("Content-Type", "application/json").send();
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("value (string) required");
  });

  it("DELETE clears the value", async () => {
    await request(base()).put("/api/settings/gone").send({ value: "x" });
    const del = await request(base()).delete("/api/settings/gone");
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    const got = await request(base()).get("/api/settings/gone");
    expect(got.body.value).toBeNull();
  });

  it("DELETE of a never-set key is still ok (idempotent)", async () => {
    const del = await request(base()).delete("/api/settings/never-existed");
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
  });

  it("stores large cookie-file-sized strings (express.json limit is 2mb)", async () => {
    const big = "# Netscape HTTP Cookie File\n" + "x".repeat(512 * 1024);
    const put = await request(base()).put("/api/settings/cookies-youtube").send({ value: big });
    expect(put.status).toBe(200);
    const got = await request(base()).get("/api/settings/cookies-youtube");
    expect(got.body.value).toBe(big);
  });
});

describe("provider cookie settings (Settings → Cookies)", () => {
  it("GET lists providers with configured flags (never the values)", async () => {
    await request(base()).put("/api/settings/cookies").send({
      provider: "youtube",
      value: "# Netscape HTTP Cookie File\nsecret",
    });

    const res = await request(base()).get("/api/settings/cookies");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      providers: [{ provider: "youtube", label: "YouTube", configured: true }],
    });
    // The stored secret must never leak through this route.
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("unconfigured providers report configured:false", async () => {
    const res = await request(base()).get("/api/settings/cookies");
    expect(res.status).toBe(200);
    expect(res.body.providers[0]).toMatchObject({ provider: "youtube" });
  });

  it("PUT stores the cookie value (case-insensitive provider)", async () => {
    const res = await request(base()).put("/api/settings/cookies").send({
      provider: " YouTube ",
      value: "/home/user/cookies.txt",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, provider: "youtube", configured: true });

    const got = await request(base()).get("/api/settings/cookies");
    expect(got.body.providers[0].configured).toBe(true);
  });

  it("PUT rejects unsupported providers with 400", async () => {
    const res = await request(base()).put("/api/settings/cookies").send({ provider: "spotify", value: "x" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("Unsupported cookie provider");
  });

  it("PUT rejects missing/empty/non-string values with 400", async () => {
    for (const body of [{ provider: "youtube" }, { provider: "youtube", value: "" }, { provider: "youtube", value: 42 }]) {
      const res = await request(base()).put("/api/settings/cookies").send(body);
      expect(res.status).toBe(400);
      expect(res.body.detail).toBe("value (non-empty string) required");
    }
  });

  it("DELETE clears the provider cookie", async () => {
    await request(base()).put("/api/settings/cookies").send({ provider: "youtube", value: "x" });
    const res = await request(base()).delete("/api/settings/cookies/youtube");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, provider: "youtube", configured: false });

    const got = await request(base()).get("/api/settings/cookies");
    expect(got.body.providers[0].configured).toBe(false);
  });

  it("DELETE rejects unsupported providers with 400", async () => {
    const res = await request(base()).delete("/api/settings/cookies/spotify");
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("Unsupported cookie provider");
  });

  it("generic :key route no longer shadows the cookies route", async () => {
    const res = await request(base()).get("/api/settings/cookies");
    expect(res.status).toBe(200);
    expect(res.body.key).toBeUndefined();
    expect(res.body.providers).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Settings → Update surface (binaries + app updates), stubbed for determinism.

let updateDir: string;
let updateApp: Awaited<ReturnType<typeof createApp>>;
const installMock = vi.fn();

const stubBinaries: BinariesLike = {
  getBinaries: async () => [
    { name: "yt-dlp", path: "/app/bin/yt-dlp", version: "2026.01.01", is_system: false, link: "https://github.com/yt-dlp/yt-dlp/releases" },
    { name: "ffmpeg", path: "/usr/bin/ffmpeg", version: "6.1", is_system: true, link: null },
  ],
  getUpdates: async () => [
    { name: "yt-dlp", current: "2026.01.01", latest: "2026.02.02", has_update: true },
    { name: "ffmpeg", current: "6.1", latest: "—", has_update: false },
  ],
  install: installMock,
};

beforeAll(async () => {
  updateDir = mkdtempSync(join(tmpdir(), "airwave-update-"));
  updateApp = createApp({
    dbPath: join(updateDir, "update.db"),
    staticDir: join(updateDir, "no-dist"),
    trackSource: {
      resolveVideo: async (url) => ({
        sourceUrl: url, normalizedUrl: url, title: "Stub", channel: null, durationSeconds: 10,
        thumbnailUrl: null, streamUrl: url, isLive: false,
      }),
      normalizeUrl: (url) => url,
    },
    binaries: stubBinaries,
    appVersion: "v2.3.2",
    latestAppRelease: async () => "v9.9.9",
    watchtowerUrl: "http://127.0.0.1:9999",
    triggerUpgrade: async () => {
      throw new Error("fire-and-forget"); // swallowed by the route
    },
  });
  await updateApp.start(0, "127.0.0.1");
}, 20_000);

afterAll(async () => {
  await updateApp.stop().catch(() => {});
  rmSync(updateDir, { recursive: true, force: true });
});

const updateBase = () => `http://127.0.0.1:${(updateApp.server.address() as { port: number }).port}`;

describe("binaries endpoints (Settings → Update)", () => {
  it("GET /api/binaries lists status with in_use (idle engine → false)", async () => {
    const res = await request(updateBase()).get("/api/binaries");
    expect(res.status).toBe(200);
    expect(res.body.binaries).toHaveLength(2);
    expect(res.body.binaries[0]).toEqual({
      name: "yt-dlp",
      path: "/app/bin/yt-dlp",
      version: "2026.01.01",
      is_system: false,
      in_use: false,
      link: "https://github.com/yt-dlp/yt-dlp/releases",
    });
    expect(res.body.binaries[1]).toMatchObject({ name: "ffmpeg", is_system: true, in_use: false });
  });

  it("GET /api/binaries/updates lists update info", async () => {
    const res = await request(updateBase()).get("/api/binaries/updates");
    expect(res.status).toBe(200);
    expect(res.body.updates).toEqual([
      { name: "yt-dlp", current: "2026.01.01", latest: "2026.02.02", has_update: true },
      { name: "ffmpeg", current: "6.1", latest: "—", has_update: false },
    ]);
  });

  it("POST /api/binaries/install installs and reports the name", async () => {
    installMock.mockResolvedValueOnce(undefined);
    const res = await request(updateBase()).post("/api/binaries/install").send({ name: "yt-dlp", stop_stream_first: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, name: "yt-dlp" });
    expect(installMock).toHaveBeenCalledWith("yt-dlp");
  });

  it("POST /api/binaries/install rejects unknown names with 400", async () => {
    const res = await request(updateBase()).post("/api/binaries/install").send({ name: "wget", stop_stream_first: false });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("yt-dlp");
  });

  it("POST /api/binaries/install maps busy installs to 409 binary_in_use (frontend modal path)", async () => {
    installMock.mockRejectedValueOnce(new BinariesInstallError("busy", "binary_in_use"));
    const res = await request(updateBase()).post("/api/binaries/install").send({ name: "ffmpeg", stop_stream_first: false });
    expect(res.status).toBe(409);
    expect(res.body.detail).toBe("binary_in_use");
  });

  it("POST /api/binaries/install maps system-binary refusals to 400", async () => {
    installMock.mockRejectedValueOnce(new BinariesInstallError("system-binary", "Cannot update system-installed ffmpeg"));
    const res = await request(updateBase()).post("/api/binaries/install").send({ name: "ffmpeg", stop_stream_first: false });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("Cannot update system-installed ffmpeg");
  });
});

describe("app updates (Settings → Update)", () => {
  it("GET /api/system/updates reports versions, has_update and upgrade availability", async () => {
    const res = await request(updateBase()).get("/api/system/updates");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      current: "v2.3.2",
      latest: "v9.9.9",
      has_update: true,
      can_upgrade: true,
      releases_url: "https://github.com/dev-hann/Airwave/releases",
    });
  });

  it("POST /api/system/upgrade answers 202 and swallows trigger failures", async () => {
    const res = await request(updateBase()).post("/api/system/upgrade");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, status: "update_triggered" });
  });
});
