/** TrackAttemptRunner tests — port of tests/test_play_track.py (17 cases). Fakes only, injected clock, zero waiting. */

import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  ATTEMPT_COMPLETED,
  ATTEMPT_PREMATURE_END,
  ATTEMPT_RETRY_FFMPEG,
  ATTEMPT_RETRY_SOURCE,
  PlaybackState,
  ResolvedTrackLike,
  initialPlaybackState,
} from "@airwave/domain";

import { InterruptedError, TrackAttemptRequest, TrackAttemptRunner } from "../src/play-track.js";

interface FakeQueueItem {
  id: number;
  sourceUrl: string;
  normalizedUrl: string | null;
  durationSeconds: number | null;
  title: string | null;
}

const fakeItem = (overrides: Partial<FakeQueueItem> = {}): FakeQueueItem => ({
  id: 1,
  sourceUrl: "https://media.local/audio",
  normalizedUrl: "https://media.local/audio",
  durationSeconds: 120,
  title: "Song",
  ...overrides,
});

const fakeResolved = (overrides: Partial<ResolvedTrackLike> = {}): ResolvedTrackLike => ({
  sourceUrl: "https://media.local/audio",
  normalizedUrl: "https://media.local/audio",
  title: "Song",
  channel: "chan",
  durationSeconds: 120,
  thumbnailUrl: null,
  streamUrl: "http://media.local/audio",
  isLive: false,
  ...overrides,
});

class FakeProc {
  readonly stdout: Readable;
  readonly stderr: Writable;
  returncode: number;
  #bytes: Buffer[];

  constructor(payload: Buffer, returncode = 0, stderr = "") {
    this.#bytes = [payload];
    this.returncode = returncode;
    this.stdout = new Readable({
      read: () => {
        const next = this.#bytes.shift() ?? Buffer.alloc(0);
        this.stdout.push(next);
        if (this.#bytes.length === 0) this.stdout.push(null);
      },
    });
    this.stderr = new Writable({ write: (_c, _e, cb) => cb() });
    this.stderr.read = () => Buffer.from(stderr);
  }
  poll(): number {
    return this.returncode;
  }
}

class ScriptedFfmpeg {
  spawns: FakeProc[];
  probeDurations: Array<number | null>;
  spawnError: Error | null;
  spawnUrls: string[] = [];
  spawnOffsets: number[] = [];

  constructor(options: { spawns?: FakeProc[]; probeDurations?: Array<number | null>; spawnError?: Error | null }) {
    this.spawns = [...(options.spawns ?? [])];
    this.probeDurations = [...(options.probeDurations ?? [])];
    this.spawnError = options.spawnError ?? null;
  }

  spawnForSource(sourceUrl: string, startAtSeconds = 0): FakeProc {
    this.spawnUrls.push(sourceUrl);
    this.spawnOffsets.push(startAtSeconds);
    if (this.spawnError) throw this.spawnError;
    const next = this.spawns.shift();
    if (!next) throw new Error("scripted spawns exhausted");
    return next;
  }

  probeSource(_sourceUrl: string): Record<string, number | null> {
    const duration = this.probeDurations.length > 0 ? this.probeDurations.shift()! : null;
    return { duration_seconds: duration ?? null };
  }

  readChunk(stdout: Readable, chunkSize: number): Buffer {
    // Synchronous drain of available buffered bytes, mirroring the Python fake.
    const chunks: Buffer[] = [];
    while (stdout.readableLength > 0) {
      const piece = stdout.read(chunkSize) as Buffer | null;
      if (!piece) break;
      chunks.push(piece);
    }
    if (stdout.readableEnded) return Buffer.concat(chunks);
    // Wait-free fake: return whatever is buffered; payload is pushed up-front.
    if (chunks.length === 0) {
      const piece = stdout.read(chunkSize) as Buffer | null;
      if (piece) chunks.push(piece);
    }
    return Buffer.concat(chunks);
  }
}

class RecordingHooks {
  calls: string[] = [];
  chunks: Buffer[] = [];
  resolved: ResolvedTrackLike | Error;
  interruptAfter: number | null = null;
  interruptReason = "skip";
  prefetched: string | null;
  usesDirect: boolean;
  seekDefaultUsed: number | null = null;
  silenceStarted = 0;
  silenceStopped = 0;
  markedResolved: [number, string] | null = null;
  offsetSet: number | null = null;
  slowReads = 0;

