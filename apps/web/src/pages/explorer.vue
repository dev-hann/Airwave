<template>
  <section class="min-h-0 h-full min-w-0 overflow-auto rounded-xl border border-neutral-700 p-4 md:p-6 surface-panel">
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight md:text-3xl">Media Browser</h1>
        <p class="mt-1 text-sm text-muted">
          Browse allowed server folders and queue local files or folders.
        </p>
      </div>
      <label class="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input v-model="includeSubfolders" type="checkbox" class="rounded border-neutral-500">
        <span>Include subfolders</span>
      </label>
    </div>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <UButton
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-bi-house"
        :disabled="!currentDir"
        @click="() => { void showRoots() }"
      >
        Roots
      </UButton>
      <UButton
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-bi-arrow-up"
        :disabled="!canGoUp"
        @click="goUp"
      >
        Up
      </UButton>
      <div v-if="breadcrumbs.length" class="min-w-0 flex-1 overflow-x-auto">
        <nav class="flex min-w-max items-center gap-1 text-sm">
          <template v-for="(crumb, idx) in breadcrumbs" :key="crumb.path">
            <button
              type="button"
              class="rounded px-1.5 py-1 hover:bg-neutral-800"
              @click="openBreadcrumb(crumb.path)"
            >
              {{ crumb.label }}
            </button>
            <span v-if="idx < breadcrumbs.length - 1" class="text-muted">/</span>
          </template>
        </nav>
      </div>
    </div>

    <div v-if="errorMsg" class="mb-3 text-sm text-red-400">
      {{ errorMsg }}
    </div>
    <div v-if="loading" class="text-sm opacity-70">
      Loading…
    </div>
    <div v-else-if="showingRoots && roots.length === 0" class="text-sm opacity-70">
      No media roots configured on the server.
    </div>
    <div v-else>
      <ul class="space-y-2 md:grid md:grid-cols-3 md:gap-3 md:space-y-0 lg:grid-cols-4 xl:grid-cols-5">
        <li v-for="entry in visibleEntries" :key="entry.path" class="min-w-0">
          <ExplorerFolder
            v-if="entry.kind === 'directory'"
            :entry="entry"
            :playlists="localPlaylists"
            :show-path="showingRoots"
            @open="openDirectory(entry.path)"
            @queue="queueFolder(entry.path)"
            @play="playFolder(entry.path)"
            @add-to-playlist="(playlistId) => addFolderToPlaylist(playlistId, entry.path)"
          />
          <ExplorerFile
            v-else
            :entry="entry"
            :playlists="localPlaylists"
            @queue="queueFile(entry.path)"
            @play="playFile(entry.path)"
            @add-to-playlist="(playlistId) => addFileToPlaylist(playlistId, entry.path)"
          />
        </li>
      </ul>
      <div v-if="!visibleEntries.length" class="py-8 text-center text-sm text-muted">
        No files or folders found here.
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useQuery } from "@tanstack/vue-query";

import ExplorerFile from "../components/explorer/ExplorerFile.vue";
import ExplorerFolder from "../components/explorer/ExplorerFolder.vue";
import { useExplorerStore, type LocalMediaEntry, type LocalMediaRoot } from "../stores/explorer";
import { usePlaylistsStore } from "../stores/playlists";

const route = useRoute();
const router = useRouter();

const explorerStore = useExplorerStore();
const playlistsStore = usePlaylistsStore();
const { playlists } = storeToRefs(playlistsStore);
const {
  fetchLocalRoots,
  browseLocalDirectory,
  addLocalPath,
  addLocalFolder,
  playLocalPath,
  playLocalFolder,
} = explorerStore;
const { addLocalPathToPlaylist, addLocalFolderToPlaylist } = playlistsStore;

const currentDir = ref("");
const activeRoot = ref("");
const includeSubfolders = ref(true);

const localPlaylists = computed(() => (playlists.value ?? []).filter((p) => p?.kind !== "remote_youtube"));
const showingRoots = computed(() => !currentDir.value);

const rootsQuery = useQuery({
  queryKey: ["media", "roots"],
  queryFn: () => fetchLocalRoots(),
  staleTime: Infinity,
  gcTime: Infinity,
});

const browseQuery = useQuery({
  queryKey: computed(() => ["media", "browse", currentDir.value] as const),
  queryFn: () => browseLocalDirectory(currentDir.value),
  enabled: computed(() => currentDir.value !== ""),
  staleTime: 30_000,
});

const roots = computed<LocalMediaRoot[]>(() => rootsQuery.data.value?.roots ?? []);
const entries = computed<LocalMediaEntry[]>(() => browseQuery.data.value?.entries ?? []);
const ready = computed(() => rootsQuery.isSuccess.value || rootsQuery.isError.value);
const loading = computed(() =>
  showingRoots.value ? rootsQuery.isPending.value : browseQuery.isPending.value,
);
const errorMsg = computed(() => {
  const rootError = rootsQuery.error.value as { message?: string } | null;
  if (rootError) return rootError.message || "Could not load media roots";
  if (!showingRoots.value) {
    const browseError = browseQuery.error.value as { message?: string } | null;
    if (browseError) return browseError.message || "Browse failed";
  }
  return "";
});
function compareEntries(a: LocalMediaEntry, b: LocalMediaEntry): number {
  const aIsDirectory = a?.kind === "directory";
  const bIsDirectory = b?.kind === "directory";
  if (aIsDirectory !== bIsDirectory) return aIsDirectory ? -1 : 1;
  const aName = (a?.name || "").toString();
  const bName = (b?.name || "").toString();
  return aName.localeCompare(bName, undefined, { sensitivity: "base", numeric: true });
}

