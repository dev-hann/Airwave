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

  async function addUrl(url: string): Promise<void> {
    try {
      const result = await postJson<QueueMutationResult>("/api/queue/add", { url });
      if (result?.type === "playlist") {
        notifications.notifySuccess("Playlist queued", `${result.count || 0} playlist items added to queue.`);
      } else {
        notifications.notifySuccess("Added to queue", "URL added successfully.");
      }
    } catch (error) {
      notifications.notifyError("Could not add URL", error);
    }
  }

  async function removeFromQueue(itemId: number | string): Promise<void> {
    try {
      await deleteJson(`/api/queue/${itemId}`);
      notifications.notifySuccess("Removed from queue", "Item removed from queue.");
    } catch (error) {
      notifications.notifyError("Could not remove from queue", error);
    }
  }

  async function playUrl(url: string): Promise<void> {
    try {
      const result = await postJson<QueueMutationResult>("/api/queue/play-now", { url });
      if (result?.type === "playlist") {
        notifications.notifySuccess("Playing playlist", "Queue replaced and playlist playback started.");
      } else {
        notifications.notifySuccess("Playing now", "URL queued and playback started.");
      }
    } catch (error) {
      notifications.notifyError("Could not play URL", error);
    }
  }

  async function clearQueue(): Promise<void> {
    try {
      await deleteJson("/api/queue");
      notifications.notifySuccess("Queue cleared", "Queued tracks removed.");
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
