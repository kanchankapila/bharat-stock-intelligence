"""The chatbot's RAG embeddings must not pull torch into the long-running chatbot service.

2026-11-06: the chatbot held 2,860MB private with torch + cu128 DLLs loaded, because both embedding
sites used chromadb's SentenceTransformerEmbeddingFunction (sentence-transformers -> torch) and the
nightly chatbot-reingest job embeds inside the service. chromadb ships the same all-MiniLM-L6-v2
model as ONNX; on 5 probe texts its vectors matched sentence-transformers at cosine 1.000000 with
identical neighbour order, and the top-5 results on all three live collections were identical.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

CHATBOT_DIR = Path(__file__).resolve().parents[2] / "src" / "server" / "chatbot"
sys.path.insert(0, str(CHATBOT_DIR))

ONNX_NAME = "onnx_mini_lm_l6_v2"


def test_both_embedding_sites_use_the_torch_free_model():
    code = (
        "import sys\n"
        "import ingest\n"
        "from tools import screener_tool\n"
        "names = {ingest.get_embedding_fn().name(), screener_tool.get_embedding_fn().name()}\n"
        "print('NAMES=' + ','.join(sorted(names)))\n"
        "print('TORCH=' + str('torch' in sys.modules))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=CHATBOT_DIR, capture_output=True,
                         text=True, timeout=300, env={**os.environ, "CUDA_VISIBLE_DEVICES": "-1"})
    assert out.returncode == 0, out.stderr[-3000:]
    assert f"NAMES={ONNX_NAME}" in out.stdout
    assert "TORCH=False" in out.stdout


def _seed(client, name, ef=None):
    col = client.create_collection(
        name, embedding_function=ef,
        configuration={"hnsw": {"space": "cosine", "ef_construction": 100, "ef_search": 100,
                                "max_neighbors": 16}})
    col.add(ids=["a", "b", "c"], embeddings=[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.7, 0.7, 0.0]],
            documents=["doc a", "doc b", "doc c"], metadatas=[{"k": 1}, {"k": 2}, {"k": 3}])
    return col


def test_migration_rebuilds_collection_with_vectors_preserved(tmp_path):
    chromadb = pytest.importorskip("chromadb")
    import ingest

    client = chromadb.PersistentClient(path=str(tmp_path))
    _seed(client, "stock_profiles")  # created with no recorded ONNX function: must be migrated

    assert ingest.migrate_collection_embedding_fn(client, "stock_profiles") == 3

    col = client.get_or_create_collection("stock_profiles", embedding_function=ingest.get_embedding_fn())
    assert col.configuration_json["embedding_function"]["name"] == ONNX_NAME
    assert col.configuration_json["hnsw"]["space"] == "cosine"
    got = col.get(include=["embeddings", "documents", "metadatas"])
    by_id = {i: (list(e), d, m) for i, e, d, m in zip(got["ids"], got["embeddings"], got["documents"], got["metadatas"])}
    assert by_id["c"][0] == pytest.approx([0.7, 0.7, 0.0])
    assert by_id["b"][1:] == ("doc b", {"k": 2})
    hit = col.query(query_embeddings=[[0.0, 1.0, 0.0]], n_results=1)["ids"][0]
    assert hit == ["b"]
    assert [c.name for c in client.list_collections()] == ["stock_profiles"]


def test_migration_is_a_no_op_when_already_onnx(tmp_path):
    chromadb = pytest.importorskip("chromadb")
    import ingest

    client = chromadb.PersistentClient(path=str(tmp_path))
    _seed(client, "news_articles", ef=ingest.get_embedding_fn())
    assert ingest.migrate_collection_embedding_fn(client, "news_articles") == 0
    assert client.get_collection("news_articles", embedding_function=ingest.get_embedding_fn()).count() == 3


def test_migration_skips_a_missing_collection(tmp_path):
    chromadb = pytest.importorskip("chromadb")
    import ingest

    client = chromadb.PersistentClient(path=str(tmp_path))
    assert ingest.migrate_collection_embedding_fn(client, "screener_descriptions") == 0
    assert client.list_collections() == []
