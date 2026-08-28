/** UI store tests — theme persistence, sidebar settings, search/playlist routing. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";

/** Sidebar watchers flush on the pre-render microtask queue. */
const flushWatchers = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

import {
  HISTORY_TAB,
  MOBILE_VIEW_HOME,
  MOBILE_VIEW_QUEUE,
  QUEUE_TAB,
  THEME_DARK,
  THEME_NIGHT,
  useUiStore,
} from "./ui";

interface RouteOverrides {
  path?: string;
  query?: Record<string, unknown>;
  params?: Record<string, string | string[]>;
}

function makeRoute(overrides: RouteOverrides = {}): RouteLocationNormalizedLoaded {
  return { path: "/", query: {}, params: {}, ...overrides } as unknown as RouteLocationNormalizedLoaded;
}

function makeRouter(): Router {
  return { push: vi.fn().mockResolvedValue(undefined) } as unknown as Router;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

// initialize() runs once per module load (guarded by the `initialized` flag),
// so these tests must stay in the FIRST describe block that calls it.
describe("ui store — initialize()", () => {
  it("applies stored theme/sidebar, seeds route state, persists watcher changes", async () => {
    window.localStorage.setItem("airwave:settings:theme", "night");
    window.localStorage.setItem("airwave:settings:sidebar-tab", "history");
    const route = makeRoute({ path: "/search", query: { q: "hello" } });
    const store = useUiStore();

    store.initialize(route);

    expect(store.currentTheme).toBe(THEME_NIGHT);
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
    expect(store.activeQueueTab).toBe(HISTORY_TAB);
    // Immediate route watcher seeds the search text.
    expect(store.searchText).toBe("hello");

    // Watchers persist sidebar changes (first — and only — initialize call
    // in this module instance is what registers them).
    store.activeQueueTab = "queue";
    await flushWatchers();
    expect(window.localStorage.getItem("airwave:settings:sidebar-tab")).toBe("queue");
    // SidebarView is a constant literal type ("queue") — its watcher is
    // currently dead code; nothing else can be persisted through it.
    expect(store.sidebarView).toBe("queue");
  });

  it("a second initialize() call is a no-op (theme storage changes ignored)", () => {
    const store = useUiStore();
    store.initialize(makeRoute());
    store.setTheme(THEME_NIGHT);

    window.localStorage.setItem("airwave:settings:theme", THEME_DARK);
    store.initialize(makeRoute());

    expect(store.currentTheme).toBe(THEME_NIGHT);
  });

  it("playlist route seeding needs a fresh module (see final describe)", () => {
    // initialize() already ran in the first test of this file; the module
    // guard means the immediate playlist watcher cannot re-run here.
    const store = useUiStore();
    store.initialize(makeRoute({ path: "/playlist/42", params: { id: "42" } }));
    expect(store.activePlaylistId).toBeNull();
  });
});

describe("ui store — route seeding (fresh module, runs last)", () => {
  it("playlist route seeds activePlaylistId", async () => {
    vi.resetModules();
    const { useUiStore: freshUseUiStore } = await import("./ui");
    const store = freshUseUiStore();
    store.initialize(makeRoute({ path: "/playlist/42", params: { id: "42" } }));
    expect(store.activePlaylistId).toBe("42");
  });

  it("array route params use the first element", async () => {
    vi.resetModules();
    const { useUiStore: freshUseUiStore } = await import("./ui");
    const store = freshUseUiStore();
    store.initialize(makeRoute({ path: "/playlist/7", params: { id: ["7", "8"] } }));
    expect(store.activePlaylistId).toBe("7");
  });
});

describe("ui store — theme", () => {
  it("defaults to dark and writes the default when nothing is stored", () => {
    const store = useUiStore();
    store.initializeTheme();
    expect(store.currentTheme).toBe(THEME_DARK);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("airwave:settings:theme")).toBe("dark");
  });

  it("restores a stored valid theme without rewriting it", () => {
    window.localStorage.setItem("airwave:settings:theme", "night");
    const store = useUiStore();
    store.initializeTheme();
    expect(store.currentTheme).toBe(THEME_NIGHT);
    expect(window.localStorage.getItem("airwave:settings:theme")).toBe("night");
  });

  it("falls back to dark on a garbage stored value (and keeps the garbage on disk)", () => {
    window.localStorage.setItem("airwave:settings:theme", "solarized");
    const store = useUiStore();
    store.initializeTheme();
    expect(store.currentTheme).toBe(THEME_DARK);
    expect(window.localStorage.getItem("airwave:settings:theme")).toBe("solarized");
  });

  it("setTheme applies + persists valid themes", () => {
    const store = useUiStore();
    store.setTheme(THEME_NIGHT);
    expect(store.currentTheme).toBe(THEME_NIGHT);
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
    expect(window.localStorage.getItem("airwave:settings:theme")).toBe("night");
  });

  it("setTheme ignores unsupported values", () => {
    const store = useUiStore();
    store.setTheme(THEME_NIGHT);
    store.setTheme("light" as never);
    expect(store.currentTheme).toBe(THEME_NIGHT);
    expect(window.localStorage.getItem("airwave:settings:theme")).toBe("night");
  });
});

