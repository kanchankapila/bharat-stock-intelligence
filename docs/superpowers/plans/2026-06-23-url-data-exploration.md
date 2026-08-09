# URL Data Exploration Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A re-runnable Python tool that reads `urls.txt`, collapses near-duplicate URLs into endpoint templates, fetches each, stores raw responses + a catalog in Postgres, and reports which fields look useful for the model (coverage + correlation).

**Architecture:** A focused package `src/server/url_explorer/` with one responsibility per module (normalizer → fetcher → store → profiler → correlator → report), orchestrated by a CLI (`explore.py`). All DB access goes through the existing `db_compat` facade (SQLite/Postgres dual-mode). Network and DB are dependency-injected so the unit suite is hermetic (no live calls), mirroring `test_intraday_fetcher.py`.

**Tech Stack:** Python 3.11 (venv at `backend-python/venv`), `curl_cffi` (chrome impersonation) + `requests` fallback, `pandas`/`scipy` for profiling+correlation, `db_compat` for storage, `pytest` 9.x.

## Global Constraints

- All DB access via `db_compat` (`from db_compat import query_all, execute, ...`). Never open raw `sqlite3`/`psycopg2` in package code. Pass parameters as a positional tuple/list with `?` placeholders (the translator converts to `$n` for Postgres).
- Tests import package modules after `sys.path.insert(0, <src/server>)`; DB tests inject a temp SQLite via `os.environ["DATABASE_URL"]` + `importlib.reload(db_compat)` and restore env in an autouse fixture (copy the pattern from `src/server/tests/test_intraday_fetcher.py`).
- No network in unit tests. `fetcher.fetch_all` accepts a `fetch_fn` injection; default only used in live runs.
- Run tests with: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_<x>.py -v` from repo root `d:\Github\bharat-stock-intelligence`.
- Python entry points run from `src/server/` (so `import db_compat` and `import url_explorer...` resolve), e.g. `cd src/server && ../../backend-python/venv/Scripts/python.exe -m url_explorer.explore`.
- Dataclasses are the shared interface types. Names/fields below are canonical — later tasks must use them verbatim.

---

### Task 1: `normalizer.py` — URL → endpoint template + typed params

**Files:**
- Create: `src/server/url_explorer/__init__.py` (empty)
- Create: `src/server/url_explorer/normalizer.py`
- Test: `src/server/tests/test_url_explorer_normalizer.py`

**Interfaces:**
- Produces:
  - `@dataclass ParamSpec(name:str, location:str, inferred_type:str, is_variable:bool, distinct_count:int, sample_values:list[str])` — `location` ∈ `{"path","query"}`; `inferred_type` ∈ `{"ticker","date","epoch","int_id","enum","string","const"}`.
  - `@dataclass EndpointTemplate(template:str, host:str, path_skeleton:str, query_keys:list[str], method:str, params:list[ParamSpec], urls:list[str])`.
  - `classify_value(value:str, universe:set[str]) -> str` — returns an `inferred_type` (never `"const"`; const is decided by variability, not value).
  - `normalize(urls:list[str], universe:set[str]) -> list[EndpointTemplate]`.

- [x] **Step 1: Write the failing test**

```python
# src/server/tests/test_url_explorer_normalizer.py
import os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import classify_value, normalize

UNIVERSE = {"INFY", "HDFCBANK", "TCS"}

class TestClassifyValue:
    def test_ticker(self):
        assert classify_value("INFY", UNIVERSE) == "ticker"
    def test_date(self):
        assert classify_value("2026-06-23", UNIVERSE) == "date"
    def test_epoch(self):
        assert classify_value("1781207470", UNIVERSE) == "epoch"
    def test_int_id(self):
        assert classify_value("533", UNIVERSE) == "int_id"
    def test_string(self):
        assert classify_value("all", UNIVERSE) == "string"

class TestNormalize:
    def test_kayal_collapses_to_one_endpoint(self):
        urls = [
            "https://kayal.trendlyne.com/x/get/?perPageCount=200&pageNumber=0&screenpk=19814&groupType=all",
            "https://kayal.trendlyne.com/x/get/?perPageCount=200&pageNumber=0&screenpk=3057&groupType=all",
            "https://kayal.trendlyne.com/x/get/?perPageCount=200&pageNumber=0&screenpk=6211&groupType=all",
        ]
        eps = normalize(urls, UNIVERSE)
        assert len(eps) == 1
        ep = eps[0]
        assert ep.host == "kayal.trendlyne.com"
        assert len(ep.urls) == 3
        screenpk = next(p for p in ep.params if p.name == "screenpk")
        assert screenpk.is_variable is True
        assert screenpk.inferred_type == "int_id"
        ptype = next(p for p in ep.params if p.name == "perPageCount")
        assert ptype.is_variable is False
        assert ptype.inferred_type == "const"

    def test_rest_path_ids_templated(self):
        urls = [
            "https://trendlyne.com/web-widget/qvt-widget/533/HDFCBANK/",
            "https://trendlyne.com/web-widget/qvt-widget/1594/INFY/",
        ]
        eps = normalize(urls, UNIVERSE)
        assert len(eps) == 1
        assert eps[0].path_skeleton == "/web-widget/qvt-widget/{int_id}/{ticker}/"
        locs = {(p.name, p.location, p.inferred_type) for p in eps[0].params}
        assert ("path_2", "path", "int_id") in locs
        assert ("path_3", "path", "ticker") in locs

    def test_distinct_endpoints_separate(self):
        urls = [
            "https://a.com/p/?x=1",
            "https://b.com/p/?x=1",
        ]
        assert len(normalize(urls, UNIVERSE)) == 2
```

- [x] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_normalizer.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'url_explorer'`.

- [x] **Step 3: Write minimal implementation**

```python
# src/server/url_explorer/__init__.py
```
(empty file)

