/** Domain unit tests — direct port of tests/test_domain.py (47 cases). No fakes, no I/O, no waiting. */

import { describe, expect, it } from "vitest";

import {
  AttemptFacts,
  ATTEMPT_COMPLETED,
  ATTEMPT_PREMATURE_END,
  ATTEMPT_RETRY_FFMPEG,
  ATTEMPT_RETRY_SOURCE,
  classifyAttempt,
  completedUnusuallyFast,
  endedPrematurely,
  expectedDurationSeconds,
  initialPlaybackState,
  PLAYBACK_MODE_IDLE,
  newQueueItemFields,
  playbackProgress,
  REPEAT_OFF,
  replayItemFields,
  RepeatCycleItem,
  repeatCycleItemFrom,
  restoreOrder,
  secondsFromPercent,
  clampSeekSeconds,
  shuffledOrder,
  slowChunkRead,
  stderrIndicatesStreamFailure,
  TrackIdentity,
} from "@airwave/domain";

interface FakeRow extends TrackIdentity {}

const fakeRow = (overrides: Partial<FakeRow> = {}): FakeRow => ({
  sourceUrl: "https://s",
  provider: "youtube",
  providerItemId: "abc",
  normalizedUrl: "https://n",
  sourceType: "youtube",
  title: "Song",
  durationSeconds: 200,
  thumbnailUrl: "https://t",
  playlistId: "pl-7",
  ...overrides,
});

// ------------------------------------------------------------ outcome rules

describe("stderr failure markers", () => {
  it.each([
    ["[tls] Error in the pull function.\nInput/output error", true],
    ["Session has been invalidated", true],
    ["Connection reset by peer", true],
    ["read error 123", true],
    ["at end of file", true],
    ["", false],
    ["everything fine", false],
    [null, false],
    [undefined, false],
  ])("%j -> %s", (stderr, expected) => {
    expect(stderrIndicatesStreamFailure(stderr as string | null)).toBe(expected);
  });
});

describe("expected duration precedence", () => {
  it.each([
    [120, 100, 90, 120], // probe wins
    [null, 100, 90, 100], // source metadata next
    [null, null, 90, 90], // queue item last
    [null, null, null, 0], // nothing known
    [0, 100, 90, 100], // falsy probe skipped
    [0, 0, 0, 0], // all falsy
  ])("probed=%s resolved=%s queued=%s -> %s", (probed, resolved, queued, expected) => {
    expect(expectedDurationSeconds(probed, resolved, queued)).toBe(expected);
  });
});

describe("endedPrematurely", () => {
  it.each([
    [10, 200, true], // 5% of a long track
    [185, 200, false], // 92.5% — fine
    [180, 200, false], // exactly 90% boundary -> NOT premature (strict <)
    [5, 20, false], // short track: heuristic disabled
    [5, 0, false], // unknown duration
  ])("elapsed=%s duration=%s -> %s", (elapsed, duration, expected) => {
    expect(endedPrematurely(elapsed, duration)).toBe(expected);
  });
});

it("fast completion threshold", () => {
  expect(completedUnusuallyFast(10, 200)).toBe(true);
  expect(completedUnusuallyFast(100, 200)).toBe(false);
  expect(completedUnusuallyFast(1, 10)).toBe(false); // short track exempt
});

it("slow chunk read threshold", () => {
  expect(slowChunkRead(0.3)).toBe(true); // boundary inclusive
  expect(slowChunkRead(0.2999)).toBe(false);
  expect(slowChunkRead(0.5, 1.0)).toBe(false);
  expect(slowChunkRead(2.0, 1.0)).toBe(true); // custom threshold
});

// --------------------------------------------------------- attempt verdicts

const facts = (overrides: Partial<AttemptFacts> = {}): AttemptFacts => ({
  ffmpegReturnCode: 0,
  sourceReturnCode: 0,
  elapsedSeconds: 195,
  expectedSeconds: 200,
  stderrText: "",
  ...overrides,
});

it("completed verdict when healthy", () => {
  const verdict = classifyAttempt(facts());
  expect(verdict.outcome).toBe(ATTEMPT_COMPLETED);
  expect(verdict.reason).toBeNull();
});

it("ffmpeg nonzero exit always fails even with stderr failure", () => {
  const verdict = classifyAttempt(facts({ ffmpegReturnCode: 1, stderrText: "Input/output error" }));
  expect(verdict.outcome).toBe(ATTEMPT_RETRY_FFMPEG);
  expect(verdict.reason).toContain("status 1");
});

it("source nonzero exit fails", () => {
  expect(classifyAttempt(facts({ sourceReturnCode: 2 })).outcome).toBe(ATTEMPT_RETRY_SOURCE);
});

it("premature end requires both conditions", () => {
  // premature + failure stderr -> retryable
  expect(classifyAttempt(facts({ elapsedSeconds: 10, stderrText: "connection reset" })).outcome).toBe(ATTEMPT_PREMATURE_END);
  // premature but clean stderr -> completed (may be legit short)
  expect(classifyAttempt(facts({ elapsedSeconds: 10 })).outcome).toBe(ATTEMPT_COMPLETED);
  // failure stderr but full runtime -> completed
  expect(classifyAttempt(facts({ stderrText: "connection reset" })).outcome).toBe(ATTEMPT_COMPLETED);
});

it("null return codes treated as success", () => {
  expect(classifyAttempt(facts({ ffmpegReturnCode: null, sourceReturnCode: null })).outcome).toBe(ATTEMPT_COMPLETED);
});

// ---------------------------------------------------------------- progress

