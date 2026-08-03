"""Return targets keyed by ticker, computed from stock_ohlcv. Empty if unavailable."""
from __future__ import annotations

from db_compat import query_all


def load_return_targets(windows=(5, 20)) -> dict[str, dict[str, float]]:
    targets: dict[str, dict[str, float]] = {}
    try:
        rows = query_all(
            """SELECT symbol, date, close FROM stock_ohlcv
               WHERE close IS NOT NULL ORDER BY symbol, date"""
        )
    except Exception:
        return targets
    series: dict[str, list[tuple[str, float]]] = {}
    for r in rows:
        series.setdefault(r["symbol"], []).append((r["date"], float(r["close"])))
    for w in windows:
        trail: dict[str, float] = {}
        for sym, pts in series.items():
            closes = [c for _, c in pts]
            if len(closes) > w and closes[-1 - w] > 0:
                trail[sym] = closes[-1] / closes[-1 - w] - 1.0
        targets[f"trailing_ret_{w}d"] = trail
    # NOTE: forward-return targets (fwd_ret_*) are intentionally NOT emitted in v1.
    # A field's value is captured at fetch time; the genuine forward return is only
    # known on a later run. Computing it now would store a misleading zero column.
    # Trailing returns are descriptive of the current cross-section and are enough
    # for the first-pass usefulness signal; true forward IC accrues once run history
    # exists (a later enhancement that diffs stored snapshots).
    return targets
