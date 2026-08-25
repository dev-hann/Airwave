"""Persistence package. The public surface is frozen:
`Repository`, `NewQueueItem`, `NewPlaylistEntry` — imported from here by the
rest of the app and tests.
"""

from app.db.repository.base import NewPlaylistEntry, NewQueueItem
from app.db.repository.repository import Repository

__all__ = ["NewPlaylistEntry", "NewQueueItem", "Repository"]
