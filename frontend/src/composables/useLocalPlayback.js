import { onUnmounted, ref, watch } from "vue";

import Hls from "hls.js";

import { usePlaybackState } from "./usePlaybackState";

const LOCAL_VOLUME_STORAGE_KEY = "airwave:settings:local-volume";
const DEFAULT_LOCAL_VOLUME = 0.8;

// Recovery tuning (radio-app conventions: unlimited retries, capped backoff).
const REJOIN_BACKOFF_BASE_MS = 1000;
const REJOIN_BACKOFF_MAX_MS = 8000;
const STALL_WATCHDOG_INTERVAL_MS = 5000;
const RECONCILE_SETTLE_MS = 250;

// HLS tuning: a deep forward buffer is what lets mobile/VPN listeners ride
// out multi-second network stalls without an audible cut, and catch up on
// missed segments afterwards instead of rejoining at the live edge.
const HLS_MAX_BUFFER_SECONDS = 30;
const HLS_MAX_MAX_BUFFER_SECONDS = 90;
// Start listeners this many segments behind the live edge (4s segments).
const HLS_LIVE_SYNC_SEGMENT_COUNT = 3;

function canPlayNativeHls(audio) {
  return Boolean(audio) && audio.canPlayType("application/vnd.apple.mpegurl") !== "";
}

function clampVolume(value) {
  if (!Number.isFinite(value)) return DEFAULT_LOCAL_VOLUME;
  return Math.max(0, Math.min(1, value));
}

function readStoredLocalVolume() {
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

function writeStoredLocalVolume(volume) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_VOLUME_STORAGE_KEY, String(clampVolume(volume)));
  } catch {
    // Ignore localStorage write errors and keep in-memory state.
  }
}

