<template>
  <div class="flex flex-col w-full">
    <USlider
      :model-value="seekSliderValue"
      :min="0"
      :max="100"
      color="neutral"
      :size="size"
      :disabled="!canSeek"
      :ui="{ root: 'group', range: 'transition-colors group-hover:bg-primary', thumb: 'cursor-pointer opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100' }"
      class="w-full cursor-pointer"
      aria-label="Seek current track"
      @update:model-value="onSeekInput"
      @change="onSeekCommit"
    />
    <div class="mt-2 flex w-full items-center justify-between text-xs text-muted">
      <span>{{ formatDuration(elapsedSeconds) }}</span>
      <span>{{ formatDuration(durationSeconds) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { formatDuration } from "../utils/duration";
const props = withDefaults(
  defineProps<{
    progressPercent?: number | null;
    elapsedSeconds?: number | null;
    durationSeconds?: number | null;
    canSeek?: boolean;
    size?: string;
  }>(),
  {
    progressPercent: 0,
    elapsedSeconds: null,
    durationSeconds: null,
    canSeek: false,
    size: "md",
  },
);

const emit = defineEmits<{ seek: [percent: number] }>();

// Commit-on-release semantics: dragging only moves the local preview; the
// seek request fires ONCE when the interaction finishes (USlider `change`
// event). This avoids an interrupt+ffmpeg-restart storm per 150ms of drag.
const isSeeking = ref(false);
const localSeekPercent = ref(0);
let pendingPercent: number | null = null;

const seekSliderValue = computed(() =>
  isSeeking.value ? localSeekPercent.value : (props.progressPercent ?? 0)
);

function onSeekInput(value: number | number[] | null | undefined): void {
  const percent = Array.isArray(value) ? value[0] : value;
  const num = Number(percent ?? 0);
  if (!Number.isFinite(num)) return;
  isSeeking.value = true;
  localSeekPercent.value = Math.max(0, Math.min(100, num));
}

function onSeekCommit(_event: Event): void {
  // USlider emits a DOM `change` Event on release; the pending value was
  // captured by the last onSeekInput.
  if (pendingPercent === null) return;
  const target = pendingPercent;
  emit("seek", target);
}

// Release the drag preview once the server's position reaches (or passes)
// the committed target — no fixed timer that would rubber-band back to the
// pre-seek position while ffmpeg restarts.
const wasSeeking = ref(false);
const checkRelease = computed(() => {
  if (isSeeking.value && pendingPercent !== null) {
    wasSeeking.value = true;
    const server = props.progressPercent ?? 0;
    // Within ~2% of the target, or overshot it: the snapshot landed.
    if (Math.abs(server - pendingPercent) <= 2 || server > pendingPercent) {
      isSeeking.value = false;
      pendingPercent = null;
    }
  } else if (wasSeeking.value && pendingPercent === null) {
    wasSeeking.value = false;
  }
  return null;
});
void checkRelease;

onBeforeUnmount(() => {
  isSeeking.value = false;
  pendingPercent = null;
});
</script>
