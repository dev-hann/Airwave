/**
 * Play one track: resolve → probe → spawn → stream chunks → classify.
 * Ported from app/usecases/play_track.py (TrackAttemptRunner).
 *
 * The runner owns ONE attempt and reports a TrackAttemptResult; the engine
 * keeps retry policy, interrupt dispatch, and state mutation behind the
 * AttemptHooks interface. All time access flows through the injected clock.
 */

import {
  ATTEMPT_COMPLETED,
  ATTEMPT_RETRY_FFMPEG,
  ATTEMPT_RETRY_SOURCE,
  classifyAttempt,
  expectedDurationSeconds,
  slowChunkRead,
} from "@airwave/domain";
import type { AttemptOutcome, ResolvedTrackLike, Transcoder } from "@airwave/domain";

export interface QueueItemLike {
  id: number;
  sourceUrl: string;
  normalizedUrl: string | null;
  durationSeconds: number | null;
  title: string | null;
}

export interface TrackAttemptRequest {
  queueItem: QueueItemLike;
  attempt: number;
  defaultSeekSeconds: number;
}

export interface TrackAttemptResult {
  outcome: AttemptOutcome;
  reason: string | null;
  chunksSent: number;
  bytesSent: number;
  elapsedSeconds: number;
  expectedSeconds: number;
  resolved: ResolvedTrackLike | null;
  seekSeconds: number;
  stderrText: string;
}

/** Engine capabilities the attempt needs. Implemented by the Node engine. */
export interface AttemptHooks {
  resolveTrack(item: QueueItemLike, forceRefresh: boolean): ResolvedTrackLike;
  onResolvedMetadata(resolved: ResolvedTrackLike): void;
  markItemResolved(itemId: number, normalizedUrl: string): void;
  rememberResolved(resolved: ResolvedTrackLike): void;
  consumeSeek(defaultSeconds: number): number;
  setPlaybackOffset(seconds: number): void;
  getPrefetchedAudio(itemId: number): string | null;
  prefetchAudio(itemId: number, sourceUrl: string): void;
  usesDirectFfmpeg(item: QueueItemLike): boolean;
  registerActiveProcess(process: unknown): void;
  triggerPrefetchUpcoming(): void;
  notifyStateChanged(): void;
  startTransitionSilence(): TransitionSilenceHandle | null;
  stopTransitionSilence(handle: TransitionSilenceHandle): void;
  onFirstChunk(): void;
  writeChunk(chunk: Buffer): void;
  /** null = keep going; "stop" ends the engine; other reasons interrupt. */
  checkInterrupt(): string | null;
  consumeInterruptReason(): string;
  /** Optional slow-read telemetry hook (engine logging policy). */
  notifySlowRead?(itemId: number, attempt: number, chunkIndex: number, readSeconds: number, requested: number, received: number): void;
}

export interface TransitionSilenceHandle {
  stop: () => void;
}

interface SilencePair {
  handle: TransitionSilenceHandle | null;
}

export class TrackAttemptRunner {
  private readonly transcoder: Transcoder;
  private readonly clock: () => number;
  private readonly chunkSize: number;
  private inResolvePhase = false;

  constructor(options: { transcoder: Transcoder; clock: () => number; chunkSize: number }) {
    this.transcoder = options.transcoder;
    this.clock = options.clock;
    this.chunkSize = options.chunkSize;
  }

  run(request: TrackAttemptRequest, hooks: AttemptHooks): TrackAttemptResult {
    const item = request.queueItem;
    const silence: SilencePair = { handle: null };
    const startedAt = this.clock();
    try {
      silence.handle = hooks.startTransitionSilence();
      const resolved = this.resolve(request, hooks);
      const probedDuration = this.probeDuration(resolved);
      hooks.markItemResolved(item.id, resolved.normalizedUrl);
      hooks.rememberResolved(resolved);
      hooks.onResolvedMetadata(resolved);
      const seekSeconds = hooks.consumeSeek(request.defaultSeekSeconds);
      hooks.setPlaybackOffset(seekSeconds);

      const process = this.spawn(request, resolved, seekSeconds, hooks);
      hooks.registerActiveProcess(process);
      hooks.triggerPrefetchUpcoming();
      hooks.notifyStateChanged();

      const { chunks, byteCount, stderrText } = this.streamChunks(item.id, request.attempt, process, hooks, () => {
        // First real chunk: stop transition silence, then engine prefetch hook.
        if (silence.handle) {
          const handle = silence.handle;
          silence.handle = null;
          hooks.stopTransitionSilence(handle);
        }
        hooks.onFirstChunk();
      });
      const elapsed = Math.max(0, this.clock() - startedAt);

      const expected = expectedDurationSeconds(probedDuration, resolved.durationSeconds, item.durationSeconds);
      const verdict = classifyAttempt({
        ffmpegReturnCode: this.returnCode(process),
        sourceReturnCode: 0,
        elapsedSeconds: elapsed,
        expectedSeconds: expected,
        stderrText,
      });
      return {
        outcome: verdict.outcome,
        reason: verdict.reason,
        chunksSent: chunks,
        bytesSent: byteCount,
        elapsedSeconds: elapsed,
        expectedSeconds: expected,
        resolved,
        seekSeconds,
        stderrText,
      };
    } catch (error) {
      if (error instanceof InterruptedError) throw error;
      const outcome = this.inResolvePhase ? ATTEMPT_RETRY_SOURCE : ATTEMPT_RETRY_FFMPEG;
      return {
        outcome,
        reason: error instanceof Error ? error.message : String(error),
        chunksSent: 0,
        bytesSent: 0,
        elapsedSeconds: Math.max(0, this.clock() - startedAt),
        expectedSeconds: 0,
        resolved: null,
        seekSeconds: 0,
        stderrText: "",
      };
    } finally {
      if (silence.handle) {
        const handle = silence.handle;
        silence.handle = null;
        hooks.stopTransitionSilence(handle);
      }
    }
  }

