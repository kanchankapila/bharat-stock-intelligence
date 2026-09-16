"""
MoneyControl EPS Surprise Fetcher
==================================
Fetches quarterly EPS actual-vs-estimate data from MC and computes five
beat-streak features for ml_ensemble:

  eps_surprise_q1        — most recent quarter NP surprise %
  eps_surprise_q2        — one quarter prior NP surprise %
  eps_beat_streak        — consecutive quarters with np_surprise > 0 (up to 8)
  eps_miss_after_streak  — 1 if prior 3 quarters beat BUT latest missed
  rev_surprise_q1        — most recent quarter revenue surprise %

Strategy (two-pass):
  Pass 1 — BULK endpoint: one request fetches latest-quarter data for ~524 stocks.
            sc_id in the response = mcsymbol in nse_stocks. No per-stock ID needed.
            URL: https://api.moneycontrol.com/mcapi/v1/earnings/actual-estimate?page=1&limit=30000

  Pass 2 — STORED HISTORY (no network): q2 + beat streak are derived by reading back the
            eps_surprise_history rows the bulk pass itself accumulates, one per
            (scid, results-date), run after run. MC exposes NO per-stock variant of this
            endpoint — see enrich_from_history for the live 422 evidence.

All five columns are written to the most-recent technical_signals row per symbol.

Run:
  python eps_surprise_fetcher.py                # bulk + history-derived streak
  python eps_surprise_fetcher.py --bulk-only    # bulk pass only (fast, q1 only)
  python eps_surprise_fetcher.py --symbol INFY  # single stock test
  python eps_surprise_fetcher.py --limit 50     # first 50 resolved stocks
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class EpsSurpriseFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class EpsSurpriseFetcherBaseFetcher(BaseFetcher[EpsSurpriseFetcherSchema]):
    fetcher_name = 'EpsSurpriseFetcher'
    domain = 'general'
    schema = EpsSurpriseFetcherSchema
    min_interval_sec = 0.5


import argparse
import sys

from db_compat import connect, translate, use_postgres, read_df, executemany
from fetch_utils import retry_get

try:
    from curl_cffi import requests as cffi_req
except ImportError:
    cffi_req = None

# ── Constants ─────────────────────────────────────────────────────────────────

BULK_URL  = "https://api.moneycontrol.com/mcapi/v1/earnings/actual-estimate?page=1&limit=30000"
# NOTE: there is deliberately no per-stock URL here. MC's actual-estimate endpoint is list-only
# (see enrich_from_history) — every per-stock query-string variant returns HTTP 422.

MC_HEADERS = {
    "accept": "application/json",
    "accept-language": "en-IN,en;q=0.9",
    "origin": "https://www.moneycontrol.com",
    "referer": "https://www.moneycontrol.com/",
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    ),
}

MAX_QUARTERS   = 8


# ── Schema ────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS eps_surprise_history (
            scid          TEXT NOT NULL,
            symbol        TEXT,
            quarter       TEXT NOT NULL,
            np_actual     REAL,
            np_estimate   REAL,
            np_surprise   REAL,
            rev_actual    REAL,
            rev_estimate  REAL,
            rev_surprise  REAL,
            eps_actual    REAL,
            eps_estimate  REAL,
            eps_surprise  REAL,
            fetched_at    TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (scid, quarter)
        )
    """))
    con.commit()

    new_cols = [
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_surprise_q1       REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_surprise_q2       REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_beat_streak       INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_miss_after_streak INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS rev_surprise_q1       REAL",
    ]
    for ddl in new_cols:
        try:
            cur.execute(translate(ddl))
            con.commit()
        except Exception:
            try:
                con.rollback()
            except Exception:
                pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_float(val) -> float | None:
    if val is None or val == "--":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def _compute_features(rows: list[dict]) -> dict:
    """rows must be newest-first, already filtered to those with a valid quarter."""
    def _np_surp(idx):
        return rows[idx].get("np_surprise") if idx < len(rows) else None

    eps_q1 = _np_surp(0)
    eps_q2 = _np_surp(1)
    rev_q1 = rows[0].get("rev_surprise") if rows else None

    streak = 0
    for row in rows[:MAX_QUARTERS]:
        s = row.get("np_surprise")
        if s is not None and s > 0:
            streak += 1
        else:
            break

    miss_after = 0
    if (
        eps_q1 is not None and eps_q1 <= 0
        and len(rows) >= 4
        and all(
            rows[i].get("np_surprise") is not None and rows[i].get("np_surprise", 0) > 0
            for i in range(1, 4)
        )
    ):
        miss_after = 1

    return {
        "eps_surprise_q1":       eps_q1,
        "eps_surprise_q2":       eps_q2,
        "eps_beat_streak":       streak,
        "eps_miss_after_streak": miss_after,
        "rev_surprise_q1":       rev_q1,
    }


