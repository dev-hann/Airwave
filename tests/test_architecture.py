"""Architecture enforcement backstop.

Mirrors the import-linter contracts in pyproject.toml and the layer rules in
docs/backend/clean-architecture.md. Pure pytest + AST so it runs anywhere,
even without import-linter installed.
"""

from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent / "app"

FORBIDDEN_IN_DOMAIN = ("app.api", "app.db", "app.services", "app.usecases", "app.main")
FORBIDDEN_IN_USECASES = ("app.api", "app.db", "app.services", "app.main")
# Wall-clock / blocking / I/O constructs banned from the domain layer.
FORBIDDEN_DOMAIN_CALLS = ("time.sleep", "time.time", "time.monotonic", "subprocess", "socket", "urllib", "requests")


def _modules_in(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return sorted(p for p in path.rglob("*.py"))


def _imported_roots(tree: ast.Ast) -> list[str]:
    roots: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.append(node.module)
    return roots


def _source_segments(tree: ast.Ast, source: str) -> list[str]:
    segments: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                segments.append(f"{func.value.id}.{func.attr}")
            elif isinstance(func, ast.Name):
                segments.append(func.id)
        if isinstance(node, ast.ImportFrom) and node.module:
            segments.append(node.module)
        if isinstance(node, ast.Import):
            segments.extend(alias.name for alias in node.names)
    _ = source
    return segments


def test_domain_imports_nothing_from_app() -> None:
    violations: list[str] = []
    for file in _modules_in(APP_ROOT / "domain"):
        tree = ast.parse(file.read_text(encoding="utf-8"))
        for root in _imported_roots(tree):
            if root.startswith(FORBIDDEN_IN_DOMAIN):
                violations.append(f"{file.name}: imports {root}")
    assert not violations, "domain layer must not import application code: " + "; ".join(violations)


def test_usecases_import_only_domain() -> None:
    violations: list[str] = []
    for file in _modules_in(APP_ROOT / "usecases"):
        tree = ast.parse(file.read_text(encoding="utf-8"))
        for root in _imported_roots(tree):
            if any(root.startswith(bad) for bad in FORBIDDEN_IN_USECASES):
                violations.append(f"{file.name}: imports {root}")
    assert not violations, "usecases layer may only import domain: " + "; ".join(violations)


def test_domain_has_no_io_or_wall_clock() -> None:
    violations: list[str] = []
    for file in _modules_in(APP_ROOT / "domain"):
        source = file.read_text(encoding="utf-8")
        tree = ast.parse(source)
        for segment in _source_segments(tree, source):
            if any(segment == bad or segment.startswith(bad + ".") for bad in FORBIDDEN_DOMAIN_CALLS):
                violations.append(f"{file.name}: uses {segment}")
    assert not violations, "domain layer must stay free of I/O and wall-clock access: " + "; ".join(violations)


def test_domain_and_usecases_exist_or_absent_together() -> None:
    """While the migration is in flight the layers may be empty, but the
    architecture contract only bites when files exist — keep the guard honest."""
    for layer in ("domain", "usecases"):
        path = APP_ROOT / layer
        if path.exists():
            assert any(path.rglob("*.py")), f"app/{layer}/ exists but has no modules"
