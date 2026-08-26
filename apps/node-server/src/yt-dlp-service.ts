/**
 * yt-dlp adapter — metadata resolution via JSON dump. Port of the resolve
 * surface the engine needs (app/services/yt_dlp_service.py subset).
 *
 * List-argv only. Network timeouts bounded.
 */

import { spawn } from "node:child_process";

import type { ResolvedTrackLike } from "@airwave/domain";

export class YtDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YtDlpError";
  }
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

export class YtDlpService {
  private readonly ytDlpPath: string;
  private readonly timeoutMs: number;

  constructor(ytDlpPath: string, timeoutMs = 60_000) {
    this.ytDlpPath = ytDlpPath;
    this.timeoutMs = timeoutMs;
  }

  async resolveVideo(url: string, forceRefresh = false): Promise<ResolvedTrackLike> {
    const args = [
      "-J", // single JSON dump with the selected format resolved
      "--no-warnings",
      "--no-playlist",
      "-f", "bestaudio[acodec!=none]/bestaudio/best", // top-level url = picked format
      ...(forceRefresh ? ["--no-cache-dir"] : []),
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
    const raw = await this.run(["-J", "--no-warnings", "--flat-playlist", "--extractor-args", "youtubetab:approximate_metadata", url]);
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
