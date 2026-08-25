#!/usr/bin/env python3
"""Export the OpenAPI schema for frontend type generation.

Run from anywhere; resolves the server package relative to the repo root.
Uses create_app(start_engine=False) so no subprocesses or workers start.

Usage:
    python scripts/export_openapi.py          # writes ./openapi.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = REPO_ROOT / "apps" / "server"
OUTPUT = REPO_ROOT / "openapi.json"


def main() -> int:
    sys.path.insert(0, str(SERVER_DIR))
    try:
        from app.main import create_app
    except ImportError as exc:
        print(f"Cannot import server package from {SERVER_DIR}: {exc}", file=sys.stderr)
        return 1

    app = create_app(start_engine=False)
    schema = app.openapi()
    OUTPUT.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
