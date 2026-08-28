/**
 * Playlist/queue ingestion orchestration — port of the Python PlaylistService
 * surface the web app consumes. Duplicate handling (check / add_all /
 * skip_duplicates) mirrors the wire contract exactly.
 */

import type { Repository } from "@airwave/db";

import { MediaSourceResolver } from "./media-resolver.ts";
import type { PlaylistPreview } from "./yt-dlp-service.ts";
import type { YtDlpService } from "./yt-dlp-service.ts";

export type ImportMode = "check" | "add_all" | "skip_duplicates";

export interface QueueMutationResult {
  type: "video" | "playlist";
  count: number;
  title: string | null;
  item_ids: number[];
}

export interface DuplicateCheckResult {
  has_duplicates: true;
  duplicate_count: number;
  total: number;
  new_count: number;
  target_playlist_title: string;
  target_playlist_id: string;
}

export interface EntryInput {
  sourceUrl: string;
  provider?: string | null;
  providerItemId?: string | null;
  normalizedUrl: string;
  title?: string | null;
  channel?: string | null;
  durationSeconds?: number | null;
  thumbnailUrl?: string | null;
}

function isDuplicate(keys: Set<string>, normalizedUrl: string | null, providerItemId: string | null): boolean {
  if (providerItemId && keys.has(`pid:${providerItemId}`)) return true;
  if (normalizedUrl && keys.has(`url:${normalizedUrl}`)) return true;
  return false;
}

function toQueueItem(entry: EntryInput & { sourceType?: string }): {
  sourceUrl: string;
  provider: string | null;
  providerItemId: string | null;
  normalizedUrl: string;
  sourceType: string;
  title: string | null;
  channel: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  playlistId: null;
} {
  return {
    sourceUrl: entry.sourceUrl,
    provider: entry.provider ?? null,
    providerItemId: entry.providerItemId ?? null,
    normalizedUrl: entry.normalizedUrl,
    sourceType: entry.sourceType ?? entry.provider ?? "video",
    title: entry.title ?? null,
    channel: entry.channel ?? null,
    durationSeconds: entry.durationSeconds ?? null,
    thumbnailUrl: entry.thumbnailUrl ?? null,
    playlistId: null,
  };
}

export class PlaylistService {
  private readonly repository: Repository;
  private readonly ytDlp: Pick<YtDlpService, "isPlaylistUrl" | "previewPlaylist" | "resolveVideo">;
  private readonly mediaResolver: MediaSourceResolver;
  private readonly hooks: { publish: () => void };

  constructor(
    repository: Repository,
    ytDlp: Pick<YtDlpService, "isPlaylistUrl" | "previewPlaylist" | "resolveVideo">,
    mediaResolver: MediaSourceResolver,
    hooks: { publish: () => void },
  ) {
    this.repository = repository;
    this.ytDlp = ytDlp;
    this.mediaResolver = mediaResolver;
    this.hooks = hooks;
  }

  // ------------------------------------------------------------------ queue

  /** POST /api/queue/add — single URL (video, direct media) or playlist URL (queues all). */
  async addUrl(url: string): Promise<QueueMutationResult> {
    if (this.ytDlp.isPlaylistUrl(url)) return this.queuePlaylistUrl(url);
    const resolved = await this.resolveSingleRemoteUrl(url);
    const created = this.repository.enqueueItems([toQueueItem(resolved)]);
    return { type: "video", count: created.length, title: resolved.title ?? null, item_ids: created.map((item) => item.id) };
  }

  /**
   * Instant queue insert: no network awaits before the row exists.
   *
   * YouTube URLs are inserted immediately using caller-supplied metadata
   * (search results / history / playlist rows already know it) or as a
   * title-less placeholder; resolution happens afterwards in the engine
   * (play flows) or in a background enrichment pass (plain adds). This is
   * what lets the loading spinner start within milliseconds of a click.
   */
  async addUrlImmediate(
    url: string,
    meta?: { title?: string | null; channel?: string | null; durationSeconds?: number | null; thumbnailUrl?: string | null },
  ): Promise<QueueMutationResult & { deferred: boolean }> {
    const text = (url || "").trim();
    if (this.ytDlp.isPlaylistUrl(text) || !/youtube\.com|youtu\.be/i.test(text)) {
      // Playlists (need entry listing) and direct http(s) media (need a
      // probe) keep the resolving path — they cannot be represented by a
      // YouTube placeholder row.
      const result = await this.addUrl(text);
      return { ...result, deferred: false };
    }
    const hasMeta = Boolean(meta && (meta.title || meta.durationSeconds));
    const entry: EntryInput & { sourceType: string } = {
      sourceUrl: text,
      provider: "youtube",
      providerItemId: null,
      normalizedUrl: text,
      sourceType: "youtube",
      title: hasMeta ? (meta?.title ?? null) : null,
      channel: hasMeta ? (meta?.channel ?? null) : null,
      durationSeconds: hasMeta ? (meta?.durationSeconds ?? null) : null,
      thumbnailUrl: hasMeta ? (meta?.thumbnailUrl ?? null) : null,
    };
    const created = this.repository.enqueueItems([toQueueItem(entry)]);
    return {
      type: "video",
      count: created.length,
      title: entry.title ?? null,
      item_ids: created.map((item) => item.id),
      deferred: !hasMeta,
    };
  }

