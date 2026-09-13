import importlib, json, os, sys, uuid
import pytest
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
