#!/usr/bin/env python3
"""First-reported quarterly financials parsed from each NSE results filing's XBRL -> nse_filing_financials.

Why: dalalos_financial_trends_history may hold RESTATED values. The pre-registered Q2-FY27 shadow arm
(measurement.md 2026-10-11, AF-20261008-42) and the H1-H3 re-tests need the numbers AS FILED, dated by
the filing's own broadcast_ts. Each row of nse_results_filings carries the XBRL link; this module
fetches it (one GET per filing, nsearchives.nseindia.com, via NseClient) and parses it.

Taxonomy findings (probed 2026-10-11 on 9 real files: INFY/HDFCBANK legacy 2023, TCS legacy Q2-FY24,
INFY/RELIANCE/HDFCBANK/BAJFINANCE integrated Q1-FY27, INFY/SBIN integrated Q2-FY26):
- Contexts are identified by NSE's fixed ids, NOT by their declared period: 'OneD' = the quarter,
  'FourD' = year-to-date (present from Q2 on), 'OneI' = the balance-sheet date. The ids are trusted
  because the declared periods are not: TCS Q2-FY24 declares FourD as 01-Jul..30-Sep while its facts
  are the half year (and its own DateOfStartOfReportingPeriod[FourD] says 01-Apr), and HDFCBANK's
  2023 BANKING file references 'OneD' from every fact but never declares that context at all.
  Every other context is dimensional (segments, expense lines) and is ignored.
- NO prior-year comparative is in any file (no context for the year-earlier quarter; 'PY_I' is only
  the previous year-end balance sheet). YoY growth therefore needs the year-earlier filing's own row.
- Monetary facts are absolute rupees (unit iso4217:INR, `decimals` = rounding, e.g. -7 = crore,
  -5 = lakh) whatever LevelOfRounding says; values here are stored in Rs crore (/1e7). EPS is per
  share and never scaled. A monetary fact in any other unit is treated as absent, never rescaled.
- Tag families: Ind-AS and NBFC files use RevenueFromOperations / ProfitLossForPeriod /
  ProfitBeforeTax / FinanceCosts; BANKING files use InterestEarned / ProfitLossForThePeriod /
  ProfitLossFromOrdinaryActivitiesBeforeTax / InterestExpended. For a bank, `revenue` = interest
  earned and `finance_costs` = interest expended. Life insurers (LI; CANHLIFE Q2-FY27 probed) use
  NetPremiumIncome / ProfitLossAfterTaxAndExtraordinaryItems / ProfitLossBeforeTax; general
  insurers (GI) were not probed. A file with none of revenue/total_income/pat is stored with
  parse_error='no_core_tags'.
- Balance sheet (Assets) and cash flow (CashFlowsFromUsedInOperatingActivities, YTD) appear only in
  half-year/annual filings (Q2, Q4); in Q1/Q3 they are NULL.

NULL always means 'tag absent'; a reported 0 stays 0. One row per (symbol, period_end, consolidated,
broadcast_ts, filing_period); revisions are kept as their own rows with is_original = false. A
reader wanting first-reported values picks is_original, consolidated if present else standalone.

    python nse_xbrl_fundamentals_fetcher.py --period-end 2026-09-30 --only-latest-per-symbol-period
    python nse_xbrl_fundamentals_fetcher.py --since 2026-10-01 --only-latest-per-symbol-period --max-requests 300
    python nse_xbrl_fundamentals_fetcher.py --since 2021-01-01 --dry-run      # request math, no fetch
"""
from __future__ import annotations

import argparse
import math
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import date, datetime, time, timedelta

from db_compat import connect, executemany_batched
from nse_filings_common import (
    IST, BudgetExhausted, NseBlocked, NseClient, NseFetchError, clean_text, today_ist,
)

TABLE = "nse_filing_financials"
PREFIX = "[NSE-XBRL]"
CRORE = 1e7
QUARTER, YTD, INSTANT = "OneD", "FourD", "OneI"
DEFAULT_PERIODS = ("Quarterly", "Integrated")  # 'Annual' files' OneD is not a quarter

MONEY_TAGS = {  # first tag present wins
    "revenue": ("RevenueFromOperations", "InterestEarned", "NetPremiumIncome"),
    "total_income": ("Income",),
    "pat": ("ProfitLossForPeriod", "ProfitLossForThePeriod", "ProfitLossAfterTaxAndExtraordinaryItems"),
    "pat_owners": ("ProfitOrLossAttributableToOwnersOfParent",
                   "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates"),
    "pbt": ("ProfitBeforeTax", "ProfitLossFromOrdinaryActivitiesBeforeTax", "ProfitLossBeforeTax"),
    "tax_expense": ("TaxExpense",),
    "finance_costs": ("FinanceCosts", "InterestExpended"),
}
EPS_TAGS = ("BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
            "BasicEarningsLossPerShareFromContinuingOperations",
            "BasicEarningsPerShareAfterExtraordinaryItems")
