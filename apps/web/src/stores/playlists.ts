import { defineStore } from "pinia";
import { ref } from "vue";
import type { Router } from "vue-router";

import { deleteJson, fetchJson, patchJson, postJson } from "../lib/api/http";
import type { Playlist, PlaylistEntry } from "../types/api";
import { useNotificationsStore } from "./notifications";

/** Common shape of "check" responses from add/import endpoints. */
interface DuplicateCheckResult {
  has_duplicates?: boolean;
  target_playlist_title?: string | null;
  count?: number;
  total?: number;
  new_count?: number;
  skipped_duplicates?: boolean;
  skipped?: number;
}

interface SpotifyImportStartResult {
  playlist_id?: string;
}

interface BatchEntryInput {
  source_url: string;
  normalized_url: string;
  provider: string | null;
  provider_item_id: string | null;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
}

type DuplicateConfirm = () => Promise<void>;

interface DuplicateModalState {
  open: boolean;
  targetPlaylistTitle: string;
  pendingAddAll: DuplicateConfirm | null;
  pendingAddNewOnes: DuplicateConfirm | null;
}

export const usePlaylistsStore = defineStore("playlists", () => {
  const notifications = useNotificationsStore();

  const playlists = ref<Playlist[]>([]);
  const duplicateModal = ref<DuplicateModalState>({
    open: false,
    targetPlaylistTitle: "",
    pendingAddAll: null,
    pendingAddNewOnes: null,
  });

  async function refreshPlaylists(): Promise<void> {
    playlists.value = await fetchJson<Playlist[]>("/api/playlists");
  }

  function setPlaylists(next: Playlist[]): void {
    playlists.value = next;
  }

  function showDuplicateModal(options: {
    targetPlaylistTitle?: string | null;
    onAddAll: DuplicateConfirm;
    onAddNewOnes: DuplicateConfirm;
  }): void {
    duplicateModal.value = {
      open: true,
      targetPlaylistTitle: options.targetPlaylistTitle || "Untitled playlist",
      pendingAddAll: options.onAddAll,
      pendingAddNewOnes: options.onAddNewOnes,
    };
  }

  function closeDuplicateModal(): void {
    duplicateModal.value = {
      open: false,
      targetPlaylistTitle: "",
      pendingAddAll: null,
      pendingAddNewOnes: null,
    };
  }

  async function confirmDuplicateAddAll(): Promise<void> {
    const fn = duplicateModal.value.pendingAddAll;
    closeDuplicateModal();
    if (fn) await fn();
  }

  async function confirmDuplicateAddNewOnes(): Promise<void> {
    const fn = duplicateModal.value.pendingAddNewOnes;
    closeDuplicateModal();
    if (fn) await fn();
  }

  /**
   * Shared duplicate-check flow (glossary: "Duplicate check"): POST the body
   * with `import_mode: "check"`; if the server reports duplicates, open the
   * duplicate modal with confirm callbacks that re-run the request with
   * `add_all` / `skip_duplicates`. Collapses the five former copy-pasted
   * call sites (ADR-0004).
   */
  async function withDuplicateCheck<B extends object, R extends DuplicateCheckResult>(
    url: string,
    baseBody: B,
    toasts: {
      addAll: (result: R, check: R) => void;
      addNew: (result: R) => void;
      immediate: (check: R) => void;
    },
    errorTitle: string,
    onComplete?: () => void,
  ): Promise<void> {
    const complete = typeof onComplete === "function" ? onComplete : undefined;
    try {
      const check = await postJson<R>(url, { ...baseBody, import_mode: "check" });
      if (check?.has_duplicates) {
        showDuplicateModal({
          targetPlaylistTitle: check.target_playlist_title,
          onAddAll: async () => {
            const result = await postJson<R>(url, { ...baseBody, import_mode: "add_all" });
            toasts.addAll(result, check);
            complete?.();
          },
          onAddNewOnes: async () => {
            const result = await postJson<R>(url, { ...baseBody, import_mode: "skip_duplicates" });
            toasts.addNew(result);
            complete?.();
          },
        });
      } else {
        toasts.immediate(check);
        complete?.();
      }
    } catch (error) {
      notifications.notifyError(errorTitle, error);
    }
  }

  async function importPlaylistUrl(url: string): Promise<void> {
    try {
      const result = await postJson<DuplicateCheckResult>("/api/playlist/import", { url });
      notifications.notifySuccess("Playlist imported", `${result.count || 0} items saved to playlist library.`);
    } catch (error) {
      notifications.notifyError("Could not import playlist", error);
    }
  }

  async function startSpotifyImportFromUrl(url: string, router?: Router): Promise<void> {
    try {
      const result = await postJson<SpotifyImportStartResult>("/api/spotify/import", { url });
      const pid = result?.playlist_id;
      if (pid && router) {
        notifications.notifySuccess("Spotify playlist", "Matching tracks from providers…");
        await router.push(`/spotify-import/${pid}`);
      }
    } catch (error) {
      notifications.notifyError("Could not import Spotify playlist", error);
    }
  }

  async function importPlaylistIntoPlaylist(url: string, targetPlaylistId: string): Promise<void> {
    if (!targetPlaylistId) return;
    await withDuplicateCheck<{ url: string; target_playlist_id: string }, DuplicateCheckResult>(
      "/api/playlist/import",
      { url, target_playlist_id: targetPlaylistId },
      {
        addAll: (r, check) =>
          notifications.notifySuccess("Playlist imported", `${r.count ?? check.total ?? 0} items added to playlist.`),
        addNew: (r) => {
          if (r?.skipped_duplicates && r?.count === 0) {
            notifications.notifySuccess("Already added", "All items are already in the playlist.");
          } else {
            notifications.notifySuccess("Playlist imported", `${r.count ?? r.new_count ?? 0} new items added.`);
          }
        },
        immediate: (check) =>
          notifications.notifySuccess("Playlist imported", `${check.count || 0} items added to playlist.`),
      },
      "Could not import playlist",
    );
  }

  async function addUrlToPlaylist(playlistId: string, url: string): Promise<void> {
    await withDuplicateCheck<{ url: string }, DuplicateCheckResult>(
      `/api/playlists/${playlistId}/entries`,
      { url },
      {
        addAll: () => notifications.notifySuccess("Saved to playlist", "Item added to playlist."),
        addNew: (r) => {
          if (r?.skipped_duplicates) {
            notifications.notifySuccess("Already added", "This item is already in the playlist.");
          } else {
            notifications.notifySuccess("Saved to playlist", "Item added to playlist.");
          }
        },
        immediate: () => notifications.notifySuccess("Saved to playlist", "Item added to playlist."),
      },
      "Could not save to playlist",
    );
  }

  async function addEntriesToPlaylist(
    playlistId: string,
    entries: Array<Partial<PlaylistEntry> & { source_url: string }>,
    options: { onComplete?: () => void } = {},
  ): Promise<void> {
    if (!playlistId || !entries?.length) return;
    const payload: BatchEntryInput[] = entries.map((e) => ({
      source_url: e.source_url,
      normalized_url: e.normalized_url ?? e.source_url,
      provider: e.provider ?? null,
      provider_item_id: e.provider_item_id ?? null,
      title: e.title ?? null,
      channel: e.channel ?? null,
      duration_seconds: e.duration_seconds ?? null,
      thumbnail_url: e.thumbnail_url ?? null,
    }));
    await withDuplicateCheck<{ entries: BatchEntryInput[] }, DuplicateCheckResult>(
      `/api/playlists/${playlistId}/entries/batch`,
      { entries: payload },
      {
        addAll: (r) => notifications.notifySuccess("Added to playlist", `${r.count ?? 0} items added.`),
        addNew: (r) => {
          if (r?.skipped_duplicates && r?.count === 0) {
            notifications.notifySuccess("Already added", "All items are already in the playlist.");
          } else {
            notifications.notifySuccess("Added to playlist", `${r.count ?? 0} new items added.`);
          }
        },
        immediate: (check) =>
          notifications.notifySuccess("Added to playlist", `${check?.count ?? entries.length} items added.`),
      },
      "Could not add to playlist",
      options.onComplete,
    );
  }

  async function createPlaylist(title: string): Promise<Playlist | null> {
    try {
      const created = await postJson<Playlist>("/api/playlists/custom", { title });
      playlists.value = [created, ...playlists.value.filter((playlist) => playlist.id !== created.id)];
      notifications.notifySuccess("Playlist created", title);
      return created;
    } catch (error) {
      notifications.notifyError("Could not create playlist", error);
      return null;
    }
  }

  async function removeFromPlaylist(entryId: number): Promise<void> {
    try {
      await deleteJson(`/api/playlists/entries/${entryId}`);
      await refreshPlaylists();
      notifications.notifySuccess("Removed from playlist", "Item removed from playlist.");
    } catch (error) {
      notifications.notifyError("Could not remove from playlist", error);
    }
  }

  async function queuePlaylist(playlistId: string): Promise<void> {
    try {
      await postJson(`/api/playlists/${playlistId}/queue`);
      notifications.notifySuccess("Playlist queued", "Items added to queue.");
    } catch (error) {
      notifications.notifyError("Could not queue playlist", error);
    }
  }

  async function playPlaylistNow(playlistId: string): Promise<void> {
    try {
      await postJson(`/api/playlists/${playlistId}/play-now`);
      notifications.notifySuccess("Playing now", "Playlist queued and playback started.");
    } catch (error) {
      notifications.notifyError("Could not play playlist", error);
    }
  }

  async function updatePlaylist(
    playlistId: string,
    fields: {
      title?: string;
      description?: string;
      pinned?: boolean;
      sync_enabled?: boolean;
      sync_remove_missing?: boolean;
    },
    options: { notify?: boolean } = {},
  ): Promise<Playlist | null> {
    const { notify = true } = options;
    try {
      const body: Record<string, unknown> = {};
      if (fields.title !== undefined) body.title = fields.title.trim();
      if (fields.description !== undefined) body.description = fields.description.trim();
      if (fields.pinned !== undefined) body.pinned = !!fields.pinned;
      if (fields.sync_enabled !== undefined) body.sync_enabled = !!fields.sync_enabled;
      if (fields.sync_remove_missing !== undefined) body.sync_remove_missing = !!fields.sync_remove_missing;
      if (Object.keys(body).length === 0) return null;
      const updated = await patchJson<Playlist>(`/api/playlists/${playlistId}`, body);
      await refreshPlaylists();
      if (notify) notifications.notifySuccess("Playlist updated");
      return updated && typeof updated === "object" ? updated : null;
    } catch (error) {
      notifications.notifyError("Could not update playlist", error);
      return null;
    }
  }

  async function setPlaylistPinned(playlistId: string, pinned: boolean): Promise<void> {
    try {
      await patchJson(`/api/playlists/${playlistId}`, { pinned });
      await refreshPlaylists();
      notifications.notifySuccess(pinned ? "Playlist pinned" : "Playlist unpinned");
    } catch (error) {
      notifications.notifyError(pinned ? "Could not pin playlist" : "Could not unpin playlist", error);
    }
  }

  async function deletePlaylist(playlistId: string): Promise<void> {
    try {
      await deleteJson(`/api/playlists/${playlistId}`);
      await refreshPlaylists();
      notifications.notifySuccess("Playlist deleted");
    } catch (error) {
      notifications.notifyError("Could not delete playlist", error);
    }
  }

  async function reorderPlaylistEntry(entryId: number, newPosition: number): Promise<void> {
    try {
      await postJson(`/api/playlists/entries/${entryId}/reorder`, { new_position: newPosition });
    } catch (error) {
      notifications.notifyError("Could not reorder playlist", error);
    }
  }

  async function reorderSidebarPlaylist(playlistId: string, newPosition: number, pinned: boolean): Promise<void> {
    try {
      await postJson("/api/playlists/reorder", {
        playlist_id: String(playlistId),
        new_position: newPosition,
        pinned: !!pinned,
      });
      await refreshPlaylists();
    } catch (error) {
      notifications.notifyError("Could not reorder playlists", error);
      await refreshPlaylists();
    }
  }

  async function addLocalPathToPlaylist(playlistId: string, path: string): Promise<void> {
    await withDuplicateCheck<{ path: string }, DuplicateCheckResult>(
      `/api/playlists/${playlistId}/entries/local`,
      { path },
      {
        addAll: () => notifications.notifySuccess("Saved to playlist", "Item added."),
        addNew: (r) => {
          if (r?.skipped_duplicates) {
            notifications.notifySuccess("Already added", "This item is already in the playlist.");
          } else {
            notifications.notifySuccess("Saved to playlist", "Item added.");
          }
        },
        immediate: () => notifications.notifySuccess("Saved to playlist", "Item added."),
      },
      "Could not save to playlist",
    );
  }

  async function addLocalFolderToPlaylist(
    playlistId: string,
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    const { recursive = true } = options;
    await withDuplicateCheck<{ path: string; recursive: boolean }, DuplicateCheckResult>(
      `/api/playlists/${playlistId}/entries/local-folder`,
      { path, recursive },
      {
        addAll: (r, check) =>
          notifications.notifySuccess("Saved to playlist", `${r?.count ?? check?.total ?? 0} items added.`),
        addNew: (r) => {
          if (r?.skipped_duplicates && r?.count === 0) {
            notifications.notifySuccess("Already added", "All folder tracks were already in the playlist.");
          } else {
            notifications.notifySuccess("Saved to playlist", `${r?.count ?? 0} new items added.`);
          }
        },
        immediate: (check) => notifications.notifySuccess("Saved to playlist", `${check?.count ?? 0} items added.`),
      },
      "Could not save folder to playlist",
    );
  }

  return {
    playlists,
    duplicateModal,
    refreshPlaylists,
    setPlaylists,
    closeDuplicateModal,
    confirmDuplicateAddAll,
    confirmDuplicateAddNewOnes,
    importPlaylistUrl,
    startSpotifyImportFromUrl,
    importPlaylistIntoPlaylist,
    addUrlToPlaylist,
    addEntriesToPlaylist,
    createPlaylist,
    removeFromPlaylist,
    queuePlaylist,
    playPlaylistNow,
    updatePlaylist,
    setPlaylistPinned,
    deletePlaylist,
    reorderPlaylistEntry,
    reorderSidebarPlaylist,
    addLocalPathToPlaylist,
    addLocalFolderToPlaylist,
  };
});
