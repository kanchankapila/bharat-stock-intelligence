#!/usr/bin/env python3
"""
assembly_ablation.py — what does unified_ranker's POST-BLEND stack do to the blend?
===================================================================================

The open question in measurement.md: the six raw engines combined carry 5d rank IC +0.083
(`engine_composite_scores`), the live `unified_score` carries +0.012, and the blend-level A/B
(2026-08-22) could not answer why -- its own caveat #1 says reconstruction fidelity was 0.5665
because "quality_gate, RED_FLAG_VETO, HIGH_VOL_VETO and factor_crowding all multiply AFTER the
blend ... this graded the blend in isolation, not the final ranking."

This grades the stack itself, one layer at a time, on IDENTICAL rows.

Every multiplier in unified_ranker.run() is <= 1.0 AND SELECTIVE. A uniform multiplier cannot
reorder anything (that was the 2026-08-17 factor-crowding finding: a uniform x0.9 fired on 98.6%
of the universe, invisible to every rank diagnostic, and only mattered against ABSOLUTE
thresholds). A selective one reorders by construction. So each layer here can, in principle,
move rank IC -- and this measures whether it does.

Arms are CUMULATIVE, in the ranker's own application order (unified_ranker.py ~L2290-2330):

    blend            _blend over normalized engine maps          (the starting point)
    +quality         * quality_gate(piotroski_f, roe)            [feature_store]
    +redflag         * RED_FLAG_VETO_MULT   where red-flagged    [screener_appearances x catalog]
    +highvol         * HIGH_VOL_VETO_MULT   where hv >= p80      [technical_signals.hv_20d]
    stored           the persisted unified_score                 (ground truth, all layers)

NOT reconstructed: factor_crowding. Its inputs are quant_scores.mf_* and quant_scores has ONE
row per symbol with no history at all (2,424 rows / 2,424 symbols, checked live), so no
point-in-time value exists for any past date. It is also the smallest layer -- after the
2026-08-17 producer fix its prevalence fell 98.6% -> 4.8%. The gap between the `+highvol` arm
and `stored` therefore bounds crowding + the RL gate + the tradeable-universe restriction
together, and is reported rather than attributed.

Reuses unified_ranker's real _blend/_normalize_to_100/quality_gate/is_red_flagged/high_vol_cutoff
and factor_edge's real _forward_returns/_metrics/_verdict -- never a reimplementation, because a
test or measurement that mirrors the logic under test passes against the unfixed source
(recurring-bugs.md).

Run:  python assembly_ablation.py                 # print the table
      python assembly_ablation.py --persist       # also write to factor_edge_history
      python assembly_ablation.py --entry open    # panel-spec entry (see factor_edge --entry)
"""
import argparse
import sys

import pandas as pd

import engine_composite as ec
import factor_edge as fe
import unified_ranker as ur
from db_compat import connect, read_df

# engine_composite's raw column -> unified_ranker's engine key. screener and smart_money have
# no raw historical source and are absent from both arms, so this compares like with like.
RAW_TO_ENGINE = {
    'win_probability': 'ml', 'cs_score': 'cs', 'signal_score': 'technical',
    'breakout_probability': 'breakout', 'prob_up_5d': 'dl', 'confluence_ns': 'confluence',
}

# Cumulative arms, in the ranker's own order. Persisted under these table_names so each keeps
# its own row in factor_edge_history rather than colliding with the others or with the real
# `unified_recommendations` verdicts.
MIN_ADT_CR = 1.0   # measurement.md panel spec

ARMS = ['equal_weight', 'regime_weighted', 'rw+quality', 'rw+quality+redflag',
        'rw+quality+redflag+highvol', 'rw7+screener', 'rw7+smartmoney', 'rw8+gates',
        'stored_unified_score']

