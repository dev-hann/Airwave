import { defineStore } from "pinia";

import { formatErrorMessage } from "../utils/errors";

interface ToastItem {
  title: string;
  description?: string;
  color: string;
  icon: string;
  type: "foreground" | "background";
}

interface ToastApi {
  // Method syntax: bivariant, so @nuxt/ui's useToast() return structurally fits.
  add(item: ToastItem): unknown;
}

/**
 * Toast notifications. The toast API instance comes from `useToast()` in
 * `App.vue` (setup order: initializeNotifications before any notify call).
 */
export const useNotificationsStore = defineStore("notifications", {
  state: () => ({
    toast: null as ToastApi | null,
  }),
  actions: {
    initialize(toast: ToastApi) {
      this.toast = toast;
    },
    notifySuccess(title: string, description?: string) {
      this.toast?.add({
        title,
        description,
        color: "success",
        icon: "i-bi-check-lg",
        type: "foreground",
      });
    },
    notifyError(title: string, error: unknown) {
      this.toast?.add({
        title,
        description: formatErrorMessage(error),
        color: "error",
        icon: "i-bi-exclamation-triangle-fill",
        type: "foreground",
      });
    },
  },
});
