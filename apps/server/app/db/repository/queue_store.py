"""Queue domain: enqueue/dequeue/reorder/status transitions."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Select, func, select, update
from sqlalchemy.orm import Session

from app.db.models import QueueItem, QueueStatus
from app.db.repository.base import NewQueueItem


class _QueueStoreMixin:
    def enqueue_items(self, items: list[NewQueueItem]) -> list[QueueItem]:
        if not items:
            return []
        with self._queue_lock, self.session() as session:
            position = self._next_position(session)
            created: list[QueueItem] = []
            for item in items:
                queue_item = QueueItem(
                    source_url=item.source_url,
                    provider=item.provider,
                    provider_item_id=item.provider_item_id,
                    normalized_url=item.normalized_url,
                    source_type=item.source_type,
                    title=item.title,
                    channel=item.channel,
                    duration_seconds=item.duration_seconds,
                    thumbnail_url=item.thumbnail_url,
                    playlist_id=item.playlist_id,
                    status=QueueStatus.queued,
                    queue_position=position,
                )
                session.add(queue_item)
                created.append(queue_item)
                position += 1
            session.flush()
            return created

    def replace_queued_items(self, items: list[NewQueueItem]) -> list[QueueItem]:
        with self._queue_lock, self.session() as session:
            session.execute(update(QueueItem).where(QueueItem.status == QueueStatus.queued).values(status=QueueStatus.removed))
            if not items:
                return []
            created: list[QueueItem] = []
            for position, item in enumerate(items, start=1):
                queue_item = QueueItem(
                    source_url=item.source_url,
                    provider=item.provider,
                    provider_item_id=item.provider_item_id,
                    normalized_url=item.normalized_url,
                    source_type=item.source_type,
                    title=item.title,
                    channel=item.channel,
                    duration_seconds=item.duration_seconds,
                    thumbnail_url=item.thumbnail_url,
                    playlist_id=item.playlist_id,
                    status=QueueStatus.queued,
                    queue_position=position,
                )
                session.add(queue_item)
                created.append(queue_item)
            session.flush()
            return created

    @staticmethod
    def _normalize_playing_items(session: Session, *, keep_latest: bool) -> None:
        playing_items = list(
            session.scalars(
                select(QueueItem)
                .where(QueueItem.status == QueueStatus.playing)
                .order_by(QueueItem.updated_at.desc(), QueueItem.id.desc())
            ).all()
        )
        if not playing_items:
            return
        if keep_latest and len(playing_items) == 1:
            return

        keep_id = playing_items[0].id if keep_latest else None
        for item in playing_items:
            if keep_id is not None and item.id == keep_id:
                continue
            item.status = QueueStatus.skipped

    def list_queue(self) -> list[QueueItem]:
        with self._queue_lock, self.session() as session:
            self._normalize_playing_items(session, keep_latest=True)
            stmt: Select[tuple[QueueItem]] = select(QueueItem).where(
                QueueItem.status.in_([QueueStatus.queued, QueueStatus.playing])
            ).order_by(QueueItem.status.asc(), QueueItem.queue_position.asc())
            return list(session.scalars(stmt).all())

    def clear_queue(self) -> int:
        with self._queue_lock, self.session() as session:
            removed = session.execute(
                update(QueueItem).where(QueueItem.status == QueueStatus.queued).values(status=QueueStatus.removed)
            )
            skipped = session.execute(
                update(QueueItem).where(QueueItem.status == QueueStatus.playing).values(status=QueueStatus.skipped)
            )
            return int((removed.rowcount or 0) + (skipped.rowcount or 0))

    def has_queued_items(self) -> bool:
        with self.session() as session:
            count = session.scalar(select(func.count(QueueItem.id)).where(QueueItem.status == QueueStatus.queued))
            return bool(count and count > 0)

    def queued_count(self) -> int:
        with self.session() as session:
            count = session.scalar(select(func.count(QueueItem.id)).where(QueueItem.status == QueueStatus.queued))
            return int(count or 0)

    def list_queued_ids(self) -> list[int]:
        with self.session() as session:
            stmt = select(QueueItem.id).where(QueueItem.status == QueueStatus.queued).order_by(QueueItem.queue_position.asc())
            return [int(item_id) for item_id in session.scalars(stmt).all()]

    def dequeue_next(self) -> QueueItem | None:
        with self._queue_lock, self.session() as session:
            self._normalize_playing_items(session, keep_latest=False)
            next_item = session.scalar(
                select(QueueItem)
                .where(QueueItem.status == QueueStatus.queued)
                .order_by(QueueItem.queue_position.asc())
                .limit(1)
            )
            if next_item is None:
                return None
            next_item.status = QueueStatus.playing
            return next_item

    def mark_item_resolved(self, item_id: int, stream_url: str) -> None:
        with self.session() as session:
            item = session.get(QueueItem, item_id)
            if item is None:
                return
            item.resolved_stream_url = stream_url
            item.resolved_at = datetime.now(timezone.utc)

    def remove_item(self, item_id: int) -> bool:
        with self._queue_lock, self.session() as session:
            item = session.get(QueueItem, item_id)
            if item is None:
                return False
            if item.status == QueueStatus.playing:
                item.status = QueueStatus.skipped
            else:
                item.status = QueueStatus.removed
            return True

    def reorder_item(self, item_id: int, new_position: int) -> bool:
        with self._queue_lock, self.session() as session:
            queue_items = list(
                session.scalars(
                    select(QueueItem)
                    .where(QueueItem.status == QueueStatus.queued)
                    .order_by(QueueItem.queue_position.asc())
                ).all()
            )
            if not queue_items:
                return False
            idx = next((i for i, item in enumerate(queue_items) if item.id == item_id), None)
            if idx is None:
                return False
            item = queue_items.pop(idx)
            bounded_target = max(0, min(new_position, len(queue_items)))
            queue_items.insert(bounded_target, item)
            for pos, queue_item in enumerate(queue_items, start=1):
                queue_item.queue_position = pos
            return True

    def reorder_queued_items(self, item_ids: list[int]) -> bool:
        with self._queue_lock, self.session() as session:
            queue_items = list(
                session.scalars(
                    select(QueueItem)
                    .where(QueueItem.status == QueueStatus.queued)
                    .order_by(QueueItem.queue_position.asc())
                ).all()
            )
            if not queue_items:
                return False

            items_by_id = {item.id: item for item in queue_items}
            reordered: list[QueueItem] = []
            seen_ids: set[int] = set()

            for item_id in item_ids:
                item = items_by_id.get(item_id)
                if item is None or item.id in seen_ids:
                    continue
                reordered.append(item)
                seen_ids.add(item.id)

            for item in queue_items:
                if item.id in seen_ids:
                    continue
                reordered.append(item)

            for pos, queue_item in enumerate(reordered, start=1):
                queue_item.queue_position = pos
            return True

    def move_item_to_front(self, item_id: int) -> bool:
        return self.reorder_item(item_id=item_id, new_position=0)

    def get_item(self, item_id: int) -> Optional[QueueItem]:
        with self.session() as session:
            return session.get(QueueItem, item_id)