# The two engines with no raw historical table. They are read from unified_recommendations'
# stored columns ONLY for the `rw8+gates` arm, which exists to bisect the one step where the
# whole IC loss sits (last reconstructed arm -> stored). screener is the leading suspect:
# independently measured negative (IC -0.027, t=-2.36) and it is the engine the 2026-08-20
# weight re-derivation shrank. Its stored column is far less zero-contaminated than ml's
# (2-10% pre-fix vs 74%, and 0% from 2026-08-18), so unlike ml it is usable here -- but a
# stored 0 is still ambiguous pre-fix, so it is treated as MISSING rather than as a real
# bottom-rank score. See the zero-vs-NULL note in load_panel.
STORED_ONLY_ENGINES = {'screener_stock_score': 'screener', 'smart_money_score': 'smart_money'}


def load_panel(start):
    """RAW engine values (engine_composite's own loader) + the stored unified_score.

    Deliberately NOT unified_recommendations' stored *_score columns. Those carry the
    AF-20260818-31 artifact: 5 of 8 reporting columns wrote a literal 0.0, not NULL, for an
    engine that never scored a symbol. Measured live -- ml_score = 0 on 36,400 of 72,223 rows
    and dl_score = 0 on 100% of some dates -- and the guard only landed 2026-08-18, leaving 5
    usable dates. Feeding those zeros to _normalize_to_100 re-spreads a constant-zero engine
    across a full 0-100 rank, i.e. injects pure noise at a real weight. A first version of this
    script did exactly that and reported a NEGATIVE blend IC; the raw tables have 66 dates and
    no zero-vs-NULL ambiguity.

    screener and smart_money have no raw historical source, so BOTH the equal-weight and the
    regime-weighted arm are built from the same six engines -- like compared with like.
    """
    raw = ec.load_panel(start)
    for c in RAW_TO_ENGINE:
        if c in raw.columns:
            raw[c] = pd.to_numeric(raw[c], errors="coerce")
    extra = ", ".join(STORED_ONLY_ENGINES)
    ur_df = read_df(
        f"SELECT symbol, computed_at::date AS date, regime, unified_score, {extra} "
        f"FROM unified_recommendations WHERE computed_at::date >= ?", (start,))
    for c in STORED_ONLY_ENGINES:
        # A stored 0 is ambiguous before the 2026-08-18 has_data guard: it means either a real
        # bottom score or "this engine never scored this symbol". Treating it as a real 0 is
        # what made version 1 of this script report a negative IC. Treated as MISSING, so the
        # symbol simply blends over its other engines -- the conservative reading.
        ur_df[c] = pd.to_numeric(ur_df[c], errors="coerce").replace(0.0, float("nan"))
    ur_df["date"] = pd.to_datetime(ur_df["date"])
    ur_df["unified_score"] = pd.to_numeric(ur_df["unified_score"], errors="coerce")
    return raw.merge(ur_df, on=["symbol", "date"], how="inner")


def load_liquidity(start):
    """ADT20 in Rs crore. measurement.md's panel spec mandates a >=Rs1cr floor: "Without it you
    are measuring microcaps you cannot trade." Not optional here -- WITHOUT the floor this
    ablation reported that the ranker's universe restriction destroyed the composite's edge
    (h5 +0.068 full vs +0.012 restricted). WITH it, that gap almost entirely closes at h5
    (+0.0575 vs +0.0585): most of the apparent effect was liquidity, not selection.
    """
    a = read_df("""
        SELECT symbol, date::date AS date,
               AVG(close*volume) OVER (PARTITION BY symbol ORDER BY date
                                       ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)/1e7 AS adt_cr
          FROM stock_ohlcv WHERE date >= ? AND (is_suspect IS NULL OR is_suspect = 0)""",
        (start,))
    a["date"] = pd.to_datetime(a["date"])
    a["adt_cr"] = pd.to_numeric(a["adt_cr"], errors="coerce")
    return a


def load_quality(start):
    q = read_df(
        "SELECT symbol, date::date AS date, piotroski_f, roe FROM feature_store "
        "WHERE date::date >= ?", (start,))
    q["date"] = pd.to_datetime(q["date"])
    return q


