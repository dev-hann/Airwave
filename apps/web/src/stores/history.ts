import { defineStore, storeToRefs } from "pinia";
import { ref, watch } from "vue";

import { fetchJson, postJson } from "../lib/api/http";
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
    // Server-authoritative: the history push arrives via WS. The route is
    // POST /api/history/clear (the old DELETE /api/history call 404'd —
    // latent bug fixed here).
    try {
      await postJson("/api/history/clear");
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

/**
 * Derived failure notifications (replaces a dedicated server "notice"
 * message kind): watch the history rows the WS pushes and toast each
 * `failed` track once per session. Rows already present at store
 * initialization are marked seen so reconnects/boot never replay old
 * failures.
 */
export function useFailureNotifications(): void {
  const historyStore = useHistoryStore();
  const notifications = useNotificationsStore();
  const { history } = storeToRefs(historyStore);
  const seenFailedIds = new Set<number>();
  let initialized = false;

  watch(
    history,
    (rows) => {
      for (const row of rows) {
        if (row.status !== "failed") continue;
        if (!initialized || seenFailedIds.has(row.id)) continue;
        seenFailedIds.add(row.id);
        notifications.notifyError(
          "Track failed",
          new Error(row.error_message || row.title || "Playback failed"),
        );
      }
      // Mark current rows as seen AFTER the first pass so boot history is
      // not replayed; rows arriving later fire the toast above.
      if (!initialized && rows.length > 0) {
        for (const row of rows) {
          if (row.status === "failed") seenFailedIds.add(row.id);
        }
        initialized = true;
      }
    },
    { immediate: true, deep: true },
  );
}
