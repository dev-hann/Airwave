import { defineStore } from "pinia";
import { ref } from "vue";

import { PlaybackMode, RepeatMode } from "@airwave/shared";

import { postJson, fetchJson } from "../lib/api/http";
import type { PlaybackStateContract } from "../types/api";
import { useNotificationsStore } from "./notifications";

/** Placeholder before the first snapshot/REST state arrives. */
function initialPlaybackState(): PlaybackStateContract {
  return {
    mode: PlaybackMode.IDLE as PlaybackStateContract["mode"],
    paused: false,
    repeat_mode: RepeatMode.OFF as PlaybackStateContract["repeat_mode"],
    shuffle_enabled: false,
    can_seek: false,
    now_playing_title: null,
    now_playing_channel: null,
    now_playing_thumbnail_url: null,
    now_playing_is_live: false,
    now_playing_is_liked: false,
    now_playing_id: null,
    duration_seconds: null,
    elapsed_seconds: null,
    progress_percent: null,
    started_at: null,
    stream_url: "",
  };
}

let playbackTicker: ReturnType<typeof setInterval> | null = null;
let initialized = false;

export const usePlaybackStore = defineStore("playback", () => {
  const notifications = useNotificationsStore();

  const playbackState = ref<PlaybackStateContract>(initialPlaybackState());

  /**
   * Increments whenever a seek is accepted by the server. The audio element
   * watches this and rejoins the live edge: the server purges the HLS window
   * on a seek (new timeline), so the browser's buffered audio stalls after
   * draining — a rejoin is the only way playback continues at the new
   * position without a manual refresh.
   */
  const seekEpoch = ref(0);
  let seekPendingWhilePaused = false;

  function consumeSeekPending(): boolean {
    const pending = seekPendingWhilePaused;
    seekPendingWhilePaused = false;
    return pending;
  }

  function applyPlaybackState(nextState: PlaybackStateContract | null | undefined): void {
    if (!nextState || typeof nextState !== "object") return;
    const wasPaused = playbackState.value.paused;
    playbackState.value = nextState;
    // A seek issued while paused parks server-side; it commits on resume —
    // surface it as a seek event then so the audio element rejoins too.
    if (wasPaused && !nextState.paused && consumeSeekPending()) {
      seekEpoch.value += 1;
    }
  }

  function startPlaybackTicker(): void {
    if (playbackTicker) clearInterval(playbackTicker);
    playbackTicker = setInterval(() => {
      const state = playbackState.value;
      if (!state || state.mode !== "playing" || state.started_at == null || state.paused) return;
      const startedAt = Number(state.started_at);
      if (!Number.isFinite(startedAt)) return;
      const elapsed = Math.max(0, Date.now() / 1000 - startedAt);
      const duration = Number(state.duration_seconds);
      const progress =
        Number.isFinite(duration) && duration > 0 ? Math.min(100, (elapsed / duration) * 100) : null;
      playbackState.value = {
        ...state,
        elapsed_seconds: elapsed,
        progress_percent: progress,
      };
    }, 1000);
  }

  async function initializePlayback(): Promise<void> {
    if (!initialized) {
      initialized = true;
      startPlaybackTicker();
    }
    playbackState.value = await fetchJson<PlaybackStateContract>("/api/state");
  }

  async function skipCurrent(): Promise<void> {
    // Server-authoritative: the engine notifies (full WS push) when the
    // next pipeline is ready — no local preview, no rollback.
    try {
      await postJson("/api/queue/skip");
    } catch (error) {
      notifications.notifyError("Could not skip", error);
    }
  }

  async function previousTrack(): Promise<void> {
    try {
      await postJson("/api/playback/previous");
    } catch (error) {
      notifications.notifyError("Could not go back", error);
    }
  }

  async function togglePause(): Promise<void> {
    const isPaused = playbackState.value?.paused;
    const mode = playbackState.value?.mode;
    // Server-authoritative: pause/resume state arrives via the WS push.
    if (isPaused || mode === "idle") {
      try {
        await postJson("/api/playback/play");
      } catch (error) {
        notifications.notifyError("Could not resume", error);
      }
    } else {
      try {
        await postJson("/api/playback/toggle-pause");
      } catch (error) {
        notifications.notifyError("Could not pause", error);
      }
    }
  }

  async function setRepeatMode(mode: PlaybackStateContract["repeat_mode"]): Promise<void> {
    try {
      await postJson("/api/playback/repeat", { mode });
    } catch (error) {
      notifications.notifyError("Could not change repeat mode", error);
    }
  }

  async function setShuffleEnabled(enabled: boolean): Promise<void> {
    try {
      await postJson("/api/playback/shuffle", { enabled });
    } catch (error) {
      notifications.notifyError("Could not change shuffle", error);
    }
  }

  async function seekToPercent(percent: number): Promise<void> {
    try {
      const result = await postJson<{ ok?: boolean }>("/api/playback/seek", { percent });
      // HTTP 200 with ok:false = engine refused (idle, no duration, live) —
      // surface it instead of silently doing nothing.
      if (result && result.ok === false) {
        notifications.notifyError("Could not seek", new Error("Track is not seekable right now"));
        return;
      }
      if (playbackState.value.paused) {
        // The engine parks the target server-side; emit the seek event when
        // playback resumes (applyPlaybackState handles the transition).
        seekPendingWhilePaused = true;
      } else {
        seekEpoch.value += 1;
      }
    } catch (error) {
      notifications.notifyError("Could not seek track", error);
    }
  }

  async function likeCurrentSong(): Promise<void> {
    try {
      const result = await postJson<{ skipped_duplicates?: boolean }>("/api/state/like");
      if (result?.skipped_duplicates) {
        notifications.notifySuccess("Already liked", "This track is already in Liked Songs.");
      } else {
        notifications.notifySuccess("Liked", "Added to Liked Songs.");
      }
      // state (now_playing_is_liked, playlists) arrives via the WS push.
    } catch (error) {
      notifications.notifyError("Could not like song", error);
    }
  }

  async function unlikeCurrentSong(): Promise<void> {
    try {
      const result = await postJson<{ removed?: number }>("/api/state/unlike");
      if ((result?.removed ?? 0) > 0) {
        notifications.notifySuccess("Unliked", "Removed from Liked Songs.");
      } else {
        notifications.notifySuccess("Not in Liked Songs", "This track was not in Liked Songs.");
      }
      // state + playlists arrive via the WS push.
    } catch (error) {
      notifications.notifyError("Could not unlike song", error);
    }
  }

  async function toggleLikeCurrentSong(): Promise<void> {
    if (playbackState.value?.now_playing_is_liked) return unlikeCurrentSong();
    return likeCurrentSong();
  }

  return {
    playbackState,
    applyPlaybackState,
    initializePlayback,
    skipCurrent,
    previousTrack,
    togglePause,
    setRepeatMode,
    setShuffleEnabled,
    seekToPercent,
    seekEpoch,
    likeCurrentSong,
    unlikeCurrentSong,
    toggleLikeCurrentSong,
  };
});
