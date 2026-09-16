import importlib, json, os, sys, uuid
import pytest
from urllib.parse import urlsplit
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate, ParamSpec

@pytest.fixture(autouse=True)
def _db():
    import psycopg2
    from pg_test_support import (
        PG_TEST_SCHEMA_LOCK_NS, _pg_dsn, _sa_url, pg_available, drop_throwaway_schema,
    )
    if not pg_available():
        pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")
    saved = {k: os.environ.get(k) for k in ("POSTGRES_URL", "USE_POSTGRES", "DATABASE_URL")}
    schema = f"t_{uuid.uuid4().hex[:12]}"
    admin = psycopg2.connect(**_pg_dsn())
    admin.autocommit = True
    admin_cur = admin.cursor()
    admin_cur.execute(f'CREATE SCHEMA "{schema}"')
    admin_cur.execute("SELECT pg_advisory_lock(%s, hashtext(%s))", (PG_TEST_SCHEMA_LOCK_NS, schema))
    os.environ["USE_POSTGRES"] = "true"
    os.environ["POSTGRES_URL"] = _sa_url(schema)
    os.environ.pop("DATABASE_URL", None)
    import db_compat; importlib.reload(db_compat)
    import url_explorer.store as store; importlib.reload(store)
    import url_explorer.ingest as ingest; importlib.reload(ingest)
    store.ensure_schema()
    yield store, ingest
    db_compat.dispose_engines()
    try:
        drop_throwaway_schema(admin, schema)
    finally:
        admin.close()
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    importlib.reload(db_compat)

def _rec(url, source="urls.normalized.txt", **kw):
    from url_explorer.ingest import SourceRecord
    return SourceRecord(url=url, source=source, **kw)

def test_dedup_and_source_merge(_db):
    store, ingest = _db
    recs = [
        _rec("https://h/a?x=1", source="updated_urls.json", description="d1"),
        _rec("https://h/a?x=2", source="updated_urls_verified.json"),
    ]
    catalog = ingest.build_catalog(recs, [], set())
    assert len(catalog) == 1
    entry = next(iter(catalog.values()))
    assert entry.meta["sources"] == {"updated_urls.json", "updated_urls_verified.json"}
    assert len(entry.endpoint.urls) == 2

    assert ingest.apply_catalog(catalog) == 1
    import db_compat
    assert db_compat.query_scalar("SELECT COUNT(*) FROM url_endpoints") == 1
    row = db_compat.query_one("SELECT sources_json, description FROM url_endpoints")
    assert set(json.loads(row["sources_json"])) == {"updated_urls.json", "updated_urls_verified.json"}
    assert row["description"] == "d1"

def test_registry_enrichment_and_feature_targets(_db):
    store, ingest = _db
    recs = [_rec("https://h/share?companyid=9195", source="detailed_uls.json",
                 provider="ET", category="Ownership")]
    reg = [{"endpoint_name": "et_share", "provider": "Indiatimes",
            "category": "Ownership & Institutional Holdings", "http_method": "GET",
            "url_template": "https://h/share?companyid={companyid}",
            "feature_targets_json": '["mf_pct"]'}]
    catalog = ingest.build_catalog(recs, [], set(), reg)
    entry = next(iter(catalog.values()))
    assert entry.meta["provider"] == "ET"
    assert "mf_pct" in entry.meta["feature_targets"]
    assert "et_share" in entry.meta["refs"]
    assert "ai_endpoint_registry" in entry.meta["sources"]

def test_registry_only_template_synthesizes_endpoint(_db):
    store, ingest = _db
    reg = [{"endpoint_name": "mc_quote", "provider": "MoneyControl", "http_method": "GET",
            "url_template": "https://api.mc/lq?symbol={symbol}",
            "feature_targets_json": '["last_price"]'}]
    catalog = ingest.build_catalog([], [], set(), reg)
    entry = next(iter(catalog.values()))
    assert entry.endpoint.host == "api.mc"
    assert entry.meta["feature_targets"] == {"last_price"}
    assert entry.meta["provider"] == "MoneyControl"

def test_post_group_ingested(_db):
    store, ingest = _db
    group = ingest.PostRequestGroup(url="https://p/scr", source="et_screeners.json", requests=[
        {"payload": {"screenerId": "73", "pagesize": 20}, "label": "Cash Cows"},
        {"payload": {"screenerId": "99", "pagesize": 20}, "label": None},
        {"payload": {"screenerId": "12", "pagesize": 50}, "label": None},
    ])
    catalog = ingest.build_catalog([], [group], set())
    entry = next(iter(catalog.values()))
    assert entry.endpoint.method == "POST"

    assert ingest.apply_catalog(catalog) == 1
    import db_compat
    row = db_compat.query_one("SELECT method, n_urls FROM url_endpoints")
    assert row["method"] == "POST" and row["n_urls"] == 3
    p = db_compat.query_one(
        "SELECT location, distinct_count FROM url_params WHERE name = 'screenerId'")
    assert p["location"] == "body" and p["distinct_count"] == 3

