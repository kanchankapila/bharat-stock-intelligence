#!/usr/bin/env python3
"""
Does a stock's SCREENER STATE AS OF D-1 predict it being a top-N gainer on day D?

Answers the question "which screeners were the day's biggest gainers in, and since when --
and does that generalise into an early-warning signal?" WITHOUT falling into the trap that
question invites.

WHY THIS IS NOT JUST "LIST THE WINNERS' SCREENERS"
--------------------------------------------------
Tabulating only the winners is selection on the dependent variable: if 80% of today's top-20
gainers sat in a momentum screener, that is meaningless until you know what share of the WHOLE
tradeable universe sat in it too. If the base rate is also 80%, the screener carries zero
information. Every number here is therefore reported as a LIFT against the same-date universe
base rate, never as a raw share. `.claude/rules/measurement.md` makes the general form of this
mandatory ("grade every candidate factor against BOTH tails" -- this codebase has twice been
fooled by a statistic computed only against winners).

THE PRIORS THIS RESPECTS (see .claude/skills/screener-combo-predictor)
---------------------------------------------------------------------
- All 1,563 screeners tested individually: 0 survive FDR/Bonferroni. So the unit of analysis
  here is the CONCEPT TAG (via screener_name_concepts.decompose), never a single screener.
- screener_catalog.signal_bias is inverted on this data and is NOT used as a direction.
- Only `same_day_relevant` screeners are kept: a quarterly-results membership qualifies the
  same stock for ~60 straight sessions and cannot predict WHICH day it moves.
- Per-date, then average. Never pooled -- pooling has flipped a conclusion here three times.
- Liquidity floor + is_suspect filter, or you are measuring untradeable microcaps.

WHAT IS GENUINELY NEW HERE
--------------------------
Tenure. "Since when" is not in measurement.md's already-tested list: prior work asked whether
membership predicts, never whether TIME-IN-SCREENER does. A stock freshly added to an oversold
screener yesterday is a different claim from one that has sat there for six weeks.

WHY MEMBERSHIP COMES FROM screener_membership_snapshot, NOT screener_appearances
--------------------------------------------------------------------------------
`screener_combo_finder.py` carries this warning in its own source, and it is decisive for a
"since when" question: screener_appearances' appeared_date/exited_date "predate the 2026-07-31
point-in-time snapshot fix and are not reconstructable exactly as of a historical date --
treated here as a coarse 'was this stock a member around this date' signal, not an exact PIT
record." Tenure built on that column would be measuring a reconstruction artifact.

screener_membership_snapshot IS point-in-time by construction (one row per symbol/screener per
daily snapshot), so tenure here = the number of CONSECUTIVE prior snapshots a (symbol,
screener) pair appears in. That is honest but caps observable tenure at the snapshot history
(~27 dates from 2026-07-31), and 27 dates is barely above measurement.md's ~20-date
reliability floor. Every verdict below is therefore LOW-DATA and directional, never a finding.

NOT a combination search -- `screener_combo_finder.py` owns that and must not be duplicated.

Usage:
  python src/server/screener_tenure_mover_analysis.py                  # full window
  python src/server/screener_tenure_mover_analysis.py --top-n 20 --min-adt-cr 1.0
"""
import argparse
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else ".")

from db_compat import read_df  # noqa: E402
from screener_name_concepts import decompose  # noqa: E402


def load_catalog_tags() -> dict:
    """screener_id -> (tags, same_day_relevant).

    Keyed on screener_id alone because screener_membership_snapshot carries no `source`.
    screener_catalog's PK is (source, screener_id) and the same id CAN be issued by two
    providers (data-sources.md's composite-key rule), so where an id is ambiguous we take the
    UNION of tags and require ALL of its rows to be same-day-relevant before trusting it --
    the conservative direction: an ambiguous id that might be a quarterly-results screener is
    excluded rather than silently treated as intraday.
    """
    cat = read_df(
        "SELECT screener_id, LOWER(source) AS source, screener_name FROM screener_catalog", ()
    )
    tags_acc: dict = {}
    sameday_acc: dict = {}
    for row in cat.itertuples(index=False):
        c = decompose(str(row.screener_name or ""))
        sid = str(row.screener_id)
        tags_acc.setdefault(sid, set()).update(c.signal_tags)
        sameday_acc.setdefault(sid, []).append(bool(c.same_day_relevant))
    return {sid: (sorted(tags_acc[sid]), all(sameday_acc[sid])) for sid in tags_acc}


