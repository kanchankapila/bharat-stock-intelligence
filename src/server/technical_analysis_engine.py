import pandas as pd
import os
import json
import datetime
from sqlalchemy import text
from ta.momentum import RSIIndicator
from ta.trend import MACD, EMAIndicator
from ta.volatility import BollingerBands, AverageTrueRange
import numpy as np

from db_compat import get_engine
from as_of import logical_write_floor
import sys


# ── ATR-based barriers ──────────────────────────────────────────────────────────
# Replaces the old fixed +8%/-5% targets, which ignored that a 5% stop is sub-1σ noise
# on a high-vol smallcap (random stop-outs) and 3σ-untouchable on an FMCG name (no
# protection). Barriers are ATR multiples, clamped to sane % guardrails so a single
# gappy day can't produce an absurd level.
STOP_ATR_MULT, TARGET_ATR_MULT = 1.5, 2.5
STOP_PCT_FLOOR, STOP_PCT_CAP = 0.02, 0.08      # 2%–8%
TARGET_PCT_FLOOR, TARGET_PCT_CAP = 0.03, 0.15  # 3%–15%


def compute_atr_barriers(price, atr, direction,
                         stop_mult=STOP_ATR_MULT, target_mult=TARGET_ATR_MULT):
    """ATR-multiple target/stop as (target_price, stop_loss), clamped to % guardrails.

    direction: 'long' (target above, stop below) or 'short' (inverted). Missing/zero ATR
    falls back to the floor % so barriers are never degenerate.
    """
    if price <= 0:
        return 0.0, 0.0
    atr_frac = (atr / price) if atr and atr > 0 else 0.0
    stop_frac = min(max(stop_mult * atr_frac, STOP_PCT_FLOOR), STOP_PCT_CAP)
    target_frac = min(max(target_mult * atr_frac, TARGET_PCT_FLOOR), TARGET_PCT_CAP)
    if direction == 'long':
        return round(price * (1 + target_frac), 2), round(price * (1 - stop_frac), 2)
    return round(price * (1 - target_frac), 2), round(price * (1 + stop_frac), 2)


# ── unified_signals row mapping (Cluster B-lite, 2026-08) ────────────────────────
# technical_analysis_signals folded into unified_signals (signal_source='technical').
# Column choices preserve queryability for the three readers this replaces:
#   trend            -> signal_type      (kept as a real filter key, not buried in text)
#   rsi              -> technical_score  (numeric column, so strategySignalsService's
#                                          `rsi <= ?` filter still works as a plain comparison —
#                                          a formatted text blob would not be queryable)
#   patterns (JSON)  -> ai_reasoning     (already json.dumps'd; mcpServer's JSON.parse(...)
#                                          still works unchanged)
#   entry/target/stop -> passthrough (unified_signals already has these columns)
#   reasoning         -> a human-readable RSI/MACD/BB summary (unified_signals' own free-text column)
#
# confidence_score is DELIBERATELY NOT WRITTEN, and that is a decision, not an oversight.
# This source is 24,442 of unified_signals' rows (the largest single writer) and 100% of them
# have a NULL confidence_score -- reviewed 2026-08-16 and left NULL on purpose. analyze_stock()
# computes no confidence quantity: it produces a trend label, an RSI, a 4-state MACD label, a
# Bollinger state and a pattern list. Any "confidence" derived from those would be an invented
# weighting with no validation behind it, and .claude/rules/measurement.md is explicit that a
# new score needs backtest evidence before it is emitted -- this codebase has already been
# burned by scores that looked like evidence and were not.
#
# The correct handling is on the READ side, and it is done: a consumer must treat NULL here as
# "this source does not report confidence", never as zero and never as a reason to exclude the
# row. `confidence_score >= X` is never true for NULL, which is exactly how the chatbot's
# get_buy_signals silently dropped every row from this source until 2026-08-15.

