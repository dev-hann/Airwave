/**
 * /api/system/version — build identity for deploy-drift detection.
 * Also pins resolveAppVersion: package.json is the single source of truth.
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "airwave-version-"));
  app = createApp({
    dbPath: join(dir, "version.db"),
    staticDir: join(dir, "no-dist"),
    appVersion: "9.9.9-test",
    trackSource: {
      resolveVideo: async (url) => ({
        sourceUrl: url,
        normalizedUrl: url,
        title: "Stub Track",
        channel: "chan",
        durationSeconds: 120,
        thumbnailUrl: null,
        streamUrl: url,
        isLive: false,
      }),
    },
  });
  await app.start(0, "127.0.0.1");
  const port = (app.server.address() as { port: number }).port;
  base = () => `http://127.0.0.1:${port}`;
}, 20_000);

afterAll(async () => {
  await app.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/system/version", () => {
  it("returns the injected app version", async () => {
    const res = await request(base()).get("/api/system/version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: "9.9.9-test" });
  });
});

describe("resolveAppVersion", () => {
  it("reads the root package.json (single source of truth)", () => {
    expect(resolveAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("package.json wins over env — branch builds must not fake a drift", () => {
    const v = resolveAppVersion({ AIRWAVE_APP_VERSION: "v0.0.0-env" });
    expect(v).not.toContain("env");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});
