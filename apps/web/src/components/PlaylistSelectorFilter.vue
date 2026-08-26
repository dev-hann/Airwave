<template>
  <div class="flex flex-col gap-2 px-2 py-1.5 w-full">
    <div class="flex items-center gap-2">
      <UIcon name="i-bi-search" class="size-4 shrink-0 text-muted" />
      <input
        :value="modelValue"
        type="text"
        class="min-w-0 flex-1 border-0 bg-transparent px-2 py-1 text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-0"
        :placeholder="placeholder"
        @input="onInput"
        @click.stop
        @keydown.stop
        @keyup.stop
        @keypress.stop
      />
    </div>
    <form
      v-if="showCreate"
      class="flex items-center gap-2 border-t border-neutral-600/60 pt-2"
      @submit.prevent="submitCreate"
    >
      <UIcon name="i-bi-plus-lg" class="size-4 shrink-0 text-muted" aria-hidden="true" />
      <input
        v-model="newTitle"
        type="text"
        :placeholder="createPlaceholder"
        class="min-w-0 flex-1 rounded-md border-0 bg-transparent px-2 py-1 text-sm placeholder-neutral-500 focus:outline-none focus:ring-0"
        :disabled="creating"
        @click.stop
        @keydown.stop
        @keyup.stop
        @keypress.stop
      />
      <UButton
        type="submit"
        size="xs"
        color="primary"
        variant="soft"
        class="shrink-0"
        :disabled="creating || !newTitle.trim()"
        @click.stop
      >
        Create
      </UButton>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

import { usePlaylistsStore } from "../stores/playlists";
import type { Playlist } from "../types/api";

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    placeholder?: string;
    showCreate?: boolean;
    createPlaceholder?: string;
  }>(),
  { modelValue: "", placeholder: "Find a playlist", showCreate: true, createPlaceholder: "New playlist name" },
);
void props;

const emit = defineEmits<{ "update:modelValue": [value: string]; "playlist-created": [created: Playlist] }>();

function onInput(event: Event): void {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}

const playlistsStore = usePlaylistsStore();
const newTitle = ref("");
const creating = ref(false);

async function submitCreate(): Promise<void> {
  const title = newTitle.value.trim();
  if (!title || creating.value) return;
  creating.value = true;
  try {
    const created = await playlistsStore.createPlaylist(title);
    if (created?.id) {
      newTitle.value = "";
      emit("playlist-created", created);
    }
  } finally {
    creating.value = false;
  }
}
</script>
