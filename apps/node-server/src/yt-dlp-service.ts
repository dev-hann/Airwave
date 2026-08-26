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

interface RawEntry {
  id?: string;
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
  constructor(private readonly ytDlpPath: string, private readonly timeoutMs = 60_000) {}

  async resolveVideo(url: string, forceRefresh = false): Promise<ResolvedTrackLike> {
    const args = [
      "-J", // single JSON dump
      "--no-warnings",
      "--no-playlist",
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
    const audio = entry.formats?.find((f) => f.url && f.acodec && f.acodec !== "none" && f.protocol !== "m3u8_native");
    if (audio?.url) return audio.url;
    const any = entry.formats?.find((f) => f.url);
    if (any?.url) return any.url;
    throw new YtDlpError("no stream URL in yt-dlp output");
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
