import db_compat


def test_engine_labels_the_python_writer_process(monkeypatch):
    captured = {}
    monkeypatch.setattr(db_compat, "_engines", {})
    monkeypatch.setattr(db_compat, "database_url", lambda: "postgresql+psycopg2://example/test")
    monkeypatch.setattr(db_compat._sys, "argv", ["financial_ratios_fetcher.py"])
    monkeypatch.delenv("BSI_WRITER_NAME", raising=False)

    def fake_create_engine(url, **kwargs):
        captured.update(url=url, **kwargs)
        return object()

    monkeypatch.setattr(db_compat, "create_engine", fake_create_engine)
    db_compat.get_engine()
    assert captured["connect_args"]["application_name"] == "bsi:financial_ratios_fetcher.py"


def test_engine_writer_label_can_be_overridden(monkeypatch):
    captured = {}
    monkeypatch.setattr(db_compat, "_engines", {})
    monkeypatch.setattr(db_compat, "database_url", lambda: "postgresql+psycopg2://example/test")
    monkeypatch.setenv("BSI_WRITER_NAME", "repair-run")
    monkeypatch.setattr(
        db_compat,
        "create_engine",
        lambda url, **kwargs: captured.update(url=url, **kwargs) or object(),
    )
    db_compat.get_engine()
    assert captured["connect_args"]["application_name"] == "bsi:repair-run"