```python
# src/server/url_explorer/normalizer.py
"""URL -> endpoint template + typed parameter catalog (hybrid structural + entity)."""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from urllib.parse import urlsplit, parse_qsl

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_INT_RE = re.compile(r"^\d+$")
# unix-seconds plausible window: 2001-09-09 .. 2033-05-18
_EPOCH_LO, _EPOCH_HI = 1_000_000_000, 2_000_000_000


@dataclass
class ParamSpec:
    name: str
    location: str            # "path" | "query"
    inferred_type: str       # ticker|date|epoch|int_id|enum|string|const
    is_variable: bool
    distinct_count: int
    sample_values: list[str]


@dataclass
class EndpointTemplate:
    template: str
    host: str
    path_skeleton: str
    query_keys: list[str]
    method: str
    params: list[ParamSpec]
    urls: list[str] = field(default_factory=list)


def classify_value(value: str, universe: set[str]) -> str:
    v = (value or "").strip()
    if not v:
        return "string"
    if v.upper() in universe:
        return "ticker"
    if _DATE_RE.match(v):
        return "date"
    if _INT_RE.match(v):
        n = int(v)
        if len(v) == 10 and _EPOCH_LO <= n <= _EPOCH_HI:
            return "epoch"
        return "int_id"
    return "string"


def _path_segments(path: str) -> list[str]:
    return [s for s in path.split("/") if s != ""]


def _structural_key(host: str, segs: list[str], query_keys: list[str]) -> str:
    """Two URLs share a template if host, path length, and query-key set match."""
    return f"{host}|seglen={len(segs)}|q={','.join(sorted(query_keys))}"


def normalize(urls: list[str], universe: set[str]) -> list[EndpointTemplate]:
    universe = {u.upper() for u in universe}
    groups: dict[str, list[tuple]] = defaultdict(list)
    for raw in urls:
        raw = raw.strip()
        if not raw:
            continue
        sp = urlsplit(raw)
        segs = _path_segments(sp.path)
        q = parse_qsl(sp.query, keep_blank_values=True)
        qkeys = [k for k, _ in q]
        key = _structural_key(sp.netloc, segs, qkeys)
        groups[key].append((raw, sp.netloc, sp.path, segs, dict(q), qkeys))

    endpoints: list[EndpointTemplate] = []
    for members in groups.values():
        host = members[0][1]
        seg_count = len(members[0][3])
        qkeys = members[0][5]

        # Collect values per path index and per query key across members.
        path_vals: dict[int, list[str]] = {i: [] for i in range(seg_count)}
        query_vals: dict[str, list[str]] = {k: [] for k in qkeys}
        for _, _, _, segs, qd, _ in members:
            for i in range(seg_count):
                path_vals[i].append(segs[i])
            for k in qkeys:
                query_vals[k].append(qd.get(k, ""))

        params: list[ParamSpec] = []
        skeleton_segs: list[str] = []
        for i in range(seg_count):
            vals = path_vals[i]
            distinct = sorted(set(vals))
            is_var = len(distinct) > 1
            if is_var:
                itype = classify_value(distinct[0], universe)
                skeleton_segs.append("{" + itype + "}")
                params.append(ParamSpec(f"path_{i}", "path", itype, True,
                                        len(distinct), distinct[:5]))
            else:
                skeleton_segs.append(vals[0])
        path_skeleton = "/" + "/".join(skeleton_segs) + ("/" if seg_count else "")

        for k in qkeys:
            vals = query_vals[k]
            distinct = sorted(set(vals))
            is_var = len(distinct) > 1
            itype = classify_value(distinct[0], universe) if is_var else "const"
            params.append(ParamSpec(k, "query", itype, is_var,
                                    len(distinct), distinct[:5]))

        template = f"https://{host}{path_skeleton}?{'&'.join(sorted(qkeys))}"
        endpoints.append(EndpointTemplate(
            template=template, host=host, path_skeleton=path_skeleton,
            query_keys=sorted(qkeys), method="GET", params=params,
            urls=[m[0] for m in members],
        ))
    return endpoints
```

- [x] **Step 4: Run test to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_normalizer.py -v`
Expected: PASS (8 tests).

- [x] **Step 5: Commit**

```bash
git add src/server/url_explorer/__init__.py src/server/url_explorer/normalizer.py src/server/tests/test_url_explorer_normalizer.py
git commit -m "feat(url-explorer): URL normalizer with hybrid param typing"
```

---

### Task 2: `store.py` — schema + db_compat writers

**Files:**
- Create: `src/server/url_explorer/store.py`
- Test: `src/server/tests/test_url_explorer_store.py`

**Interfaces:**
- Consumes: `EndpointTemplate`, `ParamSpec` (Task 1).
- Produces:
  - `ensure_schema() -> None`
  - `upsert_endpoint(t:EndpointTemplate) -> int` (endpoint id)
  - `upsert_params(endpoint_id:int, params:list[ParamSpec]) -> None`
  - `insert_fetch(endpoint_id:int, concrete_url:str, params_json:str, http_status:int, latency_ms:int, ok:bool, response_bytes:int, raw_json:str|None, error:str|None) -> int`
  - `insert_field(endpoint_id:int, run_at:str, p:"FieldProfile") -> None` (FieldProfile from Task 4; `store` reads attributes `field_path,dtype,fill_rate,cardinality,num_min,num_max,num_mean,universe_overlap_pct,changed_vs_last`)
  - `insert_correlation(endpoint_id:int, run_at:str, c:"Correlation") -> None` (Correlation from Task 5; attrs `field_path,target,n,pearson,spearman,ic`)
  - `last_run_field_paths(endpoint_id:int) -> set[str]` (for Task 4 change detection)

- [x] **Step 1: Write the failing test**

```python
# src/server/tests/test_url_explorer_store.py
import importlib, os, sqlite3, sys, tempfile
import pytest
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate, ParamSpec

@pytest.fixture(autouse=True)
def _db():
    saved = {k: os.environ.get(k) for k in ("DATABASE_URL", "USE_POSTGRES")}
    path = os.path.join(tempfile.mkdtemp(), "store_test.sqlite")
    os.environ.pop("USE_POSTGRES", None)
    os.environ["DATABASE_URL"] = f"sqlite:///{path}"
    import db_compat; importlib.reload(db_compat)
    import url_explorer.store as store; importlib.reload(store)
    store.ensure_schema()
    yield store, path
    for k, v in saved.items():
        os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
    importlib.reload(db_compat)

