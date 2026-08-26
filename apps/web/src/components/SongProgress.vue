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
      @keydown="onSeekKeydown"
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
  const clamped = Math.max(0, Math.min(100, num));
  isSeeking.value = true;
  localSeekPercent.value = clamped;
  // Park the value for the commit-on-release path — without this the
  // onSeekCommit guard always returns early and NO interaction ever seeks.
  pendingPercent = clamped;
}

// reka-ui emits valueCommit BEFORE update:modelValue on keyboard input, so
// the generic commit handler sees a stale preview. Keyboard keys commit
// directly from the event's resulting value on the NEXT tick.
function onSeekKeydown(event: KeyboardEvent): void {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
  if (!keys.includes(event.key)) return;
  // Let reka update first, then read the committed thumb position.
  setTimeout(() => {
    const thumb = (event.currentTarget as HTMLElement | null)?.querySelector?.('[role="slider"]');
    const raw = Number((thumb as HTMLElement | null)?.getAttribute?.("aria-valuenow"));
    if (!Number.isFinite(raw)) return;
    const clamped = Math.max(0, Math.min(100, raw));
    isSeeking.value = true;
    localSeekPercent.value = clamped;
    pendingPercent = clamped;
    emit("seek", clamped);
  }, 0);
}

function onSeekCommit(_event: Event): void {
  // USlider forwards reka-ui's valueCommit as a `change` Event; its
  // target.value is unreliable (Event init drops target). Keyboard commits
  // can arrive BEFORE the corresponding update:modelValue tick (reka emits
  // valueCommit first), so fall back to the preview value.
  const target = pendingPercent ?? localSeekPercent.value;
  if (isSeeking.value || target > 0) {
    emit("seek", Math.max(0, Math.min(100, target)));
  }
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
