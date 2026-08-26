<template>
  <div class="group flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 playlist-card">
    <div
      v-if="thumbnailSrc && mode == 'search'"
      class="relative h-14 w-24 shrink-0 overflow-hidden rounded surface-elevated"
      @click="playNow(item.provider, item.source_url)"
    >
      <img
        :src="thumbnailSrc"
        :alt="item.title || 'Thumbnail'"
        class="h-full w-full object-cover"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
      <div
        class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/40 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:any-pointer-coarse:opacity-100"
        aria-hidden
      >
        <UIcon name="i-bi-play-fill" class="size-8 text-white drop-shadow-md" />
      </div>
    </div>

    <div class="min-w-0 flex-1">
      <p class="truncate text-sm" :title="item.title || item.source_url">
        {{ item.title || item.source_url }}
      </p>
      <p v-if="item.provider" class="truncate text-xs text-muted">
        <UBadge :label="providerLabel" color="neutral" variant="soft" class="shrink-0" />
      </p>
      <p v-if="showSecondary" class="truncate text-xs text-muted">
        <template v-if="mode === 'queue'">{{ item.status }} · {{ item.channel || "unknown" }}</template>
        <template v-else-if="mode === 'history'">{{ item.status }}</template>
        <template v-else-if="mode === 'search' && item.channel">{{ item.channel }}</template>
      </p>
      <p v-if="item.duration_seconds != null" class="truncate text-xs text-muted">
        {{ formatDuration(item.duration_seconds) }}
      </p>
    </div>
    <div
      v-if="dropdownItems.length > 0"
      class="shrink-0 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:any-pointer-coarse:opacity-100"
      @click.stop
    >
      <UDropdownMenu :items="dropdownItems" :ui="{ separator: 'hidden' }" @update:open="(open: boolean) => !open && resetSearch()">
        <template #playlist-filter>
          <PlaylistSelectorFilter
            v-model="playlistSearchTerm"
            placeholder="Find a playlist"
            @playlist-created="onPlaylistCreated"
          />
        </template>
        <UButton
          class="cursor-pointer"
          type="button"
          icon="i-bi-three-dots"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="More actions"
        />
      </UDropdownMenu>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import PlaylistSelectorFilter from "./PlaylistSelectorFilter.vue";
import { formatDuration } from "../utils/duration";
import { usePlaylistSelector } from "../composables/usePlaylistSelector";
import { useExplorerStore } from "../stores/explorer";
import { useNotificationsStore } from "../stores/notifications";
import { usePlaylistsStore } from "../stores/playlists";
import { useQueueStore } from "../stores/queue";
import type { DropdownMenuItem } from "@nuxt/ui";
import type { Playlist } from "../types/api";

/** Union of track-like rows (queue item, history row, playlist entry, search result). */
type SongMode = "search" | "queue" | "history" | "playlist";

interface SongItem {
  id?: number;
  source_url: string;
  title?: string | null;
  channel?: string | null;
  provider?: string | null;
  thumbnail_url?: string | null;
  status?: string;
  duration_seconds?: number | null;
}

const props = withDefaults(
  defineProps<{
    item: SongItem;
    mode?: SongMode;
    playlists?: Playlist[];
    playlistId?: string | null;
    entryId?: number | null;
  }>(),
  { mode: "search", playlists: () => [], playlistId: null, entryId: null },
);

const emit = defineEmits<{ deleted: [entryId: number] }>();

const { playlistSearchTerm, filteredPlaylists, resetSearch } = usePlaylistSelector(() => props.playlists);
const notifications = useNotificationsStore();
const queueStore = useQueueStore();
const playlistsStore = usePlaylistsStore();
const explorerStore = useExplorerStore();
const notifyError = (title: string, error: unknown) => notifications.notifyError(title, error);

const thumbnailSrc = computed(() => props.item?.thumbnail_url || "");

const showSecondary = computed(
  () => props.mode === "queue" || props.mode === "history" || (props.mode === "search" && props.item?.channel),
);

const providerLabel = computed(() => {
  const provider = props.item?.provider;
  if (provider) return provider.charAt(0).toUpperCase() + provider.slice(1);
  return "";
});

async function addToQueue(provider: string | null | undefined, url: string): Promise<void> {
  if (!url) return;
  try {
    if (provider === "local") {
      await explorerStore.addLocalPath(url);
    } else {
      await queueStore.addUrl(url);
    }
  } catch (error) {
    notifyError("Could not add to queue", error);
  }
}

async function playNow(provider: string | null | undefined, url: string): Promise<void> {
  if (!url) return;
  if (provider === "local") {
    await explorerStore.playLocalPath(url);
  } else {
    await queueStore.playUrl(url);
  }
}

async function addToPlaylist(playlistId: string, provider: string | null | undefined, url: string): Promise<void> {
  if (!playlistId || !url) return;
  try {
    if (provider === "local") {
      await playlistsStore.addLocalPathToPlaylist(playlistId, url);
    } else {
      await playlistsStore.addUrlToPlaylist(playlistId, url);
    }
  } finally {
    resetSearch();
  }
}

async function onPlaylistCreated(created: Playlist | null): Promise<void> {
  if (created?.id == null) return;
  await addToPlaylist(created.id, props.item?.provider, props.item?.source_url);
}

const dropdownItems = computed<DropdownMenuItem[][]>(() => {
  const url = props.item?.source_url;
  const provider = props.item?.provider;
  const hasUrl = !!url;
  const items: DropdownMenuItem[][] = [[]];
  if (hasUrl) {
    items[0]!.push({
      label: "Play now",
      icon: "i-bi-play-fill",
      onSelect: () => playNow(provider, url),
    });

    if (props.mode !== "queue") {
      items[0]!.push({
        label: "Add to queue",
        icon: "i-bi-music-note-list",
        onSelect: () => addToQueue(provider, url),
      });
    }
    if (props.mode === "queue") {
      items[0]!.push({
        label: "Remove from queue",
        icon: "i-bi-trash-fill",
        color: "error",
        onSelect: () => queueStore.removeFromQueue(props.item.id!),
      });
    }
  }

  const addToPlaylistChildren: DropdownMenuItem[] = [
    { type: "label", slot: "playlist-filter" },
    ...filteredPlaylists.value.map((p) => ({
      label: p.title,
      onSelect: () => addToPlaylist(p.id, provider, url),
    })),
  ];

  if (hasUrl) {
    items.push([
      {
        label: "Add to playlist",
        icon: "i-bi-plus",
        children: [addToPlaylistChildren],
      },
    ]);
  }

  if (props.playlistId && props.entryId != null) {
    items.push([
      {
        label: "Remove from playlist",
        icon: "i-bi-trash-fill",
        color: "error",
        onSelect: async () => {
          try {
            await playlistsStore.removeFromPlaylist(props.entryId!);
            emit("deleted", props.entryId!);
          } catch (error) {
            notifyError("Could not remove from playlist", error);
          }
        },
      } satisfies DropdownMenuItem,
    ]);
  }
  return items;
});
</script>