  constructor(options: { resolved?: ResolvedTrackLike | Error; interruptAfter?: number; interruptReason?: string; prefetched?: string | null; usesDirect?: boolean } = {}) {
    this.resolved = options.resolved ?? fakeResolved();
    this.interruptAfter = options.interruptAfter ?? null;
    this.interruptReason = options.interruptReason ?? "skip";
    this.prefetched = options.prefetched ?? null;
    this.usesDirect = options.usesDirect ?? false;
  }

  resolveTrack(_item: FakeQueueItem, forceRefresh: boolean): ResolvedTrackLike {
    this.calls.push(`resolve:force=${forceRefresh}`);
    if (this.resolved instanceof Error) throw this.resolved;
    return this.resolved;
  }
  onResolvedMetadata(_resolved: ResolvedTrackLike): void {
    this.calls.push("metadata");
  }
  markItemResolved(itemId: number, normalizedUrl: string): void {
    this.markedResolved = [itemId, normalizedUrl];
    this.calls.push("mark_resolved");
  }
  rememberResolved(_resolved: ResolvedTrackLike): void {
    this.calls.push("remember");
  }
  consumeSeek(defaultSeconds: number): number {
    this.seekDefaultUsed = defaultSeconds;
    return defaultSeconds;
  }
  setPlaybackOffset(seconds: number): void {
    this.offsetSet = seconds;
    this.calls.push(`offset:${seconds}`);
  }
  getPrefetchedAudio(_itemId: number): string | null {
    return this.prefetched;
  }
  prefetchAudio(itemId: number, _sourceUrl: string): void {
    this.calls.push("prefetch");
    this.prefetched = `/tmp/prefetched/${itemId}.bin`;
  }
  usesDirectFfmpeg(_item: FakeQueueItem): boolean {
    return this.usesDirect;
  }
  registerActiveProcess(_process: unknown): void {
    this.calls.push("register");
  }
  triggerPrefetchUpcoming(): void {
    this.calls.push("prefetch_upcoming");
  }
  notifyStateChanged(): void {
    this.calls.push("notify");
  }
  startTransitionSilence(): { stop: () => void } | null {
    this.silenceStarted += 1;
    return { stop: () => {} };
  }
  stopTransitionSilence(_handle: { stop: () => void }): void {
    this.silenceStopped += 1;
  }
  onFirstChunk(): void {
    this.calls.push("first_chunk");
  }
  writeChunk(chunk: Buffer): void {
    this.chunks.push(chunk);
  }
  checkInterrupt(): string | null {
    if (this.interruptAfter !== null && this.chunks.length >= this.interruptAfter) {
      return this.interruptReason;
    }
    return null;
  }
  consumeInterruptReason(): string {
    return this.interruptReason;
  }
  notifySlowRead(): void {
    this.slowReads += 1;
  }
}

class FakeClock {
  now = 1000.0;
  __call(): number {
    this.now += 0.001;
    return this.now;
  }
}

const fakeClock = () => {
  const clock = new FakeClock();
  return () => clock.now++ / 1000 + 1000;
};

const runner = (ffmpeg: ScriptedFfmpeg, clock?: () => number) =>
  new TrackAttemptRunner({ transcoder: ffmpeg as never, clock: clock ?? fakeClock(), chunkSize: 4 });

const request = (item: FakeQueueItem = fakeItem(), attempt = 1, seek = 0): TrackAttemptRequest => ({
  queueItem: item,
  attempt,
  defaultSeekSeconds: seek,
});

describe("TrackAttemptRunner", () => {
  it("happy path streams chunks and completes", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("abcd"))], probeDurations: [120] });
    const hooks = new RecordingHooks();
    const result = runner(ffmpeg).run(request(), hooks as never);

    expect(result.outcome).toBe(ATTEMPT_COMPLETED);
    expect(hooks.chunks.map((c) => c.toString())).toEqual(["abcd"]);
    expect(result.chunksSent).toBe(1);
    expect(result.bytesSent).toBe(4);
    expect(result.resolved).toBe(hooks.resolved);
    expect(ffmpeg.spawnUrls).toEqual(["/tmp/prefetched/1.bin"]);
    expect(hooks.calls.slice(0, 7)).toEqual([
      "resolve:force=false",
      "mark_resolved",
      "remember",
      "metadata",
      "offset:0",
      "prefetch",
      "register",
    ]);
    expect(hooks.calls).toContain("notify");
    expect(hooks.calls).toContain("first_chunk");
    expect(hooks.calls.indexOf("notify")).toBeLessThan(hooks.calls.indexOf("first_chunk"));
    expect(hooks.silenceStarted).toBe(1);
    expect(hooks.silenceStopped).toBeGreaterThanOrEqual(1);
  });

  it("resolve failure maps to retry_source outcome", () => {
    const ffmpeg = new ScriptedFfmpeg({});
    const hooks = new RecordingHooks({ resolved: new Error("yt-dlp exploded") });
    const result = runner(ffmpeg).run(request(), hooks as never);

    expect(result.outcome).toBe(ATTEMPT_RETRY_SOURCE);
    expect(result.reason).toContain("yt-dlp exploded");
    expect(hooks.chunks).toHaveLength(0);
    expect(hooks.silenceStopped).toBeGreaterThanOrEqual(1);
  });

  it("spawn failure maps to retry_ffmpeg outcome", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawnError: new Error("ffmpeg missing") });
    const hooks = new RecordingHooks();
    const result = runner(ffmpeg).run(request(), hooks as never);

    expect(result.outcome).toBe(ATTEMPT_RETRY_FFMPEG);
    expect(result.reason).toContain("ffmpeg missing");
  });

  it("ffmpeg nonzero exit maps to retry_ffmpeg", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("ab"), 1)] });
    const result = runner(ffmpeg).run(request(), new RecordingHooks() as never);

    expect(result.outcome).toBe(ATTEMPT_RETRY_FFMPEG);
    expect(result.reason).toContain("status 1");
  });

  it("premature end with transport stderr maps to premature_end", () => {
    const ffmpeg = new ScriptedFfmpeg({
      spawns: [new FakeProc(Buffer.from("ab"), 0, "[tls] Error in the pull function.\nInput/output error")],
      probeDurations: [300],
    });
    const result = runner(ffmpeg).run(request(fakeItem({ durationSeconds: 300 })), new RecordingHooks() as never);

    expect(result.outcome).toBe(ATTEMPT_PREMATURE_END);
  });

  it("elapsed from injected clock feeds classification (slow clock, clean stderr -> completed)", () => {
    let tick = 0;
    const slowClock = () => (tick += 10); // attempt spans 20s wall vs 300s duration
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("ab"))], probeDurations: [300] });
    const result = new TrackAttemptRunner({ transcoder: ffmpeg as never, clock: slowClock, chunkSize: 4 }).run(
      request(fakeItem({ durationSeconds: 300 })),
      new RecordingHooks() as never,
    );
    expect(result.outcome).toBe(ATTEMPT_COMPLETED); // premature-but-clean = completed
  });

  it("attempt number drives force refresh", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("x"))] });
    const hooks = new RecordingHooks();
    runner(ffmpeg).run(request(fakeItem(), 2), hooks as never);
    expect(hooks.calls[0]).toBe("resolve:force=true");
  });

  it("seek offset forwarded to spawn", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("x"))] });
    const hooks = new RecordingHooks();
    runner(ffmpeg).run(request(fakeItem(), 1, 42), hooks as never);
    expect(ffmpeg.spawnOffsets).toEqual([42]);
    expect(hooks.offsetSet).toBe(42);
    expect(hooks.seekDefaultUsed).toBe(42);
  });

  it("prefetched audio preferred over stream URL (no prefetch step)", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("x"))] });
    const hooks = new RecordingHooks({ prefetched: "/tmp/prefetched/1.bin" });
    runner(ffmpeg).run(request(), hooks as never);
    expect(ffmpeg.spawnUrls).toEqual(["/tmp/prefetched/1.bin"]);
    expect(hooks.calls).not.toContain("prefetch");
  });

  it("missing prefetch triggers prefetch then spawns from downloaded file", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("x"))] });
    const hooks = new RecordingHooks();
    runner(ffmpeg).run(request(), hooks as never);
    expect(hooks.calls).toContain("prefetch");
    expect(ffmpeg.spawnUrls).toEqual(["/tmp/prefetched/1.bin"]);
  });

  it("live track never prefetches", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("x"))] });
    const hooks = new RecordingHooks();
    hooks.resolved = fakeResolved({ isLive: true });
    runner(ffmpeg).run(request(), hooks as never);
    expect(hooks.calls).not.toContain("prefetch");
    expect(ffmpeg.spawnUrls).toEqual([fakeResolved().streamUrl]);
  });

  it("direct ffmpeg items spawn from stream URL without prefetch", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("x"))] });
    const hooks = new RecordingHooks({ usesDirect: true });
    runner(ffmpeg).run(request(), hooks as never);
    expect(hooks.calls).not.toContain("prefetch");
    expect(ffmpeg.spawnUrls).toEqual([fakeResolved().streamUrl]);
  });

  it("interrupt mid-stream raises InterruptedError", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("abcdefgh"))] });
    const hooks = new RecordingHooks({ interruptAfter: 1, interruptReason: "pause" });
    expect(() => runner(ffmpeg).run(request(), hooks as never)).toThrowError(InterruptedError);
    expect(hooks.chunks.length).toBeGreaterThan(0);
    expect(hooks.silenceStopped).toBeGreaterThanOrEqual(1);
  });

  it("interrupt after prefetch consumes real reason", () => {
    class InterruptingPrefetchHooks extends RecordingHooks {
      prefetchAudio(itemId: number, sourceUrl: string): void {
        super.prefetchAudio(itemId, sourceUrl);
        this.interruptAfter = -1; // force interrupt on next check
      }
    }
    const ffmpeg = new ScriptedFfmpeg({});
    const hooks = new InterruptingPrefetchHooks();
    expect(() => runner(ffmpeg).run(request(), hooks as never)).toThrowError(InterruptedError);
  });

  it("transition silence stopped in finally when spawn fails", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawnError: new Error("boom") });
    const hooks = new RecordingHooks();
    runner(ffmpeg).run(request(), hooks as never);
    expect(hooks.silenceStarted).toBe(1);
    expect(hooks.silenceStopped).toBe(1); // only finally stop — no first chunk happened
  });

  it("result carries expected duration basis", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("x"))], probeDurations: [250] });
    const result = runner(ffmpeg).run(request(fakeItem({ durationSeconds: 120 })), new RecordingHooks() as never);
    expect(result.expectedSeconds).toBe(250); // probe wins over queue metadata
  });

  it("InterruptedError is not swallowed by the failure mapping", () => {
    const ffmpeg = new ScriptedFfmpeg({ spawns: [new FakeProc(Buffer.from("x"))] });
    const hooks = new RecordingHooks({ interruptAfter: 0, interruptReason: "stop" });
    expect(() => runner(ffmpeg).run(request(), hooks as never)).toThrowError(InterruptedError);
  });
});

// Type-only sanity: domain state remains structurally compatible.
const _state: PlaybackState = initialPlaybackState();
void _state;
