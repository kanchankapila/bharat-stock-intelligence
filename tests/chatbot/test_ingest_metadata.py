import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "server", "chatbot"))
import ingest


class _FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _FakeConnection:
    def execute(self, sql, params=()):
        return _FakeResult([
            ("INFY", "Infosys Ltd", "IT", "Software", "Vendor description"),
        ])

    def close(self):
        pass


class _FakeCollection:
    name = "stock_profiles"

    def __init__(self):
        self.documents = []
        self.ids = []
        self.metadatas = []

    def upsert(self, documents, ids, metadatas):
        self.documents = documents
        self.ids = ids
        self.metadatas = metadatas

    def get(self, include=None):
        return {"ids": self.ids}


class _FakeClient:
    def __init__(self, collection):
        self.collection = collection

    def get_or_create_collection(self, name, embedding_function=None):
        assert name == "stock_profiles"
        return self.collection


def test_stock_profiles_exclude_generated_ai_text_and_carry_entity_metadata():
    collection = _FakeCollection()
    with patch("ingest.connect", return_value=_FakeConnection()), patch("ingest.get_embedding_fn", return_value=object()):
        count = ingest.ingest_stock_profiles(_FakeClient(collection))
    assert count == 1
    assert "AI Analysis" not in collection.documents[0]
    assert collection.metadatas[0]["entity_type"] == "instrument"
    assert collection.metadatas[0]["content_kind"] == "vendor_profile"
    assert collection.metadatas[0]["source_ref"] == "nse_stocks:INFY"