const visibleEntries = computed<LocalMediaEntry[]>(() => {
  if (showingRoots.value) {
    return roots.value.map((root) => ({
      kind: "directory" as const,
      path: root.path,
      name: root.name || pathLabel(root.path),
    })).sort(compareEntries);
  }
  return [...entries.value].sort(compareEntries);
});

const canGoUp = computed(() => {
  if (showingRoots.value) return false;
  if (!activeRoot.value || !currentDir.value) return false;
  return currentDir.value !== activeRoot.value;
});

const breadcrumbs = computed(() => {
  if (!currentDir.value || !activeRoot.value) return [];
  const root = roots.value.find((r) => r.path === activeRoot.value);
  const rootLabel = root?.name || pathLabel(activeRoot.value);
  const crumbs = [{ path: activeRoot.value, label: rootLabel }];

  if (currentDir.value === activeRoot.value) return crumbs;

  const normalizedRoot = activeRoot.value.endsWith("/") ? activeRoot.value : `${activeRoot.value}/`;
  const relative = currentDir.value.startsWith(normalizedRoot) ? currentDir.value.slice(normalizedRoot.length) : "";
  if (!relative) return crumbs;

  const segments = relative.split("/").filter(Boolean);
  let currentPath = activeRoot.value;
  for (const segment of segments) {
    currentPath = `${currentPath.replace(/\/+$/, "")}/${segment}`;
    crumbs.push({ path: currentPath, label: segment });
  }
  return crumbs;
});

function pathLabel(path: string): string {
  if (!path) return "/";
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] || "/";
}

function dirParent(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return trimmed;
  return trimmed.slice(0, index) || "/";
}

function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function normalizeQueryPath(value: unknown): string {
  if (Array.isArray(value)) return ((value[0] as string | undefined) || "").trim();
  return typeof value === "string" ? value.trim() : "";
}

async function syncRoutePath(path: string): Promise<void> {
  const normalizedPath = typeof path === "string" ? path.trim() : "";
  const nextQuery = { ...route.query };
  if (normalizedPath) {
    nextQuery.path = normalizedPath;
  } else {
    delete nextQuery.path;
  }
  await router.replace({ query: nextQuery });
}

async function openDirectory(path: string, options: { updateRoute?: boolean } = {}): Promise<void> {
  const { updateRoute = true } = options;
  if (!path) return;
  if (!activeRoot.value || path === activeRoot.value || roots.value.some((root) => root.path === path)) {
    activeRoot.value = roots.value.some((root) => root.path === path) ? path : activeRoot.value;
  }
  currentDir.value = path;
  if (updateRoute) {
    await syncRoutePath(path);
  }
}

async function showRoots(options: { updateRoute?: boolean } = {}): Promise<void> {
  const { updateRoute = true } = options;
  currentDir.value = "";
  activeRoot.value = "";
  if (updateRoute) {
    await syncRoutePath("");
  }
}

async function openBreadcrumb(path: string): Promise<void> {
  if (!path) return;
  await openDirectory(path);
}

async function goUp(): Promise<void> {
  if (!canGoUp.value) return;
  const parent = dirParent(currentDir.value);
  const nextPath = isUnderRoot(parent, activeRoot.value) ? parent : activeRoot.value;
  await openDirectory(nextPath);
}

function queueFile(path: string): void {
  addLocalPath(path);
}

function playFile(path: string): void {
  playLocalPath(path);
}

function queueFolder(path: string): void {
  addLocalFolder(path, { recursive: includeSubfolders.value });
}

function playFolder(path: string): void {
  playLocalFolder(path, { recursive: includeSubfolders.value });
}

function addFileToPlaylist(playlistId: string, path: string): void {
  addLocalPathToPlaylist(playlistId, path);
}

function addFolderToPlaylist(playlistId: string, path: string): void {
  addLocalFolderToPlaylist(playlistId, path, { recursive: includeSubfolders.value });
}

async function restorePathFromRoute(pathQuery: unknown): Promise<void> {
  const path = normalizeQueryPath(pathQuery);
  if (!path) {
    if (!showingRoots.value) {
      await showRoots({ updateRoute: false });
    }
    return;
  }

  const root = roots.value.find((candidate) => isUnderRoot(path, candidate.path));
  if (!root) {
    await showRoots({ updateRoute: false });
    await syncRoutePath("");
    return;
  }

  if (currentDir.value === path && activeRoot.value === root.path) return;

  activeRoot.value = root.path;
  await openDirectory(path, { updateRoute: false });
}

watch(
  () => route.query.path,
  async (value) => {
    if (!ready.value) return;
    await restorePathFromRoute(value);
  },
);

watch(
  ready,
  async (isReady) => {
    if (!isReady) return;
    await restorePathFromRoute(route.query.path);
  },
  { immediate: true },
);
</script>
