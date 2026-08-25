"""Shuffle ordering, extracted from StreamEngine.set_shuffle_enabled.

Pure: the RNG is injected so tests are deterministic.
"""

from __future__ import annotations

import random
from collections.abc import Sequence


def shuffled_order(ids: Sequence[int], rng: random.Random | None = None) -> list[int]:
    order = list(ids)
    (rng or random).shuffle(order)
    return order


def restore_order(current: Sequence[int], restore: Sequence[int] | None) -> list[int] | None:
    """Return the canonical order for `current` ids given a saved `restore`
    snapshot; None when nothing to restore (ids vanished from the queue)."""
    if not restore:
        return None
    known = set(current)
    ordered = [i for i in restore if i in known]
    return ordered or None
