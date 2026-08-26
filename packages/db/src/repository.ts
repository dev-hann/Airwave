/**
 * Repository facade over Drizzle — port of app/db/repository/ store mixins.
 *
 * Clean-start database (no legacy migration path). Invariants carried over
 * from the Python stores:
 * - dequeueNext marks the next queued item playing and demotes any previous
 *   playing row to skipped (self-healing single-playing guarantee).
 * - enqueue assigns sequential queue positions 1..n.
 * - markPlaybackFinished writes queue status + a play_history row in one
 *   transaction.
 * - "Liked Songs" playlist is auto-seeded, can_edit/can_delete = false.
 */

import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { newQueueItemFields, RepeatCycleItem, TrackIdentity } from "@airwave/domain";

import * as schema from "./schema.js";
import { playHistory, playlistEntries, playlists, queueItems, settings } from "./schema.js";

export const LIKED_SONGS_SOURCE_URL = "custom://liked_songs";

export interface NewQueueItem extends TrackIdentity {
  playlistId?: string | null;
}

export type QueueStatusValue = "queued" | "playing" | "completed" | "skipped" | "failed";

export class Repository {
  readonly db: BetterSQLite3Database<typeof schema>;
  private readonly sqlite: Database.Database;

  constructor(dbPath: string) {
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.db = drizzle(this.sqlite, { schema });
  }

  close(): void {
    this.sqlite.close();
  }

  // ------------------------------------------------------------------ init

