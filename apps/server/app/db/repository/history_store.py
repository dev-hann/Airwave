"""Play-history domain. mark_playback_finished deliberately lives here
with access to the shared queue lock: it writes queue status AND history
rows in one locked section (documented cross-domain exception).
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete, select

from app.db.models import PlayHistory, QueueItem, QueueStatus


class _HistoryStoreMixin:
    def list_history(self, limit: int = 50) -> list[PlayHistory]:
        with self.session() as session:
            stmt = select(PlayHistory).order_by(PlayHistory.started_at.desc()).limit(limit)
            return list(session.scalars(stmt).all())

    def clear_history(self) -> int:
        with self.session() as session:
            result = session.execute(delete(PlayHistory))
            return int(result.rowcount or 0)

    def mark_playback_finished(self, item_id: int, status: QueueStatus, error_message: str | None = None) -> None:
        with self._queue_lock, self.session() as session:
            item = session.get(QueueItem, item_id)
            if item is None:
                return
            item.status = status
            session.add(
                PlayHistory(
                    queue_item_id=item.id,
                    title=item.title,
                    source_url=item.source_url,
                    provider=item.provider,
                    provider_item_id=item.provider_item_id,
                    thumbnail_url=item.thumbnail_url,
                    status=status.value,
                    error_message=error_message,
                    finished_at=datetime.now(timezone.utc),
                )
            )
