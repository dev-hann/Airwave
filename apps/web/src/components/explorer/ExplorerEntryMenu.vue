<template>
  <UDropdownMenu
    :items="dropdownItems"
    :ui="{ separator: 'hidden' }"
    @update:open="(open) => !open && resetSearch()"
  >
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
</template>

<script setup lang="ts">
import { computed } from "vue";

import PlaylistSelectorFilter from "../PlaylistSelectorFilter.vue";
import { usePlaylistSelector } from "../../composables/usePlaylistSelector";
import type { DropdownMenuItem } from "@nuxt/ui";
import { type LocalMediaEntry } from "../../stores/explorer";
import type { Playlist } from "../../types/api";

const props = withDefaults(
  defineProps<{
    entry: LocalMediaEntry;
    playlists?: Playlist[];
  }>(),
  { playlists: () => [] },
);

const emit = defineEmits<{
  queue: [];
  play: [];
  "add-to-playlist": [playlistId: string];
}>();

const { playlistSearchTerm, filteredPlaylists, resetSearch } = usePlaylistSelector(() => props.playlists);

const dropdownItems = computed(() => {
  const items: DropdownMenuItem[] = [
    {
      label: "Queue",
      icon: "i-bi-music-note-list",
      onSelect: () => emit("queue"),
    },
    {
      label: "Play now",
      icon: "i-bi-play-fill",
      onSelect: () => emit("play"),
    },
  ];

  const addToPlaylistChildren: DropdownMenuItem[] = [
    { type: "label", slot: "playlist-filter" },
    ...filteredPlaylists.value.map((p) => ({
      label: p.title,
      onSelect: () => emit("add-to-playlist", p.id),
    })),
  ];
  items.push({
    label: "Add to playlist",
    icon: "i-bi-plus",
    children: [addToPlaylistChildren],
  });

  return items;
});

function onPlaylistCreated(created: Playlist | null): void {
  if (created?.id != null) emit("add-to-playlist", created.id);
}
</script>
