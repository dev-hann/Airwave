"""Seek-position math, extracted from StreamEngine.seek_to_*.

Pure functions: percent <-> seconds conversion with clamping. Callers own
the duration source.
"""

from __future__ import annotations


def seconds_from_percent(percent: float, duration_seconds: float | None) -> float:
    if not duration_seconds or duration_seconds <= 0:
        return 0.0
    clamped = min(100.0, max(0.0, float(percent)))
    return clamped / 100.0 * float(duration_seconds)


def clamp_seek_seconds(seconds: float, duration_seconds: float | None) -> float:
    value = max(0.0, float(seconds))
    if duration_seconds and duration_seconds > 0:
        value = min(value, float(duration_seconds))
    return value
