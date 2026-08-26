import { watch } from "vue";

import { usePlaybackStore } from "../stores/playback";

const FALLBACK_ARTWORK_URL = "/web-app-manifest-192x192.png";
const ARTWORK_SIZES = [96, 128, 192, 256, 384, 512];
const DEFAULT_SKIP_TIME = 10;

function buildArtwork(thumbnailUrl: string | null): Array<{ src: string; sizes: string }> {
  const src = thumbnailUrl || FALLBACK_ARTWORK_URL;
  // No `type`: thumbnails are webp/jpeg from providers while the fallback is
  // png — declaring a wrong MIME makes strict browsers skip the artwork.
  return ARTWORK_SIZES.map((size) => ({
    src,
    sizes: `${size}x${size}`,
  }));
}

/**
 * OS media controls (lock screen / notification) mirror the in-app transport:
 * play/pause/stop toggle the shared SERVER stream; per-browser listening is
 * controlled separately via the local mute/volume UI.
 */
export function useMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }

  const playbackStore = usePlaybackStore();

  function updatePositionState(): void {
    if (!("setPositionState" in navigator.mediaSession)) return;

    const state = playbackStore.playbackState;
    const duration = Number(state?.duration_seconds);
    const position = Number(state?.elapsed_seconds ?? 0);

    if (!Number.isFinite(duration) || duration <= 0 || !state?.can_seek) return;

    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(Math.max(position, 0), duration),
      });
    } catch {
      // Position state may be unsupported or invalid
    }
  }

  function updateMetadata(): void {
    const state = playbackStore.playbackState;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: state?.now_playing_title || "Airwave",
      artist: state?.now_playing_channel || "",
      album: "",
      artwork: buildArtwork(state?.now_playing_thumbnail_url),
    });

    const isPlaying = state?.mode === "playing" && !state?.paused;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    updatePositionState();
  }

  navigator.mediaSession.setActionHandler("play", () => void playbackStore.togglePause());
  navigator.mediaSession.setActionHandler("pause", () => void playbackStore.togglePause());
  navigator.mediaSession.setActionHandler("previoustrack", () => void playbackStore.previousTrack());
  navigator.mediaSession.setActionHandler("nexttrack", () => void playbackStore.skipCurrent());

  navigator.mediaSession.setActionHandler("seekbackward", (event) => {
    const state = playbackStore.playbackState;
    const duration = Number(state?.duration_seconds);
    const elapsed = Number(state?.elapsed_seconds ?? 0);
    if (!Number.isFinite(duration) || duration <= 0 || !state?.can_seek) return;

    const skipTime = event?.seekOffset ?? DEFAULT_SKIP_TIME;
    const newPosition = Math.max(elapsed - skipTime, 0);
    void playbackStore.seekToPercent((newPosition / duration) * 100);
  });

  navigator.mediaSession.setActionHandler("seekforward", (event) => {
    const state = playbackStore.playbackState;
    const duration = Number(state?.duration_seconds);
    const elapsed = Number(state?.elapsed_seconds ?? 0);
    if (!Number.isFinite(duration) || duration <= 0 || !state?.can_seek) return;

    const skipTime = event?.seekOffset ?? DEFAULT_SKIP_TIME;
    const newPosition = Math.min(elapsed + skipTime, duration);
    void playbackStore.seekToPercent((newPosition / duration) * 100);
  });

  try {
    navigator.mediaSession.setActionHandler("seekto", (event) => {
      const state = playbackStore.playbackState;
      const duration = Number(state?.duration_seconds);
      if (!Number.isFinite(duration) || duration <= 0 || !state?.can_seek) return;
      if (event?.seekTime == null) return;

      const seekTime = Math.min(Math.max(Number(event.seekTime), 0), duration);
      void playbackStore.seekToPercent((seekTime / duration) * 100);
    });
  } catch {
    // seekto is not supported (e.g. Chrome < 78)
  }

  try {
    navigator.mediaSession.setActionHandler("stop", () => void playbackStore.togglePause());
  } catch {
    // stop is not supported (e.g. Chrome < 77)
  }

  watch(() => playbackStore.playbackState, updateMetadata, { immediate: true, deep: true });
}
