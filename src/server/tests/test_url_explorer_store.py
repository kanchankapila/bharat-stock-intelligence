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
