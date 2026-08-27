/**
 * State synchronization: WS messages → stores (single merge funnel).
 *
 * The server is the SOLE authority: every mutation reflects through a WS
 * push under the shared envelope. This module applies present keys only —
 * a partial push (e.g. playlists-only) leaves the other stores untouched.
 * Stale-message dropping happens in ws.ts (timestamp guard).
 */

import { onStateMessage } from "./ws";
import { useHistoryStore } from "../../stores/history";
import { usePlaybackStore } from "../../stores/playback";
import { usePlaylistsStore } from "../../stores/playlists";
import { useQueueStore } from "../../stores/queue";
import type { HistoryRow, Playlist, QueueItem } from "../../types/api";
import type { WsMessagePayload } from "@airwave/shared/contracts";

let unsubscribe: (() => void) | null = null;

export function applyStateMessage(message: WsMessagePayload): void {
  if (!message || typeof message !== "object") return;
  const { data } = message;
  const queueStore = useQueueStore();
  const historyStore = useHistoryStore();
  const playlistsStore = usePlaylistsStore();
  const playbackStore = usePlaybackStore();

  if (Array.isArray(data.queue)) queueStore.queue = data.queue as QueueItem[];
  if (Array.isArray(data.history)) historyStore.history = data.history as HistoryRow[];
  if (Array.isArray(data.playlists)) playlistsStore.playlists = data.playlists as unknown as Playlist[];
  if (data.state && typeof data.state === "object") {
    playbackStore.applyPlaybackState(data.state);
  }
}

/** Subscribe to WS state messages (idempotent). Requires active Pinia. */
export function initializeSync(): void {
  if (unsubscribe) return;
  unsubscribe = onStateMessage(applyStateMessage);
}

/**
 * Startup data load: subscribe to the WS funnel and fetch the playback
 * state once. The remaining domains arrive in the server's connect
 * snapshot (it sends a FULL snapshot to every client on connect —
 * reconnect included), which the funnel applies exactly like any push.
 */
export async function initializeLibraryData(): Promise<void> {
  initializeSync();
  const playbackStore = usePlaybackStore();
  await playbackStore.initializePlayback();
}
