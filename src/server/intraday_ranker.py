#!/usr/bin/env python3
"""
Intraday stock ranker — FULLY ISOLATED from unified_ranker / unified_recommendations.

Ranks stocks for intraday trades from ONLY intraday-horizon signals:
  - intraday-classified screener confluence (screener_catalog.investment_horizon='intraday')
  - breakout_probability (technical_signals) — the one component with validated live edge
Gated/tilted by the intraday regime label (app_settings.intraday_regime, written by
intraday_regime.py) which fuses VIX/basis/MMI/breadth.

Writes ONLY to intraday_recommendations. Reuses unified_ranker's PURE scoring helpers but shares
no table or query with the positional pipeline, so unified_ranker output is never affected.

Run (market hours, every 15 min):  python intraday_ranker.py
"""
import json
import math
from datetime import date, datetime, timedelta

from db_compat import connect
# Index series stored alongside stocks in intraday_ohlcv -- excluded from the stock ranking.
from intraday_fetcher import _INDEX_SYMBOLS
from unified_ranker import (
    compute_screener_stock_scores,
    bet_size_from_probability,
    normalize_position_sizes,
    _classify,
    _conviction,
    VOL_FLOOR_PCT,
)
import sys

# Intraday-scaled ATR barriers — tighter than the positional 2.5×/1.5× (an intraday move plays out
# in hours, not the 5-15 day positional horizon).
STOP_ATR_MULT, TARGET_ATR_MULT = 0.6, 1.0
STOP_PCT_FLOOR, STOP_PCT_CAP = 0.005, 0.03       # 0.5%–3%
TARGET_PCT_FLOOR, TARGET_PCT_CAP = 0.008, 0.05   # 0.8%–5%

# Score blend, all components on a 0-100 scale. Must sum to 1.0 (asserted below -- the
# unified_ranker REGIME_WEIGHTS drift bug of 2026-07-23 was exactly this going unchecked).
#
# REBALANCED 2026-07-31 after the intraday audit. Both original components are
# momentum/breakout-flavoured, and momentum is the WRONG SIGN intraday: measured over 23
# sessions of 15m bars, every momentum feature has a NEGATIVE cross-sectional IC against the
# remainder of the session (vwap_dev -0.090 t=-5.7, or_pos -0.086, above_or -0.061,
# rvol -0.054 t=-7.4) and only "broke below the opening range" is positive (+0.059 t=+6.0).
# Graded honestly (entry at the next 15m bar open after the signal, exits only on later bars)
# this engine's Buy/Strong-Buy signals returned -0.099% gross against a -0.003% universe,
# t=-6.55 -- genuine negative alpha, not noise.
#
# W_REVERSAL introduces the one component that measured the right way round. Breakout is cut
# rather than removed: breakout_probability is the platform's only model with validated
# forward edge, but that edge is at a MULTI-DAY horizon (purged-OOF AUC ~0.61 on a 10-day
# forward label), which is not the horizon this file trades.
#
# These weights are deliberately conservative -- 23 sessions is not enough to fit weights on,
# and hand-fitting them here would repeat Finding #31. The load-bearing safety mechanism is
# EMISSION_GATE below, which is empirical; this rebalance only stops the score actively
# pointing the wrong way.
W_BREAKOUT, W_SCREENER, W_REVERSAL = 0.20, 0.40, 0.40

# Regime tilt — applied to both the final score AND (unlike before) position sizing, so a
# RISK_OFF regime actually shrinks exposure instead of just relabeling the same full-size bet.
REGIME_TILT = {"RISK_ON": 1.15, "NEUTRAL": 1.0, "RISK_OFF": 0.80}

# Event-risk haircut on position sizing (not a hard block -- same "soft multiplier" pattern as
# REGIME_TILT): a stock on its own F&O expiry day (gamma/unwind flows into the 3:00-3:30 PM
# close) or with quarterly results due imminently (a post-close print can still gap a position
# that wasn't squared off in time) carries risk beyond what the ATR-derived stop/target
# accounts for. <=1 day matches movement_predictor.py's own near-results threshold for
# consistency across the codebase.
EVENT_RISK_TILT = 0.70
RESULTS_IMMINENT_DAYS = 1

# News-sentiment tilt: a fresh news score in [-1, +1] nudges the blended score up to ±15%. News is
# sparse (only some names have coverage), so it modifies rather than drives the ranking.
NEWS_TILT_WEIGHT = 0.15

assert abs(W_BREAKOUT + W_SCREENER + W_REVERSAL - 1.0) < 1e-9, "blend weights must sum to 1.0"

# ── Emission gate ─────────────────────────────────────────────────────────────
# The engine may only publish actionable Buy/Strong-Buy classifications while its OWN realised
# net PnL over recent sessions is positive. This is the same champion/challenger discipline the
# ML engines in this codebase already apply to model promotion, applied to signal emission.
#
# Why a gate rather than simply flipping the sign: across 256 backtested configurations
# (8 signal families x 4 decision times x 4 exit rules x 2 basket sizes) over the liquid
# universe, the best net return at a generous 15bps round-trip was -0.004%. The intraday
# mean-reversion effect is real and robust in sign but its magnitude (~0.08-0.22% gross) sits
# below the cost floor, so a correctly-signed score is break-even, not profitable. Publishing
# Buy recommendations with measured-negative expectancy is the actual defect; the gate closes
# it and re-opens by itself if and when realised edge appears. Nothing is hardcoded off.
EMISSION_GATE_LOOKBACK_DAYS = 10
EMISSION_GATE_MIN_TRADES = 100      # below this the realised estimate is too noisy to trust
EMISSION_GATE_MIN_AVG_PNL = 0.0     # required trailing mean net PnL % per trade
# Escape hatch so the gate can be overridden deliberately (app_settings key, default off).
EMISSION_GATE_SETTING = "intraday_emission_gate_disabled"

