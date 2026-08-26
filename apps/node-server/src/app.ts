/**
 * Express app — API surface port (P5 core: state/playback/queue/history/
 * playlists/settings routes + HLS endpoints + WS).
 *
 * Route handlers stay thin (validate → service → serialize); business logic
 * lives in the engine/stores — same layering rule as the Python app.
 */

import express, { type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { LIKED_SONGS_SOURCE_URL, Repository } from "@airwave/db";

import { FfmpegPipeline } from "./ffmpeg-pipeline.ts";
import { HlsSegmenter } from "./hls-segmenter.ts";
import { MediaSourceResolver } from "./media-resolver.ts";
import { PlaylistService } from "./playlist-service.ts";
import type { PlaylistPreview, SearchResultItem } from "./yt-dlp-service.ts";
import { StreamEngine } from "./stream-engine.ts";
import { UiEventBroker } from "./ui-events.ts";
import { buildUiSnapshot, serializePlaylist, serializePlaylistEntry, serializeQueueItem } from "./serializers.ts";

const asInt = (value: unknown, fallback: number | null = null): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const isImportMode = (value: unknown): value is "check" | "add_all" | "skip_duplicates" | undefined =>
  value === undefined || value === "check" || value === "add_all" || value === "skip_duplicates";

export interface AppOptions {
  dbPath: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  hlsDirectory?: string;
  streamPath?: string;
  staticDir?: string;
  localMediaRoots?: string[];
  trackSource: {
    resolveVideo: (url: string, forceRefresh?: boolean) => Promise<import("@airwave/domain").ResolvedTrackLike>;
    normalizeUrl?: (url: string) => string;
  };
  /** YouTube search (optional — injected in prod, stubbed in tests). */
  search?: (query: string, limit: number) => Promise<SearchResultItem[]>;
  /** Playlist preview (optional). */
  previewPlaylist?: (url: string) => Promise<PlaylistPreview>;
  isPlaylistUrl?: (url: string) => boolean;
}

export function createApp(options: AppOptions) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const repo = new Repository(options.dbPath);
  repo.init();

  const pipeline = new FfmpegPipeline(options.ffmpegPath ?? "ffmpeg", options.ffprobePath ?? "ffprobe", "320k");
  const segmenter = new HlsSegmenter({
    directory: options.hlsDirectory,
    segmentSeconds: 4,
    windowSize: 12,
    spawnPackager: (playlistPath, segmentPattern, opts) =>
      pipeline.spawnHlsPackager(playlistPath, segmentPattern, { startNumber: opts.startNumber, segmentSeconds: 4, hlsBitrate: "192k" }),
  });

  const broker = new UiEventBroker(() => buildUiSnapshot(engine, repo, streamPath));
  const engine = new StreamEngine({
    repository: repo,
    ffmpegPipeline: pipeline,
    segmenter,
    trackSource: options.trackSource,
    onStateChange: () => broker.publishSnapshot(),
  });

  const streamPath = options.streamPath ?? "/stream/live.m3u8";
  const publish = () => broker.publishSnapshot();

  // Ingestion services (playlist/queue flows + local media).
  const ytDlpAdapter = {
    isPlaylistUrl: options.isPlaylistUrl ?? (() => false),
    previewPlaylist:
      options.previewPlaylist ??
      (async () => {
        throw new Error("Playlist preview unavailable");
      }),
    resolveVideo: (url: string, forceRefresh?: boolean) => options.trackSource.resolveVideo(url, forceRefresh),
  };
  const mediaResolver = new MediaSourceResolver(options.localMediaRoots ?? [], (url) => pipeline.probeSource(url));
  const playlistsSvc = new PlaylistService(repo, ytDlpAdapter, mediaResolver, { publish });
  const wrapServiceError = (res: Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(/not found/i.test(message) ? 404 : 400).json({ detail: message });
  };

  // ---------------------------------------------------------------- health

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ----------------------------------------------------------------- state

  app.get("/api/state", (_req, res) => {
    res.json(buildUiSnapshot(engine, repo, streamPath).state);
  });

  // -------------------------------------------------------------- playback

  app.post("/api/playback/resume", (_req, res) => {
    const outcome = engine.resumePlayback();
    publish();
    res.json({ ok: true, outcome });
  });

  // Python-era alias: the web store posts /play to (re)start playback.
  app.post("/api/playback/play", (_req, res) => {
    const outcome = engine.resumePlayback();
    publish();
    res.json({ ok: true, outcome });
  });

  app.post("/api/playback/stop", (_req, res) => {
    engine.stopPlayback();
    publish();
    res.json({ ok: true });
  });

  app.post("/api/playback/previous", (_req, res) => {
    const outcome = engine.playPreviousOrRestart();
    publish();
    res.json({ ok: true, outcome });
  });

  app.post("/api/playback/toggle-pause", (_req, res) => {
    const paused = engine.togglePause();
    publish();
    res.json({ ok: true, paused });
  });

  app.post("/api/playback/repeat", (req, res) => {
    const mode = String(req.body?.mode ?? "");
    try {
      const value = engine.setRepeatMode(mode);
      publish();
      res.json({ ok: true, repeat_mode: value });
    } catch {
      res.status(400).json({ detail: "Invalid repeat mode" });
    }
  });

  app.post("/api/playback/shuffle", (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    const value = engine.setShuffleEnabled(enabled);
    publish();
    res.json({ ok: true, shuffle_enabled: value });
  });

  app.post("/api/playback/seek", (req, res) => {
    const percent = Number(req.body?.percent);
    if (!Number.isFinite(percent)) {
      res.status(400).json({ detail: "Invalid percent" });
      return;
    }
    const ok = engine.seekToPercent(percent);
    res.json({ ok });
  });

  // ----------------------------------------------------------------- queue

  app.get("/api/queue", (_req, res) => {
    res.json(repo.listQueue().map(serializeQueueItem));
  });

  app.post("/api/queue/add", async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) {
      res.status(400).json({ detail: "url required" });
      return;
    }
    try {
      const result = await playlistsSvc.addUrl(url);
      publish();
      res.json({ ok: true, ...result });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/queue/add-local", async (req, res) => {
    const path = String(req.body?.path ?? "").trim();
    if (!path) {
      res.status(400).json({ detail: "path required" });
      return;
    }
    try {
      const result = await playlistsSvc.addLocalPath(path);
      publish();
      res.json({ ok: true, ...result });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/queue/add-local-folder", async (req, res) => {
    const path = String(req.body?.path ?? "").trim();
    if (!path) {
      res.status(400).json({ detail: "path required" });
      return;
    }
    try {
      const result = await playlistsSvc.addLocalFolder(path, req.body?.recursive !== false);
      publish();
      res.json({ ok: true, ...result });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/queue/play-now", async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) {
      res.status(400).json({ detail: "url required" });
      return;
    }
    try {
      const result = ytDlpAdapter.isPlaylistUrl(url)
        ? await playlistsSvc.queuePlaylistUrl(url, true)
        : await playlistsSvc.addUrl(url);
      if (result.item_ids.length > 0) {
        repo.moveItemToFront(result.item_ids[0]!);
      }
      engine.playNow();
      publish();
      res.json({ ok: true, ...result });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/queue/play-now-local", async (req, res) => {
    const path = String(req.body?.path ?? "").trim();
    if (!path) {
      res.status(400).json({ detail: "path required" });
      return;
    }
    try {
      const result = await playlistsSvc.addLocalPath(path);
      if (result.item_ids.length > 0) {
        repo.reorderQueuedItems(result.item_ids);
      }
      engine.playNow();
      publish();
      res.json({ ok: true, ...result });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/queue/play-now-local-folder", async (req, res) => {
    const path = String(req.body?.path ?? "").trim();
    if (!path) {
      res.status(400).json({ detail: "path required" });
      return;
    }
    try {
      const result = await playlistsSvc.addLocalFolder(path, req.body?.recursive !== false);
      if (result.item_ids.length > 0) {
        repo.reorderQueuedItems(result.item_ids);
      }
      engine.playNow();
      publish();
      res.json({ ok: true, ...result });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/queue/skip", (_req, res) => {
    // Skip relies on the engine's pipeline-ready notify (parity with Python).
    engine.skip();
    res.json({ ok: true });
  });

  app.post("/api/queue/:id/reorder", (req, res) => {
    const itemId = asInt(req.params.id);
    const newPosition = asInt(req.body?.new_position);
    if (itemId === null || newPosition === null) {
      res.status(400).json({ detail: "id and new_position required" });
      return;
    }
    if (!repo.reorderItem(itemId, newPosition)) {
      res.status(404).json({ detail: "Queue item not found" });
      return;
    }
    publish();
    res.json({ ok: true });
  });

  app.delete("/api/queue/:id", (req, res) => {
    const itemId = asInt(req.params.id);
    const item = itemId !== null ? repo.getItem(itemId) : null;
    if (!item) {
      res.status(404).json({ detail: "Queue item not found" });
      return;
    }
    const ok = repo.removeItem(itemId!);
    if (item.status === "playing") engine.skip();
    publish();
    res.json({ ok });
  });

  // Legacy alias from the early Node port.
  app.post("/api/queue/remove/:id", (req, res) => {
    const ok = repo.removeItem(Number(req.params.id));
    publish();
    res.json({ ok });
  });

  app.post("/api/queue/reorder", (req, res) => {
    const itemId = asInt(req.body?.id);
    const newPosition = asInt(req.body?.new_position);
    if (itemId === null || newPosition === null) {
      res.status(400).json({ detail: "id and new_position required" });
      return;
    }
    repo.reorderItem(itemId, newPosition);
    publish();
    res.json({ ok: true });
  });

  app.delete("/api/queue", (_req, res) => {
    const hasPlaying = repo.listQueue().some((item) => item.status === "playing");
    repo.clearQueue();
    if (hasPlaying) engine.skip();
    publish();
    res.json({ ok: true });
  });

  app.post("/api/queue/clear", (_req, res) => {
    const removed = repo.clearQueue();
    publish();
    res.json({ ok: true, removed });
  });

  // ----------------------------------------------------------------- search

  app.get("/api/search", async (req, res) => {
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      res.status(400).json({ detail: "q required" });
      return;
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    if (!options.search) {
      res.status(503).json({ detail: "Search unavailable (yt-dlp not configured)" });
      return;
    }
    try {
      const results = await options.search(query, limit);
      res.json({ query, count: results.length, results });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.get("/api/search/youtube", async (req, res) => {
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      res.status(400).json({ detail: "q required" });
      return;
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    if (!options.search) {
      res.status(503).json({ detail: "Search unavailable (yt-dlp not configured)" });
      return;
    }
    try {
      const results = await options.search(query, limit);
      res.json({ query, count: results.length, results });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  // ------------------------------------------------------------ local media

  app.get("/api/media/local/roots", (_req, res) => {
    res.json({ roots: mediaResolver.listRootsPayload() });
  });

  app.get("/api/media/local/browse", (req, res) => {
    const path = String(req.query.path ?? "");
    if (!path) {
      res.status(400).json({ detail: "path required" });
      return;
    }
    try {
      res.json(mediaResolver.browseDirectory(path));
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  // --------------------------------------------------------------- history

  app.get("/api/history", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(buildUiSnapshot(engine, repo, streamPath, limit).history);
  });

  app.post("/api/history/clear", (_req, res) => {
    repo.clearHistory();
    publish();
    res.json({ ok: true });
  });

  // -------------------------------------------------------------- playlists

  app.get("/api/playlists", (_req, res) => {
    const lastPlayed = repo.playlistLastPlayedAtById();
    res.json(
      repo.listPlaylists().map((row) => ({
        ...serializePlaylist(row),
        last_played_at: lastPlayed.get(row.id) ?? null,
      })),
    );
  });

  app.post("/api/playlists", (req, res) => {
    const title = String(req.body?.title ?? "").trim();
    if (!title) {
      res.status(400).json({ detail: "title required" });
      return;
    }
    const created = repo.createCustomPlaylist(title);
    publish();
    res.json(serializePlaylist(created));
  });

  app.post("/api/playlists/custom", (req, res) => {
    const title = String(req.body?.title ?? "").trim();
    if (!title) {
      res.status(400).json({ detail: "title required" });
      return;
    }
    const created = repo.createCustomPlaylist(title);
    publish();
    res.json(serializePlaylist(created));
  });

  app.get("/api/playlists/:id", (req, res) => {
    const playlist = repo.getPlaylist(req.params.id);
    if (!playlist) {
      res.status(404).json({ detail: "Playlist not found" });
      return;
    }
    res.json(serializePlaylist(playlist));
  });

  app.patch("/api/playlists/:id", (req, res) => {
    const body = req.body ?? {};
    const hasPatch = ["title", "description", "pinned", "sync_enabled", "sync_remove_missing"].some((key) => body[key] !== undefined);
    if (!hasPatch) {
      res.status(400).json({ detail: "At least one field must be provided" });
      return;
    }
    const playlist = repo.getPlaylist(req.params.id);
    if (!playlist) {
      res.status(404).json({ detail: "Playlist not found" });
      return;
    }
    const patch: { title?: string; pinned?: boolean; syncEnabled?: boolean; syncRemoveMissing?: boolean } = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    // Liked Songs (can_edit=false) may only be pinned/unpinned.
    const restricted = ["title", "sync_enabled", "sync_remove_missing"].some((key) => body[key] !== undefined);
    if (!playlist.canEdit && restricted) {
      res.status(403).json({ detail: "Playlist cannot be edited" });
      return;
    }
    if (playlist.canEdit) {
      if (typeof body.sync_enabled === "boolean") patch.syncEnabled = body.sync_enabled;
      if (typeof body.sync_remove_missing === "boolean") patch.syncRemoveMissing = body.sync_remove_missing;
    }
    const updated = repo.updatePlaylist(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ detail: "Playlist not found" });
      return;
    }
    publish();
    res.json(serializePlaylist(updated));
  });

  app.delete("/api/playlists/:id", (req, res) => {
    const playlist = repo.getPlaylist(req.params.id);
    if (!playlist) {
      res.status(404).json({ detail: "Playlist not found" });
      return;
    }
    if (!playlist.canDelete) {
      res.status(403).json({ detail: "Playlist cannot be deleted" });
      return;
    }
    repo.deletePlaylist(req.params.id);
    publish();
    res.json({ ok: true });
  });

  app.post("/api/playlists/reorder", (req, res) => {
    const playlistId = String(req.body?.playlist_id ?? "");
    const newPosition = asInt(req.body?.new_position);
    if (!playlistId || newPosition === null) {
      res.status(400).json({ detail: "playlist_id and new_position required" });
      return;
    }
    try {
      playlistsSvc.reorderSidebarPlaylist(playlistId, newPosition, Boolean(req.body?.pinned));
      publish();
      res.json({ ok: true });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.get("/api/playlists/:id/entries", (req, res) => {
    const playlist = repo.getPlaylist(req.params.id);
    if (!playlist) {
      res.status(404).json({ detail: "Playlist not found" });
      return;
    }
    res.json(repo.listPlaylistEntries(req.params.id).map(serializePlaylistEntry));
  });

  app.post("/api/playlists/:id/entries", async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) {
      res.status(400).json({ detail: "url required" });
      return;
    }
    if (!isImportMode(req.body?.import_mode)) {
      res.status(400).json({ detail: "Invalid import_mode" });
      return;
    }
    try {
      const result = await playlistsSvc.addItemToPlaylist(req.params.id, url, req.body.import_mode ?? null);
      if (!result.has_duplicates) publish();
      res.json(result);
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/playlists/:id/entries/local", async (req, res) => {
    const path = String(req.body?.path ?? "").trim();
    if (!path) {
      res.status(400).json({ detail: "path required" });
      return;
    }
    if (!isImportMode(req.body?.import_mode)) {
      res.status(400).json({ detail: "Invalid import_mode" });
      return;
    }
    try {
      const result = await playlistsSvc.addLocalPathToPlaylist(req.params.id, path, req.body.import_mode ?? null);
      if (!result.has_duplicates) publish();
      res.json(result);
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/playlists/:id/entries/local-folder", async (req, res) => {
    const path = String(req.body?.path ?? "").trim();
    if (!path) {
      res.status(400).json({ detail: "path required" });
      return;
    }
    if (!isImportMode(req.body?.import_mode)) {
      res.status(400).json({ detail: "Invalid import_mode" });
      return;
    }
    try {
      const result = await playlistsSvc.addLocalFolderToPlaylist(req.params.id, path, req.body?.recursive !== false, req.body.import_mode ?? null);
      if (!result.has_duplicates) publish();
      res.json(result);
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/playlists/:id/entries/batch", async (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
    if (!entries) {
      res.status(400).json({ detail: "entries required" });
      return;
    }
    if (!isImportMode(req.body?.import_mode)) {
      res.status(400).json({ detail: "Invalid import_mode" });
      return;
    }
    try {
      const result = await playlistsSvc.addEntriesToPlaylist(
        req.params.id,
        entries.map((entry: Record<string, unknown>) => ({
          sourceUrl: String(entry.source_url ?? ""),
          provider: entry.provider ?? null,
          providerItemId: entry.provider_item_id ?? null,
          normalizedUrl: String(entry.normalized_url ?? entry.source_url ?? ""),
          title: entry.title ?? null,
          channel: entry.channel ?? null,
          durationSeconds: entry.duration_seconds ?? null,
          thumbnailUrl: entry.thumbnail_url ?? null,
        })),
        req.body.import_mode ?? null,
      );
      if (!result.has_duplicates) publish();
      res.json(result);
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/playlists/:id/queue", (req, res) => {
    try {
      const result = playlistsSvc.queuePlaylist(req.params.id);
      publish();
      res.json(result);
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/playlists/:id/play-now", (req, res) => {
    try {
      const result = playlistsSvc.queuePlaylist(req.params.id, true);
      engine.playNow();
      publish();
      res.json(result);
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.post("/api/playlists/entries/:entryId/queue", (req, res) => {
    try {
      const result = playlistsSvc.queuePlaylistEntry(asInt(req.params.entryId, 0)!);
      publish();
      res.json(result);
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  app.delete("/api/playlists/entries/:entryId", (req, res) => {
    if (!repo.removePlaylistEntry(asInt(req.params.entryId, 0)!)) {
      res.status(404).json({ detail: "Playlist entry not found" });
      return;
    }
    publish();
    res.status(204).end();
  });

  app.post("/api/playlists/entries/:entryId/reorder", (req, res) => {
    const newPosition = asInt(req.body?.new_position);
    if (newPosition === null) {
      res.status(400).json({ detail: "new_position required" });
      return;
    }
    try {
      playlistsSvc.reorderPlaylistEntry(asInt(req.params.entryId, 0)!, newPosition);
      publish();
      res.json({ ok: true });
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  // --------------------------------------------------------------- import

  app.post("/api/playlist/import", async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) {
      res.status(400).json({ detail: "url required" });
      return;
    }
    try {
      const result = await playlistsSvc.importPlaylist(url);
      res.json(result);
    } catch (error) {
      wrapServiceError(res, error);
    }
  });

  // ------------------------------------------------------------------- like

  app.post("/api/state/like", async (req, res) => {
    const state = engine.state;
    if (state.nowPlayingId === null) {
      res.status(400).json({ detail: "Nothing playing" });
      return;
    }
    const item = repo.getItem(state.nowPlayingId);
    if (!item) {
      res.status(404).json({ detail: "Queue item not found" });
      return;
    }
    const liked = repo.getPlaylistBySourceUrl(LIKED_SONGS_SOURCE_URL);
    if (!liked) {
      res.status(500).json({ detail: "Liked Songs playlist missing" });
      return;
    }
    if (repo.playlistContainsTrack(liked.id, item.normalizedUrl, item.providerItemId)) {
      const current = repo.listPlaylistEntries(liked.id).find((entry) => entry.normalizedUrl === item.normalizedUrl);
      res.json({ ok: true, liked: true, skipped_duplicates: false, state: buildUiSnapshot(engine, repo, streamPath).state });
      void current;
      return;
    }
    repo.addPlaylistEntry(liked.id, {
      sourceUrl: item.sourceUrl,
      normalizedUrl: item.normalizedUrl,
      provider: item.provider,
      providerItemId: item.providerItemId,
      title: item.title,
      channel: item.channel,
      durationSeconds: item.durationSeconds,
      thumbnailUrl: item.thumbnailUrl,
    });
    publish();
    res.json({ ok: true, liked: true, skipped_duplicates: false, state: buildUiSnapshot(engine, repo, streamPath).state });
  });

  app.post("/api/state/unlike", (req, res) => {
    const liked = repo.getPlaylistBySourceUrl(LIKED_SONGS_SOURCE_URL);
    if (!liked) {
      res.status(500).json({ detail: "Liked Songs playlist missing" });
      return;
    }
    const state = engine.state;
    const item = state.nowPlayingId !== null ? repo.getItem(state.nowPlayingId) : null;
    if (!item) {
      res.status(404).json({ detail: "Queue item not found" });
      return;
    }
    const entries = repo.listPlaylistEntries(liked.id);
    const match = entries.find((entry) => entry.normalizedUrl === item.normalizedUrl || (entry.providerItemId && entry.providerItemId === item.providerItemId));
    let removed = false;
    if (match) {
      removed = repo.removePlaylistEntry(match.id);
    }
    publish();
    res.json({ ok: true, unliked: true, removed, state: buildUiSnapshot(engine, repo, streamPath).state });
  });

  // --------------------------------------------------------------- settings

  app.get("/api/settings/:key", (req, res) => {
    res.json({ key: req.params.key, value: repo.getSetting(req.params.key) });
  });

  app.put("/api/settings/:key", (req, res) => {
    const value = req.body?.value;
    if (typeof value !== "string") {
      res.status(400).json({ detail: "value (string) required" });
      return;
    }
    repo.setSetting(req.params.key, value);
    res.json({ ok: true });
  });

  app.delete("/api/settings/:key", (req, res) => {
    repo.clearSetting(req.params.key);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------- HLS

  app.get(streamPath, async (req: Request, res: Response) => {
    const client = req.socket.remoteAddress ?? "unknown";
    const port = req.socket.remotePort ?? 0;
    engine.noteListener(`${client}:${port}`);
    const text = await engine.playlistText();
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send(text);
  });

  app.get<{ segment: string }>("/stream/:segment", async (req, res) => {
    const segmentName = req.params.segment;
    const path = await engine.segmentPath(segmentName);
    if (!path) {
      res.status(404).json({ detail: "Unknown stream segment" });
      return;
    }
    res.setHeader("Content-Type", engine.segmentMimeType());
    res.setHeader("Cache-Control", "public, max-age=60");
    res.sendFile(resolvePath(path));
  });

  // ------------------------------------------------------------- frontend
  // Order matters: API/HLS routes are registered above; static assets and the
  // SPA fallback come last so they can never shadow /api/* or /stream/*.

  const staticDir = options.staticDir ?? resolvePath("static-dist");
  // Root mount serves the bundle at the paths index.html references
  // (/app.js, /app.css, /chunks/*, /assets/*).
  app.use(express.static(staticDir, { etag: true, maxAge: 0 }));
  // Legacy /static prefix kept for compatibility.
  app.use("/static", express.static(staticDir, { etag: true, maxAge: 0 }));
  // SPA fallback: deep links (/explorer, /playlist/:id) render the shell.
  // Middleware guard (not a wildcard route) — Express 5 '{*splat}' would also
  // swallow unknown /api/* paths, but an unhandled API route must stay a 404.
  app.use(async (req: Request, res: Response, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/stream/")) {
      next();
      return;
    }
    try {
      const html = await readFile(join(staticDir, "index.html"), "utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.type("html").send(html);
    } catch {
      res.status(503).send("frontend bundle missing");
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/api/ws/events" });
  wss.on("connection", (ws: WebSocket) => broker.addClient(ws));

  const startup = {
    server,
    engine,
    broker,
    repository: repo,
    async start(port = 8000, host = "0.0.0.0") {
      await engine.start();
      await new Promise<void>((resolvePromise) => server.listen(port, host, () => resolvePromise()));
    },
    async stop() {
      await engine.stop();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      repo.close();
    },
  };
  return startup;
}
