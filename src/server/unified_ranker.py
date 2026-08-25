"""
unified_ranker.py — Regime-gated unified stock recommendation engine.

Run after market close: python unified_ranker.py
"""
import json
import csv
import math
import sys
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

from db_compat import connect
import as_of

CSV_PATH         = Path(__file__).parent.parent.parent / 'screener_scoring_v2.csv'
CORRECTIONS_PATH = Path(__file__).parent.parent.parent / 'screener_corrections.csv'

BIAS_SIGN = {'bullish': 1.0, 'bearish': -1.0, 'neutral': 0.3}

CAT_BASE_WT = {
    'composite_strategy':      0.1287,
    'fundamental_quality':     0.1188,
    'fundamental_growth':      0.0990,
    'valuation':               0.0792,
    'technical_breakout':      0.0792,
    'ownership_institutional': 0.0693,
    'technical_momentum':      0.0693,
    'technical_trend':         0.0594,
    'analyst_sentiment':       0.0495,
    'technical_reversal':      0.0396,
    'event_corporate_action':  0.0396,
    'derivatives_positioning': 0.0297,
    'income_dividend':         0.0297,
    'risk_red_flags':          0.0297,
    'volume_liquidity':        0.0297,
    'volatility':              0.0198,
    'sector_theme':            0.0198,
    'market_cap_style':        0.0099,
    'other':                   0.0,
}

SUBCAT_MOD = {
    'multi_factor_strategy':        1.20,
    'earnings_growth':              1.15,
    'institutional_activity':       1.15,
    'capital_efficiency':           1.10,
    'revenue_growth':               1.10,
    'price_leadership':             1.10,
    'relative_strength':            1.10,
    'balance_sheet_quality':        1.05,
    'price_breakout':               1.05,
    'volume_delivery':              1.05,
    'moving_average_trend':         1.00,
    'relative_or_absolute_value':   1.00,
    'trend_indicator':              0.95,
    'earnings_event':               0.95,
    'oscillator_signal':            0.90,
    'broker_forecast':              0.90,
    'open_interest':                0.90,
    'oscillator_reversal':          0.85,
    'dividend_income':              0.85,
    'candlestick_reversal':         0.80,
    'volatility_range':             0.75,
    'sector_or_theme':              0.70,
    'corporate_action':             0.70,
    'financial_or_governance_risk': 0.60,
    'size_style':                   0.60,
}

HORIZON_MULT = {
    'intraday':    0.70,
    'swing':       0.95,
    'positional':  1.05,
    'long_term':   1.10,
    # screener_catalog_enricher.py inserts rows with this coarser vocabulary
    # (screener_master entries missing from screener_scoring_v2.csv) — map them
    # onto the same scale instead of silently falling back to the 0.95 default.
    'short_term':  0.95,
    'medium_term': 1.05,
}

# `breakout` is the breakout classifier's P(>=6% up-move in 10d) — the one component with
# proven durable out-of-sample edge (5yr purged-OOF AUC 0.61, top-decile 1.47x base rate). It
# is weighted heavier in momentum regimes (BULL/SIDEWAYS/HIGH_VOL) where cross-sectional
# breakouts pay, and lighter in risk-off regimes (BEAR/CRASH) where a breakout into a falling
# tape is a trap — mirroring REGIME_CAT_TILT. _blend renormalizes over engines present for each
# symbol (so a per-symbol missing engine doesn't deflate its score), but every regime's full
# table must still sum to 1.0 for the case where all engines have data — screener/cs/breakout
# are pinned at their documented values and ml/confluence/technical/dl are scaled down from
# their pre-cs/breakout values to absorb the added weight.
#
# `smart_money` (insider buying + institutional block-deal accumulation, 2026-08-04) is flat
# 0.05 across every regime — same treatment as `cs`, both genuinely orthogonal signals with no
# regime-dependent rationale for tilting and no backtested edge magnitude to size a bigger
# weight off (unlike breakout's 5yr OOS AUC). Held out of the momentum-vs-risk-off tilt that
# governs breakout/technical, since insider/institutional accumulation isn't a momentum signal.
# ml/confluence/technical/dl were each scaled down proportionally (factor = (pool-0.05)/pool,
# where pool is their own pre-existing sum in that regime) to absorb the 5pp, same mechanism as
# the cs/breakout addition documented above — screener/cs/breakout stay pinned.
#
# A 9th `delivery` engine was drafted 2026-08-12 at 0.068-0.084 across all five regimes and is
# deliberately NOT here. `delivery_pct` was measured the same day through factor_backtest.py and
# FAILED as a long-only factor: net excess -1.04%/period at 21d/25bps and -0.15% at 5d/15bps,
# t=-1.48 both, 2/6 and 1/6 years positive. It is not a cost story -- gross 0.77%/period is
# already BELOW the universe's 1.43%, because high delivery selects the calm names and a low-vol
# tilt lags a universe compounding at 18-21%. The +0.19pp/day top-minus-bottom quintile spread is
# real but is a DIFFERENT construction; a blend engine consumes the long-only top slice, which is
# the one that loses. See measurement.md, which names this engine explicitly. The draft also left
# BEAR and SIDEWAYS summing to 0.995 rather than 1.0.
# `screener` shrunk 0.5x, 2026-08-20 -- same ENGINE_EDGE_SHRINK factor this file already
# applies elsewhere for a demonstrated "no edge"/negative engine (see edge_adjusted_weights),
# applied here directly rather than through that mechanism because its own gate reads
# factor_edge_history against unified_recommendations, which is stuck at 1 date (LOW-DATA,
# same calendar constraint as smart_money_score) and can't fire yet. `screener` was the
# HEAVIEST-weighted engine of all 8 in every regime (0.20-0.40) despite two independent,
# well-powered live measurements both finding it net-negative: measurement.md's own
# "screener bullish consensus IC -0.027, t=-2.36" (0/552-1,563 individual screeners survive
# correction), and a same-session natural experiment (2026-08-20) comparing
# confluence_signals.confluence_score, which bakes in a screener sub-component, against the
# identical construction with that component stripped out (_get_confluence_scores's own
# 2026-08-05 "decorrelation fix") -- WITH screener graded consistently worse at every horizon
# (1d +0.019->+0.012, 5d +0.056->+0.040, 21d +0.067->+0.044 rank IC). A from-scratch linear
# reconstruction of this blend's other 6 engines (screener/smart_money excluded, otherwise
# identical _normalize_to_100/_blend mechanics and BULL weights) measured real, USABLE-at-21d
# IC (+0.037/+0.081/+0.100 at 1d/5d/21d) -- dramatically higher than unified_score's own
# live headline number (5d rank IC ~=0.0001) -- which is what motivated tracing screener's
# weight specifically rather than assuming the components can't be combined at all. Full
# derivation: measurement.md, "The shared-ceiling pattern, tested rather than argued" section.
# Freed weight redistributed proportionally over the other 6 non-pinned engines in each regime
# (ml/cs/confluence/technical/dl/smart_money) -- the same mechanism this file's own comments
# already describe for the cs/breakout and smart_money additions above. `breakout` is
# deliberately EXCLUDED from the redistribution and stays pinned at its exact prior value in
# every regime: TestBreakoutWeightCeiling (test_unified_ranker_regime.py) and
# scripts/check_load_bearing_constraints.py's BREAKOUT_WEIGHT_CEILING both independently cap
# it, for an unrelated reason (momentum measured net-negative after costs on this universe,
# mom21 -0.53%/5d t=-3.21) -- naively scaling every non-screener engine up, breakout included,
# would have pushed it above that ceiling in all 5 regimes. NOT a re-derivation of the whole
# table from scratch -- a single, targeted, reversible shrink on the one component with a
# direct negative-edge finding, leaving every other regime-conditional judgment call as-is.
# Re-check via a fresh live unified_ranker.py run + factor_edge.py grading of the resulting
# unified_score once ~20+ dates have accumulated under these weights -- this could not be
# validated retroactively since past unified_recommendations rows were generated under the
# old weights.
# THIRD targeted shrink, 2026-08-24: `ml` halved (ENGINE_EDGE_SHRINK=0.5), freed weight
# redistributed proportionally over the other 6 non-pinned engines; `breakout` pinned at its
# exact prior value in every regime (same mechanism and policy as the 2026-08-20 and
# 2026-08-21 screener shrinks documented below). Why ml: its persisted engine score averages
# a window of isotonic-CALIBRATED win probabilities (_get_ml_scores read
# COALESCE(calibrated_win_probability, ...) until today), and the calibrators collapse
# dispersion by design when a regime has no live edge (HIGH_VOL emitted ~0.78 for ~90% of
# the universe -- see that function's own 2026-08-10 note). A near-constant input carries
# blend weight without contributing cross-sectional rank information and dilutes the
# composite (blended AUC@5d measured 0.5206 vs confluence_score's own 0.5812 on identical
# rows). Today's companion fix switches that read back to raw win_probability, so this table
# encodes "the engine we actually have"; the shrink and the input fix were verified TOGETHER
# because arm-testing ran against persisted (collapsed) scores.
#
# Evidence gate, run BEFORE editing (measurement.md rule: never reweight from argument alone):
#   python src/server/_tmp_weight_arms.py -- mechanical candidate transforms scored on the
#   IDENTICAL panel/labels/metrics as blend_walkforward.py (59,756 rows, 24 sessions,
#   2026-06-30..2026-08-13), paired t-stats over daily rank-IC deltas vs BASE:
#     BASE              mean IC 0.0405, 18/24 days positive, 6 top-30 gainer hits
#     A  ml x0.5        mean IC 0.0424, dIC +0.0019, paired t=+2.05, 19/24 days  <- SHIPPED
#     B  ml+dl both x0.5  IC 0.0379, dIC -0.0027, t=-1.82                       <- rejected
#     C  ml x0.5 + give freed share straight to confluence  IC 0.0420, dIC +0.0014, t=+0.78
#   Only arm A cleared the pre-declared bar (dIC > 0 AND |t| >= ~2), so ONLY arm A ships.
#   Confluence rises here as a CONSEQUENCE of proportional redistribution (BULL
#   0.190227 -> 0.214195), NOT because it was hand-picked -- arm C, the hand-picked variant,
#   failed its own significance test. dl explicitly KEEPS its weight: demoting it (arm B)
#   measurably hurt (it holds the best engine IC, +0.059 @5d), contradicting the earlier
#   "observation-only" hypothesis -- the hypothesis was tested and lost.
#
# Known consequence, accepted (same class as the 2026-08-21 note below): shrinking one
# engine's share shifts the unified_score distribution and therefore how many names clear
# DIRECTIONAL_BUY_FLOOR-style absolute thresholds. Left alone for the same reason as then.
# Re-check via a fresh blend_walkforward.py run once ~20+ further sessions accumulate; if
# the dIC advantage reverses on the larger sample, revert is a one-commit operation.
REGIME_WEIGHTS = {
    'BULL':     {'screener': 0.08445,  'ml': 0.107098, 'cs': 0.079331, 'confluence': 0.214195, 'technical': 0.171356, 'dl': 0.114237, 'breakout': 0.15, 'smart_money': 0.079333},
    'BEAR':     {'screener': 0.100068, 'ml': 0.136449, 'cs': 0.082198, 'confluence': 0.272899, 'technical': 0.138093, 'dl': 0.138093, 'breakout': 0.05, 'smart_money': 0.0822},
    'HIGH_VOL': {'screener': 0.054404, 'ml': 0.079274, 'cs': 0.066062, 'confluence': 0.158549, 'technical': 0.317099, 'dl': 0.158549, 'breakout': 0.10, 'smart_money': 0.066063},
    'CRASH':    {'screener': 0.115177, 'ml': 0.144181, 'cs': 0.089001, 'confluence': 0.224281, 'technical': 0.144181, 'dl': 0.144181, 'breakout': 0.05, 'smart_money': 0.088998},
    # SIDEWAYS was silently falling back to BULL; a balanced blend is more appropriate for
    # a rangebound tape (lean slightly less on momentum/dl than BULL).
    'SIDEWAYS': {'screener': 0.090793, 'ml': 0.11737, 'cs': 0.081507, 'confluence': 0.23474, 'technical': 0.146713, 'dl': 0.11737, 'breakout': 0.13, 'smart_money': 0.081507},
}
# SECOND screener shrink, 2026-08-21 (the first was 2026-08-20, same policy, same reason).
# ENGINE_EDGE_SHRINK=0.5 applied again to `screener` only, freed weight redistributed
# proportionally over the 6 non-pinned engines. `breakout` is pinned at its exact prior value
# in every regime -- it has an independent audit-derived ceiling (BREAKOUT_WEIGHT_CEILING /
# TestBreakoutWeightCeiling) and a naive proportional scale-up would silently breach it.
# Screener went BULL 0.30 -> 0.15 -> 0.075; CRASH 0.40 -> 0.20 -> 0.10.
#
# Evidence, TWO independent measurements agreeing, neither of them a re-run of the other:
#   1. factor_edge.py on unified_recommendations (35 dates): screener_stock_score rank IC
#      -0.0326 @5d, -0.0160 @10d -- negative at both well-powered horizons, while
#      technical_score is +0.031 and dl_score +0.059 on the identical rows.
#   2. The natural experiment already in the schema (2026-08-20): confluence_score WITH its
#      screener component grades worse than the same composite WITHOUT it at every horizon
#      (5d +0.056 -> +0.040, 21d +0.067 -> +0.044).
# Plus the standing population-level result: 0 of 1,563 individual screeners survive FDR or
# Bonferroni, and bullish screener consensus is significantly NEGATIVE (t=-2.36).
#
# This is a REMOVAL of a measured-harmful input, not the addition of an unproven one -- the
# distinction that makes it defensible under measurement.md's "reweighting is not a fix" rule,
# which is about chasing gains by retuning, not about cutting a demonstrated negative.
# Deliberately a shrink and not a drop to zero: at 21d screener reads +0.002 (LOW-DATA, 4
# dates), so "harmful at every horizon" is not established, and zeroing an engine also changes
# _blend's renormalization for symbols where other engines are missing.
# Full derivation + the composite finding that motivated re-examining the blend: measurement.md.
#
# MEASURED SIDE EFFECT, live before/after on the same day and the same SIDEWAYS regime:
# actionable Buys fell 81 -> 66 (-19%) while mean unified_score barely moved (43.55 -> 43.66).
# This is recurring-bugs.md's "restricting/deflating a score upstream re-tunes every ABSOLUTE
# threshold downstream" class -- the reweighting is rank-motivated, but DIRECTIONLESS_BUY_FLOOR
# (70.0) and STRONG_BUY (80.0) are absolute, so a distributional shift in the upper tail changes
# how many names clear them. Left as-is DELIBERATELY rather than re-tuning the floor to hold the
# old count: no Buy call on this platform has ever demonstrated forward edge (unified_score 5d
# IC +0.012, AUC 0.514 over 38 dates), so manufacturing more of them by loosening a floor would
# be fitting the output to a target rather than to evidence. Flagged here so the next session
# sees this was a known, chosen consequence and not an unnoticed regression.

# Per-regime CATEGORY tilt (multipliers on CAT_BASE_WT). Rangebound/neutral = SIDEWAYS (no
# tilt). In risk-off regimes (BEAR/CRASH) overweight valuation/quality/dividend and
# underweight breakout/momentum to avoid chasing false breakouts into a falling tape; in
# BULL do the reverse. Categories absent from a regime's map keep their base weight.
REGIME_CAT_TILT = {
    'BULL': {
        'technical_breakout': 1.30, 'technical_momentum': 1.20, 'technical_trend': 1.10,
        'valuation': 0.90, 'fundamental_quality': 0.90,
    },
    'BEAR': {
        'valuation': 1.40, 'fundamental_quality': 1.30, 'income_dividend': 1.20,
        'technical_reversal': 0.80,
        'technical_breakout': 0.50, 'technical_momentum': 0.60,
    },
    'CRASH': {
        'valuation': 1.50, 'fundamental_quality': 1.40, 'income_dividend': 1.30,
        'technical_breakout': 0.30, 'technical_momentum': 0.40, 'technical_trend': 0.70,
    },
    'HIGH_VOL': {
        'fundamental_quality': 1.20, 'valuation': 1.15, 'volatility': 1.10,
        'technical_breakout': 0.70, 'technical_momentum': 0.80,
    },
    'SIDEWAYS': {},
}

# ── Finding #31 resolution (2026-07-31) ──────────────────────────────────────────────────
# REGIME_CAT_TILT above is hand-set intuition that has never been validated against outcomes.
# The audit left it open pending "regime-labeled outcome history". That history was measured
# directly this session, and the conclusion is that it will not arrive on any useful horizon:
#
#   independent regime EPISODES over the full market_regimes history (2023-11 -> 2026-07):
#       HIGH_VOL 172 · SIDEWAYS 170 · BEAR 14 · CRASH 6 · BULL 3
#   stock_factor_breakdown_history (the only per-category score history, 13 distinct dates):
#       SIDEWAYS 8 days · HIGH_VOL 4 · BEAR 1 · BULL 0 · CRASH 0
#
# So BULL and CRASH -- which carry the most extreme multipliers (0.30, 1.50) -- have ZERO days
# of per-category history and 3 and 6 lifetime episodes. Neither fitting the magnitudes NOR
# validating their sign is possible, and the 170+ HIGH_VOL/SIDEWAYS "episodes" are day-to-day
# alternation rather than durable regimes, so they do not supply independent samples either.
# Fitting on this would reproduce exactly the overfit-then-write bug Finding #42 fixed in
# strategy_optimizer.py.
#
# The resolution is therefore NOT to fit, and not to leave unvalidated intuition at full
# strength either: the tilts are treated as PRIORS and shrunk halfway toward neutral (1.0).
# Direction is economically defensible (don't chase breakouts into a crash) and is preserved;
# only the unjustifiable magnitude is damped. A 70% cut to breakout weight in CRASH is an
# opinion nobody has ever tested -- a 35% cut is the same opinion, held less confidently.
# Shrinkage is the standard treatment for a prior with no supporting sample.
TILT_SHRINKAGE = 0.5


def shrink_tilt(raw: float, shrinkage: float = TILT_SHRINKAGE) -> float:
    """Pull a hand-set multiplier toward neutral 1.0. shrinkage=0 -> no tilt at all,
    1.0 -> the raw hand-set value. Sign of the tilt (above/below 1.0) is always preserved."""
    return 1.0 + (raw - 1.0) * shrinkage


