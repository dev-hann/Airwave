/**
 * Domain layer (pure TypeScript, zero dependencies).
 *
 * Ported from the Python app/domain package (clean-architecture migration);
 * same rules apply: no I/O, no wall clock, no framework imports. Time and
 * randomness arrive as arguments. Shared by the Node server and the web
 * client — this is the single source of truth for playback rules.
 */

export const PLAYBACK_MODE_IDLE = "idle" as const;
export const PLAYBACK_MODE_PLAYING = "playing" as const;
export type PlaybackModeValue = typeof PLAYBACK_MODE_IDLE | typeof PLAYBACK_MODE_PLAYING;

export const REPEAT_OFF = "off" as const;
export const REPEAT_ALL = "all" as const;
export const REPEAT_ONE = "one" as const;
export type RepeatModeValue = typeof REPEAT_OFF | typeof REPEAT_ALL | typeof REPEAT_ONE;

export interface PlaybackState {
  mode: PlaybackModeValue;
  nowPlayingId: number | null;
  nowPlayingTitle: string | null;
  nowPlayingChannel: string | null;
  nowPlayingThumbnailUrl: string | null;
  nowPlayingDurationSeconds: number | null;
  nowPlayingIsLive: boolean;
  startedAtEpochSeconds: number | null;
  startedAtMonotonicSeconds: number | null;
  paused: boolean;
  /** True from the moment a track is chosen until its audio pipeline spawns. */
  loading: boolean;
  pausedElapsedSeconds: number | null;
  repeatMode: RepeatModeValue;
  shuffleEnabled: boolean;
}

export function initialPlaybackState(): PlaybackState {
  return {
    mode: PLAYBACK_MODE_IDLE,
    nowPlayingId: null,
    nowPlayingTitle: null,
    nowPlayingChannel: null,
    nowPlayingThumbnailUrl: null,
    nowPlayingDurationSeconds: null,
    nowPlayingIsLive: false,
    startedAtEpochSeconds: null,
    startedAtMonotonicSeconds: null,
    paused: false,
    loading: false,
    pausedElapsedSeconds: null,
    repeatMode: REPEAT_OFF,
    shuffleEnabled: false,
  };
}
