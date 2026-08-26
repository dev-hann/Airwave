/**
 * Shared playback enum constants.
 *
 * The canonical string unions live in contracts.ts (zod: RepeatModeSchema /
 * PlaybackModeSchema); these frozen objects give the frontend importable
 * VALUES (not just types). Keep in sync with contracts.ts in the same commit.
 */

/** @enum {string} */
export const RepeatMode = Object.freeze({
  OFF: "off",
  ALL: "all",
  ONE: "one",
});

/** @enum {string} */
export const PlaybackMode = Object.freeze({
  IDLE: "idle",
  PLAYING: "playing",
});

/**
 * @typedef {"off"|"all"|"one"} RepeatModeValue
 * @typedef {"idle"|"playing"} PlaybackModeValue
 */