def regime_tilt_fit_readiness(conn, min_days: int = 60, min_episodes: int = 20) -> dict:
    """Report, per regime, whether enough history has accumulated to actually FIT the tilt.

    This exists so Finding #31 unblocks itself instead of sitting open forever: once a regime
    clears both thresholds, its tilt can be fitted from real outcomes and written to
    app_settings.optimal_regime_cat_tilt (already wired below). Advisory only -- nothing
    consumes the verdict, and it must never silently start fitting on thin data.
    """
    out = {}
    try:
        days = {r[0]: r[1] for r in conn.execute(
            "SELECT regime, COUNT(DISTINCT snapshot_date) FROM stock_factor_breakdown_history "
            "WHERE regime IS NOT NULL GROUP BY regime"
        ).fetchall()}
        rows = conn.execute("SELECT date, regime FROM market_regimes ORDER BY date").fetchall()
    except Exception as e:
        # Module-level function, no self -- route to stderr directly (see UnifiedRanker._degraded
        # for why stderr, not stdout: it's the one stream pythonRunner.ts's runPython() surfaces
        # as a log.warn() on an otherwise "successful" run).
        print(f"[UnifiedRanker] regime_tilt_fit_readiness unavailable: {e}", file=sys.stderr)
        return {}

    episodes, prev = {}, None
    for r in rows:
        rg = r[1]
        if rg != prev:
            episodes[rg] = episodes.get(rg, 0) + 1
        prev = rg

    for regime in REGIME_CAT_TILT:
        d, e = int(days.get(regime, 0)), int(episodes.get(regime, 0))
        out[regime] = {
            'factor_history_days': d,
            'regime_episodes': e,
            'ready_to_fit': d >= min_days and e >= min_episodes,
        }
    return out


_regime_tilt_override = None  # lazy-loaded: None = not yet checked, {} = checked, nothing learned yet


def _load_regime_tilt_override():
    """REGIME_CAT_TILT below is hand-set, never backtested — mirrors the same "dressed up as
    regime-aware, actually intuition" gap CATEGORY_WEIGHTS/SOURCE_WEIGHTS had before
    strategy_optimizer.py started fitting those from real outcomes. This wires the same
    override-from-app_settings pattern scoring_engine.py already uses for those, so a future
    backtest-fit tilt can be loaded here without another code change.

    CORRECTED 2026-07-31: this docstring used to say the blocker was that no per-category
    history table existed. stock_factor_breakdown_history DOES now exist and even carries a
    `regime` column — but it holds only 13 distinct dates (SIDEWAYS 8, HIGH_VOL 4, BEAR 1,
    BULL 0, CRASH 0), and BULL/CRASH have just 3 and 6 lifetime regime episodes. So the real
    blocker is sample size, not schema, and it is not a gap that waiting will close on any
    useful horizon. See TILT_SHRINKAGE above: rather than fit on thin data, the hand-set
    values are treated as priors and shrunk toward neutral.

    A fitted override written to app_settings.optimal_regime_cat_tilt still wins outright and
    is used UNSHRUNK — shrinkage exists to damp unvalidated intuition, and a value actually
    fitted from outcomes is not that. Use regime_tilt_fit_readiness() to check whether a
    regime has accumulated enough history to justify fitting before populating this key.
    """
    global _regime_tilt_override
    if _regime_tilt_override is not None:
        return _regime_tilt_override
    try:
        conn = connect()
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = 'optimal_regime_cat_tilt'"
        ).fetchone()
        _regime_tilt_override = json.loads(row['value']) if row and row['value'] else {}
    except Exception as e:
        # Module-level function, no self -- see the matching comment in
        # regime_tilt_fit_readiness() above.
        print(f"[UnifiedRanker] Could not load optimal_regime_cat_tilt override: {e}", file=sys.stderr)
        _regime_tilt_override = {}
    return _regime_tilt_override


def regime_cat_weights(regime):
    """CAT_BASE_WT with the regime's category tilt applied (returns a fresh dict; an unknown
    or SIDEWAYS regime yields a plain copy of CAT_BASE_WT).

    A fitted override from app_settings is applied at full strength. The hand-set
    REGIME_CAT_TILT fallback is shrunk toward neutral first (Finding #31) — it is a prior with
    no supporting sample, not a measurement.
    """
    override = _load_regime_tilt_override()
    if override:
        tilt = override.get(regime, {})
        return {cat: base * tilt.get(cat, 1.0) for cat, base in CAT_BASE_WT.items()}
    tilt = REGIME_CAT_TILT.get(regime, {})
    return {cat: base * shrink_tilt(tilt.get(cat, 1.0)) for cat, base in CAT_BASE_WT.items()}

CONVICTION_TIERS = [
    ('S_ELITE',    80),
    ('A_HIGH',     65),
    ('B_MEDIUM',   45),
    ('C_LOW',      25),
    ('D_MARGINAL',  1),
]

# Directional agreement floor (2026-08-10). A screener direction vote alone used to be enough
# to label a row at ANY composite score: bull>bear returned 'Buy' even at score 2, bear>bull
# returned 'Sell' even at score 98 -- only the *Strong* tiers ever consulted the score. A
# direction and a magnitude that flatly contradict each other are not an actionable call, so
# they now resolve to Hold. Expressed as ONE number mirrored around 50 (Buy needs
# score >= FLOOR, Sell needs score <= 100-FLOOR) so the long and short sides cannot drift
# apart -- an asymmetry between the two is precisely the class of bug this is fixing.
DIRECTIONAL_AGREEMENT_FLOOR = 45.0

# Position-size confidence coupling (2026-08-10). Sizing was bet/vol only, so the final score,
# conviction and engine coverage did not reach the allocation at all: a marginal Buy could be
# sized above a better-supported Strong Buy, and a row blended from 2 engines was sized
# identically to one blended from 8. This multiplier is bounded [FLOOR, 1.0] and can therefore
# only SHRINK a position -- the part of it that has not been backtested can reduce risk, never
# inflate it beyond what the validated probability/volatility core already allows.
SIZE_CONFIDENCE_FLOOR = 0.5
FULL_ENGINE_COVERAGE = 5


def _fund_mult(score):
    if score is None:
        return 1.0
    if score > 70:
        return 1.3
    if score < 40:
        return 0.7
    return 1.0


def _normalize_to_100(raw):
    """Percentile-rank normalization (0-100). Robust to outliers, unlike min-max which
    collapses the whole cluster toward 0 when a single extreme value sets the max."""
    if not raw:
        return {}
    n = len(raw)
    if n == 1:
        return {k: 50.0 for k in raw}
    values = list(raw.values())
    out = {}
    for k, v in raw.items():
        less = sum(1 for x in values if x < v)
        equal = sum(1 for x in values if x == v)
        out[k] = (less + 0.5 * equal) / n * 100.0
    return out


def _finite_engine_map(name, raw):
    """Drop non-finite (NaN/inf) scores from an engine map.

    A NaN score must be treated as *absent*, not as a value: `_blend` renormalizes over the
    engines that actually have data, so dropping the entry degrades that symbol to the other
    engines instead of poisoning the blend. Keeping it silently produces a NaN unified_score,
    which then falls through `_classify` (every comparison against NaN is False) to a plain
    'Buy' and through `_conviction` to 'D_MARGINAL' — i.e. a fabricated recommendation.

    This is not hypothetical: the BiLSTM checkpoints lstm_v3..v18 all carry 100% NaN weights,
    so every deep_learning_predictions.prob_up_5d has been NaN, which made 1563 of 1566 rows
    in unified_recommendations NaN-scored on 2026-07-31 before this guard existed.
    """
    if not raw:
        return raw
    clean = {k: v for k, v in raw.items() if v is not None and math.isfinite(v)}
    dropped = len(raw) - len(clean)
    if dropped:
        print(f"[UnifiedRanker] WARNING: engine '{name}' returned {dropped}/{len(raw)} "
              f"non-finite scores - those symbols are treated as having no {name} signal.",
              file=sys.stderr)
    return clean


# ── Zero-dispersion engine guard (2026-08-10) ────────────────────────────────────
# An engine that emits the SAME value for every symbol cannot rank anything, but it still
# consumes its full REGIME_WEIGHTS share in _blend. That is not harmless: _blend renormalizes
# over each symbol's own present-engine set, so a constant c contributes w/W * c where W
# varies BY COVERAGE GROUP -- injecting a meaningless coverage-dependent offset into
# cross-symbol comparisons. Dropping it is arithmetic, not a view on the engine's merit: the
# weight redistributes onto engines that actually vary, and symbols become comparable again.
#
# This is live, not theoretical. Measured on the 2026-08-10 snapshot (1,843 symbols):
#   ml         modal share 0.896   <- technical_signals.calibrated_win_probability had
#                                     EXACTLY 1 distinct value (0.7800, sd 0.0000) across all
#                                     2,193 rows, while raw win_probability had 1,501. The
#                                     isotonic calibrator is correctly reporting "no monotonic
#                                     edge in this regime"; the ranker was consuming that
#                                     verdict as if it were a score.
#   technical  modal share 0.863
#   => 28.4% of total blend weight was carried by engines with no cross-sectional dispersion.
#
# Threshold is deliberately ~zero dispersion, NOT a modal-share heuristic. A 50%-modal-share
# cutoff was tested over 29 ranker-days and was a wash (IC 0.0082 vs 0.0126, top-20 0.428%
# vs 0.378% -- neither significant), so it is not shipped. Only the unambiguous case is
# handled here, where inclusion is provably pure dilution rather than a judgement call.
ZERO_DISPERSION_EPS = 1e-9
ZERO_DISPERSION_MIN_SYMBOLS = 50   # below this a flat map is thin coverage, not a dead engine

# A near-flat engine is as unrankable as a perfectly flat one, and after the percentile
# normalization below it is strictly WORSE: _normalize_to_100 re-spreads any input, however
# narrow, to a uniform 0-100, so an engine whose whole universe sits in a 5-point band has its
# noise amplified to full weight instead of being harmlessly diluted. Under the old raw blend
# that engine contributed a near-constant offset (measured 1.1% of ranking influence on a
# 17.2% weight); normalized without this floor it would contribute 17.2% of pure noise. So
# this floor is not an independent tightening — it is required BY the normalization.
#
# Threshold derived from the data, not picked (recurring-bugs.md: measure the null first).
# Per-(engine, date) stddev over the 38 ranker-days with >=200 symbols, 2026-06-01..08-24,
# 138 engine-days, bucketed by 2 on the 0-100 score scale:
#   [0,2): 31   [2,4): 4   [4,6): 4   [6,8): 4   [8,10): 4   [10,12): 13   ... [28,30): 38
# Bimodal: a collapsed mode massed under 2 and the healthy mode from ~10 up, with a sparse
# valley between. 5.0 sits in that valley and errs toward keeping. It fires on real dates, not
# only pathological ones: ml_score is under it on 13 of 38 days, dl_score 15, technical 7 --
# the collapse is episodic (regime-dependent isotonic calibration), which is exactly why the
# check has to be dynamic per run rather than an engine being removed from REGIME_WEIGHTS.
ZERO_DISPERSION_MIN_SD = 5.0


def _stddev(vals):
    n = len(vals)
    if n < 2:
        return 0.0
    mean = sum(vals) / n
    return math.sqrt(sum((v - mean) ** 2 for v in vals) / (n - 1))


def drop_zero_dispersion_engines(engine_maps):
    """Remove engines whose scores carry no usable cross-sectional information.

    Returns (kept_maps, dropped_engine_names). Missing/thinly-covered engines pass through.
    """
    kept, dropped = {}, []
    for name, m in engine_maps.items():
        vals = list(m.values())
        if len(vals) >= ZERO_DISPERSION_MIN_SYMBOLS and (
            (max(vals) - min(vals)) <= ZERO_DISPERSION_EPS
            or _stddev(vals) < ZERO_DISPERSION_MIN_SD
        ):
            dropped.append(name)
            continue
        kept[name] = m
    return kept, dropped


def _blend(engine_scores, present_engines, weights):
    """Weighted blend that renormalizes weights over the engines that actually have data
    for this symbol, so missing engines (empty confluence/dl tables) don't deflate the score."""
    active = {e: weights[e] for e in weights if e in present_engines}
    wsum = sum(active.values())
    if wsum <= 0:
        return 0.0
    return sum(active[e] / wsum * engine_scores.get(e, 0.0) for e in active)


# ── Quality gate (#4) ───────────────────────────────────────────────────────────
# AMC overlay: a technical/screener breakout on a fundamentally rotten name is a value
# trap. Demote the unified score by a balance-sheet-quality multiplier so weak names can't
# rank as high-conviction buys. Uses the Piotroski F-score (the canonical cross-sector
# fundamental-strength screen — it already folds in leverage/liquidity trend) plus a
# negative-ROE flag. Missing data is neutral (financials/new listings legitimately lack it).
QUALITY_GATE_FLOOR = 0.5


def quality_gate(piotroski, roe, *, floor: float = QUALITY_GATE_FLOOR) -> float:
    """Fundamental-quality multiplier in [floor, 1.0]. None inputs are treated as neutral."""
    mult = 1.0
    if piotroski is not None:
        if piotroski <= 2:
            mult *= 0.6
        elif piotroski <= 4:
            mult *= 0.85
    if roe is not None and roe < 0:
        mult *= 0.8
    return max(floor, mult)


# ── Position sizing (#6) ────────────────────────────────────────────────────────
# Meta-labeling -> sizing: the ML ensemble's win_probability is a meta-label (P the long
# signal is correct). Instead of only gating it at 0.40, turn it into a bet size (López de
# Prado: z=(p-0.5)/sqrt(p(1-p)), size=2*Phi(z)-1) and weight by inverse volatility
# (vol-target), so high-conviction low-vol names get more capital. Normalized + per-name
# capped into suggested portfolio weights.
GROSS_EXPOSURE = 1.0     # weights sum to at most 100% of the long book
MAX_POSITION = 0.10      # per-name cap
VOL_FLOOR_PCT = 10.0     # don't let an ultra-low-vol name dominate
DEFAULT_VOL_PCT = 30.0   # when annualized_vol is missing
# Findings #27/#30 (2026-07-28 audit): the per-name cap alone lets N independently-sized but
# highly correlated same-sector names (e.g. IT-services riding the same USD/INR tailwind)
# each approach MAX_POSITION simultaneously — effective single-factor exposure far above what
# the flat gross cap implies. A rolling covariance matrix would be the fuller fix; this is the
# cheap first-order approximation the audit itself suggests: cap aggregate sector weight.
MAX_SECTOR_EXPOSURE = 0.30

# The breakout classifier is the one component with validated live edge (purged-OOF AUC ~0.61,
# top-decile 1.47× base rate). The ML win-prob meta-label it's blended against has ~0.50 AUC
# (no edge) outside BEAR, so sizing on win-prob alone leaves capital un-allocated in the dominant
# BULL/SIDEWAYS regimes. These map a name's cross-sectional breakout percentile to a sizing
# conviction on the same [0,1] scale as the López de Prado ML bet, so a top-decile breakout gets
# sized even when the ML label is asleep. Rank-based (not a raw-prob cut) because P(≥6% move) has
# a ~20-30% base rate, not 50% — a fixed 0.5 threshold would zero out nearly everything.
BREAKOUT_SIZE_P90 = 0.25   # top decile → conviction comparable to a ~0.63 ML win-prob bet
BREAKOUT_SIZE_P80 = 0.12   # top quintile → modest tilt


def bet_size_from_probability(p, neutral: float = 0.5) -> float:
    """López de Prado bet size in [0,1] from a win probability (long-only: 0 at/below neutral).

    isfinite guard: a NaN p fails `p <= neutral` (every NaN comparison is False), so without
    this it falls through to `min(1.0, nan)`, which -- because Python's min/max keep the FIRST
    argument when compared against NaN -- returns 1.0, the MAXIMUM bet size for an undefined
    probability. Same failure shape as the 2026-07-31 dl_score-into-'Buy' incident.
    """
    if p is None or not math.isfinite(p) or p <= neutral:
        return 0.0
    denom = math.sqrt(p * (1.0 - p))
    if denom <= 0:
        return 1.0
    z = (p - neutral) / denom
    cdf = 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))
    return max(0.0, min(1.0, 2.0 * cdf - 1.0))


def normalize_position_sizes(raw: dict, sectors: dict | None = None,
                              gross: float = GROSS_EXPOSURE, cap: float = MAX_POSITION,
                              sector_cap: float = MAX_SECTOR_EXPOSURE) -> dict:
    """Normalize raw conviction×inverse-vol sizes to portfolio weights (sum ≤ gross, each ≤
    cap), then apply a sector-concentration cap (Findings #27/#30): if a sector's aggregate
    weight exceeds sector_cap, scale every position in that sector down proportionally so the
    sector's total lands exactly at the cap. `sectors` is an optional {symbol: sector} map —
    omitted or empty, this is a no-op (unchanged behavior for callers that don't pass it).
    """
    total = sum(v for v in raw.values() if v and v > 0)
    if total <= 0:
        return {k: 0.0 for k in raw}
    weights = {k: min(cap, gross * max(0.0, (v or 0.0)) / total) for k, v in raw.items()}

    if sectors:
        sector_totals: dict = {}
        for sym, w in weights.items():
            sec = sectors.get(sym)
            if sec and w > 0:
                sector_totals[sec] = sector_totals.get(sec, 0.0) + w
        for sec, sec_total in sector_totals.items():
            if sec_total > sector_cap:
                scale = sector_cap / sec_total
                for sym in weights:
                    if sectors.get(sym) == sec:
                        weights[sym] *= scale

    return {k: round(v, 4) for k, v in weights.items()}


# ── Correlation-cluster exposure cap (#27/#30 follow-up, 2026-08-05) ────────────────────
# The sector cap above is the "cheap first-order approximation" its own comment already flags
# as needing a fuller covariance-based fix -- several independently-sized, highly-correlated
# names that don't share a GICS sector TAG (e.g. IT-services split across sub-sector labels,
# all riding the same USD/INR tailwind) can each individually approach MAX_POSITION and jointly
# carry far more single-factor exposure than the sector cap alone implies. This is that fuller
# fix's cheap first-order version: empirically cluster today's SIZED names by pairwise return
# correlation (not a static taxonomy) and apply the identical over-cap-then-scale-down
# mechanism the sector cap already uses, as a second pass on top of it.
MAX_CORRELATION_CLUSTER_EXPOSURE = 0.35
CORRELATION_CLUSTER_THRESHOLD = 0.65
# Minimum overlapping daily-return observations required to trust a pairwise correlation
# estimate. A short/sparse overlap (a recent listing, a long trading halt) can produce a
# spuriously high correlation on noise alone -- symbols without enough overlap are left OUT
# of every cluster rather than force-grouped on an untrustworthy number.
CORRELATION_MIN_OVERLAP = 20
RETURN_LOOKBACK_DAYS = 60


def _pearson(a: list, b: list):
    """Pearson correlation of two equal-length numeric sequences, or None if undefined
    (fewer than 2 points, or one series has zero variance -- e.g. a circuit-locked stretch)."""
    n = len(a)
    if n < 2 or n != len(b):
        return None
    mean_a, mean_b = sum(a) / n, sum(b) / n
    cov = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
    var_a = sum((x - mean_a) ** 2 for x in a)
    var_b = sum((y - mean_b) ** 2 for y in b)
    denom = math.sqrt(var_a * var_b)
    return cov / denom if denom > 0 else None


