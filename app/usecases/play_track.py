"""Play one track: resolve → probe → spawn → stream chunks → classify.

Extracted from StreamEngine._play_item's attempt body. The runner owns a
single playback attempt and reports facts; the retry policy, interrupt
dispatch, and state mutation stay with the engine (which implements
AttemptHooks). All time access flows through the injected clock, so tests
drive retries and slow-read paths in microseconds.

Never imports adapters: collaborators arrive as ports/duck-typed objects and
engine capabilities behind the AttemptHooks protocol.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from app.domain.outcomes import (
    AttemptFacts,
    AttemptOutcome,
    classify_attempt,
    expected_duration_seconds,
    slow_chunk_read,
)
from app.domain.ports import Clock, ResolvedTrackLike, Transcoder

logger = logging.getLogger(__name__)


class QueueItemLike(Protocol):
    id: int
    source_url: str
    normalized_url: str | None
    duration_seconds: int | None
    title: str | None


@dataclass(frozen=True)
class TrackAttemptRequest:
    queue_item: QueueItemLike
    attempt: int
    default_seek_seconds: float


@dataclass
class TrackAttemptResult:
    outcome: AttemptOutcome
    reason: str | None = None
    chunks_sent: int = 0
    bytes_sent: int = 0
    elapsed_seconds: float = 0.0
    expected_seconds: float = 0.0
    resolved: ResolvedTrackLike | None = None
    seek_seconds: float = 0.0
    stderr_text: str = field(default="")


@runtime_checkable
class AttemptHooks(Protocol):
    """Engine capabilities the attempt needs. Implemented by StreamEngine."""

    def resolve_track(self, item: QueueItemLike, force_refresh: bool) -> ResolvedTrackLike: ...

    def on_resolved_metadata(self, resolved: ResolvedTrackLike) -> None:
        """State updates (thumbnail/channel/is_live) once metadata is known."""

    def mark_item_resolved(self, item_id: int, normalized_url: str) -> None: ...

    def remember_resolved(self, resolved: ResolvedTrackLike) -> None: ...

    def consume_seek(self, default_seconds: float) -> float: ...

    def set_playback_offset(self, seconds: float) -> None: ...

    def get_prefetched_audio(self, item_id: int) -> str | None: ...

    def prefetch_audio(self, item_id: int, source_url: str) -> None: ...

    def uses_direct_ffmpeg(self, item: QueueItemLike) -> bool: ...

    def register_active_process(self, process: object) -> None: ...

    def trigger_prefetch_upcoming(self) -> None: ...

    def notify_state_changed(self) -> None: ...

    def start_transition_silence(self) -> tuple[object, object]: ...

    def stop_transition_silence(self, stop_event: object, worker: object) -> None: ...

    def on_first_chunk(self) -> None: ...

    def write_chunk(self, chunk: bytes) -> None: ...

    def check_interrupt(self) -> str | None:
        """None = keep going; otherwise the interrupt reason ('stop' ends the engine)."""

    def consume_interrupt_reason(self) -> str: ...


class TrackAttemptRunner:
    def __init__(
        self,
        *,
        transcoder: Transcoder,
        clock: Clock,
        chunk_size: int,
    ) -> None:
        self._transcoder = transcoder
        self._clock = clock
        self._chunk_size = chunk_size

    def run(self, request: TrackAttemptRequest, hooks: AttemptHooks) -> TrackAttemptResult:
        item = request.queue_item
        silence_pair: tuple[object, object] | None = None
        started_at = self._clock()
        phase = "resolve"
        try:
            silence_pair = hooks.start_transition_silence()
            resolved = self._resolve(request, hooks)
            phase = "spawn"
            probed_duration = self._probe_duration(resolved)
            hooks.mark_item_resolved(item.id, resolved.normalized_url)
            hooks.remember_resolved(resolved)
            hooks.on_resolved_metadata(resolved)
            seek_seconds = hooks.consume_seek(request.default_seek_seconds)
            hooks.set_playback_offset(seek_seconds)

            process, source_process = self._spawn(request, resolved, seek_seconds, hooks)
            hooks.trigger_prefetch_upcoming()
            hooks.notify_state_changed()
            logger.info("Notifying state changed before first streamed chunk")

            def _on_first_chunk() -> None:
                nonlocal silence_pair
                if silence_pair is not None:
                    hooks.stop_transition_silence(*silence_pair)
                    silence_pair = None
                hooks.on_first_chunk()

            chunks, byte_count, stderr_text = self._stream_chunks(
                item.id, request.attempt, process, source_process, hooks, _on_first_chunk
            )
            elapsed = max(0.0, self._clock() - started_at)

            reason = self._interrupt_or_none(hooks, allow_stop_only=True)
            if reason is not None:
                raise InterruptedError(reason if reason != "stop" else "stop")

            expected = expected_duration_seconds(probed_duration, resolved.duration_seconds, item.duration_seconds)
            verdict = classify_attempt(
                AttemptFacts(
                    ffmpeg_return_code=self._return_code(process),
                    source_return_code=self._return_code(source_process) if source_process is not None else 0,
                    elapsed_seconds=elapsed,
                    expected_seconds=expected,
                    stderr_text=stderr_text,
                )
            )
            return TrackAttemptResult(
                outcome=verdict.outcome,
                reason=verdict.reason,
                chunks_sent=chunks,
                bytes_sent=byte_count,
                elapsed_seconds=elapsed,
                expected_seconds=expected,
                resolved=resolved,
                seek_seconds=seek_seconds,
                stderr_text=stderr_text,
            )
        except InterruptedError:
            raise
        except Exception as exc:  # resolve/probe/spawn failures become retryable outcomes
            outcome = AttemptOutcome.retry_source if phase == "resolve" else AttemptOutcome.retry_ffmpeg
            return TrackAttemptResult(
                outcome=outcome,
                reason=str(exc),
                elapsed_seconds=max(0.0, self._clock() - started_at),
            )
        finally:
            if silence_pair is not None:
                hooks.stop_transition_silence(*silence_pair)

    # ---------------------------------------------------------------- phases

    def _resolve(self, request: TrackAttemptRequest, hooks: AttemptHooks) -> ResolvedTrackLike:
        return hooks.resolve_track(request.queue_item, force_refresh=request.attempt > 1)

    def _probe_duration(self, resolved: ResolvedTrackLike) -> float | None:
        probe_source = getattr(self._transcoder, "probe_source", None)
        try:
            probe = probe_source(resolved.stream_url) if callable(probe_source) else None
            if probe is None:
                return None
            raw = probe.get("duration_seconds")
            return float(raw) if raw is not None else None
        except Exception:
            return None

    def _spawn(
        self,
        request: TrackAttemptRequest,
        resolved: ResolvedTrackLike,
        seek_seconds: float,
        hooks: AttemptHooks,
    ) -> tuple[object, object | None]:
        item = request.queue_item
        spawn_for_source = getattr(self._transcoder, "spawn_for_source", None)
        if not callable(spawn_for_source):
            raise RuntimeError("ffmpeg source playback is unavailable")
        prefetched = hooks.get_prefetched_audio(item.id)
        if not prefetched and not resolved.is_live and not hooks.uses_direct_ffmpeg(item):
            hooks.prefetch_audio(item.id, item.source_url)
            interrupt = hooks.check_interrupt()
            if interrupt is not None:
                raise InterruptedError(hooks.consume_interrupt_reason())
            prefetched = hooks.get_prefetched_audio(item.id)
        if prefetched:
            process = spawn_for_source(prefetched, start_at_seconds=seek_seconds)
        elif seek_seconds > 0 or resolved.is_live or hooks.uses_direct_ffmpeg(item):
            process = spawn_for_source(resolved.stream_url, start_at_seconds=seek_seconds)
        else:
            raise RuntimeError("ffmpeg source playback is unavailable")
        hooks.register_active_process(process)
        return process, None

    def _stream_chunks(
        self,
        item_id: int,
        attempt: int,
        process: object,
        source_process: object | None,
        hooks: AttemptHooks,
        on_first_chunk,
    ) -> tuple[int, int, str]:
        chunks = 0
        byte_count = 0
        while True:
            interrupt = hooks.check_interrupt()
            if interrupt is not None:
                raise InterruptedError(hooks.consume_interrupt_reason() if interrupt != "stop" else "stop")
            read_started = self._clock()
            chunk = self._read_chunk(process)
            read_seconds = self._clock() - read_started
            if chunk and slow_chunk_read(read_seconds):
                logger.warning(
                    "Slow ffmpeg read while streaming track_id=%s attempt=%s chunk_index=%s "
                    "read_seconds=%.3f requested_bytes=%s received_bytes=%s",
                    item_id, attempt, chunks, read_seconds, self._chunk_size, len(chunk),
                )
            if not chunk:
                return chunks, byte_count, self._stderr_text(process, source_process)
            if chunks == 0:
                on_first_chunk()
            hooks.write_chunk(chunk)
            chunks += 1
            byte_count += len(chunk)

    # --------------------------------------------------------------- helpers

    def _read_chunk(self, process: object) -> bytes:
        read_chunk = getattr(self._transcoder, "read_chunk", None)
        stdout = getattr(process, "stdout", None)
        if callable(read_chunk):
            return read_chunk(stdout, self._chunk_size)
        if stdout is None:
            return b""
        return stdout.read(self._chunk_size)

    @staticmethod
    def _stderr_text(process: object, source_process: object | None) -> str:
        def _read(proc: object) -> str:
            pipe = getattr(proc, "stderr", None)
            if pipe is None:
                return ""
            return pipe.read().decode("utf-8", errors="replace").strip()

        return f"{_read(process)}\n{_read(source_process)}".strip()

    @staticmethod
    def _return_code(process: object) -> int | None:
        poll = getattr(process, "poll", None)
        if callable(poll):
            code = poll()
            if code is not None:
                return code
        wait = getattr(process, "wait", None)
        if callable(wait):
            try:
                wait(timeout=0.2)
            except Exception:  # noqa: S110 - process may already be reaped; poll() below is authoritative
                pass
        if callable(poll):
            return poll()
        return getattr(process, "returncode", None)

    @staticmethod
    def _interrupt_or_none(hooks: AttemptHooks, *, allow_stop_only: bool) -> str | None:
        _ = allow_stop_only
        return hooks.check_interrupt()


__all__ = ["AttemptHooks", "QueueItemLike", "TrackAttemptRequest", "TrackAttemptResult", "TrackAttemptRunner"]