def _ep():
    return EndpointTemplate(
        template="https://h/p/?x", host="h", path_skeleton="/p/",
        query_keys=["x"], method="GET",
        params=[ParamSpec("x", "query", "int_id", True, 3, ["1", "2"])], urls=["u1", "u2"])

def test_upsert_endpoint_returns_id_and_is_idempotent(_db):
    store, path = _db
    a = store.upsert_endpoint(_ep())
    b = store.upsert_endpoint(_ep())
    assert a == b
    con = sqlite3.connect(path)
    assert con.execute("SELECT COUNT(*) FROM url_endpoints").fetchone()[0] == 1

def test_upsert_params_writes_rows(_db):
    store, path = _db
    eid = store.upsert_endpoint(_ep())
    store.upsert_params(eid, _ep().params)
    store.upsert_params(eid, _ep().params)  # idempotent
    con = sqlite3.connect(path)
    assert con.execute("SELECT COUNT(*) FROM url_params").fetchone()[0] == 1

def test_insert_fetch_appends_history(_db):
    store, path = _db
    eid = store.upsert_endpoint(_ep())
    store.insert_fetch(eid, "u1", "{}", 200, 12, True, 100, '{"a":1}', None)
    store.insert_fetch(eid, "u1", "{}", 200, 13, True, 100, '{"a":2}', None)
    con = sqlite3.connect(path)
    assert con.execute("SELECT COUNT(*) FROM url_fetches").fetchone()[0] == 2
```

- [x] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_store.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'url_explorer.store'`.

- [x] **Step 3: Write minimal implementation**

```python
# src/server/url_explorer/store.py
"""db_compat-backed storage for the URL explorer (catalog + raw history)."""
from __future__ import annotations

import json
from db_compat import execute, query_all, query_one

_DDL = [
    """CREATE TABLE IF NOT EXISTS url_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template TEXT UNIQUE NOT NULL,
        host TEXT, path_skeleton TEXT, param_keys TEXT,
        method TEXT DEFAULT 'GET', n_urls INTEGER DEFAULT 0,
        last_run_at TEXT, last_status TEXT)""",
    """CREATE TABLE IF NOT EXISTS url_params (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER NOT NULL,
        name TEXT, location TEXT, inferred_type TEXT,
        is_variable INTEGER, distinct_count INTEGER, sample_values TEXT,
        UNIQUE(endpoint_id, location, name))""",
    """CREATE TABLE IF NOT EXISTS url_fetches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER NOT NULL,
        concrete_url TEXT, params_json TEXT,
        fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
        http_status INTEGER, latency_ms INTEGER, ok INTEGER,
        response_bytes INTEGER, raw_json TEXT, error TEXT)""",
    """CREATE TABLE IF NOT EXISTS url_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER NOT NULL, run_at TEXT,
        field_path TEXT, dtype TEXT, fill_rate REAL, cardinality INTEGER,
        num_min REAL, num_max REAL, num_mean REAL,
        universe_overlap_pct REAL, changed_vs_last INTEGER)""",
    """CREATE TABLE IF NOT EXISTS url_field_correlations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER NOT NULL, run_at TEXT,
        field_path TEXT, target TEXT, n INTEGER,
        pearson REAL, spearman REAL, ic REAL)""",
    "CREATE INDEX IF NOT EXISTS ix_url_fetches_ep ON url_fetches(endpoint_id, fetched_at)",
    "CREATE INDEX IF NOT EXISTS ix_url_fields_ep ON url_fields(endpoint_id, run_at)",
]


def ensure_schema() -> None:
    for ddl in _DDL:
        execute(ddl)


def upsert_endpoint(t) -> int:
    execute(
        """INSERT INTO url_endpoints (template, host, path_skeleton, param_keys, method, n_urls)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(template) DO UPDATE SET
             host=excluded.host, path_skeleton=excluded.path_skeleton,
             param_keys=excluded.param_keys, n_urls=excluded.n_urls""",
        (t.template, t.host, t.path_skeleton, json.dumps(t.query_keys), t.method, len(t.urls)),
    )
    row = query_one("SELECT id FROM url_endpoints WHERE template = ?", (t.template,))
    return int(row["id"])


def upsert_params(endpoint_id: int, params) -> None:
    for p in params:
        execute(
            """INSERT INTO url_params (endpoint_id, name, location, inferred_type,
                 is_variable, distinct_count, sample_values)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(endpoint_id, location, name) DO UPDATE SET
                 inferred_type=excluded.inferred_type, is_variable=excluded.is_variable,
                 distinct_count=excluded.distinct_count, sample_values=excluded.sample_values""",
            (endpoint_id, p.name, p.location, p.inferred_type,
             1 if p.is_variable else 0, p.distinct_count, json.dumps(p.sample_values)),
        )


def insert_fetch(endpoint_id, concrete_url, params_json, http_status,
                 latency_ms, ok, response_bytes, raw_json, error) -> int:
    execute(
        """INSERT INTO url_fetches (endpoint_id, concrete_url, params_json, http_status,
             latency_ms, ok, response_bytes, raw_json, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (endpoint_id, concrete_url, params_json, http_status, latency_ms,
         1 if ok else 0, response_bytes, raw_json, error),
    )
    row = query_one("SELECT MAX(id) AS id FROM url_fetches WHERE endpoint_id = ?", (endpoint_id,))
    return int(row["id"])


def insert_field(endpoint_id, run_at, p) -> None:
    execute(
        """INSERT INTO url_fields (endpoint_id, run_at, field_path, dtype, fill_rate,
             cardinality, num_min, num_max, num_mean, universe_overlap_pct, changed_vs_last)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (endpoint_id, run_at, p.field_path, p.dtype, p.fill_rate, p.cardinality,
         p.num_min, p.num_max, p.num_mean, p.universe_overlap_pct,
         1 if p.changed_vs_last else 0),
    )


def insert_correlation(endpoint_id, run_at, c) -> None:
    execute(
        """INSERT INTO url_field_correlations (endpoint_id, run_at, field_path, target, n,
             pearson, spearman, ic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (endpoint_id, run_at, c.field_path, c.target, c.n, c.pearson, c.spearman, c.ic),
    )


def last_run_field_paths(endpoint_id: int) -> set[str]:
    rows = query_all(
        """SELECT DISTINCT field_path FROM url_fields
           WHERE endpoint_id = ? AND run_at = (
             SELECT MAX(run_at) FROM url_fields WHERE endpoint_id = ?)""",
        (endpoint_id, endpoint_id),
    )
    return {r["field_path"] for r in rows}
```