def cluster_by_correlation(returns: dict, threshold: float = CORRELATION_CLUSTER_THRESHOLD,
                            min_overlap: int = CORRELATION_MIN_OVERLAP) -> dict:
    """Pure function -- no DB access. `returns`: {symbol: {date: pct_return}} (date-keyed, not
    a plain list, so two symbols are compared on the SAME trading days rather than by list
    position -- different symbols miss different days for unrelated reasons -- holidays for a
    recently-listed name, a circuit lock, a data gap -- and positional alignment would silently
    pair the wrong days together and produce a spurious estimate).

    Union-find over every pair whose correlation clears `threshold`. Returns {symbol:
    cluster_id} ONLY for symbols placed in a cluster of size >= 2; a symbol with no correlated
    peer above threshold (or too little overlapping history to trust an estimate at all) is
    omitted entirely, so apply_correlation_cap leaves it untouched rather than grouping it into
    a meaningless catch-all bucket.
    """
    symbols = [s for s, r in returns.items() if len(r) >= min_overlap]
    parent = {s: s for s in symbols}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[ry] = rx

    for i, a in enumerate(symbols):
        for b in symbols[i + 1:]:
            common = sorted(returns[a].keys() & returns[b].keys())
            if len(common) < min_overlap:
                continue
            xs = [returns[a][d] for d in common]
            ys = [returns[b][d] for d in common]
            corr = _pearson(xs, ys)
            if corr is not None and corr >= threshold:
                union(a, b)

    groups: dict = {}
    for s in symbols:
        groups.setdefault(find(s), []).append(s)

    clusters: dict = {}
    for cid, (_root, members) in enumerate(g for g in groups.items() if len(g[1]) >= 2):
        for m in members:
            clusters[m] = cid
    return clusters


def apply_correlation_cap(weights: dict, clusters: dict,
                           cap: float = MAX_CORRELATION_CLUSTER_EXPOSURE) -> dict:
    """Pure function -- no DB access. Same over-cap-then-scale-down mechanism as the sector cap
    in normalize_position_sizes, keyed on empirical correlation clusters instead of a static
    sector label. `clusters` maps symbol -> cluster id only for symbols the caller placed in a
    real >=2-member cluster (see cluster_by_correlation) -- a symbol absent from `clusters` is
    left untouched here, so a missing or untrustworthy correlation estimate degrades to "no
    extra cap" rather than to an incorrect one. Can only ever reduce a position's weight, never
    raise it.
    """
    out = dict(weights)
    totals: dict = {}
    for sym, w in out.items():
        cid = clusters.get(sym)
        if cid is not None and w and w > 0:
            totals[cid] = totals.get(cid, 0.0) + w
    for cid, total in totals.items():
        if total > cap:
            scale = cap / total
            for sym in out:
                if clusters.get(sym) == cid:
                    out[sym] *= scale
    return {k: round(v, 4) for k, v in out.items()}


# Bounded score-fallback for directionless stocks (2026-08-05 pipeline-review finding,
# "direction and magnitude are decoupled" -- resolved per explicit user confirmation of the
# bounded-fallback approach over full multi-engine voting or leaving it as-is). Screeners keep
# FULL authority whenever they express ANY net opinion (bull != bear) -- this only changes the
# case where a stock is off every screener's radar for the day (total==0) or exactly tied
# (bull==bear, a genuine stand-off rather than silence): a multi-engine-consensus score this
# extreme is itself real evidence the ~1,700-screener catalog simply hasn't caught up to. The
# bar is set well ABOVE the existing Strong-tier gate (66/34) specifically so this fallback
# only ever fires on a genuinely standout blended score, never an ordinary one that happened to
# have no screener coverage that day.
#
# FLAG-GATED, DEFAULT OFF (2026-08-06, quant-review finding): the "genuinely standout blended
# score" premise above does not hold. Three of the eight engines -- screener, cs, confluence,
# technical -- are percentile-RANK normalized (_normalize_to_100: guarantees a uniform 0-100
# spread across the scored universe by construction, independent of whether the underlying
# signal is objectively strong that day). When a stock has no screener opinion (the ONLY case
# this fallback fires in), screener's weight (0.20-0.40, the single largest of the eight) is
# redistributed by _blend()'s renormalization onto the remaining seven -- and cs+confluence+
# technical alone can then represent over half of that redistributed weight (e.g. HIGH_VOL:
# cs 0.05 + confluence 0.12 + technical 0.24 = 0.41 of the 0.80 remaining after screener drops
# out). All three lean on the same underlying momentum/trend signal family (technical_score is
# a raw RSI/MACD composite; confluence's non-screener sum is trend_alignment_score +
# volume_score; cs_ranker is a cross-sectional alpha-percentile ranker) -- so on any day a
# cohort of stocks is genuinely "hot," that cohort ranks top-percentile on all three
# simultaneously and clears this fallback's 70/80 bar from shared momentum exposure alone, not
# from independent multi-engine agreement. This is not a hypothetical: the platform's own
# 2026-07-30/07-31 quant-strategy audits already measured short-horizon momentum to have
# NEGATIVE forward alpha on this exact universe (mom21: -0.53%/5d, t=-3.21; intraday
# vwap_dev/rvol: all negative, t up to -11) -- so a mechanism that manufactures broad "high
# score on every parameter" Buy/Strong Buy classifications specifically FOR stocks lacking the
# one genuinely independent, empirically-diverse check (screener consensus across ~1,700
# separately-built screens) is systematically leaning into the platform's own documented losing
# factor, not a validated edge. It also cannot be caught by is_red_flagged()'s hard veto, which
# reads the same (empty, by construction) screener membership list.
#
# Traced directly to a real-world symptom: a 60+-Telegram-alert burst reported the day after
# this fallback (and a companion websocketService.ts change removing an unrelated but
# accidentally-protective Telegram threshold) shipped. That burst's Telegram root cause was a
# separate, already-fixed gate (signals.py's AI-signal win_probability floor reverting to a
# degenerate 0.40 default -- see the CLAUDE.md session note dated 2026-08-06) -- but reviewing
# unified_recommendations for the same "why do so many stocks look great on every parameter"
# question surfaced this mechanism as a second, independent contributor to implausibly broad
# Buy/Strong Buy classification, on the canonical ranking table itself, not just the AI-signal
# side channel.
#
# Rather than delete the mechanism outright (its actual premise -- screeners under-cover the
# universe, and a stock can be genuinely strong before any screener catches up -- is real and
# was an explicit, considered decision), it is disabled by default (missing/non-'true'
# app_settings row = OFF, matching ml_calibration.is_edge_adjustment_enabled()'s established
# convention) until it can be validated against live/historical unified_recommendations data:
# specifically, whether stocks classified via this fallback path actually outperform, and
# whether requiring genuine cross-engine diversity (e.g. the non-percentile ml/dl/breakout
# engines, not just cs+confluence+technical) closes the gap. Flip with:
#   UPDATE app_settings SET value='true' WHERE key='directionless_score_fallback_enabled';
#   -- or INSERT if the key has never been set.
DIRECTIONLESS_STRONG_BUY_FLOOR  = 80.0
DIRECTIONLESS_BUY_FLOOR         = 70.0
DIRECTIONLESS_STRONG_SELL_CEIL  = 20.0
DIRECTIONLESS_SELL_CEIL         = 30.0


# ── Engine-level live edge (factor_edge.py measures unified_recommendations.*_score
# columns weekly, see queues.ts) → optional weight shrinkage ──────────────────────────
#
# factor_edge.py already answers "does this score column actually predict forward
# returns?" for third-party scores (Trendlyne DVM); it's now pointed at our OWN 8 blend
# engines too. This reads the latest verdict and shrinks an engine's REGIME_WEIGHTS share
# toward 0 when it's shown "no edge" on enough history -- same shrinkage philosophy as
# shrink_tilt() above, not a hard cutoff. Ships OFF by default: 30-ish accumulated trading
# days is not enough to act on yet (see the live run this shipped with -- every engine
# showed near-zero IC, consistent with the regime's already-known negative momentum, but
# too little history to trust as a standing decision). Flip on once factor_edge_history
# has enough dates per regime to be worth trusting:
#   UPDATE app_settings SET value='true' WHERE key='engine_edge_adjustment_enabled';
ENGINE_TO_SCORE_COL = {
    'screener': 'screener_stock_score', 'ml': 'ml_score', 'cs': 'cs_score',
    'confluence': 'confluence_score', 'technical': 'technical_score', 'dl': 'dl_score',
    'breakout': 'breakout_score', 'smart_money': 'smart_money_score',
}
ENGINE_EDGE_SHRINK = 0.5     # multiplier applied to a "no edge" engine's weight share
ENGINE_EDGE_HORIZON = 5      # which persisted horizon to read (matches the ranker's swing focus)


def is_engine_edge_adjustment_enabled(conn) -> bool:
    """Separate flag from is_edge_adjustment_enabled (that one calibrates win_probability;
    this one shrinks engine blend weights) -- different mechanism, different scope, deliberately
    not conflated. Defaults to OFF (missing row)."""
    try:
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = 'engine_edge_adjustment_enabled'"
        ).fetchone()
        return bool(row) and row['value'] == 'true'
    except Exception as e:
        # Module-level function, no self -- see the matching comment in
        # regime_tilt_fit_readiness() above.
        print(f"[UnifiedRanker] is_engine_edge_adjustment_enabled unavailable: {e}", file=sys.stderr)
        return False


def is_ic_tilt_enabled(conn) -> bool:
    """Gate for ic_tilted_weights(): app_settings 'engine_ic_tilt_enabled', default OFF
    (missing row), same convention as every other ranker flag here. When ON it supersedes
    is_engine_edge_adjustment_enabled (run() enforces the precedence)."""
    try:
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = 'engine_ic_tilt_enabled'"
        ).fetchone()
        return bool(row) and row['value'] == 'true'
    except Exception as e:
        print(f"[UnifiedRanker] is_ic_tilt_enabled unavailable: {e}", file=sys.stderr)
        return False


def load_engine_edge_verdicts(conn, regime: str, horizon: int = ENGINE_EDGE_HORIZON) -> dict:
    """engine -> verdict ('USABLE'/'no edge'/'LOW-DATA'/None) from the most recent
    factor_edge.py run against unified_recommendations, for this regime falling back to
    'ALL' when the regime-specific row doesn't exist (matches factor_edge's own groups)."""
    try:
        row = conn.execute(
            "SELECT MAX(run_at) AS r FROM factor_edge_history WHERE table_name = 'unified_recommendations'"
        ).fetchone()
        run_at = row['r'] if row else None
        if not run_at:
            return {}
        out = {}
        for engine, col in ENGINE_TO_SCORE_COL.items():
            r = conn.execute(
                "SELECT verdict FROM factor_edge_history WHERE run_at = ? AND table_name = "
                "'unified_recommendations' AND score_col = ? AND horizon_days = ? AND regime = ?",
                (run_at, col, horizon, regime)).fetchone()
            if not r:
                r = conn.execute(
                    "SELECT verdict FROM factor_edge_history WHERE run_at = ? AND table_name = "
                    "'unified_recommendations' AND score_col = ? AND horizon_days = ? AND regime = 'ALL'",
                    (run_at, col, horizon)).fetchone()
            out[engine] = r['verdict'] if r else None
        return out
    except Exception as e:
        # Module-level function, no self -- see the matching comment in
        # regime_tilt_fit_readiness() above.
        print(f"[UnifiedRanker] load_engine_edge_verdicts unavailable: {e}", file=sys.stderr)
        return {}


def edge_adjusted_weights(base_weights: dict, verdicts: dict) -> dict:
    """Pure function: shrink a REGIME_WEIGHTS dict's per-engine share toward 0 for any engine
    verdict-'no edge' (LOW-DATA/USABLE/None left untouched -- shrink only on demonstrated
    absence of edge, never on insufficient evidence). Renormalizes so weights still sum to 1."""
    adjusted = {
        e: (w * ENGINE_EDGE_SHRINK if verdicts.get(e) == 'no edge' else w)
        for e, w in base_weights.items()
    }
    total = sum(adjusted.values())
    if total <= 0:
        return dict(base_weights)
    return {e: w / total * sum(base_weights.values()) for e, w in adjusted.items()}


# ── IC-tilted engine weights (successor to binary edge_adjusted_weights) ──────
# Why this exists (AF-20260823-81 close-out): edge_adjusted_weights is BINARY -- it halves
# any engine whose persisted 5d verdict reads 'no edge'. Measured live 2026-08-24, every
# engine except dl grades 'no edge' at h=5 (dl +0.059 IC, technical +0.031, breakout +0.026,
# ml/cs/screener/confluence negative), so the binary rule halves nearly everything and the
# freed weight flows proportionally to LOW-DATA engines with NO evidence -- reallocation
# toward the unproven, not toward the proven. The magnitude information (the actual signed
# rank IC) is thrown away exactly where it is informative.
#
# ic_tilted_weights instead rescales each engine's share by its own measured 5d rank IC,
# clamped to [1+ENGINE_TILT_CLAMP, 1+ENGINE_TILT_CLAMP] so a single strong (or pathological)
# estimate cannot dominate, floored at 0 so a negatively-loaded engine never enters the buy
# blend inverted (a negative-IC engine is DROPPED here, not flipped -- sign flips are a
# different decision requiring their own evidence), and renormalized. Engines below
# ENGINE_IC_MIN_DATES distinct dates carry no reliable estimate (factor_edge's own
# MIN_DATES_RELIABLE bar) and pass through untouched.
#
# Gate: app_settings 'engine_ic_tilt_enabled' (default OFF, like every predecessor). When
# ON it SUPERSEDES engine_edge_adjustment_enabled -- the two must not stack (shrink-then-
# tilt would double-count the same evidence). run() enforces the precedence.
ENGINE_IC_MIN_DATES = 20
ENGINE_TILT_CLAMP = 0.75   # max |deviation| of an engine's multiplier from 1.0


def load_latest_engine_ics(conn, horizon: int = ENGINE_EDGE_HORIZON,
                           table_name: str = 'unified_recommendations__open_entry') -> dict:
    """engine -> {'ic': float, 'dates': int} from the most recent factor_edge_history run
    for this table/horizon (regime 'ALL'), or {} when nothing has ever been graded.
    Missing engines simply stay absent -- callers decide what absence means.
    Defaults to the __open_entry grades: that is the panel-spec entry convention
    (enter at next open, exit at the open N sessions later -- no untradeable overnight
    gap credit) and what blend_walkforward.py measures against, so tilt multipliers must
    come from the same label definition the harness validates. Close-entry rows stay
    available under table_name='unified_recommendations'."""
    try:
        row = conn.execute(
            "SELECT MAX(run_at) AS r FROM factor_edge_history "
            "WHERE table_name = ? AND horizon_days = ? AND regime = 'ALL'",
            (table_name, int(horizon))).fetchone()
        run_at = row['r'] if row else None
        if not run_at:
            return {}
        out = {}
        rows = conn.execute(
            "SELECT score_col, rank_ic, dates FROM factor_edge_history "
            "WHERE run_at = ? AND table_name = ? AND horizon_days = ? AND regime = 'ALL'",
            (run_at, table_name, int(horizon))).fetchall()
        for r in rows:
            for engine, col in ENGINE_TO_SCORE_COL.items():
                if col == r['score_col'] and r['rank_ic'] is not None and r['dates'] is not None:
                    out[engine] = {'ic': float(r['rank_ic']), 'dates': int(r['dates'])}
        return out
    except Exception as e:
        print(f"[UnifiedRanker] load_latest_engine_ics unavailable: {e}", file=sys.stderr)
        return {}


def ic_tilted_weights(base_weights: dict, engine_ics: dict,
                      min_dates: int = ENGINE_IC_MIN_DATES,
                      clamp: float = ENGINE_TILT_CLAMP) -> tuple:
    """Pure function -> (weights, report). Rescale each engine's share by
    min(1 + ic, 1 + clamp), floored at 0 -- an anti-predictive engine is shrunk toward
    zero-weight and only reaches literal 0 (dropped) once its IC <= -1; it is never
    inverted. Engines whose estimate carries >= min_dates distinct dates qualify;
    everything else passes through untouched. Renormalizes to the original total.
    Returns the ORIGINAL dict unchanged (identity, not copy-equal) when no engine qualifies."""
    report = {}
    touched = False
    adjusted = {}
    for e, w in base_weights.items():
        info = engine_ics.get(e) or {}
        ic, dates = info.get('ic'), info.get('dates', 0)
        if ic is None or dates is None or dates < min_dates:
            adjusted[e] = w
            continue
        mult = max(0.0, min(1.0 + ic, 1.0 + clamp))
        # 1 - clamp floor: a strongly negative IC drives the multiplier to 0 (dropped),
        # never negative (an anti-predictive engine must not enter the blend inverted).
        adjusted[e] = w * mult
        report[e] = {'ic': round(ic, 4), 'dates': dates, 'mult': round(mult, 4)}
        touched = True
    total = sum(adjusted.values())
    if not touched or total <= 0:
        return dict(base_weights), {}
    return ({e: w / total * sum(base_weights.values()) for e, w in adjusted.items()}, report)


#: Selectivity band the Buy floor is expected to land in, as a fraction of the scored
#: universe. NOT a target to tune the floor to -- purely a tripwire. Measured live
#: 2026-08-05..08-10, the same absolute floor selected 15.6% of the universe on 08-09 and
#: 1.2% on 08-10, a 13x swing driven entirely by two unrelated (and correct) engine fixes
#: landing the same day: the LSTM v4->v3 rollback (dl_score avg 78.5 -> 28.1) and the
#: _get_ml_scores edge adjustment (ml_score avg 70.8 -> 47.9). Nothing about the Buy rule
#: changed; the SCALE moved underneath it.
#:
#: That is the real fragility here: DIRECTIONLESS_BUY_FLOOR is an ABSOLUTE cut on a score
#: whose distribution is not stationary -- it shifts whenever an engine is fixed, rolled
#: back, or dropped by drop_zero_dispersion_engines(). Deliberately NOT "fixed" by
#: recalibrating the constant or switching to a percentile: measured per-date over the 30
#: dates with forward returns, NO score cut has significant edge (top-10 -0.242%/t=-0.57,
#: top-20 +0.102%/t=0.33, top-50 -0.215%/t=-1.02, top-100 -0.001%/t=-0.01, top-200
#: +0.160%/t=1.75 -- non-monotone, and the very top of the distribution is negative). There
#: is no evidence supporting 70, 60, or any percentile, so changing it would be a guess.
#: What CAN be done today is make the drift visible instead of discovering it as a 96%
#: collapse in actionable recommendations weeks later.
BUY_FLOOR_EXPECTED_SELECTIVITY = (0.03, 0.40)


def _report_buy_floor_selectivity(results, band=BUY_FLOOR_EXPECTED_SELECTIVITY):
    """Log what fraction of the scored universe cleared the Buy floor, and warn when the
    absolute floor has drifted out of its expected selectivity band. Pure reporting -- it
    never changes a score, a label, or a size."""
    total = len(results)
    if not total:
        return None
    buys = sum(1 for r in results if r.get('classification') in ('Buy', 'Strong Buy'))
    frac = buys / total
    lo, hi = band
    print(f'[UnifiedRanker] buy-floor selectivity: {buys}/{total} ({frac*100:.1f}%) cleared '
          f'DIRECTIONLESS_BUY_FLOOR={DIRECTIONLESS_BUY_FLOOR}', file=sys.stderr)
    if frac < lo or frac > hi:
        print(f'[UnifiedRanker] WARNING: buy-floor selectivity {frac*100:.1f}% is outside the '
              f'expected {lo*100:.0f}-{hi*100:.0f}% band. The floor is an ABSOLUTE cut on a '
              f'non-stationary score scale -- check whether an engine was fixed, rolled back, '
              f'or dropped for zero dispersion before reading this as a change in the market.',
              file=sys.stderr)
    return frac


