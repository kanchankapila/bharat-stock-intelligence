import sqlite3
import json
import os
import datetime
import pandas as pd
import numpy as np
from sqlalchemy import create_engine, text
from nlp_engine import NLPScreenerInference
from typing import Dict, Any, List

# Configuration
DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')
DATABASE_URL = f"sqlite:///{DB_PATH}"

class AlphaQuantScoringEngine:
    """
    Production-grade Quantitative Ranking System
    """
    
    CATEGORY_WEIGHTS = {
        'fundamental': 1.0,
        'technical': 0.85,
        'momentum': 0.95,
        'delivery': 0.8,
        'news': 1.2,
        'other': 0.5
    }
    
    SOURCE_WEIGHTS = {
        'Trendlyne': 1.0,
        'MoneyControl': 0.9,
        'ETnow': 0.85
    }

    def __init__(self):
        self.engine = create_engine(DATABASE_URL)
        self.nlp = NLPScreenerInference()
        self.stock_stats = {} # symbol -> detailed metrics

    def load_data(self):
        """Load all screeners and mappings from the database"""
        with self.engine.connect() as conn:
            # 1. Load Trendlyne
            tl_screeners = pd.read_sql("SELECT screener_id as scan_id, screener_name as name, description FROM trendlyne_screeners", conn)
            tl_screeners['source'] = 'Trendlyne'
            tl_screeners['is_positive'] = 1 # Trendlyne defaults to positive
            
            tl_mappings = pd.read_sql("SELECT screener_id as scan_id, stock_id, symbol FROM trendlyne_screener_stocks", conn)
            
            # 2. Load MoneyControl
            mc_screeners = pd.read_sql("SELECT scan_id, screener_name as name, is_positive FROM moneycontrol_screeners", conn)
            mc_screeners['source'] = 'MoneyControl'
            mc_screeners['description'] = "" # Descriptions not stored for MC yet
            
            mc_mappings = pd.read_sql("SELECT scan_id, mcsymbol as stock_id, symbol FROM moneycontrol_screener_stocks", conn)
            
            # Combine
            screeners = pd.concat([tl_screeners, mc_screeners], ignore_index=True)
            mappings = pd.concat([tl_mappings, mc_mappings], ignore_index=True)
            
            return screeners, mappings

    def process_scoring(self):
        print(f"Starting AlphaQuant Scoring Engine v2 (Multi-Timeframe) at {datetime.datetime.now()}")
        screeners, mappings = self.load_data()
        
        # 1. Infer metadata for all screeners
        print("Inferring screener intent and timeframe using NLP...")
        screeners_meta = {}
        for _, s in screeners.iterrows():
            inference = self.nlp.infer(s['name'], s.get('description', ''))
            
            sentiment = inference['sentiment']
            if sentiment == 'neutral' and 'is_positive' in s:
                sentiment = 'bullish' if s['is_positive'] == 1 else 'bearish'
            
            screeners_meta[s['scan_id']] = {
                'name': s['name'],
                'source': s['source'],
                'sentiment': sentiment,
                'category': inference['category'],
                'timeframe': inference['timeframe'],
                'confidence': inference['confidence']
            }

        # 1.5 Load News Data
        print("Loading news sentiment data...")
        with self.engine.connect() as conn:
            news_df = pd.read_sql("SELECT symbols, sentiment, title, source FROM news_articles", conn)
            
        news_map = {} # symbol -> [news_items]
        for _, n in news_df.iterrows():
            if not n['symbols']: continue
            syms = [s.strip() for s in n['symbols'].split(',')]
            for s in syms:
                if s not in news_map: news_map[s] = []
                news_map[s].append({
                    'name': n['title'],
                    'sentiment': n['sentiment'].lower(),
                    'source': n['source'],
                    'category': 'news'
                })

        # 2. Separate rankings by timeframe
        timeframes = ['long_term', 'intraday']
        all_timeframe_results = []

        for tf in timeframes:
            print(f"Processing {tf} rankings...")
            stock_scores = {} # symbol -> {factors, reasons, contradictions}

            # Pre-populate with news sentiment if available
            # News contributes to both timeframes
            for symbol, news_items in news_map.items():
                if symbol not in stock_scores:
                    stock_scores[symbol] = {
                        'raw_sum': 0,
                        'factors': {cat: 0 for cat in self.CATEGORY_WEIGHTS.keys()},
                        'positive_screeners': [],
                        'negative_screeners': [],
                        'sources': set(),
                        'categories': set()
                    }
                
                for item in news_items:
                    sentiment_multiplier = 1 if item['sentiment'] == 'positive' else -1
                    if item['sentiment'] == 'neutral': sentiment_multiplier = 0
                    
                    contribution = 7.0 * sentiment_multiplier # News has high impact
                    stock_scores[symbol]['raw_sum'] += contribution
                    stock_scores[symbol]['factors']['news'] += contribution
                    stock_scores[symbol]['sources'].add(item['source'])
                    stock_scores[symbol]['categories'].add('news')
                    
                    if sentiment_multiplier > 0:
                        stock_scores[symbol]['positive_screeners'].append(item)
                    elif sentiment_multiplier < 0:
                        stock_scores[symbol]['negative_screeners'].append(item)

            for _, m in mappings.iterrows():
                symbol = m['symbol']
                if not symbol or symbol == '#N/A': continue
                
                scan_id = m['scan_id']
                meta = screeners_meta.get(scan_id)
                if not meta: continue
                
                # Fundamental screeners apply to BOTH timeframes
                # Other screeners apply only to their specific timeframe
                is_fundamental = meta['category'] == 'fundamental'
                if not is_fundamental and meta['timeframe'] != tf: continue
                
                if symbol not in stock_scores:
                    stock_scores[symbol] = {
                        'raw_sum': 0,
                        'factors': {cat: 0 for cat in self.CATEGORY_WEIGHTS.keys()},
                        'positive_screeners': [],
                        'negative_screeners': [],
                        'sources': set(),
                        'categories': set()
                    }
                
                # Calculate weight
                base_score = 5.0
                sentiment_multiplier = 1 if meta['sentiment'] == 'bullish' else -1
                cat_weight = self.CATEGORY_WEIGHTS.get(meta['category'], 0.5)
                src_weight = self.SOURCE_WEIGHTS.get(meta['source'], 0.9)
                
                weighted_contribution = base_score * cat_weight * src_weight * sentiment_multiplier
                
                stock_scores[symbol]['raw_sum'] += weighted_contribution
                stock_scores[symbol]['factors'][meta['category']] += weighted_contribution
                stock_scores[symbol]['sources'].add(meta['source'])
                stock_scores[symbol]['categories'].add(meta['category'])
                
                reason = {'name': meta['name'], 'sentiment': meta['sentiment'], 'source': meta['source'], 'category': meta['category']}
                if meta['sentiment'] == 'bullish':
                    stock_scores[symbol]['positive_screeners'].append(reason)
                else:
                    stock_scores[symbol]['negative_screeners'].append(reason)

            # Normalization
            for symbol, data in stock_scores.items():
                category_count = len(data['categories'])
                consensus_multiplier = 1 + (0.1 * (category_count - 1)) if category_count > 1 else 1.0
                final_score = data['raw_sum'] * consensus_multiplier
                
                screener_count = len(data['positive_screeners']) + len(data['negative_screeners'])
                source_count = len(data['sources'])
                confidence = min(100, (screener_count * 10) * (1 + 0.2 * (source_count - 1)))
                
                classification = "Hold"
                if final_score > 30: classification = "Strong Buy"
                elif final_score > 10: classification = "Buy"
                elif final_score < -20: classification = "Strong Sell"
                elif final_score < -5: classification = "Sell"
                
                normalized_ui_score = min(100, max(0, 50 + (final_score * 2)))
                
                # Identify Top Domain
                top_domain = "Other"
                if data['factors']:
                    # Get category with highest absolute contribution
                    abs_factors = {k: abs(v) for k, v in data['factors'].items()}
                    top_domain = max(abs_factors, key=abs_factors.get).capitalize()

                all_timeframe_results.append({
                    'symbol': symbol,
                    'timeframe': tf,
                    'score': normalized_ui_score,
                    'confidence': confidence,
                    'classification': classification,
                    'top_domain': top_domain,
                    'positive_count': len(data['positive_screeners']),
                    'negative_count': len(data['negative_screeners']),
                    'reasons': json.dumps(data['positive_screeners'] + data['negative_screeners']),
                    'factor_breakdown': json.dumps(data['factors']),
                    'last_updated': datetime.datetime.now().isoformat()
                })

        # 3. Save results to DB
        self.save_results(all_timeframe_results, screeners_meta)

    def save_results(self, results, screeners_meta):
        print(f"Saving {len(results)} ranked stocks and {len(screeners_meta)} screener metadata to database...")
        with self.engine.begin() as conn:
            # 1. Clear and Update Screener Master
            conn.execute(text("DELETE FROM screener_master"))
            master_data = []
            for sid, m in screeners_meta.items():
                master_data.append({
                    'scan_id': sid,
                    'name': m['name'],
                    'source': m['source'],
                    'inferred_sentiment': m['sentiment'],
                    'inferred_category': m['category'],
                    'inferred_timeframe': m['timeframe'],
                    'confidence': m['confidence'],
                    'last_updated': datetime.datetime.now().isoformat()
                })
            
            if master_data:
                conn.execute(text("""
                    INSERT INTO screener_master
                    (scan_id, name, source, inferred_sentiment, inferred_category, inferred_timeframe, confidence, last_updated)
                    VALUES (:scan_id, :name, :source, :inferred_sentiment, :inferred_category, :inferred_timeframe, :confidence, :last_updated)
                """), master_data)

            # 2. Update Scores
            conn.execute(text("DELETE FROM stock_scores"))
            conn.execute(text("DELETE FROM stock_factor_breakdown"))
            
            if results:
                conn.execute(text("""
                    INSERT INTO stock_scores 
                    (symbol, timeframe, score, confidence, classification, top_domain, positive_count, negative_count, reasons, last_updated)
                    VALUES (:symbol, :timeframe, :score, :confidence, :classification, :top_domain, :positive_count, :negative_count, :reasons, :last_updated)
                """), results)
                
                breakdowns = []
                for r in results:
                    factors = json.loads(r['factor_breakdown'])
                    breakdowns.append({
                        'symbol': r['symbol'],
                        'timeframe': r['timeframe'],
                        'technical': factors.get('technical', 0),
                        'fundamental': factors.get('fundamental', 0),
                        'momentum': factors.get('momentum', 0),
                        'valuation': factors.get('valuation', 0),
                        'delivery': factors.get('delivery', 0),
                        'news': factors.get('news', 0),
                        'last_updated': r['last_updated']
                    })
                
                conn.execute(text("""
                    INSERT INTO stock_factor_breakdown
                    (symbol, timeframe, technical, fundamental, momentum, valuation, delivery, news, last_updated)
                    VALUES (:symbol, :timeframe, :technical, :fundamental, :momentum, :valuation, :delivery, :news, :last_updated)
                """), breakdowns)
                
        print("Ranking and Scoring complete!")

if __name__ == "__main__":
    engine = AlphaQuantScoringEngine()
    engine.process_scoring()
