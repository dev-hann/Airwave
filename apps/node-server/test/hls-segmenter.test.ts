/** HlsSegmenter tests — port of tests/test_hls_segmenter.py. Fake packager, real FS in tmp dirs. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HlsSegmenter } from "../src/hls-segmenter.js";

class FakePackager {
  readonly playlistPath: string;
  readonly segmentPattern: string;
  startNumber: number;
  ended = false;
  killed = false;
  failWrites = false;
  private counter: number;
  private writeCount = 0;

  constructor(playlistPath: string, segmentPattern: string, startNumber: number) {
    this.playlistPath = playlistPath;
    this.segmentPattern = segmentPattern;
    this.startNumber = startNumber;
    this.counter = startNumber;
  }

  write(_data: Buffer): void {
    if (this.failWrites || this.ended) throw new Error("broken pipe");
    this.writeCount++;
  }
  end(): void {
    this.ended = true;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }

  /** Test helper: append one segment entry to the fake playlist, like the real muxer. */
  async emitSegment(duration: number): Promise<string> {
    const name = `seg${String(this.counter).padStart(10, "0")}.ts`;
    this.counter += 1;
    await writeFile(join(this.playlistPath, "..", name), "TS");
    let old = "";
    try {
      old = await readFile(this.playlistPath, "utf-8");
    } catch {
      old = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n";
    }
    // Append like the real ffmpeg muxer (previous entries preserved).
    const body = old.endsWith("\n") ? old : `${old}\n`;
    await writeFile(this.playlistPath, `${body}#EXTINF:${duration.toFixed(3)},\n${name}\n`);
    return name;
  }

  get writes(): number {
    return this.writeCount;
  }
}

class Harness {
  packagers: FakePackager[] = [];
  segmenter: HlsSegmenter;

  constructor(root: string, options: Partial<ConstructorParameters<typeof HlsSegmenter>[0]> = {}) {
    const dir = join(root, `hls-${Math.random().toString(36).slice(2, 8)}`);
    this.segmenter = new HlsSegmenter({
      directory: dir,
      spawnPackager: (playlistPath, segmentPattern, opts) => {
        const packager = new FakePackager(playlistPath, segmentPattern, opts.startNumber);
        this.packagers.push(packager);
        return packager as never;
      },
      ...options,
    });
  }

  get active(): FakePackager {
    if (this.packagers.length === 0) throw new Error("no packager spawned");
    return this.packagers[this.packagers.length - 1]!;
  }
}

let root: string;
const harnesses: Harness[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "airwave-hls-test-"));
});

afterEach(async () => {
  for (const harness of harnesses) await harness.segmenter.close().catch(() => {});
  harnesses.length = 0;
  rmSync(root, { recursive: true, force: true });
});

const make = (options: Partial<ConstructorParameters<typeof HlsSegmenter>[0]> = {}): Harness => {
  const harness = new Harness(root, options);
  harnesses.push(harness);
  return harness;
};