# ── Pass 1: Bulk endpoint ─────────────────────────────────────────────────────

def fetch_bulk(mc_to_symbol: dict[str, str]) -> tuple[dict[str, dict], list[tuple]]:
    """Fetch the bulk earnings page. Returns:
      - features_by_symbol: {nse_symbol: feature_dict}   (q1 only)
      - history_rows: list of tuples for eps_surprise_history upsert
    """
    if cffi_req is None:
        raise ImportError("curl_cffi is required: pip install curl-cffi")

    try:
        r = retry_get(cffi_req, BULK_URL, headers=MC_HEADERS, impersonate="chrome110", timeout=30)
    except Exception as e:
        print(f"[EPSSurprise] Bulk endpoint fetch failed after retries: {e}", file=sys.stderr)
        return {}, []
    try:
        rows = r.json()["data"]["list"]
    except (ValueError, KeyError, TypeError) as e:
        print(f"[EPSSurprise] Bulk endpoint returned no usable data (status={r.status_code}): {e}", file=sys.stderr)
        return {}, []

    features_by_symbol: dict[str, dict] = {}
    history_rows: list[tuple] = []

    for row in rows:
        scid    = row[0]        # = mcsymbol
        quarter = row[5]        # meeting date as quarter label (e.g. "May 30, 2026")
        surp_pct = _safe_float(row[8])
        qdata   = row[9]        # [['Revenue', actual, est], ['Net Profit', actual, est], ['EPS', actual, est]]

        symbol = mc_to_symbol.get(scid)
        if not symbol:
            continue

        # Parse quarterData array
        rev_a = rev_e = rev_s = None
        np_a  = np_e  = np_s  = None
        eps_a = eps_e = eps_s = None
        for block in (qdata or []):
            if not isinstance(block, (list, tuple)) or len(block) < 3:
                continue
            label  = str(block[0]).lower()
            actual = _safe_float(block[1])
            est    = _safe_float(block[2])
            diff   = (actual - est) / abs(est) * 100 if (actual is not None and est and est != 0) else None
            if "revenue" in label or "sales" in label:
                rev_a, rev_e, rev_s = actual, est, diff
            elif "profit" in label or "np" in label:
                np_a, np_e, np_s = actual, est, diff
            elif "eps" in label:
                eps_a, eps_e, eps_s = actual, est, diff

        # Use API-provided surprise % as primary; computed as fallback
        np_surprise = surp_pct if surp_pct is not None else np_s

        history_rows.append((
            scid, symbol, quarter,
            np_a, np_e, np_surprise,
            rev_a, rev_e, rev_s,
            eps_a, eps_e, eps_s,
        ))

        features_by_symbol[symbol] = _compute_features([{
            "quarter":     quarter,
            "np_surprise": np_surprise,
            "rev_surprise": rev_s,
        }])

    return features_by_symbol, history_rows


# ── Pass 2: q2 + beat streak from accumulated history ────────────────────────
#
# This used to call a per-stock MC endpoint once per resolved symbol. That endpoint does not
# exist: live-probed 2026-07-31, `...actual-estimate?scId=RI&type=Q&subType=yoy` returns HTTP
# 422 `{"success":0,"data":"\"scId\" is not allowed"}` — scId/sc_id/scid/id/symbol are ALL
# rejected as parameters, and `type` only accepts [all, std, con]. So the endpoint is
# list-only; there is no per-stock variant to fix the query string to. Every one of the ~500
# calls 422'd, each one retried by retry_get, which burned the job's whole 600s budget and
# killed it by timeout on every run (132 `HTTP Error 422` lines per run in pm2-err.log).
#
# The replacement needs no network at all: the bulk pass already upserts one row per
# (scid, quarter) into eps_surprise_history on every run, so the quarter-over-quarter history
# this pass wanted is accumulating in our own table. Read it back instead.