def _classify(score, bull, bear):
    """Directional label (matches stock_scores taxonomy the Top Rated UI renders). Direction
    comes from the blended 0-100 score. Screener counts are accepted and IGNORED here -- they
    remain real, displayed, and still feed the score itself and is_red_flagged()'s hard veto;
    they just no longer get a direct vote on direction.

    DIRECTION RULE (2026-08-10, merged from two PRs that each measured half of it).

    Two independent changes reached opposite conclusions and the live data says BOTH were
    partly right, so this is neither one:

      * Screener DIRECTION (net bull-bear) used to decide Buy vs Sell. Measured against
        realised forward returns it is HARMFUL: Buy+Strong Buy under screener direction gave
        -0.440% 21d excess (t=-5.14) vs +0.758% (t=+2.39) under score thresholds, and net
        bias bucketed against forward return is monotone the WRONG way (<=-3: +2.90% ...
        >+3: +2.24%, rank IC -0.0159). The decisive case: score>=70 with net-BEARISH
        screeners is the BEST performing group at +3.015% (t=+3.60) -- a rule that requires
        screeners to agree throws exactly those away. So screeners get NO vote on direction.

      * Screener COVERAGE, separately, does matter. unified_score ranks returns within the
        covered population (IC +0.0241, t=+2.36) and NOT for uncovered names (-0.0150,
        t=-1.51, ~19% of rows); score>=70 with no screener opinion returns -0.066%
        (t=-0.12), i.e. nothing. Labelling a stock no screener has ever surfaced, on score
        alone, is labelling a population the score demonstrably does not rank.

    Hence: coverage is REQUIRED to label at all, direction comes purely from the score, and
    the bull/bear counts themselves are ignored. They remain real, displayed, and still feed
    the score and is_red_flagged()'s hard veto.

    This also satisfies DIRECTIONAL_AGREEMENT_FLOOR structurally and with margin -- a Buy
    always scores >= DIRECTIONLESS_BUY_FLOOR (70) and a Sell <= 30, against that constant's
    45/55 -- so direction and magnitude can no longer contradict by construction.

    HONEST LIMIT: 5-14 ranker days carry a full 21d window and they overlap, so every |t|
    here is inflated; the bearish-screener group is n=135 over 7 days. The case for this rule
    is that both halves are consistent with every other cut tried and nothing measured points
    the other way -- not that either is a clean significance test.
    """
    total = (bull or 0) + (bear or 0)
    if total == 0:
        # No screener has surfaced this name: the score does not rank this population.
        return 'Hold'
    if score >= DIRECTIONLESS_STRONG_BUY_FLOOR:
        return 'Strong Buy'
    if score >= DIRECTIONLESS_BUY_FLOOR:
        return 'Buy'
    if score <= DIRECTIONLESS_STRONG_SELL_CEIL:
        return 'Strong Sell'
    if score <= DIRECTIONLESS_SELL_CEIL:
        return 'Sell'
    return 'Hold'


def _directional_strength(score, classification):
    """How strongly the 0-100 unified score supports THE DIRECTION THIS ROW IS CLAIMING.

    The score is bullish-oriented (100 = maximally attractive long), so a bearish row's
    strength is its mirror image. Without this, conviction ran backwards on every short:
    a high-scoring plain Sell was persisted S_ELITE while a correctly low-scoring Strong
    Sell could only ever be D_MARGINAL. Hold has no direction and therefore no strength.
    """
    if classification in ('Strong Buy', 'Buy'):
        return score
    if classification in ('Strong Sell', 'Sell'):
        return 100.0 - score
    return 0.0


def _conviction(score, classification):
    """Conviction tier of the row's own direction. `classification` is REQUIRED — the
    single-argument form was the bug (see _directional_strength), so there is deliberately
    no default that would silently reinstate the bullish-only reading."""
    strength = _directional_strength(score, classification)
    if strength <= 0:
        return 'D_MARGINAL'
    for tier, threshold in CONVICTION_TIERS:
        if strength >= threshold:
            return tier
    return 'D_MARGINAL'


def size_confidence_multiplier(strength, coverage):
    """Bounded [SIZE_CONFIDENCE_FLOOR, 1.0], monotonically non-decreasing in BOTH inputs.

    Shrink-only by construction, so it cannot size a position above the probability/vol core
    that was actually backtested. `strength` is _directional_strength; `coverage` is the count
    of engines that genuinely informed the blend (len(present), not len(engine_maps_all)).
    """
    span = 100.0 - DIRECTIONAL_AGREEMENT_FLOOR
    q = max(0.0, min(1.0, (strength - DIRECTIONAL_AGREEMENT_FLOOR) / span)) if span > 0 else 0.0
    c = max(0.0, min(1.0, coverage / FULL_ENGINE_COVERAGE))
    return SIZE_CONFIDENCE_FLOOR + (1.0 - SIZE_CONFIDENCE_FLOOR) * q * c


def compute_screener_stock_scores(membership, fundamental_scores, cat_weights=None):
    """
    Pure function — no DB access.
    membership: {symbol: [{signal_bias, confidence, category, subcategory, investment_horizon}]}
    cat_weights: per-category weight map (defaults to CAT_BASE_WT); pass regime_cat_weights(regime)
                 to apply the regime-conditional tilt.
    Returns: (normalized_scores_0_100, bullish_counts, bearish_counts)
    """
    weights = cat_weights if cat_weights is not None else CAT_BASE_WT
    raw = {}
    bullish_counts = {}
    bearish_counts = {}

    for sym, screeners in membership.items():
        fm = _fund_mult(fundamental_scores.get(sym))
        contrib = sum(
            BIAS_SIGN.get(s['signal_bias'], 0.0)
            * weights.get(s['category'], 0.0)
            * SUBCAT_MOD.get(s.get('subcategory', ''), 1.0)
            * HORIZON_MULT.get(s.get('investment_horizon', 'swing'), 0.95)
            * float(s.get('confidence', 0.74))
            for s in screeners
        )
        raw[sym] = contrib * fm
        bullish_counts[sym] = sum(1 for s in screeners if s['signal_bias'] == 'bullish')
        bearish_counts[sym] = sum(1 for s in screeners if s['signal_bias'] == 'bearish')

    return _normalize_to_100(raw), bullish_counts, bearish_counts


# ── Red-flag hard veto ────────────────────────────────────────────────────────────
# A bearish Risk-Red-Flag screener (debt trap, high promoter pledge, auditor warning,
# ASM/GSM, wealth destroyer) is a SOLVENCY/governance veto — it must remove the name from
# the buy pool regardless of how strong its technical/momentum score is. A roaring breakout
# on a debt-trap microcap is exactly the trade that blows up an account. (A *bullish*
# risk-category event, e.g. pledge reduced, is not a veto.) Distinct from quality_gate,
# which only demotes weak fundamentals — this is a hard exclusion.
RED_FLAG_VETO_MULT = 0.5  # demote the unified score so a vetoed name also ranks low


def is_red_flagged(screeners) -> bool:
    return any(
        s.get('category') == 'risk_red_flags' and s.get('signal_bias') == 'bearish'
        for s in screeners
    )


def veto_classification(classification):
    """A vetoed name cannot be a Buy — collapse buy tiers to Hold, leave the rest."""
    return 'Hold' if classification in ('Strong Buy', 'Buy') else classification


# ── High-realized-volatility veto (2026-08-10) ───────────────────────────────────
# The single most statistically robust cross-sectional result available in this platform's
# own price history, and the only one that survives a 4.5-year test:
#
#   67 monthly rebalances (2022-02 -> 2026-07), liquid universe (>=1cr ADT), winsorized
#   +/-40%, 21-day forward return, entry at next open:
#       top-decile 21d realized vol   0.453%/month   vs universe 1.403%   -> -0.949%, t=-3.00
#       bottom-decile (low vol)       0.953%/month                        -> -0.450%, t=-1.38
#   For comparison, NOTHING else tested clears |t|>1.4: momentum_21d -0.158 (t=-0.51),
#   momentum_63d -0.175 (t=-0.55), reversal_5d +0.251 (t=1.08), reversal_21d +0.269 (t=0.97).
#
# So this is not an alpha source -- it is an EXCLUSION. Both tails underperform the mean
# (the middle of the vol distribution does best), but only the high tail is significant, and
# avoiding it costs nothing because it is a filter rather than an extra trade.
#
# WHY hv_20d AND NOT quant_scores.annualized_vol -- this distinction is load-bearing and was
# established by a refuted counterfactual, not by preference. annualized_vol is a 253-DAY
# window (institutional_quant_engine.py:85) and correlates only 0.366 with 21-day realized
# vol; running this exact veto on it REVERSES the sign (-0.272%/5d, t=-2.41 -- i.e. actively
# harmful), whereas the point-in-time hv_20d matches the quantity validated above and is
# directionally consistent (+0.303%/5d, t=0.94 over the 18 ranker-days available).
# quant_scores is also a CURRENT-SNAPSHOT table with no history, so it cannot be evaluated
# point-in-time at all. Do not "simplify" this to reuse the vol already loaded for sizing.
#
# Deliberately NOT changed: inverse-vol position sizing still uses annualized_vol. A 1-year
# vol is the standard, stable choice for sizing and nothing measured here contradicts it.
HIGH_VOL_VETO_PCTILE = 0.80   # exclude the top 20% most volatile names from the buy pool
HIGH_VOL_VETO_MULT = 0.7      # and demote the score so a vetoed name also ranks low


def high_vol_cutoff(vols, pctile: float = HIGH_VOL_VETO_PCTILE):
    """Cross-sectional realized-vol cutoff for today's universe, or None if unavailable.

    Cross-sectional rather than an absolute threshold on purpose: "volatile" is only
    meaningful relative to the rest of the tape on the same day, and an absolute cutoff would
    silently veto everything in a HIGH_VOL regime and nothing in a calm one.
    """
    clean = sorted(v for v in vols if v is not None and math.isfinite(v) and v > 0)
    if len(clean) < 50:
        return None      # too thin to define a percentile; fail open rather than veto blind
    return clean[min(len(clean) - 1, int(pctile * len(clean)))]


# ── Factor crowding (#28) ────────────────────────────────────────────────────────
# Mirrors multi_factor_scorer.py's FACTOR_WEIGHTS — duplicated rather than imported so this
# DB-only script doesn't pick up numpy/pandas as a new dependency just for one dict. Keep the
# two in sync if either changes.
_MF_FACTOR_WEIGHTS = {
    'mf_quality_score':  0.25,
    'mf_momentum_score': 0.30,
    'mf_value_score':    0.20,
    'mf_risk_adj_score': 0.15,
    'mf_macro_score':    0.10,
}
FACTOR_CROWDING_THRESHOLD = 0.70  # >70% of weighted deviation-from-neutral in one factor
FACTOR_CROWDING_DISCOUNT  = 0.90  # mild demotion (quality_gate's style), not a veto


def factor_crowding_multiplier(factor_scores: dict) -> tuple:
    """Finding #28 (2026-07-28 audit): multi_factor_scorer.py's orthogonal 5-factor breakdown
    (quality/momentum/value/risk-adj/macro) existed but was never used to check whether a
    name's composite score is genuinely diversified across factors, or one factor wearing a
    diversified-looking wrapper. Each factor is a cross-sectional percentile rank (0-100,
    neutral=50); this measures what share of the total weighted deviation-from-neutral traces
    to the single largest factor. Returns (multiplier, dominant_factor_or_None) — multiplier
    is 1.0 (no discount) when factor data is missing or no single factor dominates.
    """
    devs = {}
    for col, w in _MF_FACTOR_WEIGHTS.items():
        v = factor_scores.get(col)
        if v is not None:
            devs[col] = w * abs(v - 50.0)
    total = sum(devs.values())
    if total <= 0:
        return 1.0, None
    dominant = max(devs, key=devs.get)
    if devs[dominant] / total > FACTOR_CROWDING_THRESHOLD:
        return FACTOR_CROWDING_DISCOUNT, dominant
    return 1.0, None


_last_generated_at: "datetime | None" = None


def _next_generated_at() -> datetime:
    """Wall-clock UTC, but guaranteed STRICTLY INCREASING within this process.

    Why this is not just `datetime.now(timezone.utc)` (fixed 2026-08-15):

    `unified_recommendations_history` is PRIMARY KEY (symbol, generated_at) and its insert is
    `ON CONFLICT DO NOTHING` -- deliberately, because silently rewriting a snapshot is the exact
    failure that table exists to prevent. That design assumes two runs can never share a
    timestamp. They can: `datetime.now()`'s resolution is the SYSTEM CLOCK TICK, not the
    microseconds its ISO output implies. Measured on Windows 2026-08-15 --
    `time.get_clock_info('time').resolution` is 0.015625 s, and 2000 back-to-back
    `datetime.now(timezone.utc)` calls returned exactly ONE distinct value.

    `run()` over a small universe finishes well inside 15.6 ms, so two runs in quick succession
    (a retry, a double-trigger, a same-process re-run) produce the IDENTICAL generated_at, the
    ON CONFLICT fires, and the second run's ENTIRE snapshot is discarded with no error, no
    warning, and no row-count change to notice. That reproduces precisely the evidence loss
    documented in measurement.md: re-runs overwriting each other until the canonical ranker had
    only one provably pre-market date and could not be graded against forward returns at all.

    Linux (production pm2) has ~1 ns clock resolution, so live exposure is far smaller than on
    a Windows dev box -- but a snapshot table's uniqueness guarantee must not rest on how coarse
    the host's clock happens to be. Bumping by 1 microsecond on collision keeps the value a real
    wall-clock timestamp (it is used to prove a run was pre-market) while making the key
    reliable.

    Found via `test_history_snapshot_is_append_only_across_reruns`, which had been dismissed as
    an order-dependent flake for weeks -- it was reporting a real defect the whole time. Test
    ordering only changed how long the gap between the two runs was.
    """
    global _last_generated_at
    now = datetime.now(timezone.utc)
    if _last_generated_at is not None and now <= _last_generated_at:
        now = _last_generated_at + timedelta(microseconds=1)
    _last_generated_at = now
    return now


