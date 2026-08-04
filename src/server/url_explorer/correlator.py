"""Correlate ticker-keyed numeric fields against return targets."""
from __future__ import annotations

import json
from dataclasses import dataclass

from scipy import stats

from .profiler import flatten


@dataclass
class Correlation:
    field_path: str
    target: str
    n: int
    pearson: float
    spearman: float
    ic: float


def _rows_of(results):
    """Yield per-response flattened (path->list) grouped by record. Returns list of dicts."""
    records = []
    for r in results:
        if not (r.ok and r.body):
            continue
        try:
            payload = json.loads(r.body)
        except (ValueError, TypeError):
            continue
        # Re-group flattened leaves into aligned records by list position.
        grouped: dict[str, list] = {}
        for path, val in flatten(payload):
            grouped.setdefault(path, []).append(val)
        width = max((len(v) for v in grouped.values()), default=0)
        for i in range(width):
            rec = {p: (v[i] if i < len(v) else None) for p, v in grouped.items()}
            records.append(rec)
    return records


def build_cross_section(results, ticker_field, value_field, universe):
    universe = {u.upper() for u in universe}
    cs: dict[str, float] = {}
    for rec in _rows_of(results):
        sym = rec.get(ticker_field)
        val = rec.get(value_field)
        if not isinstance(sym, str) or sym.upper() not in universe:
            continue
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            cs[sym.upper()] = float(val)  # last wins
    return cs


def correlate(cross_section, returns, field_path, target, min_n=20):
    common = [s for s in cross_section if s in returns]
    if len(common) < min_n:
        return None
    x = [cross_section[s] for s in common]
    y = [returns[s] for s in common]
    pear = stats.pearsonr(x, y).statistic
    spear = stats.spearmanr(x, y).statistic
    return Correlation(field_path, target, len(common),
                       float(pear), float(spear), float(spear))


def correlate_endpoint(results, profiles, returns_by_target, universe,
                       overlap_threshold: float = 0.5, min_n: int = 20):
    ticker_fields = [p.field_path for p in profiles
                     if p.dtype == "string" and p.universe_overlap_pct >= overlap_threshold]
    numeric_fields = [p.field_path for p in profiles if p.dtype == "numeric"]
    if not ticker_fields or not numeric_fields:
        return []
    tfield = ticker_fields[0]
    out: list[Correlation] = []
    for vfield in numeric_fields:
        cs = build_cross_section(results, tfield, vfield, universe)
        for target, rets in returns_by_target.items():
            c = correlate(cs, rets, vfield, target, min_n=min_n)
            if c is not None:
                out.append(c)
    return out
