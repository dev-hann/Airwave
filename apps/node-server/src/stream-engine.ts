/**
 * StreamEngine — port of app/services/stream_engine.py (playback session).
 *
 * Single-threaded async loop: dequeue → play attempt (TrackAttemptRunner) →
 * retry/interrupt dispatch → advance. No locks (Node runs one loop); state
 * mutations happen between awaits only, so snapshot() is trivially consistent.
 */

import {
  ATTEMPT_COMPLETED,
  ATTEMPT_RETRY_FFMPEG,
  initialPlaybackState,
  playbackProgress,
  REPEAT_ALL,
  REPEAT_ONE,
  repeatCycleItemFrom,
  restoreOrder,
  shuffledOrder,
  stderrIndicatesStreamFailure,
} from "@airwave/domain";
import type { PlaybackState, ResolvedTrackLike } from "@airwave/domain";
import type { Repository } from "@airwave/db";
import { InterruptedError } from "@airwave/usecases";
import type { AttemptHooks } from "@airwave/usecases";

import { FfmpegPipeline } from "./ffmpeg-pipeline.ts";
import type { SpawnedProcess } from "./ffmpeg-pipeline.ts";
import { HlsSegmenter } from "./hls-segmenter.ts";

export type InterruptReason =
  | "skip"
  | "pause"
  | "resume"
  | "seek"
  | "stop"
  | "user_stop"
  | "resume_from_stop"
  | "previous";

export interface StreamEngineOptions {
  repository: Repository;
  ffmpegPipeline: FfmpegPipeline;
  segmenter: HlsSegmenter;
  trackSource: {
    resolveVideo: (url: string, forceRefresh?: boolean) => Promise<ResolvedTrackLike>;
    normalizeUrl?: (url: string) => string;
  };
  chunkSize?: number;
  queuePollSeconds?: number;
  playbackRetryCount?: number;
  onStateChange?: () => void;
  clock?: () => number;
  sleeper?: (seconds: number) => Promise<void>;
}

interface ResolvedTrackCacheEntry {
  resolved: ResolvedTrackLike;
}

export class StreamEngine {
  readonly state: PlaybackState = initialPlaybackState();
  private readonly repo: Repository;
  private readonly ffmpeg: FfmpegPipeline;
  private readonly segmenter: HlsSegmenter;
  private readonly trackSource: StreamEngineOptions["trackSource"];
  private readonly chunkSize: number;
  private readonly queuePollSeconds: number;
  private readonly playbackRetryCount: number;
  private readonly onStateChange?: () => void;
  private readonly clock: () => number;
  private readonly sleeper: (seconds: number) => Promise<void>;

  private readonly attemptHooks: AttemptHooks;

  private readonly resolvedTrackCache = new Map<number, ResolvedTrackCacheEntry>();
  private readonly recentResolvedByUrl = new Map<string, ResolvedTrackLike>();
  private readonly prefetchedAudio = new Map<number, string>();
  private repeatCycle: ReturnType<typeof repeatCycleItemFrom>[] = [];
  private shuffleRestoreOrder: number[] | null = null;

  private interruptRequested: InterruptReason | null = null;
  private pendingSeekSeconds: number | null = null;
  private userStopped = false;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private activeProcess: SpawnedProcess | null = null;
  private silenceProcess: SpawnedProcess | null = null;

  constructor(options: StreamEngineOptions) {
    this.repo = options.repository;
    this.ffmpeg = options.ffmpegPipeline;
    this.segmenter = options.segmenter;
    this.trackSource = options.trackSource;
    this.chunkSize = options.chunkSize ?? 4096;
    this.queuePollSeconds = options.queuePollSeconds ?? 1;
    this.playbackRetryCount = Math.max(0, options.playbackRetryCount ?? 2);
    this.onStateChange = options.onStateChange;
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.sleeper = options.sleeper ?? ((seconds) => new Promise((r) => setTimeout(r, seconds * 1000)));
    this.attemptHooks = this.buildAttemptHooks();
  }

  // ------------------------------------------------------------ HLS facade

  async playlistText(): Promise<string> {
    return this.segmenter.playlistText();
  }

  async segmentPath(name: string): Promise<string | null> {
    return this.segmenter.segmentPath(name);
  }

