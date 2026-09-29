"""Feature-group ablation: which data sources actually earn their place in the model.

The promotion gate judges the whole model, so a group that adds nothing — or quietly hurts —
rides along with the ones that work. This re-runs the SAME walk-forward out-of-fold training
with one group removed at a time and compares per-date rank IC against the full model on the
same dates:

    delta_t = IC_full(t) - IC_without_group(t),   t_nw = Newey-West t of delta (lags = h - 1)

A group ADDS when delta > 0 with t_nw >= promotion_min_t, HURTS when delta < 0 with
t_nw <= -promotion_min_t, and otherwise has NO EVIDENCE (which is the expected verdict for a
source that has only just started accruing history). Ablation measures marginal value given the
other groups: two groups carrying the same information can each show no evidence while
removing both would hurt.
"""
from __future__ import annotations

import pandas as pd

from bharat_alpha.config import get_settings
from bharat_alpha.evaluation.metrics import newey_west_t, per_date_ic
from bharat_alpha.modeling.dataset import Dataset
from bharat_alpha.modeling.members import combine, default_members
from bharat_alpha.modeling.train import _wide, walk_forward_oof

# ordered: the first matching prefix wins; anything unmatched is a price/volume feature
GROUP_PREFIXES = (
    ("delivery", ("deliv_",)),
    ("options", ("opt_",)),
    ("futures", ("fo_basis", "fo_oi", "fo_listed")),
    ("fo_ban", ("fo_ban",)),
    ("earnings_reaction", ("earn_",)),
    ("reported_results", ("res_",)),
    ("estimates", ("est_",)),
    ("fundamentals", ("fund_",)),
    ("ownership", ("own_",)),
    ("events", ("days_to_results", "insider_", "idx_days_since")),
    ("legacy_bridge", ("x_",)),
    ("participant_oi", ("fii_idx", "pro_idx", "client_idx")),
    ("cash_flows", ("fii_net", "dii_net")),
    ("global_cues", ("us_", "usd_", "brent_", "usdinr_")),
    ("market_context", ("mkt_", "breadth_", "xs_", "vix", "n500_", "gift_")),
)


def group_of(col: str) -> str:
    return next((g for g, pre in GROUP_PREFIXES if col.startswith(pre)), "price")


def feature_groups(cols: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for c in cols:
        out.setdefault(group_of(c), []).append(c)
    return out


def _ensemble_ic(ds: Dataset, X: pd.DataFrame, members_factory) -> pd.Series:
    s = get_settings()
    sub = Dataset(ds.horizon, X, ds.y, ds.fwd, ds.excess, ds.features, ds.labels, ds.panel)
    oof = walk_forward_oof(sub, members_factory, s.cv_folds, s.train_min_dates)
    ens = combine(oof, {c: 1.0 for c in oof.columns})
    return per_date_ic(_wide(ens), _wide(ds.fwd.reindex(oof.index)))


def ablate(ds: Dataset, members_factory=None, groups: dict[str, list[str]] | None = None) -> pd.DataFrame:
    s = get_settings()
    members_factory = members_factory or (lambda: default_members(s.seeds))
    groups = groups or feature_groups(list(ds.X.columns))
    full = _ensemble_ic(ds, ds.X, members_factory)
    lags = max(ds.horizon - 1, 0)
    rows = []
    for g, cols in sorted(groups.items()):
        keep = [c for c in ds.X.columns if c not in set(cols)]
        if not keep:
            continue
        without = _ensemble_ic(ds, ds.X[keep], members_factory)
        diff = (full - without).dropna()
        delta = float(diff.mean()) if len(diff) else float("nan")
        t = newey_west_t(diff, lags)
        if t == t and delta > 0 and t >= s.promotion_min_t:
            verdict = "adds"
        elif t == t and delta < 0 and t <= -s.promotion_min_t:
            verdict = "hurts"
        else:
            verdict = "no evidence"
        rows.append({"group": g, "n_features": len(cols), "ic_full": float(full.mean()),
                     "ic_without": float(without.mean()), "delta_ic": delta, "t_nw": t,
                     "n_dates": int(len(diff)), "verdict": verdict})
    return pd.DataFrame(rows).sort_values("delta_ic", ascending=False).reset_index(drop=True)