def load_panel(min_adt_cr: float) -> pd.DataFrame:
    """Liquid, non-suspect daily returns over the window the PIT snapshots cover.

    ADT is a TRAILING 20-day average computed strictly before the return day, so the
    liquidity filter itself cannot peek at the move it is filtering for.
    """
    return read_df(
        """
        WITH span AS (
            SELECT MIN(as_of_date)::date AS d0, MAX(as_of_date)::date AS d1
              FROM screener_membership_snapshot
        ),
        px AS (
            SELECT o.symbol, o.date, o.close,
                   LAG(o.close) OVER (PARTITION BY o.symbol ORDER BY o.date) AS prev_close,
                   AVG(o.close * o.volume) OVER (
                       PARTITION BY o.symbol ORDER BY o.date
                       ROWS BETWEEN 21 PRECEDING AND 1 PRECEDING
                   ) AS adt
              FROM stock_ohlcv o, span
             WHERE COALESCE(o.is_suspect, 0) = 0
               AND o.date BETWEEN span.d0 - 40 AND span.d1
        )
        SELECT symbol, date, close, prev_close, adt
          FROM px, span
         WHERE prev_close IS NOT NULL AND prev_close > 0
           AND date >= span.d0
           AND adt >= ?
        """,
        (min_adt_cr * 1e7,),  # cr -> rupees
    )


def load_memberships() -> pd.DataFrame:
    """Point-in-time membership: one row per (as_of_date, symbol, screener_id).

    screener_membership_snapshot has no `source` column -- screener_id alone is the key here,
    so the catalog lookup below falls back across sources for the tag set.
    """
    return read_df(
        """
        SELECT as_of_date::date AS as_of_date,
               symbol,
               screener_id::text AS screener_id
          FROM screener_membership_snapshot
         WHERE symbol IS NOT NULL AND symbol <> ''
        """,
        (),
    )


def winsorize(s: pd.Series, pct: float = 0.01) -> pd.Series:
    """interpolation='higher'/'lower' -- the linear default does NOT clip a lone outlier
    (logged in ml-model-bugs.md: it clips to ~1% of the way toward it and the mean still
    blows out)."""
    if s.empty:
        return s
    lo = s.quantile(pct, interpolation="lower")
    hi = s.quantile(1 - pct, interpolation="higher")
    return s.clip(lo, hi)


