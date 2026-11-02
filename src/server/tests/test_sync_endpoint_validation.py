import sqlite3
import sys
from pathlib import Path
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
import sync_endpoint_validation as subject  # noqa: E402


def test_load_checkpoint_keys_results_by_uid(tmp_path):
    db = tmp_path / "checkpoint.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE validation_results (uid TEXT, status_code INTEGER)")
        conn.execute("INSERT INTO validation_results VALUES ('GET::one', 200)")

    assert subject._load_checkpoint(db)["GET::one"]["status_code"] == 200


def test_probe_missing_records_non_200_as_current_evidence():
    response = Mock(status_code=405, content=b"blocked", headers={"content-type": "text/plain"})
    with patch.object(subject.requests, "request", return_value=response):
        result = subject._probe_missing(("GET::one", "GET", "https://example.test", {}, None))

    assert result["status_code"] == 405
    assert result["is_working"] == 0
    assert result["validated_at"]