VALUE_COLS = ("period_start", *MONEY_TAGS, "eps_basic", "total_assets", "cfo_ytd", "revenue_ytd",
              "pat_ytd", "unit_scale")
KEY = ("symbol", "period_end", "consolidated", "broadcast_ts", "filing_period")
COLUMNS = (*KEY, "relating_to", "is_original", *VALUE_COLS, "xbrl_kind", "parse_error", "source_url")


class XbrlParseError(ValueError):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def ensure_schema(conn) -> None:
    money = ",\n".join(f"            {c} DOUBLE PRECISION" for c in
                       (*MONEY_TAGS, "eps_basic", "total_assets", "cfo_ytd", "revenue_ytd", "pat_ytd"))
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            symbol          TEXT NOT NULL,
            period_end      DATE NOT NULL,
            consolidated    BOOLEAN NOT NULL,
            broadcast_ts    TIMESTAMPTZ NOT NULL,
            filing_period   TEXT NOT NULL,
            relating_to     TEXT,
            is_original     BOOLEAN NOT NULL,
            period_start    DATE,
{money},
            unit_scale      TEXT,
            xbrl_kind       TEXT,
            parse_error     TEXT,
            source_url      TEXT NOT NULL,
            parsed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (symbol, period_end, consolidated, broadcast_ts, filing_period)
        )""")
    conn.execute(f"CREATE INDEX IF NOT EXISTS {TABLE}_source_url_idx ON {TABLE} (source_url)")
    conn.commit()


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def xbrl_kind(url: str) -> str:
    name = (url or "").rsplit("/", 1)[-1].upper()
    if "BANKING" in name:
        return "bank"
    if "NBFC" in name:
        return "nbfc"
    if re.search(r"(^|_)(LI|GI)_", name):
        return "insurance"
    if "NONINDAS" in name:
        return "nonindas"
    return "indas"


def _iso(v) -> date | None:
    s = clean_text(v)
    try:
        return date.fromisoformat(s[:10]) if s else None
    except ValueError:
        return None


def parse_xbrl(text: str, expected_period_end: date | None = None,
               expected_consolidated: bool | None = None) -> dict:
    """XBRL instance text -> the VALUE_COLS dict (Rs crore). Raises XbrlParseError(reason)."""
    try:
        root = ET.fromstring(text)
    except (ET.ParseError, TypeError):
        raise XbrlParseError("not_xbrl")
    if _local(root.tag) != "xbrl":
        raise XbrlParseError("not_xbrl")

    units: dict[str, str] = {}
    ctx_period: dict[str, tuple] = {}
    facts: dict[tuple, ET.Element] = {}
    for el in root:
        name = _local(el.tag)
        if name == "unit":
            measures = [m.text.strip() for m in el.iter() if _local(m.tag) == "measure" and m.text]
            units[el.get("id")] = measures[0] if measures else ""  # simple measure, or a divide's numerator
        elif name == "context":
            got = {_local(p.tag): (p.text or "").strip() for p in el.iter()
                   if _local(p.tag) in ("startDate", "endDate", "instant")}
            ctx_period[el.get("id")] = (_iso(got.get("startDate")), _iso(got.get("endDate") or got.get("instant")))
        elif el.get("contextRef") in (QUARTER, YTD, INSTANT):
            facts.setdefault((name, el.get("contextRef")), el)

    def inr(el, fallback_id):
        uid = el.get("unitRef")
        measure = units.get(uid)
        return measure.upper().endswith(":INR") if measure is not None else uid == fallback_id

    def num(el):
        try:
            v = float((el.text or "").replace(",", "").strip())
        except ValueError:
            return None
        return v if math.isfinite(v) else None

    def money(tags, ctx):
        for t in tags:
            el = facts.get((t, ctx))
            if el is not None:
                v = num(el) if inr(el, "INR") else None
                return None if v is None else round(v / CRORE, 4)
        return None

    def txt(tag, ctx=QUARTER):
        el = facts.get((tag, ctx))
        return clean_text(el.text) if el is not None else None

    q_start, q_end = ctx_period.get(QUARTER, (None, None))
    period_end = _iso(txt("DateOfEndOfReportingPeriod")) or q_end
    expected_period_end = _iso(str(expected_period_end)) if expected_period_end else None  # db_compat may hand back text
    if expected_period_end and period_end and period_end != expected_period_end:
        raise XbrlParseError("period_mismatch")
    nature = txt("NatureOfReportStandaloneConsolidated")
    if nature and expected_consolidated is not None and nature.lower().startswith("consolidated") != expected_consolidated:
        raise XbrlParseError("consolidation_mismatch")

    out = {k: money(tags, QUARTER) for k, tags in MONEY_TAGS.items()}
    eps = next((facts[(t, QUARTER)] for t in EPS_TAGS if (t, QUARTER) in facts), None)
    out["eps_basic"] = num(eps) if eps is not None and inr(eps, "INRPerShare") else None
    out["total_assets"] = money(("Assets",), INSTANT)
    out["cfo_ytd"] = money(("CashFlowsFromUsedInOperatingActivities",), YTD)
    out["revenue_ytd"] = money(MONEY_TAGS["revenue"], YTD)
    out["pat_ytd"] = money(MONEY_TAGS["pat"], YTD)
    out["period_start"] = _iso(txt("DateOfStartOfReportingPeriod")) or q_start
    out["unit_scale"] = txt("LevelOfRounding") or txt("LevelOfRoundingUsedInFinancialStatements")
    return out


def quality_flag(values: dict, period_end) -> str | None:
    """A parsed file whose values must not be read as a quarter. Values are still stored.
    not_a_quarter: 'OneD' spans > 100 days -- 12 of the first 150 Q2-FY26 files declared their
    'OneD' as 01-Apr..30-Sep and carried half-year figures there (IRFC PAT 3,522.67 vs quarter
    1,776.98), with no separate quarter context."""
    if not any(values[k] is not None for k in ("revenue", "total_income", "pat")):
        return "no_core_tags"
    start, end = values.get("period_start"), _iso(str(period_end)) if period_end else None
    if start and end and (end - start).days > 100:
        return "not_a_quarter"
    return None


# ─── selection / write / crawl ─────────────────────────────────────────────

def _ist_start(d: date) -> datetime:
    return datetime.combine(d, time.min, tzinfo=IST)


def select_filings(conn, since: date, until: date, period_end: date | None = None,
                   only_latest: bool = False, periods=DEFAULT_PERIODS, include_parsed: bool = False) -> list[dict]:
    """Filings broadcast in [since, until] (IST dates) with an XBRL link and not yet in TABLE.
    only_latest: one filing per (symbol, period_end) -- original before revision, consolidated
    before standalone, then the latest broadcast."""
    ph = ", ".join("?" for _ in periods)
    params = [*periods, _ist_start(since), _ist_start(until + timedelta(days=1))]
    pe = ""
    if period_end:
        pe, params = "AND period_end = ?", [*params, period_end]
    rows = conn.execute(f"""
        WITH f AS (
            SELECT symbol, period_end, period AS filing_period, consolidated, relating_to, broadcast_ts, xbrl_url,
                   ROW_NUMBER() OVER (PARTITION BY symbol, period_end ORDER BY
                       (relating_to IS DISTINCT FROM 'Revision') DESC, (consolidated = 'Consolidated') DESC,
                       broadcast_ts DESC) AS rn
            FROM nse_results_filings
            WHERE period IN ({ph}) AND broadcast_ts >= ? AND broadcast_ts < ? {pe}
              AND xbrl_url LIKE 'http%'
        )
        SELECT symbol, period_end, filing_period, consolidated, relating_to, broadcast_ts, xbrl_url FROM f
        WHERE {'rn = 1' if only_latest else 'TRUE'}
          {'' if include_parsed else f'AND NOT EXISTS (SELECT 1 FROM {TABLE} p WHERE p.source_url = f.xbrl_url)'}
        ORDER BY broadcast_ts, symbol, xbrl_url""", tuple(params)).fetchall()
    cols = ("symbol", "period_end", "filing_period", "consolidated", "relating_to", "broadcast_ts", "xbrl_url")
    return [dict(zip(cols, r)) for r in rows]


def _row(f: dict, values: dict | None, error: str | None) -> dict:
    row = dict.fromkeys(COLUMNS)
    row.update({
        "symbol": f["symbol"], "period_end": f["period_end"], "broadcast_ts": f["broadcast_ts"],
        "consolidated": f["consolidated"] == "Consolidated", "filing_period": f["filing_period"],
        "relating_to": f["relating_to"], "is_original": f["relating_to"] != "Revision",
        "xbrl_kind": xbrl_kind(f["xbrl_url"]), "parse_error": error, "source_url": f["xbrl_url"],
    })
    if values:
        row.update(values)
    return row


def upsert(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    upd = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c not in KEY)
    executemany_batched(conn, f"""
        INSERT INTO {TABLE} ({', '.join(COLUMNS)}) VALUES ({', '.join('?' for _ in COLUMNS)})
        ON CONFLICT ({', '.join(KEY)}) DO UPDATE SET {upd}, parsed_at = now()""",
                        [tuple(r[c] for c in COLUMNS) for r in rows])
    conn.commit()
    return len(rows)


def crawl(conn, client: NseClient, filings: list[dict], max_consecutive_transient: int = 5,
          batch_size: int = 50) -> Counter:
    """One GET per filing. Permanent outcomes (parsed, a 4xx, a parse error) are written, so a resumed
    run skips them; transient ones (5xx/timeout after retries, an HTML page in place of XBRL) are
    counted, not written, and N in a row stop the run."""
    stats: Counter = Counter()
    stats["stop"] = None
    batch: list[dict] = []
    transient = 0
    try:
        for f in filings:
            try:
                text = client.get_text(f["xbrl_url"])
            except NseFetchError as exc:
                msg = str(exc)
                if msg.startswith("HTTP "):
                    reason = "http_" + msg.split()[1]
                    stats[reason] += 1
                    batch.append(_row(f, None, reason))
                    continue
                text = None
                reason = "fetch_failed"
            if text is not None:
                try:
                    values = parse_xbrl(text, f["period_end"], f["consolidated"] == "Consolidated")
                except XbrlParseError as exc:
                    reason = exc.reason
                else:
                    transient = 0
                    flag = quality_flag(values, f["period_end"])
                    stats[flag or "parsed"] += 1
                    batch.append(_row(f, values, flag))
                    reason = None
                if reason and reason != "not_xbrl":
                    transient = 0
                    stats[reason] += 1
                    batch.append(_row(f, None, reason))
                    reason = None
            if reason:  # transient: fetch_failed / not_xbrl
                stats[reason] += 1
                transient += 1
                if transient >= max_consecutive_transient:
                    stats["stop"] = f"error: {transient} consecutive transient failures (last {reason} on {f['xbrl_url']})"
                    break
            if len(batch) >= batch_size:
                stats["written"] += upsert(conn, batch)
                batch = []
                print(f"{PREFIX} written {stats['written']} (requests {client.requests_made}/{client.max_requests})")
    except BudgetExhausted as exc:
        stats["stop"] = f"budget: {exc}"
    except NseBlocked as exc:
        stats["stop"] = f"error: {exc}"
    stats["written"] += upsert(conn, batch)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--since", type=date.fromisoformat, help="broadcast date from (IST, default: 10 days ago)")
    ap.add_argument("--until", type=date.fromisoformat, help="broadcast date to (IST, default: today)")
    ap.add_argument("--period-end", type=date.fromisoformat, help="only this quarter end")
    ap.add_argument("--only-latest-per-symbol-period", action="store_true",
                    help="one filing per (symbol, period_end): original, consolidated if present, latest broadcast")
    ap.add_argument("--periods", default=",".join(DEFAULT_PERIODS))
    ap.add_argument("--max-requests", type=int, default=500)
    ap.add_argument("--min-interval", type=float, default=1.5, help="seconds between requests (floor 1.0)")
    ap.add_argument("--dry-run", action="store_true", help="print how many GETs the selection needs, fetch nothing")
    args = ap.parse_args(argv)

    end = args.until or today_ist()
    start = args.since or (end - timedelta(days=10))
    periods = tuple(p.strip() for p in args.periods.split(",") if p.strip())
    conn = connect()
    ensure_schema(conn)
    filings = select_filings(conn, start, end, args.period_end, args.only_latest_per_symbol_period, periods)
    conn.commit()  # end the read transaction: never sit 'idle in transaction' through minutes of network I/O
    print(f"{PREFIX} {len(filings)} filings to fetch ({start}..{end}, period_end={args.period_end}, "
          f"only_latest={args.only_latest_per_symbol_period}, periods={periods})")
    if args.dry_run:
        by_q = Counter(str(f["period_end"]) for f in filings)
        print(f"{PREFIX} dry run: {len(filings)} GETs (+1 warm-up) ~{len(filings) * args.min_interval / 60:.0f} min "
              f"at {args.min_interval}s; by period_end: {dict(sorted(by_q.items()))}")
        conn.close()
        return 0
    client = NseClient(args.max_requests, args.min_interval, log_prefix=PREFIX)
    stats = crawl(conn, client, filings)
    conn.close()
    print(f"{PREFIX} done: {dict(stats)} requests={client.requests_made} statuses={dict(client.status_counts)}")
    return 2 if stats["stop"] and stats["stop"].startswith("error") else 0


if __name__ == "__main__":
    sys.exit(main())