- [x] **Step 4: Run test to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_store.py -v`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/server/url_explorer/store.py src/server/tests/test_url_explorer_store.py
git commit -m "feat(url-explorer): Postgres/SQLite storage schema + writers"
```

---

### Task 3: `fetcher.py` — throttled, injectable fetching

**Files:**
- Create: `src/server/url_explorer/fetcher.py`
- Test: `src/server/tests/test_url_explorer_fetcher.py`

**Interfaces:**
- Consumes: `EndpointTemplate` (Task 1).
- Produces:
  - `@dataclass FetchResult(endpoint:EndpointTemplate, url:str, status:int, latency_ms:int, ok:bool, body:str|None, content_type:str, error:str|None)`
  - `fetch_all(endpoints:list[EndpointTemplate], fetch_fn=None, max_per_endpoint:int|None=None, delay:float=0.3, max_consec_fail:int=5) -> list[FetchResult]`
  - `fetch_fn` signature: `fetch_fn(url:str) -> tuple[int, str|None, str]` returning `(status, body, content_type)`; raising is treated as a failure.

- [x] **Step 1: Write the failing test**

```python
# src/server/tests/test_url_explorer_fetcher.py
import os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate, ParamSpec
from url_explorer.fetcher import fetch_all

def _ep(urls):
    return EndpointTemplate("t", "h", "/p/", ["x"], "GET",
                            [ParamSpec("x", "query", "int_id", True, len(urls), [])], urls)

def test_fetches_every_url_via_injected_fn():
    seen = []
    def fn(url):
        seen.append(url)
        return 200, '{"ok":1}', "application/json"
    results = fetch_all([_ep(["a", "b", "c"])], fetch_fn=fn, delay=0)
    assert seen == ["a", "b", "c"]
    assert all(r.ok for r in results)

def test_max_per_endpoint_caps_fetches():
    def fn(url):
        return 200, "{}", "application/json"
    results = fetch_all([_ep(["a", "b", "c", "d"])], fetch_fn=fn, max_per_endpoint=2, delay=0)
    assert len(results) == 2

def test_failure_is_isolated_and_marked():
    def fn(url):
        if url == "b":
            raise RuntimeError("boom")
        return 200, "{}", "application/json"
    results = fetch_all([_ep(["a", "b", "c"])], fetch_fn=fn, delay=0)
    by_url = {r.url: r for r in results}
    assert by_url["a"].ok and by_url["c"].ok
    assert by_url["b"].ok is False and "boom" in by_url["b"].error

def test_circuit_breaker_stops_endpoint_after_consecutive_failures():
    calls = []
    def fn(url):
        calls.append(url)
        return 405, None, "text/html"
    results = fetch_all([_ep([str(i) for i in range(20)])],
                        fetch_fn=fn, delay=0, max_consec_fail=5)
    assert len(calls) == 5  # tripped, stopped early
    assert all(not r.ok for r in results)
```

- [x] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_fetcher.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [x] **Step 3: Write minimal implementation**

```python
# src/server/url_explorer/fetcher.py
"""Politely fetch concrete URLs for each endpoint. Network is injectable for tests."""
from __future__ import annotations

import random
import time
from dataclasses import dataclass

from .normalizer import EndpointTemplate


@dataclass
class FetchResult:
    endpoint: EndpointTemplate
    url: str
    status: int
    latency_ms: int
    ok: bool
    body: str | None
    content_type: str
    error: str | None


def _default_fetch_fn(url: str):
    from curl_cffi import requests as cffi
    r = cffi.get(url, impersonate="chrome120", timeout=15)
    return r.status_code, r.text, r.headers.get("content-type", "")


def fetch_all(endpoints, fetch_fn=None, max_per_endpoint=None,
              delay: float = 0.3, max_consec_fail: int = 5):
    fetch_fn = fetch_fn or _default_fetch_fn
    results: list[FetchResult] = []
    for ep in endpoints:
        urls = ep.urls if max_per_endpoint is None else ep.urls[:max_per_endpoint]
        consec = 0
        for url in urls:
            t0 = time.time()
            try:
                status, body, ctype = fetch_fn(url)
                ok = 200 <= status < 300 and body is not None
                err = None if ok else f"http {status}"
            except Exception as e:  # noqa: BLE001
                status, body, ctype, ok, err = 0, None, "", False, str(e)
            results.append(FetchResult(ep, url, status, int((time.time() - t0) * 1000),
                                       ok, body, ctype, err))
            consec = 0 if ok else consec + 1
            if consec >= max_consec_fail:
                break  # circuit breaker: stop hammering a throttling host
            if delay:
                time.sleep(delay * (0.7 + 0.6 * random.random()))
    return results
```

- [x] **Step 4: Run test to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_fetcher.py -v`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
git add src/server/url_explorer/fetcher.py src/server/tests/test_url_explorer_fetcher.py
git commit -m "feat(url-explorer): injectable throttled fetcher with circuit breaker"
```

---

### Task 4: `profiler.py` — field inventory + universe overlap

**Files:**
- Create: `src/server/url_explorer/profiler.py`
- Test: `src/server/tests/test_url_explorer_profiler.py`

**Interfaces:**
- Consumes: `FetchResult` (Task 3).
- Produces:
  - `@dataclass FieldProfile(field_path:str, dtype:str, fill_rate:float, cardinality:int, num_min:float|None, num_max:float|None, num_mean:float|None, universe_overlap_pct:float, changed_vs_last:bool)`
  - `flatten(obj, prefix="") -> list[tuple[str, object]]` — leaf `(path, value)` pairs; list items collapse to the same path (fan-out).
  - `profile_endpoint(results:list[FetchResult], universe:set[str], prev_paths:set[str]) -> list[FieldProfile]`

