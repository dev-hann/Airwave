<template>
  <section class="min-h-0 h-full rounded-xl border border-neutral-700 p-6 overflow-auto surface-panel">
    <h2 class="text-2xl font-bold mb-2">Provider Search</h2>
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

    <div
      v-if="query && !loading && !errorMessage"
      class="mt-4 flex flex-wrap items-center gap-2"
    >
      <UButton
        v-for="filter in providerFilters"
        :key="filter.id"
        type="button"
        size="sm"
        :variant="selectedProvider === filter.id ? 'solid' : 'outline'"
        :color="selectedProvider === filter.id ? 'primary' : 'neutral'"
        @click="() => { selectedProvider = filter.id }"
      >
        {{ filter.label }} ({{ providerCounts[filter.id] || 0 }})
      </UButton>
    </div>

    <div v-if="query && !loading && !errorMessage && !filteredResults.length" class="mt-4 text-sm text-muted">
      No results found.
    </div>

    <ul v-if="filteredResults.length" class="mt-4 space-y-2">
      <li v-for="item in filteredResults" :key="item.provider_item_id || item.source_url">
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
import { computed, ref, watch } from "vue";
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
const selectedProvider = ref("all");

function onSearchInputEvent(event: Event): void {
  onSearchTextChange((event.target as HTMLInputElement).value);
}

function providerLabel(providerId: string): string {
  if (!providerId || providerId === "all") return "All";
  return providerId
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

const providerCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { all: results.value.length };
  for (const item of results.value) {
    const provider = String(item?.provider || "").toLowerCase();
    if (!provider) continue;
    counts[provider] = (counts[provider] || 0) + 1;
  }
  return counts;
});

const providerFilters = computed(() => {
  const dynamicProviders = Object.keys(providerCounts.value)
    .filter((id) => id !== "all")
    .sort();
  return [{ id: "all", label: providerLabel("all") }, ...dynamicProviders.map((id) => ({ id, label: providerLabel(id) }))];
});

const filteredResults = computed(() => {
  if (selectedProvider.value === "all") return results.value;
  return results.value.filter((item) => item?.provider === selectedProvider.value);
});

let requestId = 0;

function normalizeQuery(value: unknown): string {
  if (Array.isArray(value)) return (value[0] as string | undefined || "").trim();
  return typeof value === "string" ? value.trim() : "";
}

async function searchAll(rawQuery: unknown): Promise<void> {
  const normalized = normalizeQuery(rawQuery);
  query.value = normalized;
  selectedProvider.value = "all";

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

watch(providerFilters, (filters) => {
  if (!filters.some((filter) => filter.id === selectedProvider.value)) {
    selectedProvider.value = "all";
  }
});
</script>
