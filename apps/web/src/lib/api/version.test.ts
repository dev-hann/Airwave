import { beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./http", () => ({ getJson: getJsonMock }));

import { bundleVersion, isVersionDrift, normalizeVersion, refreshServerVersion, serverVersion } from "./version";

describe("normalizeVersion", () => {
  it("strips a leading v", () => {
    expect(normalizeVersion("v2.3.2")).toBe("2.3.2");
  });

  it("keeps plain semver", () => {
    expect(normalizeVersion("2.3.2")).toBe("2.3.2");
  });

  it("null/undefined/empty → null", () => {
    expect(normalizeVersion(null)).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
    expect(normalizeVersion("")).toBeNull();
  });
});

describe("bundleVersion", () => {
  it("is a non-empty string (define is absent in tests → 'dev' fallback)", () => {
    expect(typeof bundleVersion).toBe("string");
    expect(bundleVersion.length).toBeGreaterThan(0);
  });
});

describe("serverVersion / deploy drift", () => {
  beforeEach(() => {
    serverVersion.value = null;
    getJsonMock.mockReset();
  });

  it("no drift before the server version is known", () => {
    expect(isVersionDrift()).toBe(false);
  });

  it("drift when the server runs a different version than this bundle", () => {
    serverVersion.value = "9.9.9";
    expect(isVersionDrift()).toBe(bundleVersion !== "9.9.9");
  });

  it("no drift when versions match", () => {
    serverVersion.value = bundleVersion;
    expect(isVersionDrift()).toBe(false);
  });

  it("refresh parses and normalizes the server payload", async () => {
    getJsonMock.mockResolvedValue({ version: "v2.3.2" });
    await refreshServerVersion();
    expect(serverVersion.value).toBe("2.3.2");
  });

  it("refresh failure clears the server version (no false drift)", async () => {
    serverVersion.value = "1.0.0";
    getJsonMock.mockRejectedValue(new Error("offline"));
    await refreshServerVersion();
    expect(serverVersion.value).toBeNull();
    expect(isVersionDrift()).toBe(false);
  });
});
