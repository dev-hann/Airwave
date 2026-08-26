/**
 * Drizzle schema for the Airwave Node server.
 *
 * Ported from app/db/models.py (SQLAlchemy). Clean-start database — no
 * legacy-compat constraints; UUID primary keys stored as text (crypto.randomUUID).
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey(),
  sourceUrl: text("source_url").notNull().unique(),
  title: text("title"),
  description: text("description"),
  channel: text("channel"),
  thumbnailUrl: text("thumbnail_url"),
  entryCount: integer("entry_count").notNull().default(0),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  canEdit: integer("can_edit", { mode: "boolean" }).notNull().default(true),
  canDelete: integer("can_delete", { mode: "boolean" }).notNull().default(true),
  syncEnabled: integer("sync_enabled", { mode: "boolean" }).notNull().default(false),
  syncRemoveMissing: integer("sync_remove_missing", { mode: "boolean" }).notNull().default(false),
  lastSyncStartedAt: text("last_sync_started_at"),
  lastSyncSucceededAt: text("last_sync_succeeded_at"),
  lastSyncStatus: text("last_sync_status"),
  lastSyncError: text("last_sync_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const queueItems = sqliteTable(
  "queue_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceUrl: text("source_url").notNull(),
    provider: text("provider"),
    providerItemId: text("provider_item_id"),
    normalizedUrl: text("normalized_url").notNull(),
    sourceType: text("source_type").notNull().default("video"),
    title: text("title"),
    channel: text("channel"),
    durationSeconds: integer("duration_seconds"),
    thumbnailUrl: text("thumbnail_url"),
    status: text("status").notNull().default("queued"),
    queuePosition: integer("queue_position").notNull(),
    resolvedStreamUrl: text("resolved_stream_url"),
    resolvedAt: text("resolved_at"),
    playlistId: text("playlist_id").references(() => playlists.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_queue_items_position").on(table.queuePosition)],
);

export const playlistEntries = sqliteTable(
  "playlist_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id),
    sourceUrl: text("source_url").notNull(),
    provider: text("provider"),
    providerItemId: text("provider_item_id"),
    upstreamItemId: text("upstream_item_id"),
    normalizedUrl: text("normalized_url").notNull(),
    title: text("title"),
    channel: text("channel"),
    durationSeconds: integer("duration_seconds"),
    thumbnailUrl: text("thumbnail_url"),
    position: integer("position").notNull().default(1),
    spotifyImportSearched: integer("spotify_import_searched", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_playlist_entries_playlist").on(table.playlistId)],
);

export const playHistory = sqliteTable("play_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  queueItemId: integer("queue_item_id").references(() => queueItems.id),
  title: text("title"),
  sourceUrl: text("source_url").notNull(),
  provider: text("provider"),
  providerItemId: text("provider_item_id"),
  thumbnailUrl: text("thumbnail_url"),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type PlaylistRow = typeof playlists.$inferSelect;
export type QueueItemRow = typeof queueItems.$inferSelect;
export type PlaylistEntryRow = typeof playlistEntries.$inferSelect;
export type PlayHistoryRow = typeof playHistory.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
