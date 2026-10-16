import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "build_technical_signals_lineage.py"
SPEC = importlib.util.spec_from_file_location("technical_signals_lineage", SCRIPT)
lineage = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(lineage)


def test_lineage_inventory_covers_every_schema_column_and_sql_writer():
    report = lineage.build_lineage()
    expected_columns = lineage.schema_columns(lineage.SCHEMA.read_text(encoding="utf-8"))
    assert set(report["columns"]) == set(expected_columns)
    assert report["column_count"] >= 300
    assert report["writer_file_count"] >= 45

    for path in lineage._source_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        if lineage._WRITE.search(text):
            assert path.relative_to(lineage.ROOT).as_posix() in report["writer_files"]


def test_known_multi_writer_and_fcf_edges_are_visible():
    report = lineage.build_lineage()
    win_probability = report["columns"]["win_probability"]["writers"]
    assert "src/server/ml_ensemble.py" in win_probability
    assert "src/server/online_learner.py" in win_probability
    assert "src/server/ml_signal_scorer.py" in win_probability

    fcf_writers = report["columns"]["fcf_yield_approx"]["writers"]
    assert "src/server/financial_ratios_fetcher.py" in fcf_writers
