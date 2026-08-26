/**
 * Snapshot synchronization: WS snapshots → stores.
 *
 * Replaces the old eventBus hop (`ws:snapshot` → useLibraryState). Snapshots
 * arriving before `initializeSync()` run refresh via REST instead (the
 * initial fetch in `initializeLibraryData` covers them) — same behavior as
 * the legacy bus.
 */

import { onSnapshot } from "./ws";
import { useHistoryStore } from "../../stores/history";
import { usePlaybackStore } from "../../stores/playback";
import { usePlaylistsStore } from "../../stores/playlists";
import { useQueueStore } from "../../stores/queue";
import type { HistoryRow, Playlist, QueueItem, UiSnapshot } from "../../types/api";

let unsubscribe: (() => void) | null = null;

export function applySnapshot(snapshot: UiSnapshot): void {
  if (!snapshot || typeof snapshot !== "object") return;
  const queueStore = useQueueStore();
  const historyStore = useHistoryStore();
  const playlistsStore = usePlaylistsStore();
  const playbackStore = usePlaybackStore();

  if (Array.isArray(snapshot.queue)) queueStore.queue = snapshot.queue as QueueItem[];
  if (Array.isArray(snapshot.history)) historyStore.history = snapshot.history as HistoryRow[];
  if (Array.isArray(snapshot.playlists)) playlistsStore.playlists = snapshot.playlists as unknown as Playlist[];
  if (snapshot.state && typeof snapshot.state === "object") {
    playbackStore.applyPlaybackState(snapshot.state);
  }
}

/** Subscribe to WS snapshots (idempotent). Requires active Pinia. */
export function initializeSync(): void {
  if (unsubscribe) return;
  unsubscribe = onSnapshot(applySnapshot);
}

/**
 * Startup data load: subscribe to snapshots, then REST-refresh the library
 * stores (queue/history/playlists). Mirrors the old `initializeLibraryState`.
 */
export async function initializeLibraryData(): Promise<void> {
  initializeSync();
  const queueStore = useQueueStore();
  const historyStore = useHistoryStore();
  const playlistsStore = usePlaylistsStore();
  await Promise.allSettled([queueStore.refreshQueue(), historyStore.refreshHistory(), playlistsStore.refreshPlaylists()]);
}