it("progress idle has no elapsed", () => {
  const out = playbackProgress(initialPlaybackState(), 1000);
  expect(out.elapsedSeconds).toBeNull();
  expect(out.progressPercent).toBeNull();
  expect(out.startedAt).toBeNull();
});

it("progress playing computes from startedAt", () => {
  const state = {
    ...initialPlaybackState(),
    mode: "playing" as const,
    startedAtEpochSeconds: 100,
    startedAtMonotonicSeconds: 900,
    nowPlayingDurationSeconds: 200,
  };
  const out = playbackProgress(state, 1000);
  expect(out.elapsedSeconds).toBeCloseTo(100);
  expect(out.progressPercent).toBeCloseTo(50);
  expect(out.startedAt).toBe(100);
});

it("progress paused uses frozen elapsed", () => {
  const state = {
    ...initialPlaybackState(),
    mode: "playing" as const,
    paused: true,
    pausedElapsedSeconds: 42,
    startedAtMonotonicSeconds: 900,
    nowPlayingDurationSeconds: 200,
  };
  // Wall clock advanced 500s but paused clock must not move.
  const out = playbackProgress(state, 1400);
  expect(out.elapsedSeconds).toBe(42);
  expect(out.progressPercent).toBeCloseTo(21);
});

it("progress never negative and caps at 100", () => {
  const state = {
    ...initialPlaybackState(),
    mode: "playing" as const,
    startedAtMonotonicSeconds: 1500,
    nowPlayingDurationSeconds: 100,
  };
  expect(playbackProgress(state, 1000).elapsedSeconds).toBe(0);
  const out = playbackProgress(state, 5000);
  expect(out.elapsedSeconds).toBe(3500);
  expect(out.progressPercent).toBe(100);
});

it("progress without duration still reports elapsed", () => {
  const state = { ...initialPlaybackState(), mode: "playing" as const, startedAtMonotonicSeconds: 0 };
  const out = playbackProgress(state, 33);
  expect(out.elapsedSeconds).toBe(33);
  expect(out.progressPercent).toBeNull();
});

it("progress without startedAt reports null", () => {
  const state = { ...initialPlaybackState(), mode: "playing" as const };
  expect(playbackProgress(state, 10).elapsedSeconds).toBeNull();
});

// ------------------------------------------------------------- repeat cycle

it("repeat cycle roundtrip preserves fields", () => {
  const item = repeatCycleItemFrom(fakeRow());
  expect(item).toBeInstanceOf(Object);
  const fields = newQueueItemFields(item);
  expect(fields.sourceUrl).toBe("https://s");
  expect(fields.provider).toBe("youtube");
  expect(fields.playlistId).toBe("pl-7");
  expect(Object.keys(fields).sort()).toEqual(
    [
      "durationSeconds",
      "normalizedUrl",
      "playlistId",
      "provider",
      "providerItemId",
      "sourceType",
      "sourceUrl",
      "thumbnailUrl",
      "title",
    ].sort(),
  );
});

it("repeat cycle defaults playlistId to null when absent", () => {
  const row = fakeRow();
  delete (row as Partial<FakeRow>).playlistId;
  expect(repeatCycleItemFrom(row).playlistId).toBeNull();
});

it("replay item coalesces missing source URL", () => {
  expect(replayItemFields(fakeRow({ sourceUrl: "" })).sourceUrl).toBe("unknown");
});

// ---------------------------------------------------------------------- seek

describe("secondsFromPercent", () => {
  it.each([
    [50, 200, 100],
    [0, 200, 0],
    [100, 200, 200],
    [150, 200, 200], // clamp high
    [-20, 200, 0], // clamp low
    [50, 0, 0], // unknown duration
    [50, null, 0],
  ])("%s%% of %s -> %s", (percent, duration, expected) => {
    expect(secondsFromPercent(percent, duration)).toBe(expected);
  });
});

it("clampSeekSeconds", () => {
  expect(clampSeekSeconds(-5, 200)).toBe(0);
  expect(clampSeekSeconds(500, 200)).toBe(200);
  expect(clampSeekSeconds(50, 200)).toBe(50);
  expect(clampSeekSeconds(999, null)).toBe(999); // no cap without duration
});

// ------------------------------------------------------------------- shuffle

it("shuffledOrder permutes deterministically with injected RNG and leaves input untouched", () => {
  const ids = [1, 2, 3, 4, 5];
  const rng = { shuffle: (list: number[]) => list.reverse() };
  expect(shuffledOrder(ids, rng)).toEqual([5, 4, 3, 2, 1]);
  expect(ids).toEqual([1, 2, 3, 4, 5]);
});

it("restoreOrder keeps only surviving ids in saved sequence", () => {
  expect(restoreOrder([3, 1, 2], [2, 1, 5])).toEqual([2, 1]);
  expect(restoreOrder([1], null)).toBeNull();
  expect(restoreOrder([1], [9, 9])).toBeNull(); // nothing survives
});

// -------------------------------------------------------------------- state

it("playback state defaults", () => {
  const state = initialPlaybackState();
  expect(state.mode).toBe(PLAYBACK_MODE_IDLE);
  expect(state.repeatMode).toBe(REPEAT_OFF);
  expect(state.shuffleEnabled).toBe(false);
  expect(state.nowPlayingId).toBeNull();
  expect(state.startedAtMonotonicSeconds).toBeNull();
});

// repeat-cycle items are plain frozen-ish objects (TS structural typing);
// guard the playlistId passthrough once more for parity with the Python frozen dataclass test.
it("repeat cycle item shape is a complete snapshot", () => {
  const original = fakeRow();
  const item: RepeatCycleItem = repeatCycleItemFrom(original);
  original.title = "mutated-after";
  expect(item.title).toBe("Song"); // snapshot copied, not aliased
});