function isFirefox() {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Firefox");
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
 *   else uses hls.js (MSE) with a deep forward buffer (~30s) so mobile/VPN
 *   listeners survive stalls and catch up instead of rejoining.
 * - The element stays connected (muted or not) and rejoins automatically on
 *   stalls, network errors, and background freezes (backoff 1s→8s, unlimited).
 * @param {import('vue').Ref<HTMLAudioElement | null>} audioRef
 */
export function useLocalPlayback(audioRef) {
  const { playbackState } = usePlaybackState();
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
  let rejoinTimer = null;
  let watchdogTimer = null;
  let watchdogLastCurrentTime = -1;
  let detachGestureFallback = () => {};
  let hls = null; // hls.js instance; null on native-HLS engines (iOS Safari)

  function destroyHls() {
    if (hls != null) {
      try {
        hls.destroy();
      } catch {
        // Destroy racing a fatal error is benign.
      }
      hls = null;
    }
  }

  function clearRejoinTimer() {
    if (rejoinTimer != null) {
      clearTimeout(rejoinTimer);
      rejoinTimer = null;
    }
  }

  function scheduleRejoin(delayMs) {
    clearRejoinTimer();
    rejoinTimer = setTimeout(() => {
      rejoinTimer = null;
      void rejoinLiveStream();
    }, delayMs);
  }

  function scheduleRejoinWithBackoff() {
    const delay = Math.min(REJOIN_BACKOFF_BASE_MS * 2 ** rejoinAttempts, REJOIN_BACKOFF_MAX_MS);
    rejoinAttempts += 1;
    scheduleRejoin(delay);
  }

  function shouldRecover() {
    return Boolean(audioRef.value);
  }

  function streamUrlWithCacheBust(url) {
    // Firefox caches the downloaded live stream, which breaks rejoins.
    // A fresh URL per start bypasses the stale cache/buffer (AzuraCast pattern).
    if (!isFirefox()) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}refresh=${Date.now()}`;
  }

  /**
   * (Re)join the live edge: reset src (never recreate the element — reusing it
   * preserves the iOS audio session permission) and start playback. Preserves
   * the current mute state so an unmuted listener keeps hearing audio across
   * rejoins.
   */
  async function rejoinLiveStream(reason = "rejoin") {
    const audio = audioRef.value;
    const streamUrl = playbackState.value?.stream_url;
    if (!audio || !streamUrl || !shouldRecover()) return;

    console.debug("[airwave] rejoin live stream", { reason, attempt: rejoinAttempts + 1, native: canPlayNativeHls(audio) });
    sourceLoading = true;
    destroyHls();
    audio.removeAttribute("src");
    audio.load();

    if (canPlayNativeHls(audio)) {
      // iOS Safari & friends play HLS natively; the element manages the
      // buffer and live-edge sync itself.
      audio.src = streamUrlWithCacheBust(streamUrl);
    } else if (typeof window !== "undefined" && Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: HLS_MAX_BUFFER_SECONDS,
        maxMaxBufferLength: HLS_MAX_MAX_BUFFER_SECONDS,
        liveSyncDurationCount: HLS_LIVE_SYNC_SEGMENT_COUNT,
        backBufferLength: 90,
      });
      hls.attachMedia(audio);
      hls.loadSource(streamUrl);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try {
            hls?.recoverMediaError();
            return;
          } catch {
            // fall through to rejoin
          }
        }
        scheduleRejoinWithBackoff();
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
      if (error?.name === "NotAllowedError") {
        // Audible rejoin without a gesture (background recovery while unmuted).
        // Retry with backoff — browsers grant play() again after any interaction.
        sourceLoading = false;
        scheduleRejoinWithBackoff();
        syncLocalAudioPausedFromElement();
        return;
      }
      if (error?.name !== "AbortError") {
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

  function maybeRecover(reason) {
    if (!shouldRecover()) return;
    if (sourceLoading) return; // transient pause from our own src swap
    if (rejoinTimer != null) return; // already scheduled
    rejoinAttempts = 0;
    scheduleRejoin(reason === "stall" ? STALL_WATCHDOG_INTERVAL_MS : 0);
  }

  function syncLocalAudioPausedFromElement() {
    const audio = audioRef.value;
    if (!audio) {
      localAudioPaused.value = true;
      return;
    }
    localAudioPaused.value = audio.paused || audio.ended;
  }

  function applyAudioVolume() {
    if (!audioRef.value) return;
    audioRef.value.volume = clampVolume(localVolume.value);
    audioRef.value.muted = isMuted.value || localVolume.value <= 0;
  }

  function setLocalVolume(volume) {
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

  function toggleMuted() {
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

  function onAudioPause() {
    // The element stopped without our src-swap being in flight (background tab,
    // OS interruption, server pause) — recover to keep the live edge warm.
    syncLocalAudioPausedFromElement();
    if (!sourceLoading) maybeRecover("pause");
  }

  function onAudioError() {
    const audio = audioRef.value;
    const code = audio?.error?.code;
    // MediaError.NETWORK_ERROR === 2 — the only recoverable class for a live stream.
    if (code === 2 || code == null) {
      rejoinAttempts = 0;
      scheduleRejoinWithBackoff();
    } else {
      // Decode/src errors also recover via rejoin on a live stream (no seek possible).
      scheduleRejoinWithBackoff();
    }
  }

  function onAudioPlaying() {
    rejoinAttempts = 0;
    clearRejoinTimer();
    detachGestureFallback();
    syncLocalAudioPausedFromElement();
  }

  function onAudioLoadStart() {
    sourceLoading = true;
  }

  function onAudioCanPlay() {
    sourceLoading = false;
  }

  function onAudioTimeUpdate() {
    const audio = audioRef.value;
    if (audio) watchdogLastCurrentTime = audio.currentTime;
  }

  function onAudioStalledOrWaiting(eventName) {
    // Fired even in throttled background tabs; immediate recovery trigger.
    if (!sourceLoading && shouldRecover() && rejoinTimer == null) {
      console.debug("[airwave] stall event", eventName);
      rejoinAttempts = 0;
      scheduleRejoin(STALL_WATCHDOG_INTERVAL_MS);
    }
  }

  function runStallWatchdog() {
    const audio = audioRef.value;
    if (!audio || !shouldRecover()) return;
    if (rejoinTimer != null) return;

    const paused = audio.paused || audio.ended;
    // A frozen currentTime while not paused is a stall at ANY readyState:
    // after a chunk drop the decoder can sit at readyState >= 3 with the
    // clock not advancing and no pause event — the stream is dead.
    const timeFrozen = Math.abs(audio.currentTime - watchdogLastCurrentTime) < 0.05;
    if (paused || timeFrozen) {
      maybeRecover("stall");
    }
    watchdogLastCurrentTime = audio.currentTime;
  }

  /** Reconcile after background freeze: trust the element state, recover if needed. */
  function onVisibleReconcile() {
    if (document.visibilityState !== "visible") return;
    setTimeout(() => {
      const audio = audioRef.value;
      if (!audio || !shouldRecover()) return;
      if (audio.paused || audio.ended) maybeRecover("visible");
    }, RECONCILE_SETTLE_MS);
  }

  /**
   * Belt-and-braces for engines that refuse even muted play(): retry on the
   * first pointer/key gesture, then detach once playback is running.
   */
  function installGestureFallback() {
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
    () => playbackState.value.stream_url,
    async (newUrl) => {
      if (!newUrl) return;
      if (!audioRef.value) return;
      await rejoinLiveStream("prestart");
    }
  );

  let detachAudioStateListeners = () => {};

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
      audio.addEventListener("timeupdate", onAudioTimeUpdate);
      audio.addEventListener("stalled", () => onAudioStalledOrWaiting("stalled"));
      audio.addEventListener("waiting", () => onAudioStalledOrWaiting("waiting"));
      detachAudioStateListeners = () => {
        audio.removeEventListener("play", onAudioStateEvent);
        audio.removeEventListener("pause", onAudioPause);
        audio.removeEventListener("ended", onAudioStateEvent);
        audio.removeEventListener("playing", onAudioPlaying);
        audio.removeEventListener("error", onAudioError);
        audio.removeEventListener("loadstart", onAudioLoadStart);
        audio.removeEventListener("canplay", onAudioCanPlay);
        audio.removeEventListener("timeupdate", onAudioTimeUpdate);
      };
      // Element mounted before/after the stream URL arrived: cover both orders.
      if (playbackState.value?.stream_url) {
        void rejoinLiveStream("prestart");
      }
      installGestureFallback();
    },
    { immediate: true }
  );

  if (typeof window !== "undefined") {
    document.addEventListener("visibilitychange", onVisibleReconcile);
    window.addEventListener("pageshow", onVisibleReconcile);
    document.addEventListener("resume", onVisibleReconcile);
    watchdogTimer = setInterval(runStallWatchdog, STALL_WATCHDOG_INTERVAL_MS);
  }

  if (storedVolume == null) {
    writeStoredLocalVolume(localVolume.value);
  }

  onUnmounted(() => {
    detachAudioStateListeners();
    detachGestureFallback();
    clearRejoinTimer();
    destroyHls();
    if (watchdogTimer != null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
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
