/**
 * Repeat-cycle bookkeeping. Ported from app/domain/repeat_cycle.py.
 *
 * Track identity shape used when re-enqueueing items (repeat-one re-enqueue,
 * user-stop requeue, repeat-all replay). Structurally compatible with queue
 * rows and playlist entries returned by the stores.
 */

export interface TrackIdentity {
  sourceUrl: string;
  provider: string | null;
  providerItemId: string | null;
  normalizedUrl: string;
  sourceType: string;
  title: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  playlistId?: string | null;
}

export interface RepeatCycleItem extends TrackIdentity {
  playlistId: string | null;
}

export function repeatCycleItemFrom(item: TrackIdentity): RepeatCycleItem {
  return {
    sourceUrl: item.sourceUrl,
    provider: item.provider,
    providerItemId: item.providerItemId,
    normalizedUrl: item.normalizedUrl,
    sourceType: item.sourceType,
    title: item.title,
    durationSeconds: item.durationSeconds,
    thumbnailUrl: item.thumbnailUrl,
    playlistId: item.playlistId ?? null,
  };
}

/** Insert-fields for the queue from a stored cycle item. */
export function newQueueItemFields(cycleItem: RepeatCycleItem): TrackIdentity & { playlistId: string | null } {
  return {
    sourceUrl: cycleItem.sourceUrl,
    provider: cycleItem.provider,
    providerItemId: cycleItem.providerItemId,
    normalizedUrl: cycleItem.normalizedUrl,
    sourceType: cycleItem.sourceType,
    title: cycleItem.title,
    durationSeconds: cycleItem.durationSeconds,
    thumbnailUrl: cycleItem.thumbnailUrl,
    playlistId: cycleItem.playlistId,
  };
}

/** Enqueue fields from a history/queue row, coalescing missing source URL. */
export function replayItemFields(item: TrackIdentity): TrackIdentity & { playlistId: string | null } {
  const fields = newQueueItemFields(repeatCycleItemFrom(item));
  if (!fields.sourceUrl) fields.sourceUrl = "unknown";
  return fields;
}