- [x] **Step 1: Write the failing test**

```python
# src/server/tests/test_url_explorer_profiler.py
import json, os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate, ParamSpec
from url_explorer.fetcher import FetchResult
from url_explorer.profiler import flatten, profile_endpoint

UNIVERSE = {"INFY", "TCS", "HDFCBANK"}
EP = EndpointTemplate("t", "h", "/p/", [], "GET", [], [])

def _res(payload):
    return FetchResult(EP, "u", 200, 1, True, json.dumps(payload), "application/json", None)

def test_flatten_nested_and_lists():
    pairs = dict_paths = flatten({"a": {"b": 1}, "c": [{"sym": "INFY"}, {"sym": "TCS"}]})
    paths = [p for p, _ in pairs]
    assert "a.b" in paths
    assert paths.count("c.sym") == 2

def test_numeric_stats_and_fill_rate():
    results = [_res({"pe": 10.0}), _res({"pe": 20.0}), _res({"x": 1})]
    profs = {p.field_path: p for p in profile_endpoint(results, UNIVERSE, set())}
    pe = profs["pe"]
    assert pe.dtype == "numeric"
    assert pe.num_min == 10.0 and pe.num_max == 20.0 and pe.num_mean == 15.0
    assert round(pe.fill_rate, 2) == 0.67  # present in 2 of 3 responses

def test_universe_overlap_detects_ticker_field():
    results = [_res({"rows": [{"sym": "INFY"}, {"sym": "TCS"}, {"sym": "ZZZ"}]})]
    profs = {p.field_path: p for p in profile_endpoint(results, UNIVERSE, set())}
    assert round(profs["rows.sym"].universe_overlap_pct, 2) == 0.67

def test_changed_vs_last_flag():
    results = [_res({"newcol": 1})]
    profs = {p.field_path: p for p in profile_endpoint(results, UNIVERSE, prev_paths={"oldcol"})}
    assert profs["newcol"].changed_vs_last is True
```

- [x] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_profiler.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [x] **Step 3: Write minimal implementation**

```python
# src/server/url_explorer/profiler.py
"""Flatten JSON responses into a per-field profile with NSE-universe overlap."""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass


@dataclass
class FieldProfile:
    field_path: str
    dtype: str
    fill_rate: float
    cardinality: int
    num_min: float | None
    num_max: float | None
    num_mean: float | None
    universe_overlap_pct: float
    changed_vs_last: bool


def flatten(obj, prefix: str = "") -> list[tuple[str, object]]:
    out: list[tuple[str, object]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.extend(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(obj, list):
        for item in obj:
            out.extend(flatten(item, prefix))
    else:
        out.append((prefix, obj))
    return out


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def profile_endpoint(results, universe, prev_paths):
    universe = {u.upper() for u in universe}
    ok = [r for r in results if r.ok and r.body]
    n_resp = len(ok) or 1

    values: dict[str, list] = defaultdict(list)
    present_in: dict[str, int] = defaultdict(int)
    for r in ok:
        try:
            payload = json.loads(r.body)
        except (ValueError, TypeError):
            continue
        seen_paths = set()
        for path, val in flatten(payload):
            values[path].append(val)
            seen_paths.add(path)
        for p in seen_paths:
            present_in[p] += 1

    profiles: list[FieldProfile] = []
    for path, vals in values.items():
        nums = [v for v in vals if _is_num(v)]
        strs = [str(v).upper() for v in vals if isinstance(v, str)]
        if nums and len(nums) >= len(strs):
            dtype = "numeric"
            nmin, nmax = float(min(nums)), float(max(nums))
            nmean = float(sum(nums) / len(nums))
        else:
            dtype = "string" if strs else "other"
            nmin = nmax = nmean = None
        overlap = (sum(1 for s in strs if s in universe) / len(strs)) if strs else 0.0
        profiles.append(FieldProfile(
            field_path=path, dtype=dtype,
            fill_rate=present_in[path] / n_resp,
            cardinality=len(set(map(str, vals))),
            num_min=nmin, num_max=nmax, num_mean=nmean,
            universe_overlap_pct=overlap,
            changed_vs_last=(path not in prev_paths) if prev_paths else False,
        ))
    return profiles
```

- [x] **Step 4: Run test to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_profiler.py -v`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
git add src/server/url_explorer/profiler.py src/server/tests/test_url_explorer_profiler.py
git commit -m "feat(url-explorer): JSON field profiler with universe overlap"
```

---

### Task 5: `correlator.py` — ticker-keyed numeric fields vs returns

**Files:**
- Create: `src/server/url_explorer/correlator.py`
- Test: `src/server/tests/test_url_explorer_correlator.py`

**Interfaces:**
- Consumes: `FetchResult` (Task 3), `FieldProfile` (Task 4).
- Produces:
  - `@dataclass Correlation(field_path:str, target:str, n:int, pearson:float, spearman:float, ic:float)`
  - `build_cross_section(results:list[FetchResult], ticker_field:str, value_field:str, universe:set[str]) -> dict[str,float]` — `ticker -> latest numeric value`.
  - `correlate(cross_section:dict[str,float], returns:dict[str,float], field_path:str, target:str, min_n:int=20) -> Correlation|None`
  - `correlate_endpoint(results, profiles, returns_by_target:dict[str,dict[str,float]], universe:set[str], overlap_threshold:float=0.5, min_n:int=20) -> list[Correlation]`

- [x] **Step 1: Write the failing test**

