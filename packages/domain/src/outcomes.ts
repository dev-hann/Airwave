/**
 * Playback attempt outcome classification. Ported from app/domain/outcomes.py.
 *
 * Pure decision logic: given an attempt's observable facts decide whether it
 * completed, failed hard, or ended early after an upstream transport failure.
 */

export const FAILURE_MARKERS = [
  "input/output error",
  "read error",
  "error in the pull function",
  "session has been invalidated",
  "connection reset",
  "end of file",
] as const;

export function stderrIndicatesStreamFailure(stderrText: string | null | undefined): boolean {
  const normalized = (stderrText ?? "").toLowerCase();
  return FAILURE_MARKERS.some((marker) => normalized.includes(marker));
}

/** First credible duration source wins: ffprobe > source metadata > queue item. */
export function expectedDurationSeconds(
  probed: number | null,
  resolved: number | null,
  queued: number | null,
): number {
  for (const value of [probed, resolved, queued]) {
    if (value && value > 0) return value;
  }
  return 0;
}

/** A track that ran less than 90% of its expected (long) duration ended early. */
export function endedPrematurely(elapsedSeconds: number, expectedSeconds: number): boolean {
  return expectedSeconds > 30 && elapsedSeconds < expectedSeconds * 0.9;
}

/** Suspiciously short run of a long track — worth a warning log. */
export function completedUnusuallyFast(elapsedSeconds: number, expectedSeconds: number): boolean {
  return expectedSeconds > 30 && elapsedSeconds < expectedSeconds * 0.2;
}

export function slowChunkRead(readSeconds: number, thresholdSeconds = 0.3): boolean {
  return readSeconds >= thresholdSeconds;
}

export const ATTEMPT_COMPLETED = "completed" as const;
export const ATTEMPT_RETRY_FFMPEG = "retry_ffmpeg" as const;
export const ATTEMPT_RETRY_SOURCE = "retry_source" as const;
export const ATTEMPT_PREMATURE_END = "premature_end" as const;

export type AttemptOutcome =
  | typeof ATTEMPT_COMPLETED
  | typeof ATTEMPT_RETRY_FFMPEG
  | typeof ATTEMPT_RETRY_SOURCE
  | typeof ATTEMPT_PREMATURE_END;

export interface AttemptFacts {
  ffmpegReturnCode: number | null;
  sourceReturnCode: number | null;
  elapsedSeconds: number;
  expectedSeconds: number;
  stderrText: string;
}

export interface AttemptVerdict {
  outcome: AttemptOutcome;
  reason: string | null;
}

export function classifyAttempt(facts: AttemptFacts): AttemptVerdict {
  if (facts.ffmpegReturnCode !== null && facts.ffmpegReturnCode !== 0) {
    return {
      outcome: ATTEMPT_RETRY_FFMPEG,
      reason: `ffmpeg exited with status ${facts.ffmpegReturnCode}`,
    };
  }
  if (facts.sourceReturnCode !== null && facts.sourceReturnCode !== 0) {
    return {
      outcome: ATTEMPT_RETRY_SOURCE,
      reason: `source exited with status ${facts.sourceReturnCode}`,
    };
  }
  if (
    endedPrematurely(facts.elapsedSeconds, facts.expectedSeconds) &&
    stderrIndicatesStreamFailure(facts.stderrText)
  ) {
    return {
      outcome: ATTEMPT_PREMATURE_END,
      reason: "upstream stream ended early after transport failure",
    };
  }
  return { outcome: ATTEMPT_COMPLETED, reason: null };
}