def load_vol(start):
    v = read_df(
        "SELECT symbol, date::date AS date, hv_20d FROM technical_signals "
        "WHERE date::date >= ? AND hv_20d IS NOT NULL", (start,))
    v["date"] = pd.to_datetime(v["date"])
    v["hv_20d"] = pd.to_numeric(v["hv_20d"], errors="coerce")
    return v


def load_redflags(start):
    """Point-in-time red-flag membership: a screener appearance is live on date d when it had
    appeared by d and had not yet exited. Mirrors is_red_flagged's own predicate
    (category='risk_red_flags' AND signal_bias='bearish') in SQL rather than pulling every
    membership row into pandas -- the category/bias test is matched case-insensitively because
    screener_catalog has documented source/bias casing drift.
    """
    return read_df("""
        SELECT DISTINCT sa.symbol, sa.appeared_date::date AS appeared, sa.exited_date::date AS exited
          FROM screener_appearances sa
          JOIN screener_catalog sc
            ON sc.screener_id = sa.screener_id AND LOWER(sc.source) = LOWER(sa.source)
         WHERE LOWER(sc.category) = 'risk_red_flags'
           AND LOWER(sc.signal_bias) = 'bearish'
           AND (sa.exited_date IS NULL OR sa.exited_date::date >= ?)
    """, (start,))


