"""Repository facade: composes the store mixins into the frozen public
class. Import surface (Repository, NewQueueItem, NewPlaylistEntry) is frozen
per docs/backend/clean-architecture.md.
"""

from __future__ import annotations

from app.db.repository.base import _RepositoryBase
from app.db.repository.history_store import _HistoryStoreMixin
from app.db.repository.migrations import _MigrationMixin
from app.db.repository.playlist_store import _PlaylistStoreMixin
from app.db.repository.queue_store import _QueueStoreMixin
from app.db.repository.settings_store import _SettingsStoreMixin


class Repository(
    _QueueStoreMixin,
    _HistoryStoreMixin,
    _PlaylistStoreMixin,
    _SettingsStoreMixin,
    _MigrationMixin,
    _RepositoryBase,
):
    """All persistence. See docs/backend/architecture.md."""
