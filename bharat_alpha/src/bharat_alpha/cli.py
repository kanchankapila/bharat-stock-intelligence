"""`bqa` command line."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import typer

app = typer.Typer(add_completion=False, help="bharat_alpha — point-in-time, self-grading NSE prediction engine")


def _date(s: str | None) -> dt.date | None:
    return dt.date.fromisoformat(s) if s else None


def _print(obj) -> None:
    from bharat_alpha.db import jsonable

    typer.echo(json.dumps(jsonable(obj), indent=2, default=str))


@app.command("init-db")
def init_db():
    """Apply migrations and verify the schema."""
    from bharat_alpha.db import connect
    from bharat_alpha.db.migrate import migrate

    with connect() as conn:
        _print({"applied": migrate(conn)})


@app.command()
def ingest(source: str, date: str = typer.Option(None), start: str = typer.Option(None), end: str = typer.Option(None)):
    """Run one connector for a date or a date range (per-date sources) or once (snapshot sources)."""
    from bharat_alpha.db import connect
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.http import HttpClient
    from bharat_alpha.ingest.registry import CONNECTORS
    from bharat_alpha.timeutil import latest_completed_session

    cls = CONNECTORS[source]
    client = HttpClient()
    with connect() as conn:
        if cls.per_date and start:
            d, stop, out = _date(start), _date(end) or latest_completed_session(), {}
            while d <= stop:
                if d.weekday() < 5:
                    out[str(d)] = run_connector(conn, cls(), d, client=client)
                d += dt.timedelta(days=1)
            _print(out)
        else:
            _print(run_connector(conn, cls(), _date(date) or latest_completed_session(), client=client))


@app.command("import-legacy")
def import_legacy(legacy_dsn: str, start: str, end: str):
    """Bootstrap history from the legacy bharat_intel database (bhavcopy + FII/DII)."""
    from bharat_alpha.db import connect
    from bharat_alpha.ingest.sources.legacy_bridge import import_legacy as run
    from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars

    with connect() as conn:
        stats = run(conn, legacy_dsn, _date(start), _date(end))
        stats["suspect_flags"] = flag_suspect_bars(conn)
        stats["adjustments"] = derive_adjustments(conn)
        conn.commit()
        _print(stats)


@app.command("import-provider-ids")
def import_provider_ids(legacy_dsn: str):
    """Import MoneyControl scIds from the legacy nse_stocks master (ambiguous codes dropped)."""
    import psycopg

    from bharat_alpha.db import connect
    from bharat_alpha.reference.provider_ids import import_legacy_mc_ids

    with connect() as conn, psycopg.connect(legacy_dsn) as legacy:
        _print(import_legacy_mc_ids(conn, legacy))


@app.command("import-estimates")
def import_estimates(legacy_dsn: str):
    """Import legacy analyst_estimates_history as point-in-time estimate snapshots."""
    import psycopg

    from bharat_alpha.db import connect
    from bharat_alpha.ingest.sources.mc_estimates import import_legacy_estimates

    with connect() as conn, psycopg.connect(legacy_dsn) as legacy:
        _print({"rows_written": import_legacy_estimates(conn, legacy)})


@app.command("compare-legacy")
def compare_legacy(legacy_dsn: str, start: str, end: str, horizon: int = 21, timeframe: str = typer.Option(None)):
    """Grade legacy unified_recommendations and this system's published ranking on the same dates."""
    from bharat_alpha.db import connect
    from bharat_alpha.evaluation.compare import compare, ledger_scores, load_legacy_ranker

    a = load_legacy_ranker(legacy_dsn, _date(start), _date(end), timeframe)
    with connect() as conn:
        b = ledger_scores(conn, horizon, _date(start), _date(end))
        if b.empty:
            raise typer.BadParameter("no bharat_alpha recommendations in that window yet")
        _print(compare(conn, a, b, horizon))


@app.command()
def prepare(since: str = typer.Option(None)):
    """Re-flag suspect bars and re-derive corporate-action factors."""
    from bharat_alpha.db import connect
    from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars

    with connect() as conn:
        out = {"suspect_flags_changed": flag_suspect_bars(conn, _date(since)),
               "adjustments": derive_adjustments(conn, _date(since))}
        conn.commit()
        _print(out)


@app.command()
def train(horizon: int = 21, end: str = typer.Option(None), years: int = 6, promote: bool = True):
    """Walk-forward train + evaluate a candidate; run the promotion gate."""
    from bharat_alpha.db import connect, read_df
    from bharat_alpha.modeling.dataset import build_dataset
    from bharat_alpha.modeling.registry import decide
    from bharat_alpha.modeling.train import train_model

    with connect() as conn:
        end_d = _date(end) or read_df(conn, "SELECT max(trade_date) d FROM alpha.trading_day").d[0]
        ds = build_dataset(conn, end_d - dt.timedelta(days=365 * years), end_d, horizon)
        res = train_model(conn, ds)
        out = {"model_id": res.model_id, "ensemble": res.report["ensemble"], "backtest": res.report["backtest"],
               "benchmark": res.report.get("benchmark", {}).get("backtest")}
        if promote:
            out["gate"] = decide(conn, res.model_id).as_dict()
        _print(out)


session_app = typer.Typer(help="next-session (open->close) engine")
app.add_typer(session_app, name="session")


