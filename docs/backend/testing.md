# Backend Testing

Read this before writing or modifying backend tests. For layer rules the tests enforce, see `docs/backend/clean-architecture.md`; for the decision record, `docs/decisions/` (ADR process).

## Layout & commands

- Tests live in `apps/server/tests/` (pytest, ~270 tests, ~5,700 lines). Run from the repo root with the repo-root venv:
  ```bash
  source .venv/bin/activate
  cd apps/server && python -m pytest                 # all
  python -m pytest tests/test_domain.py              # one file
  python -m pytest tests/test_domain.py -k repeat    # one test / keyword
  ```
- The package must be installed **editable** (`pip install -e ".[dev]"`); non-editable installs break the static tests (they resolve paths relative to `app/`).
- CI runs the full suite with JUnit reporting (`.github/workflows/ci.yml`).

## Test map

| File | Covers |
|---|---|
| `test_api.py`, `test_api_extended.py`, `test_system_routes.py` | HTTP surface via FastAPI TestClient |
| `test_architecture.py` | **Static AST layer enforcement** (see below) |
| `test_ports.py` | Protocol/port satisfaction (FfmpegPipeline→Transcoder, HlsSegmenter→StreamSink, YtDlpService→TrackSource, Repository→PlaybackStore, …) |
| `test_domain.py` | Pure playback rules (`app/domain/`) |
| `test_play_track.py` | Play-track orchestration (`app/usecases/`) |
| `test_stream_engine.py`, `test_engine_control_flows.py` | StreamEngine session/retry/transition logic |
| `test_hls_segmenter.py` | HLS segmenting |
| `test_playlist_service.py`, `test_spotify_*` | Playlist + Spotify import services |
| `test_repository.py` | DB facade, stores, migrations |
| `test_state_locking.py` | Concurrency/locking around shared state |
| `test_yt_dlp_*.py`, `test_ffmpeg_*.py`, `test_extractors.py`, `test_binaries_service.py` | Subprocess wrapper services (use fake binaries / recorded fixtures — no network) |
| `test_config.py`, `test_local_folder.py`, `test_media_sources.py`, `test_sync_service.py` | Settings, local-media ingestion, sync |

## Architecture & port enforcement (the unusual part)

Two test files are **lint backstops**, not behavior tests. Breaking them means you violated the layer rules — fix the code, not the test:

- `test_architecture.py` — pure pytest + AST mirrors the import-linter contracts in `apps/server/pyproject.toml` (`[tool.importlinter]`) and `docs/backend/clean-architecture.md`:
  - `domain` imports nothing from `app.api`/`app.db`/`app.services`/`app.usecases`/`app.main`
  - `usecases` imports nothing from `app.api`/`app.db`/`app.services`/`app.main`
  - `domain` bans wall-clock/blocking/IO calls (`time.sleep`, `subprocess`, `socket`, `requests`, …)
- `test_ports.py` — service classes must satisfy the Protocols the engine consumes (`isinstance(x, Transcoder)`-style checks with fakes). If you add an engine collaborator, add a Protocol and a satisfaction test.

import-linter itself runs as a dev tool; the AST tests exist so the rules hold even where import-linter's transitive counting is too coarse.

## Conventions

- Style: ruff config in `apps/server/pyproject.toml`; double quotes, `from __future__ import annotations` where used already.
- Subprocess services are tested with fake executables / argv assertions — never shell out to the real yt-dlp/ffmpeg, never hit the network.
- FastAPI tests build the app via the factory and use `request.app.state` services like production code does.
- New behavior in `domain`/`usecases`/engine logic → test in the matching file; new service → new `test_<service>.py` following the fake-binary pattern.

## Known gaps

- No coverage gate; suite is behavior + architecture focused.
- E2E/browser tests do not exist (`tests_e2e/` was removed upstream; do not recreate without an ADR).