_MONTHS = {m: i for i, m in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}


def _quarter_sort_key(quarter: str) -> tuple:
    """MC's `quarter` is a results-announcement date ('May 30, 2026'), not a quarter label,
    so it does NOT sort correctly as text. Parse to (y, m, d); unparseable sorts oldest."""
    try:
        mon, rest = quarter.split(" ", 1)
        day, year = rest.split(",", 1)
        return (int(year.strip()), _MONTHS[mon.strip()[:3].title()], int(day.strip()))
    except (ValueError, KeyError, AttributeError):
        return (0, 0, 0)



def enrich_from_history(bulk_features: dict[str, dict],
                        symbol_filter: str | None,
                        limit: int | None) -> tuple[dict[str, dict], list[tuple]]:
    """Derive q2 + beat streak from eps_surprise_history (written by the bulk pass).

    Returns the same (features, history_rows) shape the old network pass did; history_rows is
    always empty because this pass is now a pure read — it adds no new quarters, it only reads
    back the ones the bulk pass already persisted.
    """
    symbols = list(bulk_features.keys())
    if symbol_filter:
        symbols = [s for s in symbols if s.upper() == symbol_filter.upper()]
    if limit:
        symbols = symbols[:limit]
    if not symbols:
        return bulk_features, []

    ph = ",".join("?" for _ in symbols)
    hist = read_df(
        translate(
            f"SELECT symbol, quarter, np_surprise, rev_surprise "
            f"FROM eps_surprise_history WHERE symbol IN ({ph})"
        ),
        params=symbols,
    )
    if hist.empty:
        return bulk_features, []

    by_symbol: dict[str, list[dict]] = {}
    for row in hist.to_dict("records"):
        if row.get("quarter"):
            by_symbol.setdefault(row["symbol"], []).append(row)

    enriched = 0
    for symbol, rows in by_symbol.items():
        # newest-first — _compute_features documents that contract
        rows.sort(key=lambda r: _quarter_sort_key(r["quarter"]), reverse=True)
        if len(rows) < 2:
            continue  # nothing the bulk pass's own q1 didn't already give us
        feats = _compute_features([
            {"quarter": r["quarter"],
             "np_surprise": _safe_float(r.get("np_surprise")),
             "rev_surprise": _safe_float(r.get("rev_surprise"))}
            for r in rows[:MAX_QUARTERS]
        ])
        existing = bulk_features.get(symbol, {})
        # Keep the bulk pass's q1/rev_q1: those come straight from MC's own surprise % field,
        # which is more authoritative than anything recomputed off stored actual-vs-estimate.
        bulk_features[symbol] = {
            **existing,
            **feats,
            "eps_surprise_q1": existing.get("eps_surprise_q1") or feats["eps_surprise_q1"],
            "rev_surprise_q1": existing.get("rev_surprise_q1") or feats["rev_surprise_q1"],
        }
        enriched += 1

    print(f"[EPSSurprise]   History: {enriched} symbols enriched with q2/streak "
          f"from {len(hist)} stored quarters")
    return bulk_features, []


# ── DB writes ─────────────────────────────────────────────────────────────────

_UPSERT_HISTORY = """
INSERT INTO eps_surprise_history
    (scid, symbol, quarter, np_actual, np_estimate, np_surprise,
     rev_actual, rev_estimate, rev_surprise,
     eps_actual, eps_estimate, eps_surprise)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (scid, quarter) DO UPDATE SET
    symbol        = excluded.symbol,
    np_actual     = COALESCE(excluded.np_actual,   eps_surprise_history.np_actual),
    np_estimate   = COALESCE(excluded.np_estimate, eps_surprise_history.np_estimate),
    np_surprise   = COALESCE(excluded.np_surprise, eps_surprise_history.np_surprise),
    rev_actual    = COALESCE(excluded.rev_actual,  eps_surprise_history.rev_actual),
    rev_estimate  = COALESCE(excluded.rev_estimate,eps_surprise_history.rev_estimate),
    rev_surprise  = COALESCE(excluded.rev_surprise,eps_surprise_history.rev_surprise),
    eps_actual    = COALESCE(excluded.eps_actual,  eps_surprise_history.eps_actual),
    eps_estimate  = COALESCE(excluded.eps_estimate,eps_surprise_history.eps_estimate),
    eps_surprise  = COALESCE(excluded.eps_surprise,eps_surprise_history.eps_surprise),
    fetched_at    = CURRENT_TIMESTAMP
"""


