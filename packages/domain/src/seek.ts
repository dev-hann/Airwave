/** Seek-position math. Ported from app/domain/seek.py. */

export function secondsFromPercent(percent: number, durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  const clamped = Math.min(100, Math.max(0, percent));
  return (clamped / 100) * durationSeconds;
}

export function clampSeekSeconds(seconds: number, durationSeconds: number | null): number {
  let value = Math.max(0, seconds);
  if (durationSeconds && durationSeconds > 0) {
    value = Math.min(value, durationSeconds);
  }
  return value;
}
