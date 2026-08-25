"""Repeat-cycle bookkeeping.

StreamEngine tracked replayable items as anonymous 8-tuples copied between
QueueItem and NewQueueItem shapes (three hand-rolled copies existed). This
module gives the tuple a name and centralizes the conversions. Pure: takes
plain attribute holders (duck-typed ORM rows / NewQueueItem dataclasses), no
DB access.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class _HasTrackIdentity(Protocol):
    source_url: str
    provider: str | None
    provider_item_id: str | None
    normalized_url: str
    source_type: str
    title: str | None
    duration_seconds: int | None
    thumbnail_url: str | None


@dataclass(frozen=True)
class RepeatCycleItem:
    source_url: str
    provider: str | None
    provider_item_id: str | None
    normalized_url: str
    source_type: str
    title: str | None
    duration_seconds: int | None
    thumbnail_url: str | None
    playlist_id: int | None = None


def repeat_cycle_item_from(item: _HasTrackIdentity) -> RepeatCycleItem:
    return RepeatCycleItem(
        source_url=item.source_url,
        provider=item.provider,
        provider_item_id=item.provider_item_id,
        normalized_url=item.normalized_url,
        source_type=item.source_type,
        title=item.title,
        duration_seconds=item.duration_seconds,
        thumbnail_url=item.thumbnail_url,
        playlist_id=getattr(item, "playlist_id", None),
    )


def new_item_fields(cycle_item: RepeatCycleItem) -> dict[str, Any]:
    """Kwargs for Repository.enqueue_items from a stored cycle item."""
    return {
        "source_url": cycle_item.source_url,
        "provider": cycle_item.provider,
        "provider_item_id": cycle_item.provider_item_id,
        "normalized_url": cycle_item.normalized_url,
        "source_type": cycle_item.source_type,
        "title": cycle_item.title,
        "duration_seconds": cycle_item.duration_seconds,
        "thumbnail_url": cycle_item.thumbnail_url,
        "playlist_id": cycle_item.playlist_id,
    }


def replay_item_from(item: _HasTrackIdentity) -> dict[str, Any]:
    """Convenience: enqueue kwargs directly from a queue/history row,
    coalescing missing values the same way resume_playback did."""
    fields = new_item_fields(repeat_cycle_item_from(item))
    fields["source_url"] = fields["source_url"] or "unknown"
    return fields
