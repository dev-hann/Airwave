<template>
  <div v-if="state !== 'connected'" class="flex items-center gap-1.5" :title="title" :aria-label="title">
    <span class="relative inline-flex size-2">
      <span
        v-if="state === 'reconnecting'"
        class="absolute inset-0 animate-ping rounded-full"
        :class="reconnecting ? 'bg-warning/60' : 'bg-error/60'"
      />
      <span class="relative inline-flex size-2 rounded-full" :class="dotClass" />
    </span>
    <span class="text-[10px] leading-none text-muted hidden sm:inline">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { connectionState } from "../lib/api/ws";

const state = computed(() => connectionState.value);

const dotClass = computed(() => {
  switch (state.value) {
    case "reconnecting":
      return "bg-warning";
    case "connecting":
      return "bg-warning";
    default:
      return "bg-error";
  }
});

const label = computed(() => {
  switch (state.value) {
    case "reconnecting":
      return "Reconnecting…";
    case "connecting":
      return "Connecting…";
    default:
      return "Offline";
  }
});

const title = computed(() =>
  state.value === "connected"
    ? "Live updates connected"
    : `Live updates: ${label.value} — state may be stale until reconnected`,
);

const reconnecting = computed(() => state.value === "reconnecting");
</script>