  async addLocalPath(path: string): Promise<QueueMutationResult> {
    const resolved = this.mediaResolver.resolveLocalFile(path);
    const created = this.repository.enqueueItems([toQueueItem({ ...resolved, provider: "local", sourceType: "local" })]);
    return { type: "video", count: created.length, title: resolved.title, item_ids: created.map((item) => item.id) };
  }

  async addLocalFolder(path: string, recursive = true): Promise<QueueMutationResult> {
    const candidates = this.mediaResolver.listCandidateAudioFiles(path, recursive);
    if (candidates.length === 0) throw new Error("No audio files found in that folder");
    const items = candidates.map((candidate) => {
      const resolved = this.mediaResolver.resolveLocalFile(candidate);
      return toQueueItem({ ...resolved, provider: "local", sourceType: "local" });
    });
    const created = this.repository.enqueueItems(items);
    return { type: "playlist", count: created.length, title: null, item_ids: created.map((item) => item.id) };
  }

  /** Queue a playlist URL without importing it into the library. */
  async queuePlaylistUrl(url: string, replace = false): Promise<QueueMutationResult> {
    const preview = await this.ytDlp.previewPlaylist(url);
    const items = preview.entries.map((entry) => ({
      sourceUrl: entry.source_url,
      provider: entry.provider,
      providerItemId: entry.provider_item_id,
      normalizedUrl: entry.normalized_url,
      sourceType: entry.provider,
      title: entry.title,
      channel: entry.channel,
      durationSeconds: entry.duration_seconds,
      thumbnailUrl: entry.thumbnail_url,
      playlistId: null,
    }));
    const created = replace ? this.repository.replaceQueuedItems(items) : this.repository.enqueueItems(items);
    return { type: "playlist", count: created.length, title: preview.title, item_ids: created.map((item) => item.id) };
  }

  private async resolveSingleRemoteUrl(url: string): Promise<EntryInput & { sourceType: string; playlistId?: null }> {
    const text = (url || "").trim();
    if (this.ytDlp.isPlaylistUrl(text)) {
      throw new Error("Playlist URL; use the playlist flow");
    }
    // YouTube watch URLs resolve via yt-dlp; everything else http(s) probes directly.
    if (/youtube\.com|youtu\.be/i.test(text)) {
      const resolved = await this.ytDlp.resolveVideo(text);
      return {
        sourceUrl: resolved.sourceUrl,
        provider: "youtube",
        providerItemId: null,
        normalizedUrl: resolved.normalizedUrl,
        sourceType: "youtube",
        title: resolved.title,
        channel: resolved.channel,
        durationSeconds: resolved.durationSeconds,
        thumbnailUrl: resolved.thumbnailUrl,
        playlistId: null,
      };
    }
    if (/^https?:\/\//i.test(text)) {
      const resolved = await this.mediaResolver.resolveHttpMedia(text);
      return {
        sourceUrl: resolved.sourceUrl,
        provider: "direct",
        providerItemId: null,
        normalizedUrl: resolved.normalizedUrl,
        sourceType: "direct",
        title: resolved.title,
        channel: resolved.channel,
        durationSeconds: resolved.durationSeconds,
        thumbnailUrl: null,
        playlistId: null,
      };
    }
    throw new Error("Unsupported URL");
  }

  // ----------------------------------------------------------- import flow

  /** POST /api/playlist/import — import a playlist URL as a library playlist. */
  async importPlaylist(url: string): Promise<{ ok: true; playlist_id: string; count: number; title: string | null }> {
    const preview = await this.ytDlp.previewPlaylist(url);
    const playlist = this.repository.createOrUpdateImportedPlaylist({
      sourceUrl: preview.sourceUrl,
      title: preview.title,
      channel: preview.channel,
      thumbnailUrl: preview.thumbnailUrl,
      entryCount: preview.entries.length,
    });
    this.repository.replacePlaylistEntries(
      playlist.id,
      preview.entries.map((entry) => ({
        sourceUrl: entry.source_url,
        provider: entry.provider,
        providerItemId: entry.provider_item_id,
        normalizedUrl: entry.normalized_url,
        title: entry.title,
        channel: entry.channel,
        durationSeconds: entry.duration_seconds,
        thumbnailUrl: entry.thumbnail_url,
      })),
    );
    this.hooks.publish();
    return { ok: true, playlist_id: playlist.id, count: preview.entries.length, title: preview.title };
  }

  // -------------------------------------------------- playlist entry flows

