/** Shuffle ordering. Ported from app/domain/shuffle_order.py. RNG injected. */

export function shuffledOrder(ids: readonly number[], rng: { shuffle(list: number[]): void }): number[] {
  const order = [...ids];
  rng.shuffle(order);
  return order;
}

/**
 * Canonical order for `current` ids given a saved `restore` snapshot;
 * null when nothing to restore (all saved ids vanished).
 */
export function restoreOrder(
  current: readonly number[],
  restore: readonly number[] | null,
): number[] | null {
  if (!restore || restore.length === 0) return null;
  const known = new Set(current);
  const ordered = restore.filter((id) => known.has(id));
  return ordered.length > 0 ? ordered : null;
}