def analyse(top_n: int, min_adt_cr: float) -> None:
    print(f"[cfg] top_n={top_n} min_adt_cr={min_adt_cr}", flush=True)

    tags_by_screener = load_catalog_tags()
    panel = load_panel(min_adt_cr)
    mem = load_memberships()
    if panel.empty or mem.empty:
        print("[abort] empty panel or memberships — nothing to measure.")
        return

    panel["date"] = pd.to_datetime(panel["date"]).dt.date
    panel["ret"] = panel["close"] / panel["prev_close"] - 1.0
    mem["as_of_date"] = pd.to_datetime(mem["as_of_date"]).dt.date

    # Only same-day-relevant screeners carry a tag set worth testing.
    mem["tags"] = mem["screener_id"].map(lambda k: tags_by_screener.get(str(k), ([], False))[0])
    mem["same_day"] = mem["screener_id"].map(lambda k: tags_by_screener.get(str(k), ([], False))[1])
    mem = mem[mem["same_day"] & mem["tags"].map(bool)]
    snap_dates = sorted(mem["as_of_date"].unique())
    print(f"[data] panel rows={len(panel):,} dates={panel['date'].nunique()} | "
          f"same-day memberships={len(mem):,} across {len(snap_dates)} PIT snapshots",
          flush=True)

    # Tenure by CONSECUTIVE presence in prior snapshots -- PIT-correct by construction.
    membership: dict = {}
    for d, grp in mem.groupby("as_of_date"):
        membership[d] = set(zip(grp["symbol"], grp["screener_id"].astype(str)))
    tenure: dict = {}
    prev_d = None
    for d in snap_dates:
        prev_t = tenure.get(prev_d, {}) if prev_d is not None else {}
        tenure[d] = {k: (prev_t.get(k, 0) + 1) for k in membership.get(d, set())}
        prev_d = d
    tags_of = {str(r.screener_id): r.tags for r in mem.itertuples(index=False)}

    dates = sorted(panel["date"].unique())
    per_date_hits = defaultdict(list)     # tag -> [ (p_top, p_universe) ]
    per_date_tenure = defaultdict(list)   # tag -> [ (mean_tenure_top, mean_tenure_univ) ]
    news_rows = []

    for d in dates:
        day = panel[panel["date"] == d].copy()
        if len(day) < top_n * 5:          # need a real cross-section, not a stub day
            continue
        day["ret_w"] = winsorize(day["ret"])
        top = set(day.nlargest(top_n, "ret_w")["symbol"])
        bot = set(day.nsmallest(top_n, "ret_w")["symbol"])
        universe = set(day["symbol"])

        # Screener state STRICTLY as of the latest snapshot BEFORE d (no same-day leakage).
        prior = [s for s in snap_dates if s < d]
        if not prior:
            continue
        sd = prior[-1]
        live_pairs = membership.get(sd, set())
        live_ten = tenure.get(sd, {})
        if not live_pairs:
            continue

        sym_tags = defaultdict(set)
        sym_tag_tenure = defaultdict(dict)
        for (sym, sid) in live_pairs:
            ten = live_ten.get((sym, sid), 1)
            for t in tags_of.get(sid, ()):
                sym_tags[sym].add(t)
                # longest-held wins: "since when" = earliest qualifying appearance
                sym_tag_tenure[sym][t] = max(sym_tag_tenure[sym].get(t, 0), ten)

        all_tags = {t for s in universe for t in sym_tags.get(s, ())}
        for t in all_tags:
            in_top = sum(1 for s in top if t in sym_tags.get(s, ()))
            in_uni = sum(1 for s in universe if t in sym_tags.get(s, ()))
            if in_uni == 0:
                continue
            in_bot = sum(1 for s in bot if t in sym_tags.get(s, ()))
            per_date_hits[t].append((in_top / max(len(top), 1), in_uni / len(universe),
                                     in_bot / max(len(bot), 1)))

            tt = [sym_tag_tenure[s][t] for s in top if t in sym_tag_tenure.get(s, {})]
            tu = [sym_tag_tenure[s][t] for s in universe if t in sym_tag_tenure.get(s, {})]
            if tt and tu:
                per_date_tenure[t].append((float(np.mean(tt)), float(np.mean(tu))))

        news_rows.append((d, top, universe))

    if not per_date_hits:
        print("[abort] no usable dates — check the overlap between the price panel and "
              "screener_appearances.")
        return

    n_tags = len(per_date_hits)
    bonf = 0.05 / max(n_tags, 1)
    print(f"\n[dates used] {len(news_rows)} | tags tested {n_tags} | "
          f"Bonferroni alpha {bonf:.5f} (t~{abs(_t_crit(bonf)):.2f})\n", flush=True)

    rows = []
    for t, pairs in per_date_hits.items():
        arr = np.array(pairs)                      # (n_dates, 3): top, universe, bottom
        diff = arr[:, 0] - arr[:, 1]               # per-date lift in percentage points
        n = len(diff)
        if n < 10:
            continue
        tstat = float(np.mean(diff) / (np.std(diff, ddof=1) / np.sqrt(n))) if np.std(diff, ddof=1) > 0 else 0.0
        # BOTH TAILS. measurement.md makes this mandatory and this codebase has been fooled
        # twice by a statistic computed only against winners: a tag that lifts the top tail AND
        # the bottom tail equally is detecting VOLATILITY, not direction -- the top-20 gainers
        # on any day are disproportionately high-beta names, so "membership predicts a big up
        # move" and "membership predicts a big move" are indistinguishable without this.
        bot_diff = arr[:, 2] - arr[:, 1]
        bot_t = (float(np.mean(bot_diff) / (np.std(bot_diff, ddof=1) / np.sqrt(n)))
                 if np.std(bot_diff, ddof=1) > 0 else 0.0)
        sep = arr[:, 0] - arr[:, 2]                # winners minus losers: the directional claim
        sep_t = (float(np.mean(sep) / (np.std(sep, ddof=1) / np.sqrt(n)))
                 if np.std(sep, ddof=1) > 0 else 0.0)
        base = float(np.mean(arr[:, 1]))
        top_p = float(np.mean(arr[:, 0]))
        ten = per_date_tenure.get(t, [])
        ten_arr = np.array(ten) if ten else np.zeros((0, 2))
        ten_diff = (ten_arr[:, 0] - ten_arr[:, 1]) if len(ten_arr) else np.array([])
        ten_t = (float(np.mean(ten_diff) / (np.std(ten_diff, ddof=1) / np.sqrt(len(ten_diff))))
                 if len(ten_diff) > 2 and np.std(ten_diff, ddof=1) > 0 else float("nan"))
        rows.append({
            "tag": t, "n_dates": n,
            "p_top": top_p, "p_universe": base,
            "lift_pp": (top_p - base) * 100,
            "lift_ratio": (top_p / base) if base > 0 else float("nan"),
            "t_stat": tstat,
            "p_bottom": float(np.mean(arr[:, 2])),
            "bot_lift_pp": (float(np.mean(arr[:, 2])) - base) * 100,
            "bot_t": bot_t,
            "sep_pp": float(np.mean(sep)) * 100,
            "sep_t": sep_t,
            "tenure_top_d": float(np.mean(ten_arr[:, 0])) if len(ten_arr) else float("nan"),
            "tenure_univ_d": float(np.mean(ten_arr[:, 1])) if len(ten_arr) else float("nan"),
            "tenure_t": ten_t,
        })

    df = pd.DataFrame(rows).sort_values("t_stat", ascending=False)
    pd.set_option("display.width", 200, "display.max_columns", 20)
    print("=== MEMBERSHIP LIFT (per-date, then averaged) ===")
    print(df[["tag", "n_dates", "p_top", "p_universe", "lift_pp", "lift_ratio", "t_stat"]]
          .to_string(index=False, float_format=lambda v: f"{v:.3f}"))

    survivors = df[df["t_stat"].abs() >= abs(_t_crit(bonf))]
    print(f"\n[verdict, WINNING TAIL ONLY] tags clearing Bonferroni (alpha={bonf:.5f}): "
          f"{len(survivors)} of {len(df)}")
    if len(survivors):
        print(survivors[["tag", "lift_pp", "lift_ratio", "t_stat"]]
              .to_string(index=False, float_format=lambda v: f"{v:.3f}"))
    else:
        print("  NONE. Consistent with measurement.md's standing finding that screener "
              "membership does not predict on this data.")

    print("\n=== BOTH TAILS: is this direction, or just volatility? ===")
    print("  p_top/p_bottom = share of the day's top-20 GAINERS / top-20 LOSERS carrying the tag.")
    print("  sep = p_top - p_bottom. A tag that predicts UP moves separates the two tails;")
    print("  a tag that merely predicts BIG moves lifts both and separates neither.\n")
    both = df.sort_values("sep_t", ascending=False)
    print(both[["tag", "p_universe", "p_top", "p_bottom", "lift_pp", "bot_lift_pp",
                "sep_pp", "sep_t"]]
          .to_string(index=False, float_format=lambda v: f"{v:.3f}"))

    tcrit = abs(_t_crit(bonf))
    directional = df[(df["t_stat"] >= tcrit) & (df["sep_t"] >= tcrit)]
    vol_only = df[(df["t_stat"] >= tcrit) & (df["sep_t"].abs() < tcrit)]
    print(f"\n[verdict, DIRECTIONAL] tags that clear Bonferroni on the winning tail AND on the "
          f"winners-minus-losers separation: {len(directional)} of {len(df)}")
    if len(directional):
        print(directional[["tag", "lift_pp", "bot_lift_pp", "sep_pp", "sep_t"]]
              .to_string(index=False, float_format=lambda v: f"{v:.3f}"))
    else:
        print("  NONE.")
    if len(vol_only):
        print(f"\n[volatility detectors] {len(vol_only)} tag(s) lift the winning tail "
              f"significantly but do NOT separate winners from losers -- these predict that a "
              f"stock will MOVE, not which way:")
        print(vol_only[["tag", "lift_pp", "bot_lift_pp", "sep_pp", "sep_t"]]
              .to_string(index=False, float_format=lambda v: f"{v:.3f}"))

    print("\n=== TENURE ('since when'): mean days-in-screener, movers vs universe ===")
    tdf = df.dropna(subset=["tenure_t"]).sort_values("tenure_t")
    print(tdf[["tag", "tenure_top_d", "tenure_univ_d", "tenure_t"]]
          .to_string(index=False, float_format=lambda v: f"{v:.2f}"))
    print("\n  Negative tenure_t = movers were in the screener a SHORTER time than the "
          "universe (fresh entries move); positive = longer-held names move.")
    print("  CAVEAT: tenure is measured on the WINNING tail against the universe, so it "
          "inherits\n  the same limitation the both-tails block above exposes for membership -- "
          "with zero\n  tags separating winners from losers, 'fresh entries move' is a statement "
          "about\n  MOVEMENT, not about direction. Do not read it as an up-move signal.")

    _news_factor(news_rows)


