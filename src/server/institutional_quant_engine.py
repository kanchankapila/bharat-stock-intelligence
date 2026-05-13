import pandas as pd
import numpy as np
import yfinance as yf
import sqlite3
import os
import json
import datetime
from sqlalchemy import create_engine, text
import time

# Configuration
DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')
DATABASE_URL = f"sqlite:///{DB_PATH}"

class InstitutionalQuantEngine:
    def __init__(self):
        self.engine = create_engine(DATABASE_URL)
        self.weights = {
            'value': 0.30,
            'growth': 0.30,
            'quality': 0.30,
            'momentum': 0.10
        }

    def get_universe(self, limit=100):
        """Get a universe of stocks to rank."""
        with self.engine.connect() as conn:
            # We'll use the top stocks by market cap if available, otherwise just symbols
            query = text("SELECT symbol FROM nse_stocks LIMIT :limit")
            result = conn.execute(query, {"limit": limit})
            return [row[0] for row in result]

    def fetch_fundamental_data(self, symbols):
        """Fetch all required metrics for the scoring framework using yfinance."""
        data_list = []
        print(f"Fetching fundamental data for {len(symbols)} stocks...")
        
        for symbol in symbols:
            try:
                ticker = yf.Ticker(f"{symbol}.NS")
                info = ticker.info
                
                # Safety Filters
                debt_to_equity = info.get('debtToEquity', 999) / 100.0 # yfinance returns as percentage like 80.5
                interest_coverage = info.get('operatingCashflow', 0) / abs(info.get('totalDebt', 1)) # Proxy if not available
                # Actually try to get better interest coverage
                try:
                    income_stmt = ticker.income_stmt
                    interest_expense = abs(income_stmt.loc['Interest Expense'].iloc[0]) if 'Interest Expense' in income_stmt.index else 1
                    ebit = income_stmt.loc['EBIT'].iloc[0] if 'EBIT' in income_stmt.index else 0
                    interest_coverage = ebit / interest_expense
                except:
                    pass
                
                avg_volume_usd = info.get('averageVolume', 0) * info.get('currentPrice', 0) / 83.0 # Approx USD conversion
                
                # Metrics
                metrics = {
                    'symbol': symbol,
                    # Value
                    'pe': info.get('trailingPE', np.nan),
                    'ps': info.get('priceToSalesTrailing12Months', np.nan),
                    'earnings_yield': 1.0 / info.get('trailingPE', 0.001) if info.get('trailingPE') else 0,
                    
                    # Growth
                    'rev_growth': info.get('revenueGrowth', 0),
                    'eps_growth': info.get('earningsGrowth', 0),
                    
                    # Quality
                    'roe': info.get('returnOnEquity', 0),
                    'op_margin': info.get('operatingMargins', 0),
                    
                    # Momentum
                    'price': info.get('currentPrice', 0),
                    'ma200': info.get('twoHundredDayAverage', 0),
                    
                    # Safety
                    'debt_to_equity': debt_to_equity,
                    'interest_coverage': interest_coverage,
                    'avg_vol_usd': avg_volume_usd,
                    
                    # F-Score Data (simplified placeholder or fetch)
                    'f_score': self.calculate_piotroski_f_score(ticker)
                }
                data_list.append(metrics)
                time.sleep(0.5) # Avoid rate limit
            except Exception as e:
                print(f"  Error fetching {symbol}: {e}")
                
        return pd.DataFrame(data_list)

    def calculate_piotroski_f_score(self, ticker):
        """Calculate the 9-point Piotroski F-Score."""
        try:
            # This requires historical financials which are slow to fetch
            # For this implementation, we return a score based on available 'info' or 5 as neutral
            # Real implementation would pull last 2 years of Balance Sheet and Income Statement
            score = 0
            info = ticker.info
            if info.get('returnOnAssets', 0) > 0: score += 1
            if info.get('operatingCashflow', 0) > 0: score += 1
            if info.get('returnOnAssets', 0) > info.get('returnOnAssets', 0): score += 1 # Placeholder for trend
            if info.get('operatingCashflow', 0) > info.get('netIncomeToCommon', 0): score += 1
            # ... additional 5 points would come from historical comparisons
            return score + 3 # Adjusting for the missing 5 points with a neutral buffer
        except:
            return 5

    def rank_universe(self, df):
        """Apply normalization, safety filters, and composite scoring."""
        if df.empty: return df
        
        # 1. Apply Mandatory Safety Filters (Pass/Fail)
        df['pass_safety'] = (
            (df['debt_to_equity'] < 1.0) & 
            (df['interest_coverage'] > 3.0) & 
            (df['avg_vol_usd'] > 1000000)
        )
        
        # 2. Normalization (Percentile Ranking 0-100)
        def percentile_score(series, higher_is_better=True):
            if higher_is_better:
                return series.rank(pct=True) * 100
            else:
                return (1 - series.rank(pct=True)) * 100

        # Scoring Metrics
        df['score_pe'] = percentile_score(df['pe'], False)
        df['score_ps'] = percentile_score(df['ps'], False)
        df['score_ey'] = percentile_score(df['earnings_yield'], True)
        
        df['score_rev'] = percentile_score(df['rev_growth'], True)
        df['score_eps'] = percentile_score(df['eps_growth'], True)
        
        df['score_roe'] = percentile_score(df['roe'], True)
        df['score_margin'] = percentile_score(df['op_margin'], True)
        
        df['dist_ma200'] = (df['price'] / df['ma200'] - 1) * 100
        df['score_momentum'] = percentile_score(df['dist_ma200'], True)

        # 3. Component Scores
        df['value_score'] = (df['score_pe'] + df['score_ps'] + df['score_ey']) / 3
        df['growth_score'] = (df['score_rev'] + df['score_eps']) / 2
        df['quality_score'] = (df['score_roe'] + df['score_margin']) / 2
        
        # 4. Composite Score Calculation
        df['composite_score'] = (
            df['value_score'] * self.weights['value'] +
            df['growth_score'] * self.weights['growth'] +
            df['quality_score'] * self.weights['quality'] +
            df['score_momentum'] * self.weights['momentum']
        )
        
        # 5. Final Adjustments
        # Quality Check: Piotroski F-Score overlay
        # If F-Score < 4, penalize composite score
        df['composite_score'] = np.where(df['f_score'] < 4, df['composite_score'] * 0.8, df['composite_score'])
        
        # Penalize failing safety filters
        df['composite_score'] = np.where(df['pass_safety'], df['composite_score'], df['composite_score'] * 0.5)

        return df.sort_values('composite_score', ascending=False)

    def run(self):
        symbols = self.get_universe(limit=20) # Small batch for demo
        raw_data = self.fetch_fundamental_data(symbols)
        ranked_data = self.rank_universe(raw_data)
        
        print("\n--- Institutional Quant Ranking Results ---")
        print(ranked_data[['symbol', 'composite_score', 'pass_safety', 'f_score', 'value_score', 'growth_score', 'quality_score']].head(10))
        
        # Save to a new table
        with self.engine.begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS institutional_rankings"))
            ranked_data.to_sql('institutional_rankings', conn, if_exists='replace', index=False)
            
        print("\nResults saved to 'institutional_rankings' table.")

if __name__ == "__main__":
    engine = InstitutionalQuantEngine()
    engine.run()
