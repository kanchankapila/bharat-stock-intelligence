"""
DalalOS Financial-Trends One-Time Backfill
===========================================
Loads real per-quarter revenue/EPS/margin/growth history into
`dalalos_financial_trends_history`, sourced from DalalOS's MCP `get_financial_trends`
tool (mcp__<dalalos-server>__get_financial_trends).

Why this is a one-time backfill script, not a scheduled `*_fetcher.py`:
DalalOS is a third-party MCP server (github: dalalos) with NO usable REST endpoint for
this platform's own runPython()/BullMQ jobs to call — its REST surface returned
`HTTP 403 {"error": "The rest API is not included in your plan", "reason_code":
"surface_not_in_plan"}` when live-tested 2026-08-31 with a real API key. Only a Claude
session holding an active MCP connection to DalalOS can call `get_financial_trends`, so
the data-collection step (Phase 1/2 of onboard-data-source) happens INTERACTIVELY, once,
with the raw tool output saved to `dalalos_financial_trends_seed.json` — not on a schedule.

This module still keeps the standard fetcher shape (own parse function, own DB-write
function, kept separate) so it's testable and so extending coverage is mechanical: to add
more symbols, call `get_financial_trends(symbol, limit=12)` via MCP, append a trimmed
{"nse_symbol", "isin", "statement_type", "revenue_cagr", "net_income_cagr", "periods": [...]}
entry to the seed JSON (drop the `segments`/`cash_flow_available`/`notes` fields — not
needed for factor testing and bulk up the file for no benefit), and re-run this script.

Why historical_fundamentals/fundamentals_history don't already cover this: checked live
2026-08-31 against RELIANCE — despite ~35 "distinct dates" since 2026-06-30, the underlying
values (eps_ttm, revenue_growth, net_margin) are the same 3-4 quarterly snapshots re-stamped
daily. There is no genuine multi-quarter series in either table. This one holds real
2023-2026 quarterly history instead.

Run:
    python dalalos_financial_trends_backfill.py
    python dalalos_financial_trends_backfill.py --seed-file dalalos_financial_trends_seed.json
"""

import argparse
import json
from pathlib import Path

from db_compat import connect


def parse_financial_trends(entry: dict) -> list[dict]:
    """
    Convert one seed-JSON company entry (already-trimmed DalalOS get_financial_trends
    output) into a list of row dicts ready for write_financial_trends_rows().
    Mirrors the "own parsing function" convention every fetcher in this repo follows,
    even though the raw source here is an MCP tool result captured interactively rather
    than an HTTP response this function fetches itself.
    """
    symbol = (entry.get("nse_symbol") or "").strip().upper()
    if not symbol:
        return []
    isin = entry.get("isin") or None
    statement_type = entry.get("statement_type") or None
    revenue_cagr = entry.get("revenue_cagr")
    net_income_cagr = entry.get("net_income_cagr")

    rows = []
    for p in entry.get("periods", []):
        period_end = p.get("period_end")
        if not period_end:
            continue
        rows.append({
            "symbol": symbol,
            "period_end": period_end,
            "period_type": "quarterly",
            "fiscal_label": p.get("fiscal_label"),
            "isin": isin,
            "statement_type": statement_type,
            "revenue": p.get("revenue"),
            "revenue_basis": p.get("revenue_basis"),
            "net_income": p.get("net_income"),
            "eps": p.get("eps"),
            "ebitda_margin": p.get("ebitda_margin"),
            "net_margin": p.get("net_margin"),
            "net_margin_delta": p.get("net_margin_delta"),
            "qoq_revenue_growth": p.get("qoq_revenue_growth"),
            "qoq_net_income_growth": p.get("qoq_net_income_growth"),
            "yoy_revenue_growth": p.get("yoy_revenue_growth"),
            "revenue_cagr": revenue_cagr,
            "net_income_cagr": net_income_cagr,
            "source": p.get("source") or "dalalos-mcp",
        })
    return rows


def write_financial_trends_rows(conn, rows: list[dict]) -> int:
    """Upsert parsed rows into dalalos_financial_trends_history. Returns rows written."""
    if not rows:
        return 0

    sql = """
        INSERT INTO dalalos_financial_trends_history
            (symbol, period_end, period_type, fiscal_label, isin, statement_type,
             revenue, revenue_basis, net_income, eps, ebitda_margin, net_margin,
             net_margin_delta, qoq_revenue_growth, qoq_net_income_growth,
             yoy_revenue_growth, revenue_cagr, net_income_cagr, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, period_end, period_type) DO UPDATE SET
            fiscal_label           = excluded.fiscal_label,
            isin                   = excluded.isin,
            statement_type         = excluded.statement_type,
            revenue                = excluded.revenue,
            revenue_basis          = excluded.revenue_basis,
            net_income             = excluded.net_income,
            eps                    = excluded.eps,
            ebitda_margin          = excluded.ebitda_margin,
            net_margin             = excluded.net_margin,
            net_margin_delta       = excluded.net_margin_delta,
            qoq_revenue_growth     = excluded.qoq_revenue_growth,
            qoq_net_income_growth  = excluded.qoq_net_income_growth,
            yoy_revenue_growth     = excluded.yoy_revenue_growth,
            revenue_cagr           = excluded.revenue_cagr,
            net_income_cagr        = excluded.net_income_cagr,
            source                 = excluded.source
    """
    params = [
        (
            r["symbol"], r["period_end"], r["period_type"], r["fiscal_label"], r["isin"],
            r["statement_type"], r["revenue"], r["revenue_basis"], r["net_income"], r["eps"],
            r["ebitda_margin"], r["net_margin"], r["net_margin_delta"],
            r["qoq_revenue_growth"], r["qoq_net_income_growth"], r["yoy_revenue_growth"],
            r["revenue_cagr"], r["net_income_cagr"], r["source"],
        )
        for r in rows
    ]
    # Use the CALLER's conn (ConnWrapper.executemany), not db_compat's module-level
    # executemany() -- that helper opens its own engine connection and silently ignores
    # any conn passed to it, which defeats a test fixture's schema isolation (caught live
    # by test_write_roundtrip_and_upsert_idempotent writing into an empty pg_conn schema
    # and finding 0 rows). See recurring-bugs.md's "a function that takes a conn argument
    # and then ignores it" entry.
    conn.executemany(sql, params)
    conn.commit()
    return len(params)


def main():
    parser = argparse.ArgumentParser(description="Backfill dalalos_financial_trends_history from a seed JSON file")
    parser.add_argument("--seed-file", default="dalalos_financial_trends_seed.json")
    args = parser.parse_args()

    seed_path = Path(__file__).parent / args.seed_file
    entries = json.loads(seed_path.read_text(encoding="utf-8"))

    conn = connect()
    total = 0
    per_symbol = {}
    for entry in entries:
        rows = parse_financial_trends(entry)
        n = write_financial_trends_rows(conn, rows)
        per_symbol[entry.get("nse_symbol")] = n
        total += n
    conn.close()

    print(f"[DalalOSFinancialTrends] Wrote {total} quarter-rows across {len(entries)} symbols:")
    for sym, n in per_symbol.items():
        print(f"  {sym}: {n} quarters")


if __name__ == "__main__":
    main()
