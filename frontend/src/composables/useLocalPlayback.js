import { computed, onUnmounted, ref, watch } from "vue";

import { usePlaybackState } from "./usePlaybackState";

const LOCAL_VOLUME_STORAGE_KEY = "airwave:settings:local-volume";
const DEFAULT_LOCAL_VOLUME = 0.8;

// Recovery tuning (radio-app conventions: unlimited retries, capped backoff).
const REJOIN_BACKOFF_BASE_MS = 1000;
const REJOIN_BACKOFF_MAX_MS = 8000;
const STALL_WATCHDOG_INTERVAL_MS = 5000;
const RECONCILE_SETTLE_MS = 250;
const NOT_ALLOWED_MAX_RETRIES = 5;

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
 * Recovery model (mobile radio semantics):
 * - `wantsLocalPlayback` = user-level connect intent (Connect button / gesture autostart)
 * - `userPaused` = user explicitly paused (Disconnect or pause control) — the ONLY state we stay stopped in
 * - everything else (OS background pause, stall, network error, tab freeze) is recovered from
 *   automatically by rejoining the live edge: src reset (+ Firefox cache-bust) + play().
 * - Retries: exponential backoff 1s→8s, unlimited, reset once 'playing' fires.
 * @param {import('vue').Ref<HTMLAudioElement | null>} audioRef
 */
