/**
 * API payload types.
 *
 * Wire contracts live in `@airwave/shared/contracts` (zod) — one module
 * imported by both the Node server and this app; the OpenAPI codegen
 * pipeline was retired with the Python backend (ADR-0004 era). A few
 * endpoints still return hand-shaped payloads server-side; those types
 * are defined below with their source of truth noted.
 */

import type {
  HistoryRowPayload,
  PlaybackStatePayload,
  QueueItemPayload,
  UiSnapshotPayload,
} from "@airwave/shared/contracts";

export type PlaybackStateContract = PlaybackStatePayload;
export type QueueItem = QueueItemPayload;
export type HistoryRow = HistoryRowPayload;

/** WS `{"type": "snapshot"}` payload — see `lib/api/ws.ts`. */
export type UiSnapshot = UiSnapshotPayload;

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