  init(): void {
    // drizzle-kit owns DDL for real deployments (see drizzle/ migrations);
    // for tests and first boot, create tables directly.
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL UNIQUE,
        title TEXT,
        description TEXT,
        channel TEXT,
        thumbnail_url TEXT,
        entry_count INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        can_edit INTEGER NOT NULL DEFAULT 1,
        can_delete INTEGER NOT NULL DEFAULT 1,
        sync_enabled INTEGER NOT NULL DEFAULT 0,
        sync_remove_missing INTEGER NOT NULL DEFAULT 0,
        last_sync_started_at TEXT,
        last_sync_succeeded_at TEXT,
        last_sync_status TEXT,
        last_sync_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS queue_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_url TEXT NOT NULL,
        provider TEXT,
        provider_item_id TEXT,
        normalized_url TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'video',
        title TEXT,
        channel TEXT,
        duration_seconds INTEGER,
        thumbnail_url TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        queue_position INTEGER NOT NULL,
        resolved_stream_url TEXT,
        resolved_at TEXT,
        playlist_id TEXT REFERENCES playlists(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.run(sql`CREATE INDEX IF NOT EXISTS idx_queue_items_position ON queue_items (queue_position)`);
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS playlist_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id TEXT NOT NULL REFERENCES playlists(id),
        source_url TEXT NOT NULL,
        provider TEXT,
        provider_item_id TEXT,
        upstream_item_id TEXT,
        normalized_url TEXT NOT NULL,
        title TEXT,
        channel TEXT,
        duration_seconds INTEGER,
        thumbnail_url TEXT,
        position INTEGER NOT NULL DEFAULT 1,
        spotify_import_searched INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.run(sql`CREATE INDEX IF NOT EXISTS idx_playlist_entries_playlist ON playlist_entries (playlist_id)`);
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS play_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_item_id INTEGER REFERENCES queue_items(id),
        title TEXT,
        source_url TEXT NOT NULL,
        provider TEXT,
        provider_item_id TEXT,
        thumbnail_url TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      )
    `);
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.seedLikedSongs();
  }

  private seedLikedSongs(): void {
    const existing = this.db.select().from(playlists).where(eq(playlists.sourceUrl, LIKED_SONGS_SOURCE_URL)).get();
    if (existing) return;
    this.db
      .insert(playlists)
      .values({
        id: crypto.randomUUID(),
        sourceUrl: LIKED_SONGS_SOURCE_URL,
        title: "Liked Songs",
        canEdit: false,
        canDelete: false,
        entryCount: 0,
      })
      .run();
  }

  // ----------------------------------------------------------------- queue

  private nextPosition(): number {
    const row = this.db.select({ max: sql<number | null>`MAX(${queueItems.queuePosition})` }).from(queueItems).get();
    return (row?.max ?? 0) + 1;
  }

  enqueueItems(items: NewQueueItem[]): schema.QueueItemRow[] {
    if (items.length === 0) return [];
    let position = this.nextPosition();
    const created: schema.QueueItemRow[] = [];
    this.sqlite.transaction(() => {
      for (const item of items) {
        const row = this.db
          .insert(queueItems)
          .values({
            sourceUrl: item.sourceUrl,
            provider: item.provider ?? null,
            providerItemId: item.providerItemId ?? null,
            normalizedUrl: item.normalizedUrl,
            sourceType: item.sourceType,
            title: item.title ?? null,
            durationSeconds: item.durationSeconds ?? null,
            thumbnailUrl: item.thumbnailUrl ?? null,
            queuePosition: position++,
            playlistId: item.playlistId ?? null,
          })
          .returning()
          .get();
        if (row) created.push(row);
      }
    })();
    return created;
  }

  /** Demote any 'playing' rows to 'skipped', then promote the lowest-position queued item. */
  dequeueNext(): schema.QueueItemRow | null {
    return this.sqlite.transaction(() => {
      this.db
        .update(queueItems)
        .set({ status: "skipped", updatedAt: new Date().toISOString() })
        .where(eq(queueItems.status, "playing"))
        .run();
      const next = this.db
        .select()
        .from(queueItems)
        .where(eq(queueItems.status, "queued"))
        .orderBy(asc(queueItems.queuePosition))
        .get();
      if (!next) return null;
      const promoted = this.db
        .update(queueItems)
        .set({ status: "playing", updatedAt: new Date().toISOString() })
        .where(eq(queueItems.id, next.id))
        .returning()
        .get();
      return promoted ?? next;
    })();
  }

  listQueue(): schema.QueueItemRow[] {
    return this.db.select().from(queueItems).orderBy(asc(queueItems.queuePosition)).all();
  }

  clearQueue(): number {
    const removed = this.db.select({ n: count() }).from(queueItems).where(ne(queueItems.status, "completed")).get();
    this.db.delete(queueItems).where(ne(queueItems.status, "completed")).run();
    return removed?.n ?? 0;
  }

  hasQueuedItems(): boolean {
    return (this.db.select({ n: count() }).from(queueItems).where(eq(queueItems.status, "queued")).get()?.n ?? 0) > 0;
  }

  queuedCount(): number {
    return this.db.select({ n: count() }).from(queueItems).where(eq(queueItems.status, "queued")).get()?.n ?? 0;
  }

  listQueuedIds(): number[] {
    return this.db
      .select({ id: queueItems.id })
      .from(queueItems)
      .where(eq(queueItems.status, "queued"))
      .orderBy(asc(queueItems.queuePosition))
      .all()
      .map((row) => row.id);
  }

  getItem(itemId: number): schema.QueueItemRow | null {
    return this.db.select().from(queueItems).where(eq(queueItems.id, itemId)).get() ?? null;
  }

  removeItem(itemId: number): boolean {
    return this.db.delete(queueItems).where(eq(queueItems.id, itemId)).run().changes > 0;
  }

  moveItemToFront(itemId: number): boolean {
    const item = this.getItem(itemId);
    if (!item) return false;
    const minPos = this.db.select({ min: sql<number | null>`MIN(${queueItems.queuePosition})` }).from(queueItems).get()?.min ?? 1;
    this.db.update(queueItems).set({ queuePosition: minPos - 1, updatedAt: new Date().toISOString() }).where(eq(queueItems.id, itemId)).run();
    return true;
  }

  reorderItem(itemId: number, newPosition: number): boolean {
    return this.reorderInternal([{ itemId, newPosition }]);
  }

  reorderQueuedItems(orderedIds: number[]): boolean {
    const pairs = orderedIds.map((itemId, index) => ({ itemId, newPosition: index + 1 }));
    return this.reorderInternal(pairs);
  }

  private reorderInternal(pairs: Array<{ itemId: number; newPosition: number }>): boolean {
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      // Park positions negative to dodge the uniqueness window during shifting.
      for (const { itemId, newPosition } of pairs) {
        this.db.update(queueItems).set({ queuePosition: -newPosition, updatedAt: now }).where(eq(queueItems.id, itemId)).run();
      }
      for (const { itemId, newPosition } of pairs) {
        this.db.update(queueItems).set({ queuePosition: newPosition, updatedAt: now }).where(eq(queueItems.id, itemId)).run();
      }
      // Close gaps for items outside the reordered set.
      const remaining = this.db
        .select({ id: queueItems.id })
        .from(queueItems)
        .where(and(ne(queueItems.status, "completed"), sql`${queueItems.queuePosition} > ${pairs.length}`))
        .orderBy(asc(queueItems.queuePosition))
        .all();
      let next = pairs.length + 1;
      for (const row of remaining) {
        this.db.update(queueItems).set({ queuePosition: next++, updatedAt: now }).where(eq(queueItems.id, row.id)).run();
      }
    })();
    return true;
  }

  markItemResolved(itemId: number, streamUrl: string): void {
    this.db
      .update(queueItems)
      .set({ resolvedStreamUrl: streamUrl, resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(queueItems.id, itemId))
      .run();
  }

  // --------------------------------------------------------------- history

  listHistory(limit = 50): schema.PlayHistoryRow[] {
    return this.db.select().from(playHistory).orderBy(desc(playHistory.id)).limit(limit).all();
  }

  clearHistory(): number {
    const n = this.db.select({ n: count() }).from(playHistory).get()?.n ?? 0;
    this.db.delete(playHistory).run();
    return n;
  }

  /** Queue status + history row in one transaction (cross-domain exception, same as Python). */
  markPlaybackFinished(itemId: number, status: QueueStatusValue, errorMessage: string | null = null): void {
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.db.update(queueItems).set({ status, updatedAt: now }).where(eq(queueItems.id, itemId)).run();
      const item = this.getItem(itemId);
      if (item) {
        this.db
          .insert(playHistory)
          .values({
            queueItemId: itemId,
            title: item.title,
            sourceUrl: item.sourceUrl,
            provider: item.provider,
            providerItemId: item.providerItemId,
            thumbnailUrl: item.thumbnailUrl,
            status,
            errorMessage,
            startedAt: item.createdAt,
            finishedAt: now,
          })
          .run();
      }
    })();
  }

  // -------------------------------------------------------------- playlists

  listPlaylists(): schema.PlaylistRow[] {
    return this.db.select().from(playlists).all();
  }

  getPlaylist(playlistId: string): schema.PlaylistRow | null {
    return this.db.select().from(playlists).where(eq(playlists.id, playlistId)).get() ?? null;
  }

  getPlaylistBySourceUrl(sourceUrl: string): schema.PlaylistRow | null {
    return this.db.select().from(playlists).where(eq(playlists.sourceUrl, sourceUrl)).get() ?? null;
  }

  createCustomPlaylist(title: string): schema.PlaylistRow {
    const row = this.db
      .insert(playlists)
      .values({ id: crypto.randomUUID(), sourceUrl: `custom://${crypto.randomUUID()}`, title })
      .returning()
      .get();
    if (!row) throw new Error("playlist insert failed");
    return row;
  }

