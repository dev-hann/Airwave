import { computed, ref, unref } from "vue";
import type { MaybeRefOrGetter, Ref, ComputedRef } from "vue";

import type { Playlist } from "../types/api";

/**
 * Shared logic for playlist selector dropdown with search.
 * @param playlists Playlist list (ref, computed, or getter)
 */
export function usePlaylistSelector(playlists: MaybeRefOrGetter<Playlist[]>) {
  const playlistSearchTerm = ref("");

  const localPlaylists: ComputedRef<Playlist[]> = computed(() => {
    const list = typeof playlists === "function" ? (playlists as () => Playlist[])() : unref(playlists);
    return (list ?? []).filter((p) => p?.kind !== "remote_youtube");
  });

  const filteredPlaylists: ComputedRef<Playlist[]> = computed(() => {
    const term = playlistSearchTerm.value.toLowerCase().trim();
    if (!term) return localPlaylists.value;
    return localPlaylists.value.filter((p) => (p.title || "").toLowerCase().includes(term));
  });

  function resetSearch(): void {
    playlistSearchTerm.value = "";
  }

  return { playlistSearchTerm, localPlaylists, filteredPlaylists, resetSearch } as {
    playlistSearchTerm: Ref<string>;
    localPlaylists: ComputedRef<Playlist[]>;
    filteredPlaylists: ComputedRef<Playlist[]>;
    resetSearch: () => void;
  };
}