# Sell/Strong-Sell mirror of the above, tracked independently (2026-08). Until this shipped,
# Sell classifications were never quality-gated at all -- they carry no entry/target/stop or
# position size (see the buy-pool-only sizing block below), but the CLASSIFICATION LABEL itself
# was still published with no evidence it's predictive, unlike Buy which the gate above protects.
# A long-side reversal edge existing says nothing about the short side: the 2026-07-31 intraday
# audit measured fading intraday strength at +0.838%/day gross (alpha +0.739%, t=2.88) on the
# full universe, but that collapses to +0.017%/day (alpha -0.031%, t=-0.27) once restricted to
# the F&O universe -- the only realistically shortable set most brokers actually offer. The whole
# apparent edge lived in unshortable small/mid caps. Gated the same way, on its own outcome
# history, so it can re-open on real evidence rather than staying permanently on or off by fiat.
EMISSION_GATE_SETTING_SHORT = "intraday_emission_gate_short_disabled"

# app_settings key the frontend reads for a live gate-state badge (both directions in one row,
# refreshed every run) -- see getIntradayEmissionGateStatus in misc.router.ts.
EMISSION_GATE_STATUS_KEY = "intraday_emission_gate_status"

# Minimum 20-day average daily turnover (₹ crore) to be eligible for an intraday recommendation.
# Intraday trades need enough same-day volume to enter AND exit without material slippage --
# unlike a positional trade, there's no multi-day window to work an illiquid fill.
MIN_TURNOVER_CR = 1.0

# Don't size NEW intraday entries in the last stretch before NSE close (15:30 IST) -- a signal
# firing this late has too little time left to reach an ATR target before same-day square-off.
LATE_CUTOFF_MINUTES_BEFORE_CLOSE = 45

# Max plausible same-day move vs. the last known daily close before an intraday_ohlcv price is
# treated as corrupt rather than real. NSE circuit limits cap a genuine one-day move at ~20%;
# anything beyond that is far more likely a symbol/provider-mapping bug than price action --
# found live 2026-07-17: nse_stocks.RELINFRA.mcsymbol was mapped to BSE Ltd's MoneyControl
# code, so intraday_ohlcv carried BSE's ~Rs 3589 price under RELINFRA's symbol (a 54x
# mismatch vs. RELINFRA's real ~Rs 66 close) -- 17 symbols total had the same class of bug.
PLAUSIBLE_INTRADAY_DEVIATION = 0.30
NSE_CLOSE_MINUTES_IST = 15 * 60 + 30  # 15:30 IST


def _wilder_atr(bars, period: int = 14) -> float:
    """Wilder ATR(period) from bars ascending by date; 0 when history is too short."""
    n = len(bars)
    if n < period + 1:
        return 0.0
    tr = []
    for i in range(1, n):
        h, l, c0 = bars[i]["high"], bars[i]["low"], bars[i - 1]["close"]
        tr.append(max(h - l, abs(h - c0), abs(l - c0)))
    val = sum(tr[:period]) / period
    for i in range(period, len(tr)):
        val = (val * (period - 1) + tr[i]) / period
    return val


def _atr_barriers(price: float, atr: float):
    """Intraday ATR-multiple target/stop, clamped to % guardrails (long-only)."""
    if not price or price <= 0:
        return None, None, None
    frac = (atr / price) if atr and atr > 0 else 0.0
    stop_frac = min(max(STOP_ATR_MULT * frac, STOP_PCT_FLOOR), STOP_PCT_CAP)
    tgt_frac = min(max(TARGET_ATR_MULT * frac, TARGET_PCT_FLOOR), TARGET_PCT_CAP)
    target = round(price * (1 + tgt_frac), 2)
    stop = round(price * (1 - stop_frac), 2)
    rr = round(tgt_frac / stop_frac, 2) if stop_frac > 0 else None
    return target, stop, rr


def _atr_barriers_short(price: float, atr: float):
    """Mirror of _atr_barriers for a short (Sell/Strong Sell) setup -- same ATR multiples and
    %% guardrails, direction inverted: target below entry, stop above. Used only to build the
    outcome-tracking geometry written to intraday_recommendations_history (see run() below);
    Sell rows in the user-facing intraday_recommendations table still carry no entry/stop/
    target/size, same as before -- this does not make Sell an actionable trade to display."""
    if not price or price <= 0:
        return None, None, None
    frac = (atr / price) if atr and atr > 0 else 0.0
    stop_frac = min(max(STOP_ATR_MULT * frac, STOP_PCT_FLOOR), STOP_PCT_CAP)
    tgt_frac = min(max(TARGET_ATR_MULT * frac, TARGET_PCT_FLOOR), TARGET_PCT_CAP)
    target = round(price * (1 - tgt_frac), 2)
    stop = round(price * (1 + stop_frac), 2)
    rr = round(tgt_frac / stop_frac, 2) if stop_frac > 0 else None
    return target, stop, rr


