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
from datetime import date, datetime, timedelta

from db_compat import connect
from unified_ranker import (
    compute_screener_stock_scores,
    bet_size_from_probability,
    normalize_position_sizes,
    _classify,
    _conviction,
    VOL_FLOOR_PCT,
)

# Intraday-scaled ATR barriers — tighter than the positional 2.5×/1.5× (an intraday move plays out
# in hours, not the 5-15 day positional horizon).
STOP_ATR_MULT, TARGET_ATR_MULT = 0.6, 1.0
STOP_PCT_FLOOR, STOP_PCT_CAP = 0.005, 0.03       # 0.5%–3%
TARGET_PCT_FLOOR, TARGET_PCT_CAP = 0.008, 0.05   # 0.8%–5%

# Score blend: breakout (validated edge) vs intraday screener confluence. Both on a 0-100 scale.
W_BREAKOUT, W_SCREENER = 0.45, 0.55

# Regime tilt — applied to both the final score AND (unlike before) position sizing, so a
# RISK_OFF regime actually shrinks exposure instead of just relabeling the same full-size bet.
REGIME_TILT = {"RISK_ON": 1.15, "NEUTRAL": 1.0, "RISK_OFF": 0.80}

# News-sentiment tilt: a fresh news score in [-1, +1] nudges the blended score up to ±15%. News is
# sparse (only some names have coverage), so it modifies rather than drives the ranking.
NEWS_TILT_WEIGHT = 0.15

# Minimum 20-day average daily turnover (₹ crore) to be eligible for an intraday recommendation.
# Intraday trades need enough same-day volume to enter AND exit without material slippage --
# unlike a positional trade, there's no multi-day window to work an illiquid fill.
MIN_TURNOVER_CR = 1.0