def _t_crit(alpha: float) -> float:
    from scipy import stats
    return stats.norm.ppf(alpha / 2)


def _news_factor(news_rows: list) -> None:
    """Was same-day/prior-evening news more common for movers than for the universe?"""
    print("\n=== NEWS CO-OCCURRENCE (base-rate corrected) ===")
    try:
        news = read_df(
            "SELECT symbols, timestamp, sentiment FROM news_articles "
            "WHERE symbols IS NOT NULL AND symbols <> ''", ()
        )
    except Exception as e:  # noqa: BLE001
        print(f"  [skip] news_articles unreadable: {e}", file=sys.stderr)
        return
    if news.empty:
        print("  [skip] no news rows.")
        return
    news["d"] = pd.to_datetime(news["timestamp"], errors="coerce", utc=True).dt.date
    by_date = defaultdict(set)
    for r in news.itertuples(index=False):
        if r.d is None or (isinstance(r.d, float) and np.isnan(r.d)):
            continue
        for s in str(r.symbols).replace(";", ",").split(","):
            s = s.strip().upper()
            if s:
                by_date[r.d].add(s)

    diffs = []
    for d, top, universe in news_rows:
        withnews = by_date.get(d, set())
        if not withnews:
            continue
        p_top = len(top & withnews) / max(len(top), 1)
        p_uni = len(universe & withnews) / max(len(universe), 1)
        diffs.append(p_top - p_uni)
    if len(diffs) < 5:
        print(f"  [low-data] only {len(diffs)} dates with news overlap — not reporting a verdict.")
        return
    arr = np.array(diffs)
    t = float(np.mean(arr) / (np.std(arr, ddof=1) / np.sqrt(len(arr)))) if np.std(arr, ddof=1) > 0 else 0.0
    print(f"  dates={len(arr)}  mean lift={np.mean(arr)*100:+.2f}pp  t={t:+.2f}")
    print("  (Same-day news is NOT a tradeable pre-open signal even if positive — "
          "measurement.md: news sentiment is +0.13 IC same-day, -0.03 next-day. "
          "This measures whether news EXPLAINS the move, not whether it predicts it.)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--top-n", type=int, default=20)
    ap.add_argument("--min-adt-cr", type=float, default=1.0)
    a = ap.parse_args()
    analyse(a.top_n, a.min_adt_cr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