```python
# src/server/tests/test_url_explorer_correlator.py
import json, os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate
from url_explorer.fetcher import FetchResult
from url_explorer.profiler import FieldProfile
from url_explorer.correlator import build_cross_section, correlate, correlate_endpoint

EP = EndpointTemplate("t", "h", "/p/", [], "GET", [], [])
UNIVERSE = {f"S{i}" for i in range(50)}

def _res(rows):
    return FetchResult(EP, "u", 200, 1, True, json.dumps({"rows": rows}), "application/json", None)

def test_build_cross_section_keys_by_ticker():
    r = _res([{"sym": "S1", "score": 10.0}, {"sym": "S2", "score": 20.0}])
    cs = build_cross_section([r], "rows.sym", "rows.score", UNIVERSE)
    assert cs == {"S1": 10.0, "S2": 20.0}

def test_correlate_perfect_positive():
    cs = {f"S{i}": float(i) for i in range(30)}
    rets = {f"S{i}": float(i) for i in range(30)}
    c = correlate(cs, rets, "rows.score", "fwd_ret_5d", min_n=20)
    assert c is not None and round(c.pearson, 3) == 1.0 and round(c.spearman, 3) == 1.0

def test_correlate_below_min_n_returns_none():
    cs = {f"S{i}": float(i) for i in range(5)}
    rets = {f"S{i}": float(i) for i in range(5)}
    assert correlate(cs, rets, "f", "t", min_n=20) is None

def test_correlate_endpoint_only_ticker_keyed_numeric():
    rows = [{"sym": f"S{i}", "score": float(i)} for i in range(30)]
    profs = [
        FieldProfile("rows.sym", "string", 1.0, 30, None, None, None, 1.0, False),
        FieldProfile("rows.score", "numeric", 1.0, 30, 0.0, 29.0, 14.5, 0.0, False),
    ]
    rets = {"fwd_ret_5d": {f"S{i}": float(i) for i in range(30)}}
    cors = correlate_endpoint([_res(rows)], profs, rets, UNIVERSE)
    assert len(cors) == 1 and cors[0].field_path == "rows.score"
    assert round(cors[0].pearson, 3) == 1.0
```

- [x] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_correlator.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [x] **Step 3: Write minimal implementation**

```python
# src/server/url_explorer/correlator.py
"""Correlate ticker-keyed numeric fields against return targets."""
from __future__ import annotations

import json
from dataclasses import dataclass

from scipy import stats

from .profiler import flatten


@dataclass
class Correlation:
    field_path: str
    target: str
    n: int
    pearson: float
    spearman: float
    ic: float


def _rows_of(results):
    """Yield per-response flattened (path->list) grouped by record. Returns list of dicts."""
    records = []
    for r in results:
        if not (r.ok and r.body):
            continue
        try:
            payload = json.loads(r.body)
        except (ValueError, TypeError):
            continue
        # Re-group flattened leaves into aligned records by list position.
        grouped: dict[str, list] = {}
        for path, val in flatten(payload):
            grouped.setdefault(path, []).append(val)
        width = max((len(v) for v in grouped.values()), default=0)
        for i in range(width):
            rec = {p: (v[i] if i < len(v) else None) for p, v in grouped.items()}
            records.append(rec)
    return records


def build_cross_section(results, ticker_field, value_field, universe):
    universe = {u.upper() for u in universe}
    cs: dict[str, float] = {}
    for rec in _rows_of(results):
        sym = rec.get(ticker_field)
        val = rec.get(value_field)
        if not isinstance(sym, str) or sym.upper() not in universe:
            continue
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            cs[sym.upper()] = float(val)  # last wins
    return cs


def correlate(cross_section, returns, field_path, target, min_n=20):
    common = [s for s in cross_section if s in returns]
    if len(common) < min_n:
        return None
    x = [cross_section[s] for s in common]
    y = [returns[s] for s in common]
    pear = stats.pearsonr(x, y).statistic
    spear = stats.spearmanr(x, y).statistic
    return Correlation(field_path, target, len(common),
                       float(pear), float(spear), float(spear))


def correlate_endpoint(results, profiles, returns_by_target, universe,
                       overlap_threshold: float = 0.5, min_n: int = 20):
    ticker_fields = [p.field_path for p in profiles
                     if p.dtype == "string" and p.universe_overlap_pct >= overlap_threshold]
    numeric_fields = [p.field_path for p in profiles if p.dtype == "numeric"]
    if not ticker_fields or not numeric_fields:
        return []
    tfield = ticker_fields[0]
    out: list[Correlation] = []
    for vfield in numeric_fields:
        cs = build_cross_section(results, tfield, vfield, universe)
        for target, rets in returns_by_target.items():
            c = correlate(cs, rets, vfield, target, min_n=min_n)
            if c is not None:
                out.append(c)
    return out
```

- [x] **Step 4: Run test to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_correlator.py -v`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
git add src/server/url_explorer/correlator.py src/server/tests/test_url_explorer_correlator.py
git commit -m "feat(url-explorer): cross-sectional correlation vs returns"
```

---

### Task 6: `returns.py` + `report.py` — return targets and markdown report

**Files:**
- Create: `src/server/url_explorer/returns.py`
- Create: `src/server/url_explorer/report.py`
- Test: `src/server/tests/test_url_explorer_report.py`

**Interfaces:**
- Consumes: `EndpointTemplate` (Task 1), `FieldProfile` (Task 4), `Correlation` (Task 5).
- Produces:
  - `returns.load_return_targets(windows=(5,20)) -> dict[str, dict[str,float]]` — keys like `trailing_ret_5d`, `fwd_ret_5d`; each maps `ticker -> return`. Reads `stock_ohlcv` via `db_compat`; empty dict if table absent.
  - `report.render_report(items:list[dict]) -> str` where each item = `{"endpoint":EndpointTemplate, "n_ok":int, "n_total":int, "profiles":list[FieldProfile], "correlations":list[Correlation]}`.

- [x] **Step 1: Write the failing test**

```python
# src/server/tests/test_url_explorer_report.py
import os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate
from url_explorer.profiler import FieldProfile
from url_explorer.correlator import Correlation
from url_explorer.report import render_report

def test_report_lists_endpoint_and_correlations():
    ep = EndpointTemplate("https://h/p/?x", "h", "/p/", ["x"], "GET", [], ["u1", "u2"])
    items = [{
        "endpoint": ep, "n_ok": 2, "n_total": 2,
        "profiles": [FieldProfile("rows.score", "numeric", 1.0, 2, 0.0, 1.0, 0.5, 0.0, False)],
        "correlations": [Correlation("rows.score", "fwd_ret_5d", 30, 0.42, 0.40, 0.40)],
    }]
    md = render_report(items)
    assert "https://h/p/?x" in md
    assert "rows.score" in md
    assert "0.42" in md
    assert "2/2" in md  # fetch success

def test_report_handles_empty():
    assert "No endpoints" in render_report([])
```

