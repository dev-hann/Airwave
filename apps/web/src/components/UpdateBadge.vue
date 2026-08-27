<template>
  <button
    v-if="drift"
    type="button"
    class="pointer-events-auto flex items-center gap-1 text-[10px] leading-none text-warning hover:opacity-80"
    :title="`App updated on the server (v${serverLabel}) — this tab runs v${bundleVersion}. Click to reload.`"
    aria-label="App updated — reload page"
    @click="reloadPage"
  >
    <UIcon name="i-bi-arrow-repeat" class="size-3 shrink-0" aria-hidden="true" />
    <span class="hidden sm:inline">Update ready — reload</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { bundleVersion, isVersionDrift, serverVersion } from "../lib/api/version";

const drift = computed(() => isVersionDrift());
const serverLabel = computed(() => serverVersion.value ?? "?");

function reloadPage(): void {
  window.location.reload();
}
</script>
