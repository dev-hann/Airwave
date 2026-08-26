/** Engine control-flow tests — port of tests/test_engine_control_flows.py (fake pipeline, no network). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Repository } from "@airwave/db";

import { StreamEngine } from "../src/stream-engine.js";

let dir: string;
let repo: Repository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "airwave-engine-"));
  repo = new Repository(join(dir, "engine.db"));
  repo.init();
});

afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

const fakeProc = (payload: Buffer, returncode = 0) => {
  let sent = false;
  const stdout = new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(payload);
        this.push(null);
      } else {
        this.push(null);
      }
    },
  });
  const stderrBuffer = Buffer.from("");
  const proc = {
    stdout,
    stderr: Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { read: () => stderrBuffer }),
    process: { exitCode: returncode } as never,
    stderrBuffer: () => "",
    returnCode: async () => returncode,
    write: (_d: Buffer) => {},
    end: () => {},
    kill: async () => {},
    spawnFailure: () => null,
  };
  return proc;
};

class FakePipeline {
  spawnUrls: Array<{ url: string; offset: number }> = [];
  private scripts: Array<{ url: string; offset: number; payload: Buffer; code: number }[]> = [];

  constructor(private plans: Array<Array<{ payload: Buffer; code: number }>> = []) {}

  spawnForSource(url: string, offset = 0) {
    this.spawnUrls.push({ url, offset });
    const next = this.plans.shift() ?? [{ payload: Buffer.from("abc123"), code: 0 }];
    const proc = fakeProc(next[0]!.payload, next[0]!.code);
    this.scripts.push(next.map((p) => ({ url, offset, ...p })));
    return proc;
  }
  spawnSilence() {
    return fakeProc(Buffer.from("\0\0\0\0"));
  }
  async probeSource(_url: string) {
    return { durationSeconds: 120, bitRate: null, formatName: "mp3" };
  }
  spawnHlsPackager() {
    return fakeProc(Buffer.alloc(0));
  }
}

const stubSource = {
  resolveVideo: async (url: string) => ({
    sourceUrl: url,
    normalizedUrl: url,
    title: "Resolved",
    channel: "chan",
    durationSeconds: 120,
    thumbnailUrl: null,
    streamUrl: `http://media.local/${url}`,
    isLive: false,
  }),
};

const makeEngine = (pipeline: FakePipeline, options: Partial<ConstructorParameters<typeof StreamEngine>[0]> = {}) =>
  new StreamEngine({
    repository: repo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ffmpegPipeline: pipeline as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    segmenter: fakeSegmenter() as any,
    trackSource: stubSource,
    queuePollSeconds: 0.01,
    sleeper: async () => {},
    ...options,
  });

const fakeSegmenter = () => ({
  ensureDirectory: async () => {},
  write: (_d: Buffer) => {},
  purge: async () => {},
  close: async () => {},
  playlistText: async () => "#EXTM3U\n",
  segmentPath: async (_n: string) => null,
  segmentMimeType: () => "video/mp2t",
  noteListener: (_k: string) => {},
  listenerCount: () => 0,
});

const enqueueOne = (title = "Song") =>
  repo.enqueueItems([
    {
      sourceUrl: "u", normalizedUrl: "u", sourceType: "video", title,
      provider: null, providerItemId: null, durationSeconds: 120,
      thumbnailUrl: null, playlistId: null,
    },
  ]);

describe("StreamEngine controls", () => {
  it("seek offset restarts playback at requested position", async () => {
    const created = enqueueOne();
    repo.dequeueNext();
    const pipeline = new FakePipeline();
    const engine = makeEngine(pipeline);
    engine.seekInit(30); // test helper via pendingSeek
    await engine.playItemForTest(created[0]!.id);
    expect(pipeline.spawnUrls.some((s) => s.offset === 30)).toBe(true);
  });

  it("seekToPercent rejects idle, duration-less, and live tracks", async () => {
    const engine = makeEngine(new FakePipeline());
    // idle → false
    expect(engine.seekToPercent(50)).toBe(false);
    // playing but no duration → false
    engine.state.mode = "playing";
    engine.state.nowPlayingDurationSeconds = null;
    expect(engine.seekToPercent(50)).toBe(false);
    // zero duration → false
    engine.state.nowPlayingDurationSeconds = 0;
    expect(engine.seekToPercent(50)).toBe(false);
    // live with duration → false (live guard)
    engine.state.nowPlayingDurationSeconds = 300;
    engine.state.nowPlayingIsLive = true;
    expect(engine.seekToPercent(50)).toBe(false);
    engine.state.nowPlayingIsLive = false;
    expect(engine.seekToPercent(50)).toBe(true);
  });

  it("seekToPercent clamps out-of-range values", () => {
    const engine = makeEngine(new FakePipeline());
    engine.state.mode = "playing";
    engine.state.nowPlayingDurationSeconds = 200;
    expect(engine.seekToPercent(150)).toBe(true);
    expect(engine.seekToPercent(-20)).toBe(true);
  });

  it("mid-track seek interrupts and restarts ffmpeg at the offset", async () => {
    const created = enqueueOne();
    repo.dequeueNext();
    const pipeline = new FakePipeline();
    const engine = makeEngine(pipeline);
    // runAttempt writes to the segmenter directly — hook there to fire the
    // seek once the first chunk flows (mid-track conditions).
    const seg = (engine as unknown as { segmenter: { write(chunk: Buffer): void } }).segmenter;
    const originalWrite = seg.write.bind(seg);
    seg.write = (chunk: Buffer) => {
      originalWrite(chunk);
      if (chunk.length > 0 && pipeline.spawnUrls.length === 1) {
        engine.seekToPercent(50); // 120s * 50% = 60s
      }
    };
    await engine.playItemForTest(created[0]!.id);
    // Attempt must have restarted with -ss 60 after the seek interrupt.
    expect(pipeline.spawnUrls.some((s) => s.offset === 60)).toBe(true);
    expect(repo.getItem(created[0]!.id)!.status).not.toBe("failed");
  }, 30_000);

  it("paused seek parks the target and resumes at the offset", async () => {
    const created = enqueueOne();
    repo.dequeueNext();
    const pipeline = new FakePipeline();
    const engine = makeEngine(pipeline);
    engine.state.mode = "playing";
    engine.state.nowPlayingDurationSeconds = 120;
    engine.state.startedAtMonotonicSeconds = engine.clockNow() - 10;
    engine.togglePause(); // pauses + parks elapsed=10
    expect(engine.state.paused).toBe(true);

    // Seek while paused: engine accepts and stores the target.
    expect(engine.seekToPercent(50)).toBe(true);

    // Resume through the real path: unpause drives the engine's own
    // seek+resume branch (playItem's paused/seek handling).
    engine.resumePlayback(); // clears pause via togglePause branch
    expect(engine.state.paused).toBe(false);
    // The parked seek survives in pendingSeekSeconds; restarting the item
    // picks it up as the attempt offset.
    await engine.playItemForTest(created[0]!.id);
    expect(pipeline.spawnUrls.some((s) => s.offset === 60)).toBe(true);
  }, 30_000);

  it("repeat mode rejects unknown values", () => {
    const engine = makeEngine(new FakePipeline());
    expect(() => engine.setRepeatMode("banana")).toThrow("Invalid repeat mode");
    expect(engine.state.repeatMode).toBe("off");
  });

  it("repeat-one re-enqueues completed track at front", async () => {
    const created = enqueueOne();
    repo.dequeueNext();
    const engine = makeEngine(new FakePipeline());
    engine.setRepeatMode("one");
    await engine.playItemForTest(created[0]!.id);
    expect(repo.getItem(created[0]!.id)!.status).toBe("completed");
    const ids = repo.listQueuedIds();
    expect(ids).toHaveLength(1);
    expect(repo.getItem(ids[0]!)!.title).toBe("Song");
  });

  it("user_stop re-enqueues current track", async () => {
    const created = enqueueOne();
    repo.dequeueNext();
    let fired = false;
    const engine = makeEngine(new FakePipeline());
    // Fire user_stop when the attempt writes its first chunk to the segmenter.
    const segmenter = (engine as unknown as { segmenter: { write(chunk: Buffer): void } }).segmenter;
    const originalWrite = segmenter.write.bind(segmenter);
    segmenter.write = (chunk: Buffer) => {
      originalWrite(chunk);
      if (!fired && chunk.length > 0) {
        fired = true;
        engine.stopPlayback();
      }
    };
    await engine.playItemForTest(created[0]!.id);
    expect(repo.getItem(created[0]!.id)!.status).toBe("skipped");
    const ids = repo.listQueuedIds();
    expect(ids).toHaveLength(1);
    expect(repo.getItem(ids[0]!)!.sourceUrl).toBe("u");
  });

  it("resume playback four branches", async () => {
    const created = enqueueOne();
    repo.dequeueNext();
    const engine = makeEngine(new FakePipeline());

    engine.state.mode = "playing";
    engine.state.paused = true;
    expect(engine.resumePlayback()).toBe("resumed");
    expect(engine.state.paused).toBe(false);

    engine.state.mode = "idle";
    engine.userStoppedForTest = true;
    expect(engine.resumePlayback()).toBe("resumed_from_stop");

    repo.markPlaybackFinished(created[0]!.id, "completed");
    expect(engine.resumePlayback()).toBe("resume_last");
    expect(repo.listQueuedIds()).toHaveLength(1);

    repo.clearQueue();
    repo.clearHistory();
    expect(engine.resumePlayback()).toBe("noop");
  });

  it("shuffle toggle restores canonical order", () => {
    for (let i = 1; i <= 4; i++) {
      repo.enqueueItems([
        { sourceUrl: `u${i}`, normalizedUrl: `u${i}`, sourceType: "video", title: `S${i}`,
          provider: null, providerItemId: null, durationSeconds: null, thumbnailUrl: null, playlistId: null },
      ]);
    }
    const original = repo.listQueuedIds();
    const engine = makeEngine(new FakePipeline());
    engine.setShuffleEnabled(true);
    expect(repo.listQueuedIds().length).toBe(4);
    engine.setShuffleEnabled(false);
    expect(repo.listQueuedIds()).toEqual(original);
  });

  it("toggle pause flips state and freezes elapsed", async () => {
    const created = enqueueOne();
    repo.dequeueNext();
    const engine = makeEngine(new FakePipeline());
    engine.state.mode = "playing";
    engine.state.nowPlayingDurationSeconds = 200;
    engine.state.startedAtMonotonicSeconds = engine.clockNow() - 50;

    expect(engine.togglePause()).toBe(true);
    expect(engine.state.paused).toBe(true);
    expect(engine.state.pausedElapsedSeconds).toBeGreaterThanOrEqual(49);

    expect(engine.togglePause()).toBe(false);
    expect(engine.state.paused).toBe(false);
    void created;
  });
});