  // ---------------------------------------------------------------- phases

  private resolve(request: TrackAttemptRequest, hooks: AttemptHooks): ResolvedTrackLike {
    this.inResolvePhase = true;
    try {
      const resolved = hooks.resolveTrack(request.queueItem, request.attempt > 1);
      this.inResolvePhase = false;
      return resolved;
    } catch (error) {
      // Keep inResolvePhase = true so the outer catch maps this to retry_source.
      throw error;
    }
  }

  private probeDuration(resolved: ResolvedTrackLike): number | null {
    try {
      const probe = this.transcoder.probeSource(resolved.streamUrl) as
        | Record<string, number | string | null>
        | null
        | undefined;
      if (!probe) return null;
      const raw = probe["duration_seconds"] ?? probe["durationSeconds"];
      const value = typeof raw === "number" ? raw : raw !== null && raw !== undefined ? Number(raw) : NaN;
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  private spawn(
    request: TrackAttemptRequest,
    resolved: ResolvedTrackLike,
    seekSeconds: number,
    hooks: AttemptHooks,
  ): unknown {
    const item = request.queueItem;
    let prefetched = hooks.getPrefetchedAudio(item.id);
    if (!prefetched && !resolved.isLive && !hooks.usesDirectFfmpeg(item)) {
      hooks.prefetchAudio(item.id, item.sourceUrl);
      const interrupt = hooks.checkInterrupt();
      if (interrupt !== null) {
        throw new InterruptedError(hooks.consumeInterruptReason());
      }
      prefetched = hooks.getPrefetchedAudio(item.id);
    }
    if (prefetched) {
      return this.transcoder.spawnForSource(prefetched, seekSeconds);
    }
    if (seekSeconds > 0 || resolved.isLive || hooks.usesDirectFfmpeg(item)) {
      return this.transcoder.spawnForSource(resolved.streamUrl, seekSeconds);
    }
    throw new Error("ffmpeg source playback is unavailable");
  }

  private streamChunks(
    itemId: number,
    attempt: number,
    process: unknown,
    hooks: AttemptHooks,
    onFirstChunk: () => void,
  ): { chunks: number; byteCount: number; stderrText: string } {
    let chunks = 0;
    let byteCount = 0;
    for (;;) {
      const interrupt = hooks.checkInterrupt();
      if (interrupt !== null) {
        throw new InterruptedError(interrupt === "stop" ? "stop" : hooks.consumeInterruptReason());
      }
      const readStarted = this.clock();
      const chunk = this.readChunk(process);
      const readSeconds = this.clock() - readStarted;
      if (chunk && slowChunkRead(readSeconds)) {
        // Slow-read warning is engine-side logging policy; surfaced via reason-free path.
        hooks.notifySlowRead?.(itemId, attempt, chunks, readSeconds, this.chunkSize, chunk.length);
      }
      if (!chunk || chunk.length === 0) {
        return { chunks, byteCount, stderrText: this.stderrText(process) };
      }
      if (chunks === 0) onFirstChunk();
      hooks.writeChunk(chunk);
      chunks += 1;
      byteCount += chunk.length;
    }
  }

  // --------------------------------------------------------------- helpers

  private readChunk(process: unknown): Buffer {
    const stdout = (process as { stdout?: { read?: (n: number) => Buffer } } | null)?.stdout;
    if (!stdout || typeof stdout.read !== "function") return Buffer.alloc(0);
    return stdout.read(this.chunkSize) ?? Buffer.alloc(0);
  }

  private stderrText(process: unknown): string {
    const readStderr = (proc: unknown): string => {
      const pipe = (proc as { stderr?: { read?: () => Buffer } } | null)?.stderr;
      if (!pipe || typeof pipe.read !== "function") return "";
      return pipe.read()?.toString("utf-8").trim() ?? "";
    };
    return readStderr(process).trim();
  }

  private returnCode(process: unknown): number | null {
    const proc = process as { poll?: () => number | null; returncode?: number | null } | null;
    if (typeof proc?.poll === "function") {
      const code = proc.poll();
      if (code !== null && code !== undefined) return code;
    }
    return proc?.returncode ?? null;
  }
}

/** Mirrors Python's InterruptedError control-flow contract. */
export class InterruptedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "InterruptedError";
    this.reason = reason;
  }
}

export { ATTEMPT_COMPLETED, ATTEMPT_RETRY_FFMPEG, ATTEMPT_RETRY_SOURCE };