def test_find_alternates_ranks_and_excludes(_db):
    store, ingest = _db
    catalog = ingest.build_catalog([], [], set(), [
        {"endpoint_name": "pcr_a", "url_template": "https://a/pcr?symbol={symbol}",
         "feature_targets_json": '["pcr"]'},
        {"endpoint_name": "pcr_b", "url_template": "https://b/pcr?symbol={symbol}",
         "feature_targets_json": '["pcr", "iv"]'},
    ])
    ingest.apply_catalog(catalog)
    rows = ingest.find_alternates(["pcr", "iv"])
    assert rows[0]["template"].startswith("https://b/")
    assert len(rows) == 2
    rows = ingest.find_alternates(["pcr"], exclude="https://a/")
    assert len(rows) == 1 and rows[0]["template"].startswith("https://b/")

def test_dry_run_writes_nothing(_db):
    store, ingest = _db
    report, stats = ingest.consolidate([_rec("https://h/a?x=1")], [], set(), [], apply=False)
    assert stats["entries"] == 1 and stats["written"] == 0
    import db_compat
    assert db_compat.query_scalar("SELECT COUNT(*) FROM url_endpoints") == 0
    assert "https://h/a" in report

def test_record_health(_db):
    store, ingest = _db
    ep = EndpointTemplate(template="https://h/p/?x", host="h", path_skeleton="/p/",
                          query_keys=["x"], method="GET", params=[], urls=["u1"])
    eid = store.upsert_endpoint(ep)
    store.record_health(eid, False, "http 404")
    import db_compat
    row = db_compat.query_one("SELECT last_status, last_run_at FROM url_endpoints")
    assert row["last_status"].startswith("fail")
    assert row["last_run_at"]

def test_select_targets_exclusions(_db):
    store, _ = _db
    import url_explorer.fetch_pass as fp
    def _ep(tpl, host):
        return EndpointTemplate(template=tpl, host=host, path_skeleton="/s/",
                                query_keys=["x"], method="GET", params=[], urls=[tpl])
    clean = store.upsert_endpoint(_ep("https://clean/s/?x", "clean"))
    fetched = store.upsert_endpoint(_ep("https://fetched/s/?x", "fetched"))
    dead = store.upsert_endpoint(_ep("https://dead/s/?x", "dead"))
    store.insert_fetch(fetched, "u", "{}", 200, 5, True, 10, "{}", None)
    store.update_endpoint_meta(dead, provider=None, category=None, description=None,
                               feature_targets=[], sources=[], refs=[],
                               verified={"n": 2, "ok": 0, "non200": {"403": 2}, "errors": 0})
    targets, excluded = fp.select_targets()
    templates = [t for _, t, _ in targets]
    assert "https://clean/s/?x" in templates
    assert "https://fetched/s/?x" not in templates
    assert "https://dead/s/?x" not in templates
    assert excluded == 1

def test_load_ue_successes_paroles_proven_urls(_db):
    from url_explorer.ingest import load_ue_successes
    recs = load_ue_successes()
    assert len(recs) == 429  # 528 + 407 raw rows, deduped by URL
    assert all(r.source.startswith("urls-explorer/") for r in recs)
    assert any("marketservices.indiatimes.com" in r.url for r in recs)

def test_normalize_url_repairs_browser_copied_forms(_db):
    import url_explorer.fetch_pass as fp
    assert fp.normalize_url("https:///api.moneycontrol.com/mcapi/v1/x/?scId") == \
        "https://api.moneycontrol.com/mcapi/v1/x/?scId"
    assert fp.normalize_url("https:////host//a//b/?x=1") == "https://host/a/b/?x=1"
    assert fp.normalize_url("  https://ok.example/p/?a  ") == "https://ok.example/p/?a"

def test_make_fetch_fn_403_referer_fallback(_db, monkeypatch):
    import url_explorer.fetch_pass as fp
    calls = []
    class FakeResp:
        def __init__(self, status):
            self.status_code = status
            self.text = "{}"
            self.headers = {"content-type": "application/json"}
    class FakeSession:
        def get(self, url, headers=None, timeout=None, allow_redirects=None):
            calls.append(headers.get("Referer"))
            return FakeResp(200 if len(calls) > 1 else 403)
    monkeypatch.setattr(fp, "_CFFI_SESSION", FakeSession())
    fetch = fp.make_fetch_fn(retries=1)
    status, body, _ = fetch({"url": "https://ticker.finology.in/peers.ashx/?fincode"})
    assert status == 200
    assert calls[0].endswith("finology.in/")       # own-domain referer first
    assert any("ticker.finology.in" in c for c in calls[1:])  # then the ladder

def test_make_fetch_fn_retries_transport_then_succeeds(_db):
    import url_explorer.fetch_pass as fp
    calls = []
    def flaky_once(url):
        calls.append(url)
        if len(calls) == 1:
            return 503, "", "text/html"
        return 200, "{\"a\": 1}", "application/json"
    fetch = fp.make_fetch_fn(retries=2, once=flaky_once)
    status, body, _ = fetch({"url": "https://x/y"})
    assert status == 200 and len(calls) == 2

