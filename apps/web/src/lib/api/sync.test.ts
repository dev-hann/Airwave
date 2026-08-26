import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { applySnapshot } from "./sync";
import { useHistoryStore } from "../../stores/history";
import { usePlaybackStore } from "../../stores/playback";
import { usePlaylistsStore } from "../../stores/playlists";
import { useQueueStore } from "../../stores/queue";
import type { Playlist } from "../../types/api";

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    queue: [{ id: 1, source_url: "https://a", title: "A", status: "queued" }],
    history: [{ id: 9, source_url: "https://h", title: "H" }],
    playlists: [{ id: "p1", title: "P1", kind: "custom" }] as unknown as Playlist[],
    state: {
      can_seek: false,
      duration_seconds: null,
      elapsed_seconds: null,
      mode: "playing",
      now_playing_channel: null,
      now_playing_id: 1,
      now_playing_is_liked: false,
      now_playing_is_live: false,
      now_playing_thumbnail_url: null,
      now_playing_title: "A",
      paused: false,
      progress_percent: null,
      repeat_mode: "off",
      shuffle_enabled: false,
      started_at: 100,
      stream_url: "/stream/live.m3u8",
    },
    timestamp: 1,
    ...overrides,
  } as unknown as Parameters<typeof applySnapshot>[0];
}

describe("applySnapshot", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("replaces queue, history, playlists and playback state wholesale", () => {
    applySnapshot(makeSnapshot());

    const queueStore = useQueueStore();
    const historyStore = useHistoryStore();
    const playlistsStore = usePlaylistsStore();
    const playbackStore = usePlaybackStore();

    expect(queueStore.queue).toHaveLength(1);
    expect(queueStore.queue[0]!.title).toBe("A");
    expect(historyStore.history).toHaveLength(1);
    expect(playlistsStore.playlists).toHaveLength(1);
    expect(playlistsStore.playlists[0]!.title).toBe("P1");
    expect(playbackStore.playbackState.mode).toBe("playing");
    expect(playbackStore.playbackState.now_playing_title).toBe("A");
  });

  it("keeps existing state when snapshot fields are missing", () => {
    const queueStore = useQueueStore();
    queueStore.queue = [{ id: 7, source_url: "https://old", title: "Old", status: "playing" }] as never;

    applySnapshot(makeSnapshot({ queue: undefined, history: undefined, playlists: undefined, state: undefined }));

    expect(queueStore.queue).toHaveLength(1);
    expect(queueStore.queue[0]!.title).toBe("Old");
  });

  it("ignores non-object snapshots", () => {
    expect(() => applySnapshot(null as unknown as Parameters<typeof applySnapshot>[0])).not.toThrow();
  });
});
