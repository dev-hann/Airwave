import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { postJson } from "../lib/api/http";
import { usePlaylistsStore } from "./playlists";

vi.mock("../lib/api/http", () => ({
  postJson: vi.fn().mockResolvedValue({}),
  fetchJson: vi.fn().mockResolvedValue([]),
  patchJson: vi.fn().mockResolvedValue({}),
  deleteJson: vi.fn().mockResolvedValue(null),
}));

describe("playlists store — withDuplicateCheck flow", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(postJson).mockReset().mockResolvedValue({});
  });

  it("immediate path: no duplicates → success toast, no modal", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ has_duplicates: false, count: 3 });
    const store = usePlaylistsStore();

    await store.addUrlToPlaylist("pid", "https://x");

    expect(postJson).toHaveBeenCalledWith("/api/playlists/pid/entries", {
      url: "https://x",
      import_mode: "check",
    });
    expect(store.duplicateModal.open).toBe(false);
  });

  it("duplicate path: opens modal with target title", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({
      has_duplicates: true,
      target_playlist_title: "My Playlist",
      total: 5,
    });
    const store = usePlaylistsStore();

    await store.addUrlToPlaylist("pid", "https://x");

    expect(store.duplicateModal.open).toBe(true);
    expect(store.duplicateModal.targetPlaylistTitle).toBe("My Playlist");
  });

  it("confirmDuplicateAddAll runs the add_all request with the same body", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ has_duplicates: true, target_playlist_title: "T" });
    const store = usePlaylistsStore();
    await store.addUrlToPlaylist("pid", "https://x");

    vi.mocked(postJson).mockResolvedValueOnce({ count: 5 });
    await store.confirmDuplicateAddAll();

    expect(postJson).toHaveBeenLastCalledWith("/api/playlists/pid/entries", {
      url: "https://x",
      import_mode: "add_all",
    });
    expect(store.duplicateModal.open).toBe(false);
  });

  it("confirmDuplicateAddNewOnes runs skip_duplicates", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ has_duplicates: true, target_playlist_title: "T" });
    const store = usePlaylistsStore();
    await store.addUrlToPlaylist("pid", "https://x");

    vi.mocked(postJson).mockResolvedValueOnce({ skipped_duplicates: true, count: 0 });
    await store.confirmDuplicateAddNewOnes();

    expect(postJson).toHaveBeenLastCalledWith("/api/playlists/pid/entries", {
      url: "https://x",
      import_mode: "skip_duplicates",
    });
  });

  it("batch entries flow calls onComplete after immediate success", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ has_duplicates: false, count: 2 });
    const store = usePlaylistsStore();
    const onComplete = vi.fn();

    await store.addEntriesToPlaylist(
      "pid",
      [{ source_url: "https://a" }, { source_url: "https://b" }],
      { onComplete },
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith("/api/playlists/pid/entries/batch", {
      entries: [
        expect.objectContaining({ source_url: "https://a", normalized_url: "https://a" }),
        expect.objectContaining({ source_url: "https://b" }),
      ],
      import_mode: "check",
    });
  });

  it("batch entries flow calls onComplete after modal confirm", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ has_duplicates: true, target_playlist_title: "T" });
    const store = usePlaylistsStore();
    const onComplete = vi.fn();

    await store.addEntriesToPlaylist("pid", [{ source_url: "https://a" }], { onComplete });
    expect(onComplete).not.toHaveBeenCalled();

    vi.mocked(postJson).mockResolvedValueOnce({ count: 1 });
    await store.confirmDuplicateAddAll();

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("local folder flow passes path+recursive in the body", async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ has_duplicates: false, count: 4 });
    const store = usePlaylistsStore();

    await store.addLocalFolderToPlaylist("pid", "/mnt/music", { recursive: false });

    expect(postJson).toHaveBeenCalledWith("/api/playlists/pid/entries/local-folder", {
      path: "/mnt/music",
      recursive: false,
      import_mode: "check",
    });
  });

  it("createPlaylist prepends and dedupes by id", async () => {
    const created = { id: "new", title: "New", kind: "custom" as const };
    vi.mocked(postJson).mockResolvedValueOnce(created);
    const store = usePlaylistsStore();
    store.playlists = [{ ...created, title: "Old copy" }] as never;

    const result = await store.createPlaylist("New");

    expect(result?.id).toBe("new");
    expect(store.playlists).toHaveLength(1);
    expect(store.playlists[0]!.title).toBe("New");
  });

  it("importPlaylistIntoPlaylist skips when no target id", async () => {
    await usePlaylistsStore().importPlaylistIntoPlaylist("https://x", "");
    expect(postJson).not.toHaveBeenCalled();
  });
});
