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
from datetime import date, timedelta

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

# Regime tilt on the final score (intraday breadth risk-on/off from intraday_regime.py).
REGIME_TILT = {"RISK_ON": 1.15, "NEUTRAL": 1.0, "RISK_OFF": 0.80}


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
        """Screener memberships restricted to intraday-classified screeners (same join shape as
        unified_ranker._get_screener_membership, filtered to investment_horizon='intraday')."""
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
             "WHERE sc.investment_horizon='intraday'"),
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, "
             "COALESCE(sc.screener_name, sc.screener_id) sname "
             "FROM moneycontrol_screener_stocks ss "
             "JOIN screener_catalog sc ON sc.screener_id=ss.scan_id AND sc.source='moneycontrol' "
             "WHERE sc.investment_horizon='intraday'"),
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, "
             "COALESCE(sc.screener_name, sc.screener_id) sname "
             "FROM etnow_screener_stocks ss "
             "JOIN screener_catalog sc ON sc.screener_id=ss.screener_id AND sc.source='etnow' "
             "WHERE sc.investment_horizon='intraday'"),
        ]
        for sql in queries:
            try:
                for r in self.conn.execute(sql).fetchall():
                    add(r["symbol"], r["signal_bias"], r["confidence"],
                        r["category"], r["subcategory"], r["sname"])
            except Exception as e:
                print(f"[IntradayRanker] membership query skipped: {str(e)[:80]}")
        return membership

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

    def _intraday_regime(self) -> str:
        row = self.conn.execute(
            "SELECT value FROM app_settings WHERE key='intraday_regime'"
        ).fetchone()
        return (row["value"] if row else None) or "NEUTRAL"

    def _cmp_atr_map(self, symbols):
        """Latest close + Wilder ATR from recent daily bars for the given symbols (one query)."""
        if not symbols:
            return {}
        ph = ",".join("?" for _ in symbols)
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
        out = {}
        for sym, rs in by_sym.items():
            bars = [{"high": float(x["high"]), "low": float(x["low"]), "close": float(x["close"])}
                    for x in reversed(rs)]  # ascending
            if not bars:
                continue
            cmp_ = bars[-1]["close"]
            atr = _wilder_atr(bars)
            out[sym] = (cmp_, atr)
        return out

    def run(self):
        membership = self._intraday_membership()
        screener_scores, bull_counts, bear_counts = compute_screener_stock_scores(membership, {})
        breakout_scores = self._breakout_scores()
        regime = self._intraday_regime()
        tilt = REGIME_TILT.get(regime, 1.0)

        all_symbols = set(screener_scores) | set(breakout_scores)
        rows = []
        buy_syms = []
        for sym in all_symbols:
            s_sc = screener_scores.get(sym)
            b_sc = breakout_scores.get(sym)
            # Renormalize the blend over whichever components are present for this symbol.
            if s_sc is not None and b_sc is not None:
                base = W_SCREENER * s_sc + W_BREAKOUT * b_sc
            elif s_sc is not None:
                base = s_sc
            else:
                base = b_sc
            score = min(100.0, max(0.0, base * tilt))
            bull, bear = bull_counts.get(sym, 0), bear_counts.get(sym, 0)
            classification = _classify(score, bull, bear)
            rows.append({
                "symbol": sym, "score": round(score, 2),
                "conviction": _conviction(score), "classification": classification,
                "screener_score": round(s_sc, 2) if s_sc is not None else None,
                "breakout_score": round(b_sc, 2) if b_sc is not None else None,
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
            # Size on the validated breakout edge, inverse-vol (ATR%), longs only.
            bet = bet_size_from_probability(r["breakout_prob"])
            vol = max(VOL_FLOOR_PCT, (atr / cmp_ * 100.0) if cmp_ else VOL_FLOOR_PCT)
            raw_sizes[r["symbol"]] = bet / vol

        sizes = normalize_position_sizes(raw_sizes)
        for r in rows:
            r["position_size_pct"] = round(sizes.get(r["symbol"], 0.0) * 100, 2)

        today = date.today().isoformat()
        cur = self.conn.cursor()
        for r in rows:
            reasoning = (f"{r['bull']} bullish / {r['bear']} bearish intraday screeners "
                         f"({r['classification']}); regime {regime}"
                         + (f"; breakout P={r['breakout_prob']:.2f}" if r["breakout_prob"] else ""))
            cur.execute(
                """INSERT INTO intraday_recommendations
                   (symbol, computed_at, intraday_regime, intraday_score, conviction_level,
                    classification, screener_score, breakout_score, bullish_count, bearish_count,
                    cmp, entry_price, stop_loss, target_1, risk_reward, position_size_pct,
                    reasoning, computed_ts)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                   ON CONFLICT(symbol, computed_at) DO UPDATE SET
                     intraday_regime=excluded.intraday_regime, intraday_score=excluded.intraday_score,
                     conviction_level=excluded.conviction_level, classification=excluded.classification,
                     screener_score=excluded.screener_score, breakout_score=excluded.breakout_score,
                     bullish_count=excluded.bullish_count, bearish_count=excluded.bearish_count,
                     cmp=excluded.cmp, entry_price=excluded.entry_price, stop_loss=excluded.stop_loss,
                     target_1=excluded.target_1, risk_reward=excluded.risk_reward,
                     position_size_pct=excluded.position_size_pct, reasoning=excluded.reasoning,
                     computed_ts=CURRENT_TIMESTAMP""",
                (r["symbol"], today, regime, r["score"], r["conviction"], r["classification"],
                 r["screener_score"], r["breakout_score"], r["bull"], r["bear"], r["cmp"],
                 r["entry_price"], r["stop_loss"], r["target_1"], r["risk_reward"],
                 r["position_size_pct"], reasoning),
            )
        self.conn.commit()
        buys = sum(1 for r in rows if r["classification"] in ("Strong Buy", "Buy"))
        print(json.dumps({"success": True, "ranked": len(rows), "buy_pool": buys,
                          "intraday_regime": regime}))
        return rows


if __name__ == "__main__":
    IntradayRanker().run()
