"""
check_load_bearing_constraints.py — read-only re-verification of two facts this codebase's own
audits established and that must NOT be treated as stale caveats:

  1. The intraday ranker's Buy/Strong-Buy emission gate is CLOSED because the engine's own
     trailing realised edge over 15-min bars has measured negative (see intraday_ranker.py's
     EMISSION_GATE_* constants and the 2026-07-31 intraday audit). It is designed to re-open
     itself automatically once that stops being true -- this script tells you, right now,
     whether it has.
  2. Short-horizon (5-day) and intraday momentum/breakout factors measured net-negative in
     this exact universe (2026-07-30 bias audit, 2026-07-31 intraday audit). REGIME_WEIGHTS'
     `breakout` engine weight was capped low in risk-off regimes specifically because of that
     finding, not by convention.

Both are living constraints, not facts to be repeated from memory -- run this before touching
EMISSION_GATE_*, REGIME_WEIGHTS' breakout weight, or REGIME_CAT_TILT's momentum multipliers,
and before concluding either finding is "surely fixed by now." Makes NO writes.

  python scripts/check_load_bearing_constraints.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "server"))

from db_compat import connect
from intraday_ranker import IntradayRanker, EMISSION_GATE_MIN_TRADES, EMISSION_GATE_MIN_AVG_PNL, EMISSION_GATE_LOOKBACK_DAYS
from unified_ranker import REGIME_WEIGHTS

# Pinned ceiling: the breakout engine's weight was deliberately capped at these values per
# regime because BULL/SIDEWAYS backtest as the only regimes where cross-sectional momentum
# didn't measure net-negative, and even there the weight was kept modest (see
# unified_ranker.py's REGIME_WEIGHTS comment block and CLAUDE.md's "negative-momentum
# findings"). A silent increase past this is the kind of drift this script exists to catch --
# it does not mean the increase is wrong, only that it must be a conscious, re-verified choice.
BREAKOUT_WEIGHT_CEILING = {
    "BULL": 0.15, "SIDEWAYS": 0.13, "HIGH_VOL": 0.10, "BEAR": 0.05, "CRASH": 0.05,
}


def section(title):
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def main():
    conn = connect()

    section("1. Intraday emission gate -- live status")
    ranker = IntradayRanker(conn=conn)
    avg_pnl, n = ranker._emission_edge()
    allowed, reason = ranker._emission_allowed()
    print(f"  Lookback window:        {EMISSION_GATE_LOOKBACK_DAYS}d")
    print(f"  Min trades required:    {EMISSION_GATE_MIN_TRADES}")
    print(f"  Min avg PnL required:   {EMISSION_GATE_MIN_AVG_PNL:+.2f}%/trade")
    print(f"  Trailing avg PnL:       {avg_pnl:+.4f}%/trade" if avg_pnl is not None else "  Trailing avg PnL:       n/a")
    print(f"  Resolved trades (n):    {n}")
    print(f"  GATE STATE:             {'OPEN -- Buy/Strong-Buy publishing' if allowed else 'CLOSED -- downgraded to Hold'}")
    print(f"  Reason:                 {reason}")
    if allowed:
        print(
            "\n  *** The gate has FLIPPED OPEN since the 2026-07-31 audit found it closed. ***\n"
            "  This means the intraday engine's own trailing realised edge is now positive on\n"
            "  a large enough sample -- a genuinely significant regime change. Re-verify this\n"
            "  is real (not a fluke sample or a resolver bug) before treating intraday Buy\n"
            "  signals as trustworthy again; do not just assume the audit's finding lapsed."
        )

    section("2. REGIME_WEIGHTS breakout weight vs. the audit-derived ceiling")
    ceiling_ok = True
    for regime, ceiling in BREAKOUT_WEIGHT_CEILING.items():
        actual = REGIME_WEIGHTS.get(regime, {}).get("breakout")
        if actual is None:
            print(f"  {regime:>10}  MISSING breakout key entirely")
            ceiling_ok = False
            continue
        flag = "" if actual <= ceiling + 1e-9 else "  <-- ABOVE PINNED CEILING"
        if flag:
            ceiling_ok = False
        print(f"  {regime:>10}  breakout={actual:.3f}  ceiling={ceiling:.3f}{flag}")
    if ceiling_ok:
        print("\n  All regimes at or below the audit-derived ceiling. No silent re-inflation detected.")
    else:
        print(
            "\n  *** At least one regime's breakout weight exceeds the pinned ceiling. ***\n"
            "  If this was a deliberate change, update BREAKOUT_WEIGHT_CEILING here with a\n"
            "  citation to whatever re-measurement justified it. If it was not deliberate,\n"
            "  this is exactly the silent-momentum-re-inflation this script exists to catch."
        )

    section("3. Daily-horizon momentum -- last known measurement (not re-derived here)")
    print(
        "  The 2026-07-30 bias audit measured mom21 at -0.53% net alpha/5d (t=-3.21, negative\n"
        "  in 5/6 years) on this universe. This script does not re-run that full statistical\n"
        "  sweep (it needs a purpose-built backtest harness, not a quick live query) -- treat\n"
        "  a 'momentum is fine now' claim as unverified until that harness is re-run for real."
    )

    conn.close()


if __name__ == "__main__":
    main()
