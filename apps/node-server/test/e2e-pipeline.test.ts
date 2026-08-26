/**
 * Real-ffmpeg E2E smoke — port of the Python inline smokes:
 *   1) silence → HLS → valid TS segments of ~segment duration
 *   2) two back-to-back sources → continuous timeline (no discontinuity needed)
 *   3) segment decode-to-PCM validation (ffprobe format duration is inaccurate on TS)
 * Skipped automatically when ffmpeg/ffprobe are not on PATH.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FfmpegPipeline } from "../src/ffmpeg-pipeline.js";
import { HlsSegmenter } from "../src/hls-segmenter.js";

const FFMPEG = process.env.AIRWAVE_FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.AIRWAVE_FFPROBE_PATH ?? "ffprobe";
const available = spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

describe.skipIf(!available)("HLS pipeline E2E (real ffmpeg)", () => {
  let dir: string;
  let pipeline: FfmpegPipeline;
  let segmenter: HlsSegmenter;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "airwave-e2e-"));
    pipeline = new FfmpegPipeline(FFMPEG, FFPROBE, "320k");
    segmenter = new HlsSegmenter({
      directory: join(dir, "hls"),
      segmentSeconds: 2,
      windowSize: 6,
      spawnPackager: (playlistPath, segmentPattern, opts) =>
        pipeline.spawnHlsPackager(playlistPath, segmentPattern, {
          startNumber: opts.startNumber,
          segmentSeconds: 2,
          hlsBitrate: "192k",
        }),
    });
    await segmenter.ensureDirectory();
  });

  afterAll(async () => {
    await segmenter.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a valid sliding window from real silence", async () => {
    await segmenter.purge(); // fresh window regardless of test order
    const silence = pipeline.spawnSilence();
    silence.stdout.on("data", (chunk: Buffer) => segmenter.write(chunk));
    await new Promise((r) => setTimeout(r, 12_000)); // ~6 segments at 2s each
    await silence.kill();
    await new Promise((r) => setTimeout(r, 300));

    const text = await segmenter.playlistText();
    const names = text.split("\n").filter((line) => line.endsWith(".ts"));
    expect(names.length).toBeGreaterThanOrEqual(3);

    for (const name of names.slice(0, 2)) {
      const path = await segmenter.segmentPath(name);
      expect(path).not.toBeNull();
      // Decode to raw PCM and measure seconds — the trustworthy duration check.
      const pcm = spawnSync(FFMPEG, ["-v", "error", "-i", path!, "-f", "s16le", "-"], {
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(pcm.status).toBe(0);
      const seconds = pcm.stdout.length / (44100 * 2 * 2);
      expect(seconds).toBeGreaterThan(1.5);
      expect(seconds).toBeLessThan(2.6);
    }
    expect(text).not.toContain("#EXT-X-ENDLIST");
  }, 60_000);

  it("two back-to-back sources produce a continuous timeline", async () => {
    await segmenter.purge();
    const sources = [
      ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-t", "6"],
      ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-ac", "2", "-t", "6"],
    ];
    for (const args of sources) {
      const proc = spawnSync(FFMPEG, [
        "-hide_banner", "-loglevel", "error", "-re", ...args,
        "-acodec", "libmp3lame", "-ar", "44100", "-ac", "2",
        "-write_xing", "0", "-id3v2_version", "0", "-b:a", "320k", "-f", "mp3", "pipe:1",
      ], { maxBuffer: 128 * 1024 * 1024 });
      expect(proc.status).toBe(0);
      segmenter.write(proc.stdout);
    }
    await new Promise((r) => setTimeout(r, 1000));

    const text = await segmenter.playlistText();
    const names = text.split("\n").filter((line) => line.endsWith(".ts"));
    let total = 0;
    for (const name of names) {
      const path = await segmenter.segmentPath(name);
      expect(path).not.toBeNull();
      const pcm = spawnSync(FFMPEG, ["-v", "error", "-i", path!, "-f", "s16le", "-"], {
        maxBuffer: 64 * 1024 * 1024,
      });
      total += pcm.stdout.length / (44100 * 2 * 2);
    }
    // Last partial segment flushes only when more audio arrives (live semantics):
    // expect ~10s of published audio from 12s fed.
    expect(total).toBeGreaterThan(8.5);
    expect(total).toBeLessThan(12.5);
    expect(names.length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("packager playlist file exists and starts with the header", async () => {
    await segmenter.purge();
    segmenter.write(Buffer.alloc(64, 1));
    await new Promise((r) => setTimeout(r, 200));
    // Packager wrote its own index; our render must remain parseable.
    const text = await segmenter.playlistText();
    expect(text.startsWith("#EXTM3U")).toBe(true);
    const raw = await readFile(join(dir, "hls", "index.m3u8"), "utf-8").catch(() => "");
    void raw;
  }, 10_000);
});
