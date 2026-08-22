"""
Equal-weight cross-sectional composite of the RAW engine outputs
================================================================

Persists the composite measured on 2026-08-21 so it ACCUMULATES and can be graded by the
normal harness (`factor_edge.py --table engine_composite_scores --scores composite`) and,
once ~12 months exist, by the cost-aware one.

Why this exists, and what it is NOT:

  Measured (equal weights, no fitting, per-date cross-sectional rank z-score, graded with
  factor_edge.py's own _metrics), lagged one session so the entry is one a pre-market run
  could actually take:

      composite   1d IC +0.014 AUC 0.514 | 5d +0.046 / 0.538 | 21d +0.077 / 0.558  -> USABLE
      unified_score (live canonical)                          | 21d +0.023 / 0.516  -> no edge

  It is the first cross-sectional score on this platform to clear USABLE (|IC|>=0.03 AND
  AUC>=0.55 at >=20 dates), and it beats every one of its own components -- win_probability
  has a higher IC (+0.113) but fails on AUC (0.544). That is a real ensemble effect: pairwise
  Spearman between the six engines maxes at 0.293, most under 0.1.

  ⚠ It is NOT a validated tradeable edge and is deliberately NOT wired into unified_ranker.py.
  One-way turnover is 91% per 21d rebalance (3.3%/yr drag @15bps, 5.5% @25bps) and only 2-3
  NON-overlapping 21d periods exist, so no cost-aware verdict is possible yet -- the same
  calendar wall win_probability and earnings_beat_yoy hit. The 21d IC above is on OVERLAPPING
  windows and its observations are autocorrelated. See measurement.md.

  EQUAL weights on purpose. Weighting by measured IC on the panel used to score it is the
  in-sample trap; equal weights involve no fitting at all, which is why the result is
  believable at this sample size.

Run:  python engine_composite.py            # today's logical session
      python engine_composite.py --days 90  # backfill
"""

import argparse
import datetime
import logging

import pandas as pd

from as_of import logical_trading_date
from db_compat import execute, executemany, read_df

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# The six raw engine outputs. Sign convention: higher = more bullish, for every one of them,
# so an equal-weight mean is meaningful without per-engine sign flips.
ENGINES = ["win_probability", "cs_score", "signal_score", "breakout_probability",
           "prob_up_5d", "confluence_ns"]

# A row needs at least this many engines present before it gets a composite. Below it the mean
# is dominated by whichever one or two engines happened to be populated, which is a different
# (and much noisier) quantity than the thing that was measured.
MIN_ENGINES = 3


def ensure_schema() -> None:
    execute("""
        CREATE TABLE IF NOT EXISTS engine_composite_scores (
            symbol      TEXT NOT NULL,
            date        TEXT NOT NULL,
            composite   DOUBLE PRECISION,
            n_engines   INTEGER,
            computed_at TEXT NOT NULL,
            PRIMARY KEY (symbol, date)
        )
    """)


def load_panel(start: str) -> pd.DataFrame:
    """Raw engines joined on (symbol, date). Reads the RAW tables, deliberately not
    unified_recommendations' stored copies -- those are a session staler (a pre-market run can
    only see the previous completed scan), which measurably costs them IC."""
    ts = read_df(
        "SELECT symbol, date::date AS date, win_probability, cs_score, signal_score, "
        "breakout_probability FROM technical_signals WHERE date::date >= ?", (start,))
    dl = read_df(
        "SELECT symbol, prediction_date::date AS date, prob_up_5d "
        "FROM deep_learning_predictions WHERE prediction_date::date >= ?", (start,))
    # Earliest snapshot per (symbol, date): confluence_signals is a 30-min intraday table, and
    # taking anything but the first row of the day would use information the morning did not have.
    cf = read_df("""
        SELECT symbol, date, AVG(comp) AS confluence_ns FROM (
            SELECT symbol, computed_at::date AS date,
                   (trend_alignment_score + volume_score + sector_strength_score
                    + fundamental_score) AS comp,
                   ROW_NUMBER() OVER (PARTITION BY symbol, computed_at::date
                                      ORDER BY computed_at) rn
            FROM confluence_signals WHERE computed_at::date >= ?
        ) t WHERE rn = 1 GROUP BY symbol, date
    """, (start,))

    for d in (ts, dl, cf):
        if not d.empty:
            d["date"] = pd.to_datetime(d["date"])
    df = ts.merge(dl, on=["symbol", "date"], how="outer").merge(cf, on=["symbol", "date"], how="outer")
    for c in ENGINES:
        if c not in df.columns:
            df[c] = pd.NA
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def compute_composite(df: pd.DataFrame) -> pd.DataFrame:
    """Pure: panel -> (symbol, date, composite, n_engines). Split out so it is testable
    without a DB, and so the exact transform that was measured is the one that runs."""
    if df.empty:
        return df.assign(composite=[], n_engines=[])

    def rank_z(g):
        # Cross-sectional RANK z-score, not a raw z-score: raw means on this data are void
        # (a single +127,900% bar once produced an 850%-annualised phantom edge), and the six
        # engines are on wildly different scales.
        return (g.rank(pct=True) - 0.5) / 0.2887

    for c in ENGINES:
        df[f"z_{c}"] = df.groupby("date")[c].transform(rank_z)
    zcols = [f"z_{c}" for c in ENGINES]
    # mean() skips NaN, so a symbol missing one engine is averaged over the rest rather than
    # dragged toward 0 the way a fillna(0) sum would.
    df["composite"] = df[zcols].mean(axis=1)
    df["n_engines"] = df[zcols].notna().sum(axis=1)
    out = df[df["n_engines"] >= MIN_ENGINES].dropna(subset=["composite"])
    return out[["symbol", "date", "composite", "n_engines"]]


def write(rows: pd.DataFrame) -> int:
    if rows.empty:
        return 0
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload = [(r.symbol, r.date.strftime("%Y-%m-%d"), float(r.composite), int(r.n_engines), now)
               for r in rows.itertuples()]
    executemany("""
        INSERT INTO engine_composite_scores (symbol, date, composite, n_engines, computed_at)
        VALUES (?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
          composite=excluded.composite, n_engines=excluded.n_engines,
          computed_at=excluded.computed_at
    """, payload)
    return len(payload)


def run(days: int = 5) -> int:
    ensure_schema()
    start = (datetime.date.fromisoformat(logical_trading_date())
             - datetime.timedelta(days=days)).isoformat()
    panel = load_panel(start)
    log.info("panel: %d rows, %d dates", len(panel), panel["date"].nunique() if not panel.empty else 0)
    out = compute_composite(panel)
    n = write(out)
    log.info("wrote %d composite rows (%d dates)", n, out["date"].nunique() if not out.empty else 0)
    return n


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=5, help="lookback window to (re)compute")
    a = ap.parse_args()
    run(days=a.days)
