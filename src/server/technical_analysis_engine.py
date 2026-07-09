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
        if trend == "Bullish" or latest['rsi'] < 35:
            entry_price = round(current_price * 1.005, 2)
            target_price, stop_loss = compute_atr_barriers(current_price, latest_atr, 'long')
        elif trend == "Bearish" or latest['rsi'] > 65:
            # For shorting or exit
            entry_price = round(current_price * 0.995, 2)
            target_price, stop_loss = compute_atr_barriers(current_price, latest_atr, 'short')

        return {
            'symbol': symbol,
            'trend': trend,
            'rsi': float(latest['rsi']),
            'macd': "Bullish Crossover" if latest['macd'] > latest['macd_signal'] and prev['macd'] < prev['macd_signal'] else "Neutral",
            'bollinger': "High" if latest['close'] > latest['bb_high'] else "Low" if latest['close'] < latest['bb_low'] else "Normal",
            'patterns': json.dumps(patterns),
            'entry_price': entry_price,
            'target_price': target_price,
            'stop_loss': stop_loss,
            'last_updated': datetime.datetime.now().isoformat()
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
                print(f"Error analyzing {symbol}: {e}")

        if results:
            with self.engine.begin() as conn:
                conn.execute(text("""
                    INSERT INTO technical_analysis_signals
                    (symbol, trend, rsi, macd, bollinger, patterns, entry_price, target_price, stop_loss, last_updated)
                    VALUES (:symbol, :trend, :rsi, :macd, :bollinger, :patterns, :entry_price, :target_price, :stop_loss, :last_updated)
                    ON CONFLICT(symbol) DO UPDATE SET
                        trend=excluded.trend, rsi=excluded.rsi, macd=excluded.macd,
                        bollinger=excluded.bollinger, patterns=excluded.patterns,
                        entry_price=excluded.entry_price, target_price=excluded.target_price,
                        stop_loss=excluded.stop_loss, last_updated=excluded.last_updated
                """), results)
            print(f"Analysis complete. {len(results)} signals saved.")

        return results


def run_ta_engine():
    engine = TechnicalAnalysisEngine()
    results = engine.process_all()
    return {"message": f"TA Analysis complete. {len(results) if results else 0} signals saved."}


if __name__ == "__main__":
    engine = TechnicalAnalysisEngine()
    engine.process_all()