class IntradayRanker:
    def __init__(self, conn=None):
        self.conn = conn or connect()

    def _intraday_membership(self):
        """Screener memberships restricted to intraday-relevant screeners (same join shape as
        unified_ranker._get_screener_membership, filtered to investment_horizon IN
        ('intraday', 'short_term')). 'short_term' is included alongside 'intraday' because
        screener_catalog_enricher.py inserts rows under that coarser label for screeners
        screener_scoring_v2.csv doesn't classify -- excluding it left ~109 real screeners
        (vs. ~92 tagged 'intraday') invisible to this ranker."""
        membership = {}

        def add(sym, bias, conf, cat, sub, name):
            if not sym:
                return
            membership.setdefault(sym, []).append({
                "signal_bias": bias or "neutral",
                "confidence": float(conf or 0.74),
                "category": cat or "other",
                "subcategory": sub or "",
                "investment_horizon": "intraday",
                "screener_name": name or "",
            })

        queries = [
            # symbol NOT LIKE guard: defense in depth against the URL-as-symbol corruption
            # class (root cause: a since-fixed trendlyne_screener_discovery.py bug; a DB
            # CHECK constraint now blocks it at the source, this is a second layer).
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, "
             "COALESCE(ts.screener_name, sc.screener_name, sc.screener_id) sname "
             "FROM trendlyne_screener_stocks ss "
             "JOIN screener_catalog sc ON sc.screener_id=ss.screener_id AND LOWER(sc.source)='trendlyne' "
             "LEFT JOIN trendlyne_screeners ts ON ts.screener_id=sc.screener_id "
             "WHERE sc.investment_horizon IN ('intraday', 'short_term') "
             "AND (ss.symbol IS NULL OR ss.symbol NOT LIKE '%://%')"),
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, "
             "COALESCE(sc.screener_name, sc.screener_id) sname "
             "FROM moneycontrol_screener_stocks ss "
             "JOIN screener_catalog sc ON sc.screener_id=ss.scan_id AND LOWER(sc.source)='moneycontrol' "
             "WHERE sc.investment_horizon IN ('intraday', 'short_term')"),
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, "
             "COALESCE(sc.screener_name, sc.screener_id) sname "
             "FROM etnow_screener_stocks ss "
             "JOIN screener_catalog sc ON sc.screener_id=ss.screener_id AND LOWER(sc.source)='etnow' "
             "WHERE sc.investment_horizon IN ('intraday', 'short_term')"),
        ]
        for sql in queries:
            try:
                for r in self.conn.execute(sql).fetchall():
                    add(r["symbol"], r["signal_bias"], r["confidence"],
                        r["category"], r["subcategory"], r["sname"])
            except Exception as e:
                print(f"[IntradayRanker] membership query skipped: {str(e)[:80]}", file=sys.stderr)
        return membership

    def _restricted_symbols(self) -> set:
        """Symbols under NSE surveillance (ASM/GSM). Many GSM stages (and T2T-segment ASM
        stocks) settle delivery-only -- intraday square-off isn't permitted by the exchange,
        so recommending an entry/target/stop meant to be closed same-day is not just risky,
        it may describe a trade the exchange won't let through. nse_stocks.is_asm/gsm_stage
        are the live, actively-synced surveillance flags (verified populated as of today);
        backtester.py's own ASM/GSM filter reads from a separate asm_gsm_stocks table that
        does not exist on this database, so deliberately not reused here."""
        try:
            rows = self.conn.execute(
                "SELECT symbol FROM nse_stocks WHERE is_asm=1 OR gsm_stage>0"
            ).fetchall()
            return {r["symbol"] for r in rows}
        except Exception as e:
            print(f"[IntradayRanker] surveillance filter skipped: {str(e)[:80]}", file=sys.stderr)
            return set()

    def _liquid_symbols(self, symbols: set) -> set:
        """Symbols clearing MIN_TURNOVER_CR average daily turnover over the last 20 sessions.
        Intraday trades need enough same-day volume to enter AND exit without material
        slippage; there's no multi-day window to work an illiquid fill like a positional
        trade has."""
        if not symbols:
            return set()
        ph = ",".join("?" for _ in symbols)
        cutoff = (date.today() - timedelta(days=30)).isoformat()
        rows = self.conn.execute(
            f"SELECT symbol, AVG(volume * close) AS avg_turnover FROM stock_ohlcv "
            f"WHERE symbol IN ({ph}) AND date >= ? AND COALESCE(is_suspect,0)=0 "
            f"GROUP BY symbol", tuple(symbols) + (cutoff,)
        ).fetchall()
        min_turnover = MIN_TURNOVER_CR * 1e7  # crore -> rupees
        return {r["symbol"] for r in rows if (r["avg_turnover"] or 0) >= min_turnover}

    def _breakout_scores(self):
        """Latest breakout_probability per symbol, scaled to 0-100 (same source as unified_ranker)."""
        cutoff = (date.today() - timedelta(days=7)).isoformat()
        rows = self.conn.execute(
            "SELECT symbol, breakout_probability FROM technical_signals "
            "WHERE date>=? AND breakout_probability IS NOT NULL ORDER BY date DESC", (cutoff,)
        ).fetchall()
        out = {}
        for r in rows:
            if r["symbol"] in out:
                continue
            # isfinite, not `or 0`: NaN is TRUTHY, so `float(nan or 0)` is nan, not 0 -- the
            # exact idiom that let a NaN dl_score be written as a fake 'Buy' (2026-07-31).
            # Skip rather than coerce: a non-finite probability is absent, and coercing it to
            # 0 would fabricate the WORST possible breakout score for that symbol. Falling
            # through leaves an older finite row for the same symbol usable.
            v = r["breakout_probability"]
            if v is None:
                continue
            v = float(v)
            if not math.isfinite(v):
                continue
            out[r["symbol"]] = v * 100
        return out

    def _reversal_scores(self):
        """Cross-sectional intraday mean-reversion score per symbol, 0-100 (100 = most
        oversold within today's own session, i.e. the most attractive long under the measured
        effect).

        Built from today's 15m bars directly rather than from technical_signals, because the
        session state has to be current as of THIS 15-minute cycle -- technical_signals is
        refreshed post-close.

        Two inputs, both measured with strong negative IC against the remaining session, so
        both are inverted here:
          vwap_dev   (close - session VWAP) / VWAP     IC -0.090 (t=-5.7) at 10:15
          range_pos  (close - low) / (high - low)      IC -0.090 (t=-6.6) at 10:15
        Ranked cross-sectionally (not thresholded) so the score is comparable across days
        regardless of how trendy the tape is.
        """
        today = date.today().isoformat()
        try:
            rows = self.conn.execute(
                """SELECT symbol, datetime, high, low, close, volume
                   FROM intraday_ohlcv
                   WHERE interval='15m' AND datetime >= ?
                   ORDER BY symbol, datetime""", (today + "T00:00:00+05:30",)
            ).fetchall()
        except Exception as e:
            print(f"[IntradayRanker] reversal scores skipped: {str(e)[:80]}", file=sys.stderr)
            return {}

        acc: dict = {}
        for r in rows:
            ts = str(r["datetime"])
            # Skip the off-grid synthetic "last price" quotes both vendors append (zero volume,
            # open==high==low==close). intraday_fetcher.py drops these at write time now, but
            # ~2M already exist in the compressed hypertable and are not being backfilled out.
            try:
                mm, ss = int(ts[14:16]), int(ts[17:19])
            except (ValueError, IndexError):
                continue
            if ss != 0 or mm % 15 != 0:
                continue
            h, l, c = r["high"], r["low"], r["close"]
            if h is None or l is None or c is None:
                continue
            h, l, c, v = float(h), float(l), float(c), float(r["volume"] or 0)
            a = acc.setdefault(r["symbol"], {"hi": h, "lo": l, "pv": 0.0, "v": 0.0, "last": c})
            a["hi"] = max(a["hi"], h)
            a["lo"] = min(a["lo"], l)
            a["last"] = c
            if v > 0:
                a["pv"] += ((h + l + c) / 3.0) * v
                a["v"] += v

        vwap_dev, range_pos = {}, {}
        for sym, a in acc.items():
            if a["v"] > 0:
                vwap = a["pv"] / a["v"]
                if vwap > 0:
                    vwap_dev[sym] = (a["last"] - vwap) / vwap
            span = a["hi"] - a["lo"]
            if span > 0:
                range_pos[sym] = (a["last"] - a["lo"]) / span

        def _pct_rank(d: dict) -> dict:
            if not d:
                return {}
            order = sorted(d, key=lambda s: d[s])
            n = len(order)
            return {s: i / (n - 1) if n > 1 else 0.5 for i, s in enumerate(order)}

        rv, rr = _pct_rank(vwap_dev), _pct_rank(range_pos)
        out = {}
        for sym in set(rv) | set(rr):
            parts = [v for v in (rv.get(sym), rr.get(sym)) if v is not None]
            if parts:
                # invert: lowest vwap_dev / lowest range position -> highest score
                out[sym] = (1.0 - sum(parts) / len(parts)) * 100.0
        return out

    def _emission_edge(self, direction: str):
        """(avg_net_pnl_pct, n_trades) over the engine's own recently-resolved recommendations
        for the given direction ('LONG' or 'SHORT').

        Reads intraday_recommendation_outcomes, which as of 2026-07-31 is produced by an
        honest post-signal-only simulation on 15m bars. Before that rewrite it graded against
        the DAILY bar and included pre-signal price action, so this gate would have been
        reading fabricated exits -- the two changes only make sense together.
        """
        cutoff = (date.today() - timedelta(days=EMISSION_GATE_LOOKBACK_DAYS)).isoformat()
        try:
            row = self.conn.execute(
                "SELECT AVG(pnl_pct) AS avg_pnl, COUNT(*) AS n "
                "FROM intraday_recommendation_outcomes "
                "WHERE computed_at >= ? AND direction = ? AND pnl_pct IS NOT NULL",
                (cutoff, direction)
            ).fetchone()
        except Exception as e:
            print(f"[IntradayRanker] emission-edge lookup failed ({direction}): {str(e)[:80]}", file=sys.stderr)
            return None, 0
        if not row or not row["n"]:
            return None, 0
        return (float(row["avg_pnl"]) if row["avg_pnl"] is not None else None), int(row["n"])

    def _emission_allowed(self, direction: str):
        """(allowed, reason, avg_pnl, n). direction='LONG' gates Buy/Strong-Buy, 'SHORT' gates
        Sell/Strong-Sell -- each may only be published when THAT direction's own trailing
        realised edge is positive on a large enough sample. Independent gates: see
        EMISSION_GATE_SETTING_SHORT above for why long edge existing says nothing about short."""
        setting_key = EMISSION_GATE_SETTING if direction == "LONG" else EMISSION_GATE_SETTING_SHORT
        row = self.conn.execute(
            "SELECT value FROM app_settings WHERE key=?", (setting_key,)
        ).fetchone()
        if row and str(row["value"]).lower() in ("1", "true", "yes"):
            return True, "gate manually disabled via app_settings", None, 0
        avg_pnl, n = self._emission_edge(direction)
        if n < EMISSION_GATE_MIN_TRADES:
            return False, (f"only {n} resolved trades in the last "
                           f"{EMISSION_GATE_LOOKBACK_DAYS}d (need {EMISSION_GATE_MIN_TRADES})"), avg_pnl, n
        if avg_pnl is None or avg_pnl <= EMISSION_GATE_MIN_AVG_PNL:
            return False, (f"trailing realised net PnL {avg_pnl:+.3f}%/trade over {n} trades "
                           f"is not above {EMISSION_GATE_MIN_AVG_PNL:+.2f}%"), avg_pnl, n
        return True, f"trailing realised net PnL {avg_pnl:+.3f}%/trade over {n} trades", avg_pnl, n

    def _persist_gate_status(self, long_state, short_state):
        """Write both gate states to app_settings as one JSON row -- the frontend badge
        (getIntradayEmissionGateStatus, misc.router.ts) reads this instead of parsing job logs."""
        ok_l, reason_l, avg_l, n_l = long_state
        ok_s, reason_s, avg_s, n_s = short_state
        payload = json.dumps({
            "computed_at": datetime.utcnow().isoformat(),
            "long": {"open": ok_l, "reason": reason_l, "avg_pnl_pct": avg_l, "n_trades": n_l},
            "short": {"open": ok_s, "reason": reason_s, "avg_pnl_pct": avg_s, "n_trades": n_s},
        })
        try:
            self.conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (EMISSION_GATE_STATUS_KEY, payload)
            )
        except Exception as e:
            print(f"[IntradayRanker] gate-status persist failed: {str(e)[:80]}", file=sys.stderr)

    def _news_sentiment(self, days: int = 2):
        """Avg recent news sentiment per symbol in [-1, +1] (mirrors technicalSignalsService's
        loadRecentNewsSentiment: news_sentiment_items.symbols_json → sentiment_score)."""
        import json as _json
        upper = (date.today() + timedelta(days=1)).isoformat()
        cutoff = (date.today() - timedelta(days=days)).isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbols_json, sentiment_score FROM news_sentiment_items "
                "WHERE fetched_at >= ? AND fetched_at <= ? AND symbols_json IS NOT NULL "
                "AND symbols_json != '' AND symbols_json != '[]'", (cutoff, upper)
            ).fetchall()
        except Exception as e:
            print(f"[IntradayRanker] news sentiment skipped: {str(e)[:80]}", file=sys.stderr)
            return {}
        acc = {}
        for r in rows:
            try:
                syms = _json.loads(r["symbols_json"])
            except Exception:
                continue
            # Same NaN-is-truthy trap as _breakout_scores: one non-finite sentiment_score
            # would make the MEAN nan for every symbol tagged on that article, not just skew it.
            sc = r["sentiment_score"]
            if sc is None:
                continue
            sc = float(sc)
            if not math.isfinite(sc):
                continue
            for s in syms:
                acc.setdefault(s, []).append(sc)
        return {s: sum(v) / len(v) for s, v in acc.items() if v}

    def _learned_weights(self):
        """Blend weights learned from realized outcomes by intraday_strategy_learner.py (published
        to app_settings once enough trades accumulate). Falls back to the module defaults."""
        row = self.conn.execute(
            "SELECT value FROM app_settings WHERE key='intraday_learned_weights'"
        ).fetchone()
        if not row or not row["value"]:
            return W_BREAKOUT, W_SCREENER, NEWS_TILT_WEIGHT
        try:
            import json as _json
            w = _json.loads(row["value"])
            return (float(w.get("W_BREAKOUT", W_BREAKOUT)),
                    float(w.get("W_SCREENER", W_SCREENER)),
                    float(w.get("NEWS_TILT_WEIGHT", NEWS_TILT_WEIGHT)))
        except Exception:
            return W_BREAKOUT, W_SCREENER, NEWS_TILT_WEIGHT

    def _intraday_regime(self) -> str:
        row = self.conn.execute(
            "SELECT value FROM app_settings WHERE key='intraday_regime'"
        ).fetchone()
        return (row["value"] if row else None) or "NEUTRAL"

    def _event_risk_map(self, symbols):
        """Latest days_to_expiry/is_expiry_day (expiry_features.py) and days_to_next_results
        (mc_earnings_fetcher.py) per symbol, both daily-ops features on technical_signals.
        Returns {symbol: (is_expiry_day, days_to_next_results)}; missing values are None
        (most of the universe has no F&O contract / no announced results date -- that's the
        expected, not an error)."""
        if not symbols:
            return {}
        ph = ",".join("?" for _ in symbols)
        try:
            rows = self.conn.execute(
                f"SELECT symbol, is_expiry_day, days_to_next_results FROM technical_signals "
                f"WHERE symbol IN ({ph}) AND date = (SELECT MAX(date) FROM technical_signals t2 "
                f"WHERE t2.symbol = technical_signals.symbol)", tuple(symbols)
            ).fetchall()
        except Exception as e:
            print(f"[IntradayRanker] event-risk lookup skipped: {str(e)[:80]}", file=sys.stderr)
            return {}
        return {
            r["symbol"]: (
                int(r["is_expiry_day"]) if r["is_expiry_day"] is not None else 0,
                int(r["days_to_next_results"]) if r["days_to_next_results"] is not None else None,
            )
            for r in rows
        }

    def _cmp_atr_map(self, symbols):
        """Current price (from today's intraday bars when available) + Wilder ATR (from daily
        bars) for the given symbols."""
        if not symbols:
            return {}
        ph = ",".join("?" for _ in symbols)

        # ATR still comes from daily bars -- the STOP_ATR_MULT/TARGET_ATR_MULT barrier
        # multipliers above are tuned against daily-ATR magnitude, so this stays unchanged.
        rows = self.conn.execute(
            f"SELECT symbol, date, high, low, close FROM stock_ohlcv "
            f"WHERE symbol IN ({ph}) AND COALESCE(is_suspect,0)=0 "
            f"ORDER BY symbol, date DESC", tuple(symbols)
        ).fetchall()
        by_sym = {}
        for r in rows:
            by_sym.setdefault(r["symbol"], [])
            if len(by_sym[r["symbol"]]) < 30:  # newest 30, still desc
                by_sym[r["symbol"]].append(r)

        # Today's freshest intraday bar per symbol, when intraday_fetcher.py has run at
        # least once today (every 30 min during market hours). stock_ohlcv's row for
        # "today" is only populated after EOD, so using it as `cmp` for a ranker that runs
        # every 15 min intraday meant every pre-close run priced entries off yesterday's
        # close. Falls back to the daily close when no intraday bar exists yet today.
        today = date.today().isoformat()
        intraday_rows = self.conn.execute(
            f"SELECT symbol, close FROM ("
            f"  SELECT symbol, close, "
            f"    ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY datetime DESC) AS rn "
            f"  FROM intraday_ohlcv WHERE symbol IN ({ph}) AND datetime >= ?"
            f") t WHERE rn = 1", tuple(symbols) + (today,)
        ).fetchall()
        intraday_cmp = {r["symbol"]: float(r["close"]) for r in intraday_rows if r["close"] is not None}

        out = {}
        for sym, rs in by_sym.items():
            bars = [{"high": float(x["high"]), "low": float(x["low"]), "close": float(x["close"])}
                    for x in reversed(rs)]  # ascending
            if not bars:
                continue
            daily_close = bars[-1]["close"]
            cmp_ = intraday_cmp.get(sym)
            if cmp_ is not None and daily_close:
                deviation = abs(cmp_ - daily_close) / daily_close
                if deviation > PLAUSIBLE_INTRADAY_DEVIATION:
                    print(f"[IntradayRanker] {sym}: intraday_ohlcv price {cmp_} implausible vs "
                          f"daily close {daily_close} ({deviation:.0%} off) -- falling back to "
                          f"daily close, likely a bad mcsymbol mapping")
                    cmp_ = None
            if cmp_ is None:
                cmp_ = daily_close
            atr = _wilder_atr(bars)
            out[sym] = (cmp_, atr)
        return out

    def run(self):
        membership = self._intraday_membership()
        screener_scores, bull_counts, bear_counts = compute_screener_stock_scores(membership, {})
        breakout_scores = self._breakout_scores()
        reversal_scores = self._reversal_scores()
        news_scores = self._news_sentiment()
        regime = self._intraday_regime()
        tilt = REGIME_TILT.get(regime, 1.0)
        # Blend weights: learned from realized outcomes if available, else defaults (self-improving).
        w_breakout, w_screener, news_tilt = self._learned_weights()
        emission_ok, emission_reason, _emission_avg, _emission_n = self._emission_allowed("LONG")
        sell_emission_ok, sell_emission_reason, _sell_avg, _sell_n = self._emission_allowed("SHORT")
        print(f"[IntradayRanker] emission gate (LONG): {'OPEN' if emission_ok else 'CLOSED'} -- {emission_reason}")
        print(f"[IntradayRanker] emission gate (SHORT): {'OPEN' if sell_emission_ok else 'CLOSED'} -- {sell_emission_reason}")
        if reversal_scores:
            print(f"[IntradayRanker] reversal component: {len(reversal_scores)} symbols scored "
                  f"from today's 15m bars")

        all_symbols = set(screener_scores) | set(breakout_scores) | set(reversal_scores)

        # Index series are not tradeable instruments and must never be emitted as stock
        # recommendations. Excluded here at the universe level rather than per-component,
        # because they reach the ranker by more than one route: technical_signals already
        # carries breakout_probability rows for NIFTY50/NIFTYBANK/NIFTYIT/NIFTYMIDCAP (so
        # _breakout_scores picks them up), and as of 2026-07-31 intraday_ohlcv carries their
        # bars too (so _reversal_scores would as well). This was a live pre-existing bug, not
        # a new one: 522 index rows had accumulated in intraday_recommendations_history --
        # complete with entry/stop/target and position sizing -- because the downstream
        # liquidity filter only drops the ones that happen to have no ADTV, which let NIFTY50
        # and NIFTYMIDCAP through.
        index_syms = all_symbols & set(_INDEX_SYMBOLS)
        if index_syms:
            all_symbols -= index_syms
            print(f"[IntradayRanker] Excluded {len(index_syms)} index series from the stock "
                  f"universe: {sorted(index_syms)}")

        # Eligibility filter: drop symbols that can't actually be traded intraday as described
        # (surveillance-restricted) or don't have enough same-day volume to enter/exit cleanly.
        restricted = self._restricted_symbols()
        before = len(all_symbols)
        all_symbols -= restricted
        illiquid = all_symbols - self._liquid_symbols(all_symbols)
        all_symbols -= illiquid
        if restricted or illiquid:
            print(f"[IntradayRanker] Eligibility filter: {before} -> {len(all_symbols)} "
                  f"(-{len(restricted & (set(screener_scores) | set(breakout_scores)))} ASM/GSM, "
                  f"-{len(illiquid)} illiquid)")

        rows = []
        buy_syms = []
        sell_syms = []
        gated = 0
        sell_gated = 0
        for sym in all_symbols:
            s_sc = screener_scores.get(sym)
            b_sc = breakout_scores.get(sym)
            r_sc = reversal_scores.get(sym)
            # Renormalize the blend over whichever components are present for this symbol, so a
            # missing component never silently dilutes the others toward zero.
            parts = [(w_screener, s_sc), (w_breakout, b_sc), (W_REVERSAL, r_sc)]
            # isfinite, not just `is not None` -- a NaN component currently degrades to a
            # silently-zeroed score (max(0.0, nan) keeps 0.0 under Python's first-arg-wins
            # NaN comparison), not a fake Buy, but that's incidental to argument order, not a
            # guarantee -- match unified_ranker.py's explicit guard for the same anti-pattern.
            present = [(w, v) for w, v in parts if v is not None and math.isfinite(v)]
            if not present:
                continue
            wsum = sum(w for w, _ in present)
            base = sum(w * v for w, v in present) / wsum if wsum > 0 else 0.0
            # News tilt: nudge the score by up to ±(news_tilt) on fresh sentiment (0 when no coverage).
            news = news_scores.get(sym)
            news_mult = 1.0 + news_tilt * max(-1.0, min(1.0, news)) if news is not None else 1.0
            score = min(100.0, max(0.0, base * tilt * news_mult))
            bull, bear = bull_counts.get(sym, 0), bear_counts.get(sym, 0)
            raw_classification = _classify(score, bull, bear)
            classification = raw_classification
            # Emission gate: the score is still computed and stored (it is the input the
            # strategy learner and the UI ranking need), but an actionable Buy/Sell is only
            # published while THAT direction's own trailing realised edge justifies it.
            # raw_classification (pre-gate) is kept separately below and is what gets written
            # to intraday_recommendations_history -- see the "shadow geometry" block after the
            # buy-pool sizing loop for why: gating on the DISPLAYED classification here starved
            # the outcome resolver of anything to grade the moment the gate closed.
            if not emission_ok and classification in ("Strong Buy", "Buy"):
                classification = "Hold"
                gated += 1
            elif not sell_emission_ok and classification in ("Strong Sell", "Sell"):
                classification = "Hold"
                sell_gated += 1
            rows.append({
                "symbol": sym, "score": round(score, 2),
                # Conviction is direction-aware and reads the DISPLAYED classification, so a
                # gated row reports the conviction of the Hold it actually shows, not of the
                # Buy/Sell it would have been.
                "conviction": _conviction(score, classification), "classification": classification,
                "raw_classification": raw_classification,
                "screener_score": round(s_sc, 2) if s_sc is not None else None,
                "breakout_score": round(b_sc, 2) if b_sc is not None else None,
                "reversal_score": round(r_sc, 2) if r_sc is not None else None,
                "news_sentiment": round(news, 3) if news is not None else None,
                "bull": bull, "bear": bear,
                "breakout_prob": (b_sc / 100.0) if b_sc is not None else None,
            })
            if classification in ("Strong Buy", "Buy"):
                buy_syms.append(sym)
            elif classification in ("Strong Sell", "Sell"):
                sell_syms.append(sym)

        # Entry/target/stop + inverse-vol sizing for the buy pool only.
        cmp_atr = self._cmp_atr_map(buy_syms)
        event_risk = self._event_risk_map(buy_syms)
        raw_sizes = {}
        for r in rows:
            r.update({"cmp": None, "entry_price": None, "stop_loss": None,
                      "target_1": None, "risk_reward": None, "position_size_pct": 0.0,
                      "event_risk_flag": None})
            if r["symbol"] not in cmp_atr:
                continue
            cmp_, atr = cmp_atr[r["symbol"]]
            target, stop, rr = _atr_barriers(cmp_, atr)
            r.update({"cmp": round(cmp_, 2), "entry_price": round(cmp_, 2),
                      "stop_loss": stop, "target_1": target, "risk_reward": rr})
            # Size on the validated breakout edge, inverse-vol (ATR%), longs only. tilt is the
            # same regime multiplier applied to score above -- previously RISK_OFF only
            # relabeled the classification, exposure stayed full-size regardless of the
            # system's own risk-off signal.
            bet = bet_size_from_probability(r["breakout_prob"]) * tilt
            is_expiry, days_res = event_risk.get(r["symbol"], (0, None))
            results_imminent = days_res is not None and days_res <= RESULTS_IMMINENT_DAYS
            if is_expiry or results_imminent:
                bet *= EVENT_RISK_TILT
                r["event_risk_flag"] = (
                    "F&O expiry today" if is_expiry
                    else ("results today" if days_res == 0 else f"results in {days_res}d")
                )
            vol = max(VOL_FLOOR_PCT, (atr / cmp_ * 100.0) if cmp_ else VOL_FLOOR_PCT)
            raw_sizes[r["symbol"]] = bet / vol

        sizes = normalize_position_sizes(raw_sizes)
        for r in rows:
            r["position_size_pct"] = round(sizes.get(r["symbol"], 0.0) * 100, 2)

        # Don't deploy fresh capital in the last stretch before close -- a signal this late
        # has too little time left to reach target before same-day square-off. Still write
        # the recommendation/score for visibility, just zero the sizing.
        ist_now = datetime.utcnow() + timedelta(hours=5, minutes=30)
        minutes_to_close = NSE_CLOSE_MINUTES_IST - (ist_now.hour * 60 + ist_now.minute)
        if 0 <= minutes_to_close <= LATE_CUTOFF_MINUTES_BEFORE_CLOSE:
            for r in rows:
                if r["position_size_pct"]:
                    r["position_size_pct"] = 0.0
            print(f"[IntradayRanker] {minutes_to_close}min to close -- late-cutoff active, "
                  f"no new position sizing this cycle.")

        # Shadow geometry for outcome tracking, keyed off raw_classification (pre-gate) so the
        # resolver keeps grading what the engine would have recommended even while a gate is
        # closed -- computed independently of, and never copied into, the live entry/stop/target
        # fields above (those stay gate-aware: a Hold never shows a target). Long reuses cmp_atr
        # (already computed for the buy pool) where the symbol wasn't gated out of buy_syms;
        # anything gated out needs its own lookup since it never entered buy_syms/cmp_atr above.
        raw_buy_syms = [r["symbol"] for r in rows if r["raw_classification"] in ("Strong Buy", "Buy")]
        raw_sell_syms = [r["symbol"] for r in rows if r["raw_classification"] in ("Strong Sell", "Sell")]
        shadow_buy_extra = self._cmp_atr_map([s for s in raw_buy_syms if s not in cmp_atr])
        shadow_cmp_atr_sell = self._cmp_atr_map(raw_sell_syms)
        shadow_geom = {}
        for sym in raw_buy_syms:
            cmp_atr_pair = cmp_atr.get(sym) or shadow_buy_extra.get(sym)
            if cmp_atr_pair is None:
                continue
            cmp_, atr = cmp_atr_pair
            target, stop, rr = _atr_barriers(cmp_, atr)
            shadow_geom[sym] = (round(cmp_, 2), stop, target, rr)
        for sym in raw_sell_syms:
            cmp_atr_pair = shadow_cmp_atr_sell.get(sym)
            if cmp_atr_pair is None:
                continue
            cmp_, atr = cmp_atr_pair
            target, stop, rr = _atr_barriers_short(cmp_, atr)
            shadow_geom[sym] = (round(cmp_, 2), stop, target, rr)

        today = date.today().isoformat()
        cycle_at = datetime.utcnow().isoformat()
        cur = self.conn.cursor()
        for r in rows:
            if r["raw_classification"] in ("Strong Buy", "Buy") and not emission_ok:
                gate_note = "; EMISSION GATED (engine's trailing realised LONG edge is not positive)"
            elif r["raw_classification"] in ("Strong Sell", "Sell") and not sell_emission_ok:
                gate_note = "; EMISSION GATED (engine's trailing realised SHORT edge is not positive)"
            else:
                gate_note = ""
            reasoning = (f"{r['bull']} bullish / {r['bear']} bearish intraday screeners "
                         f"({r['classification']}); regime {regime}"
                         + (f"; reversal {r['reversal_score']:.0f}/100" if r.get("reversal_score") is not None else "")
                         + (f"; breakout P={r['breakout_prob']:.2f}" if r["breakout_prob"] else "")
                         + (f"; news {r['news_sentiment']:+.2f}" if r["news_sentiment"] is not None else "")
                         + gate_note
                         + (f"; EVENT RISK: {r['event_risk_flag']} (size cut {int((1 - EVENT_RISK_TILT) * 100)}%)"
                            if r.get("event_risk_flag") else ""))
            cur.execute(
                """INSERT INTO intraday_recommendations
                   (symbol, computed_at, intraday_regime, intraday_score, conviction_level,
                    classification, screener_score, breakout_score, news_sentiment, bullish_count,
                    bearish_count, cmp, entry_price, stop_loss, target_1, risk_reward,
                    position_size_pct, reasoning, computed_ts)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                   ON CONFLICT(symbol, computed_at) DO UPDATE SET
                     intraday_regime=excluded.intraday_regime, intraday_score=excluded.intraday_score,
                     conviction_level=excluded.conviction_level, classification=excluded.classification,
                     screener_score=excluded.screener_score, breakout_score=excluded.breakout_score,
                     news_sentiment=excluded.news_sentiment,
                     bullish_count=excluded.bullish_count, bearish_count=excluded.bearish_count,
                     cmp=excluded.cmp, entry_price=excluded.entry_price, stop_loss=excluded.stop_loss,
                     target_1=excluded.target_1, risk_reward=excluded.risk_reward,
                     position_size_pct=excluded.position_size_pct, reasoning=excluded.reasoning,
                     computed_ts=CURRENT_TIMESTAMP""",
                (r["symbol"], today, regime, r["score"], r["conviction"], r["classification"],
                 r["screener_score"], r["breakout_score"], r["news_sentiment"], r["bull"], r["bear"],
                 r["cmp"], r["entry_price"], r["stop_loss"], r["target_1"], r["risk_reward"],
                 r["position_size_pct"], reasoning),
            )
            # Append-only trail of this specific cycle -- intraday_recommendations above is
            # overwrite-in-place per (symbol, day), so it's the LATEST cycle's row only. The
            # outcome resolver reads this history table to paper-trade the FIRST Buy/Sell-
            # classified cycle of the day per symbol, not whichever cycle happened to run last.
            #
            # Deliberately writes raw_classification (pre-gate) and the shadow entry/stop/target
            # here, NOT r["classification"]/r["entry_price"] (the gate-aware, live-facing values
            # used in the insert above) -- those are correctly "Hold"/None once a gate closes,
            # but that means the resolver would find nothing to grade, and the gate would freeze
            # on stale evidence forever instead of re-measuring whether the edge has recovered.
            hist_entry, hist_stop, hist_target, hist_rr = shadow_geom.get(r["symbol"], (None, None, None, None))
            cur.execute(
                """INSERT INTO intraday_recommendations_history
                   (symbol, computed_at, cycle_at, intraday_regime, intraday_score, conviction_level,
                    classification, screener_score, breakout_score, news_sentiment, bullish_count,
                    bearish_count, cmp, entry_price, stop_loss, target_1, risk_reward, position_size_pct)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(symbol, cycle_at) DO NOTHING""",
                (r["symbol"], today, cycle_at, regime, r["score"], r["conviction"], r["raw_classification"],
                 r["screener_score"], r["breakout_score"], r["news_sentiment"], r["bull"], r["bear"],
                 hist_entry, hist_entry, hist_stop, hist_target, hist_rr,
                 r["position_size_pct"]),
            )
        self.conn.commit()
        buys = sum(1 for r in rows if r["classification"] in ("Strong Buy", "Buy"))
        sells = sum(1 for r in rows if r["classification"] in ("Strong Sell", "Sell"))
        self._persist_gate_status(
            (emission_ok, emission_reason, _emission_avg, _emission_n),
            (sell_emission_ok, sell_emission_reason, _sell_avg, _sell_n),
        )
        self.conn.commit()
        print(json.dumps({"success": True, "ranked": len(rows), "buy_pool": buys, "sell_pool": sells,
                          "emission_gate_long": "open" if emission_ok else "closed",
                          "emission_gate_long_reason": emission_reason, "gated_to_hold": gated,
                          "emission_gate_short": "open" if sell_emission_ok else "closed",
                          "emission_gate_short_reason": sell_emission_reason, "sell_gated_to_hold": sell_gated,
                          "reversal_scored": len(reversal_scores),
                          "intraday_regime": regime}))
        return rows


if __name__ == "__main__":
    IntradayRanker().run()
