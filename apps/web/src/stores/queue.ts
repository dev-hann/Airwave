import { defineStore } from "pinia";
import { ref } from "vue";

import { deleteJson, fetchJson, postJson } from "../lib/api/http";
import type { HistoryRow, QueueItem } from "../types/api";
import { useHistoryStore } from "./history";
import { useNotificationsStore } from "./notifications";

interface QueueMutationResult {
  type?: string;
  count?: number;
}

/** Metadata the client already knows — skips the server's resolve round-trip. */
export interface QueueMetaBody {
  title?: string | null;
  channel?: string | null;
  duration_seconds?: number | null;
  thumbnail_url?: string | null;
}

export const useQueueStore = defineStore("queue", () => {
  const notifications = useNotificationsStore();
  const historyStore = useHistoryStore();

  const queue = ref<QueueItem[]>([]);

  async function refreshQueue(): Promise<void> {
    queue.value = await fetchJson<QueueItem[]>("/api/queue");
  }

  /** Queue + history together — a reorder can finish a track into history. */
  async function refreshCore(): Promise<void> {
    const [queueData, historyData] = await Promise.all([
      fetchJson<QueueItem[]>("/api/queue"),
      fetchJson<HistoryRow[]>("/api/history"),
    ]);
    queue.value = queueData;
    historyStore.setHistory(historyData);
  }

  async function addUrl(url: string, meta?: QueueMetaBody): Promise<void> {
    try {
      await postJson<QueueMutationResult>("/api/queue/add", { url, ...meta });
    } catch (error) {
      notifications.notifyError("Could not add URL", error);
    }
  }

  async function removeFromQueue(itemId: number | string): Promise<void> {
    try {
      await deleteJson(`/api/queue/${itemId}`);
    } catch (error) {
      notifications.notifyError("Could not remove from queue", error);
    }
  }

  async function playUrl(url: string, meta?: QueueMetaBody): Promise<void> {
    try {
      await postJson<QueueMutationResult>("/api/queue/play-now", { url, ...meta });
    } catch (error) {
      notifications.notifyError("Could not play URL", error);
    }
  }

  async function clearQueue(): Promise<void> {
    try {
      await deleteJson("/api/queue");
    } catch (error) {
      notifications.notifyError("Could not clear queue", error);
    }
  }

  async function reorderQueueItem(itemId: number | string, newPosition: number): Promise<void> {
    // Server-authoritative: the reorder push (queue + history) arrives via WS.
    try {
      await postJson(`/api/queue/${itemId}/reorder`, { new_position: newPosition });
    } catch (error) {
      notifications.notifyError("Could not reorder queue", error);
    }
  }

  return {
    queue,
    refreshQueue,
    refreshCore,
    addUrl,
    removeFromQueue,
    playUrl,
    clearQueue,
    reorderQueueItem,
  };
});
