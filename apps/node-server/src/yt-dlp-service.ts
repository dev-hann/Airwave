/**
 * yt-dlp adapter — metadata resolution via JSON dump. Port of the resolve
 * surface the engine needs (app/services/yt_dlp_service.py subset).
 *
 * List-argv only. Network timeouts bounded.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedTrackLike } from "@airwave/domain";

export class YtDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YtDlpError";
  }
}

// ------------------------------------------------------------ cookies

export const COOKIE_PROVIDERS: ReadonlyArray<{ provider: string; label: string }> = [
  { provider: "youtube", label: "YouTube" },
];

export function isSupportedCookieProvider(provider: string): boolean {
  return COOKIE_PROVIDERS.some((entry) => entry.provider === provider);
}

export function cookieSettingKey(provider: string): string {
  return `cookies:${provider}`;
}

/** True for hosts yt-dlp hits for playback sources (Airwave is YouTube-only). */
export function cookieProviderForUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtu.be") return "youtube";
  } catch {
    return null;
  }
  return null;
}

/** True when the stored value is Netscape cookie content rather than a path. */
export function looksLikeCookieContent(value: string): boolean {
  const stripped = value.trim();
  return stripped.startsWith("# Netscape HTTP Cookie File") || stripped.includes("\n") || stripped.includes("\t");
}

function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home ? join(home, path.slice(1)) : path;
}

interface CookieFileCacheEntry {
  valueHash: string;
  path: string;
}

export interface SearchResultItem {
  provider: string;
  provider_item_id: string | null;
  source_url: string;
  normalized_url: string;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
}

export interface PlaylistPreviewEntry {
  provider: string;
  provider_item_id: string | null;
  source_url: string;
  normalized_url: string;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
}

export interface PlaylistPreview {
  provider: string;
  sourceUrl: string;
  title: string | null;
  channel: string | null;
  thumbnailUrl: string | null;
  entries: PlaylistPreviewEntry[];
}

interface RawEntry {
  id?: string;
  original_url?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  is_live?: boolean;
  url?: string;
  webpage_url?: string;
  formats?: Array<{ url?: string; protocol?: string; acodec?: string; format_id?: string }>;
}

export interface YtDlpServiceOptions {
  timeoutMs?: number;
  /** Stored cookie value per provider (Netscape content or a file path). */
  cookieValueFor?: (provider: string) => string | null;
}

export class YtDlpService {
  private readonly ytDlpPath: string;
  private readonly timeoutMs: number;
  private readonly cookieValueFor: (provider: string) => string | null;
  private readonly cookieCache = new Map<string, CookieFileCacheEntry>();

  constructor(ytDlpPath: string, options: YtDlpServiceOptions = {}) {
    this.ytDlpPath = ytDlpPath;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.cookieValueFor = options.cookieValueFor ?? (() => null);
  }