  segmentMimeType(): string {
    return this.segmenter.segmentMimeType();
  }

  noteListener(key: string): void {
    this.segmenter.noteListener(key);
  }

  listenerCount(): number {
    return this.segmenter.listenerCount();
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.segmenter.ensureDirectory();
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.requestInterrupt("stop");
    await this.loopPromise;
    await this.segmenter.close();
  }

  private requestInterrupt(reason: InterruptReason, purge = true): void {
    this.interruptRequested = reason;
    if (purge) {
      void this.segmenter.purge();
      this.killActiveProcess();
    }
  }

  private consumeInterrupt(): InterruptReason {
    const reason = this.interruptRequested ?? "skip";
    this.interruptRequested = null;
    return reason;
  }

  // ------------------------------------------------------------ main loop

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        if (this.userStopped) {
          await this.streamIdle();
          continue;
        }
        const item = this.repo.dequeueNext();
        if (!item) {
          if (this.state.repeatMode === REPEAT_ALL && this.repeatCycle.length > 0) {
            const replay = this.repeatCycle;
            this.repeatCycle = [];
            this.repo.enqueueCycleItems(replay);
            continue;
          }
          if (this.state.repeatMode !== REPEAT_ALL) this.repeatCycle = [];
          await this.streamIdle();
          continue;
        }
        await this.playItem(item.id);
      } catch (error) {
        console.error("Stream engine loop failed; retrying", error);
        await this.sleeper(this.queuePollSeconds);
      }
    }
  }

  private async streamIdle(): Promise<void> {
    this.state.mode = "idle";
    this.state.nowPlayingId = null;
    this.state.nowPlayingTitle = null;
    this.state.nowPlayingChannel = null;
    this.state.nowPlayingThumbnailUrl = null;
    this.state.nowPlayingDurationSeconds = null;
    this.state.nowPlayingIsLive = false;
    this.state.startedAtEpochSeconds = null;
    this.state.startedAtMonotonicSeconds = null;
    this.state.paused = false;
    this.state.pausedElapsedSeconds = null;
    this.notifyStateChanged();

    let silence: SpawnedProcess | null = this.spawnSilenceOrNull();
    if (!silence) {
      await this.sleeper(this.queuePollSeconds);
      return;
    }
    let idleStart = this.clock();
    try {
      while (this.running && silence) {
        if (this.interruptRequested) {
          const reason = this.consumeInterrupt();
          if (reason === "resume_from_stop") return;
          // user_stop keeps idling
        }
        const chunk = await this.readChunk(silence);
        if (!chunk || chunk.length === 0) {
          this.killProcess(silence);
          silence = this.spawnSilenceOrNull();
          if (!silence) await this.sleeper(this.queuePollSeconds);
          continue;
        }
        this.segmenter.write(chunk);
        if (this.clock() - idleStart >= this.queuePollSeconds) {
          idleStart = this.clock();
          if (!this.userStopped && this.repo.hasQueuedItems()) break;
        }
      }
    } finally {
      this.killProcess(silence);
    }
  }

  // ------------------------------------------------------------ play item

  private async playItem(itemId: number): Promise<void> {
    const queueItem = this.repo.getItem(itemId);
    if (!queueItem) return;

    this.state.mode = "playing";
    this.state.nowPlayingId = queueItem.id;
    this.state.nowPlayingTitle = queueItem.title;
    this.state.nowPlayingChannel = queueItem.channel;
    this.state.nowPlayingThumbnailUrl = queueItem.thumbnailUrl;
    this.state.nowPlayingDurationSeconds = queueItem.durationSeconds;
    let startOffset = this.consumePendingSeek(0);
    this.setPlaybackOffset(startOffset);
    this.state.paused = false;
    this.state.pausedElapsedSeconds = null;

    const itemLike = {
      id: queueItem.id,
      sourceUrl: queueItem.sourceUrl,
      provider: queueItem.provider,
      providerItemId: queueItem.providerItemId,
      normalizedUrl: queueItem.normalizedUrl,
      sourceType: queueItem.sourceType,
      title: queueItem.title,
      durationSeconds: queueItem.durationSeconds,
      thumbnailUrl: queueItem.thumbnailUrl,
      playlistId: queueItem.playlistId,
    };

    while (this.running) {
      this.interruptRequested = null;
      const totalAttempts = this.playbackRetryCount + 1;
      let finalFailure: Error | null = null;
      try {
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
          if (!this.running) throw new InterruptedError("stop");
          this.activeProcess = null;
          // Resolution is async in Node: pre-seed before the attempt.
          await this.ensureResolved(queueItem.id, queueItem.sourceUrl, attempt > 1);
          const result = await this.runAttempt(itemLike, attempt, startOffset);
          startOffset = result.seekSeconds;

          if (result.outcome === ATTEMPT_COMPLETED) {
            this.handleCompleted(queueItem, result);
            return;
          }

          const failure =
            result.outcome === ATTEMPT_RETRY_FFMPEG
              ? new Error(result.reason ?? "ffmpeg failed")
              : new Error(result.reason ?? "playback failed");
          if (attempt >= totalAttempts) {
            finalFailure = failure;
            break;
          }
          this.prefetchedAudio.delete(queueItem.id);
          this.resolvedTrackCache.delete(queueItem.id);
          console.warn(`Playback attempt ${attempt}/${totalAttempts} failed on track ${queueItem.id}: ${failure.message}`);
          await this.sleeper(Math.min(0.5, this.queuePollSeconds));
        }
        if (finalFailure) throw finalFailure;
      } catch (error) {
        if (error instanceof InterruptedError) {
          const reason: string = error.reason || this.consumeInterrupt();
          if (reason === "pause" || reason === "resume" || (reason === "seek" && this.state.paused)) {
            await this.streamPaused();
            if (!this.running) return;
            startOffset = this.consumePendingSeek(this.currentElapsed());
            this.state.paused = false;
            this.state.pausedElapsedSeconds = null;
            this.setPlaybackOffset(startOffset);
            this.notifyStateChanged();
            continue;
          }
          if (reason === "seek") {
            startOffset = this.consumePendingSeek(this.currentElapsed());
            continue;
          }
          if (reason === "stop") return;
          if (reason === "user_stop") {
            this.repo.markPlaybackFinished(queueItem.id, "skipped");
            const reQueued = this.repo.enqueueCycleItems([repeatCycleItemFrom(itemLike)]);
            if (reQueued.length > 0) this.repo.moveItemToFront(reQueued[0]!.id);
            this.notifyStateChanged();
            return;
          }
          // skip / previous / resume_from_stop
          this.repo.markPlaybackFinished(queueItem.id, "skipped");
          this.notifyStateChanged();
          return;
        }
        console.error(`Track ${queueItem.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.repo.markPlaybackFinished(queueItem.id, "failed", error instanceof Error ? error.message : String(error));
        this.notifyStateChanged();
        return;
      }
    }
  }

  private handleCompleted(
    queueItem: { id: number; sourceUrl: string; normalizedUrl: string; durationSeconds: number | null; title: string | null },
    result: { elapsedSeconds: number; expectedSeconds: number; chunksSent: number; bytesSent: number },
  ): void {
    this.repo.markPlaybackFinished(queueItem.id, "completed");
    const cycleItem = repeatCycleItemFrom({
      sourceUrl: queueItem.sourceUrl,
      provider: null,
      providerItemId: null,
      normalizedUrl: queueItem.normalizedUrl,
      sourceType: "video",
      title: queueItem.title,
      durationSeconds: queueItem.durationSeconds,
      thumbnailUrl: null,
      playlistId: null,
    });
    if (this.state.repeatMode === REPEAT_ONE) {
      const created = this.repo.enqueueCycleItems([cycleItem]);
      if (created.length > 0) this.repo.moveItemToFront(created[0]!.id);
    }
    this.repeatCycle.push(cycleItem);
    this.prefetchedAudio.delete(queueItem.id);
    this.notifyStateChanged();
    console.log(
      `Track ${queueItem.id} completed (elapsed=${result.elapsedSeconds.toFixed(2)}s bytes=${result.bytesSent} chunks=${result.chunksSent})`,
    );
  }

  private async streamPaused(): Promise<void> {
    while (this.running) {
      if (this.interruptRequested) {
        const reason = this.consumeInterrupt();
        if (reason === "pause") {
          if (!this.state.paused) return;
          continue;
        }
        if (reason === "resume") return;
        throw new InterruptedError(reason);
      }
      if (!this.state.paused) return;
      const silence = this.spawnSilenceOrNull();
      if (!silence) {
        await this.sleeper(0.1);
        continue;
      }
      try {
        while (this.running && this.state.paused) {
          if (this.interruptRequested) {
            const reason = this.consumeInterrupt();
            if (reason === "pause") {
              if (!this.state.paused) return;
              continue;
            }
            if (reason === "resume") return;
            throw new InterruptedError(reason);
          }
          const chunk = await this.readChunk(silence);
          if (!chunk || chunk.length === 0) break;
          this.segmenter.write(chunk);
        }
      } finally {
        this.killProcess(silence);
      }
    }
  }

  // ------------------------------------------------------------ controls

  skip(): void {
    this.requestInterrupt("skip");
  }

  /**
   * "Play now" semantics: the user explicitly asked for playback, so any
   * lingering user-stop flag must clear first — otherwise the engine stays
   * idle forever with queued items (skip() alone does not resume it).
   */
  playNow(): void {
    if (this.userStopped) {
      this.userStopped = false;
      this.requestInterrupt("resume_from_stop");
    }
    this.requestInterrupt("skip");
  }

  togglePause(): boolean {
    if (this.state.mode !== "playing") return false;
    if (this.state.paused) {
      const target = this.currentElapsed();
      this.state.paused = false;
      this.state.pausedElapsedSeconds = null;
      this.setPlaybackOffset(target);
      this.pendingSeekSeconds = target;
      this.notifyStateChanged();
      this.requestInterrupt("resume");
      return false;
    }
    this.state.paused = true;
    this.state.pausedElapsedSeconds = this.currentElapsed();
    this.notifyStateChanged();
    this.requestInterrupt("pause");
    return true;
  }

  seekToPercent(percent: number): boolean {
    const duration = this.state.nowPlayingDurationSeconds;
    if (!duration || duration <= 0) return false;
    const clamped = Math.min(100, Math.max(0, percent));
    return this.seekToSeconds((clamped / 100) * duration);
  }

  seekToSeconds(seconds: number): boolean {
    if (this.state.mode !== "playing") return false;
    const duration = this.state.nowPlayingDurationSeconds;
    let target = Math.max(0, seconds);
    if (duration && duration > 0) target = Math.min(target, duration);
    this.pendingSeekSeconds = target;
    this.requestInterrupt("seek");
    return true;
  }

  stopPlayback(): void {
    this.userStopped = true;
    this.requestInterrupt("user_stop");
  }

  resumePlayback(): "resumed" | "resumed_from_stop" | "resume_last" | "noop" {
    if (this.state.paused) {
      this.togglePause();
      return "resumed";
    }
    if (this.userStopped) {
      this.userStopped = false;
      this.requestInterrupt("resume_from_stop");
      return "resumed_from_stop";
    }
    if (this.state.mode === "idle") {
      const history = this.repo.listHistory(1);
      if (history.length === 0) return "noop";
      const previous = history[0]!;
      const queued = this.repo.enqueueItems([
        {
          sourceUrl: previous.sourceUrl || "unknown",
          provider: previous.provider,
          providerItemId: previous.providerItemId,
          normalizedUrl: previous.sourceUrl,
          sourceType: "video",
          title: previous.title ?? previous.sourceUrl,
          durationSeconds: null,
          thumbnailUrl: previous.thumbnailUrl,
          playlistId: null,
        },
      ]);
      if (queued.length > 0) this.repo.moveItemToFront(queued[0]!.id);
      this.requestInterrupt("resume_from_stop");
      this.notifyStateChanged();
      return "resume_last";
    }
    return "noop";
  }

  setRepeatMode(mode: string): string {
    if (mode !== "off" && mode !== "all" && mode !== "one") throw new Error("Invalid repeat mode");
    this.state.repeatMode = mode;
    this.notifyStateChanged();
    return mode;
  }

  setShuffleEnabled(enabled: boolean): boolean {
    const ids = this.repo.listQueuedIds();
    if (enabled && !this.state.shuffleEnabled) {
      this.shuffleRestoreOrder = [...ids];
      if (ids.length > 1) {
        const rng = { shuffle: (list: number[]) => list.sort(() => Math.random() - 0.5) };
        this.repo.reorderQueuedItems(shuffledOrder(ids, rng));
      }
    } else if (!enabled && this.state.shuffleEnabled) {
      const restore = restoreOrder(ids, this.shuffleRestoreOrder);
      if (restore) this.repo.reorderQueuedItems(restore);
      this.shuffleRestoreOrder = null;
    }
    this.state.shuffleEnabled = enabled;
    this.notifyStateChanged();
    return enabled;
  }

  playPreviousOrRestart(): "previous" | "restarted" | "noop" {
    if (this.state.mode !== "playing") return "noop";
    const elapsed = this.currentElapsed();
    if (this.state.nowPlayingDurationSeconds && elapsed >= 3) {
      this.seekToPercent(0);
      return "restarted";
    }
    this.requestInterrupt("previous");
    return "previous";
  }

  // ------------------------------------------------------------ progress

  playbackProgress(): ReturnType<typeof playbackProgress> {
    return playbackProgress(this.state, this.clock());
  }

  private currentElapsed(): number {
    return this.playbackProgress().elapsedSeconds ?? 0;
  }

  private consumePendingSeek(defaultSeconds: number): number {
    const pending = this.pendingSeekSeconds;
    this.pendingSeekSeconds = null;
    return Math.max(0, pending ?? defaultSeconds);
  }

  private setPlaybackOffset(seconds: number): void {
    this.state.startedAtEpochSeconds = Date.now() / 1000 - seconds;
    this.state.startedAtMonotonicSeconds = this.clock() - seconds;
  }

  private notifyStateChanged(): void {
    this.onStateChange?.();
  }

  // ------------------------------------------------------------ processes

  private spawnSilenceOrNull(): SpawnedProcess | null {
    try {
      const silence = this.ffmpeg.spawnSilence();
      if (silence.spawnFailure()) {
        // Binary missing/unspawnable: surface once, degrade to polling silence.
        console.error("Failed to spawn silence:", silence.spawnFailure()?.message);
        void silence.kill();
        return null;
      }
      this.silenceProcess = silence;
      return silence;
    } catch (error) {
      console.error("Failed to spawn silence", error);
      return null;
    }
  }

  private killProcess(process: SpawnedProcess | null): void {
    if (!process) return;
    void process.kill();
    if (this.silenceProcess === process) this.silenceProcess = null;
  }

  private killActiveProcess(): void {
    if (this.activeProcess) {
      void this.activeProcess.kill();
      this.activeProcess = null;
    }
  }

  private async readChunk(process: SpawnedProcess): Promise<Buffer> {
    const stdout = process.stdout;
    if (!stdout.readable) return Buffer.alloc(0);
    if (stdout.readableLength > 0) {
      return (stdout.read(this.chunkSize) as Buffer) ?? Buffer.alloc(0);
    }
    // Pure data-driven wait: 'readable' + 'data' together race — 'readable'
    // can fire while read() still returns null and settle an empty chunk,
    // stalling the idle-silence loop (observed: 0 bytes fed, forever).
    return await new Promise<Buffer>((resolve) => {
      let settled = false;
      const settle = (value: Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onData = (data: Buffer) => settle(data);
      const onEnd = () => settle(Buffer.alloc(0));
      const onError = () => settle(Buffer.alloc(0));
      const cleanup = () => {
        stdout.off("data", onData);
        stdout.off("end", onEnd);
        stdout.off("error", onError);
      };
      stdout.on("data", onData);
      stdout.on("end", onEnd);
      stdout.on("error", onError);
    });
  }

  // ------------------------------------------------------------ adapters

  private buildAttemptHooks(): AttemptHooks {
    const engine = this;
    return {
      resolveTrack(item, forceRefresh) {
        const cached = engine.resolvedTrackCache.get(item.id);
        if (cached && !forceRefresh) return cached.resolved;
        // Pre-seeded by playItem via ensureResolved before each attempt round;
        // a miss here means the source vanished — treat as retry_source.
        throw new Error("resolveTrack cache miss (ensureResolved not called)");
      },
      onResolvedMetadata(resolved) {
        if (resolved.thumbnailUrl) engine.state.nowPlayingThumbnailUrl = resolved.thumbnailUrl;
        if (resolved.channel) engine.state.nowPlayingChannel = resolved.channel;
        engine.state.nowPlayingIsLive = resolved.isLive;
      },
      markItemResolved(itemId, normalizedUrl) {
        engine.repo.markItemResolved(itemId, normalizedUrl);
      },
      rememberResolved(resolved) {
        engine.recentResolvedByUrl.set(resolved.sourceUrl, resolved);
      },
      consumeSeek(defaultSeconds) {
        return engine.consumePendingSeek(defaultSeconds);
      },
      setPlaybackOffset(seconds) {
        engine.setPlaybackOffset(seconds);
      },
      getPrefetchedAudio(itemId) {
        return engine.prefetchedAudio.get(itemId) ?? null;
      },
      prefetchAudio() {
        // Prefetch is engine-side async; the sync runner just proceeds to URL.
      },
      usesDirectFfmpeg() {
        return false; // Node clean start: yt-dlp resolution provides URLs
      },
      registerActiveProcess() {
        // spawnForSource adapter already registers.
      },
      triggerPrefetchUpcoming() {},
      notifyStateChanged() {
        engine.notifyStateChanged();
      },
      startTransitionSilence() {
        const silence = engine.spawnSilenceOrNull();
        if (!silence) return null;
        let alive = true;
        void (async () => {
          try {
            while (alive && engine.running) {
              const chunk = await engine.readChunk(silence);
              if (!chunk || chunk.length === 0) break;
              engine.segmenter.write(chunk);
            }
          } catch (error) {
            console.error("[transition-silence] loop failed", error);
          }
        })();
        return {
          stop: () => {
            alive = false;
            engine.killProcess(silence);
          },
        };
      },
      stopTransitionSilence(handle) {
        handle.stop();
      },
      onFirstChunk() {},
      writeChunk(chunk) {
        engine.segmenter.write(chunk);
      },
      checkInterrupt() {
        if (!engine.running) return "stop";
        return engine.interruptRequested;
      },
      consumeInterruptReason() {
        return engine.consumeInterrupt();
      },
    };
  }


  /** One playback attempt, native async (clock-injected, interrupt-aware). */
  private async runAttempt(
    itemLike: { id: number; sourceUrl: string; durationSeconds: number | null },
    attempt: number,
    defaultSeek: number,
  ): Promise<{ outcome: string; reason: string | null; chunksSent: number; bytesSent: number; elapsedSeconds: number; expectedSeconds: number; seekSeconds: number }> {
    const silenceHandle = this.attemptHooks.startTransitionSilence();
    const startedAt = this.clock();
    try {
      const resolved = await this.ensureResolved(itemLike.id, itemLike.sourceUrl, attempt > 1);
      const probe = await this.ffmpeg.probeSource(resolved.streamUrl).catch(() => null);
      const probedDuration = probe?.durationSeconds ?? null;

      this.repo.markItemResolved(itemLike.id, resolved.normalizedUrl);
      this.attemptHooks.onResolvedMetadata(resolved);

      const seekSeconds = this.consumePendingSeek(defaultSeek);
      this.setPlaybackOffset(seekSeconds);

      const process = this.ffmpeg.spawnForSource(resolved.streamUrl, seekSeconds);
      this.activeProcess = process;
      this.notifyStateChanged();
      process.process.stderr?.on("data", (d: Buffer) => console.error("[ffmpeg-decode]", d.toString().trim()));

      let chunksSent = 0;
      let bytesSent = 0;
      let firstChunk = true;
      const chunkSize = this.chunkSize;
      const stdout = process.stdout;

      // Event-driven chunk queue: producer (data events) runs on the event
      // loop; consumer awaits the queue. Proven path from the E2E smoke.
      const pending: Buffer[] = [];
      let finished = false;
      let wake: (() => void) | null = null;
      const onData = (data: Buffer) => {
        pending.push(data);
        wake?.();
      };
      const onEnd = () => {
        finished = true;
        wake?.();
      };
      stdout.on("data", onData);
      stdout.on("end", onEnd);

      const interruptCheck = async (): Promise<void> => {
        if (!this.running) throw new InterruptedError("stop");
        if (this.interruptRequested) {
          throw new InterruptedError(this.consumeInterrupt());
        }
      };

      try {
        for (;;) {
          await interruptCheck();
          if (pending.length === 0) {
            if (finished) break;
            await new Promise<void>((resolveWait) => {
              wake = resolveWait;
            });
            wake = null;
            continue;
          }
          const buffer = pending.shift()!;
          if (buffer.length === 0) continue;
          if (chunksSent === 0) {
            if (silenceHandle) this.attemptHooks.stopTransitionSilence(silenceHandle);
          }
          this.segmenter.write(buffer);
          chunksSent += 1;
          bytesSent += buffer.length;
          void firstChunk;
          void chunkSize;
        }
      } finally {
        stdout.off("data", onData);
        stdout.off("end", onEnd);
      }

      if (this.interruptRequested) throw new InterruptedError(this.consumeInterrupt());

      const returnCode = await process.returnCode();
      const stderrText = process.stderrBuffer();
      const elapsed = Math.max(0, this.clock() - startedAt);
      const expected = expectedDurationOf(probedDuration, resolved.durationSeconds, itemLike.durationSeconds);
      const verdict = classifyAttemptOf(returnCode, elapsed, expected, stderrText);
      return {
        outcome: verdict.outcome,
        reason: verdict.reason,
        chunksSent,
        bytesSent,
        elapsedSeconds: elapsed,
        expectedSeconds: expected,
        seekSeconds,
      };
    } finally {
      if (silenceHandle) this.attemptHooks.stopTransitionSilence(silenceHandle);
      this.killActiveProcess();
    }
  }

  // ------------------------------------------------------ test entry points
  // Thin public wrappers so control-flow tests can drive one item without
  // starting the background loop (parity with the Python tests' _play_item).

  /** @internal test hook */
  async playItemForTest(itemId: number): Promise<void> {
    // Tests drive one item without the background loop; keep the loop-guard
    // satisfied for the duration of the call.
    const wasRunning = this.running;
    this.running = true;
    try {
      await this.ensureResolved(itemId, this.repo.getItem(itemId)?.sourceUrl ?? "");
      await this.playItem(itemId);
    } finally {
      this.running = wasRunning;
    }
  }

  /** @internal test hook */
  seekInit(seconds: number): void {
    this.pendingSeekSeconds = seconds;
  }

  /** @internal test hook */
  get userStoppedForTest(): boolean {
    return this.userStopped;
  }

  /** @internal test hook */
  set userStoppedForTest(value: boolean) {
    this.userStopped = value;
  }

  /** @internal test hook */
  clockNow(): number {
    return this.clock();
  }

  /** @internal test hook */
  hooksForTest(): { writeChunk: (chunk: Buffer) => void } {
    return this.attemptHooks;
  }

  /** Pre-seed the resolved-track cache so the sync runner can consume it. */
  async ensureResolved(itemId: number, sourceUrl: string, forceRefresh = false): Promise<ResolvedTrackLike> {
    const cached = this.resolvedTrackCache.get(itemId);
    if (cached && !forceRefresh) return cached.resolved;
    const resolved = await this.trackSource.resolveVideo(sourceUrl, forceRefresh);
    this.resolvedTrackCache.set(itemId, { resolved });
    this.recentResolvedByUrl.set(resolved.sourceUrl, resolved);
    return resolved;
  }
}

function expectedDurationOf(probed: number | null, resolved: number | null, queued: number | null): number {
  for (const value of [probed, resolved, queued]) {
    if (value && value > 0) return value;
  }
  return 0;
}

function classifyAttemptOf(
  returnCode: number | null,
  elapsed: number,
  expected: number,
  stderrText: string,
): { outcome: string; reason: string | null } {
  if (returnCode !== null && returnCode !== 0) {
    return { outcome: ATTEMPT_RETRY_FFMPEG, reason: `ffmpeg exited with status ${returnCode}` };
  }
  if (expected > 30 && elapsed < expected * 0.9 && stderrIndicatesStreamFailure(stderrText)) {
    return { outcome: "premature_end", reason: "upstream stream ended early after transport failure" };
  }
  return { outcome: ATTEMPT_COMPLETED, reason: null };
}
