import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";

const SIDEBAR_VIEW_STORAGE_KEY = "airwave:settings:sidebar-view";
const SIDEBAR_TAB_STORAGE_KEY = "airwave:settings:sidebar-tab";
const THEME_STORAGE_KEY = "airwave:settings:theme";

export const SIDEBAR_QUEUE_VIEW = "queue";
export const QUEUE_TAB = "queue";
export const HISTORY_TAB = "history";
export const MOBILE_VIEW_HOME = "home";
export const MOBILE_VIEW_PLAYLISTS = "playlists";
export const MOBILE_VIEW_QUEUE = "queue";

export type SidebarView = typeof SIDEBAR_QUEUE_VIEW;
export type QueueSidebarTab = typeof QUEUE_TAB | typeof HISTORY_TAB;
export type MobileView = typeof MOBILE_VIEW_HOME | typeof MOBILE_VIEW_PLAYLISTS | typeof MOBILE_VIEW_QUEUE;

export const THEME_DARK = "dark";
export const THEME_NIGHT = "night";
export type ThemeName = typeof THEME_DARK | typeof THEME_NIGHT;

export const queueSidebarTabs: Array<{ label: string; icon: string; slot: string; value: QueueSidebarTab }> = [
  { label: "Queue", icon: "i-bi-music-note-list", slot: "queue", value: QUEUE_TAB },
  { label: "History", icon: "i-bi-clock-history", slot: "history", value: HISTORY_TAB },
];

const supportedThemes: ThemeName[] = [THEME_DARK, THEME_NIGHT];
export { supportedThemes };

function readStoredSetting(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredSetting(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage write failures and keep in-memory state.
  }
}

function applyThemeToDom(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return (value[0] as string | undefined) || "";
  return typeof value === "string" ? value : "";
}

let initialized = false;

export const useUiStore = defineStore("ui", () => {
  const sidebarView = ref<SidebarView>(SIDEBAR_QUEUE_VIEW);
  const activeQueueTab = ref<QueueSidebarTab>(QUEUE_TAB);
  const searchText = ref("");
  const activePlaylistId = ref<string | null>(null);
  const rightSidebarOpen = ref(false);
  /** Mobile only: which pane is shown in the main content area. */
  const mobileView = ref<MobileView>(MOBILE_VIEW_HOME);
  const currentTheme = ref<ThemeName>(THEME_DARK);

  function applyStoredSidebarSettings(): void {
    const storedView = readStoredSetting(SIDEBAR_VIEW_STORAGE_KEY);
    const storedTab = readStoredSetting(SIDEBAR_TAB_STORAGE_KEY);
    if (storedView === SIDEBAR_QUEUE_VIEW) {
      sidebarView.value = storedView;
    }
    if (storedTab === QUEUE_TAB || storedTab === HISTORY_TAB) {
      activeQueueTab.value = storedTab;
    }
  }

  function initializeTheme(): void {
    const storedTheme = readStoredSetting(THEME_STORAGE_KEY);
    const theme = supportedThemes.includes(storedTheme as ThemeName) ? (storedTheme as ThemeName) : THEME_DARK;
    currentTheme.value = theme;
    applyThemeToDom(theme);
    if (!storedTheme) {
      writeStoredSetting(THEME_STORAGE_KEY, THEME_DARK);
    }
  }

  function setTheme(theme: ThemeName): void {
    if (!supportedThemes.includes(theme)) return;
    currentTheme.value = theme;
    applyThemeToDom(theme);
    writeStoredSetting(THEME_STORAGE_KEY, theme);
  }

  function onSearchTextChange(value: string): void {
    searchText.value = value;
  }

  async function onSearchSubmit(router: Router, route: RouteLocationNormalizedLoaded, query: string): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      if (route.path === "/search") {
        await router.push({ path: "/search" });
      }
      return;
    }
    await router.push({ path: "/search", query: { q: trimmed } });
  }

  async function selectPlaylist(router: Router, playlistId: string | null): Promise<void> {
    activePlaylistId.value = playlistId;
    // Mobile main area only renders RouterView in the home pane; playlist detail lives in RouterView.
    mobileView.value = MOBILE_VIEW_HOME;
    try {
      const path = playlistId ? `/playlist/${playlistId}` : "/";
      await router.push({ path });
    } catch {
      // Ignore navigation errors for repeated clicks on the same route.
    }
  }

  /** One-time wiring: persisted settings + route watchers. Call in App setup. */
  function initialize(route: RouteLocationNormalizedLoaded): void {
    if (initialized) return;
    initialized = true;

    initializeTheme();
    applyStoredSidebarSettings();

    watch(sidebarView, (value) => {
      writeStoredSetting(SIDEBAR_VIEW_STORAGE_KEY, value);
    });

    watch(activeQueueTab, (value) => {
      writeStoredSetting(SIDEBAR_TAB_STORAGE_KEY, value);
    });

    watch(
      () => [route.path, route.query.q] as const,
      ([path, query]) => {
        if (path !== "/search") return;
        searchText.value = firstQueryValue(query);
      },
      { immediate: true },
    );

    watch(
      () => [route.path, route.params.id] as const,
      ([path, playlistId]) => {
        if (!path.startsWith("/playlist/")) {
          activePlaylistId.value = null;
          return;
        }
        activePlaylistId.value = Array.isArray(playlistId) ? playlistId[0] || null : playlistId || null;
      },
      { immediate: true },
    );
  }

  return {
    sidebarView,
    activeQueueTab,
    searchText,
    activePlaylistId,
    rightSidebarOpen,
    mobileView,
    currentTheme,
    queueSidebarTabs,
    initialize,
    initializeTheme,
    setTheme,
    onSearchTextChange,
    onSearchSubmit,
    selectPlaylist,
  };
});
