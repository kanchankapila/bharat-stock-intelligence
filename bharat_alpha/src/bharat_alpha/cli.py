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
    """Import MoneyControl scIds and MarketsMojo sids from the legacy nse_stocks master
    (ambiguous ids dropped and reported, never resolved by whichever row came last)."""
    import psycopg

    from bharat_alpha.db import connect
    from bharat_alpha.ingest.sources.mojo_shareholding import import_legacy_mojo_ids
    from bharat_alpha.reference.provider_ids import import_legacy_mc_ids

    with connect() as conn, psycopg.connect(legacy_dsn) as legacy:
        _print({"moneycontrol": import_legacy_mc_ids(conn, legacy),
                "marketsmojo": import_legacy_mojo_ids(conn, legacy)})


@app.command("import-estimates")
def import_estimates(legacy_dsn: str):
    """Import legacy analyst_estimates_history as point-in-time estimate snapshots."""
    import psycopg

    from bharat_alpha.db import connect
    from bharat_alpha.ingest.sources.mc_estimates import import_legacy_estimates

    with connect() as conn, psycopg.connect(legacy_dsn) as legacy:
        _print({"rows_written": import_legacy_estimates(conn, legacy)})


@app.command("import-shareholding")
def import_shareholding(legacy_dsn: str):
    """Import legacy quarterly shareholding patterns, knowable by the SEBI filing deadline."""
    import psycopg

    from bharat_alpha.db import connect
    from bharat_alpha.ingest.sources.ownership import import_legacy_shareholding

    with connect() as conn, psycopg.connect(legacy_dsn) as legacy:
        _print(import_legacy_shareholding(conn, legacy))


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


legacy_app = typer.Typer(help="ontology-driven bridge from the legacy platform's tables")
app.add_typer(legacy_app, name="legacy-map")


@legacy_app.command("generate")
def legacy_generate(ontology_root: Path = typer.Option(None)):
    """Regenerate config/legacy_feature_map.yaml from the legacy ontology."""
    from collections import Counter

    from bharat_alpha.legacy import DEFAULT_ONTOLOGY_ROOT, generate_map, load_ontology, write_map

    entries = generate_map(load_ontology(ontology_root or DEFAULT_ONTOLOGY_ROOT))
    write_map(entries)
    _print({"entries": len(entries), "by_status": dict(Counter(f"{e.status}/{'on' if e.enabled else 'off'}" for e in entries)),
            "enabled_by_table": dict(Counter(e.table for e in entries if e.enabled))})


@legacy_app.command("import")
def legacy_import(legacy_dsn: str, since: str = typer.Option(None), allow_history: bool = False):
    """Import enabled mapped columns point-in-time (eod_plus tables forward-only unless --allow-history)."""
    import psycopg

    from bharat_alpha.db import connect
    from bharat_alpha.legacy import read_map
    from bharat_alpha.legacy.importer import import_entries

    with connect() as conn, psycopg.connect(legacy_dsn) as legacy:
        _print(import_entries(conn, legacy, read_map(), _date(since), allow_history))


@legacy_app.command("screen")
def legacy_screen(start: str, cutoff: str = typer.Option(None), horizon: int = 21):
    """Admit imported columns on evidence from data before the first walk-forward test block."""
    from bharat_alpha.db import connect
    from bharat_alpha.legacy.screen import default_cutoff, screen

    with connect() as conn:
        c = _date(cutoff) or default_cutoff(conn, _date(start))
        df = screen(conn, _date(start), c, horizon)
        # Split deliberately: "measured and failed" and "never measurable" are different facts,
        # and a single `rejected` count reads as a merit verdict for both (AF-20260929-09).
        v = df.verdict if len(df) else None
        _print({"cutoff": c,
                "admitted": df[df.admitted][["source", "field", "mean_ic", "t_nw"]].to_dict("records"),
                "no_evidence": int((v == "no_evidence").sum()) if len(df) else 0,
                "not_evaluable": int((v == "not_evaluable").sum()) if len(df) else 0,
                "not_evaluable_detail": (df[v == "not_evaluable"].groupby("source").size().to_dict()
                                         if len(df) else {})})


@app.command()
def portfolio(date: str = typer.Option(None), horizon: int = 21, capital: float = typer.Option(..., help="₹ capital")):
    """Build sized, constrained portfolio targets from a published recommendation list."""
    from bharat_alpha.db import connect, read_df
    from bharat_alpha.portfolio.run import build_targets

    with connect() as conn:
        d = _date(date) or read_df(conn, "SELECT max(as_of_date) d FROM alpha.recommendation WHERE horizon=%s",
                                   (horizon,)).d[0]
        _print(build_targets(conn, d, horizon, capital))


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
def ablate(horizon: int = 21, end: str = typer.Option(None), years: int = 6):
    """Retrain without each feature group; report which data sources add, hurt, or show no evidence."""
    from bharat_alpha.db import connect, read_df
    from bharat_alpha.modeling.ablation import ablate as run_ablation
    from bharat_alpha.modeling.dataset import build_dataset

    with connect() as conn:
        end_d = _date(end) or read_df(conn, "SELECT max(trade_date) d FROM alpha.trading_day").d[0]
        ds = build_dataset(conn, end_d - dt.timedelta(days=365 * years), end_d, horizon)
        _print(run_ablation(ds).to_dict(orient="records"))


@app.command()
def movers(horizon: int = 5, k: int = 20, end: str = typer.Option(None), years: int = 6):
    """Why did the movers move? Ranks each feature among the top-k AND bottom-k forward movers.

    Reports `separation` (directional) beside `t_winners_only` (what selecting on the winners
    alone would have told you). A feature with a huge winners-only t and ~0 separation is a
    volatility detector: it predicts movement, not direction.
    """
    from bharat_alpha.db import connect, read_df
    from bharat_alpha.evaluation.movers import mover_separation
    from bharat_alpha.modeling.dataset import build_dataset

    with connect() as conn:
        end_d = _date(end) or read_df(conn, "SELECT max(trade_date) d FROM alpha.trading_day").d[0]
        ds = build_dataset(conn, end_d - dt.timedelta(days=365 * years), end_d, horizon)
        _print(mover_separation(ds, k=k).to_dict(orient="records"))


@app.command("sources-audit")
def sources_audit(repo: Path = Path("..")):
    """Scan the URL corpus AND every URL in the legacy codebase: data hosts with no catalog verdict,
    and the data still missing (backlog families, ranked)."""
    from bharat_alpha.ingest.catalog import audit, load_catalog

    fams = load_catalog()
    res = audit(repo.resolve(), fams)
    rank = {"backlog-high": 0, "backlog-medium": 1, "backlog-low": 2}
    missing = sorted((f for f in fams if f.verdict in rank and res["by_family"].get(f.id)),
                     key=lambda f: (rank[f.verdict], -res["by_family"][f.id]))
    _print({"urls": res["urls"], "by_verdict": res["by_verdict"], "unevaluated_hosts": res["unevaluated"],
            "missing_data": [{"id": f.id, "verdict": f.verdict, "urls": res["by_family"][f.id], "category": f.category,
                              "pit": f.pit, "why": f.rationale} for f in missing]})


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