def build_arms(df, qual, vol, red):
    """Apply each layer cumulatively, using the shipped functions.

    Arm 1 (equal_weight) IS engine_composite's construction -- its own rank_z, equal weights,
    MIN_ENGINES floor -- so it must reproduce that table's published +0.083 at 5d. Arm 2
    (regime_weighted) takes the IDENTICAL per-date rank-z values and applies unified_ranker's
    REGIME_WEIGHTS instead of equal ones. So arm1 -> arm2 isolates exactly one thing: the
    weighting.

    drop_zero_dispersion_engines is deliberately NOT applied here. Its ZERO_DISPERSION_MIN_SD
    of 5.0 is calibrated for 0-100 engine scores; on RAW values (win_probability is 0-1, sd
    ~0.07) it drops nearly every engine. A first version of this script applied it to the raw
    scale and dropped ml on 33 of 43 dates, which flipped the equal-weight arm negative --
    a bug in this script, not in the ranker. Rank-z normalization already removes scale.
    """
    rows = []
    for date, g in df.groupby("date", sort=True):
        regime = (g["regime"].mode().iloc[0] if g["regime"].notna().any() else "SIDEWAYS")
        weights = ur.REGIME_WEIGHTS.get(regime, ur.REGIME_WEIGHTS["SIDEWAYS"])
        gg = g.copy()
        # engine_composite's own per-date cross-sectional rank z-score.
        zc = {}
        for raw_col, eng in RAW_TO_ENGINE.items():
            if raw_col not in gg.columns:
                continue
            zc[eng] = (gg[raw_col].rank(pct=True) - 0.5) / 0.2887
        z = pd.DataFrame(zc, index=gg.index)
        present = z.notna()
        n_eng = present.sum(axis=1)
        # Equal weight = engine_composite's mean over present engines (skipna).
        gg["equal_weight"] = z.mean(axis=1)
        # Regime weighted = same values, weights renormalized over present engines only,
        # mirroring _blend's own renormalization rule.
        w = pd.Series({e: weights.get(e, 0.0) for e in z.columns})
        wmat = present.mul(w, axis=1)
        gg["regime_weighted"] = (z.fillna(0.0) * wmat).sum(axis=1) / wmat.sum(axis=1)
        # 8-engine variant: same rank-z treatment for the two stored-only engines, so
        # `rw8+gates` vs `rw+quality+redflag+highvol` isolates exactly one thing -- adding
        # screener + smart_money to an otherwise identical blend and gate stack.
        z8 = z.copy()
        for _col, _eng in STORED_ONLY_ENGINES.items():
            if _col in gg.columns:
                z8[_eng] = (gg[_col].rank(pct=True) - 0.5) / 0.2887
        p8 = z8.notna()
        w8 = pd.Series({e: weights.get(e, 0.0) for e in z8.columns})
        m8 = p8.mul(w8, axis=1)
        gg["rw8"] = (z8.fillna(0.0) * m8).sum(axis=1) / m8.sum(axis=1)
        gg.loc[p8.sum(axis=1) < ec.MIN_ENGINES, "rw8"] = float("nan")
        # Add each stored-only engine ALONE, to attribute the rw8 effect rather than
        # reporting the pair and guessing which half caused it.
        for _col, _eng in STORED_ONLY_ENGINES.items():
            z7 = z.copy()
            if _col in gg.columns:
                z7[_eng] = (gg[_col].rank(pct=True) - 0.5) / 0.2887
            p7 = z7.notna()
            w7 = pd.Series({e: weights.get(e, 0.0) for e in z7.columns})
            m7 = p7.mul(w7, axis=1)
            key = "rw7_" + _eng
            gg[key] = (z7.fillna(0.0) * m7).sum(axis=1) / m7.sum(axis=1)
            gg.loc[p7.sum(axis=1) < ec.MIN_ENGINES, key] = float("nan")
        gg.loc[n_eng < ec.MIN_ENGINES, ["equal_weight", "regime_weighted"]] = float("nan")
        gg["n_engines"] = n_eng
        rows.append(gg)
    d = pd.concat(rows, ignore_index=True)
    print(f"[ablation] engines present per row: mean={d['n_engines'].mean():.2f} "
          f"| rows below MIN_ENGINES={ec.MIN_ENGINES}: {(d['n_engines'] < ec.MIN_ENGINES).mean():.1%}")

    # --- + quality_gate ----------------------------------------------------------
    d = d.merge(qual, on=["symbol", "date"], how="left")
    d["qg"] = [ur.quality_gate(p if pd.notna(p) else None, r if pd.notna(r) else None)
               for p, r in zip(d["piotroski_f"], d["roe"])]
    d["rw+quality"] = d["regime_weighted"] * d["qg"]

    # --- + red-flag veto ---------------------------------------------------------
    if red.empty:
        d["red"] = False
    else:
        red = red.copy()
        for c in ("appeared", "exited"):
            red[c] = pd.to_datetime(red[c], errors="coerce")
        # A symbol is red-flagged on date d if ANY qualifying appearance brackets d.
        pairs = set()
        for sym, ap, ex in zip(red["symbol"], red["appeared"], red["exited"]):
            if pd.isna(ap):
                continue
            for dt in d["date"].unique():
                if ap <= dt and (pd.isna(ex) or ex >= dt):
                    pairs.add((sym, dt))
        d["red"] = [(s, t) in pairs for s, t in zip(d["symbol"], d["date"])]
    d["rw+quality+redflag"] = d["rw+quality"] * d["red"].map(
        {True: ur.RED_FLAG_VETO_MULT, False: 1.0})

    # --- + high-vol veto ---------------------------------------------------------
    d = d.merge(vol, on=["symbol", "date"], how="left")
    # Cutoff is per-date, from that date's own tape, via the ranker's own helper.
    cuts = {dt: ur.high_vol_cutoff(list(g["hv_20d"].dropna()))
            for dt, g in d.groupby("date", sort=False)}
    hv_mult = []
    for dt, v in zip(d["date"], d["hv_20d"]):
        cut = cuts.get(dt)
        hv_mult.append(ur.HIGH_VOL_VETO_MULT
                       if (cut is not None and pd.notna(v) and v >= cut) else 1.0)
    d["hv_mult"] = hv_mult
    d["rw+quality+redflag+highvol"] = d["rw+quality+redflag"] * d["hv_mult"]
    # Same gate stack applied to the 8-engine blend, so rw8+gates vs
    # rw+quality+redflag+highvol isolates exactly one thing: adding screener + smart_money.
    _gates = (d["qg"] * d["red"].map({True: ur.RED_FLAG_VETO_MULT, False: 1.0}) * d["hv_mult"])
    d["rw7+screener"] = d["rw7_screener"] * _gates
    d["rw7+smartmoney"] = d["rw7_smart_money"] * _gates
    d["rw8+gates"] = (d["rw8"] * d["qg"]
                      * d["red"].map({True: ur.RED_FLAG_VETO_MULT, False: 1.0})
                      * d["hv_mult"])

    d["stored_unified_score"] = d["unified_score"]
    return d


