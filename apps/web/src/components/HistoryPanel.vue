<template>
  <section class="min-h-0 h-full overflow-hidden rounded-xl border border-neutral-700 p-3 flex flex-col surface-panel">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-2xl font-bold">Play History</h2>
      <UButton
        type="button"
        color="error"
        variant="soft"
        size="xs"
        :disabled="!history.length"
        class="shrink-0 cursor-pointer"
        @click="clearHistory"
      >
        Clear History
      </UButton>
    </div>
    <ul class="mt-3 min-h-0 flex-1 space-y-2 overflow-auto pr-1">
      <li v-for="item in history" :key="item.id">
        <Song :item="item" mode="history" :playlists="playlists" />
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";

import { useHistoryStore } from "../stores/history";
import { usePlaylistsStore } from "../stores/playlists";
import Song from "./Song.vue";

const historyStore = useHistoryStore();
const playlistsStore = usePlaylistsStore();
const { history } = storeToRefs(historyStore);
const { playlists } = storeToRefs(playlistsStore);
const { clearHistory } = historyStore;
</script>
