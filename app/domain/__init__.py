"""Domain layer (pure Python). See docs/backend/clean-architecture.md.

No app imports, no I/O, no wall clock — enforced by tests/test_architecture.py.
"""

from app.domain.playback_state import PlaybackMode, PlaybackState, RepeatMode
from app.domain.shuffle_order import restore_order, shuffled_order

__all__ = [
    "PlaybackMode",
    "PlaybackState",
    "RepeatMode",
    "restore_order",
    "shuffled_order",
]