def main(start, horizons, entry, persist, min_per_date, min_n):
    con = connect()
    df = load_panel(start)
    if df.empty:
        print("[ablation] no unified_recommendations rows in range", file=sys.stderr)
        return
    print(f"[ablation] panel: rows={len(df)} symbols={df.symbol.nunique()} "
          f"dates={df.date.nunique()} span={df.date.min().date()}..{df.date.max().date()}")

    d = build_arms(df, load_quality(start), load_vol(start), load_redflags(start))
    # Panel-spec liquidity floor, applied to every arm identically.
    liq_start = (pd.Timestamp(start) - pd.Timedelta(days=60)).strftime("%Y-%m-%d")
    d = d.merge(load_liquidity(liq_start), on=["symbol", "date"], how="left")
    before = len(d)
    d = d[d["adt_cr"] >= MIN_ADT_CR]
    print(f"[ablation] liquidity floor >=Rs{MIN_ADT_CR}cr ADT20: kept {len(d)}/{before} rows "
          f"({len(d)/before:.1%})")
    print(f"[ablation] layer prevalence -- quality_gate<1: {(d['qg'] < 1).mean():.1%}  "
          f"red_flag: {d['red'].mean():.1%}  high_vol: {(d['hv_mult'] < 1).mean():.1%}")

    lo = (d["date"].min() - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    oh = fe._forward_returns(con, lo, horizons, entry=entry)
    m = d.merge(oh[["symbol", "date"] + [f"fwd_{N}" for N in horizons]],
                on=["symbol", "date"], how="inner")
    for N in horizons:
        m[f"xs_{N}"] = m.groupby("date")[f"fwd_{N}"].transform(lambda x: x - x.median())
    print(f"[ablation] matched to forward prices: rows={len(m)} dates={m.date.nunique()}\n")

    if persist:
        fe._ensure_history(con)
        run_at = __import__("datetime").datetime.now().isoformat()

    print(f"{'arm':<32}{'horiz':>6}{'rank_IC':>10}{'hit_AUC':>10}{'n':>9}{'dates':>7}  verdict")
    print("-" * 88)
    for arm in ARMS:
        for N in horizons:
            res = fe._metrics(m, arm, N, min_per_date, min_n)
            if res is None:
                print(f"{arm:<32}{N:>5}d{'--':>10}{'--':>10}{'--':>9}{'--':>7}  insufficient")
                continue
            mic, auc, n, dates = res
            vd = fe._verdict(mic, auc, dates)
            print(f"{arm:<32}{N:>5}d{mic:>10.4f}{auc:>10.4f}{n:>9}{dates:>7}  {vd}")
            if persist:
                suffix = "" if entry == "close" else "__open_entry"
                con.execute(
                    "INSERT INTO factor_edge_history "
                    "(run_at,table_name,score_col,regime,horizon_days,rank_ic,hit_auc,n,dates,verdict) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                    (run_at, f"assembly_ablation{suffix}", arm, "ALL", N,
                     None if mic != mic else round(mic, 4),
                     None if auc != auc else round(auc, 4), n, dates, vd))
        print()
    if persist:
        con.commit()
        print(f"[ablation] persisted to factor_edge_history (run_at={run_at})")
    con.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-06-01")
    ap.add_argument("--horizons", default="1,5,21")
    ap.add_argument("--entry", choices=("close", "open"), default="close")
    ap.add_argument("--persist", action="store_true")
    ap.add_argument("--min-per-date", type=int, default=10)
    ap.add_argument("--min-n", type=int, default=100)
    a = ap.parse_args()
    main(a.start, [int(h) for h in a.horizons.split(",")], a.entry, a.persist,
         a.min_per_date, a.min_n)
import polars as pl

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