export function useLocalPlayback(audioRef) {
  const { playbackState } = usePlaybackState();
  const wantsLocalPlayback = ref(false);
  /** Mirrors the audio element's paused/ended state so Vue updates when OS / Media Session controls the element. */
  const localAudioPaused = ref(true);
  const storedVolume = readStoredLocalVolume();
  const localVolume = ref(storedVolume ?? DEFAULT_LOCAL_VOLUME);
  const isMuted = ref(localVolume.value <= 0);
  const previousVolumeBeforeMute = ref(localVolume.value > 0 ? localVolume.value : DEFAULT_LOCAL_VOLUME);

  // --- recovery state ---
  let userPaused = false;
  let sourceLoading = false;
  let rejoinAttempts = 0;
  let notAllowedRetries = 0;
  let rejoinTimer = null;
  let watchdogTimer = null;
  let watchdogLastCurrentTime = -1;

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
    return Boolean(audioRef.value && wantsLocalPlayback.value && !userPaused);
  }

  function streamUrlWithCacheBust(url) {
    // Firefox caches the downloaded live stream, which breaks rejoins.
    // A fresh URL per start bypasses the stale cache/buffer (AzuraCast pattern).
    if (!isFirefox()) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}refresh=${Date.now()}`;
  }

  /**
   * Rejoin the live edge: reset src (never recreate the element — reusing it
   * preserves the iOS audio session permission) and start playback.
   */
  async function rejoinLiveStream(reason = "rejoin") {
    const audio = audioRef.value;
    const streamUrl = playbackState.value?.stream_url;
    if (!audio || !streamUrl || !shouldRecover()) return;

    console.debug("[airwave] rejoin live stream", { reason, attempt: rejoinAttempts + 1 });
    sourceLoading = true;
    audio.removeAttribute("src");
    audio.load();
    audio.src = streamUrlWithCacheBust(streamUrl);
    applyAudioVolume();

    try {
      await audio.play();
    } catch (error) {
      // Classify the rejection instead of treating every failure as user stop.
      if (error?.name === "NotAllowedError") {
        // Autoplay policy: retry in the background (bounded) — mobile browsers
        // sometimes refuse a play() right after returning to the foreground.
        sourceLoading = false;
        syncLocalAudioPausedFromElement();
        if (notAllowedRetries < NOT_ALLOWED_MAX_RETRIES) {
          notAllowedRetries += 1;
          scheduleRejoin(REJOIN_BACKOFF_BASE_MS * notAllowedRetries);
        }
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

  const isLocalPlaybackActive = computed(() => {
    const local = localPlaybackStatus();
    return local.isLocalPlaybackActive && !local.isLocalPlaybackPaused;
  });

  const localPlaybackSessionDeps = computed(() => ({
    wantsLocal: wantsLocalPlayback.value,
    audioPaused: localAudioPaused.value,
  }));

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
    if (isMuted.value || localVolume.value <= 0) {
      const restoredVolume = previousVolumeBeforeMute.value > 0 ? previousVolumeBeforeMute.value : DEFAULT_LOCAL_VOLUME;
      localVolume.value = clampVolume(restoredVolume);
      isMuted.value = false;
      applyAudioVolume();
      writeStoredLocalVolume(localVolume.value);
      return;
    }

    previousVolumeBeforeMute.value = localVolume.value;
    localVolume.value = 0;
    isMuted.value = true;
    applyAudioVolume();
    writeStoredLocalVolume(0);
  }

  async function startLocalPlayback() {
    if (!audioRef.value || !playbackState.value.stream_url) return;

    wantsLocalPlayback.value = true;
    userPaused = false;
    rejoinAttempts = 0;
    clearRejoinTimer();

    sourceLoading = true;
    audioRef.value.src = streamUrlWithCacheBust(playbackState.value.stream_url);
    applyAudioVolume();

    try {
      await audioRef.value.play();
    } catch (error) {
      if (error?.name === "NotAllowedError") {
        // No user gesture yet — keep connect intent; gesture autostart or the
        // Connect button will retry. Do not flip to "stopped".
        sourceLoading = false;
        syncLocalAudioPausedFromElement();
        return;
      }
      if (error?.name !== "AbortError") {
        sourceLoading = false;
        scheduleRejoinWithBackoff();
        syncLocalAudioPausedFromElement();
        return;
      }
    }
    sourceLoading = false;
    syncLocalAudioPausedFromElement();
  }

  function stopLocalPlayback() {
    clearRejoinTimer();
    wantsLocalPlayback.value = false;
    userPaused = true;

    const audio = audioRef.value;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    syncLocalAudioPausedFromElement();
  }

  function pauseLocalPlayback() {
    if (!wantsLocalPlayback.value || !audioRef.value) return;
    userPaused = true;
    clearRejoinTimer();
    audioRef.value.pause();
    syncLocalAudioPausedFromElement();
  }

  function localPlaybackStatus() {
    const audio = audioRef.value;
    const active = wantsLocalPlayback.value;
    const paused = !audio || localAudioPaused.value;
    const playing = Boolean(audio && active && !paused);
    return {
      isLocalPlaybackActive: active,
      isLocalPlaybackPaused: paused,
      isLocalPlaybackPlaying: playing,
      // Intent view: connected AND not user-paused. Stays true through transient
      // recovery pauses so the Media Session notification keeps "playing".
      isLocalPlaybackIntended: active && !userPaused,
      isLocalPlaybackStopped: !active || !audio?.src,
    };
  }

  async function resumeLocalPlayback() {
    if (!wantsLocalPlayback.value || !audioRef.value || !playbackState.value.stream_url) return;

    userPaused = false;
    rejoinAttempts = 0;
    clearRejoinTimer();
    await rejoinLiveStream();
  }

  /**
   * Start playback automatically on the first user gesture anywhere in the app
   * (autoplay policy requires a gesture for audible playback).
   */
  function enableAutostartOnUserGesture() {
    if (typeof window === "undefined") return;
    const events = ["pointerdown", "keydown", "touchstart"];
    const onFirstGesture = () => {
      if (wantsLocalPlayback.value || !playbackState.value?.stream_url) return;
      void startLocalPlayback();
      if (wantsLocalPlayback.value) {
        for (const name of events) window.removeEventListener(name, onFirstGesture, true);
      }
    };
    for (const name of events) window.addEventListener(name, onFirstGesture, { capture: true });
  }

  function onAudioPause() {
    // A pause we did not request via userPaused/src-swap means the OS or the
    // element stopped us (background tab, interruption) — recover.
    syncLocalAudioPausedFromElement();
    if (!userPaused && !sourceLoading) maybeRecover("pause");
  }

  function onAudioError() {
    const audio = audioRef.value;
    const code = audio?.error?.code;
    // MediaError.NETWORK_ERROR === 2 — the only recoverable class for a live stream.
    if (code === 2 || code == null) {
      if (!userPaused) {
        rejoinAttempts = 0;
        scheduleRejoinWithBackoff();
      }
    } else {
      // Decode/src errors also recover via rejoin on a live stream (no seek possible).
      if (!userPaused) scheduleRejoinWithBackoff();
    }
  }

  function onAudioPlaying() {
    rejoinAttempts = 0;
    notAllowedRetries = 0;
    clearRejoinTimer();
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
    if (!userPaused && !sourceLoading && shouldRecover() && rejoinTimer == null) {
      console.debug("[airwave] stall event", eventName);
      rejoinAttempts = 0;
      scheduleRejoin(STALL_WATCHDOG_INTERVAL_MS);
    }
  }

  function runStallWatchdog() {
    const audio = audioRef.value;
    if (!audio || !shouldRecover() || userPaused) return;
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

  watch(
    () => playbackState.value.stream_url,
    async (newUrl) => {
      if (!newUrl) {
        stopLocalPlayback();
        return;
      }

      if (!wantsLocalPlayback.value || !audioRef.value) return;

      await rejoinLiveStream();
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
    clearRejoinTimer();
    if (watchdogTimer != null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (typeof window !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibleReconcile);
      window.removeEventListener("pageshow", onVisibleReconcile);
      document.removeEventListener("resume", onVisibleReconcile);
    }
    stopLocalPlayback();
  });

  return {
    startLocalPlayback,
    stopLocalPlayback,
    pauseLocalPlayback,
    resumeLocalPlayback,
    localPlaybackStatus,
    localPlaybackSessionDeps,
    isLocalPlaybackActive,
    enableAutostartOnUserGesture,
    localVolume,
    isMuted,
    setLocalVolume,
    toggleMuted,
  };
}
