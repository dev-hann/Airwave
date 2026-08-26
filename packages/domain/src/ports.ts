/**
 * Ports: capabilities the playback domain/usecases require from adapters.
 * Ported from app/domain/ports.py — structural typing, adapters satisfy
 * these interfaces implicitly.
 */

import type { RepeatModeValue } from "./playback-state.ts";

export interface ResolvedTrackLike {
  sourceUrl: string;
  normalizedUrl: string;
  title: string | null;
  channel: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  streamUrl: string;
  isLive: boolean;
}

/** yt-dlp adapter surface used by playback. */
export interface TrackSource {
  resolveVideo(url: string, forceRefresh?: boolean): Promise<ResolvedTrackLike> | ResolvedTrackLike;
  spawnAudioDownload(url: string, outputPath: string): unknown;
}

/** ffmpeg adapter surface used by playback. */
export interface Transcoder {
  spawnForSource(sourceUrl: string, startAtSeconds?: number): unknown;
  spawnSilence(): unknown;
  probeSource(sourceUrl: string): Promise<Record<string, string | number | null>> | Record<string, string | number | null>;
}

/** HLS segmenter surface: where encoded audio bytes go. */
export interface StreamSink {
  write(data: Buffer | string): void;
  purge(): void;
  close(): void;
}

export type QueueStatusValue = "queued" | "playing" | "completed" | "skipped" | "failed";

/** Repository surface the playback session depends on (subset). */
export interface PlaybackStore {
  markPlaybackFinished(itemId: number, status: QueueStatusValue, errorMessage?: string | null): unknown;
  enqueueItems(items: Array<Record<string, unknown>>): unknown;
  moveItemToFront(itemId: number): unknown;
}

/** Monotonic time source. */
export type Clock = () => number;
/** Blocking/flavored sleep; tests inject a no-op. */
export type Sleeper = (seconds: number) => void | Promise<void>;

export type { RepeatModeValue };
