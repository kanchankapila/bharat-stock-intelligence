from pathlib import Path
import pandas as pd
import sqlite3
import os
import json
import datetime
from sqlalchemy import create_engine, text
from ta.momentum import RSIIndicator
from ta.trend import MACD, EMAIndicator
from ta.volatility import BollingerBands
import numpy as np

# Configuration
DB_PATH      = Path(__file__).parent.parent.parent / "database.sqlite"
DATABASE_URL = f"sqlite:///{DB_PATH}"

class TechnicalAnalysisEngine:
    def __init__(self):
        self.engine = create_engine(DATABASE_URL)

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

        # Predictions
        if trend == "Bullish" or latest['rsi'] < 35:
            entry_price = round(current_price * 1.005, 2)
            target_price = round(current_price * 1.08, 2) # 8% target
            stop_loss = round(current_price * 0.95, 2) # 5% SL
        elif trend == "Bearish" or latest['rsi'] > 65:
            # For shorting or exit
            entry_price = round(current_price * 0.995, 2)
            target_price = round(current_price * 0.92, 2)
            stop_loss = round(current_price * 1.05, 2)

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
                    INSERT OR REPLACE INTO technical_analysis_signals 
                    (symbol, trend, rsi, macd, bollinger, patterns, entry_price, target_price, stop_loss, last_updated)
                    VALUES (:symbol, :trend, :rsi, :macd, :bollinger, :patterns, :entry_price, :target_price, :stop_loss, :last_updated)
                """), results)
            print(f"Analysis complete. {len(results)} signals saved.")

if __name__ == "__main__":
    engine = TechnicalAnalysisEngine()
    engine.process_all()