describe("HlsSegmenter", () => {
  it("write spawns packager lazily and forwards bytes; empty writes no-op", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    expect(harness.packagers).toHaveLength(0);
    harness.segmenter.write(Buffer.from("mp3-bytes"));
    await new Promise((r) => setTimeout(r, 10));
    expect(harness.packagers).toHaveLength(1);
    expect(harness.active.writes).toBe(1);
    harness.segmenter.write(Buffer.alloc(0));
    await new Promise((r) => setTimeout(r, 10));
    expect(harness.packagers).toHaveLength(1);
  });

  it("write respawns dead packager and continues", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    harness.segmenter.write(Buffer.from("first"));
    await new Promise((r) => setTimeout(r, 10));
    const first = harness.active;
    first.failWrites = true;
    harness.segmenter.write(Buffer.from("second"));
    await new Promise((r) => setTimeout(r, 20));
    expect(first.killed).toBe(true);
    expect(harness.packagers).toHaveLength(2);
    expect(harness.active.startNumber).toBe(0);
  });

  it("playlist empty when nothing published", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    const text = await harness.segmenter.playlistText();
    expect(text.split("\n")[0]).toBe("#EXTM3U");
    expect(text).not.toContain("#EXT-X-ENDLIST");
    expect(text).toContain("#EXT-X-TARGETDURATION:4");
    expect(text).toContain("#EXT-X-MEDIA-SEQUENCE:0");
  });

  it("playlist appends new segments with durations", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    harness.segmenter.write(Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 5));
    await harness.active.emitSegment(4);
    await harness.active.emitSegment(3.876);
    const text = await harness.segmenter.playlistText();
    const lines = text.split("\n");
    expect(text).toContain("#EXT-X-TARGETDURATION:4");
    expect(text).toContain("#EXT-X-MEDIA-SEQUENCE:0");
    expect(text).toContain("#EXTINF:4.000,");
    expect(text).toContain("#EXTINF:3.876,");
    expect(text).toContain("seg0000000000.ts");
    expect(text).toContain("seg0000000001.ts");
    expect(lines.indexOf("seg0000000000.ts")).toBeLessThan(lines.indexOf("seg0000000001.ts"));
    expect(text).not.toContain("#EXT-X-ENDLIST");
  });

  it("playlist sync is idempotent", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    harness.segmenter.write(Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 5));
    await harness.active.emitSegment(4);
    const first = await harness.segmenter.playlistText();
    const second = await harness.segmenter.playlistText();
    expect(first).toBe(second);
  });

  it("window prunes old segments and deletes files", async () => {
    const harness = make({ windowSize: 3 });
    await harness.segmenter.ensureDirectory();
    harness.segmenter.write(Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 5));
    const names: string[] = [];
    for (let i = 0; i < 5; i++) names.push(await harness.active.emitSegment(4));
    const text = await harness.segmenter.playlistText();
    for (const name of names.slice(0, 2)) {
      expect(text).not.toContain(name);
    }
    for (const name of names.slice(2)) {
      expect(text).toContain(name);
    }
    expect(text).toContain("#EXT-X-MEDIA-SEQUENCE:2");
  });

  it("purge wipes window and marks discontinuity", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    harness.segmenter.write(Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 5));
    const firstName = await harness.active.emitSegment(4);
    await harness.segmenter.purge();
    expect(await harness.segmenter.playlistText()).not.toContain(firstName);
    expect(harness.active.killed).toBe(true);

    harness.segmenter.write(Buffer.from("y"));
    await new Promise((r) => setTimeout(r, 10));
    const secondName = await harness.active.emitSegment(4);
    const text = await harness.segmenter.playlistText();
    expect(text).toContain("#EXT-X-DISCONTINUITY");
    expect(text).toContain(secondName);
    expect(text).toContain("#EXT-X-MEDIA-SEQUENCE:1");
  });

  it("purge before any content sets no discontinuity", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    await harness.segmenter.purge();
    harness.segmenter.write(Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 10));
    await harness.active.emitSegment(4);
    expect(await harness.segmenter.playlistText()).not.toContain("#EXT-X-DISCONTINUITY");
  });

  it("segment_path only serves window entries", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    harness.segmenter.write(Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 5));
    const name = await harness.active.emitSegment(4);
    const path = await harness.segmenter.segmentPath(name);
    expect(path).not.toBeNull();

    for (let i = 0; i < 12; i++) await harness.active.emitSegment(4);
    expect(await harness.segmenter.segmentPath(name)).toBeNull();
  });

  it.each(["index.m3u8", "seg.ts", "segabc.ts", "seg0000000000.ts.bak", "../seg0000000000.ts", "/etc/passwd", "sub/seg0000000000.ts", "SEG0000000000.TS"])(
    "segment_path rejects foreign name %s",
    async (name) => {
      const harness = make();
      await harness.segmenter.ensureDirectory();
      harness.segmenter.write(Buffer.from("x"));
      await new Promise((r) => setTimeout(r, 5));
      await harness.active.emitSegment(4);
      expect(await harness.segmenter.segmentPath(name)).toBeNull();
    },
  );

  it("listener registry counts recent clients only and is idempotent", () => {
    const harness = make({ listenerTtlSeconds: 0.05 });
    harness.segmenter.noteListener("a");
    harness.segmenter.noteListener("b");
    expect(harness.segmenter.listenerCount()).toBe(2);
    harness.segmenter.noteListener("a");
    expect(harness.segmenter.listenerCount()).toBe(2);
  });

  it("expired listeners disappear after TTL", async () => {
    const harness = make({ listenerTtlSeconds: 0.05 });
    harness.segmenter.noteListener("old");
    await new Promise((r) => setTimeout(r, 80));
    expect(harness.segmenter.listenerCount()).toBe(0);
  });

  it("close terminates packager and removes directory", async () => {
    const harness = make();
    await harness.segmenter.ensureDirectory();
    harness.segmenter.write(Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 5));
    await harness.active.emitSegment(4);
    const dir = join(harness.active.playlistPath, "..");
    await harness.segmenter.close();
    expect(harness.active.killed).toBe(true);
    await expect(readFile(join(dir, "index.m3u8"))).rejects.toThrow();
  });
});
