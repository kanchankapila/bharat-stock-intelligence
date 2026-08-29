"""
Equal-weight cross-sectional composite of the RAW engine outputs
================================================================

Persists the composite measured on 2026-08-21 so it ACCUMULATES and can be graded by the
normal harness (`factor_edge.py --table engine_composite_scores --scores composite`) and,
once ~12 months exist, by the cost-aware one.

Why this exists, and what it is NOT:

  Graded by the SHIPPED harness (`factor_edge.py --table engine_composite_scores`), which is
  the read that counts -- 82,402 rows / 66 dates, span 2026-05-23..08-21:

      composite   1d IC +0.044 AUC 0.511 | 5d +0.083 / 0.526 | 21d +0.077 / 0.540 -> no edge
      unified_score (live canonical)                         | 21d +0.023 / 0.516 -> no edge

  ⚠ An earlier docstring here claimed "the first cross-sectional score to clear USABLE
  (21d AUC 0.558)". THAT IS RETRACTED -- see measurement.md's "CORRECTION, same day" section.
  It came from a one-off script over a slightly different matched universe starting a week
  later; re-run through the shipped harness on MORE dates the IC reproduced exactly (+0.077 at
  21d) but the AUC did not (0.540 on 30 dates vs 0.558 on 25), landing below the 0.55 bar. The
  lesson is the reason that correction exists: a result computed in a one-off script must be
  re-run through the shipped harness before it is written down as a verdict.

  What survives is still the strongest cross-sectional result on this platform: 5d rank IC
  +0.083 over 46 dates, ~7x unified_score's +0.012 and above every individual engine. The
  ensemble effect is real (pairwise Spearman between the six engines maxes at 0.293, most
  under 0.1); what it does not do is clear the classification bar.

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
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