describe("ui store — stored sidebar settings (fresh module; only reachable via initialize)", () => {
  it("applies valid stored tab; ignores garbage view", async () => {
    vi.resetModules();
    window.localStorage.setItem("airwave:settings:sidebar-tab", "history");
    window.localStorage.setItem("airwave:settings:sidebar-view", "explorer");
    const { useUiStore: freshUseUiStore } = await import("./ui");
    const store = freshUseUiStore();
    store.initialize(makeRoute());
    expect(store.activeQueueTab).toBe(HISTORY_TAB);
    expect(store.sidebarView).toBe("queue");
  });

  it("ignores unknown stored tab value", async () => {
    vi.resetModules();
    window.localStorage.setItem("airwave:settings:sidebar-tab", "bogus");
    const { useUiStore: freshUseUiStore } = await import("./ui");
    const store = freshUseUiStore();
    store.initialize(makeRoute());
    expect(store.activeQueueTab).toBe(QUEUE_TAB);
  });
});

describe("ui store — search", () => {
  it("onSearchTextChange sets the text", () => {
    const store = useUiStore();
    store.onSearchTextChange("abc");
    expect(store.searchText).toBe("abc");
  });

  it("onSearchSubmit pushes /search with the trimmed query", async () => {
    const store = useUiStore();
    const router = makeRouter();
    await store.onSearchSubmit(router, makeRoute({ path: "/" }), "  tool  ");
    expect(router.push).toHaveBeenCalledWith({ path: "/search", query: { q: "tool" } });
  });

  it("onSearchSubmit with empty query on /search resets to bare /search", async () => {
    const store = useUiStore();
    const router = makeRouter();
    await store.onSearchSubmit(router, makeRoute({ path: "/search" }), "   ");
    expect(router.push).toHaveBeenCalledWith({ path: "/search" });
  });

  it("onSearchSubmit with empty query elsewhere does not navigate", async () => {
    const store = useUiStore();
    const router = makeRouter();
    await store.onSearchSubmit(router, makeRoute({ path: "/playlists" }), "");
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("ui store — playlist selection", () => {
  it("selectPlaylist navigates to the playlist and resets mobileView", async () => {
    const store = useUiStore();
    store.mobileView = MOBILE_VIEW_QUEUE;
    const router = makeRouter();
    await store.selectPlaylist(router, "42");
    expect(store.activePlaylistId).toBe("42");
    expect(store.mobileView).toBe(MOBILE_VIEW_HOME);
    expect(router.push).toHaveBeenCalledWith({ path: "/playlist/42" });
  });

  it("selectPlaylist(null) navigates home", async () => {
    const store = useUiStore();
    const router = makeRouter();
    await store.selectPlaylist(router, null);
    expect(store.activePlaylistId).toBeNull();
    expect(router.push).toHaveBeenCalledWith({ path: "/" });
  });

  it("selectPlaylist swallows navigation errors (repeat clicks)", async () => {
    const store = useUiStore();
    const router = { push: vi.fn().mockRejectedValue(new Error("dup")) } as unknown as Router;
    await expect(store.selectPlaylist(router, "42")).resolves.toBeUndefined();
  });
});