class UnifiedRanker:
    def __init__(self, conn=None, csv_path=None, corrections_path=None):
        self.conn = conn or connect()
        self.csv_path = Path(csv_path) if csv_path else CSV_PATH
        self.corrections_path = Path(corrections_path) if corrections_path else CORRECTIONS_PATH
        self._degraded_count = 0

    def _degraded(self, msg: str) -> None:
        """Report a query that degraded to an empty/fallback result instead of raising.
        Every one of ~30 read methods in this class does this by design (a missing/renamed
        table must not crash the nightly ranker), but until now they all printed to STDOUT,
        which pythonRunner.ts's runPython() never inspects -- only STDERR content triggers its
        '[PY] <script> finished successfully with warnings/stderr output' log.warn(), the one
        existing hook that makes a degraded-but-"successful" run visible without a human
        reading the raw log. Routes through that hook instead of adding new alerting.
        See recurring-bugs.md's "except Exception: pass does NOT contain the failure" and
        "A UNION half that supplies NULL... is inert, and its row count hides that" entries --
        same family: this run reported success while quietly producing less than it should.
        """
        self._degraded_count += 1
        print(msg, file=sys.stderr)

    def seed_screener_catalog(self):
        """Load screener_scoring_v2.csv into screener_catalog + apply corrections. Idempotent."""
        import re

        def slugify(s):
            return re.sub(r'[^a-z0-9]+', '-', s.lower().strip())[:120]

        rows = []
        with open(self.csv_path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                try:
                    name = row['screener_name'].strip()
                    # Handle both test CSV format (has screener_id column) and
                    # production CSV format (screener_scoring_v2.csv, no screener_id column)
                    screener_id = row.get('screener_id', '').strip() or slugify(name)
                    rows.append((
                        screener_id,
                        row['source'].strip().lower(),  # match screener_catalog_enricher.py's
                        # lowercase convention -- an uncontrolled-case source here re-splits an
                        # existing (screener_id, source) row into a second row on every reseed
                        # if the CSV's casing differs from what another writer already used for
                        # the same screener_id (cross-writer-collision-audit, 2026-08-14).
                        name,
                        row['category'].strip(),
                        row.get('subcategory', '').strip(),
                        row['signal_bias'].strip(),
                        row.get('investment_horizon', '').strip(),
                        float(row['confidence']),
                        float(row.get('score_0_100') or 0),
                        row.get('tier', '').strip(),
                        float(row.get('sub_mod') or 1.0),
                        float(row.get('horiz_mult') or 0.95),
                    ))
                except (KeyError, ValueError):
                    continue

        self.conn.executemany(
            '''INSERT INTO screener_catalog
               (screener_id, source, screener_name, category, subcategory,
                signal_bias, investment_horizon, confidence,
                score_0_100, tier, sub_mod, horiz_mult)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(screener_id, source) DO UPDATE SET
                 screener_name=excluded.screener_name, category=excluded.category,
                 subcategory=excluded.subcategory, signal_bias=excluded.signal_bias,
                 investment_horizon=excluded.investment_horizon, confidence=excluded.confidence,
                 score_0_100=excluded.score_0_100, tier=excluded.tier,
                 sub_mod=excluded.sub_mod, horiz_mult=excluded.horiz_mult''',
            rows,
        )

        if self.corrections_path.exists():
            with open(self.corrections_path, newline='', encoding='utf-8') as f:
                for corr in csv.DictReader(f):
                    name = corr.get('screener_name', '').strip()
                    if not name:
                        continue
                    try:
                        if corr.get('type') == 'bias':
                            self.conn.execute(
                                'UPDATE screener_catalog SET signal_bias=? WHERE screener_name=?',
                                (corr['corrected'], name),
                            )
                        elif corr.get('type') == 'subcategory':
                            self.conn.execute(
                                'UPDATE screener_catalog SET subcategory=? WHERE screener_name=?',
                                (corr['corrected'], name),
                            )
                    except Exception:
                        pass
        self.conn.commit()
        return len(rows)

    def _get_regime(self):
        row = self.conn.execute(
            'SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1'
        ).fetchone()
        if row:
            return row['regime'], float(row['regime_prob'] or 0.5)
        return 'BULL', 0.5

    # Empirically derived from the platform's full INDIAVIX history (2026-08-09 live audit,
    # 1170 rows): median~14.0, p75~17.2. regime_detector.py's HIGH_VOL/CRASH names are assigned
    # PURELY by relative rank among whichever 5 clusters a given retrain discovers -- "2nd/5th
    # most volatile of 5" says nothing about whether ANY of the 5 states is actually volatile in
    # absolute terms. Live-confirmed this session: HIGH_VOL was assigned to 07-29..08-07 with
    # real VIX=12.16-13.27 -- the platform's own BOTTOM QUARTILE of VIX history, i.e. calm, not
    # elevated. Since REGIME_WEIGHTS/regime_cat_weights key purely off the string name, that
    # silently applied "reduce risk" weight tilts to a genuinely calm market for those 8 sessions.
    _HIGH_VOL_VIX_FLOOR = 14.0  # historical median; below this "HIGH_VOL" overclaims
    _CRASH_VIX_FLOOR     = 17.2  # historical p75; below this "CRASH" overclaims

    def _effective_regime_for_weights(self, regime: str) -> str:
        """Downgrade HIGH_VOL/CRASH to their calmer neighbor for weight SELECTION only, when
        today's real India VIX doesn't support the volatility the name claims. Deliberately does
        NOT touch the stored market_regimes row, app_settings.current_nifty_regime, or the
        `regime` value this run reports/persists elsewhere -- this is a downstream safety net on
        top of regime_detector.py's own labeling, not a replacement for fixing it there."""
        if regime not in ('HIGH_VOL', 'CRASH'):
            return regime
        try:
            row = self.conn.execute(
                "SELECT close FROM macro_asset_prices WHERE symbol = 'INDIAVIX' "
                "ORDER BY date DESC LIMIT 1"
            ).fetchone()
        except Exception as e:
            # Missing the rollback every sibling except block has here would poison the
            # connection for every later read in this run (recurring-bugs.md: "except
            # Exception: pass does NOT contain the failure on Postgres").
            self.conn.rollback()
            self._degraded(f"[UnifiedRanker] VIX regime downgrade check unavailable: {e}")
            return regime
        vix = float(row['close']) if row and row['close'] is not None else None
        if vix is None:
            return regime  # nothing to second-guess the label with -- trust it
        if regime == 'HIGH_VOL' and vix < self._HIGH_VOL_VIX_FLOOR:
            print(f"[UnifiedRanker] Regime 'HIGH_VOL' downgraded to 'SIDEWAYS' for weight "
                  f"selection -- real VIX={vix:.2f} < {self._HIGH_VOL_VIX_FLOOR} historical-median floor.",
                  file=sys.stderr)
            return 'SIDEWAYS'
        if regime == 'CRASH' and vix < self._CRASH_VIX_FLOOR:
            print(f"[UnifiedRanker] Regime 'CRASH' downgraded to 'BEAR' for weight selection "
                  f"-- real VIX={vix:.2f} < {self._CRASH_VIX_FLOOR} historical-p75 floor.",
                  file=sys.stderr)
            return 'BEAR'
        return regime

    def _get_event_triggers(self, as_of):
        """symbol -> trigger text from stock_event_triggers (event_triggers.py).

        Advisory disclosure only: never touches unified_score. Degrades to {} if the table is
        absent or the job has not run, because a missing advisory must not break the ranker."""
        out = {}
        try:
            for r in self.conn.execute(
                "SELECT symbol, triggers FROM stock_event_triggers "
                "WHERE date = ? AND triggers IS NOT NULL AND triggers != ''", (as_of,)
            ).fetchall():
                out[r['symbol']] = r['triggers']
        except Exception as e:                                   # noqa: BLE001
            self._degraded(f"[UnifiedRanker] event triggers unavailable ({str(e)[:60]}); "
                  "recommendations will carry no event disclosure today.")
        if out:
            print(f"[UnifiedRanker] event triggers on {len(out):,} symbols", file=sys.stderr)
        return out

    def _get_fundamental_scores(self):
        rows = self.conn.execute(
            "SELECT symbol, score FROM stock_scores WHERE timeframe = 'long_term'"
        ).fetchall()
        return {r['symbol']: float(r['score'] or 50) for r in rows}

    def _get_quality_metrics(self):
        """Per-symbol quant metrics: balance-sheet quality (#4 gate) + annualized vol (#6 sizing)."""
        rows = self.conn.execute(
            "SELECT symbol, piotroski_f_score, return_on_equity, annualized_vol FROM quant_scores"
        ).fetchall()
        return {
            r['symbol']: {
                'piotroski': r['piotroski_f_score'],
                'roe': float(r['return_on_equity']) if r['return_on_equity'] is not None else None,
                'vol': float(r['annualized_vol']) if r['annualized_vol'] is not None else None,
            }
            for r in rows
        }

    def _get_win_probabilities(self):
        """ML meta-label per symbol: mean isotonic-calibrated win prob (fallback to raw) over
        recent technical signals. Calibrated value is honest, so sizing only backs real edge.

        When app_settings.edge_adjustment_enabled='true' (see ml_calibration.py), each row is
        additionally shrunk toward neutral (0.5) using its OWN stamped nifty_regime before
        averaging -- win_probability has real live discrimination only in some regimes (e.g.
        BEAR), so a symbol whose recent signals span both an edge-bearing and a no-edge regime
        blends correctly instead of being trusted uniformly. Off by default: identical to the
        prior plain-average behavior. Does NOT touch the existing max(ml_bet, bo_bet) breakout
        hedge in run() -- this only makes the ML leg honest, it doesn't remove the hedge that
        already covers for it in no-edge regimes."""
        cutoff = (date.today() - timedelta(days=30)).isoformat()
        # Raw win_probability FIRST (fix 2026-08-24): isotonic calibration collapses
        # dispersion when a regime has no live edge (~90% of HIGH_VOL rows sat pinned
        # near ~0.78), so preferring calibrated_win_probability made this average
        # near-constant -- sizing every name off a constant silently erases per-symbol
        # conviction even though the number looks stable.
        rows = self.conn.execute(
            "SELECT symbol, nifty_regime, COALESCE(win_probability, calibrated_win_probability) AS p "
            "FROM technical_signals WHERE date >= ? AND win_probability IS NOT NULL",
            (cutoff,)
        ).fetchall()

        from ml_calibration import is_edge_adjustment_enabled, edge_adjusted_probability, load_regime_edge_status
        enabled = is_edge_adjustment_enabled(self.conn)
        edge_status = load_regime_edge_status(self.conn) if enabled else {}

        acc: dict = {}
        for r in rows:
            p = r['p']
            # isfinite, not just `is None` -- a NaN win_probability/calibrated_win_probability
            # passes `IS NOT NULL` in SQL (NaN is a real float, not NULL) and passes `is None`
            # here too, then poisons the whole symbol's sum()/len() average with NaN, which
            # bet_size_from_probability then turns into a MAXIMUM bet size (see that function's
            # own guard, added alongside this one) -- the same NaN-is-truthy failure mode as
            # the 2026-07-31 dl_score incident, just in the win-probability leg instead.
            if p is None or not math.isfinite(p):
                continue
            p = float(p)
            if enabled:
                p = edge_adjusted_probability(p, r['nifty_regime'], edge_status)
            acc.setdefault(r['symbol'], []).append(p)
        return {sym: sum(v) / len(v) for sym, v in acc.items() if v}

    def _get_screener_membership(self):
        membership = {}

        # screener_master as a Python-side fallback map rather than a 4th SQL join. Joining
        # it inline made all three previously-working source queries depend on that one table
        # existing -- if it is missing they ALL fail and membership comes back completely
        # empty, which is a far worse failure than the coverage gap being closed. Loaded once,
        # degrades to {} on any error, and the sources stay independent of each other.
        master_bias = {}
        try:
            for r in self.conn.execute(
                "SELECT scan_id, source, inferred_sentiment FROM screener_master"
            ).fetchall():
                master_bias[(str(r['scan_id']), (r['source'] or '').lower())] = r['inferred_sentiment']
        except Exception as e:                                   # noqa: BLE001
            self._degraded(f"[UnifiedRanker] screener_master fallback unavailable ({str(e)[:60]}); "
                  "uncatalogued screeners will contribute with a neutral bias.")

        def _add(sym, bias, conf, cat, subcat, horizon, name=None, sid=None, src=None):
            if not sym:
                return
            if not bias and sid is not None:
                bias = master_bias.get((str(sid), (src or '').lower()))
            membership.setdefault(sym, []).append({
                'signal_bias': bias or 'neutral',
                'confidence': float(conf or 0.74),
                'category': cat or 'other',
                'subcategory': subcat or '',
                'investment_horizon': horizon or 'swing',
                'screener_name': name or '',
            })

        # LEFT JOIN, not JOIN, and falling back to screener_master (2026-08-10). The INNER
        # JOIN silently dropped every screener absent from screener_catalog -- measured live:
        # 410 of 423 etnow screeners (97%), 109 of 133 moneycontrol (82%), 295 of 910
        # trendlyne (32%). Those memberships never reached bull/bear counts or the screener
        # score at all, and nothing anywhere reported a number missing. screener_master
        # carries the same NLP-inferred sentiment for most of them, so it supplies the
        # fallback; a screener in NEITHER catalogue still contributes its membership with a
        # neutral bias (via _add's own default) rather than vanishing.
        #
        # et_marketstats was missing from this list entirely -- a whole 5th screener source
        # (95 screeners) that syncs, populates screener_master, and was then never read here.
        for source_query, _src, _idcol in [
            ("SELECT ss.symbol, ss.screener_id AS sid, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, sc.investment_horizon, COALESCE(ts.screener_name, sc.screener_name, sc.screener_id) AS sname FROM trendlyne_screener_stocks ss LEFT JOIN screener_catalog sc ON sc.screener_id = ss.screener_id AND LOWER(sc.source) = 'trendlyne' LEFT JOIN trendlyne_screeners ts ON ts.screener_id = ss.screener_id", 'trendlyne', 'sid'),
            ("SELECT ss.symbol, ss.scan_id AS sid, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, sc.investment_horizon, COALESCE(sc.screener_name, sc.screener_id) AS sname FROM moneycontrol_screener_stocks ss LEFT JOIN screener_catalog sc ON sc.screener_id = ss.scan_id AND LOWER(sc.source) = 'moneycontrol'", 'moneycontrol', 'sid'),
            ("SELECT ss.symbol, ss.screener_id AS sid, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, sc.investment_horizon, COALESCE(sc.screener_name, sc.screener_id) AS sname FROM etnow_screener_stocks ss LEFT JOIN screener_catalog sc ON sc.screener_id = ss.screener_id AND LOWER(sc.source) = 'etnow'", 'etnow', 'sid'),
            ("SELECT ss.symbol, ss.screener_key AS sid, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, sc.investment_horizon, COALESCE(sc.screener_name, ss.screener_key) AS sname FROM et_marketstats_screener_stocks ss LEFT JOIN screener_catalog sc ON sc.screener_id = ss.screener_key AND LOWER(sc.source) = 'et_marketstats'", 'et_marketstats', 'sid'),
        ]:
            try:
                for r in self.conn.execute(source_query).fetchall():
                    _add(r['symbol'], r['signal_bias'], r['confidence'],
                         r['category'], r['subcategory'], r['investment_horizon'],
                         name=r['sname'], sid=r['sid'], src=_src)
            except Exception as e:
                # Do NOT swallow silently: a broken membership query means every symbol
                # falls back to Hold/0-bull/0-bear with no error surfaced anywhere — the
                # ranker looks like it's running fine while producing no directional signal
                # at all. Log so a monitoring pass can catch it.
                self._degraded(f"[UnifiedRanker] Screener membership query failed: {e}")
                self.conn.rollback()

        if not membership:
            self._degraded("[UnifiedRanker] WARNING: screener membership is completely empty — "
                  "every symbol will classify as Hold with 0 bull/bear counts.")

        return membership

    def _get_screener_momentum_scores(self):
        """Load screener_momentum_score from technical_signals (stamped by screener_features_fetcher)."""
        # Calendar days cannot span a trading-day gap: Fri->Mon is 3 calendar days and a
        # long weekend is 4, so a short date.today() window can contain NO session, this
        # read returns {}, and _blend silently renormalizes over the engines that remain.
        # Measured: dl_score was 0 on 100% of rows for 5 of 8 Mondays. recurring-bugs.md.
        cutoff = as_of.trading_days_back(2, self.conn)[-1].isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, screener_momentum_score FROM technical_signals "
                "WHERE date >= ? AND screener_momentum_score IS NOT NULL "
                "ORDER BY date DESC",
                (cutoff,)
            ).fetchall()
            # Deduplicate: keep highest per symbol
            result = {}
            for r in rows:
                sym = r['symbol']
                val = float(r['screener_momentum_score'] or 0)
                if sym not in result or val > result[sym]:
                    result[sym] = val
            return result
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_screener_momentum_scores failed: {e}")
            self.conn.rollback()
            return {}

    def _get_ml_scores(self):
        # technical_signals.date is a text column; compare against a Python-computed cutoff
        # string (date('now',...) translates to a real date on Postgres -> text>=date error).
        # Calendar days cannot span a trading-day gap: Fri->Mon is 3 calendar days and a
        # long weekend is 4, so a short date.today() window can contain NO session, this
        # read returns {}, and _blend silently renormalizes over the engines that remain.
        # Measured: dl_score was 0 on 100% of rows for 5 of 8 Mondays. recurring-bugs.md.
        cutoff = as_of.trading_days_back(3, self.conn)[-1].isoformat()
        try:
            # Was AVG(win_probability) (raw) — inconsistent with _get_win_probabilities above,
            # which already reads the regime-fair calibrated value for sizing. This 'ml' score
            # feeds the composite unified_recommendations rank/classification directly, so the
            # same raw-vs-regime-honest gap applied to ranking, not just sizing. COALESCE keeps
            # not-yet-calibrated rows working on the raw value (2026-07-18 gating follow-up).
            #
            # 2026-08-10: per-row edge-adjustment added (mirrors _get_win_probabilities exactly,
            # see its docstring for the mechanism). Live-traced: HIGH_VOL's own isotonic
            # calibrator collapsed calibrated_win_probability to a near-constant ~0.78 for 90%
            # of the universe -- correctly reflecting HIGH_VOL's own live AUC of ~0.518 (no real
            # edge, per regime_edge_status), not a broken calibration. That near-constant value
            # was still carrying this engine's full regime weight (12-24%) in the
            # RANKING/CLASSIFICATION blend even though the platform already knew, via
            # regime_edge_status, that it had no edge right now -- only sizing ever consulted
            # that knowledge. Shrinking here too collapses a no-edge regime's near-constant
            # score toward neutral (50), so _blend's per-symbol renormalization leans on the
            # OTHER engines instead of diluting the ranking with what amounts to noise.
            # Raw-first swap (2026-08-24), matching the sizing query above: isotonic
            # calibration collapses dispersion in no-edge regimes, so the calibrated
            # column handed this engine a near-constant input that still carried its
            # full regime weight while contributing no cross-sectional rank information.
            rows = self.conn.execute(
                "SELECT symbol, nifty_regime, COALESCE(win_probability, calibrated_win_probability) AS p "
                "FROM technical_signals WHERE date >= ?",
                (cutoff,),
            ).fetchall()

            from ml_calibration import is_edge_adjustment_enabled, edge_adjusted_probability, load_regime_edge_status
            enabled = is_edge_adjustment_enabled(self.conn)
            edge_status = load_regime_edge_status(self.conn) if enabled else {}

            acc: dict = {}
            for r in rows:
                p = r['p']
                # isfinite, not just `is None` -- see _get_win_probabilities' identical guard
                # for the NaN-is-truthy failure mode this prevents.
                if p is None or not math.isfinite(p):
                    continue
                p = float(p)
                if enabled:
                    p = edge_adjusted_probability(p, r['nifty_regime'], edge_status)
                acc.setdefault(r['symbol'], []).append(p)
            return {sym: (sum(v) / len(v)) * 100 for sym, v in acc.items() if v}
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_ml_scores failed: {e}")
            self.conn.rollback()
            return {}

    def _get_realized_vol(self):
        """Point-in-time 20-day realized vol per symbol (hv_features.py -> technical_signals).

        Latest row per symbol within the lookback, NOT an average: vol is a level, and
        averaging across a regime shift blurs exactly the spike this veto exists to catch.
        See HIGH_VOL_VETO_PCTILE's comment for why this column and not quant_scores.
        """
        cutoff = (date.today() - timedelta(days=7)).isoformat()
        try:
            # ROW_NUMBER(), not DISTINCT ON: the latter is Postgres-only and is not translated
            # for the SQLite fallback path. Matches _get_confluence_latest_map() et al.
            rows = self.conn.execute(
                "SELECT symbol, hv_20d FROM ("
                "  SELECT symbol, hv_20d,"
                "         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn"
                "  FROM technical_signals WHERE date >= ? AND hv_20d IS NOT NULL"
                ") t WHERE rn = 1",
                (cutoff,),
            ).fetchall()
            return {r['symbol']: float(r['hv_20d']) for r in rows}
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_realized_vol failed: {e}")
            self.conn.rollback()
            return {}

    def _get_cs_scores(self):
        # Calendar days cannot span a trading-day gap: Fri->Mon is 3 calendar days and a
        # long weekend is 4, so a short date.today() window can contain NO session, this
        # read returns {}, and _blend silently renormalizes over the engines that remain.
        # Measured: dl_score was 0 on 100% of rows for 5 of 8 Mondays. recurring-bugs.md.
        cutoff = as_of.trading_days_back(3, self.conn)[-1].isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, AVG(cs_score) AS s FROM technical_signals "
                "WHERE date >= ? AND cs_score IS NOT NULL GROUP BY symbol",
                (cutoff,),
            ).fetchall()
            return _normalize_to_100({r['symbol']: float(r['s'] or 0) for r in rows})
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_cs_scores failed: {e}")
            self.conn.rollback()
            return {}

    def _restrict_to_tradeable_universe(self, symbols):
        """Drop anything that is not a real NSE instrument we can price.

        The screener sources feed in BSE-only/SME microcaps and, on 2026-07-30, a raw numeric
        id ('13510368') sitting in a symbol column -- 2,362 of that day's 3,959 ranked symbols
        were absent from nse_stocks. Those names have no sector/market-cap/liquidity data to
        risk-control on, and no stock_ohlcv history, so every backtest silently drops them:
        the backtested universe and the live recommended universe were different populations.
        """
        try:
            master = {r[0] for r in self.conn.execute(
                "SELECT symbol FROM nse_stocks").fetchall()}
            # stock_ohlcv.date is a native DATE column (unlike most date columns here, which
            # are TEXT carried over from SQLite) — compare it against a DATE, not ::text, or
            # Postgres throws "operator does not exist: date >= text".
            priced = {r[0] for r in self.conn.execute(
                "SELECT DISTINCT symbol FROM stock_ohlcv "
                "WHERE date >= CURRENT_DATE - 30").fetchall()}
        except Exception as e:
            # A failed statement poisons the whole transaction; without this rollback every
            # subsequent query in run() dies with InFailedSqlTransaction.
            try:
                self.conn.rollback()
            except Exception:
                pass
            self._degraded(f"[UnifiedRanker] universe restriction unavailable ({e}); ranking unfiltered")
            return symbols

        if not master or not priced:
            self._degraded("[UnifiedRanker] empty master/price universe; ranking unfiltered")
            return symbols

        keep = {s for s in symbols if s in master and s in priced}
        dropped = len(symbols) - len(keep)
        if dropped:
            sample = sorted(s for s in symbols if s not in keep)[:5]
            print(f"[UnifiedRanker] universe filter: kept {len(keep)}, dropped {dropped} "
                  f"non-tradeable/unpriced symbols (e.g. {sample})", file=sys.stderr)
        return keep

    def _get_confluence_scores(self):
        # symbol NOT LIKE guards reject the URL-shaped values a since-fixed
        # trendlyne_screener_discovery.py bug wrote into confluence_signals.symbol
        # (root cause: a blind "column 0" fallback when no header matched
        # nsecode/symbol) — defense in depth even after the legacy rows are purged,
        # in case a similar bug elsewhere reintroduces non-ticker values.
        #
        # DECORRELATION FIX (2026-08-05, screener double-counting finding): this used to read
        # confluence_signals.confluence_score directly, which is
        # screenerComponent(0-60) + trend(0-15) + volume(0-10) + sector(0-8) + fundamental(0-12)
        # (confluenceEngine.ts's scoreStock()) -- up to 60 of its ~105 raw points is the SAME
        # screener membership already blended in full as its own "screener" engine (20-40%
        # weight). REGIME_WEIGHTS treats "screener" and "confluence" as two independent
        # opinions; they were not -- a screener-driven mispricing was amplified across both.
        # confluence_signals already persists the four non-screener sub-scores as their own
        # columns (trend_alignment_score/volume_score/sector_strength_score/fundamental_score),
        # so this now sums exactly those four and drops screenerComponent entirely, without
        # touching confluenceEngine.ts or its own confluence_score output (still used as-is by
        # the standalone Confluence page, intraday_ranker.py, etc.) -- only what THIS engine
        # feeds into the unified blend changes. Percentile-normalized to 0-100 like
        # _get_technical_scores, since the raw sum tops out around 45, not 100.
        # Calendar days cannot span a trading-day gap: Fri->Mon is 3 calendar days and a
        # long weekend is 4, so a short date.today() window can contain NO session, this
        # read returns {}, and _blend silently renormalizes over the engines that remain.
        # Measured: dl_score was 0 on 100% of rows for 5 of 8 Mondays. recurring-bugs.md.
        cutoff = as_of.trading_days_back(1, self.conn)[-1].isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, "
                "  (COALESCE(trend_alignment_score,0) + COALESCE(volume_score,0) "
                "   + COALESCE(sector_strength_score,0) + COALESCE(fundamental_score,0)"
                "  ) AS non_screener_score "
                "FROM confluence_signals "
                "WHERE computed_at >= ? AND symbol NOT LIKE '%://%' AND LENGTH(symbol) <= 20",
                (cutoff,),
            ).fetchall()
            raw = {r['symbol']: float(r['non_screener_score'] or 0) for r in rows}
            return _normalize_to_100(raw)
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_confluence_scores failed: {e}")
            self.conn.rollback()
            return {}

    def _get_technical_scores(self):
        # Calendar days cannot span a trading-day gap: Fri->Mon is 3 calendar days and a
        # long weekend is 4, so a short date.today() window can contain NO session, this
        # read returns {}, and _blend silently renormalizes over the engines that remain.
        # Measured: dl_score was 0 on 100% of rows for 5 of 8 Mondays. recurring-bugs.md.
        cutoff = as_of.trading_days_back(3, self.conn)[-1].isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, AVG(signal_score) AS s FROM technical_signals WHERE date >= ? GROUP BY symbol",
                (cutoff,),
            ).fetchall()
            # signal_score is a 0-10 composite; percentile-normalize to 0-100 so it is on the
            # same scale as the other engines before blending.
            return _normalize_to_100({r['symbol']: float(r['s'] or 0) for r in rows})
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_technical_scores failed: {e}")
            self.conn.rollback()
            return {}

    def _get_dl_scores(self):
        # Calendar days cannot span a trading-day gap: Fri->Mon is 3 calendar days and a
        # long weekend is 4, so a short date.today() window can contain NO session, this
        # read returns {}, and _blend silently renormalizes over the engines that remain.
        # Measured: dl_score was 0 on 100% of rows for 5 of 8 Mondays. recurring-bugs.md.
        cutoff = as_of.trading_days_back(1, self.conn)[-1].isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, prob_up_5d AS probability FROM deep_learning_predictions WHERE prediction_date >= ?",
                (cutoff,),
            ).fetchall()
            return {r['symbol']: float(r['probability'] or 0) * 100 for r in rows}
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_dl_scores failed: {e}")
            self.conn.rollback()
            return {}

    def _get_breakout_scores(self):
        """Latest breakout_probability per symbol (technical_signals, written daily full-universe
        by breakout_classifier.py --score), scaled to 0-100 to sit on the same scale as the other
        engines. This is the model with the strongest durable OOS edge; it was advisory-only until
        it was added to REGIME_WEIGHTS/engine_maps here."""
        cutoff = (date.today() - timedelta(days=5)).isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, breakout_probability FROM technical_signals "
                "WHERE date >= ? AND breakout_probability IS NOT NULL ORDER BY date DESC",
                (cutoff,),
            ).fetchall()
            result = {}
            for r in rows:  # first row per symbol is the latest (ORDER BY date DESC)
                sym = r['symbol']
                if sym not in result:
                    result[sym] = float(r['breakout_probability'] or 0) * 100
            return result
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_breakout_scores failed: {e}")
            self.conn.rollback()
            return {}

    def _get_smart_money_scores(self):
        """Insider buying (technical_signals.insider_buy_pct_90d) +
        institutional block/bulk buy accumulation (block_deals.pct_transacted) +
        ranked institutional insights (institutional_deal_signals.deal_value_cr_1w)
        -- a genuinely orthogonal signal previously only surfaced on the standalone
        /smart-money page, now fully blended into the canonical score. Component
        score is the average of whichever of the three are present for a symbol.
        """
        # 1. Insider buying (30-day window to handle sparse updates)
        insider_cutoff = (date.today() - timedelta(days=30)).isoformat()
        insider_scores = {}
        try:
            rows = self.conn.execute(
                "SELECT symbol, insider_buy_pct_90d FROM technical_signals "
                "WHERE date >= ? AND insider_buy_pct_90d IS NOT NULL ORDER BY date DESC",
                (insider_cutoff,),
            ).fetchall()
            for r in rows:
                sym = r['symbol']
                if sym not in insider_scores:
                    insider_scores[sym] = float(r['insider_buy_pct_90d'] or 0) * 100
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_smart_money_scores (insider) failed: {e}")
            self.conn.rollback()

        # 2. Block/Bulk deal accumulation (90-day window)
        block_scores = {}
        try:
            deal_cutoff = (date.today() - timedelta(days=90)).isoformat()
            rows = self.conn.execute(
                "SELECT symbol, SUM(pct_transacted) AS total_pct FROM block_deals "
                "WHERE date >= ? AND trade_type = 'buy' AND pct_transacted IS NOT NULL "
                "GROUP BY symbol",
                (deal_cutoff,),
            ).fetchall()
            for r in rows:
                # 10% of float bought over 90d -> 100; scaled linearly, capped at 100.
                block_scores[r['symbol']] = min(100.0, float(r['total_pct'] or 0) * 10.0)
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_smart_money_scores (block deals) failed: {e}")
            self.conn.rollback()

        # 3. Ranked Institutional Insights (MoneyControl ranked feed)
        inst_scores = {}
        try:
            inst_cutoff = (date.today() - timedelta(days=14)).isoformat()
            rows = self.conn.execute(
                "SELECT symbol, SUM(deal_value_cr_1w) AS total_value FROM institutional_deal_signals "
                "WHERE deal_date >= ? AND action = 'buy' AND deal_value_cr_1w IS NOT NULL "
                "GROUP BY symbol",
                (inst_cutoff,),
            ).fetchall()
            for r in rows:
                # 500Cr+ in 2 weeks -> 100; scaled linearly, capped at 100.
                inst_scores[r['symbol']] = min(100.0, float(r['total_value'] or 0) / 5.0)
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_smart_money_scores (inst insights) failed: {e}")
            self.conn.rollback()

        result = {}
        for sym in set(insider_scores) | set(block_scores) | set(inst_scores):
            parts = [v for v in (insider_scores.get(sym), block_scores.get(sym), inst_scores.get(sym)) if v is not None]
            if parts:
                result[sym] = sum(parts) / len(parts)
        return result

    def _get_avg_track_record(self):
        cutoff = (date.today() - timedelta(days=90)).isoformat()
        try:
            row = self.conn.execute(
                "SELECT AVG(actual_return_pct) AS avg_r FROM recommendation_log WHERE generated_at >= ? AND actual_return_pct IS NOT NULL",
                (cutoff,),
            ).fetchone()
            return float(row['avg_r'] or 0)
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_avg_track_record failed: {e}")
            self.conn.rollback()
            return 0.0

    # Below this many resolved (symbol, 90d) outcomes, a negative average realized return is
    # noise, not a track record -- don't let it veto a symbol. Mirrors this codebase's own
    # established thin-sample convention (screener_performance.py's MIN_SIGNALS_FOR_TIER=5).
    MIN_RL_GATE_SAMPLES = 5

    # A sample count alone was never sufficient: `avg_r < 0` is a bare SIGN test, so a symbol
    # averaging -0.17% over 22 outcomes (t=-0.45, i.e. indistinguishable from zero) was
    # excluded from the ranked universe exactly as hard as one averaging -8%. Measured live
    # 2026-08-10: 519 of 958 eligible symbols (54%) were gated out, 359 of them (69%) on a
    # statistically insignificant negative -- and the excluded set does NOT underperform the
    # kept set at any horizon tested (point-in-time, 37 dates, liquid universe, 5d forward:
    # excluded-minus-kept +0.098%, t=1.22, excluded won on 51% of dates; splitting by evidence
    # strength doesn't rescue it either -- t<=-2 exclusions +0.148%/t=1.23, noise exclusions
    # +0.073%/t=0.77). So the gate's premise (a poor trailing record predicts poor forward
    # returns) is unsupported by this platform's own data, while its cost is real and
    # confirmed: SBCL sat outside the ranked universe from 2026-07-10 on a -0.174%/22-sample
    # average, then gained +19.08% on 2026-08-10 as the day's top liquid gainer.
    #
    # Requiring significance is the minimum defensible change: it drops exclusions 519 -> 160
    # and keeps the original intent for genuinely bad records. Note the surviving 160 are not
    # positively justified by the data either (t=1.23 is not evidence the gate helps) -- but
    # deleting a risk control outright on a non-significant result would be the same
    # over-reach in the other direction. Revisit once more resolved history accumulates.
    RL_GATE_MAX_T = -2.0

    def _get_rl_gate_map(self):
        """Pre-load per-symbol (avg realized return, sample count, stddev) over the trailing
        90d, once for the whole universe (was one query per symbol inside the run() loop).

        A sample stddev is carried so _passes_rl_gate can require the negative average to be
        statistically distinguishable from zero rather than merely negative -- see
        RL_GATE_MAX_T. It is derived here from SUM/SUM-of-squares/COUNT rather than SQL's
        STDDEV: STDDEV is Postgres-only and does not exist in the SQLite dev/test fallback,
        where it fails the whole query and silently returns an empty map -- i.e. it would
        disable the gate entirely instead of erroring. These three aggregates are portable.
        sd is None for a single sample (no sample variance defined)."""
        cutoff = (date.today() - timedelta(days=90)).isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, COUNT(*) AS cnt, SUM(actual_return_pct) AS s, "
                "SUM(actual_return_pct * actual_return_pct) AS ss "
                "FROM recommendation_log WHERE generated_at >= ? AND actual_return_pct IS NOT NULL "
                "GROUP BY symbol",
                (cutoff,),
            ).fetchall()
            out = {}
            for r in rows:
                cnt = int(r['cnt'] or 0)
                if cnt <= 0:
                    continue
                s = float(r['s'] or 0.0)
                mean = s / cnt
                if cnt > 1:
                    # Sample variance; clamp at 0 -- floating-point cancellation can make this
                    # a tiny negative when every value is identical.
                    var = max(0.0, (float(r['ss'] or 0.0) - cnt * mean * mean) / (cnt - 1))
                    sd = math.sqrt(var)
                else:
                    sd = None
                out[r['symbol']] = (mean, cnt, sd)
            return out
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_rl_gate_map failed: {e}")
            self.conn.rollback()
            return {}

    def _passes_rl_gate(self, symbol, rl_gate_map):
        """A track record of losing money (negative average realized return over the trailing
        90d) removes a symbol from the ranked universe entirely -- but only once there's enough
        history to trust the average. Without MIN_RL_GATE_SAMPLES this silently, permanently
        excluded symbols on as few as 1-2 stale outcomes with no log line anywhere: confirmed
        live (2026-08-06) 825 symbols platform-wide were excluded, 352 of them (43%) on fewer
        than 5 samples -- e.g. KECL, gated out on exactly 2 technical_scan misses from 2026-05
        (-5.25% avg) despite currently-strong scores across every other engine (cs_ranker 84.5,
        confluence 97.8, breakout 74.7)."""
        entry = rl_gate_map.get(symbol)
        if entry is None:
            return True
        avg_r, cnt, sd = entry
        if cnt < self.MIN_RL_GATE_SAMPLES:
            return True
        if avg_r >= 0:
            return True
        # Negative average -- but only exclude if it is distinguishable from zero.
        # sd is None only when a single sample survived the COUNT filter, which
        # MIN_RL_GATE_SAMPLES already precludes; there is nothing to test against, so pass.
        # sd == 0 is the opposite case and must NOT be read as "untestable": a perfectly
        # consistent negative (every resolved outcome identical and losing) is maximally
        # significant, t -> -inf, so it excludes.
        if sd is None:
            return True
        if sd > 0:
            t_stat = avg_r / (sd / math.sqrt(cnt))
            if t_stat > self.RL_GATE_MAX_T:
                return True
        else:
            t_stat = float('-inf')
        print(f"[UnifiedRanker] RL gate excluded {symbol}: "
              f"avg_return={avg_r:.2f}% over {cnt} resolved outcomes (90d), t={t_stat:.2f}",
              file=sys.stderr)
        return False

    def _get_confluence_latest_map(self):
        # Same symbol-shape guard as _get_confluence_scores (see comment there) — this
        # map has no freshness cutoff at all, so without the guard a URL-shaped "symbol"
        # would surface forever (it can never receive a real update since it isn't a
        # real ticker any fetcher will ever write again).
        try:
            rows = self.conn.execute("""
                SELECT * FROM (
                    SELECT symbol, entry_zone_low, entry_zone_high, stop_loss, target_1, target_2,
                           target_3, risk_reward, suggested_timeframe AS timeframe, trade_reasoning,
                           sector,
                           ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY computed_at DESC) AS rn
                    FROM confluence_signals
                    WHERE symbol NOT LIKE '%://%' AND LENGTH(symbol) <= 20
                ) t WHERE rn = 1
            """).fetchall()
            return {r['symbol']: r for r in rows}
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_confluence_latest_map failed: {e}")
            self.conn.rollback()
            return {}

    def _get_rec_log_latest_map(self):
        try:
            rows = self.conn.execute("""
                SELECT * FROM (
                    SELECT symbol, entry_price, stop_loss, target_1, target_2, target_3, timeframe,
                           reasoning AS trade_reasoning, sector,
                           ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY generated_at DESC) AS rn
                    FROM recommendation_log
                ) t WHERE rn = 1
            """).fetchall()
            return {r['symbol']: r for r in rows}
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_rec_log_latest_map failed: {e}")
            self.conn.rollback()
            return {}

    def _get_unified_signals_latest_map(self):
        # Long-direction rows only. unified_signals carries a real direction column with
        # genuinely different geometry conventions per direction (signals.ts's exit logic
        # treats long/short rows' stop/target oppositely). This fallback's own caller
        # (_get_entry_targets) only ever attaches its result to a long-entry-style setup
        # (entry_zone_low/high, target above, stop below -- see the fallback-2 branch this
        # mirrors), so an unfiltered "latest row regardless of direction" could hand a
        # Buy-classified row a short signal's inverted geometry.
        #
        # 'Bullish' added 2026-08-16. The safety property above is about DIRECTION, not about
        # the literal string 'BUY', and this table has no single signal_type vocabulary:
        # technical_analysis_engine.py (the largest writer) spells a long 'Bullish'. Excluding
        # it was not conservative, it was a coverage gap.
        #
        # Verified empirically before widening, not assumed -- measured live over the full
        # table, counting rows by where the target sits relative to the stop:
        #
        #   signal_type   rows     long-style   short-style
        #   BUY          33,772       32,512             0
        #   Bullish      13,192       13,192             0     <- identical convention, no exceptions
        #   Bearish      11,211        1,705         9,496     <- MIXED, must stay out
        #   SELL            451            0           451
        #
        # 'Bullish' is exactly as safe here as 'BUY'. 'Bearish' is deliberately NOT added: 15%
        # of its rows carry long-style geometry, so it fails the very test 'Bullish' passes.
        # Measured coverage effect: symbols with a usable row in this tier go 2,335 -> 2,393.
        # Not a scoring change (no score, weight, threshold or classification is touched) --
        # see the matching entry in .claude/rules/measurement.md.
        try:
            rows = self.conn.execute("""
                SELECT * FROM (
                    SELECT symbol, entry_price AS entry, target_price AS target,
                           stop_loss AS "stopLoss", reasoning AS trade_reasoning,
                           ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY signal_generated_at DESC) AS rn
                    FROM unified_signals
                    WHERE signal_type IN ('BUY', 'Bullish')
                ) t WHERE rn = 1
            """).fetchall()
            return {r['symbol']: r for r in rows}
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_unified_signals_latest_map failed: {e}")
            self.conn.rollback()
            return {}

    def _get_sector_map(self):
        try:
            rows = self.conn.execute("SELECT symbol, sector FROM nse_stocks").fetchall()
            return {r['symbol']: r['sector'] for r in rows}
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_sector_map failed: {e}")
            self.conn.rollback()
            return {}

    def _get_multi_factor_map(self):
        """Finding #28: multi_factor_scorer.py's 5-factor breakdown, keyed by symbol, for the
        factor-crowding check. Empty dict (safe no-op via factor_crowding_multiplier's own
        missing-data handling) until multi_factor_scorer.py has run at least once."""
        try:
            rows = self.conn.execute(
                """SELECT symbol, mf_quality_score, mf_momentum_score, mf_value_score,
                          mf_risk_adj_score, mf_macro_score
                   FROM quant_scores WHERE mf_composite_score IS NOT NULL"""
            ).fetchall()
            return {r['symbol']: dict(r) for r in rows}
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_multi_factor_map failed: {e}")
            self.conn.rollback()
            return {}

    def _get_recent_returns(self, symbols: list, lookback_days: int = RETURN_LOOKBACK_DAYS) -> dict:
        """{symbol: {date: pct_return}} from stock_ohlcv for the correlation-cluster cap
        (#27/#30 follow-up) -- date-keyed rather than a plain list so cluster_by_correlation
        can align two symbols on the SAME trading days (see that function's own docstring).
        Bad-bar-quarantined (is_suspect) the same way backtester.py/performance_tracker.py
        already are, so a flagged impossible-move bar can't manufacture a fake correlation.
        lookback_days is calendar days x2 to comfortably cover weekends/holidays within the
        window; this is a read-side cutoff, not an exact-match write key, so it carries none
        of the date.today()-anchor write-target risk documented elsewhere in this file.
        """
        if not symbols:
            return {}
        cutoff = (date.today() - timedelta(days=lookback_days * 2)).isoformat()
        placeholders = ','.join('?' for _ in symbols)
        try:
            rows = self.conn.execute(
                f"SELECT symbol, date, close FROM stock_ohlcv "
                f"WHERE symbol IN ({placeholders}) AND date >= ? AND close > 0 "
                f"AND (is_suspect IS NULL OR is_suspect = 0) "
                f"ORDER BY symbol, date",
                tuple(symbols) + (cutoff,),
            ).fetchall()
        except Exception as e:
            self._degraded(f"[UnifiedRanker] _get_recent_returns failed: {e}")
            self.conn.rollback()
            return {}

        by_symbol: dict = {}
        for r in rows:
            by_symbol.setdefault(r['symbol'], []).append((r['date'], float(r['close'])))

        out: dict = {}
        for sym, series in by_symbol.items():
            series.sort(key=lambda t: t[0])
            rets = {}
            for (d0, c0), (d1, c1) in zip(series, series[1:]):
                if c0 > 0:
                    rets[d1] = (c1 - c0) / c0
            if rets:
                out[sym] = rets
        return out

    def _get_entry_targets(self, symbol, confluence_map, rec_log_map, unified_map, sector_map):
        # Fallback 1: confluence_signals (best source with entry zones, atr, risk-reward, etc.)
        row = confluence_map.get(symbol)
        if row and (row['entry_zone_low'] is not None or row['stop_loss'] is not None):
            return {
                'entry_zone_low':  float(row['entry_zone_low'])  if row['entry_zone_low']  is not None else None,
                'entry_zone_high': float(row['entry_zone_high']) if row['entry_zone_high'] is not None else None,
                'stop_loss':       float(row['stop_loss'])       if row['stop_loss']       is not None else None,
                'target_1':        float(row['target_1'])        if row['target_1']        is not None else None,
                'target_2':        float(row['target_2'])        if row['target_2']        is not None else None,
                'target_3':        float(row['target_3'])        if row['target_3']        is not None else None,
                'risk_reward':     float(row['risk_reward'])     if row['risk_reward']     is not None else None,
                'timeframe':       row['timeframe'],
                'trade_reasoning': row['trade_reasoning'],
                'sector':          row['sector'],
            }

        # Fallback 2: recommendation_log
        # rr floor (2026-08-05): unlike fallback 1 (confluence_signals), whose own
        # buildTradeSetup() can only ever produce risk_reward in {2,3,4} by construction
        # (reward/risk cancels to the reward multiplier), this reads a genuinely independent
        # entry/stop/target triple and can legitimately compute rr<1 -- live production had
        # Buy-classified rows presenting e.g. a 0.69 R:R as an actionable long setup. A
        # sub-1 R:R isn't a data-integrity bug in the source row itself, but it's not a trade
        # plan this ranker should hand out as "Buy" geometry either -- fall through to the
        # next, hopefully-better source instead of accepting it.
        row = rec_log_map.get(symbol)
        if row and row['entry_price'] is not None:
            ep = float(row['entry_price'])
            sl = float(row['stop_loss']) if row['stop_loss'] is not None else None
            t1 = float(row['target_1']) if row['target_1'] is not None else None
            rr = None
            if sl is not None and ep - sl > 0 and t1 is not None:
                rr = round((t1 - ep) / (ep - sl), 2)
            if rr is None or rr >= 1.0:
                return {
                    'entry_zone_low':  round(ep * 0.99, 2),
                    'entry_zone_high': round(ep * 1.01, 2),
                    'stop_loss':       sl,
                    'target_1':        t1,
                    'target_2':        float(row['target_2']) if row['target_2'] is not None else None,
                    'target_3':        float(row['target_3']) if row['target_3'] is not None else None,
                    'risk_reward':     rr,
                    'timeframe':       row['timeframe'],
                    'trade_reasoning': row['trade_reasoning'],
                    'sector':          row['sector'],
                }

        # Fallback 3: unified_signals — same rr floor as fallback 2, same reasoning: fall
        # through to fallback 4 rather than accepting a sub-1 R:R setup. trade_reasoning is
        # not specially preserved here (unlike a returned row) — the caller's own
        # screener_summary fallback (see `if not et.get('trade_reasoning')` in run()) already
        # covers this case with equally relevant context (why the stock scored the way it did),
        # so there's nothing lost by falling through the same way fallback 2 does.
        row = unified_map.get(symbol)
        if row and row['entry'] is not None:
            ep = float(row['entry'])
            sl = float(row['stopLoss']) if row['stopLoss'] is not None else None
            t1 = float(row['target']) if row['target'] is not None else None
            rr = None
            if sl is not None and ep - sl > 0 and t1 is not None:
                rr = round((t1 - ep) / (ep - sl), 2)
            if rr is None or rr >= 1.0:
                return {
                    'entry_zone_low':  round(ep * 0.99, 2),
                    'entry_zone_high': round(ep * 1.01, 2),
                    'stop_loss':       sl,
                    'target_1':        t1,
                    'target_2':        None,
                    'target_3':        None,
                    'risk_reward':     rr,
                    'timeframe':       'SWING',
                    'trade_reasoning': row['trade_reasoning'],
                    'sector':          sector_map.get(symbol),
                }

        # Fallback 4: default fallback with sector only
        return {
            'entry_zone_low':  None,
            'entry_zone_high': None,
            'stop_loss':       None,
            'target_1':        None,
            'target_2':        None,
            'target_3':        None,
            'risk_reward':     None,
            'timeframe':       None,
            'trade_reasoning': None,
            'sector':          sector_map.get(symbol),
        }

    def run(self):
        # NOT date.today(): the pipeline deliberately runs early on closed days
        # (queues.ts's closed-day-early-batch), so a Saturday/Sunday run was stamping
        # computed_at with a day the market never opened -- 9,096 such rows across
        # 2026-07-05/07-12/07-25/08-09, unreachable to any consumer joining on a trading
        # date. logical_session_date() rolls a weekend forward to the session this ranking
        # is actually for. See as_of.py for why weekends only and not holidays.
        today = as_of.logical_session_date()
        # computed_at is a bare DATE and the upsert key is (symbol, computed_at), so a manual
        # same-day re-run silently replaces that morning's 07:30 IST cron row. Nothing recorded
        # WHEN a row was actually produced, which made this table ungradeable: a genuine
        # pre-market signal and a post-close re-run of the same date were indistinguishable, so
        # measuring a session against its own date's row could silently be look-ahead.
        # One timestamp for the whole run -- one run is one generation event, and a per-row
        # now() would imply a precision that does not exist.
        generated_at = _next_generated_at()

        if self.conn.execute('SELECT COUNT(*) FROM screener_catalog').fetchone()[0] == 0:
            self.seed_screener_catalog()

        regime, _conf     = self._get_regime()
        regime_for_weights = self._effective_regime_for_weights(regime)
        base_weights      = REGIME_WEIGHTS.get(regime_for_weights, REGIME_WEIGHTS['BULL'])
        if is_engine_edge_adjustment_enabled(self.conn) and not is_ic_tilt_enabled(self.conn):
            verdicts = load_engine_edge_verdicts(self.conn, regime_for_weights)
            base_weights = edge_adjusted_weights(base_weights, verdicts)
            print(f"[UnifiedRanker] engine edge adjustment applied: {verdicts}", file=sys.stderr)
        # IC-tilt supersedes the binary shrink when both flags are set -- running both would
        # apply the same factor_edge evidence twice (shrink-then-tilt double-counts).
        if is_ic_tilt_enabled(self.conn):
            engine_ics = load_latest_engine_ics(self.conn, horizon=ENGINE_EDGE_HORIZON)
            base_weights, tilt_report = ic_tilted_weights(base_weights, engine_ics)
            if tilt_report:
                print(f"[UnifiedRanker] IC-tilt applied: {tilt_report}", file=sys.stderr)
            else:
                print("[UnifiedRanker] IC-tilt enabled but no engine carries a reliable "
                      "(>=20-date) estimate yet -- weights unchanged.", file=sys.stderr)
        event_triggers_map = self._get_event_triggers(today)
        fund_scores       = self._get_fundamental_scores()
        quality_metrics   = self._get_quality_metrics()
        win_probs         = self._get_win_probabilities()
        membership        = self._get_screener_membership()
        screener_momentum = self._get_screener_momentum_scores()

        screener_scores, bull_counts, bear_counts = compute_screener_stock_scores(
            membership, fund_scores, cat_weights=regime_cat_weights(regime_for_weights)
        )

        # Blend pre-computed screener_momentum_score into the screener engine (10% boost cap).
        # Normalise momentum scores to 0-100 range before blending.
        if screener_momentum:
            max_mom = max(screener_momentum.values()) or 1.0
            for sym, mom in screener_momentum.items():
                boost = (mom / max_mom) * 10.0
                if sym in screener_scores:
                    screener_scores[sym] = min(100.0, screener_scores[sym] + boost)
        ml_scores         = self._get_ml_scores()
        cs_scores         = self._get_cs_scores()
        confluence_scores = self._get_confluence_scores()
        technical_scores  = self._get_technical_scores()
        dl_scores         = self._get_dl_scores()
        breakout_scores   = self._get_breakout_scores()
        smart_money_scores = self._get_smart_money_scores()
        avg_track         = self._get_avg_track_record()

        # Pre-loaded once for the whole universe (was up to 5 queries PER symbol inside
        # the loop below — _passes_rl_gate + the 4-tier _get_entry_targets fallback chain).
        rl_gate_map    = self._get_rl_gate_map()
        confluence_map = self._get_confluence_latest_map()
        rec_log_map    = self._get_rec_log_latest_map()
        unified_map    = self._get_unified_signals_latest_map()
        sector_map     = self._get_sector_map()
        mf_map         = self._get_multi_factor_map()

        # smart_money_scores deliberately excluded from this union: it should raise the
        # conviction of a stock already surfaced by another engine, not single-handedly
        # introduce a new stock into the ranking on insider/block-deal activity alone with no
        # technical/screener support.
        all_symbols = set(screener_scores) | set(ml_scores) | set(cs_scores) | set(confluence_scores) | set(technical_scores) | set(dl_scores) | set(breakout_scores)
        all_symbols = self._restrict_to_tradeable_universe(all_symbols)

        engine_maps = {
            'screener':    screener_scores,
            'ml':          ml_scores,
            'cs':          cs_scores,
            'confluence':  confluence_scores,
            'technical':   technical_scores,
            'dl':          dl_scores,
            'breakout':    breakout_scores,
            'smart_money': smart_money_scores,
        }
        # Sanitize before blending: a single engine emitting NaN would otherwise NaN every
        # score it touches, and NaN survives `if unified < 1` to be written as a fake 'Buy'.
        engine_maps = {name: _finite_engine_map(name, m) for name, m in engine_maps.items()}
        # A constant engine cannot rank but still eats its weight share — see
        # drop_zero_dispersion_engines() for the measurement and why the threshold is ~0.
        # NOTE the two maps below are deliberately different and must stay that way:
        #   engine_maps      -> BLEND only (constant engines removed, weight redistributes)
        #   engine_maps_all  -> REPORTING only (every engine, so the persisted *_score columns
        #                       still show what each engine actually said — a collapsed engine
        #                       reading a flat 59.89 is exactly the diagnostic you want kept)
        # Building engine_scores off engine_maps instead would KeyError on engine_scores['ml']
        # the first time an engine collapsed. That is not hypothetical: it crashed the first
        # live run of this change.
        engine_maps_all = engine_maps
        engine_maps, _flat = drop_zero_dispersion_engines(engine_maps)
        # Put every surviving engine on ONE scale before blending. Four engines
        # (screener/cs/confluence/technical) were already percentile-rank normalized; the four
        # probability engines (ml/dl/breakout/smart_money) return raw probability*100 and were
        # not. _blend is a weighted AVERAGE, so mixing the two scales broke it two ways —
        # measured live on the 2026-08-24 snapshot (2,075 symbols):
        #
        #  1. A weight was not an influence share. Influence is proportional to weight x
        #     dispersion, so at BULL weights the real shares were confluence 23.7%, screener
        #     21.0%, technical 14.2%, dl 12.7%, smart_money 10.9%, cs 8.5%, breakout 8.0% and
        #     ml 1.1% -- ml being the joint-HEAVIEST engine (0.172) whose live range was
        #     69.1-74.1, and smart_money getting 10.9% off a 0.064 weight purely by having the
        #     widest raw spread. REGIME_WEIGHTS was tuning numbers that were not what it thought.
        #  2. Missing-engine coverage became a signal, and the wrong one. _blend renormalizes
        #     over present engines, so dropping an engine shifted a symbol's score by that
        #     engine's MEAN OFFSET -- and the means ran 27.6 (smart_money) to 73.2 (ml). Live:
        #     symbols with 3 engines averaged 28.31 and were classified 91 Sell / 0 Buy, and
        #     the bottom-100 by unified_score averaged 4.94 engines against 6.75 universe-wide.
        #     Thin coverage was being routed to Sell mechanically.
        #
        # Normalizing here makes every engine mean-50 and uniformly spread, so a weight is an
        # influence share and a missing engine costs nothing but its own information. Applied to
        # the BLEND view only: engine_maps_all stays raw so the persisted *_score columns remain
        # the diagnostic they are meant to be, and so breakout's raw probability still drives
        # position sizing against its own p80/p90 thresholds.
        engine_maps_blend = {name: _normalize_to_100(m) for name, m in engine_maps.items()}
        if _flat:
            print(f"[UnifiedRanker] engines with ZERO cross-sectional dispersion dropped from "
                  f"the blend (weight redistributed): {', '.join(sorted(_flat))}", file=sys.stderr)

        results = []
        raw_sizes = {}   # symbol -> conviction×inverse-vol (normalized into weights after the loop)
        # Cross-sectional breakout cutoffs for the sizing tilt (see BREAKOUT_SIZE_* above).
        _bo_sorted = sorted(v for v in breakout_scores.values() if v is not None)
        def _bo_pctl(q):
            if not _bo_sorted:
                return None
            return _bo_sorted[min(len(_bo_sorted) - 1, int(q * len(_bo_sorted)))]
        bo_p90, bo_p80 = _bo_pctl(0.90), _bo_pctl(0.80)
        # High-realized-vol veto cutoff for today's tape (see HIGH_VOL_VETO_PCTILE).
        realized_vol = self._get_realized_vol()
        hv_cut = high_vol_cutoff(realized_vol.values())
        if hv_cut is None:
            print(f"[UnifiedRanker] high-vol veto INACTIVE (only {len(realized_vol)} symbols "
                  f"with hv_20d; need 50+). Buy pool is unfiltered for volatility today.",
                  file=sys.stderr)
        # How often each filter/multiplier actually fires. This exists because "the ranker has
        # too many layers" is an opinion until you can say which of them touch anything: a layer
        # that never fires is removable at zero risk, and one that fires constantly deserves
        # evidence it helps. Printed once per run; costs an integer increment per symbol.
        fired = {k: 0 for k in ('rl_gate_skip', 'nonfinite_or_tiny_skip', 'quality_gate',
                                'red_flag_veto', 'high_vol_veto', 'factor_crowding',
                                'ml_bet_nonzero', 'breakout_computed',
                                'breakout_ACTUALLY_BINDS', 'size_confidence_haircut')}
        for sym in all_symbols:
            if not self._passes_rl_gate(sym, rl_gate_map):
                fired['rl_gate_skip'] += 1
                continue

            # Reporting view: every engine, so the persisted *_score columns stay complete.
            engine_scores = {e: m.get(sym, 0.0) for e, m in engine_maps_all.items()}
            # Blend view: only engines that carry cross-sectional information for this symbol.
            present = {e for e, m in engine_maps.items() if sym in m}
            has_data = {e for e, m in engine_maps_all.items() if sym in m}
            # renormalize weights over engines that actually have data for this symbol, so
            # empty confluence/dl tables don't drag every score down to ~15. Blends the
            # NORMALIZED view (see engine_maps_blend) -- engine_scores stays raw for reporting
            # and for breakout's sizing thresholds below.
            blend_scores = {e: m.get(sym, 0.0) for e, m in engine_maps_blend.items()}
            unified = _blend(blend_scores, present, base_weights)

            # ORDERING INVARIANT (2026-08-10): every ordinary score MULTIPLIER runs here,
            # BEFORE the single _classify call, and nothing may touch `unified` after it.
            # Previously the factor-crowding discount was applied *after* classification, so a
            # row kept a Strong Buy/Buy label while the score persisted alongside it had already
            # fallen below that label's own threshold -- and _conviction then read the post-
            # multiplier score while the label came from the pre-multiplier one, i.e. the two
            # columns described different numbers. The categorical vetoes below are the only
            # thing allowed to change the label afterwards, because demoting is their whole
            # purpose; they apply their score multiplier here and their demotion there.
            qm = quality_metrics.get(sym)
            if qm:
                _qg = quality_gate(qm['piotroski'], qm['roe'])
                if _qg < 1.0:
                    fired['quality_gate'] += 1
                unified *= _qg

            # Red-flag hard veto: a bearish solvency/governance screener removes the name from
            # the buy pool no matter how strong its score is (then it also ranks low + unsized).
            red_flagged = is_red_flagged(membership.get(sym, []))
            if red_flagged:
                fired['red_flag_veto'] += 1
                unified *= RED_FLAG_VETO_MULT

            # High-realized-vol veto: the top vol decile underperformed the universe by
            # -0.949%/month (t=-3.00) over 67 monthly rebalances -- the only cross-sectionally
            # significant result in 4.5 years of this platform's own price history. A name only
            # missing hv_20d is NOT vetoed (fail open), same as every other missing-data path here.
            sym_vol = realized_vol.get(sym)
            high_vol_vetoed = (hv_cut is not None and sym_vol is not None and sym_vol >= hv_cut)
            # ponytail: a "Smart Money Override" bypassing this veto above sm_score>=80 was added
            # 2026-08-12 (ae3e369) and reverted the same day -- smart_money is unmeasured (see
            # measurement.md), its closest measured analogue (ticket_size) is significantly
            # inverted (t=-2.36), and the override had zero test coverage. Re-add only behind a
            # real factor_backtest.py run showing the bypassed names outperform.

            if high_vol_vetoed:
                fired['high_vol_veto'] += 1
                unified *= HIGH_VOL_VETO_MULT

            # Factor-crowding discount (#28): demote (not veto) names where >70% of the
            # multi-factor deviation-from-neutral traces to one factor — a high score that's
            # really just one undiversified bet wearing a diversified-looking wrapper.
            crowd_mult, crowd_factor = factor_crowding_multiplier(mf_map.get(sym, {}))
            if crowd_mult < 1.0:
                fired['factor_crowding'] += 1
                unified *= crowd_mult

            # Explicit non-finite check: `unified < 1` is False for NaN, so without this a
            # NaN score is written out and mislabelled 'Buy' by _classify's fall-through.
            if not math.isfinite(unified) or unified < 1:
                fired['nonfinite_or_tiny_skip'] += 1
                continue

            bull = bull_counts.get(sym, 0)
            bear = bear_counts.get(sym, 0)
            classification = _classify(unified, bull, bear)
            if red_flagged or high_vol_vetoed:
                classification = veto_classification(classification)
            strength = _directional_strength(unified, classification)

            # #6 position size: back the stronger of the two validated edges — the López de Prado
            # bet on the calibrated ML meta-label, OR a cross-sectional breakout tilt — inverse-vol
            # weighted, longs only. Breakout is additive (max, not a multiplier) because the ML bet
            # is ~0 in BULL/SIDEWAYS where win-prob has no edge, and a multiplier on 0 stays 0.
            ml_bet = bet_size_from_probability(win_probs.get(sym))
            bo_score = engine_scores['breakout']   # breakout_probability × 100, 0 if absent
            bo_bet = (BREAKOUT_SIZE_P90 if (bo_p90 and bo_score >= bo_p90)
                      else BREAKOUT_SIZE_P80 if (bo_p80 and bo_score >= bo_p80)
                      else 0.0)
            if ml_bet > 0:
                fired['ml_bet_nonzero'] += 1
            # Count BINDING, not merely non-zero: bet = max(ml_bet, bo_bet), so a breakout tilt
            # below the ML leg changes nothing. Counting bo_bet>0 measured that the branch ran,
            # not that it mattered -- which is how this layer stayed silently inert.
            if bo_bet > 0:
                fired['breakout_computed'] += 1
            if bo_bet > ml_bet:
                fired['breakout_ACTUALLY_BINDS'] += 1
            bet = max(ml_bet, bo_bet)
            vol = max(VOL_FLOOR_PCT, (qm or {}).get('vol') or DEFAULT_VOL_PCT)
            # Confidence coupling: bet/vol is the validated risk core; this can only shrink it,
            # so a marginal Buy or a thin-coverage row is sized below an equally-probable but
            # better-supported one instead of identically to it. Counted, not assumed -- if the
            # haircut never binds it is dead weight and this counter says so.
            conf_mult = size_confidence_multiplier(strength, len(present))
            if conf_mult < 1.0:
                fired['size_confidence_haircut'] += 1
            raw_sizes[sym] = (bet / vol * conf_mult) if classification in ('Strong Buy', 'Buy') else 0.0
            cats = sorted({s.get('category', 'other') for s in membership.get(sym, [])} - {'other', ''})
            # Store actual screener names (not just categories) for richer UI display
            sym_screeners = membership.get(sym, [])
            bull_names = sorted({
                s.get('screener_name', '') for s in sym_screeners
                if s.get('signal_bias') == 'bullish' and s.get('screener_name')
            })
            bear_names = sorted({
                s.get('screener_name', '') for s in sym_screeners
                if s.get('signal_bias') == 'bearish' and s.get('screener_name')
            })
            screener_names_payload = {
                'categories': cats,
                'bull_screeners': bull_names[:20],
                'bear_screeners': bear_names[:10],
            }
            screener_summary = (
                f"{bull} bullish / {bear} bearish screener signals ({classification}); "
                f"regime {regime}" + (f"; drivers: {', '.join(cats[:4])}" if cats else "")
                + ("; RED-FLAG VETO" if red_flagged else "")
                + (f"; FACTOR-CROWDED ({crowd_factor})" if crowd_mult < 1.0 else "")
            )

            et = self._get_entry_targets(sym, confluence_map, rec_log_map, unified_map, sector_map)
            # `trade_reasoning`'s fallback sources (confluence_signals, recommendation_log) are
            # looked up by bare symbol and narrate THEIR OWN, independently-timed bull/bear read
            # -- same mismatch already fixed for entry/stop/target above, just in text form.
            # Confirmed live 2026-08-13 (PNGSREVA): row classified Strong Sell/S_ELITE while its
            # confluence-sourced trade_reasoning read "35 bullish scanners..." in unhedged bullish
            # prose, and didn't even match this row's own screener_names_payload bull count (24).
            # Only trust the external narrative for an actionable long call; every other
            # classification gets the summary computed from THIS row's own counts.
            if not et.get('trade_reasoning') or classification not in ('Strong Buy', 'Buy'):
                et['trade_reasoning'] = screener_summary

            # Event-trigger disclosure. These are NOT in unified_score and deliberately do not
            # change it -- see event_triggers.py for the measurements and for why 22-36
            # overlapping windows in one regime is not enough to give them a weight. But a risk
            # flag that lives only in a table nobody reads is not a risk flag, so it is
            # surfaced on the row where the decision is actually made. A reader can act on it;
            # the score stays honest about what it does and does not incorporate.
            trig = event_triggers_map.get(sym)
            if trig:
                base = et.get('trade_reasoning') or ''
                et['trade_reasoning'] = f"{base} | ⚠ {trig}".strip(' |')

            # Direction/geometry backstop: `_get_entry_targets`'s 3 fallback sources
            # (confluence_signals, recommendation_log, unified_signals) are looked up by
            # bare symbol only, with no awareness of THIS row's own `classification` --
            # confluence_signals in particular can carry a long-only setup for a stock this
            # ranker itself classifies Sell/Strong Sell (different bull/bear-count mechanism,
            # confirmed live: Sell rows were storing entry/stop/target as if they were long
            # trade plans). position_size_pct is already zeroed for anything outside
            # Buy/Strong Buy (see raw_sizes above) -- extend that same "not an actionable long
            # entry" invariant to the geometry fields themselves, at the point of truth, so no
            # future drift in any upstream source can reintroduce this. trade_reasoning/sector
            # stay -- they're informational, not a trade plan.
            if classification not in ('Strong Buy', 'Buy'):
                for k in ('entry_zone_low', 'entry_zone_high', 'stop_loss',
                          'target_1', 'target_2', 'target_3', 'risk_reward', 'timeframe'):
                    et[k] = None

            results.append({
                'symbol':                  sym,
                'computed_at':             today,
                'generated_at':            generated_at,
                'regime':                  regime,
                'unified_score':           round(unified, 2),
                'conviction_level':        _conviction(unified, classification),
                'classification':          classification,
                'screener_names_json':     json.dumps(screener_names_payload),
                # has_data (not present): report what the engine said even if it was excluded
                # from the blend for zero dispersion — otherwise the column silently goes NULL
                # and the collapse becomes invisible in the very table you'd debug it from.
                # These 5 were missing the `has_data` guard the 3 below already use, so a
                # symbol with genuinely NO row from an engine (e.g. dl_score for a stock the DL
                # model never scored) was written as a literal 0.0 instead of NULL --
                # indistinguishable from a real score of 0, and the frontend's "n/a" vs "0"
                # display fix (AF-20260818-31) had nothing to key off. Fixed 2026-08-18
                # (AF-20260818-31, escalated from a frontend-only finding once traced here).
                # engine_scores[e] itself is untouched, and `unified` above was already computed
                # from `present`/`_blend()` before this dict is built -- this only changes what
                # gets WRITTEN to the reporting columns, not any score, weight, or classification.
                'screener_stock_score':    round(engine_scores['screener'], 2) if 'screener' in has_data else None,
                'ml_score':                round(engine_scores['ml'], 2) if 'ml' in has_data else None,
                'confluence_score':        round(engine_scores['confluence'], 2) if 'confluence' in has_data else None,
                'technical_score':         round(engine_scores['technical'], 2) if 'technical' in has_data else None,
                'dl_score':                round(engine_scores['dl'], 2) if 'dl' in has_data else None,
                'cs_score':                round(engine_scores['cs'], 2) if 'cs' in has_data else None,
                'breakout_score':          round(engine_scores['breakout'], 2) if 'breakout' in has_data else None,
                'smart_money_score':       round(engine_scores['smart_money'], 2) if 'smart_money' in has_data else None,
                'avg_engine_track_record': round(avg_track, 2),
                # len(present), NOT len(has_data): this backs the UI's "N/7 engines" badge, and
                # an engine that collapsed to a constant did not actually support the pick. The
                # badge therefore drops on days an engine dies — which is the honest signal, not
                # a regression. (Before the zero-dispersion guard the two sets were identical.)
                'engine_coverage_count':   len(present),
                'bullish_screener_count':  bull_counts.get(sym, 0),
                'bearish_screener_count':  bear_counts.get(sym, 0),
                'fundamental_score':       fund_scores.get(sym),
                'entry_zone_low':          None,
                'entry_zone_high':         None,
                'stop_loss':               None,
                'target_1':                None,
                'target_2':                None,
                'target_3':                None,
                'risk_reward':             None,
                'timeframe':               None,
                'trade_reasoning':         None,
                'sector':                  None,
                'position_size_pct':       0.0,
                **et,
            })

        # Normalize conviction×inverse-vol into capped portfolio weights (# 6), then apply the
        # sector-concentration cap (#27/#30) using the same sector_map already loaded above.
        _wp = [v for v in win_probs.values() if v is not None and math.isfinite(v)]
        if _wp:
            _lo, _hi = min(_wp), max(_wp)
            _mlb = bet_size_from_probability(sum(_wp) / len(_wp))
            print(f'[UnifiedRanker] win_probability spread {_lo:.4f}..{_hi:.4f} '
                  f'({len(set(round(v, 4) for v in _wp))} distinct) -> mean ML bet {_mlb:.3f}; '
                  f'breakout tilt caps at {BREAKOUT_SIZE_P90} so it can '
                  f'{"BIND" if BREAKOUT_SIZE_P90 > _mlb else "NEVER BIND"} under max().',
                  file=sys.stderr)
        _tot = len(all_symbols)
        print('[UnifiedRanker] layer firing counts over %d candidates: %s' % (
            _tot, ', '.join(f'{k}={v} ({v/max(1,_tot)*100:.1f}%)' for k, v in fired.items())),
            file=sys.stderr)
        _report_buy_floor_selectivity(results)
        position_sizes = normalize_position_sizes(raw_sizes, sectors=sector_map)

        # Correlation-cluster cap (#27/#30 follow-up, 2026-08-05): the sector cap alone can miss
        # highly-correlated names that don't share a GICS sector tag. Best-effort second pass --
        # a failure here must never block the ranker run, since sizes are already sector-capped
        # and safe to publish without it.
        try:
            sized_symbols = [s for s, v in raw_sizes.items() if v and v > 0]
            if sized_symbols:
                returns_map = self._get_recent_returns(sized_symbols)
                clusters = cluster_by_correlation(returns_map)
                if clusters:
                    position_sizes = apply_correlation_cap(position_sizes, clusters)
                    print(f"[UnifiedRanker] correlation cap applied to "
                          f"{len(set(clusters.values()))} cluster(s) covering {len(clusters)} symbols.",
                          file=sys.stderr)
        except Exception as e:
            self._degraded(f"[UnifiedRanker] correlation-cluster cap skipped: {e}")

        for r in results:
            r['position_size_pct'] = round(position_sizes.get(r['symbol'], 0.0) * 100, 2)

        # win_probability into each result row for unified_recommendations_history (the raw
        # meta-label behind position_size_pct; see migration 1787140000000). .get() keeps the
        # row NULL for symbols the ensemble had no finite probability for.
        for r in results:
            wp = win_probs.get(r['symbol'])
            if wp is not None and math.isfinite(wp):
                r['win_probability'] = float(wp)

        cur = self.conn.cursor()
        for r in results:
            cur.execute('''
                INSERT INTO unified_recommendations
                (symbol, computed_at, generated_at, regime, unified_score, conviction_level,
                 classification,
                 screener_names_json,
                 screener_stock_score, ml_score, confluence_score, technical_score, dl_score,
                 cs_score, breakout_score, smart_money_score,
                 avg_engine_track_record, engine_coverage_count, bullish_screener_count,
                 bearish_screener_count,
                 fundamental_score, entry_zone_low, entry_zone_high, stop_loss,
                 target_1, target_2, target_3, risk_reward, timeframe, trade_reasoning, sector,
                 position_size_pct)
                VALUES (:symbol, :computed_at, :generated_at, :regime, :unified_score,
                        :conviction_level, :classification,
                        :screener_names_json,
                        :screener_stock_score, :ml_score, :confluence_score, :technical_score,
                        :dl_score, :cs_score, :breakout_score, :smart_money_score,
                        :avg_engine_track_record, :engine_coverage_count,
                        :bullish_screener_count,
                        :bearish_screener_count, :fundamental_score, :entry_zone_low,
                        :entry_zone_high, :stop_loss, :target_1, :target_2, :target_3,
                        :risk_reward, :timeframe, :trade_reasoning, :sector,
                        :position_size_pct)
                ON CONFLICT(symbol, computed_at) DO UPDATE SET
                    -- Deliberately overwritten, not preserved: this row IS the later run's
                    -- output, so generated_at must describe the run that actually wrote what
                    -- is now stored. Keeping the first run's timestamp would label a
                    -- post-close re-run as pre-market -- the precise defect being fixed.
                    generated_at=excluded.generated_at,
                    regime=excluded.regime, unified_score=excluded.unified_score,
                    conviction_level=excluded.conviction_level, classification=excluded.classification,
                    screener_names_json=excluded.screener_names_json,
                    screener_stock_score=excluded.screener_stock_score, ml_score=excluded.ml_score,
                    confluence_score=excluded.confluence_score, technical_score=excluded.technical_score,
                    dl_score=excluded.dl_score, cs_score=excluded.cs_score,
                    breakout_score=excluded.breakout_score, smart_money_score=excluded.smart_money_score,
                    avg_engine_track_record=excluded.avg_engine_track_record,
                    engine_coverage_count=excluded.engine_coverage_count,
                    bullish_screener_count=excluded.bullish_screener_count,
                    bearish_screener_count=excluded.bearish_screener_count,
                    fundamental_score=excluded.fundamental_score,
                    entry_zone_low=excluded.entry_zone_low, entry_zone_high=excluded.entry_zone_high,
                    stop_loss=excluded.stop_loss, target_1=excluded.target_1,
                    target_2=excluded.target_2, target_3=excluded.target_3,
                    risk_reward=excluded.risk_reward, timeframe=excluded.timeframe,
                    trade_reasoning=excluded.trade_reasoning, sector=excluded.sector,
                    position_size_pct=excluded.position_size_pct
            ''', r)

            # Append-only point-in-time snapshot. The upsert above deliberately overwrites the
            # row for (symbol, computed_at) -- correct for a table meant to hold the CURRENT
            # ranking, but it destroys what the previous run said. Measured 2026-08-12: 37
            # computed_at dates existed and exactly ONE was provably pre-market, so the canonical
            # ranker could not be graded against forward returns at all.
            #
            # Keyed on generated_at (one timestamp per run, set once in run()), so a re-run adds
            # a row instead of replacing one. DO NOTHING, not DO UPDATE: within a single run this
            # key cannot legitimately repeat, and silently rewriting a snapshot is the exact
            # failure this table exists to prevent.
            #
            # GRADER CONTRACT (pin for whoever writes the ~late-Sept canonical-ranker grading):
            #   * Key everything on generated_at (timestamptz, real time-of-day). The text
            #     computed_at column copied here is a LOGICAL SESSION LABEL -- post-midnight IST
            #     runs legitimately stamp the prior trading day, so it carries NO usable
            #     time-of-day and must not drive entry-timing or pre-market filters.
            #   * Gradeable pre-market snapshot := MIN(generated_at) per (computed_at date,
            #     symbol), keeping only dates whose min time < 03:45 UTC (09:15 IST open).
            #     Live check 2026-08-23: 11 dates accumulated, 8 pass this filter.
            #   * computed_at may legitimately be a weekend/holiday day (logical session),
            #     so join outcomes on the NEXT TRADING DAY from stock_ohlcv, never on
            #     computed_at + N calendar days.
            cur.execute('''
                INSERT INTO unified_recommendations_history
                (symbol, computed_at, generated_at, regime, unified_score, conviction_level,
                 classification, screener_stock_score, ml_score, confluence_score,
                 technical_score, cs_score, dl_score, breakout_score, smart_money_score,
                 fundamental_score, engine_coverage_count, entry_zone_low, stop_loss,
                 target_1, position_size_pct, sector, win_probability)
                VALUES (:symbol, :computed_at, :generated_at, :regime, :unified_score,
                        :conviction_level, :classification, :screener_stock_score, :ml_score,
                        :confluence_score, :technical_score, :cs_score, :dl_score,
                        :breakout_score, :smart_money_score, :fundamental_score,
                        :engine_coverage_count, :entry_zone_low, :stop_loss, :target_1,
                        :position_size_pct, :sector, :win_probability)
                ON CONFLICT(symbol, generated_at) DO NOTHING
            ''', r)
        self.conn.commit()

        # Purge rows this run did not produce. The upsert key is (symbol, computed_at), so a
        # symbol scored by an earlier run today but dropped by this one (universe filter, RL
        # gate, or the non-finite guard above) would keep its stale row and still be ranked
        # by every consumer. Without this, re-running after a fix leaves the old bad rows behind.
        try:
            scored = [r['symbol'] for r in results]
            if scored:
                placeholders = ','.join('?' for _ in scored)
                cur.execute(
                    f"DELETE FROM unified_recommendations WHERE computed_at = ? "
                    f"AND symbol NOT IN ({placeholders})",
                    tuple([today] + scored),
                )
                if cur.rowcount:
                    print(f"[UnifiedRanker] purged {cur.rowcount} stale rows for {today} "
                          f"(scored by an earlier run, not by this one).", file=sys.stderr)
                self.conn.commit()
        except Exception as e:
            self._degraded(f"[UnifiedRanker] stale-row purge failed: {e}")
            self.conn.rollback()

        # Backfill sector from nse_stocks for any row still NULL/Unknown
        try:
            self.conn.execute("""
                UPDATE unified_recommendations ur
                SET sector = ns.sector
                FROM nse_stocks ns
                WHERE ur.symbol = ns.symbol
                  AND ur.computed_at = ?
                  AND (ur.sector IS NULL OR ur.sector IN ('Unknown', '', 'OTHER', 'NA'))
                  AND ns.sector IS NOT NULL
                  AND ns.sector NOT IN ('Unknown', '', 'OTHER', 'NA')
            """, (today,))
            self.conn.commit()
        except Exception as e:
            self._degraded(f"[UnifiedRanker] sector backfill failed: {e}")
            self.conn.rollback()

        breakdown = {}
        for r in results:
            c = r['conviction_level']
            breakdown[c] = breakdown.get(c, 0) + 1

        if self._degraded_count:
            # One unmissable line beyond the individual self._degraded() calls above --
            # someone skimming pm2 logs for "did tonight's run work" should not have to
            # notice N scattered stderr lines to learn the run degraded.
            self._degraded(
                f"[UnifiedRanker] SUMMARY: {self._degraded_count} read(s)/write(s) degraded "
                f"to an empty/fallback result this run -- see the lines above for which."
            )

        output = {'success': True, 'stocks_scored': len(results),
                  'conviction_breakdown': breakdown, 'regime': regime,
                  'degraded_count': self._degraded_count}
        print(json.dumps(output))
        return results


if __name__ == '__main__':
    ranker = UnifiedRanker()
    ranker.run()
