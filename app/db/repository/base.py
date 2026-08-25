"""Repository base: connection plumbing shared by all store mixins.

The single `_queue_lock` lives here and spans every queue/history mutation —
splitting it would reintroduce races (see docs/backend/clean-architecture.md
exceptions list).
"""

import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from threading import Lock
from typing import Iterator

from sqlalchemy import Engine, create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.db.models import QueueItem, QueueStatus


@dataclass
class NewQueueItem:
    source_url: str
    normalized_url: str
    source_type: str
    provider: str | None = None
    provider_item_id: str | None = None
    title: str | None = None
    channel: str | None = None
    duration_seconds: int | None = None
    thumbnail_url: str | None = None
    playlist_id: uuid.UUID | None = None


@dataclass
class NewPlaylistEntry:
    source_url: str
    normalized_url: str
    provider: str | None = None
    provider_item_id: str | None = None
    upstream_item_id: str | None = None
    title: str | None = None
    channel: str | None = None
    duration_seconds: int | None = None
    thumbnail_url: str | None = None

class _RepositoryBase:
    """Shared engine/session/lock plumbing. Composed into Repository."""

    def __init__(self, db_url: str) -> None:
        self.engine: Engine = create_engine(db_url, future=True)
        self._session_factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self._queue_lock = Lock()

    @contextmanager
    def session(self) -> Iterator[Session]:
        session = self._session_factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def _next_position(self, session: Session) -> int:
        current_max = session.scalar(select(func.max(QueueItem.queue_position)).where(QueueItem.status == QueueStatus.queued))
        return int(current_max or 0) + 1