@session_app.command("measure")
def session_measure(end: str = typer.Option(None), sessions: int = 1500):
    """Re-measure the capitulation rule on this system's data (day-level, net of intraday costs)."""
    from bharat_alpha.db import connect, read_df
    from bharat_alpha.session.publish import measure_rule

    with connect() as conn:
        e = _date(end) or read_df(conn, "SELECT max(trade_date) d FROM alpha.trading_day").d[0]
        _print(measure_rule(conn, e, sessions))


@session_app.command("train")
def session_train(end: str = typer.Option(None), years: int = 6, promote: bool = True):
    """Walk-forward train the next-session model; gate it against the rule as a book."""
    from bharat_alpha.db import connect, read_df
    from bharat_alpha.modeling.registry import decide
    from bharat_alpha.session.model import build_session_dataset, train_session_model

    with connect() as conn:
        e = _date(end) or read_df(conn, "SELECT max(trade_date) d FROM alpha.trading_day").d[0]
        ds = build_session_dataset(conn, e - dt.timedelta(days=365 * years), e)
        model_id, report, _, _ = train_session_model(conn, ds)
        out = {"model_id": model_id, "ensemble": report["ensemble"], "day_level": report["backtest"],
               "rule": report["benchmark"]["day_level"]}
        if promote:
            out["gate"] = decide(conn, model_id).as_dict()
        _print(out)


@app.command()
def preopen():
    """Capture today's NSE pre-open auction now (use between 09:08 and 09:14 IST)."""
    from bharat_alpha.db import connect
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_preopen import NsePreopen
    from bharat_alpha.timeutil import ist_now

    with connect() as conn:
        _print(run_connector(conn, NsePreopen(), ist_now().date()))


@app.command()
def daily(date: str = typer.Option(None), no_ingest: bool = False, force: bool = False):
    """Run the daily DAG for one session (default: latest completed session)."""
    from bharat_alpha.db import connect
    from bharat_alpha.pipeline.daily import run_daily
    from bharat_alpha.timeutil import latest_completed_session

    with connect() as conn:
        _print(run_daily(conn, _date(date) or latest_completed_session(), ingest=not no_ingest, force=force))


@app.command()
def scheduler():
    """Run the scheduler loop forever (the one production process besides the API)."""
    from bharat_alpha.pipeline.scheduler import run_forever

    run_forever()


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8010):
    """Serve the read-only API."""
    import uvicorn

    uvicorn.run("bharat_alpha.api.app:app", host=host, port=port)


@app.command()
def dq(date: str = typer.Option(None)):
    """Run data-quality checks for a session."""
    from bharat_alpha.config import get_settings
    from bharat_alpha.db import connect, read_df
    from bharat_alpha.quality.checks import run_checks

    with connect() as conn:
        d = _date(date) or read_df(conn, "SELECT max(trade_date) d FROM alpha.trading_day").d[0]
        _print([r.__dict__ for r in run_checks(conn, d, get_settings().horizons)])


@app.command()
def catalog(urls: Path = Path("../urls.txt")):
    """Triage every URL in urls.txt against config/source_catalog.yaml."""
    from collections import Counter

    from bharat_alpha.ingest.catalog import load_catalog, triage

    fams = {f.id: f for f in load_catalog()}
    counts, unmatched = triage(urls.read_text().splitlines())
    by_verdict: Counter = Counter()
    for k, n in counts.items():
        by_verdict[fams[k].verdict] += n
    _print({"by_verdict": dict(by_verdict),
            "families": [{"id": k, "urls": n, "verdict": fams[k].verdict, "category": fams[k].category,
                          "rationale": fams[k].rationale} for k, n in counts.most_common()],
            "unmatched": unmatched})


@app.command()
def demo(days: int = 520, stocks: int = 120, signal: float = 1.0, horizon: int = 5):
    """Run the full pipeline on a synthetic market in the configured database (wipes schema alpha)."""
    from bharat_alpha.db import connect
    from bharat_alpha.db.migrate import migrate
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_corporate import NseSymbolChange
    from bharat_alpha.ingest.sources.nse_market import NseFiiDii, NseIndexClose
    from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars
    from bharat_alpha.modeling.dataset import build_dataset
    from bharat_alpha.modeling.registry import decide
    from bharat_alpha.modeling.train import train_model
    from bharat_alpha.sim import simulate

    if not typer.confirm("This DROPS schema 'alpha' in the configured database. Continue?"):
        raise typer.Abort()
    sim = simulate(n_stocks=stocks, n_days=days, signal_strength=signal)
    with connect() as conn:
        conn.execute("DROP SCHEMA IF EXISTS alpha CASCADE")
        conn.commit()
        migrate(conn)
        for d in sim.dates:
            run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
            run_connector(conn, NseIndexClose(), d, raw=sim.index_files[d])
            run_connector(conn, NseFiiDii(), d, raw=sim.fii_dii[d])
        run_connector(conn, NseSymbolChange(), sim.dates[-1], raw=sim.symbol_changes_csv)
        flag_suspect_bars(conn)
        derive_adjustments(conn)
        conn.commit()
        res = train_model(conn, build_dataset(conn, sim.dates[0], sim.dates[-1], horizon))
        _print({"model_id": res.model_id, "ensemble": res.report["ensemble"], "backtest": res.report["backtest"],
                "gate": decide(conn, res.model_id).as_dict()})


if __name__ == "__main__":
    app()