- [x] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_report.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [x] **Step 3: Write minimal implementation**

```python
# src/server/url_explorer/returns.py
"""Return targets keyed by ticker, computed from stock_ohlcv. Empty if unavailable."""
from __future__ import annotations

from db_compat import query_all


def load_return_targets(windows=(5, 20)) -> dict[str, dict[str, float]]:
    targets: dict[str, dict[str, float]] = {}
    try:
        rows = query_all(
            """SELECT symbol, date, close FROM stock_ohlcv
               WHERE close IS NOT NULL ORDER BY symbol, date"""
        )
    except Exception:
        return targets
    series: dict[str, list[tuple[str, float]]] = {}
    for r in rows:
        series.setdefault(r["symbol"], []).append((r["date"], float(r["close"])))
    for w in windows:
        trail: dict[str, float] = {}
        for sym, pts in series.items():
            closes = [c for _, c in pts]
            if len(closes) > w and closes[-1 - w] > 0:
                trail[sym] = closes[-1] / closes[-1 - w] - 1.0
        targets[f"trailing_ret_{w}d"] = trail
    # NOTE: forward-return targets (fwd_ret_*) are intentionally NOT emitted in v1.
    # A field's value is captured at fetch time; the genuine forward return is only
    # known on a later run. Computing it now would store a misleading zero column.
    # Trailing returns are descriptive of the current cross-section and are enough
    # for the first-pass usefulness signal; true forward IC accrues once run history
    # exists (a later enhancement that diffs stored snapshots).
    return targets
```

```python
# src/server/url_explorer/report.py
"""Render the usefulness report as markdown."""
from __future__ import annotations

from datetime import date


def render_report(items) -> str:
    if not items:
        return "# URL Explorer Report\n\nNo endpoints processed.\n"

    lines = [f"# URL Explorer Report — {date.today().isoformat()}", ""]
    lines += ["## Endpoints", "", "| Endpoint | URLs | Fetch OK | Fields | Ticker-keyed |",
              "|---|---|---|---|---|"]
    for it in items:
        ep = it["endpoint"]
        ticker_keyed = any(p.dtype == "string" and p.universe_overlap_pct >= 0.5
                           for p in it["profiles"])
        lines.append(f"| `{ep.template}` | {len(ep.urls)} | {it['n_ok']}/{it['n_total']} "
                     f"| {len(it['profiles'])} | {'yes' if ticker_keyed else 'no'} |")

    for it in items:
        ep = it["endpoint"]
        lines += ["", f"### `{ep.template}`", ""]
        top = sorted(it["profiles"], key=lambda p: (-p.fill_rate, -p.universe_overlap_pct))[:15]
        lines += ["**Fields (top by coverage):**", "",
                  "| field | dtype | fill | cardinality | universe% |", "|---|---|---|---|---|"]
        for p in top:
            lines.append(f"| {p.field_path} | {p.dtype} | {p.fill_rate:.2f} "
                         f"| {p.cardinality} | {p.universe_overlap_pct:.2f} |")
        if it["correlations"]:
            lines += ["", "**Correlations (|value| ranked):**", "",
                      "| field | target | n | pearson | spearman |", "|---|---|---|---|---|"]
            for c in sorted(it["correlations"], key=lambda c: -abs(c.pearson))[:15]:
                lines.append(f"| {c.field_path} | {c.target} | {c.n} "
                             f"| {c.pearson:.2f} | {c.spearman:.2f} |")
    return "\n".join(lines) + "\n"
```

- [x] **Step 4: Run test to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_report.py -v`
Expected: PASS (2 tests).

- [x] **Step 5: Commit**

```bash
git add src/server/url_explorer/returns.py src/server/url_explorer/report.py src/server/tests/test_url_explorer_report.py
git commit -m "feat(url-explorer): return targets + markdown usefulness report"
```

---

### Task 7: `explore.py` — CLI orchestration

**Files:**
- Create: `src/server/url_explorer/explore.py`
- Test: `src/server/tests/test_url_explorer_explore.py`

**Interfaces:**
- Consumes: every module above.
- Produces:
  - `load_universe() -> set[str]` — NSE symbols from `nse_stocks` via `db_compat`; falls back to empty set.
  - `run(urls:list[str], universe:set[str], fetch_fn=None, returns_by_target=None, max_per_endpoint=None, write=True) -> dict` — runs the full pipeline, returns `{"report": str, "endpoints": int, "fetches": int}`. `write=False` skips DB writes (for tests).
  - `main(argv=None) -> int` — argparse CLI (`--urls`, `--normalize-only`, `--no-correlate`, `--max-per-endpoint`, `--out`).

- [x] **Step 1: Write the failing test**

```python
# src/server/tests/test_url_explorer_explore.py
import os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.explore import run

UNIVERSE = {f"S{i}" for i in range(40)}

def test_run_end_to_end_without_db_or_network():
    urls = [f"https://api.test/screener/?pk={i}" for i in range(3)]
    import json
    def fetch_fn(url):
        rows = [{"sym": f"S{i}", "score": float(i)} for i in range(30)]
        return 200, json.dumps({"rows": rows}), "application/json"
    rets = {"fwd_ret_5d": {f"S{i}": float(i) for i in range(30)}}
    out = run(urls, UNIVERSE, fetch_fn=fetch_fn, returns_by_target=rets,
              max_per_endpoint=1, write=False)
    assert out["endpoints"] == 1
    assert out["fetches"] == 1
    assert "rows.score" in out["report"]
    assert "fwd_ret_5d" in out["report"]