  /**
   * Materialize a cookie file path for the provider: stored value is either
   * a filesystem path (returned as-is after ~ expansion) or Netscape content
   * (written to a temp file, cached by content hash to avoid rewrite churn).
   */
  resolveCookieFile(provider: string): string | null {
    const raw = this.cookieValueFor(provider);
    if (raw === null) return null;
    const normalized = raw.trim();
    if (!normalized) return null;
    if (!looksLikeCookieContent(normalized)) return expandHome(normalized);

    const valueHash = createHash("sha256").update(normalized, "utf8").digest("hex");
    const cached = this.cookieCache.get(provider);
    if (cached && cached.valueHash === valueHash) return cached.path;

    if (cached) rmSync(cached.path, { force: true });
    const directory = join(tmpdir(), "airwave-cookies");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `airwave-cookies-${provider}-${valueHash.slice(0, 12)}.txt`);
    writeFileSync(path, normalized, "utf8");
    this.cookieCache.set(provider, { valueHash, path });
    return path;
  }

  private cookieFileForUrl(url: string): string | null {
    const provider = cookieProviderForUrl(url);
    if (provider === null || !isSupportedCookieProvider(provider)) return null;
    return this.resolveCookieFile(provider);
  }

  async resolveVideo(url: string, forceRefresh = false): Promise<ResolvedTrackLike> {
    const cookieFile = this.cookieFileForUrl(url);
    const args = [
      "-J", // single JSON dump with the selected format resolved
      "--no-warnings",
      "--no-playlist",
      "-f", "bestaudio[acodec!=none]/bestaudio/best", // top-level url = picked format
      ...(forceRefresh ? ["--no-cache-dir"] : []),
      ...(cookieFile ? ["--cookies", cookieFile] : []),
      url,
    ];
    const raw = await this.run(args);
    let entry: RawEntry;
    try {
      const parsed = JSON.parse(raw) as RawEntry & { entries?: RawEntry[] };
      entry = parsed.entries?.[0] ?? parsed;
    } catch {
      throw new YtDlpError("Invalid JSON from yt-dlp");
    }
    const streamUrl = this.pickStreamUrl(entry);
    const normalizedUrl = entry.webpage_url ?? url;
    return {
      sourceUrl: url,
      normalizedUrl,
      title: entry.title ?? null,
      channel: entry.channel ?? entry.uploader ?? null,
      durationSeconds: Number.isFinite(entry.duration) ? Math.trunc(entry.duration!) : null,
      thumbnailUrl: entry.thumbnail ?? null,
      streamUrl,
      isLive: Boolean(entry.is_live),
    };
  }

  private pickStreamUrl(entry: RawEntry): string {
    if (entry.url) return entry.url;
    // -f selection gives a top-level url; formats are the fallback path only.
    const audio = entry.formats?.filter((f) => f.url && f.acodec && f.acodec !== "none");
    const best = audio?.[audio.length - 1];
    if (best?.url) return best.url;
    const any = entry.formats?.find((f) => f.url);
    if (any?.url) return any.url;
    throw new YtDlpError("no stream URL in yt-dlp output");
  }

  // ------------------------------------------------------------- search

  /** YouTube search via yt-dlp's ytsearchN pseudonym. Wire shape matches the Python service. */
  async search(query: string, limit = 10): Promise<SearchResultItem[]> {
    const raw = await this.run([
      "-J", "--no-warnings", "--flat-playlist", "--extractor-args", "youtubetab:approximate_metadata",
      `ytsearch${Math.max(1, Math.min(100, limit))}:${query}`,
    ]);
    let payload: RawEntry & { entries?: RawEntry[] };
    try {
      payload = JSON.parse(raw) as RawEntry & { entries?: RawEntry[] };
    } catch {
      throw new YtDlpError("Invalid JSON from yt-dlp search");
    }
    const entries = payload.entries ?? [];
    const results: SearchResultItem[] = [];
    for (const entry of entries) {
      const id = entry.id ?? null;
      const webpage = entry.webpage_url ?? (id ? `https://www.youtube.com/watch?v=${id}` : entry.url ?? null);
      if (!webpage) continue;
      results.push({
        provider: "youtube",
        provider_item_id: id,
        source_url: webpage,
        normalized_url: entry.webpage_url ?? webpage,
        title: entry.title ?? null,
        channel: entry.channel ?? entry.uploader ?? null,
        duration_seconds: Number.isFinite(entry.duration) ? Math.trunc(entry.duration!) : null,
        thumbnail_url: this.thumbnailFor(entry),
      });
    }
    return results;
  }

  private thumbnailFor(entry: RawEntry): string | null {
    if (typeof entry.thumbnail === "string" && entry.thumbnail) return entry.thumbnail;
    const id = entry.id;
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  }

  // ---------------------------------------------------------- playlists

  /** True for YouTube playlist URLs (list= param or /playlist path). */
  isPlaylistUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, "");
      if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com" && host !== "youtu.be") {
        return false;
      }
      if (parsed.searchParams.get("list")) return true;
      return parsed.pathname.startsWith("/playlist/");
    } catch {
      return false;
    }
  }

  /** Flat playlist preview: title/channel/entries (no per-video resolution). */
  async previewPlaylist(url: string): Promise<PlaylistPreview> {
    const cookieFile = this.cookieFileForUrl(url);
    const raw = await this.run([
      "-J", "--no-warnings", "--flat-playlist", "--extractor-args", "youtubetab:approximate_metadata",
      ...(cookieFile ? ["--cookies", cookieFile] : []),
      url,
    ]);
    let payload: RawEntry & { entries?: RawEntry[] };
    try {
      payload = JSON.parse(raw) as RawEntry & { entries?: RawEntry[] };
    } catch {
      throw new YtDlpError("Invalid JSON from yt-dlp playlist dump");
    }
    const entries = (payload.entries ?? []).filter((entry) => entry.id || entry.url || entry.webpage_url);
    return {
      provider: "youtube",
      sourceUrl: payload.webpage_url ?? payload.original_url ?? url,
      title: payload.title ?? null,
      channel: payload.channel ?? payload.uploader ?? null,
      thumbnailUrl: payload.thumbnail ?? (entries[0]?.id ? `https://i.ytimg.com/vi/${entries[0]!.id}/hqdefault.jpg` : null),
      entries: entries.map((entry) => {
        const id = entry.id ?? null;
        const webpage = entry.webpage_url ?? (id ? `https://www.youtube.com/watch?v=${id}` : entry.url ?? "");
        return {
          provider: "youtube",
          provider_item_id: id,
          source_url: webpage,
          normalized_url: webpage,
          title: entry.title ?? null,
          channel: entry.channel ?? entry.uploader ?? null,
          duration_seconds: Number.isFinite(entry.duration) ? Math.trunc(entry.duration!) : null,
          thumbnail_url: this.thumbnailFor(entry),
        };
      }),
    };
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new YtDlpError(`yt-dlp timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      proc.stdout.on("data", (chunk) => (stdout += chunk));
      proc.stderr.on("data", (chunk) => (stderr += chunk));
      proc.once("error", (error) => {
        clearTimeout(timer);
        reject(new YtDlpError(`yt-dlp failed to start: ${error.message}`));
      });
      proc.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new YtDlpError(stderr.trim() || `yt-dlp exited with status ${code}`));
      });
    });
  }
}
