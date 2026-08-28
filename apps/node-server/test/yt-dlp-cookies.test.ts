/**
 * yt-dlp cookie plumbing tests — provider detection, content/path
 * discrimination, temp-file caching, and --cookies argv wiring.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  YtDlpService,
  cookieProviderForUrl,
  cookieSettingKey,
  isSupportedCookieProvider,
  looksLikeCookieContent,
} from "../src/yt-dlp-service.ts";

const NETSCAPE = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tCONSENT\tYES";

function fakeProc(): NodeJS.Process {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    once: vi.fn((event: string, callback: (code: number) => void) => {
      if (event === "close") queueMicrotask(() => callback(0));
      return undefined as never;
    }),
    kill: vi.fn(),
  } as unknown as NodeJS.Process;
}

describe("cookie provider helpers", () => {
  it("recognizes YouTube hosts", () => {
    expect(cookieProviderForUrl("https://www.youtube.com/watch?v=x")).toBe("youtube");
    expect(cookieProviderForUrl("https://music.youtube.com/x")).toBe("youtube");
    expect(cookieProviderForUrl("https://youtu.be/x")).toBe("youtube");
  });

  it("rejects non-YouTube URLs and garbage", () => {
    expect(cookieProviderForUrl("https://example.com/watch?v=x")).toBeNull();
    expect(cookieProviderForUrl("not a url")).toBeNull();
  });

  it("only youtube is a supported provider (Spotify removed by decision)", () => {
    expect(isSupportedCookieProvider("youtube")).toBe(true);
    expect(isSupportedCookieProvider("spotify")).toBe(false);
    expect(isSupportedCookieProvider("")).toBe(false);
  });

  it("cookieSettingKey namespaces per provider", () => {
    expect(cookieSettingKey("youtube")).toBe("cookies:youtube");
  });

  it("looksLikeCookieContent: Netscape header, tabs or newlines mean content; bare word means path", () => {
    expect(looksLikeCookieContent(NETSCAPE)).toBe(true);
    expect(looksLikeCookieContent("a\tb")).toBe(true);
    expect(looksLikeCookieContent("line1\nline2")).toBe(true);
    expect(looksLikeCookieContent("/home/user/cookies.txt")).toBe(false);
  });
});

describe("YtDlpService.resolveCookieFile", () => {
  afterEach(() => {
    rmSync(join(tmpdir(), "airwave-cookies"), { recursive: true, force: true });
  });

  it("returns null when no value is stored", () => {
    const service = new YtDlpService("yt-dlp", { cookieValueFor: () => null });
    expect(service.resolveCookieFile("youtube")).toBeNull();
  });

  it("returns null for empty/whitespace values", () => {
    const service = new YtDlpService("yt-dlp", { cookieValueFor: () => "   " });
    expect(service.resolveCookieFile("youtube")).toBeNull();
  });

  it("treats a bare token as a cookie file path", () => {
    const service = new YtDlpService("yt-dlp", { cookieValueFor: () => "/opt/cookies.txt" });
    expect(service.resolveCookieFile("youtube")).toBe("/opt/cookies.txt");
  });

  it("writes Netscape content to a temp file and caches by content hash", () => {
    let stored = NETSCAPE;
    const service = new YtDlpService("yt-dlp", { cookieValueFor: () => stored });

    const first = service.resolveCookieFile("youtube");
    expect(first).toBeTruthy();
    expect(existsSync(first!)).toBe(true);
    expect(readFileSync(first!, "utf8")).toBe(NETSCAPE);

    // Same content → same cached file.
    expect(service.resolveCookieFile("youtube")).toBe(first);

    // New content → new file; the stale one is removed.
    stored = `${NETSCAPE}\n.youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR\t1`;
    const second = service.resolveCookieFile("youtube");
    expect(second).not.toBe(first);
    expect(existsSync(first!)).toBe(false);
    expect(readFileSync(second!, "utf8")).toBe(stored);
  });
});

describe("YtDlpService argv wiring", () => {
  it("resolveVideo passes --cookies with the resolved file", async () => {
    spawnMock.mockReset().mockImplementation(() => fakeProc());
    const service = new YtDlpService("yt-dlp", { cookieValueFor: () => NETSCAPE });

    // Empty stdout → JSON.parse fails → YtDlpError; the argv is what matters.
    const pending = service.resolveVideo("https://www.youtube.com/watch?v=x");
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    const argv = spawnMock.mock.calls[0]![1] as string[];
    expect(argv).toContain("--cookies");
    const index = argv.indexOf("--cookies");
    expect(argv[index + 1]).toMatch(/airwave-cookies-youtube-/);
  });

  it("resolveVideo omits --cookies when no cookie is stored", async () => {
    spawnMock.mockReset().mockImplementation(() => fakeProc());
    const service = new YtDlpService("yt-dlp", { cookieValueFor: () => null });

    const pending = service.resolveVideo("https://www.youtube.com/watch?v=x");
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    const argv = spawnMock.mock.calls[0]![1] as string[];
    expect(argv).not.toContain("--cookies");
  });

  it("previewPlaylist passes --cookies too", async () => {
    spawnMock.mockReset().mockImplementation(() => fakeProc());
    const service = new YtDlpService("yt-dlp", { cookieValueFor: () => NETSCAPE });

    const pending = service.previewPlaylist("https://www.youtube.com/playlist?list=x");
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    const argv = spawnMock.mock.calls[0]![1] as string[];
    expect(argv).toContain("--cookies");
  });
});