# Don't size NEW intraday entries in the last stretch before NSE close (15:30 IST) -- a signal
# firing this late has too little time left to reach an ATR target before same-day square-off.
LATE_CUTOFF_MINUTES_BEFORE_CLOSE = 45
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
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, "
             "COALESCE(ts.screener_name, sc.screener_name, sc.screener_id) sname "
             "FROM trendlyne_screener_stocks ss "
             "JOIN screener_catalog sc ON sc.screener_id=ss.screener_id AND sc.source='trendlyne' "
             "LEFT JOIN trendlyne_screeners ts ON ts.screener_id=sc.screener_id "
             "WHERE sc.investment_horizon IN ('intraday', 'short_term')"),
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, "
             "COALESCE(sc.screener_name, sc.screener_id) sname "
             "FROM moneycontrol_screener_stocks ss "
             "JOIN screener_catalog sc ON sc.screener_id=ss.scan_id AND sc.source='moneycontrol' "
             "WHERE sc.investment_horizon IN ('intraday', 'short_term')"),
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, "
             "COALESCE(sc.screener_name, sc.screener_id) sname "
             "FROM etnow_screener_stocks ss "
             "JOIN screener_catalog sc ON sc.screener_id=ss.screener_id AND sc.source='etnow' "
             "WHERE sc.investment_horizon IN ('intraday', 'short_term')"),
        ]
        for sql in queries:
            try:
                for r in self.conn.execute(sql).fetchall():
                    add(r["symbol"], r["signal_bias"], r["confidence"],
                        r["category"], r["subcategory"], r["sname"])
            except Exception as e:
                print(f"[IntradayRanker] membership query skipped: {str(e)[:80]}")
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
            print(f"[IntradayRanker] surveillance filter skipped: {str(e)[:80]}")
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
            if r["symbol"] not in out:
                out[r["symbol"]] = float(r["breakout_probability"] or 0) * 100
        return out

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
            print(f"[IntradayRanker] news sentiment skipped: {str(e)[:80]}")
            return {}
        acc = {}
        for r in rows:
            try:
                syms = _json.loads(r["symbols_json"])
            except Exception:
                continue
            for s in syms:
                acc.setdefault(s, []).append(float(r["sentiment_score"] or 0))
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
            cmp_ = intraday_cmp.get(sym, bars[-1]["close"])
            atr = _wilder_atr(bars)
            out[sym] = (cmp_, atr)
        return out

    def run(self):
        membership = self._intraday_membership()
        screener_scores, bull_counts, bear_counts = compute_screener_stock_scores(membership, {})
        breakout_scores = self._breakout_scores()
        news_scores = self._news_sentiment()
        regime = self._intraday_regime()
        tilt = REGIME_TILT.get(regime, 1.0)
        # Blend weights: learned from realized outcomes if available, else defaults (self-improving).
        w_breakout, w_screener, news_tilt = self._learned_weights()

        all_symbols = set(screener_scores) | set(breakout_scores)

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
        for sym in all_symbols:
            s_sc = screener_scores.get(sym)
            b_sc = breakout_scores.get(sym)
            # Renormalize the blend over whichever components are present for this symbol.
            if s_sc is not None and b_sc is not None:
                base = w_screener * s_sc + w_breakout * b_sc
            elif s_sc is not None:
                base = s_sc
            else:
                base = b_sc
            # News tilt: nudge the score by up to ±(news_tilt) on fresh sentiment (0 when no coverage).
            news = news_scores.get(sym)
            news_mult = 1.0 + news_tilt * max(-1.0, min(1.0, news)) if news is not None else 1.0
            score = min(100.0, max(0.0, base * tilt * news_mult))
            bull, bear = bull_counts.get(sym, 0), bear_counts.get(sym, 0)
            classification = _classify(score, bull, bear)
            rows.append({
                "symbol": sym, "score": round(score, 2),
                "conviction": _conviction(score), "classification": classification,
                "screener_score": round(s_sc, 2) if s_sc is not None else None,
                "breakout_score": round(b_sc, 2) if b_sc is not None else None,
                "news_sentiment": round(news, 3) if news is not None else None,
                "bull": bull, "bear": bear,
                "breakout_prob": (b_sc / 100.0) if b_sc is not None else None,
            })
            if classification in ("Strong Buy", "Buy"):
                buy_syms.append(sym)

        # Entry/target/stop + inverse-vol sizing for the buy pool only.
        cmp_atr = self._cmp_atr_map(buy_syms)
        raw_sizes = {}
        for r in rows:
            r.update({"cmp": None, "entry_price": None, "stop_loss": None,
                      "target_1": None, "risk_reward": None, "position_size_pct": 0.0})
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

        today = date.today().isoformat()
        cycle_at = datetime.utcnow().isoformat()
        cur = self.conn.cursor()
        for r in rows:
            reasoning = (f"{r['bull']} bullish / {r['bear']} bearish intraday screeners "
                         f"({r['classification']}); regime {regime}"
                         + (f"; breakout P={r['breakout_prob']:.2f}" if r["breakout_prob"] else "")
                         + (f"; news {r['news_sentiment']:+.2f}" if r["news_sentiment"] is not None else ""))
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
            # outcome resolver reads this history table to paper-trade the FIRST Buy-classified
            # cycle of the day per symbol, not whichever cycle happened to run last.
            cur.execute(
                """INSERT INTO intraday_recommendations_history
                   (symbol, computed_at, cycle_at, intraday_regime, intraday_score, conviction_level,
                    classification, screener_score, breakout_score, news_sentiment, bullish_count,
                    bearish_count, cmp, entry_price, stop_loss, target_1, risk_reward, position_size_pct)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(symbol, cycle_at) DO NOTHING""",
                (r["symbol"], today, cycle_at, regime, r["score"], r["conviction"], r["classification"],
                 r["screener_score"], r["breakout_score"], r["news_sentiment"], r["bull"], r["bear"],
                 r["cmp"], r["entry_price"], r["stop_loss"], r["target_1"], r["risk_reward"],
                 r["position_size_pct"]),
            )
        self.conn.commit()
        buys = sum(1 for r in rows if r["classification"] in ("Strong Buy", "Buy"))
        print(json.dumps({"success": True, "ranked": len(rows), "buy_pool": buys,
                          "intraday_regime": regime}))
        return rows


if __name__ == "__main__":
    IntradayRanker().run()
