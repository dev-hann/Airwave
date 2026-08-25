"""Playlist + playlist-entry domain, including queue-bridging helpers."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, func, select, update

from app.db.models import Playlist, PlaylistEntry, QueueItem, QueueStatus
from app.db.repository.base import NewPlaylistEntry, NewQueueItem


class _PlaylistStoreMixin:
    def create_or_update_playlist(
        self,
        source_url: str,
        title: str | None,
        channel: str | None,
        entry_count: int,
        thumbnail_url: str | None = None,
    ) -> Playlist:
        with self.session() as session:
            playlist = session.scalar(select(Playlist).where(Playlist.source_url == source_url))
            if playlist is None:
                playlist = Playlist(
                    source_url=source_url,
                    title=title,
                    channel=channel,
                    thumbnail_url=thumbnail_url,
                    entry_count=entry_count,
                )
                session.add(playlist)
            else:
                playlist.title = title
                playlist.channel = channel
                playlist.thumbnail_url = thumbnail_url
                playlist.entry_count = entry_count
            session.flush()
            # Ensure server-default timestamps are populated before detaching.
            session.refresh(playlist)
            return playlist

    def create_custom_playlist(self, title: str) -> Playlist:
        with self.session() as session:
            playlist = Playlist(
                source_url=f"custom://{datetime.now(timezone.utc).timestamp()}",
                title=title,
                channel="Custom",
                entry_count=0,
            )
            session.add(playlist)
            session.flush()
            playlist.source_url = f"custom://{str(playlist.id)}"
            # Ensure server-default timestamps are populated before detaching.
            session.refresh(playlist)
            return playlist

    def list_playlists(self) -> list[Playlist]:
        with self.session() as session:
            stmt = select(Playlist).order_by(Playlist.pinned.desc(), Playlist.updated_at.desc())
            return list(session.scalars(stmt).all())

    def playlist_last_played_at_by_id(self) -> dict[uuid.UUID, datetime]:
        """Return last playback activity per playlist_id.

        Uses the latest QueueItem.updated_at for items that reached a playback-related
        status (playing/completed/skipped/failed). Queued/removed items are ignored.
        """
        playback_statuses = [
            QueueStatus.playing,
            QueueStatus.completed,
            QueueStatus.skipped,
            QueueStatus.failed,
        ]
        with self.session() as session:
            rows = session.execute(
                select(QueueItem.playlist_id, func.max(QueueItem.updated_at))
                .where(
                    QueueItem.playlist_id.is_not(None),
                    QueueItem.status.in_(playback_statuses),
                )
                .group_by(QueueItem.playlist_id)
            ).all()
            result: dict[uuid.UUID, datetime] = {}
            for playlist_id, last_played_at in rows:
                if playlist_id is None or last_played_at is None:
                    continue
                result[playlist_id] = last_played_at
            return result

    def update_playlist(
        self,
        playlist_id: uuid.UUID,
        *,
        title: str | None = None,
        description: str | None = None,
        pinned: bool | None = None,
        sync_enabled: bool | None = None,
        sync_remove_missing: bool | None = None,
    ) -> Optional[Playlist]:
        with self.session() as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return None
            if title is not None:
                playlist.title = title
            if description is not None:
                playlist.description = description
            if pinned is not None:
                playlist.pinned = pinned
            if sync_enabled is not None:
                playlist.sync_enabled = bool(sync_enabled)
            if sync_remove_missing is not None:
                playlist.sync_remove_missing = bool(sync_remove_missing)
            session.flush()
            # Ensure onupdate timestamps are reflected before detaching.
            session.refresh(playlist)
            return playlist

    def get_playlist(self, playlist_id: uuid.UUID) -> Optional[Playlist]:
        with self.session() as session:
            return session.get(Playlist, playlist_id)

    def set_playlist_sync_state(
        self,
        playlist_id: uuid.UUID,
        *,
        last_sync_started_at: datetime | None = None,
        last_sync_succeeded_at: datetime | None = None,
        last_sync_status: str | None = None,
        last_sync_error: str | None = None,
    ) -> Optional[Playlist]:
        with self.session() as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return None
            if last_sync_started_at is not None:
                playlist.last_sync_started_at = last_sync_started_at
            if last_sync_succeeded_at is not None:
                playlist.last_sync_succeeded_at = last_sync_succeeded_at
            if last_sync_status is not None:
                playlist.last_sync_status = last_sync_status
            if last_sync_error is not None:
                playlist.last_sync_error = last_sync_error
            session.flush()
            session.refresh(playlist)
            return playlist

    def prune_playlist_entries_missing_upstream_ids(
        self,
        playlist_id: uuid.UUID,
        *,
        keep_upstream_item_ids: set[str],
    ) -> int:
        """Delete entries with upstream_item_id not present in keep set.

        Only entries with a non-null upstream_item_id are considered. Legacy rows
        without upstream_item_id are preserved.
        """
        with self.session() as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return 0

            stmt = delete(PlaylistEntry).where(
                PlaylistEntry.playlist_id == playlist_id,
                PlaylistEntry.upstream_item_id.is_not(None),
            )
            if keep_upstream_item_ids:
                stmt = stmt.where(PlaylistEntry.upstream_item_id.not_in(list(keep_upstream_item_ids)))
            result = session.execute(stmt)
            removed = int(result.rowcount or 0)
            if removed > 0:
                playlist.entry_count = int(
                    session.scalar(select(func.count(PlaylistEntry.id)).where(PlaylistEntry.playlist_id == playlist_id))
                    or 0
                )
                session.flush()
                session.refresh(playlist)
            return removed

    def delete_playlist(self, playlist_id: uuid.UUID) -> bool:
        with self.session() as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return False
            session.execute(update(QueueItem).where(QueueItem.playlist_id == playlist_id).values(playlist_id=None))
            session.execute(delete(PlaylistEntry).where(PlaylistEntry.playlist_id == playlist_id))
            session.delete(playlist)
            return True

    def replace_playlist_entries(self, playlist_id: uuid.UUID, entries: list[NewPlaylistEntry]) -> list[PlaylistEntry]:
        with self.session() as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return []
            session.execute(delete(PlaylistEntry).where(PlaylistEntry.playlist_id == playlist_id))
            created: list[PlaylistEntry] = []
            for idx, entry in enumerate(entries, start=1):
                row = PlaylistEntry(
                    playlist_id=playlist_id,
                    source_url=entry.source_url,
                    provider=entry.provider,
                    provider_item_id=entry.provider_item_id,
                    upstream_item_id=entry.upstream_item_id,
                    normalized_url=entry.normalized_url,
                    title=entry.title,
                    channel=entry.channel,
                    duration_seconds=entry.duration_seconds,
                    thumbnail_url=entry.thumbnail_url,
                    position=idx,
                )
                session.add(row)
                created.append(row)
            playlist.entry_count = len(created)
            session.flush()
            return created

    def add_playlist_entries(self, playlist_id: uuid.UUID, entries: list[NewPlaylistEntry]) -> list[PlaylistEntry]:
        if not entries:
            return []
        with self.session() as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return []
            next_pos = int(
                session.scalar(select(func.max(PlaylistEntry.position)).where(PlaylistEntry.playlist_id == playlist_id)) or 0
            ) + 1
            created: list[PlaylistEntry] = []
            for entry in entries:
                row = PlaylistEntry(
                    playlist_id=playlist_id,
                    source_url=entry.source_url,
                    provider=entry.provider,
                    provider_item_id=entry.provider_item_id,
                    upstream_item_id=entry.upstream_item_id,
                    normalized_url=entry.normalized_url,
                    title=entry.title,
                    channel=entry.channel,
                    duration_seconds=entry.duration_seconds,
                    thumbnail_url=entry.thumbnail_url,
                    position=next_pos,
                )
                session.add(row)
                created.append(row)
                next_pos += 1
            playlist.entry_count = int(
                session.scalar(select(func.count(PlaylistEntry.id)).where(PlaylistEntry.playlist_id == playlist_id))
            )
            session.flush()
            return created

    def add_playlist_entry(self, playlist_id: uuid.UUID, entry: NewPlaylistEntry) -> Optional[PlaylistEntry]:
        with self.session() as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return None
            next_pos = int(
                session.scalar(select(func.max(PlaylistEntry.position)).where(PlaylistEntry.playlist_id == playlist_id)) or 0
            ) + 1
            row = PlaylistEntry(
                playlist_id=playlist_id,
                source_url=entry.source_url,
                provider=entry.provider,
                provider_item_id=entry.provider_item_id,
                upstream_item_id=entry.upstream_item_id,
                normalized_url=entry.normalized_url,
                title=entry.title,
                channel=entry.channel,
                duration_seconds=entry.duration_seconds,
                thumbnail_url=entry.thumbnail_url,
                position=next_pos,
            )
            session.add(row)
            playlist.entry_count = next_pos
            session.flush()
            return row

    def list_playlist_entries(self, playlist_id: uuid.UUID) -> list[PlaylistEntry]:
        with self.session() as session:
            stmt = select(PlaylistEntry).where(PlaylistEntry.playlist_id == playlist_id).order_by(PlaylistEntry.position.asc())
            return list(session.scalars(stmt).all())

    def get_playlist_entry(self, entry_id: int) -> Optional[PlaylistEntry]:
        with self.session() as session:
            return session.get(PlaylistEntry, entry_id)

    def update_playlist_entry(self, entry_id: int, entry: NewPlaylistEntry) -> Optional[PlaylistEntry]:
        with self.session() as session:
            row = session.get(PlaylistEntry, entry_id)
            if row is None:
                return None
            row.source_url = entry.source_url
            row.provider = entry.provider
            row.provider_item_id = entry.provider_item_id
            if entry.upstream_item_id is not None:
                row.upstream_item_id = entry.upstream_item_id
            row.normalized_url = entry.normalized_url
            row.title = entry.title
            row.channel = entry.channel
            row.duration_seconds = entry.duration_seconds
            row.thumbnail_url = entry.thumbnail_url
            session.flush()
            return row

    def set_playlist_entry_spotify_import_searched(self, entry_id: int, searched: bool = True) -> Optional[PlaylistEntry]:
        with self.session() as session:
            row = session.get(PlaylistEntry, entry_id)
            if row is None:
                return None
            row.spotify_import_searched = searched
            session.flush()
            return row

    def get_playlist_dedup_keys(self, playlist_id: uuid.UUID) -> set[tuple[str, str | None]]:
        """Return (normalized_url, provider_item_id) pairs for duplicate detection."""
        entries = self.list_playlist_entries(playlist_id)
        keys: set[tuple[str, str | None]] = set()
        for e in entries:
            norm = (e.normalized_url or "").strip()
            pid = (e.provider_item_id or "").strip() or None
            if norm:
                keys.add((norm, pid))
            elif pid:
                keys.add(("", pid))
        return keys

    def get_first_playlist_entry(self, playlist_id: uuid.UUID) -> Optional[PlaylistEntry]:
        with self.session() as session:
            stmt = (
                select(PlaylistEntry)
                .where(PlaylistEntry.playlist_id == playlist_id)
                .order_by(PlaylistEntry.position.asc(), PlaylistEntry.id.asc())
                .limit(1)
            )
            return session.scalar(stmt)

    def queue_playlist(self, playlist_id: uuid.UUID, *, replace: bool = False) -> list[QueueItem]:
        entries = self.list_playlist_entries(playlist_id)
        new_items = [
            NewQueueItem(
                source_url=entry.source_url,
                provider=entry.provider,
                provider_item_id=entry.provider_item_id,
                normalized_url=entry.normalized_url,
                source_type=entry.provider or "unknown",
                title=entry.title,
                channel=entry.channel,
                duration_seconds=entry.duration_seconds,
                thumbnail_url=entry.thumbnail_url,
                playlist_id=playlist_id,
            )
            for entry in entries
        ]
        if replace:
            return self.replace_queued_items(new_items)
        return self.enqueue_items(new_items)

    def queue_playlist_entry(self, entry_id: int) -> Optional[QueueItem]:
        with self.session() as session:
            entry = session.get(PlaylistEntry, entry_id)
            if entry is None:
                return None
            playlist_id = entry.playlist_id
            new_item = NewQueueItem(
                source_url=entry.source_url,
                provider=entry.provider,
                provider_item_id=entry.provider_item_id,
                normalized_url=entry.normalized_url,
                source_type=entry.provider or "unknown",
                title=entry.title,
                channel=entry.channel,
                duration_seconds=entry.duration_seconds,
                thumbnail_url=entry.thumbnail_url,
                playlist_id=playlist_id,
            )
        queued = self.enqueue_items([new_item])
        return queued[0] if queued else None

    def delete_playlist_entry(self, entry_id: int) -> bool:
        with self.session() as session:
            entry = session.get(PlaylistEntry, entry_id)
            if entry is None:
                return False
            playlist_id = entry.playlist_id
            session.delete(entry)
            playlist = session.get(Playlist, playlist_id)
            if playlist is not None and playlist.entry_count > 0:
                playlist.entry_count -= 1
            return True

    def reorder_playlist_entry(self, entry_id: int, new_position: int) -> bool:
        with self.session() as session:
            entry = session.get(PlaylistEntry, entry_id)
            if entry is None:
                return False
            playlist_id = entry.playlist_id
            entries = list(
                session.scalars(
                    select(PlaylistEntry)
                    .where(PlaylistEntry.playlist_id == playlist_id)
                    .order_by(PlaylistEntry.position.asc())
                ).all()
            )
            if not entries:
                return False
            idx = next((i for i, e in enumerate(entries) if e.id == entry_id), None)
            if idx is None:
                return False
            item = entries.pop(idx)
            bounded_target = max(0, min(new_position, len(entries)))
            entries.insert(bounded_target, item)
            for pos, e in enumerate(entries, start=1):
                e.position = pos
            return True

    def get_playlist_by_source_url(self, source_url: str) -> Optional[Playlist]:
        with self.session() as session:
            return session.scalar(select(Playlist).where(Playlist.source_url == source_url))

    def playlist_contains_track(
        self,
        playlist_id: uuid.UUID,
        *,
        normalized_url: str | None,
        provider_item_id: str | None,
    ) -> bool:
        norm = (normalized_url or "").strip()
        pid = (provider_item_id or "").strip() or None
        if not norm and not pid:
            return False
        with self.session() as session:
            stmt = select(func.count(PlaylistEntry.id)).where(PlaylistEntry.playlist_id == playlist_id)
            if norm:
                stmt = stmt.where(PlaylistEntry.normalized_url == norm)
            elif pid:
                stmt = stmt.where(PlaylistEntry.provider_item_id == pid)
            count = session.scalar(stmt)
            return bool(count and int(count) > 0)

    def remove_playlist_track(
        self,
        playlist_id: uuid.UUID,
        *,
        normalized_url: str | None,
        provider_item_id: str | None,
    ) -> int:
        norm = (normalized_url or "").strip()
        pid = (provider_item_id or "").strip() or None
        if not norm and not pid:
            return 0
        with self.session() as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return 0
            stmt = delete(PlaylistEntry).where(PlaylistEntry.playlist_id == playlist_id)
            if norm:
                stmt = stmt.where(PlaylistEntry.normalized_url == norm)
            elif pid:
                stmt = stmt.where(PlaylistEntry.provider_item_id == pid)
            result = session.execute(stmt)
            removed = int(result.rowcount or 0)
            if removed > 0:
                playlist.entry_count = max(
                    0,
                    int(
                        session.scalar(
                            select(func.count(PlaylistEntry.id)).where(PlaylistEntry.playlist_id == playlist_id)
                        )
                        or 0
                    ),
                )
            return removed
