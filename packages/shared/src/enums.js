/**
 * Shared enums mirrored from the Python domain (app/domain/playback_state.py).
 *
 * These are hand-maintained duplicates BY DESIGN: Python is the source of
 * truth; the OpenAPI-generated types (src/generated/schema.d.ts) cover wire
 * payloads, while these constants give the frontend importable values for
 * the string unions. When changing a Python enum, update this file in the
 * same commit (the golden-fixture tests guard the wire format).
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