def to_unified_signal_row(row: dict, signal_date: str) -> dict:
    return {
        'symbol': row['symbol'],
        'signal_date': signal_date,
        'signal_type': row['trend'],
        'entry_price': row['entry_price'],
        'target_price': row['target_price'],
        'stop_loss': row['stop_loss'],
        'reasoning': f"RSI={row['rsi']:.1f} MACD={row['macd']} BB={row['bollinger']}",
        'technical_score': row['rsi'],
        'ai_reasoning': row['patterns'],
        'signal_generated_at': row['last_updated'],
    }


class TechnicalAnalysisEngine:
    def __init__(self):
        self.engine = get_engine()

    def load_ohlcv(self, symbol):
        with self.engine.connect() as conn:
            query = text("SELECT date, open, high, low, close, volume FROM stock_ohlcv WHERE symbol = :symbol ORDER BY date ASC")
            df = pd.read_sql(query, conn, params={"symbol": symbol})
            return df

    def analyze_stock(self, symbol):
        df = self.load_ohlcv(symbol)
        if df.empty or len(df) < 50:
            return None

        # 1. Indicators
        rsi_inv = RSIIndicator(close=df['close'], window=14)
        df['rsi'] = rsi_inv.rsi()

        macd_inv = MACD(close=df['close'])
        df['macd'] = macd_inv.macd()
        df['macd_signal'] = macd_inv.macd_signal()

        ema20 = EMAIndicator(close=df['close'], window=20)
        df['ema20'] = ema20.ema_indicator()

        ema50 = EMAIndicator(close=df['close'], window=50)
        df['ema50'] = ema50.ema_indicator()

        bb = BollingerBands(close=df['close'])
        df['bb_high'] = bb.bollinger_hband()
        df['bb_low'] = bb.bollinger_lband()

        atr = AverageTrueRange(high=df['high'], low=df['low'], close=df['close'], window=14)
        df['atr'] = atr.average_true_range()

        # Latest values
        latest = df.iloc[-1]
        prev = df.iloc[-2]

        # 2. Trend & Signals
        trend = "Neutral"
        if latest['ema20'] > latest['ema50']:
            trend = "Bullish"
        elif latest['ema20'] < latest['ema50']:
            trend = "Bearish"

        # 3. Entry/Exit Prediction
        # Simple logic: RSI oversold/overbought + EMA crossover
        entry_price = 0
        target_price = 0
        stop_loss = 0

        current_price = float(latest['close'])
        
        # Detect patterns
        patterns = []
        # Bullish Engulfing
        if latest['close'] > latest['open'] and prev['close'] < prev['open'] and \
           latest['close'] > prev['open'] and latest['open'] < prev['close']:
            patterns.append("Bullish Engulfing")
        
        # Doji
        if abs(latest['close'] - latest['open']) <= (latest['high'] - latest['low']) * 0.1:
            patterns.append("Doji")

        # Predictions — barriers scaled to the stock's own ATR, not a fixed % everywhere
        latest_atr = float(latest['atr']) if not pd.isna(latest['atr']) else 0.0

        # Bug-fix 5: always compute barriers so entry/target/stop_loss are never 0.
        # Neutral trend gets symmetric ATR barriers (market-making style); the
        # entry_price is the current mid to avoid any directional bias.
        if trend == "Bullish" or latest['rsi'] < 35:
            entry_price = round(current_price * 1.005, 2)
            target_price, stop_loss = compute_atr_barriers(current_price, latest_atr, 'long')
        elif trend == "Bearish" or latest['rsi'] > 65:
            # For shorting or exit
            entry_price = round(current_price * 0.995, 2)
            target_price, stop_loss = compute_atr_barriers(current_price, latest_atr, 'short')
        else:
            # Neutral: use current price as entry, compute symmetric long barriers as default
            entry_price = current_price
            target_price, stop_loss = compute_atr_barriers(current_price, latest_atr, 'long')

        return {
            'symbol': symbol,
            'trend': trend,
            'rsi': float(latest['rsi']),
            # Bug-fix 3: 4-state MACD label.
            # "*Crossover" = event happened yesterday→today (most actionable).
            # "Bullish"/"Bearish" = sustained state, still tradeable.
            # Previously "Neutral" was returned for the sustained state — the most
            # common and tradeable condition — which caused it to be ignored downstream.
            'macd': (
                "Bullish Crossover" if (latest['macd'] > latest['macd_signal'] and prev['macd'] <= prev['macd_signal'])
                else "Bearish Crossover" if (latest['macd'] < latest['macd_signal'] and prev['macd'] >= prev['macd_signal'])
                else "Bullish" if latest['macd'] > latest['macd_signal']
                else "Bearish" if latest['macd'] < latest['macd_signal']
                else "Neutral"
            ),
            'bollinger': "High" if latest['close'] > latest['bb_high'] else "Low" if latest['close'] < latest['bb_low'] else "Normal",
            'patterns': json.dumps(patterns),
            'entry_price': entry_price,
            'target_price': target_price,
            'stop_loss': stop_loss,
            # UTC-aware (2026-08-13): naive datetime.now() on an IST-clocked host lands in this
            # TIMESTAMPTZ column ~5:30 ahead of true UTC, since Postgres treats a naive value as
            # already being in the session's timezone. Produced 2,477 rows with
            # signal_generated_at LATER than created_at (see signal-provenance-monotonic in
            # dataQualityChecks.ts / recurring-bugs.md) -- a different mechanism from the
            # already-fixed ON CONFLICT drift bug, same symptom.
            'last_updated': datetime.datetime.now(datetime.timezone.utc).isoformat()
        }

    def process_all(self):
        with self.engine.connect() as conn:
            symbols_query = text("SELECT DISTINCT symbol FROM stock_ohlcv")
            symbols = [row[0] for row in conn.execute(symbols_query)]

        print(f"Analyzing {len(symbols)} stocks...")
        results = []
        for symbol in symbols:
            try:
                analysis = self.analyze_stock(symbol)
                if analysis:
                    results.append(analysis)
            except Exception as e:
                print(f"Error analyzing {symbol}: {e}", file=sys.stderr)

        if results:
            # Anchored to the last real session in stock_ohlcv (2026-08-13), not wall-clock: a
            # naive datetime.now().date() call written after 18:30 UTC (00:00 IST) -- which is
            # exactly when today's crash-loop-driven catch-up runs have been landing -- wrote
            # TOMORROW's calendar date into signal_date, corrupting the join key
            # measurement.md's methodology depends on. logical_write_floor() is the established
            # fix for this exact class (see recurring-bugs.md's date-anchor entries and
            # as_of.py's own docstring) and ties signal_date to the data actually analyzed,
            # not to when the job happened to run.
            today_str = logical_write_floor(
                fallback=datetime.datetime.now(datetime.timezone.utc).date().isoformat()
            )
            unified_rows = [to_unified_signal_row(r, signal_date=today_str) for r in results]
            with self.engine.begin() as conn:
                conn.execute(text("""
                    INSERT INTO unified_signals
                      (symbol, signal_date, signal_source, signal_type,
                       entry_price, target_price, stop_loss, reasoning,
                       technical_score, ai_reasoning, status, signal_generated_at)
                    VALUES (:symbol, :signal_date, 'technical', :signal_type,
                            :entry_price, :target_price, :stop_loss, :reasoning,
                            :technical_score, :ai_reasoning, 'ACTIVE', :signal_generated_at)
                    ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
                        entry_price=excluded.entry_price, target_price=excluded.target_price,
                        stop_loss=excluded.stop_loss, reasoning=excluded.reasoning,
                        technical_score=excluded.technical_score, ai_reasoning=excluded.ai_reasoning
                        -- signal_generated_at deliberately NOT refreshed (2026-08-12): it must
                        -- record when the signal was FIRST generated, or it cannot establish
                        -- that the signal predates the bar it is graded against. Every one of
                        -- this source's 19,480 rows had drifted later than its own created_at.
                """), unified_rows)
            print(f"Analysis complete. {len(results)} signals saved to unified_signals.")

        return results


def run_ta_engine():
    engine = TechnicalAnalysisEngine()
    results = engine.process_all()
    return {"message": f"TA Analysis complete. {len(results) if results else 0} signals saved."}


if __name__ == "__main__":
    engine = TechnicalAnalysisEngine()
    engine.process_all()
