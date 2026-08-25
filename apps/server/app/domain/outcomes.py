"""Playback attempt outcome classification.

Pure decision logic extracted from StreamEngine._play_item: given an
attempt's observable facts (durations, exit codes, elapsed time, captured
stderr) decide whether the attempt completed, failed hard, or ended early
after an upstream transport failure. Time values arrive as arguments — the
caller injects the clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

FAILURE_MARKERS = (
    "input/output error",
    "read error",
    "error in the pull function",
    "session has been invalidated",
    "connection reset",
    "end of file",
)


def stderr_indicates_stream_failure(stderr_text: str) -> bool:
    normalized = (stderr_text or "").lower()
    return any(marker in normalized for marker in FAILURE_MARKERS)


def expected_duration_seconds(
    probed: float | None,
    resolved: int | None,
    queued: int | None,
) -> float:
    """First credible duration source wins: ffprobe > yt-dlp metadata > queue item."""
    for value in (probed, float(resolved) if resolved else None, float(queued) if queued else None):
        if value:
            return float(value)
    return 0.0


def ended_prematurely(elapsed_seconds: float, expected_seconds: float) -> bool:
    """A track that ran less than 90% of its expected (long) duration ended early."""
    return bool(expected_seconds > 30 and elapsed_seconds < expected_seconds * 0.9)


def completed_unusually_fast(elapsed_seconds: float, expected_seconds: float) -> bool:
    """Suspiciously short run of a long track — worth a warning log."""
    return bool(expected_seconds > 30 and elapsed_seconds < expected_seconds * 0.2)


def slow_chunk_read(read_seconds: float, threshold_seconds: float = 0.3) -> bool:
    return read_seconds >= threshold_seconds


class AttemptOutcome(StrEnum):
    completed = "completed"
    retry_ffmpeg = "retry_ffmpeg"
    retry_source = "retry_source"
    premature_end = "premature_end"


@dataclass(frozen=True)
class AttemptFacts:
    """Observable facts of one finished playback attempt."""

    ffmpeg_return_code: int | None
    source_return_code: int | None
    elapsed_seconds: float
    expected_seconds: float
    stderr_text: str = ""


@dataclass(frozen=True)
class AttemptVerdict:
    outcome: AttemptOutcome
    reason: str | None = None


def classify_attempt(facts: AttemptFacts) -> AttemptVerdict:
    if facts.ffmpeg_return_code not in (None, 0):
        return AttemptVerdict(AttemptOutcome.retry_ffmpeg, f"ffmpeg exited with status {facts.ffmpeg_return_code}")
    if facts.source_return_code not in (None, 0):
        return AttemptVerdict(AttemptOutcome.retry_source, f"source exited with status {facts.source_return_code}")
    if ended_prematurely(facts.elapsed_seconds, facts.expected_seconds) and stderr_indicates_stream_failure(
        facts.stderr_text
    ):
        return AttemptVerdict(AttemptOutcome.premature_end, "upstream stream ended early after transport failure")
    return AttemptVerdict(AttemptOutcome.completed)