def test_make_fetch_fn_does_not_retry_definitive_404(_db):
    import url_explorer.fetch_pass as fp
    calls = []
    def once(url):
        calls.append(url)
        return 404, "", "text/html"
    fetch = fp.make_fetch_fn(retries=2, once=once)
    status, _, _ = fetch({"url": "https://x/y"})
    assert status == 404 and len(calls) == 1

def test_unwrap_payload(_db):
    import url_explorer.fetch_pass as fp
    assert fp.unwrap_payload("callback({\"a\": 1});") == "{\"a\": 1}"
    assert fp.unwrap_payload("﻿{\"a\": 1}") == "{\"a\": 1}"
    html = "<html><script id=\"__NEXT_DATA__\" type=\"application/json\">{\"b\": 2}</script></html>"
    assert fp.unwrap_payload(html) == "{\"b\": 2}"
    assert fp.unwrap_payload("{\"c\": 3}") == "{\"c\": 3}"

def test_execute_pass_caps_failing_host(_db):
    store, _ = _db
    import url_explorer.fetch_pass as fp
    plan = [{"endpoint_id": x, "template": f"https://dead/s{x}/?x",
             "attempts": [{"url": f"https://dead/s{x}/?x"}]} for x in range(3)]
    def fail_fetch(attempt):
        return 404, "", "text/html"
    summary = fp.execute_pass(plan, fail_fetch, {}, set(), delay_base=0,
                              host_fail_cap=2, progress_every=1000)
    assert summary["attempts_fail"] == 2
    assert summary["skipped_host_cap"] == 1
    assert summary["capped_hosts"] == ["dead"]

def test_execute_pass_populates_fetch_fields_correlations(_db):
    store, _ = _db
    import url_explorer.fetch_pass as fp
    universe = {f"S{i}" for i in range(40)}
    eids = []
    for tpl in ("https://a-scan/scan/?sym&val", "https://b-scan/scan/?sym&val"):
        ep = EndpointTemplate(template=tpl, host=urlsplit(tpl).netloc,
                              path_skeleton="/scan/", query_keys=["sym", "val"],
                              method="GET", params=[], urls=[tpl])
        eids.append(store.upsert_endpoint(ep))

    def fake_fetch(attempt):
        url = attempt["url"]
        if url.startswith("https://b-scan/"):
            return 503, "", "text/html"
        body = json.dumps({"rows": [{"sym": f"S{i}", "val": float(i) * 1.5}
                                    for i in range(25)]})
        return 200, body, "application/json"

    returns = {"trailing_ret_5d": {f"S{i}": i / 500 for i in range(25)}}
    plan = [{"endpoint_id": eid, "template": tpl,
             "attempts": [{"url": tpl}]}
            for eid, tpl in zip(eids, ("https://a-scan/scan/?sym&val",
                                       "https://b-scan/scan/?sym&val"))]
    summary = fp.execute_pass(plan, fake_fetch, returns, universe, delay_base=0)
    assert summary["attempts_ok"] == 1 and summary["attempts_fail"] == 1
    assert summary["endpoints_ok"] == 1 and summary["endpoints_fail"] == 1
    assert summary["fields"] > 0 and summary["correlations"] >= 1

    import db_compat
    assert db_compat.query_scalar("SELECT COUNT(*) FROM url_fetches") == 2
    corr = db_compat.query_all(
        "SELECT field_path, target, n FROM url_field_correlations")
    assert any(c["n"] == 25 for c in corr)
    ok_row = db_compat.query_one(
        "SELECT last_status FROM url_endpoints WHERE template LIKE 'https://a-scan/%'")
    assert ok_row["last_status"] == "ok"
    fail_row = db_compat.query_one(
        "SELECT last_status FROM url_endpoints WHERE template LIKE 'https://b-scan/%'")
    assert fail_row["last_status"].startswith("fail")

def test_split_url_line_repairs_and_splits():
    from url_explorer.ingest import split_url_line
    urls, repaired = split_url_line("https://a/b?x=1 https://c/d noturl")
    assert urls == ["https://a/b?x=1", "https://c/d"]
    assert repaired == 0

def test_split_url_line_repairs_malformed_scheme():
    from url_explorer.ingest import split_url_line
    urls, repaired = split_url_line(
        "https:////priceapi.moneycontrol.com//pricefeed//techindicator//W//BE03")
    assert urls == ["https://priceapi.moneycontrol.com/pricefeed/techindicator/W/BE03"]
    assert repaired == 1

def test_verified_evidence_attaches(_db):
    store, ingest = _db
    catalog = ingest.build_catalog(
        [_rec("https://h/v?x=1")], [], set(),
        verified={"https://h/v?x=1": 403})
    entry = next(iter(catalog.values()))
    assert entry.meta["verified"]["non200"] == {"403": 1}
    assert ingest.apply_catalog(catalog) == 1
    import db_compat
    row = db_compat.query_one("SELECT verified_json FROM url_endpoints")
    assert json.loads(row["verified_json"])["non200"] == {"403": 1}
