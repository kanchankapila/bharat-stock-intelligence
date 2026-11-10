"""The installed compiled wheels must load under Windows Smart App Control.

SAC blocks a .pyd by file hash and has withdrawn approval of versions that previously
loaded (psycopg-binary 3.3.6 on 2026-10-07, 3.3.5 on 2026-11-09). A blocked libpq wrapper
makes `bqa-scheduler` crash-loop at import, so this fails in the venv instead.
"""
from __future__ import annotations

import importlib

import pytest


def test_psycopg_uses_compiled_libpq_wrapper():
    import psycopg

    assert psycopg.pq.__impl__ in ("binary", "c")


@pytest.mark.parametrize("module", ["numpy", "scipy.linalg", "pandas", "pyarrow", "sklearn.linear_model", "lightgbm"])
def test_compiled_dependency_imports(module):
    importlib.import_module(module)
