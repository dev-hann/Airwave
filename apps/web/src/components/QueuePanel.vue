<template>
  <section class="min-h-0 h-full overflow-hidden rounded-xl border border-neutral-700 p-3 flex flex-col surface-panel">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-2xl font-bold">Queue</h2>
      <UButton
        type="button"
        color="error"
        variant="soft"
        size="xs"
        :disabled="!queue.length"
        class="shrink-0 cursor-pointer"
        @click="clearQueue"
      >
        Clear Queue
      </UButton>
    </div>
    <div class="mt-3 min-h-0 flex-1 pr-1">
      <UScrollArea :ui="{ viewport: 'gap-2 pr-1' }" class="h-full min-h-0">
        <ul class="space-y-2">
          <li v-for="item in playingItems" :key="item.id">
            <Song :item="item" mode="queue" :playlists="playlists" />
          </li>
        </ul>
        <VueDraggable
          v-model="queuedItems"
          tag="ul"
          class="space-y-2"
          :animation="150"
          :delay="200"
          :delay-on-touch-only="true"
          ghost-class="queue-drag-ghost"
          chosen-class="queue-drag-chosen"
          @end="onReorderEnd"
        >
          <li v-for="item in queuedItems" :key="item.id">
            <Song :item="item" mode="queue" :playlists="playlists" />
          </li>
        </VueDraggable>
      </UScrollArea>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";

import { VueDraggable } from "vue-draggable-plus";

import { usePlaylistsStore } from "../stores/playlists";
import { useQueueStore } from "../stores/queue";
import type { QueueItem } from "../types/api";

import Song from "./Song.vue";

const queueStore = useQueueStore();
const playlistsStore = usePlaylistsStore();
const { queue } = storeToRefs(queueStore);
const { playlists } = storeToRefs(playlistsStore);
const { clearQueue, reorderQueueItem } = queueStore;

const playingItems = computed(() => queue.value.filter((item) => item.status === "playing"));

const queuedItems = ref<QueueItem[]>([]);

function syncQueuedItems(): void {
  queuedItems.value = queue.value.filter((item) => item.status === "queued");
}

watch(queue, syncQueuedItems, { immediate: true, deep: true });

function onReorderEnd(evt: { oldIndex?: number; newIndex?: number }): void {
  const { oldIndex, newIndex } = evt;
  if (oldIndex === newIndex) return;
  const item = queuedItems.value[newIndex ?? -1];
  if (!item?.id) return;
  reorderQueueItem(item.id, newIndex ?? 0);
}
</script>
