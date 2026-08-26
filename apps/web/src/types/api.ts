/**
 * API payload types.
 *
 * Strong types come from the OpenAPI-generated contract
 * (`@airwave/shared/generated/schema.d.ts`). A few endpoints still return
 * plain dicts on the backend (no response model), so their shapes are
 * hand-derived here from the backend serializers — each is marked with its
 * source of truth. Formalize them in the backend response models eventually
 * and this file shrinks.
 */

import type { components } from "@airwave/shared/generated/schema.d.ts";

export type PlaybackStateContract = components["schemas"]["PlaybackStateContract"];
export type QueueItem = components["schemas"]["QueueItemContract"];
export type HistoryRow = components["schemas"]["HistoryRowContract"];

/** WS `{"type": "snapshot"}` payload — see `lib/api/ws.ts`. */
export type UiSnapshot = components["schemas"]["UiSnapshotContract"] & { type: "snapshot" };

/** `GET /api/playlists` item — derived from `PlaylistService._serialize_playlist`. */
export interface Playlist {
  id: string;
  title: string;
  description: string | null;
  channel: string | null;
  source_url: string;
  thumbnail_url: string | null;
  entry_count: number;
  pinned: boolean;
  can_edit: boolean;
  can_delete: boolean;
  sync_enabled: boolean;
  sync_remove_missing: boolean;
  last_sync_started_at: string | null;
  last_sync_succeeded_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  kind: "custom" | "spotify" | "imported" | "remote_youtube";
  provider: string | null;
  provider_item_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_played_at: string | null;
}

/** `GET /api/playlists/{id}/entries` item — derived from `PlaylistService.list_playlist_entries`. */
export interface PlaylistEntry {
  id: number;
  playlist_id: string;
  source_url: string;
  normalized_url: string;
  provider: string | null;
  provider_item_id: string | null;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  position: number;
}