  /** Add one URL to a playlist with duplicate handling. */
  async addItemToPlaylist(
    playlistId: string,
    url: string,
    importMode: ImportMode | null,
  ): Promise<Record<string, unknown>> {
    const playlist = this.repository.getPlaylist(playlistId);
    if (!playlist) throw new Error("Playlist not found");
    const resolved = await this.resolveSingleRemoteUrl(url);
    return this.insertEntriesWithDupCheck(playlist.id, playlist.title ?? "Untitled playlist", [resolved], importMode);
  }

  async addLocalPathToPlaylist(playlistId: string, path: string, importMode: ImportMode | null): Promise<Record<string, unknown>> {
    const playlist = this.repository.getPlaylist(playlistId);
    if (!playlist) throw new Error("Playlist not found");
    const resolved = this.mediaResolver.resolveLocalFile(path);
    return this.insertEntriesWithDupCheck(playlist.id, playlist.title ?? "Untitled playlist", [resolved], importMode);
  }

  async addLocalFolderToPlaylist(playlistId: string, path: string, recursive: boolean, importMode: ImportMode | null): Promise<Record<string, unknown>> {
    const playlist = this.repository.getPlaylist(playlistId);
    if (!playlist) throw new Error("Playlist not found");
    const candidates = this.mediaResolver.listCandidateAudioFiles(path, recursive);
    if (candidates.length === 0) throw new Error("No audio files found in that folder");
    const entries = candidates.map((candidate) => this.mediaResolver.resolveLocalFile(candidate));
    return this.insertEntriesWithDupCheck(playlist.id, playlist.title ?? "Untitled playlist", entries, importMode);
  }

  async addEntriesToPlaylist(playlistId: string, entries: EntryInput[], importMode: ImportMode | null): Promise<Record<string, unknown>> {
    const playlist = this.repository.getPlaylist(playlistId);
    if (!playlist) throw new Error("Playlist not found");
    return this.insertEntriesWithDupCheck(playlist.id, playlist.title ?? "Untitled playlist", entries, importMode);
  }

  private insertEntriesWithDupCheck(
    playlistId: string,
    targetTitle: string,
    entries: EntryInput[],
    importMode: ImportMode | null,
  ): Record<string, unknown> {
    const keys = this.repository.getPlaylistDedupKeys(playlistId);
    const dupCount = entries.filter((entry) => isDuplicate(keys, entry.normalizedUrl ?? null, entry.providerItemId ?? null)).length;
    const mode = importMode ?? "add_all";

    if (mode === "check" && dupCount > 0) {
      return {
        has_duplicates: true,
        duplicate_count: dupCount,
        total: entries.length,
        new_count: entries.length - dupCount,
        target_playlist_title: targetTitle,
        target_playlist_id: playlistId,
      };
    }
    const toInsert = mode === "skip_duplicates"
      ? entries.filter((entry) => !isDuplicate(keys, entry.normalizedUrl ?? null, entry.providerItemId ?? null))
      : entries;
    const created = this.repository.addPlaylistEntries(playlistId, toInsert);
    if (mode === "skip_duplicates" && dupCount > 0) {
      return { ok: true, skipped_duplicates: true, count: created.length, target_playlist_title: targetTitle };
    }
    const first = created[0];
    return {
      id: first?.id ?? null,
      playlist_id: playlistId,
      title: first?.title ?? null,
      source_url: first?.sourceUrl ?? null,
      position: first?.position ?? null,
      count: created.length,
    };
  }

  // ---------------------------------------------------------- queue bridges

  queuePlaylist(playlistId: string, replace = false): { ok: true; count: number; item_ids: number[] } {
    const created = this.repository.queuePlaylist(playlistId, replace);
    return { ok: true, count: created.length, item_ids: created.map((item) => item.id) };
  }

  queuePlaylistEntry(entryId: number): { ok: true; count: 1; item_ids: number[] } {
    const created = this.repository.queuePlaylistEntry(entryId);
    if (!created) throw new Error("Playlist entry not found");
    return { ok: true, count: 1, item_ids: [created.id] };
  }

  reorderPlaylistEntry(entryId: number, newPosition: number): void {
    if (!this.repository.reorderPlaylistEntry(entryId, newPosition)) {
      throw new Error("Playlist entry not found");
    }
  }

  /** Sidebar reorder: persist explicit id order; pinned handled on the row. */
  reorderSidebarPlaylist(playlistId: string, newPosition: number, pinned: boolean): void {
    const playlist = this.repository.getPlaylist(playlistId);
    if (!playlist) throw new Error("Playlist not found");
    this.repository.updatePlaylist(playlistId, { pinned });
    const ids = this.repository.listPlaylists().map((row) => row.id);
    const without = ids.filter((id) => id !== playlistId);
    const target = Math.max(0, Math.min(newPosition, without.length));
    without.splice(target, 0, playlistId);
    this.repository.setSidebarPlaylistOrder(without);
  }
}
