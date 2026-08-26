/**
 * Wire serializers — rows → contract payloads. Mirrors the Python
 * _serialize_state/_serialize_queue_items/_serialize_history_rows plus the
 * shared thumbnail helper, field-for-field.
 */

import type { PlayHistoryRow, PlaylistEntryRow, PlaylistRow, QueueItemRow } from "@airwave/db";
import { playbackProgress } from "@airwave/domain";
import type { PlaybackState } from "@airwave/domain";
import type { HistoryRowPayload, PlaybackStatePayload, PlaylistEntryPayload, PlaylistPayload, QueueItemPayload } from "@airwave/shared/contracts";

import { StreamEngine } from "./stream-engine.ts";

/** Best-effort thumbnail: stored URL > YouTube provider id > parsed source URL. */
export function resolvedThumbnail(item: {
  thumbnailUrl: string | null;
  providerItemId: string | null;
  sourceUrl: string;
}): string | null {
  if (item.thumbnailUrl) return item.thumbnailUrl;
  if (item.providerItemId) return `https://i.ytimg.com/vi/${item.providerItemId}/hqdefault.jpg`;
  try {
    const parsed = new URL(item.sourceUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const videoId = parsed.searchParams.get("v");
      if (videoId) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
    if (host === "youtu.be" || host === "www.youtu.be") {
      const videoId = parsed.pathname.replace(/^\//, "");
      if (videoId) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
  } catch {
    // Not a parseable URL.
  }
  return null;
}

export function serializeState(
  state: PlaybackState,
  progress: ReturnType<typeof playbackProgress>,
  streamUrl: string,
  liked: boolean,
): PlaybackStatePayload {
  return {
    mode: state.mode,
    paused: state.paused,
    repeat_mode: state.repeatMode,
    shuffle_enabled: state.shuffleEnabled,
    can_seek: Boolean(
      state.nowPlayingDurationSeconds &&
        state.nowPlayingDurationSeconds > 0 &&
        // Live sources have no meaningful position — seeking (-ss) is undefined.
        !state.nowPlayingIsLive,
    ),
    now_playing_id: state.nowPlayingId,
    now_playing_title: state.nowPlayingTitle,
    now_playing_channel: state.nowPlayingChannel,
    now_playing_thumbnail_url: preferHq(state.nowPlayingThumbnailUrl),
    now_playing_is_live: state.nowPlayingIsLive,
    now_playing_is_liked: liked,
    stream_url: streamUrl,
    duration_seconds: progress.durationSeconds,
    started_at: progress.startedAt,
    elapsed_seconds: progress.elapsedSeconds,
    progress_percent: progress.progressPercent,
  };
}

/** Map maxres YouTube CDN thumbs to hqdefault (yt-dlp often returns maxresdefault). */
export function preferHq(url: string | null): string | null {
  if (!url || !url.includes("maxresdefault")) return url;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith("ytimg.com")) {
      return url.replace("maxresdefault.jpg", "hqdefault.jpg").replace("maxresdefault.webp", "hqdefault.webp");
    }
  } catch {
    // Keep as-is.
  }
  return url;
}

export function serializeQueueItem(item: QueueItemRow): QueueItemPayload {
  return {
    id: item.id,
    title: item.title,
    source_url: item.sourceUrl,
    provider: item.provider,
    provider_item_id: item.providerItemId,
    status: item.status as QueueItemPayload["status"],
    queue_position: item.queuePosition,
    source_type: item.sourceType,
    channel: item.channel,
    duration_seconds: item.durationSeconds,
    thumbnail_url: resolvedThumbnail(item),
    playlist_id: item.playlistId,
  };
}

export function serializeHistoryRow(row: PlayHistoryRow): HistoryRowPayload {
  return {
    id: row.id,
    queue_item_id: row.queueItemId,
    title: row.title,
    source_url: row.sourceUrl,
    provider: row.provider,
    provider_item_id: row.providerItemId,
    thumbnail_url: resolvedThumbnail(row),
    status: row.status,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    error_message: row.errorMessage,
  };
}

export function serializePlaylist(row: PlaylistRow): PlaylistPayload {
  return {
    id: row.id,
    source_url: row.sourceUrl,
    title: row.title,
    description: row.description,
    channel: row.channel,
    thumbnail_url: row.thumbnailUrl,
    entry_count: row.entryCount,
    pinned: row.pinned,
    can_edit: row.canEdit,
    can_delete: row.canDelete,
    sync_enabled: row.syncEnabled,
    sync_remove_missing: row.syncRemoveMissing,
    last_sync_status: row.lastSyncStatus,
  };
}

export function serializePlaylistEntry(row: PlaylistEntryRow): PlaylistEntryPayload {
  return {
    id: row.id,
    playlist_id: row.playlistId,
    source_url: row.sourceUrl,
    normalized_url: row.normalizedUrl,
    provider: row.provider,
    provider_item_id: row.providerItemId,
    title: row.title,
    channel: row.channel,
    duration_seconds: row.durationSeconds,
    thumbnail_url: resolvedThumbnail(row),
    position: row.position,
  };
}

export interface UiSnapshot {
  type: "snapshot";
  timestamp: number;
  state: PlaybackStatePayload;
  queue: QueueItemPayload[];
  history: HistoryRowPayload[];
  playlists: PlaylistPayload[];
}

export function buildUiSnapshot(engine: StreamEngine, repo: import("@airwave/db").Repository, streamUrl: string, historyLimit = 50): UiSnapshot {
  const state = engine.state;
  const progress = playbackProgress(state, performance.now() / 1000);
  let liked = false;
  const likedPlaylist = repo.getPlaylistBySourceUrl("custom://liked_songs");
  if (likedPlaylist && state.nowPlayingId !== null) {
    const item = repo.getItem(state.nowPlayingId);
    if (item) {
      liked = repo.playlistContainsTrack(likedPlaylist.id, item.normalizedUrl, item.providerItemId);
    }
  }
  return {
    type: "snapshot",
    timestamp: Date.now(),
    state: serializeState(state, progress, streamUrl, liked),
    queue: repo.listQueue().map(serializeQueueItem),
    history: repo.listHistory(historyLimit).map(serializeHistoryRow),
    playlists: repo.listPlaylists().map(serializePlaylist),
  };
}
