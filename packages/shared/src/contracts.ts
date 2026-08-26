/**
 * Wire-format contracts (zod) — the single source of truth shared by the Node
 * server and the web client. Replaces the Python Pydantic contract models +
 * OpenAPI codegen pipeline: same language now, both sides import this module.
 *
 * Field names mirror the v1.x wire format exactly (golden-fixture guarded on
 * the server side). Keep changes additive; breaking changes ship in one
 * commit with the web consumers.
 */

import { z } from "zod";

export const PlaybackModeSchema = z.enum(["idle", "playing"]);
export const RepeatModeSchema = z.enum(["off", "all", "one"]);
export const QueueStatusSchema = z.enum(["queued", "playing", "completed", "skipped", "failed"]);

export const PlaybackStateSchema = z.object({
  mode: PlaybackModeSchema,
  paused: z.boolean(),
  repeat_mode: RepeatModeSchema,
  shuffle_enabled: z.boolean(),
  can_seek: z.boolean(),
  now_playing_id: z.number().int().nullable(),
  now_playing_title: z.string().nullable(),
  now_playing_channel: z.string().nullable(),
  now_playing_thumbnail_url: z.string().nullable(),
  now_playing_is_live: z.boolean(),
  now_playing_is_liked: z.boolean(),
  stream_url: z.string(),
  duration_seconds: z.number().nullable(),
  started_at: z.number().nullable(),
  elapsed_seconds: z.number().nullable(),
  progress_percent: z.number().nullable(),
});

export const QueueItemSchema = z.object({
  id: z.number().int(),
  title: z.string().nullable(),
  source_url: z.string(),
  provider: z.string().nullable(),
  provider_item_id: z.string().nullable(),
  status: QueueStatusSchema,
  queue_position: z.number().int(),
  source_type: z.string(),
  channel: z.string().nullable(),
  duration_seconds: z.number().int().nullable(),
  thumbnail_url: z.string().nullable(),
  playlist_id: z.string().nullable(),
});

export const HistoryRowSchema = z.object({
  id: z.number().int(),
  queue_item_id: z.number().int().nullable(),
  title: z.string().nullable(),
  source_url: z.string(),
  provider: z.string().nullable(),
  provider_item_id: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
  status: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  error_message: z.string().nullable(),
});

export const PlaylistSchema = z.object({
  id: z.string(),
  source_url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  channel: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
  entry_count: z.number().int(),
  pinned: z.boolean(),
  can_edit: z.boolean(),
  can_delete: z.boolean(),
  sync_enabled: z.boolean(),
  sync_remove_missing: z.boolean(),
  last_sync_status: z.string().nullable(),
});

export const PlaylistEntrySchema = z.object({
  id: z.number().int(),
  playlist_id: z.string(),
  source_url: z.string(),
  normalized_url: z.string(),
  provider: z.string().nullable(),
  provider_item_id: z.string().nullable(),
  title: z.string().nullable(),
  channel: z.string().nullable(),
  duration_seconds: z.number().int().nullable(),
  thumbnail_url: z.string().nullable(),
  position: z.number().int(),
});

/** WS snapshot payload (legacy flat shape — kept for web compatibility). */
export const UiSnapshotSchema = z.object({
  type: z.literal("snapshot"),
  timestamp: z.number(),
  state: PlaybackStateSchema,
  queue: z.array(QueueItemSchema),
  history: z.array(HistoryRowSchema),
  playlists: z.array(PlaylistSchema),
});

export type PlaybackStatePayload = z.infer<typeof PlaybackStateSchema>;
export type QueueItemPayload = z.infer<typeof QueueItemSchema>;
export type HistoryRowPayload = z.infer<typeof HistoryRowSchema>;
export type PlaylistPayload = z.infer<typeof PlaylistSchema>;
export type PlaylistEntryPayload = z.infer<typeof PlaylistEntrySchema>;
export type UiSnapshotPayload = z.infer<typeof UiSnapshotSchema>;
