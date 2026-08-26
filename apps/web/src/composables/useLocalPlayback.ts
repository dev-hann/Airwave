import { onUnmounted, ref, watch } from "vue";
import type { Ref } from "vue";

import Hls from "hls.js";

import { usePlaybackStore } from "../stores/playback";

const LOCAL_VOLUME_STORAGE_KEY = "airwave:settings:local-volume";
const DEFAULT_LOCAL_VOLUME = 0.8;

// Recovery tuning (radio-app conventions: unlimited retries, capped backoff).
const REJOIN_BACKOFF_BASE_MS = 1000;
const REJOIN_BACKOFF_MAX_MS = 8000;
const RECONCILE_SETTLE_MS = 250;
// Official hls.js sample cooldown for recoverMediaError(): retrying media
// error recovery more often loops instead of recovering.
const MEDIA_ERROR_RECOVERY_COOLDOWN_MS = 5000;

// HLS live tuning (hls.js docs: liveSyncDurationCount stays at the default 3;
// liveMaxLatencyDurationCount must be strictly greater or playback stalls).
// A deep forward buffer lets mobile/VPN listeners ride out multi-second
// network stalls; latency control then catches up (1.5x) or seeks to the
// live edge past the max-latency window instead of drifting behind forever.
const HLS_MAX_BUFFER_SECONDS = 30;
const HLS_MAX_MAX_BUFFER_SECONDS = 90;
const HLS_BACK_BUFFER_SECONDS = 30;
const HLS_LIVE_SYNC_SEGMENT_COUNT = 3;
const HLS_LIVE_MAX_LATENCY_SEGMENT_COUNT = 12;
const HLS_MAX_LIVE_SYNC_PLAYBACK_RATE = 1.5;

function canPlayNativeHls(audio: HTMLAudioElement | null): boolean {
  return audio !== null && audio.canPlayType("application/vnd.apple.mpegurl") !== "";
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOCAL_VOLUME;
  return Math.max(0, Math.min(1, value));
}

function readStoredLocalVolume(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(LOCAL_VOLUME_STORAGE_KEY);
    if (stored == null) return null;
    const parsed = Number.parseFloat(stored);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredLocalVolume(volume: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_VOLUME_STORAGE_KEY, String(clampVolume(volume)));
  } catch {
    // Ignore localStorage write errors and keep in-memory state.
  }
}

/**
 * Shared local playback over a single audio element. Call from the component that owns the element (e.g. App.vue).
 *
 * Muted-prestart model over the shared HLS live stream (/stream/live.m3u8):
 * - The audio element connects and plays MUTED as soon as the stream URL is
 *   known. Muted playback needs no user gesture, so every visitor arrives
 *   already buffering at the live edge; unmuting is instant.
 * - Listening on/off is purely local: the mute button and volume slider only
 *   touch this browser. Server playback (play/pause/skip) is controlled
 *   separately and shared by all listeners.
 * - Engines with native HLS (iOS Safari) use the element directly; everyone
 *   else uses hls.js (MSE), which owns stall detection, fragment retries,
 *   gap/nudge recovery, and live-edge latency control. The app layer only
 *   handles fatal errors (with the official recovery cooldown), autoplay
 *   policy, and foreground reconciliation — never rejoin on transient
 *   stalls, which would just destroy the buffer hls.js is defending.
 * @param audioRef ref to the shared `<audio>` element
 */
