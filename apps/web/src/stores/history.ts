import { defineStore } from "pinia";
import { ref } from "vue";

import { deleteJson, fetchJson } from "../lib/api/http";
import type { HistoryRow } from "../types/api";
import { useNotificationsStore } from "./notifications";

export const useHistoryStore = defineStore("history", () => {
  const notifications = useNotificationsStore();

  const history = ref<HistoryRow[]>([]);

  async function refreshHistory(): Promise<void> {
    history.value = await fetchJson<HistoryRow[]>("/api/history");
  }

  /** Used by the WS snapshot / refreshCore paths. */
  function setHistory(rows: HistoryRow[]): void {
    history.value = rows;
  }

  async function clearHistory(): Promise<void> {
    try {
      await deleteJson("/api/history");
      notifications.notifySuccess("History cleared", "Playback history removed.");
    } catch (error) {
      notifications.notifyError("Could not clear history", error);
    }
  }

  return {
    history,
    refreshHistory,
    setHistory,
    clearHistory,
  };
});