```

- [x] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_explore.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [x] **Step 3: Write minimal implementation**

```python
# src/server/url_explorer/explore.py
"""CLI: urls.txt -> normalize -> fetch -> store -> profile -> correlate -> report."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import store
from .correlator import correlate_endpoint
from .fetcher import fetch_all
from .normalizer import normalize
from .profiler import profile_endpoint
from .report import render_report
from .returns import load_return_targets


def load_universe() -> set[str]:
    try:
        from db_compat import query_all
        return {r["symbol"].upper() for r in query_all("SELECT symbol FROM nse_stocks")}
    except Exception:
        return set()


def run(urls, universe, fetch_fn=None, returns_by_target=None,
        max_per_endpoint=None, write=True, correlate=True):
    endpoints = normalize(urls, universe)
    if write:
        store.ensure_schema()
    results = fetch_all(endpoints, fetch_fn=fetch_fn, max_per_endpoint=max_per_endpoint)
    by_ep = {id(ep): [] for ep in endpoints}
    for r in results:
        by_ep[id(r.endpoint)].append(r)

    run_at = datetime.now(timezone.utc).isoformat()
    if correlate and returns_by_target is None:
        returns_by_target = load_return_targets() if write else {}

    items = []
    n_fetch = 0
    for ep in endpoints:
        eid = store.upsert_endpoint(ep) if write else 0
        if write:
            store.upsert_params(eid, ep.params)
        ep_results = by_ep[id(ep)]
        n_fetch += len(ep_results)
        if write:
            for r in ep_results:
                store.insert_fetch(eid, r.url, "{}", r.status, r.latency_ms,
                                   r.ok, len(r.body or ""), r.body, r.error)
        prev = store.last_run_field_paths(eid) if write else set()
        profiles = profile_endpoint(ep_results, universe, prev)
        if write:
            for p in profiles:
                store.insert_field(eid, run_at, p)
        cors = []
        if correlate and returns_by_target:
            cors = correlate_endpoint(ep_results, profiles, returns_by_target, universe)
            if write:
                for c in cors:
                    store.insert_correlation(eid, run_at, c)
        n_ok = sum(1 for r in ep_results if r.ok)
        items.append({"endpoint": ep, "n_ok": n_ok, "n_total": len(ep_results),
                      "profiles": profiles, "correlations": cors})

    return {"report": render_report(items), "endpoints": len(endpoints), "fetches": n_fetch}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Explore + catalog third-party data URLs.")
    ap.add_argument("--urls", default=str(Path(__file__).resolve().parents[3] / "urls.txt"))
    ap.add_argument("--normalize-only", action="store_true")
    ap.add_argument("--no-correlate", action="store_true")
    ap.add_argument("--max-per-endpoint", type=int, default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    urls = [ln.strip() for ln in Path(args.urls).read_text().splitlines() if ln.strip()]
    universe = load_universe()

    if args.normalize_only:
        eps = normalize(urls, universe)
        print(json.dumps([{"template": e.template, "n_urls": len(e.urls),
                           "params": [(p.name, p.inferred_type, p.is_variable) for p in e.params]}
                          for e in eps], indent=2))
        return 0

    out = run(urls, universe, max_per_endpoint=args.max_per_endpoint,
              write=True, correlate=not args.no_correlate)
    out_path = Path(args.out) if args.out else (
        Path(__file__).resolve().parents[3] / "docs" / "url_explorer"
        / f"report-{datetime.now().date().isoformat()}.md")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(out["report"], encoding="utf-8")
    print(f"[URL-EXPLORER] {out['endpoints']} endpoints, {out['fetches']} fetches. "
          f"Report -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [x] **Step 4: Run test to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_explore.py -v`
Expected: PASS (1 test).

- [x] **Step 5: Run the whole suite + a tiny live smoke test**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_url_explorer_*.py -v`
Expected: all PASS (26 tests).

Then a 3-URL live smoke (writes to the real DB):
```bash
cd src/server && printf '%s\n' \
  'https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/TCS' \
  'https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/HDF01' \
  'https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/RI' > /tmp/smoke_urls.txt
../../backend-python/venv/Scripts/python.exe -m url_explorer.explore --urls /tmp/smoke_urls.txt --max-per-endpoint 3
```
Expected: prints `1 endpoints, 3 fetches` and writes a report under `docs/url_explorer/`.

- [x] **Step 6: Commit**

```bash
git add src/server/url_explorer/explore.py src/server/tests/test_url_explorer_explore.py
git commit -m "feat(url-explorer): CLI orchestration end-to-end"
```

---

## Self-Review

**Spec coverage:**
- Edit `urls.txt` → one command → catalog + raw + report → Task 7 CLI (`--urls`, default `urls.txt`). ✓
- Endpoint templates / "same if only a param differs" → Task 1 `normalize` (structural key + variable detection). ✓
- Hybrid (structural + entity typing) → Task 1 `classify_value` + variability. ✓
- Fetch each unique URL once, throttled, rate-limit aware → Task 3 `fetch_all` (delay/backoff/circuit breaker, `--max-per-endpoint` sampling). ✓
- Identify parameters + store → Tasks 1 + 2 (`url_params`). ✓
- Store raw history → Task 2 `url_fetches`. ✓
- Field profiling + universe overlap + change-vs-last → Task 4. ✓
- Target correlation → Tasks 5 + 6 (`correlate_endpoint`, `load_return_targets`). ✓
- Catalog + raw history in Postgres via db_compat → Task 2. ✓
- Usefulness report → Task 6 `render_report`, written in Task 7. ✓
- Re-runnable / "verified regularly" via manual re-run appending history → Tasks 2/4/7 (append-only fetches/fields/correlations, `last_run_field_paths`). ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. ✓

**Type consistency:** Shared dataclasses (`ParamSpec`, `EndpointTemplate`, `FetchResult`, `FieldProfile`, `Correlation`) are defined once and referenced by the same attribute names across tasks; `store` reads `FieldProfile`/`Correlation` attributes that match Tasks 4/5; `run` wires `fetch_all`→`profile_endpoint`→`correlate_endpoint`→`render_report` with matching signatures. ✓

**Known caveat carried from spec:** v1 `returns.load_return_targets` emits only `trailing_ret_*` targets (descriptive of the current cross-section). True forward-return IC requires diffing stored snapshots across runs and is a documented later enhancement — v1 deliberately does not store a misleading zero-valued `fwd_ret_*` column.
