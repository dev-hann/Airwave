/**
 * Playback progress math. Ported from app/domain/progress.py.
 * Pure function of (state, now) — callers inject the clock.
 */

import type { PlaybackModeValue, PlaybackState } from "./playback-state.js";
import { PLAYBACK_MODE_PLAYING } from "./playback-state.js";

export interface PlaybackProgress {
  durationSeconds: number | null;
  startedAt: number | null;
  elapsedSeconds: number | null;
  progressPercent: number | null;
}

export function playbackProgress(state: PlaybackState, nowMonotonic: number): PlaybackProgress {
  if (state.mode !== PLAYBACK_MODE_PLAYING) {
    return {
      durationSeconds: state.nowPlayingDurationSeconds,
      startedAt: state.startedAtEpochSeconds,
      elapsedSeconds: null,
      progressPercent: null,
    };
  }

  const duration = state.nowPlayingDurationSeconds;
  let elapsedSeconds: number | null;
  if (state.paused && state.pausedElapsedSeconds !== null) {
    elapsedSeconds = state.pausedElapsedSeconds;
  } else if (state.startedAtMonotonicSeconds !== null) {
    elapsedSeconds = Math.max(0, nowMonotonic - state.startedAtMonotonicSeconds);
  } else {
    elapsedSeconds = null;
  }

  let progressPercent: number | null = null;
  if (elapsedSeconds !== null && duration && duration > 0) {
    progressPercent = Math.min(100, (elapsedSeconds / duration) * 100);
  }
  return {
    durationSeconds: duration,
    startedAt: state.startedAtEpochSeconds,
    elapsedSeconds,
    progressPercent,
  };
}

export type { PlaybackModeValue };
