"""Shadow arms rebuilt at grading time from unified_recommendations_history (spec 2026-10-08, section 2.C.1).

Pure functions on a DataFrame with one row per (session, symbol) and the history columns regime, unified_score,
classification, ml_score, confluence_score, technical_score, breakout_score. No database access here.

Arms:
  published       the stored unified_score (every overlay and veto the ranker applied)
  reblend         per-session percentile normalisation (unified_ranker._normalize_to_100) of the four weighted engines,
                  blended with the live REGIME_WEIGHTS, weights renormalised over the engines present for that symbol
  reblend_vol_veto  reblend x0.7 on the top 20% of the session by 20-day realised vol (vol passed in)
  reblend_no_ml   reblend without the ml engine
  reblend_no_sector_slot  reblend with the confluence "sector" slot (the stock's own momentum, AF-20261008-24) taken out of the
                  confluence engine. Needs the persisted confluence sub-scores as of each call (SLOT_COLS, from
                  confluence_signals); NaN for a session whose rebuild does not reproduce the stored score, and for every
                  session when the columns are absent
  random_control  the published scores shuffled within each session (same distribution, no information), seeded
  reblend_learned  reblend with weights learned from each engine's realised rank IC (AF-20261119): for a session, only
                  sessions whose forward window had CLOSED by then are used (no look-ahead), same regime when it has
                  enough history, shrunk towards the live REGIME_WEIGHTS by n_eff / (n_eff + LEARN_SHRINK_K). NaN
                  when no forward returns are passed in
  reblend_sector_rs_gate  reblend x0.7 on stocks that lag their sector benchmark (rs_vs_sector_21d < 0, RS_20d < 0,
                  AF-20261119-08 / learning-loop review). Fails open (no haircut) for missing/NaN sector RS; NaN
                  for sessions where sector RS is entirely absent
ponytail: the ranker's zero-dispersion engine drop, quality gate and red-flag vetoes are not replayed; `published` carries them.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from factor_edge import _effective_dates
from unified_ranker import REGIME_WEIGHTS

ENGINES = ("ml", "confluence", "technical", "breakout")
ARMS = ("published", "reblend", "reblend_vol_veto", "reblend_no_ml", "random_control", "reblend_no_sector_slot",
        "reblend_learned", "reblend_sector_rs_gate")
VOL_VETO_TOP_SHARE = 0.20
VOL_VETO_MULT = 0.7
SECTOR_RS_GATE_MULT = 0.7
SLOT_COLS = ("cs_trend", "cs_vol", "cs_sector", "cs_fund")   # confluence_signals.{trend_alignment,volume,sector_strength,fundamental}_score
SLOT_REBUILD_MIN_RANK_CORR = 0.9999
LEARN_HORIZON = 5          # sessions; the forward return the learned weights are fitted to
LEARN_SHRINK_K = 20.0      # = factor_edge.MIN_DATES_RELIABLE: half-way to the IC weights at 20 independent windows
LEARN_MIN_REGIME_EFF = 5.0 # below this many independent windows in the session's own regime, pool all regimes
LEARN_MIN_N = 30           # names per session for an engine IC (accuracy_scorecard.MIN_PER_DATE)


def _pct100(s: pd.Series) -> pd.Series:
    # (less + 0.5 * equal) / n * 100 == (average rank - 0.5) / n * 100, n = present values in the session
    return (s.rank(method="average") - 0.5) / s.notna().sum() * 100.0


def _live_weights(regime: str) -> dict:
    return REGIME_WEIGHTS.get(regime, REGIME_WEIGHTS["BULL"])      # the ranker falls back to BULL


def reblend(df: pd.DataFrame, drop=(), weights: pd.DataFrame | None = None) -> pd.Series:
    """`weights` (optional): one column per engine, row-aligned with df, replacing the live REGIME_WEIGHTS."""
    num = pd.Series(0.0, index=df.index)
    den = pd.Series(0.0, index=df.index)
    regime = df["regime"].astype(str).str.upper()
    for e in ENGINES:
        if e in drop:
            continue
        v = df.groupby("session")[f"{e}_score"].transform(_pct100)
        w = weights[e] if weights is not None else regime.map(lambda r: _live_weights(r)[e])
        ok = v.notna() & (w > 0)
        num += np.where(ok, w * v.fillna(0.0), 0.0)
        den += np.where(ok, w, 0.0)
    return (num / den.where(den > 0)).rename("reblend")


def reblend_no_ml(df: pd.DataFrame) -> pd.Series:
    return reblend(df, drop=("ml",)).rename("reblend_no_ml")


def _confluence_raw(parts: pd.DataFrame) -> pd.Series:
    # unified_ranker._get_confluence_scores: sum of the sub-scores, a missing one imputed at the cross-sectional median
    return parts.fillna(parts.median()).sum(axis=1)


def reblend_no_sector_slot(df: pd.DataFrame) -> pd.Series:
    """reblend with cs_sector out of the confluence sum. The sub-scores are rebuilt as of each call, so a session is used
    only if its trend+vol+sector+fund rebuild reproduces the stored confluence_score ranking; otherwise it is NaN
    (a proxy would not be the slot's value, and a silent drop of the engine would be a different arm)."""
    parts = df[list(SLOT_COLS)].apply(pd.to_numeric, errors="coerce")
    has = df["confluence_score"].notna()
    out = pd.Series(np.nan, index=df.index, name="reblend_no_sector_slot")
    for _, idx in df.groupby("session").groups.items():
        p, h = parts.loc[idx], has.loc[idx]
        full = _confluence_raw(p).where(h)
        if h.sum() < 2 or not (full[h].rank().corr(df.loc[idx, "confluence_score"][h].rank()) >= SLOT_REBUILD_MIN_RANK_CORR):
            continue
        sub = df.loc[idx].assign(confluence_score=_confluence_raw(p.drop(columns="cs_sector")).where(h))
        out.loc[idx] = reblend(sub).to_numpy()
    return out


def reblend_vol_veto(df: pd.DataFrame, vol: pd.Series) -> pd.Series:
    base = reblend(df)
    rank = vol.groupby(df["session"]).rank(pct=True)
    return base.where(~(rank > 1 - VOL_VETO_TOP_SHARE), base * VOL_VETO_MULT).rename("reblend_vol_veto")


def reblend_sector_rs_gate(df: pd.DataFrame, sector_rs: pd.Series | None = None) -> pd.Series:
    """reblend with a haircut (x0.7) on stocks that lag their sector (sector_rs < 0, RS_20d < 0).

    Fails open (keeps base score) for missing or NaN sector RS. If sector RS is entirely absent
    or all-NaN across a session, that session is left NaN so unpopulated windows are not graded."""
    if sector_rs is None:
        if "sector_rs" in df.columns:
            sector_rs = df["sector_rs"]
        elif "rs_vs_sector_21d" in df.columns:
            sector_rs = df["rs_vs_sector_21d"]
        else:
            return pd.Series(np.nan, index=df.index, name="reblend_sector_rs_gate")
    out = pd.Series(np.nan, index=df.index, name="reblend_sector_rs_gate")
    base = reblend(df)
    for _, idx in df.groupby("session").groups.items():
        s = sector_rs.loc[idx]
        if s.isna().all():
            continue
        gated = s.notna() & (s < 0.0)
        b = base.loc[idx]
        out.loc[idx] = b.where(~gated, b * SECTOR_RS_GATE_MULT).to_numpy()
    return out


def published(df: pd.DataFrame) -> pd.Series:
    return df["unified_score"]


def random_control(df: pd.DataFrame, seed: int = 0) -> pd.Series:
    rng = np.random.default_rng(seed)
    out = pd.Series(np.nan, index=df.index, name="random_control")
    for _, idx in df.groupby("session").groups.items():
        out.loc[idx] = rng.permutation(df.loc[idx, "unified_score"].to_numpy(copy=True))
    return out


def engine_session_ic(df: pd.DataFrame, fwd: pd.Series, min_n: int = LEARN_MIN_N) -> pd.DataFrame:
    """Per session x engine Spearman IC of the engine score against the forward return (NaN when thin)."""
    out = {}
    for e in ENGINES:
        out[e] = session_ic(df, df[f"{e}_score"], fwd, date_col="session", min_n=min_n)
    return pd.DataFrame(out)


def learned_weights(ic: pd.DataFrame, regimes: pd.Series, sessions: pd.DatetimeIndex, session, regime: str,
                    horizon: int = LEARN_HORIZON) -> dict:
    """Engine weights for `session`, from ICs of sessions whose forward window had closed by then.

    A call on session j enters at the open of j+1 and exits at the open of j+1+horizon, so its return is known
    when session i is ranked only if pos(j) <= pos(i) - (horizon + 1). Weights are the positive mean ICs,
    normalised, shrunk towards the live REGIME_WEIGHTS by n_eff / (n_eff + LEARN_SHRINK_K)."""
    live = _live_weights(regime)
    i = sessions.get_indexer([session])[0]
    if i < 0 or ic.empty:
        return dict(live)
    pos = pd.Series(sessions.get_indexer(ic.index), index=ic.index)
    known = ic[(pos >= 0) & (pos <= i - (horizon + 1))]
    same = known[regimes.reindex(known.index).astype(str).str.upper() == regime]
    use = same if _effective_dates(len(same), horizon) >= LEARN_MIN_REGIME_EFF else known
    if use.empty:
        return dict(live)
    mean = use.mean().clip(lower=0).fillna(0.0)
    if mean.sum() <= 0:
        return dict(live)
    target = (mean / mean.sum()).to_dict()
    n_eff = _effective_dates(len(use), horizon)
    lam = n_eff / (n_eff + LEARN_SHRINK_K)
    w = {e: (1 - lam) * live.get(e, 0.0) + lam * target.get(e, 0.0) for e in ENGINES}
    tot = sum(w.values())
    return {e: v / tot for e, v in w.items()} if tot > 0 else dict(live)


def reblend_learned(df: pd.DataFrame, fwd: pd.Series | None, sessions: pd.DatetimeIndex,
                    horizon: int = LEARN_HORIZON) -> pd.Series:
    if fwd is None or fwd.notna().sum() == 0:
        return pd.Series(np.nan, index=df.index, name="reblend_learned")
    ic = engine_session_ic(df, fwd)
    regimes = df.groupby("session")["regime"].agg(lambda r: str(r.mode().iat[0]).upper() if len(r.mode()) else "BULL")
    rows = []
    for sess, idx in df.groupby("session").groups.items():
        w = learned_weights(ic, regimes, sessions, sess, regimes.get(sess, "BULL"), horizon)
        rows.append(pd.DataFrame({e: w[e] for e in ENGINES}, index=idx))
    weights = pd.concat(rows).reindex(df.index)
    return reblend(df, weights=weights).rename("reblend_learned")


def arm_scores(df: pd.DataFrame, vol: pd.Series, seed: int = 0, fwd: pd.Series | None = None,
               sessions: pd.DatetimeIndex | None = None,
               sector_rs: pd.Series | None = None) -> pd.DataFrame:
    return pd.DataFrame({"published": published(df), "reblend": reblend(df), "reblend_vol_veto": reblend_vol_veto(df, vol),
                         "reblend_no_ml": reblend_no_ml(df), "random_control": random_control(df, seed),
                         "reblend_no_sector_slot": (reblend_no_sector_slot(df) if set(SLOT_COLS) <= set(df.columns)
                                                    else pd.Series(np.nan, index=df.index)),
                         "reblend_learned": (reblend_learned(df, fwd, sessions) if sessions is not None
                                             else pd.Series(np.nan, index=df.index)),
                         "reblend_sector_rs_gate": reblend_sector_rs_gate(df, sector_rs)}, index=df.index)


def session_ic(df: pd.DataFrame, score: pd.Series, fwd: pd.Series, date_col: str = "session", min_n: int = 30) -> pd.Series:
    """Spearman rank IC of score vs forward return, one value per session (thin or degenerate sessions dropped)."""
    d = pd.DataFrame({"d": df[date_col], "s": score, "f": fwd}).dropna()
    out = {}
    for k, g in d.groupby("d"):
        if len(g) >= min_n and g["s"].nunique() > 3:
            out[k] = g["s"].rank().corr(g["f"].rank())
    return pd.Series(out, dtype=float)
