"""Guard: never write into the array `Series.to_numpy()` hands back.

pandas 3 returns a READ-ONLY view, pandas 2 a writable one. CI runs 3, a dev box here runs 2,
so this fails only on CI — it did, twice over, in one afternoon (index_event_features, and the
identical pattern in event_features that no test had ever reached).

Derived from the source tree rather than a list someone maintains, so a new instance fails this
test instead of waiting for CI to find it.
"""
from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "bharat_alpha"


def _view_writes(tree: ast.AST) -> list[tuple[str, int]]:
    """Names bound to a copy-less .to_numpy() and later subscript-assigned in the same function."""
    out = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        views: dict[str, int] = {}
        for node in ast.walk(fn):
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                    and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Attribute)
                    and node.value.func.attr == "to_numpy"
                    and not any(k.arg == "copy" for k in node.value.keywords)):
                views[node.targets[0].id] = node.lineno
        for node in ast.walk(fn):
            if isinstance(node, (ast.Assign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for t in targets:
                    if (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name)
                            and t.value.id in views):
                        out.append((t.value.id, node.lineno))
    return out


def test_no_source_file_writes_into_a_to_numpy_view():
    offenders = []
    for path in sorted(SRC.rglob("*.py")):
        for name, line in _view_writes(ast.parse(path.read_text())):
            offenders.append(f"{path.relative_to(SRC.parent.parent)}:{line} writes into `{name}` "
                             f"from a copy-less .to_numpy() — pass copy=True")
    assert not offenders, "\n".join(offenders)


def test_the_scan_actually_detects_the_pattern():
    """Without this, a scan that silently matches nothing would pass for the wrong reason."""
    bad = ast.parse("def f(df):\n    col = df['x'].to_numpy()\n    col[0:2] = 1.0\n    return col\n")
    good = ast.parse("def f(df):\n    col = df['x'].to_numpy(copy=True)\n    col[0:2] = 1.0\n    return col\n")
    assert _view_writes(bad) and not _view_writes(good)
