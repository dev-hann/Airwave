<template>
  <section class="min-h-0 h-full rounded-xl border border-neutral-700 p-6 overflow-auto surface-panel">
    <h2 class="text-2xl font-bold mb-2">Search</h2>
    <p class="mt-1 text-sm text-muted hidden sm:block">
      <template v-if="query">
        Showing results for "{{ query }}"
      </template>
      <template v-else>
        Enter a search in the top bar and press Enter.
      </template>
    </p>
    <!-- Show Search for mobile -->
    <div class="flex w-full flex-row gap-2 ml-auto w-full sm:hidden">
      <input
          :value="searchText"
          type="search"
          placeholder="Search YouTube"
          class="h-10 w-full min-w-0 rounded-md border px-3 text-sm sm:w-[320px] surface-input"
          @input="onSearchInputEvent"
          @keydown.enter.prevent="onSearchSubmit(router, route, searchText)"
        />
        <UButton
          type="button"
          color="primary"
          variant="solid"
          size="md"
          class="h-10 self-start sm:self-auto"
          @click="onSearchSubmit(router, route, searchText)"
        >
          Search
        </UButton>
    </div>
     
    
    <div v-if="loading" class="mt-4 text-sm text-muted">Searching...</div>
    <div v-else-if="errorMessage" class="mt-4 text-sm text-red-300">{{ errorMessage }}</div>

    <div v-if="query && !loading && !errorMessage && !results.length" class="mt-4 text-sm text-muted">
      No results found.
    </div>

    <ul v-if="results.length" class="mt-4 space-y-2">
      <li v-for="item in results" :key="item.provider_item_id || item.source_url">
        <Song
          :item="item"
          mode="search"
          :playlists="playlists"
        />
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";

import Song from "../components/Song.vue";
import { getJson } from "../lib/api/http";
import { usePlaylistsStore } from "../stores/playlists";
import { useUiStore } from "../stores/ui";
import type { Playlist } from "../types/api";

interface SearchResultItem {
  source_url: string;
  title?: string | null;
  channel?: string | null;
  provider?: string | null;
  provider_item_id?: string | null;
  thumbnail_url?: string | null;
  duration_seconds?: number | null;
}

interface SearchResponse {
  results?: SearchResultItem[];
}

const playlistsStore = usePlaylistsStore();
const { playlists } = storeToRefs(playlistsStore);
const uiStore = useUiStore();
const { searchText } = storeToRefs(uiStore);
const { onSearchTextChange, onSearchSubmit } = uiStore;
void searchText;
const router = useRouter();

const route = useRoute();
const query = ref("");
const results = ref<SearchResultItem[]>([]);
const loading = ref(false);
const errorMessage = ref("");

function onSearchInputEvent(event: Event): void {
  onSearchTextChange((event.target as HTMLInputElement).value);
}

let requestId = 0;

function normalizeQuery(value: unknown): string {
  if (Array.isArray(value)) return (value[0] as string | undefined || "").trim();
  return typeof value === "string" ? value.trim() : "";
}

async function searchAll(rawQuery: unknown): Promise<void> {
  const normalized = normalizeQuery(rawQuery);
  query.value = normalized;

  if (!normalized) {
    results.value = [];
    errorMessage.value = "";
    loading.value = false;
    return;
  }

  const activeRequestId = ++requestId;
  loading.value = true;
  errorMessage.value = "";

  try {
    const payload = await getJson<SearchResponse>("/api/search", { q: normalized, limit: 20 });
    if (activeRequestId !== requestId) return;
    results.value = Array.isArray(payload?.results) ? payload.results : [];
  } catch (error) {
    if (activeRequestId !== requestId) return;
    results.value = [];
    errorMessage.value = error instanceof Error ? error.message : "Search failed";
  } finally {
    if (activeRequestId === requestId) {
      loading.value = false;
    }
  }
}

watch(
  () => route.query.q,
  (value) => {
    searchAll(value);
  },
  { immediate: true },
);
</script>
