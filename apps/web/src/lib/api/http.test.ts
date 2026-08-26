import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchJson, postJson, ApiError } from "./http";

function mockFetch(body: string, init: { status?: number; contentType?: string } = {}) {
  const { status = 200, contentType = "application/json" } = init;
  return vi.fn().mockResolvedValue(
    new Response(body, {
      status,
      headers: { "content-type": contentType },
    }),
  );
}

describe("fetchJson", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch('{"ok": true}'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses JSON content-type responses", async () => {
    const result = await fetchJson<{ ok: boolean }>("/api/x");
    expect(result).toEqual({ ok: true });
  });

  it("returns null for 204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await expect(fetchJson("/api/x")).resolves.toBeNull();
  });

  it("parses text bodies that contain JSON despite wrong content-type", async () => {
    vi.stubGlobal("fetch", mockFetch('{"count": 2}', { contentType: "text/plain" }));
    const result = await fetchJson<{ count: number }>("/api/x");
    expect(result).toEqual({ count: 2 });
  });

  it("returns raw string for non-JSON text bodies", async () => {
    vi.stubGlobal("fetch", mockFetch("pong", { contentType: "text/plain" }));
    await expect(fetchJson<string>("/api/x")).resolves.toBe("pong");
  });

  it("returns null for empty text bodies", async () => {
    vi.stubGlobal("fetch", mockFetch("", { contentType: "text/plain" }));
    await expect(fetchJson("/api/x")).resolves.toBeNull();
  });

  it("throws ApiError with parsed detail on error responses", async () => {
    vi.stubGlobal("fetch", mockFetch('{"detail": "Playlist not found"}', { status: 404 }));
    const error = await fetchJson("/api/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.detail).toBe("Playlist not found");
    expect(apiError.message).toBe('{"detail": "Playlist not found"}');
  });

  it("falls back to status message when error body is empty", async () => {
    vi.stubGlobal("fetch", mockFetch("", { status: 502 }));
    const error = await fetchJson("/api/x").catch((e: unknown) => e);
    expect((error as ApiError).message).toBe("Request failed: 502");
  });
});

describe("postJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends JSON body with content-type header", async () => {
    const fetchMock = mockFetch("null", { contentType: "application/json" });
    vi.stubGlobal("fetch", fetchMock);

    await postJson("/api/queue/add", { url: "https://example.com" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/queue/add");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com" });
  });

  it("sends empty object body when omitted", async () => {
    const fetchMock = mockFetch("null", { contentType: "application/json" });
    vi.stubGlobal("fetch", fetchMock);

    await postJson("/api/playback/play");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});
