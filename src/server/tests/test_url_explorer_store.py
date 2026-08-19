import importlib, os, sys, uuid
import pytest
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate, ParamSpec

@pytest.fixture(autouse=True)
def _db():
    import psycopg2
    from pg_test_support import _pg_dsn, _sa_url, pg_available
    if not pg_available():
        pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")
    saved = {k: os.environ.get(k) for k in ("POSTGRES_URL", "USE_POSTGRES", "DATABASE_URL")}
    schema = f"t_{uuid.uuid4().hex[:12]}"
    admin = psycopg2.connect(**_pg_dsn())
    admin.autocommit = True
    admin.cursor().execute(f'CREATE SCHEMA "{schema}"')
    os.environ["USE_POSTGRES"] = "true"
    os.environ["POSTGRES_URL"] = _sa_url(schema)
    os.environ.pop("DATABASE_URL", None)
    import db_compat; importlib.reload(db_compat)
    import url_explorer.store as store; importlib.reload(store)
    store.ensure_schema()
    yield store
    try:
        admin.cursor().execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
    finally:
        admin.close()
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    importlib.reload(db_compat)

def _ep():
    return EndpointTemplate(
        template="https://h/p/?x", host="h", path_skeleton="/p/",
        query_keys=["x"], method="GET",
        params=[ParamSpec("x", "query", "int_id", True, 3, ["1", "2"])], urls=["u1", "u2"])

def test_upsert_endpoint_returns_id_and_is_idempotent(_db):
    store = _db
    a = store.upsert_endpoint(_ep())
    b = store.upsert_endpoint(_ep())
    assert a == b
    import db_compat
    assert db_compat.query_scalar("SELECT COUNT(*) FROM url_endpoints") == 1

def test_upsert_params_writes_rows(_db):
    store = _db
    eid = store.upsert_endpoint(_ep())
    store.upsert_params(eid, _ep().params)
    store.upsert_params(eid, _ep().params)  # idempotent
    import db_compat
    assert db_compat.query_scalar("SELECT COUNT(*) FROM url_params") == 1

def test_insert_fetch_appends_history(_db):
    store = _db
    eid = store.upsert_endpoint(_ep())
    store.insert_fetch(eid, "u1", "{}", 200, 12, True, 100, '{"a":1}', None)
    store.insert_fetch(eid, "u1", "{}", 200, 13, True, 100, '{"a":2}', None)
    import db_compat
    assert db_compat.query_scalar("SELECT COUNT(*) FROM url_fetches") == 2