export function useLocalPlayback(audioRef: Ref<HTMLAudioElement | null>) {
  const playbackStore = usePlaybackStore();
  /** Mirrors the audio element's paused/ended state so Vue updates when OS / Media Session controls the element. */
  const localAudioPaused = ref(true);
  const storedVolume = readStoredLocalVolume();
  const localVolume = ref(storedVolume ?? DEFAULT_LOCAL_VOLUME);
  // Always start muted: audible autoplay is blocked without a gesture, muted is not.
  const isMuted = ref(true);
  const previousVolumeBeforeMute = ref(localVolume.value > 0 ? localVolume.value : DEFAULT_LOCAL_VOLUME);

  // --- recovery state ---
  let sourceLoading = false;
  let rejoinAttempts = 0;
  let rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  let detachGestureFallback: () => void = () => {};
  let hls: Hls | null = null; // hls.js instance; null on native-HLS engines (iOS Safari)
  let attemptedMediaErrorRecoveryAt = 0;

  function destroyHls(): void {
    if (hls != null) {
      try {
        hls.destroy();
      } catch {
        // Destroy racing a fatal error is benign.
      }
      hls = null;
    }
  }

  function clearRejoinTimer(): void {
    if (rejoinTimer != null) {
      clearTimeout(rejoinTimer);
      rejoinTimer = null;
    }
  }

  function scheduleRejoin(delayMs: number): void {
    clearRejoinTimer();
    rejoinTimer = setTimeout(() => {
      rejoinTimer = null;
      void rejoinLiveStream();
    }, delayMs);
  }

  function scheduleRejoinWithBackoff(): void {
    const delay = Math.min(REJOIN_BACKOFF_BASE_MS * 2 ** rejoinAttempts, REJOIN_BACKOFF_MAX_MS);
    rejoinAttempts += 1;
    scheduleRejoin(delay);
  }

  function shouldRecover(): boolean {
    return Boolean(audioRef.value);
  }

  /**
   * Fatal hls.js error handling, following the official sample in the
   * hls.js API docs: MEDIA_ERROR → recoverMediaError() with a 5s cooldown;
   * anything else exhausted → backoff rejoin (never an immediate restart,
   * which the docs warn causes loop loading).
   */
  function handleHlsFatalError(data: { type?: string }): void {
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      const now = Date.now();
      if (
        attemptedMediaErrorRecoveryAt === 0 ||
        now - attemptedMediaErrorRecoveryAt > MEDIA_ERROR_RECOVERY_COOLDOWN_MS
      ) {
        attemptedMediaErrorRecoveryAt = now;
        console.debug("[airwave] fatal media error; attempting recoverMediaError()");
        try {
          hls?.recoverMediaError();
          return;
        } catch {
          // fall through to rejoin
        }
      } else {
        console.debug("[airwave] skipping media error recovery (cooldown)");
      }
    }
    scheduleRejoinWithBackoff();
  }

  /**
   * (Re)join the live stream: reset src (never recreate the element — reusing it
   * preserves the iOS audio session permission) and start playback. Preserves
   * the current mute state so an unmuted listener keeps hearing audio across
   * rejoins.
   */
  async function rejoinLiveStream(reason = "rejoin"): Promise<void> {
    const audio = audioRef.value;
    const streamUrl = playbackStore.playbackState?.stream_url;
    if (!audio || !streamUrl || !shouldRecover()) return;

    console.debug("[airwave] rejoin live stream", {
      reason,
      attempt: rejoinAttempts + 1,
      native: canPlayNativeHls(audio),
    });
    sourceLoading = true;
    destroyHls();
    audio.removeAttribute("src");
    audio.load();

    if (canPlayNativeHls(audio)) {
      // iOS Safari & friends play HLS natively; the element manages the
      // buffer and live-edge sync itself.
      audio.src = streamUrl;
    } else if (typeof window !== "undefined" && Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: HLS_MAX_BUFFER_SECONDS,
        maxMaxBufferLength: HLS_MAX_MAX_BUFFER_SECONDS,
        backBufferLength: HLS_BACK_BUFFER_SECONDS,
        liveSyncDurationCount: HLS_LIVE_SYNC_SEGMENT_COUNT,
        liveMaxLatencyDurationCount: HLS_LIVE_MAX_LATENCY_SEGMENT_COUNT,
        maxLiveSyncPlaybackRate: HLS_MAX_LIVE_SYNC_PLAYBACK_RATE,
        liveDurationInfinity: true,
      });
      hls.attachMedia(audio);
      hls.loadSource(streamUrl);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) return;
        handleHlsFatalError(data);
      });
    } else {
      // Engine without MSE or native HLS — nothing this app can play on.
      sourceLoading = false;
      return;
    }
    applyAudioVolume();

    try {
      await audio.play();
    } catch (error) {
      if ((error as { name?: string })?.name === "NotAllowedError") {
        // Audible rejoin without a gesture (background recovery while unmuted).
        // Retry with backoff — browsers grant play() again after any interaction.
        sourceLoading = false;
        scheduleRejoinWithBackoff();
        syncLocalAudioPausedFromElement();
        return;
      }
      if ((error as { name?: string })?.name !== "AbortError") {
        // Genuine failure (network etc.) — retry with backoff.
        sourceLoading = false;
        scheduleRejoinWithBackoff();
        syncLocalAudioPausedFromElement();
        return;
      }
      // AbortError: a src swap raced our play() — the loadstart listener chain will retry.
    }
    sourceLoading = false;
    syncLocalAudioPausedFromElement();
  }

  /** Foreground-visible only: resume playback if the element got paused
   * (OS/backgrounding). Never triggered from inside a backgrounded tab, so it
   * cannot churn while the browser throttles us. */
  function maybeResumeOnForeground(): void {
    if (!shouldRecover()) return;
    if (sourceLoading) return;
    if (rejoinTimer != null) return;
    const audio = audioRef.value;
    if (!audio || (!audio.paused && !audio.ended)) return;
    rejoinAttempts = 0;
    void rejoinLiveStream("foreground");
  }

  function syncLocalAudioPausedFromElement(): void {
    const audio = audioRef.value;
    if (!audio) {
      localAudioPaused.value = true;
      return;
    }
    localAudioPaused.value = audio.paused || audio.ended;
  }

  function applyAudioVolume(): void {
    if (!audioRef.value) return;
    audioRef.value.volume = clampVolume(localVolume.value);
    audioRef.value.muted = isMuted.value || localVolume.value <= 0;
  }

  function setLocalVolume(volume: number): void {
    const nextVolume = clampVolume(volume);
    localVolume.value = nextVolume;
    if (nextVolume > 0) {
      previousVolumeBeforeMute.value = nextVolume;
      isMuted.value = false;
    } else {
      isMuted.value = true;
    }
    applyAudioVolume();
    writeStoredLocalVolume(nextVolume);
  }

  function toggleMuted(): void {
    const audio = audioRef.value;
    if (isMuted.value || localVolume.value <= 0) {
      const restoredVolume = previousVolumeBeforeMute.value > 0 ? previousVolumeBeforeMute.value : DEFAULT_LOCAL_VOLUME;
      localVolume.value = clampVolume(restoredVolume);
      isMuted.value = false;
      applyAudioVolume();
      writeStoredLocalVolume(localVolume.value);
      // Unmuting is a user gesture: if the element stalled or was interrupted,
      // restart it now so sound is immediate.
      if (audio && (audio.paused || audio.ended) && rejoinTimer == null) {
        void rejoinLiveStream("unmute");
      }
      return;
    }

    previousVolumeBeforeMute.value = localVolume.value;
    localVolume.value = 0;
    isMuted.value = true;
    applyAudioVolume();
    writeStoredLocalVolume(0);
  }

  function onAudioPause(): void {
    // The element stopped (background tab, OS interruption, server pause).
    // State sync only: hls.js keeps its buffer and resumes when play() is
    // granted again; a rejoin here would destroy the buffer for nothing.
    syncLocalAudioPausedFromElement();
  }

  function onAudioError(): void {
    // Only the native-HLS engine (no hls.js instance) surfaces playback
    // errors through the element; on MSE engines hls.js owns error handling.
    if (hls != null) return;
    scheduleRejoinWithBackoff();
  }

  function onAudioPlaying(): void {
    rejoinAttempts = 0;
    clearRejoinTimer();
    detachGestureFallback();
    syncLocalAudioPausedFromElement();
  }

  function onAudioLoadStart(): void {
    sourceLoading = true;
  }

  function onAudioCanPlay(): void {
    sourceLoading = false;
  }

  /** Reconcile after background freeze: trust the element state, recover if needed. */
  function onVisibleReconcile(): void {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    setTimeout(() => {
      if (!shouldRecover()) return;
      const audio = audioRef.value;
      if (!audio) return;
      if (audio.paused || audio.ended) maybeResumeOnForeground();
    }, RECONCILE_SETTLE_MS);
  }

  /**
   * Belt-and-braces for engines that refuse even muted play(): retry on the
   * first pointer/key gesture, then detach once playback is running.
   */
  function installGestureFallback(): void {
    if (typeof window === "undefined") return;
    const events = ["pointerdown", "keydown", "touchstart"];
    const onFirstGesture = () => {
      if (localAudioPaused.value && rejoinTimer == null) {
        void rejoinLiveStream("gesture-fallback");
      }
    };
    for (const name of events) window.addEventListener(name, onFirstGesture, { capture: true });
    detachGestureFallback = () => {
      for (const name of events) window.removeEventListener(name, onFirstGesture, { capture: true });
      detachGestureFallback = () => {};
    };
  }

  watch(
    () => playbackStore.playbackState.stream_url,
    async (newUrl) => {
      if (!newUrl) return;
      if (!audioRef.value) return;
      await rejoinLiveStream("prestart");
    },
  );

  // The server purges the HLS window on a seek (new timeline at the new
  // offset). The browser's buffered audio stalls once the old buffer drains
  // — rejoin at the live edge so playback continues at the seek target.
  watch(
    () => playbackStore.seekEpoch,
    async (epoch) => {
      if (!epoch) return;
      if (!audioRef.value) return;
      if (!playbackStore.playbackState.stream_url) return;
      await rejoinLiveStream("seek");
    },
  );

  let detachAudioStateListeners: () => void = () => {};

  watch(
    audioRef,
    (audio) => {
      detachAudioStateListeners();
      detachAudioStateListeners = () => {};
      if (!audio) {
        localAudioPaused.value = true;
        return;
      }
      applyAudioVolume();
      const onAudioStateEvent = () => syncLocalAudioPausedFromElement();
      syncLocalAudioPausedFromElement();
      audio.addEventListener("play", onAudioStateEvent);
      audio.addEventListener("pause", onAudioPause);
      audio.addEventListener("ended", onAudioStateEvent);
      audio.addEventListener("playing", onAudioPlaying);
      audio.addEventListener("error", onAudioError);
      audio.addEventListener("loadstart", onAudioLoadStart);
      audio.addEventListener("canplay", onAudioCanPlay);
      detachAudioStateListeners = () => {
        audio.removeEventListener("play", onAudioStateEvent);
        audio.removeEventListener("pause", onAudioPause);
        audio.removeEventListener("ended", onAudioStateEvent);
        audio.removeEventListener("playing", onAudioPlaying);
        audio.removeEventListener("error", onAudioError);
        audio.removeEventListener("loadstart", onAudioLoadStart);
        audio.removeEventListener("canplay", onAudioCanPlay);
      };
      // Element mounted before/after the stream URL arrived: cover both orders.
      if (playbackStore.playbackState?.stream_url) {
        void rejoinLiveStream("prestart");
      }
      installGestureFallback();
    },
    { immediate: true },
  );

  if (typeof window !== "undefined") {
    document.addEventListener("visibilitychange", onVisibleReconcile);
    window.addEventListener("pageshow", onVisibleReconcile);
    document.addEventListener("resume", onVisibleReconcile);
  }

  if (storedVolume == null) {
    writeStoredLocalVolume(localVolume.value);
  }

  onUnmounted(() => {
    detachAudioStateListeners();
    detachGestureFallback();
    clearRejoinTimer();
    destroyHls();
    if (typeof window !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibleReconcile);
      window.removeEventListener("pageshow", onVisibleReconcile);
      document.removeEventListener("resume", onVisibleReconcile);
    }
  });

  return {
    localVolume,
    isMuted,
    setLocalVolume,
    toggleMuted,
  };
}
