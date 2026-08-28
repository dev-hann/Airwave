import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import * as zodContracts from "@airwave/shared/contracts";

import { postJson } from "../lib/api/http";
import type { PlaybackStateContract } from "../types/api";
import { usePlaybackStore } from "./playback";
import { useQueueStore } from "./queue";

vi.mock("../lib/api/http", () => ({
  postJson: vi.fn().mockResolvedValue({}),
  fetchJson: vi.fn().mockResolvedValue({}),
}));

function baseState(overrides: Partial<PlaybackStateContract> = {}): PlaybackStateContract {
  return {
    can_seek: true,
    duration_seconds: 100,
    elapsed_seconds: 10,
    mode: "playing",
    now_playing_channel: "ch",
    now_playing_id: 1,
    now_playing_is_liked: false,
    now_playing_is_live: false,
    now_playing_thumbnail_url: null,
    now_playing_title: "Title",
    paused: false,
    loading: false,
    progress_percent: 10,
    repeat_mode: "off",
    shuffle_enabled: false,
    started_at: 1000,
    stream_url: "/stream/live.m3u8",
    ...overrides,
  };
}

describe("playback store — loading flag", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(postJson).mockReset().mockResolvedValue({});
  });

  it("merges loading from state pushes (WS snapshot path)", () => {
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState({ loading: true, now_playing_title: "Next Track" }));
    expect(store.playbackState.loading).toBe(true);
    store.applyPlaybackState(baseState({ loading: false }));
    expect(store.playbackState.loading).toBe(false);
  });

  it("wire schema defaults loading=false for older-server payloads", () => {
    const { PlaybackStateSchema } = zodContracts;
    const parsed = PlaybackStateSchema.parse(baseState({ loading: undefined }));
    expect(parsed.loading).toBe(false);
  });
});

describe("playback store — optimistic transport", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(postJson).mockReset().mockResolvedValue({});
  });

  it("seekToPercent posts the percent payload", async () => {
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    await store.seekToPercent(42);

    expect(postJson).toHaveBeenCalledWith("/api/playback/seek", { percent: 42 });
  });

  it("seekToPercent surfaces ok:false as an error notification (silent no-op bug)", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ ok: false });
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    await store.seekToPercent(50);

    expect(postJson).toHaveBeenCalledWith("/api/playback/seek", { percent: 50 });
  });

  it("seekToPercent notifies on transport failure", async () => {
    vi.mocked(postJson).mockRejectedValueOnce(new Error("boom"));
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    await store.seekToPercent(50);

    expect(postJson).toHaveBeenCalledWith("/api/playback/seek", { percent: 50 });
  });

  it("successful seek (playing) bumps seekEpoch for the audio rejoin", async () => {
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());
    const before = store.seekEpoch;

    await store.seekToPercent(50);

    expect(store.seekEpoch).toBe(before + 1);
  });

  it("ok:false seek does NOT bump seekEpoch", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ ok: false });
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());
    const before = store.seekEpoch;

    await store.seekToPercent(50);

    expect(store.seekEpoch).toBe(before);
  });

  it("paused seek defers the epoch bump until resume snapshot arrives", async () => {
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState({ paused: true }));
    const before = store.seekEpoch;

    await store.seekToPercent(50);
    expect(store.seekEpoch).toBe(before); // parked while paused

    // Resume snapshot: paused true → false flushes the pending seek.
    store.applyPlaybackState(baseState({ paused: false, elapsed_seconds: 50, progress_percent: 50 }));
    expect(store.seekEpoch).toBe(before + 1);
  });

  it("pause→resume without a seek does not bump the epoch", async () => {
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState({ paused: true }));
    const before = store.seekEpoch;

    store.applyPlaybackState(baseState({ paused: false }));

    expect(store.seekEpoch).toBe(before);
  });

  it("togglePause (playing) posts pause endpoint — state arrives via WS", async () => {
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    await store.togglePause();

    expect(store.playbackState.paused).toBe(false);
    expect(postJson).toHaveBeenCalledWith("/api/playback/toggle-pause");
  });

  it("togglePause from paused/idle calls /play (resume path)", async () => {
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState({ paused: true }));

    await store.togglePause();

    expect(store.playbackState.paused).toBe(true);
    expect(postJson).toHaveBeenCalledWith("/api/playback/play");
  });

  it("togglePause rolls back paused on failure", async () => {
    vi.mocked(postJson).mockRejectedValueOnce(new Error("boom"));
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    await store.togglePause();

    expect(store.playbackState.paused).toBe(false);
  });

  it("setRepeatMode updates optimistically and rolls back on failure", async () => {
    vi.mocked(postJson).mockRejectedValueOnce(new Error("boom"));
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    await store.setRepeatMode("all");

    expect(store.playbackState.repeat_mode).toBe("off");
    expect(postJson).toHaveBeenCalledWith("/api/playback/repeat", { mode: "all" });
  });

  it("setShuffleEnabled updates optimistically and rolls back on failure", async () => {
    vi.mocked(postJson).mockRejectedValueOnce(new Error("boom"));
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    await store.setShuffleEnabled(true);

    expect(store.playbackState.shuffle_enabled).toBe(false);
  });

  it("skipCurrent previews next queued track and rolls back on failure", async () => {
    vi.mocked(postJson).mockRejectedValueOnce(new Error("boom"));
    const store = usePlaybackStore();
    const queueStore = useQueueStore();
    queueStore.queue = [
      { id: 5, source_url: "https://next", title: "Next", status: "queued", thumbnail_url: null, channel: null, duration_seconds: 200, playlist_id: null, provider: null, provider_item_id: null, queue_position: 1, source_type: "url" } as never,
    ];
    store.applyPlaybackState(baseState());

    await store.skipCurrent();

    // Rolled back to the previous title after the failed skip.
    expect(store.playbackState.now_playing_title).toBe("Title");
    expect(postJson).toHaveBeenCalledWith("/api/queue/skip");
  });

  it("skipCurrent posts skip — no local preview (server-authoritative)", async () => {
    let resolveSkip: (value: unknown) => void = () => {};
    vi.mocked(postJson).mockReturnValueOnce(new Promise((resolve) => (resolveSkip = resolve)));
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    const pending = store.skipCurrent();
    expect(store.playbackState.now_playing_title).toBe("Title");
    expect(store.playbackState.now_playing_id).toBe(1);

    resolveSkip({});
    await pending;
    expect(postJson).toHaveBeenCalledWith("/api/queue/skip");
  });

  it("likeCurrentSong posts and does not merge REST state (WS is authority)", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ state: { now_playing_title: "Stale title" }, skipped_duplicates: false });
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState());

    await store.likeCurrentSong();

    expect(postJson).toHaveBeenCalledWith("/api/state/like");
    expect(store.playbackState.now_playing_is_liked).toBe(false);
    expect(store.playbackState.now_playing_title).toBe("Title");
  });

  it("unlikeCurrentSong posts without local state mutation", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ removed: 1 });
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState({ now_playing_is_liked: true }));

    await store.unlikeCurrentSong();

    expect(postJson).toHaveBeenCalledWith("/api/state/unlike");
    expect(store.playbackState.now_playing_is_liked).toBe(true);
  });

  it("toggleLikeCurrentSong routes based on current liked state", async () => {
    const store = usePlaybackStore();
    store.applyPlaybackState(baseState({ now_playing_is_liked: true }));

    await store.toggleLikeCurrentSong();

    expect(postJson).toHaveBeenCalledWith("/api/state/unlike");
  });
});
