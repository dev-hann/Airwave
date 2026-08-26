/**
 * HLS segmenter — port of app/services/hls_segmenter.py.
 *
 * Owns the single packager process turning the engine's continuous MP3 byte
 * stream into a sliding window of AAC MPEG-TS segments. Control interrupts
 * purge the window and mark a discontinuity.
 */

import { access } from "node:fs/promises";
import { mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

const SEGMENT_NAME_RE = /^seg\d{1,12}\.ts$/;
const EXTINF_RE = /^#EXTINF:([\d.]+)/;

export interface PackagerHandle {
  write(data: Buffer): void;
  end(): void;
  kill(): Promise<void>;
}

export interface HlsSegmenterOptions {
  segmentSeconds?: number;
  windowSize?: number;
  listenerTtlSeconds?: number;
  directory?: string;
  spawnPackager: (playlistPath: string, segmentPattern: string, options: { startNumber: number }) => PackagerHandle;
}

interface WindowEntry {
  sequence: number;
  filename: string;
  duration: number;
  discontinuity: boolean;
}

export class HlsSegmenter {
  private readonly segmentSeconds: number;
  private readonly windowSize: number;
  private readonly listenerTtlSeconds: number;
  private readonly dir: string;
  private readonly playlistPath: string;
  private readonly segmentPattern: string;
  private readonly spawnPackager: (playlistPath: string, segmentPattern: string, options: { startNumber: number }) => PackagerHandle;

  private packager: PackagerHandle | null = null;
  private entries: WindowEntry[] = [];
  private nextSequence = 0;
  private parsedFilenames = new Set<string>();
  private discontinuityPending = false;
  private writeQueue: Buffer[] = [];
  private flushing = false;

  private readonly listeners = new Map<string, number>();

  constructor(options: HlsSegmenterOptions) {
    this.segmentSeconds = Math.max(0.5, options.segmentSeconds ?? 4);
    this.windowSize = Math.max(3, options.windowSize ?? 12);
    this.listenerTtlSeconds = options.listenerTtlSeconds ?? 30;
    this.dir = options.directory ?? join(tmpdir(), `airwave-hls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.playlistPath = join(this.dir, "index.m3u8");
    this.segmentPattern = join(this.dir, "seg%010d.ts");
    this.spawnPackager = options.spawnPackager;
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Feed MP3 bytes into the packager (spawning it on first use). */
  write(data: Buffer): void {
    if (data.length === 0) return;
    if (!this.packager) {
      try {
        this.packager = this.spawnPackager(this.playlistPath, this.segmentPattern, { startNumber: this.nextSequence });
      } catch (error) {
        console.error("Failed to spawn HLS packager", error);
        return;
      }
    }
    this.writeQueue.push(data);
    void this.flushWriteQueue();
  }

  private async flushWriteQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.writeQueue.length > 0 && this.packager) {
        const next = this.writeQueue.shift()!;
        try {
          this.packager.write(next);
        } catch {
          // Packager died mid-stream: respawn at the synced sequence.
          await this.respawnPackager();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async respawnPackager(): Promise<void> {
    console.warn(`HLS packager died mid-stream; respawning at sequence ${this.nextSequence}`);
    await this.syncFromPackagerPlaylist();
    await this.terminatePackager();
    try {
      this.packager = this.spawnPackager(this.playlistPath, this.segmentPattern, { startNumber: this.nextSequence });
    } catch (error) {
      console.error("Failed to respawn HLS packager", error);
      this.packager = null;
    }
  }

  /** Drop the visible window (control interrupt): kill packager, wipe segments, mark discontinuity. */
  async purge(): Promise<void> {
    await this.syncFromPackagerPlaylist();
    const hadContent = this.entries.length > 0 || this.nextSequence > 0;
    await this.terminatePackager();
    this.entries = [];
    this.parsedFilenames.clear();
    await this.deleteSegmentFiles();
    await rm(this.playlistPath, { force: true });
    if (hadContent) this.discontinuityPending = true;
  }

  async close(): Promise<void> {
    await this.terminatePackager();
    this.entries = [];
    await rm(this.dir, { recursive: true, force: true });
  }

  async playlistText(): Promise<string> {
    await this.syncFromPackagerPlaylist();
    return this.renderPlaylist();
  }

  async segmentPath(name: string): Promise<string | null> {
    if (!SEGMENT_NAME_RE.test(name)) return null;
    await this.syncFromPackagerPlaylist();
    for (const entry of this.entries) {
      if (entry.filename === name) {
        const path = join(this.dir, entry.filename);
        try {
          await access(path);
          return path;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  segmentMimeType(): string {
    return "video/mp2t";
  }

  noteListener(clientKey: string): void {
    const now = performance.now() / 1000;
    this.listeners.set(clientKey, now);
    this.pruneListeners(now);
  }

  listenerCount(): number {
    const now = performance.now() / 1000;
    this.pruneListeners(now);
    return this.listeners.size;
  }

  private pruneListeners(now: number): void {
    for (const [key, seenAt] of this.listeners) {
      if (now - seenAt > this.listenerTtlSeconds) this.listeners.delete(key);
    }
  }

  // -------------------------------------------------------------- internals

  private async terminatePackager(): Promise<void> {
    const packager = this.packager;
    this.packager = null;
    if (!packager) return;
    try {
      packager.end();
    } catch {
      // Already gone.
    }
    try {
      await packager.kill();
    } catch {
      // Already reaped.
    }
  }

  private async deleteSegmentFiles(): Promise<void> {
    let children: string[];
    try {
      children = await readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(
      children
        .filter((name) => SEGMENT_NAME_RE.test(name))
        .map((name) => unlink(join(this.dir, name)).catch(() => {})),
    );
  }

  /** Diff the packager's own index.m3u8 into our window state. */
  private async syncFromPackagerPlaylist(): Promise<void> {
    if (!this.packager) return;
    let text: string;
    try {
      text = await readFile(this.playlistPath, "utf-8");
    } catch {
      return;
    }
    let pendingDuration: number | null = null;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      const extinf = EXTINF_RE.exec(line);
      if (extinf) {
        pendingDuration = Number(extinf[1]);
        continue;
      }
      if (!SEGMENT_NAME_RE.test(line)) continue;
      const filename = line;
      if (this.parsedFilenames.has(filename)) {
        pendingDuration = null;
        continue;
      }
      this.parsedFilenames.add(filename);
      const duration = pendingDuration ?? this.segmentSeconds;
      const discontinuity = this.discontinuityPending;
      this.discontinuityPending = false;
      this.entries.push({ sequence: this.nextSequence, filename, duration, discontinuity });
      this.nextSequence += 1;
      pendingDuration = null;
    }
    while (this.entries.length > this.windowSize) {
      const dropped = this.entries.shift()!;
      await unlink(join(this.dir, dropped.filename)).catch(() => {});
    }
  }

  private renderPlaylist(): string {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
    if (this.entries.length > 0) {
      const target = Math.max(1, Math.round(Math.max(...this.entries.map((entry) => entry.duration))));
      lines.push(`#EXT-X-TARGETDURATION:${target}`);
      lines.push(`#EXT-X-MEDIA-SEQUENCE:${this.entries[0]!.sequence}`);
      for (const entry of this.entries) {
        if (entry.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
        lines.push(`#EXTINF:${entry.duration.toFixed(3)},`);
        lines.push(entry.filename);
      }
    } else {
      const target = Math.max(1, Math.trunc(this.segmentSeconds));
      lines.push(`#EXT-X-TARGETDURATION:${target}`);
      lines.push(`#EXT-X-MEDIA-SEQUENCE:${this.nextSequence}`);
    }
    // No #EXT-X-ENDLIST: this is a live window.
    return lines.join("\n") + "\n";
  }
}

import { tmpdir } from "node:os";
