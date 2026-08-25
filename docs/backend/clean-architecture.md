# Clean Architecture Rules (Backend)

Read this before touching `app/domain/`, `app/usecases/`, or the playback
pipeline. This document is the single source of truth for layering rules,
enforced by import-linter contracts and `tests/test_architecture.py` — code
that violates it fails CI, not review.

Influences: Robert C. Martin's dependency rule (Clean Architecture), Hexagonal
Architecture ports/adapters, community Python practice (py-clean-arch), and
the official FastAPI "Bigger Applications" guide. This is a *scaled-down*
Clean Architecture: strict where it pays (the playback pipeline), plain
layered elsewhere (AGENTS.md hard rule 2 still governs the rest).

## The dependency rule

```
        ┌─────────────────────────────────────────┐
        │                main.py                   │  composition root:
        │  builds adapters, injects into usecases  │  the ONLY place that
        └───────────────┬─────────────────────────┘  knows everything
                        │ constructs
        ┌───────────────▼─────────────────────────┐
        │  api/  (routers, serializers, models)    │
        └───────────────┬─────────────────────────┘
                        │ calls
        ┌───────────────▼─────────────────────────┐
        │  usecases/  (application services)       │
        └───────────────┬─────────────────────────┘
                        │ uses ports (Protocols)
        ┌───────────────▼─────────────────────────┐
        │  domain/  (pure Python, zero deps)       │
        └───────────────▲─────────────────────────┘
                        │ implements ports
        ┌───────────────┴─────────────────────────┐
        │  adapters = services/ + db/  (I/O world) │
        └──────────────────────────────────────────┘
```

Dependencies point INWARD only (toward `domain/`). Adapters depend on domain;
domain depends on nothing (stdlib excepted).

## Layers

| Layer | Path | One-sentence role | May import |
|---|---|---|---|
| **domain** | `app/domain/` | Pure business rules and data: state shapes, outcome classification, progress math, repeat-cycle bookkeeping, port definitions | stdlib only |
| **usecases** | `app/usecases/` | Orchestration of domain logic through ports: one playback attempt, the retry/interrupt session, the queue-advance cycle | `domain` only |
| **adapters** | `app/services/`, `app/db/` | All I/O: subprocesses (ffmpeg/yt-dlp), SQLite, the HLS segmenter, HTTP-facing facades | `domain`, `db`, `lib`, sibling adapters |
| **api** | `app/api/` | HTTP/WS surface: validate, delegate, shape responses (AGENTS.md rule: no business logic) | `services`, `domain` (re-exports), `db` types |
| **composition root** | `app/main.py` | Constructs adapters, wires ports into usecases, owns lifespan | everything |

Existing non-playback services (PlaylistService, SyncService,
BinariesService, ...) stay as plain services in `app/services/`. They are
adapters in spirit but do NOT get ports — see "Port creation rule".

## domain/ rules (strictest layer)

1. **Zero project imports.** `import app.*` inside `app/domain/` is a build
   failure (enforced by import-linter + test). stdlib (`dataclasses`,
   `enum`, `typing`, `math`, ...) is allowed.
2. **No I/O, ever.** No `time.sleep`, no reading the wall clock (`time.time`,
   `time.monotonic`), no file/network/subprocess access, no threads. Time
   comes in through a `Clock` port or as plain arguments.
3. **Dataclasses/enums/Protocols/pure functions only.** No ORMs, no Pydantic
   models (those are API-layer DTOs), no FastAPI anything.
4. **Deterministic given inputs.** Any randomness arrives as an injected RNG
   or random value argument.
5. Public names here are stable API for the rest of the codebase — renaming
   requires updating `docs/backend/architecture.md` in the same commit.

## ports.py rules

All ports live in `app/domain/ports.py` as `typing.Protocol` classes.

| Port | Adapter implementing it | Used by |
|---|---|---|
| `TrackSource` | `services/yt_dlp_service.py` (`resolve_video`, `spawn_audio_download`) | play_track usecase |
| `Transcoder` | `services/ffmpeg_pipeline.py` (`spawn_for_source`, `spawn_silence`, `read_chunk`, `probe_source`) | play_track usecase |
| `StreamSink` | `services/hls_segmenter.py` (`write`, `purge`, ...) | engine facade |
| `PlaybackStore` | `app/db/repository/` (queue/history mutation surface the usecases call) | playback session |
| `Clock` / `Sleeper` | trivial injected callables (prod: `time.monotonic`, `time.sleep`) | all usecases |