def _write_history(history_rows: list[tuple]) -> None:
    if history_rows:
        executemany(translate(_UPSERT_HISTORY), history_rows)


def _write_technical_signals(con, features_by_symbol: dict[str, dict]) -> int:
    """Patch most-recent ts row per symbol."""
    if not features_by_symbol:
        return 0

    symbols = list(features_by_symbol.keys())
    # Build placeholders for IN clause
    ph = ",".join(["?" for _ in symbols])
    latest_df = read_df(
        translate(f"SELECT symbol, MAX(date) AS date FROM technical_signals WHERE symbol IN ({ph}) GROUP BY symbol"),
        params=symbols,
    )
    if latest_df.empty:
        return 0

    latest_map = dict(zip(latest_df["symbol"], latest_df["date"]))

    update_sql = translate("""
        UPDATE technical_signals
        SET eps_surprise_q1       = COALESCE(?, eps_surprise_q1),
            eps_surprise_q2       = COALESCE(?, eps_surprise_q2),
            eps_beat_streak       = COALESCE(?, eps_beat_streak),
            eps_miss_after_streak = COALESCE(?, eps_miss_after_streak),
            rev_surprise_q1       = COALESCE(?, rev_surprise_q1)
        WHERE symbol = ? AND date = ?
    """)

    rows = []
    for symbol, feats in features_by_symbol.items():
        date = latest_map.get(symbol)
        if not date:
            continue
        rows.append((
            feats.get("eps_surprise_q1"),
            feats.get("eps_surprise_q2"),
            feats.get("eps_beat_streak"),
            feats.get("eps_miss_after_streak"),
            feats.get("rev_surprise_q1"),
            symbol,
            date,
        ))

    if rows:
        executemany(update_sql, rows)
    return len(rows)


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="MC EPS Surprise Fetcher — bulk + per-stock quarterly beat-streak features"
    )
    parser.add_argument("--symbol",    type=str,  default=None, help="Single NSE symbol (e.g. INFY)")
    parser.add_argument("--limit",     type=int,  default=None, help="Process first N resolved stocks")
    parser.add_argument("--bulk-only", action="store_true",     help="Skip per-stock pass (fast, q1 only)")
    args = parser.parse_args()

    if cffi_req is None:
        print("[EPSSurprise] curl_cffi not installed. Run: pip install curl-cffi", file=sys.stderr)
        sys.exit(1)

    con = connect()
    ensure_schema(con)

    # Build mcsymbol → NSE symbol map
    mc_map_rows = con.execute(
        "SELECT symbol, mcsymbol FROM nse_stocks WHERE mcsymbol IS NOT NULL AND mcsymbol != ''"
    ).fetchall()
    mc_to_symbol = {row["mcsymbol"]: row["symbol"] for row in mc_map_rows}

    # Pass 1: bulk
    print("[EPSSurprise] Pass 1 — fetching bulk earnings from MC...")
    features, hist1 = fetch_bulk(mc_to_symbol)
    _write_history(hist1)
    print(f"[EPSSurprise]   Bulk: {len(features)} stocks resolved, {len(hist1)} history rows written")

    if args.symbol:
        features = {k: v for k, v in features.items() if k.upper() == args.symbol.upper()}

    # Pass 2: q2 + streak, read back from the history the bulk pass just wrote
    if not args.bulk_only:
        print("[EPSSurprise] Pass 2 — q2 + beat streak from stored history...")
        features, _ = enrich_from_history(features, args.symbol, args.limit)

    # Patch technical_signals
    ts_updated = _write_technical_signals(con, features)
    print(f"[EPSSurprise] Done. {ts_updated} technical_signals rows updated.")
    con.close()


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
