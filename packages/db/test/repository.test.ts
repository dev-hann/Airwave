/** Repository tests — port of the Python test_repository.py core invariants. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LIKED_SONGS_SOURCE_URL, Repository } from "../src/repository.js";

let dir: string;
let repo: Repository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "airwave-db-"));
  repo = new Repository(join(dir, "test.db"));
  repo.init();
});

afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

const item = (n: number) => ({
  sourceUrl: `https://u${n}`,
  normalizedUrl: `https://u${n}`,
  sourceType: "video",
  title: `Song ${n}`,
  provider: "youtube",
  providerItemId: `vid${n}`,
  durationSeconds: 200,
  thumbnailUrl: null,
  playlistId: null,
});

describe("init", () => {
  it("seeds the Liked Songs playlist exactly once", () => {
    const liked = repo.getPlaylistBySourceUrl(LIKED_SONGS_SOURCE_URL);
    expect(liked).not.toBeNull();
    expect(liked!.title).toBe("Liked Songs");
    expect(liked!.canEdit).toBe(false);
    expect(liked!.canDelete).toBe(false);
    repo.init(); // idempotent
    expect(repo.listPlaylists().filter((p) => p.sourceUrl === LIKED_SONGS_SOURCE_URL)).toHaveLength(1);
  });
});

describe("queue", () => {
  it("enqueue assigns sequential positions 1..n", () => {
    const created = repo.enqueueItems([item(1), item(2), item(3)]);
    expect(created.map((row) => row.queuePosition)).toEqual([1, 2, 3]);
  });

  it("dequeueNext promotes lowest-position queued item and demotes previous playing", () => {
    repo.enqueueItems([item(1), item(2)]);
    const first = repo.dequeueNext()!;
    expect(first.status).toBe("playing");
    expect(first.queuePosition).toBe(1);

    // Force a second playing row (self-healing scenario): requeue 1 then dequeue again.
    const requeued = repo.enqueueItems([item(1)])!;
    const second = repo.dequeueNext()!;
    expect(second.status).toBe("playing");
    const statuses = repo.listQueue().map((row) => row.status);
    expect(statuses.filter((s) => s === "playing")).toHaveLength(1);
    void requeued;
  });

  it("empty queue returns null", () => {
    expect(repo.dequeueNext()).toBeNull();
  });

  it("listQueuedIds respects position order", () => {
    repo.enqueueItems([item(1), item(2), item(3)]);
    expect(repo.listQueuedIds()).toEqual([1, 2, 3]);
  });

  it("removeItem deletes and reports", () => {
    const created = repo.enqueueItems([item(1)]);
    expect(repo.removeItem(created[0]!.id)).toBe(true);
    expect(repo.getItem(created[0]!.id)).toBeNull();
    expect(repo.removeItem(9999)).toBe(false);
  });

  it("moveItemToFront places item before current minimum", () => {
    const created = repo.enqueueItems([item(1), item(2), item(3)]);
    repo.moveItemToFront(created[2]!.id);
    const ids = repo.listQueue().map((row) => row.id);
    expect(ids.indexOf(created[2]!.id)).toBe(0);
  });

  it("reorderQueuedItems rewrites positions in given order", () => {
    const created = repo.enqueueItems([item(1), item(2), item(3)]);
    const order = [created[2]!.id, created[0]!.id, created[1]!.id];
    repo.reorderQueuedItems(order);
    expect(repo.listQueuedIds()).toEqual(order);
  });

  it("markItemResolved stores the stream URL", () => {
    const created = repo.enqueueItems([item(1)]);
    repo.markItemResolved(created[0]!.id, "http://resolved/stream");
    expect(repo.getItem(created[0]!.id)!.resolvedStreamUrl).toBe("http://resolved/stream");
  });
});

describe("history", () => {
  it("markPlaybackFinished writes queue status + history row together", () => {
    const created = repo.enqueueItems([item(1)]);
    repo.markPlaybackFinished(created[0]!.id, "completed");
    expect(repo.getItem(created[0]!.id)!.status).toBe("completed");
    const history = repo.listHistory(10);
    expect(history).toHaveLength(1);
    expect(history[0]!.queueItemId).toBe(created[0]!.id);
    expect(history[0]!.status).toBe("completed");
    expect(history[0]!.finishedAt).not.toBeNull();
  });

  it("failed status carries the error message", () => {
    const created = repo.enqueueItems([item(1)]);
    repo.markPlaybackFinished(created[0]!.id, "failed", "yt-dlp exploded");
    const row = repo.listHistory(1)[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("yt-dlp exploded");
  });

  it("clearHistory wipes rows", () => {
    const created = repo.enqueueItems([item(1)]);
    repo.markPlaybackFinished(created[0]!.id, "skipped");
    expect(repo.clearHistory()).toBeGreaterThanOrEqual(1);
    expect(repo.listHistory()).toHaveLength(0);
  });
});

describe("playlists", () => {
  it("custom playlist lifecycle", () => {
    const playlist = repo.createCustomPlaylist("Roadtrip");
    const entry = repo.addPlaylistEntry(playlist.id, {
      sourceUrl: "https://u1",
      normalizedUrl: "https://u1",
      title: "Song 1",
    });
    expect(entry).not.toBeNull();
    expect(entry!.position).toBe(1);
    expect(repo.getPlaylist(playlist.id)!.entryCount).toBe(1);

    repo.updatePlaylist(playlist.id, { title: "Roadtrip 2", pinned: true });
    const updated = repo.getPlaylist(playlist.id)!;
    expect(updated.title).toBe("Roadtrip 2");
    expect(updated.pinned).toBe(true);

    expect(repo.removePlaylistEntry(entry!.id)).toBe(true);
    expect(repo.getPlaylist(playlist.id)!.entryCount).toBe(0);
  });

  it("deletePlaylist nulls queue playlist references and removes entries", () => {
    const playlist = repo.createCustomPlaylist("Temp");
    repo.addPlaylistEntry(playlist.id, { sourceUrl: "https://u1", normalizedUrl: "https://u1" });
    const created = repo.enqueueItems([{ ...item(1), playlistId: playlist.id }]);
    expect(repo.getItem(created[0]!.id)!.playlistId).toBe(playlist.id);

    expect(repo.deletePlaylist(playlist.id)).toBe(true);
    expect(repo.getPlaylist(playlist.id)).toBeNull();
    expect(repo.getItem(created[0]!.id)!.playlistId).toBeNull();
    expect(repo.listPlaylistEntries(playlist.id)).toHaveLength(0);
  });

  it("playlistContainsTrack matches by normalized URL or provider item id", () => {
    const playlist = repo.createCustomPlaylist("Mix");
    repo.addPlaylistEntry(playlist.id, {
      sourceUrl: "https://youtu.be/abc",
      normalizedUrl: "https://www.youtube.com/watch?v=abc",
      providerItemId: "abc",
    });
    expect(repo.playlistContainsTrack(playlist.id, "https://www.youtube.com/watch?v=abc", null)).toBe(true);
    expect(repo.playlistContainsTrack(playlist.id, null, "abc")).toBe(true);
    expect(repo.playlistContainsTrack(playlist.id, "https://other", null)).toBe(false);
    expect(repo.playlistContainsTrack(playlist.id, null, null)).toBe(false);
  });
});

describe("settings", () => {
  it("get/set/clear roundtrip", () => {
    expect(repo.getSetting("k")).toBeNull();
    repo.setSetting("k", "v1");
    expect(repo.getSetting("k")).toBe("v1");
    repo.setSetting("k", "v2"); // upsert
    expect(repo.getSetting("k")).toBe("v2");
    repo.clearSetting("k");
    expect(repo.getSetting("k")).toBeNull();
  });
});