**Port creation rule (minimalism):** a new port is justified ONLY when
`domain/` or `usecases/` must call the capability directly. Ports exist for
the playback pipeline; everything else keeps the existing layered call style
(`api → services`). Do not port-ify services that only the API layer calls.

- Ports describe *behavior*, not adapters: method names chosen for the
  domain's vocabulary, not yt-dlp's.
- Adapters declare conformance implicitly (structural typing). A test
  (`tests/test_ports.py`) asserts each production adapter satisfies its
  Protocol via `isinstance(adapter, Protocol)` runtime checks, so drift
  (renamed method, changed signature) fails CI instead of exploding at
  runtime in the worker thread.

## usecases/ rules

1. Import from `domain` only. Never from `services`, `db`, `api`, `main` —
   enforced by import-linter.
2. Orchestrators return **result objects** (dataclasses in domain); they do
   not raise adapter exceptions upward. Adapter exceptions are translated at
   the usecase boundary into domain outcomes/errors.
3. No direct HTTP concepts (status codes, Request objects), no SQL, no
   subprocess handles.
4. Time waits go through the `Sleeper` port — tests inject no-op sleepers so
   retry/poll paths run in microseconds.
5. One usecase module = one narrative ("play one track with retries",
   "advance the queue"). If a module needs a paragraph to describe, split it.

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| domain module | noun or short noun-phrase, snake_case | `outcomes.py`, `repeat_cycle.py` |
| domain dataclass | singular noun | `RepeatCycleItem` |
| port | noun describing capability, no `Port` suffix, no `I` prefix | `TrackSource`, `Clock` |
| adapter | existing service names stay (public surface frozen) | `YtDlpService` |
| usecase module | verb_phrase describing the narrative | `play_track.py` |
| usecase result | `<Action>Result` | `TrackAttemptResult` |
| test module | mirrors target path | `app/domain/outcomes.py` → `tests/test_domain_outcomes.py` |

## Facade freeze (compatibility contract)

`app/services/stream_engine.py` keeps exporting `StreamEngine`,
`PlaybackMode`, `RepeatMode`, `PlaybackState`; `app/db/repository.py` (or
`repository/` package `__init__`) keeps exporting `Repository`,
`NewQueueItem`, `NewPlaylistEntry` with today's constructor/method surface.
Import sites and test monkeypatch targets must not break during the
migration. Internal decomposition may proceed freely behind the facade.

## Exceptions to Clean (do not "fix" silently)

These predate the migration and stay as-is — changing them is a behavioral
change requiring explicit approval:

- Repository manual migrations: `_ensure_*_column` pattern in `init_db`
  (AGENTS.md hard rule 7). No Alembic, no third path.
- `Repository.session()` stays public (tests use it directly).
- Single `_queue_lock` spanning queue ops + `mark_playback_finished`.
- `PlaybackState` is currently written from API and worker threads without a
  lock (known race, tracked separately).
- Subprocess spawning stays list-argv `Popen`, never `shell=True`.

## Enforcement

Three gates, all in CI:

1. **import-linter** (`pyproject.toml [tool.importlinter]`): layer contracts
   — `domain` imports nothing from app; `usecases` imports only `domain`;
   overall `domain ← usecases ← adapters ← api ← main` direction.
2. **`tests/test_architecture.py`**: pure-pytest backstop (works even without
   import-linter installed) — walks `app/domain/` and `app/usecases/` ASTs
   asserting no forbidden imports, plus scans domain source for `time.sleep`,
   `time.time`, `time.monotonic`, `subprocess`, `socket`.
3. **ruff**: lint for new layers from day one (strict per-file config);
   legacy files join the strict set only when touched by the migration, so
   review diffs stay about structure, not style churn.

## Migration map (living — update as phases land)

| Current | Target | Status |
|---|---|---|
| `stream_engine._stderr_indicates_stream_failure` | `domain/outcomes.py` | done |
| outcome classification in `_play_item` (premature-end etc.) | `domain/outcomes.py` | done |
| `playback_progress` math | `domain/progress.py` | done |
| 8-tuple repeat-cycle bookkeeping | `domain/repeat_cycle.py` (`RepeatCycleItem`) | done |
| seek math, shuffle restore order | `domain/seek.py`, `domain/shuffle_order.py` | done |
| `_play_item` attempt body | `usecases/play_track.py` | done |
| retry/interrupt dispatch | `usecases/playback_session.py` | done |
| `repository.py` monolith | `app/db/repository/` package + facade | done (retry/interrupt dispatch stayed in the engine — simpler than a separate session module; the runner covers the attempt narrative) |
