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
    // Success toasts removed by decision (v2.3.9): every success now has
    // intrinsic WS-driven feedback (queue row appears, spinner, heart flip)
    // and toasts obstructed the player controls. No-op kept so legacy call
    // sites (confirm-modal callbacks) keep compiling.
    notifySuccess(_title: string, _description?: string) {
      void _title;
      void _description;
    },
    notifyError(title: string, error: unknown) {
      this.toast?.add({
        title,
        description: formatErrorMessage(error),
        color: "error",
        icon: "i-bi-exclamation-triangle-fill",
        // background = auto-dismiss: errors must inform, never camp on the UI.
        type: "background",
      });
    },
  },
});