  updatePlaylist(playlistId: string, patch: Partial<{ title: string; pinned: boolean; syncEnabled: boolean; syncRemoveMissing: boolean }>): schema.PlaylistRow | null {
    const row = this.db
      .update(playlists)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(playlists.id, playlistId))
      .returning()
      .get();
    return row ?? null;
  }

  deletePlaylist(playlistId: string): boolean {
    return this.sqlite.transaction(() => {
      this.db.update(queueItems).set({ playlistId: null }).where(eq(queueItems.playlistId, playlistId)).run();
      this.db.delete(playlistEntries).where(eq(playlistEntries.playlistId, playlistId)).run();
      return this.db.delete(playlists).where(eq(playlists.id, playlistId)).run().changes > 0;
    })();
  }

  // -------------------------------------------------------- playlist entries

  listPlaylistEntries(playlistId: string): schema.PlaylistEntryRow[] {
    return this.db
      .select()
      .from(playlistEntries)
      .where(eq(playlistEntries.playlistId, playlistId))
      .orderBy(asc(playlistEntries.position))
      .all();
  }

  addPlaylistEntry(
    playlistId: string,
    entry: { sourceUrl: string; normalizedUrl: string; provider?: string | null; providerItemId?: string | null; title?: string | null; channel?: string | null; durationSeconds?: number | null; thumbnailUrl?: string | null },
  ): schema.PlaylistEntryRow | null {
    return this.sqlite.transaction(() => {
      const maxPos = this.db
        .select({ max: sql<number | null>`MAX(${playlistEntries.position})` })
        .from(playlistEntries)
        .where(eq(playlistEntries.playlistId, playlistId))
        .get()?.max;
      const row = this.db
        .insert(playlistEntries)
        .values({
          playlistId,
          sourceUrl: entry.sourceUrl,
          provider: entry.provider ?? null,
          providerItemId: entry.providerItemId ?? null,
          normalizedUrl: entry.normalizedUrl,
          title: entry.title ?? null,
          channel: entry.channel ?? null,
          durationSeconds: entry.durationSeconds ?? null,
          thumbnailUrl: entry.thumbnailUrl ?? null,
          position: (maxPos ?? 0) + 1,
        })
        .returning()
        .get();
      if (row) this.bumpEntryCount(playlistId);
      return row ?? null;
    })();
  }

  removePlaylistEntry(entryId: number): boolean {
    const entry = this.db.select().from(playlistEntries).where(eq(playlistEntries.id, entryId)).get();
    if (!entry) return false;
    return this.sqlite.transaction(() => {
      const removed = this.db.delete(playlistEntries).where(eq(playlistEntries.id, entryId)).run().changes > 0;
      if (removed) this.bumpEntryCount(entry.playlistId);
      return removed;
    })();
  }

  playlistContainsTrack(playlistId: string, normalizedUrl: string | null, providerItemId: string | null): boolean {
    const conditions = [] as ReturnType<typeof eq>[];
    if (normalizedUrl) conditions.push(eq(playlistEntries.normalizedUrl, normalizedUrl));
    if (providerItemId) conditions.push(eq(playlistEntries.providerItemId, providerItemId));
    if (conditions.length === 0) return false;
    const row = this.db
      .select({ n: count() })
      .from(playlistEntries)
      .where(and(eq(playlistEntries.playlistId, playlistId), conditions.length === 1 ? conditions[0]! : orJoin(conditions)))
      .get();
    return (row?.n ?? 0) > 0;
  }

  private bumpEntryCount(playlistId: string): void {
    const n = this.db.select({ n: count() }).from(playlistEntries).where(eq(playlistEntries.playlistId, playlistId)).get()?.n ?? 0;
    this.db.update(playlists).set({ entryCount: n, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
  }

  // -------------------------------------------------------------- settings

  getSetting(key: string): string | null {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
      .run();
  }

  clearSetting(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }

  // ---------------------------------------------------- repeat-cycle bridge

  enqueueCycleItems(items: RepeatCycleItem[]): schema.QueueItemRow[] {
    return this.enqueueItems(items.map((item) => newQueueItemFields(item) as NewQueueItem));
  }
}

function orJoin(conditions: Array<ReturnType<typeof eq>>): ReturnType<typeof eq> {
  // Minimal OR for the two-condition dedup lookup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sql`(${conditions[0]} OR ${conditions[1]})` as any;
}

export { schema };
void isNull;
void inArray;
