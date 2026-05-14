import sqlite3
import json
import os
import datetime
import pandas as pd
import numpy as np
from sqlalchemy import create_engine, text
from nlp_engine import NLPScreenerInference, NLP_VERSION
from typing import Dict, Any, List

# Configuration
DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')
DATABASE_URL = f"sqlite:///{DB_PATH}"

# ETnow screeners (mirrors router.ts getMarketScanners — hardcoded because
# they are not stored in etnow_screeners DB table yet).
ETNOW_SCREENERS = [
    { 'scan_id': 'et-73',   'name': 'Cash Cows',              'is_positive': 1 },
    { 'scan_id': 'et-75',   'name': 'Elite Bluechips',         'is_positive': 1 },
    { 'scan_id': 'et-79',   'name': 'Zero Debt Quality',       'is_positive': 1 },
    { 'scan_id': 'et-91',   'name': 'Buy on Dips',             'is_positive': 1 },
    { 'scan_id': 'et-195',  'name': 'Potential Multibaggers',  'is_positive': 1 },
    { 'scan_id': 'et-118',  'name': 'Straight Flush',          'is_positive': 1 },
    { 'scan_id': 'et-362',  'name': 'RSI Oversold',            'is_positive': 1 },
    { 'scan_id': 'et-518',  'name': 'The Tata Empire',         'is_positive': 0 },
    { 'scan_id': 'et-520',  'name': 'Adani Universe',          'is_positive': 0 },
    { 'scan_id': 'et-514',  'name': 'PSU Gems',                'is_positive': 0 },
    { 'scan_id': 'et-515',  'name': 'Monopoly Biz',            'is_positive': 0 },
    { 'scan_id': 'et-1101', 'name': 'Defence Sector',          'is_positive': 0 },
    { 'scan_id': 'et-1100', 'name': 'Infra Boost',             'is_positive': 1 },
]


class AlphaQuantScoringEngine:
    """
    Production-grade Quantitative Ranking System
    """

    CATEGORY_WEIGHTS = {
        'fundamental': 1.0,
        'technical':   0.85,
        'momentum':    0.95,
        'valuation':   0.9,
        'delivery':    0.8,
        'sector':      0.3,
        'news':        1.2,
        'other':       0.5,
    }

    SOURCE_WEIGHTS = {
        'Trendlyne':    1.0,
        'MoneyControl': 0.9,
        'ETnow':        0.85,
    }

    def __init__(self):
        self.engine = create_engine(DATABASE_URL)
        self.nlp = NLPScreenerInference()
        self.stock_stats = {}

    # ------------------------------------------------------------------
    # Data Loading
    # ------------------------------------------------------------------

    def load_data(self):
        """Load all screeners and stock-screener mappings from the database."""
        with self.engine.connect() as conn:
            # Trendlyne
            tl_screeners = pd.read_sql(
                "SELECT screener_id AS scan_id, screener_name AS name, description FROM trendlyne_screeners",
                conn,
            )
            tl_screeners['source'] = 'Trendlyne'
            tl_screeners['is_positive'] = None  # let NLP determine; no forced default
            tl_mappings = pd.read_sql(
                "SELECT screener_id AS scan_id, stock_id, symbol FROM trendlyne_screener_stocks",
                conn,
            )

            # MoneyControl
            mc_screeners = pd.read_sql(
                "SELECT scan_id, screener_name AS name, is_positive FROM moneycontrol_screeners",
                conn,
            )
            mc_screeners['source'] = 'MoneyControl'
            mc_screeners['description'] = ""
            mc_mappings = pd.read_sql(
                "SELECT scan_id, mcsymbol AS stock_id, symbol FROM moneycontrol_screener_stocks",
                conn,
            )

            # ETnow (loaded from DB if available; fall back to hardcoded list)
            et_db = pd.read_sql(
                "SELECT screener_id AS scan_id, screener_name AS name FROM etnow_screeners",
                conn,
            )
            if et_db.empty:
                et_screeners = pd.DataFrame(ETNOW_SCREENERS)
            else:
                et_screeners = et_db
                et_screeners['is_positive'] = 1
            et_screeners['source'] = 'ETnow'
            et_screeners['description'] = ""

            et_mappings = pd.read_sql(
                "SELECT screener_id AS scan_id, symbol, stock_name AS stock_id FROM etnow_screener_stocks",
                conn,
            )

        screeners = pd.concat([tl_screeners, mc_screeners, et_screeners], ignore_index=True)
        mappings  = pd.concat([tl_mappings, mc_mappings, et_mappings],    ignore_index=True)
        return screeners, mappings

    # ------------------------------------------------------------------
    # Screener Master — computed once, rebuilt only when NLP version changes
    # ------------------------------------------------------------------

    def _get_stored_nlp_version(self, conn) -> str:
        row = conn.execute(
            text("SELECT value FROM app_settings WHERE key='screener_nlp_version'")
        ).fetchone()
        return row[0] if row else None

    def _set_stored_nlp_version(self, conn, version: str):
        conn.execute(text("""
            INSERT INTO app_settings (key, value, updatedAt)
            VALUES ('screener_nlp_version', :v, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = CURRENT_TIMESTAMP
        """), {"v": version})

    def build_screener_metadata(self, screeners: pd.DataFrame, force_rebuild: bool = False) -> Dict[str, Any]:
        """
        Infer and persist screener metadata into screener_master.

        - First call (or after NLP version bump): rebuilds all entries.
        - Subsequent calls: only inserts NEW screeners; existing ones are untouched.

        Returns a dict of scan_id -> metadata for use in scoring.
        """
        with self.engine.begin() as conn:
            stored_version = self._get_stored_nlp_version(conn)
            version_changed = stored_version != NLP_VERSION

            if force_rebuild or version_changed:
                print(f"NLP version changed ({stored_version} -> {NLP_VERSION}). Rebuilding screener_master...")
                conn.execute(text("DELETE FROM screener_master"))
                screeners_to_infer = screeners
            else:
                # Only infer for screeners not yet in screener_master
                existing_ids = {
                    r[0] for r in conn.execute(text("SELECT scan_id FROM screener_master"))
                }
                screeners_to_infer = screeners[~screeners['scan_id'].isin(existing_ids)]
                if not screeners_to_infer.empty:
                    print(f"Adding {len(screeners_to_infer)} new screeners to screener_master...")
                else:
                    print("screener_master is up-to-date (no new screeners found).")

            # Infer metadata for screeners that need it
            new_master_data = []
            for _, s in screeners_to_infer.iterrows():
                inference = self.nlp.infer(s['name'], s.get('description', '') or '')

                sentiment = inference['sentiment']
                # For MoneyControl only: use the explicit is_positive flag to resolve neutral
                if sentiment == 'neutral' and s['source'] == 'MoneyControl' and pd.notna(s.get('is_positive')):
                    sentiment = 'bullish' if int(s['is_positive']) == 1 else 'bearish'

                new_master_data.append({
                    'scan_id':            s['scan_id'],
                    'name':               s['name'],
                    'source':             s['source'],
                    'inferred_sentiment': sentiment,
                    'inferred_category':  inference['category'],
                    'inferred_timeframe': inference['timeframe'],
                    'confidence':         inference['confidence'],
                    'last_updated':       datetime.datetime.now().isoformat(),
                })

            if new_master_data:
                conn.execute(text("""
                    INSERT INTO screener_master
                        (scan_id, name, source, inferred_sentiment, inferred_category,
                         inferred_timeframe, confidence, last_updated)
                    VALUES
                        (:scan_id, :name, :source, :inferred_sentiment, :inferred_category,
                         :inferred_timeframe, :confidence, :last_updated)
                    ON CONFLICT(scan_id) DO NOTHING
                """), new_master_data)

            # Persist version so next run skips rebuild
            self._set_stored_nlp_version(conn, NLP_VERSION)

        # Return full metadata from DB (includes previously-computed rows)
        return self._load_screener_metadata()

    def _load_screener_metadata(self) -> Dict[str, Any]:
        with self.engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT scan_id, name, source, inferred_sentiment, inferred_category, "
                "inferred_timeframe, confidence FROM screener_master"
            )).fetchall()
        return {
            r[0]: {
                'name':      r[1],
                'source':    r[2],
                'sentiment': r[3],
                'category':  r[4],
                'timeframe': r[5],
                'confidence': r[6],
            }
            for r in rows
        }

    # ------------------------------------------------------------------
    # Scoring
    # ------------------------------------------------------------------

    def process_scoring(self, force_rebuild: bool = False):
        print(f"Starting AlphaQuant Scoring Engine v2 (Multi-Timeframe) at {datetime.datetime.now()}")
        screeners, mappings = self.load_data()

        print("Building screener metadata (NLP inference)...")
        screeners_meta = self.build_screener_metadata(screeners, force_rebuild=force_rebuild)
        print(f"screener_master has {len(screeners_meta)} entries.")

        # Load news sentiment
        print("Loading news sentiment data...")
        with self.engine.connect() as conn:
            news_df = pd.read_sql(
                "SELECT symbols, sentiment, title, source FROM news_articles", conn
            )

        news_map: Dict[str, list] = {}
        for _, n in news_df.iterrows():
            if not n['symbols']:
                continue
            for s in [x.strip() for x in n['symbols'].split(',')]:
                news_map.setdefault(s, []).append({
                    'name':      n['title'],
                    'sentiment': n['sentiment'].lower(),
                    'source':    n['source'],
                    'category':  'news',
                })

        # Score per timeframe
        timeframes = ['long_term', 'intraday']
        all_timeframe_results = []

        for tf in timeframes:
            print(f"Processing {tf} rankings...")
            stock_scores: Dict[str, dict] = {}

            # Seed with news (applies to both timeframes)
            for symbol, news_items in news_map.items():
                stock_scores.setdefault(symbol, {
                    'raw_sum': 0,
                    'factors': {cat: 0 for cat in self.CATEGORY_WEIGHTS},
                    'positive_screeners': [],
                    'negative_screeners': [],
                    'sources': set(),
                    'categories': set(),
                })
                for item in news_items:
                    mult = 1 if item['sentiment'] == 'positive' else (-1 if item['sentiment'] == 'negative' else 0)
                    contrib = 7.0 * mult
                    stock_scores[symbol]['raw_sum'] += contrib
                    stock_scores[symbol]['factors']['news'] += contrib
                    stock_scores[symbol]['sources'].add(item['source'])
                    stock_scores[symbol]['categories'].add('news')
                    if mult > 0:
                        stock_scores[symbol]['positive_screeners'].append(item)
                    elif mult < 0:
                        stock_scores[symbol]['negative_screeners'].append(item)

            for _, m in mappings.iterrows():
                symbol = m['symbol']
                if not symbol or symbol == '#N/A':
                    continue

                scan_id = m['scan_id']
                meta = screeners_meta.get(scan_id)
                if not meta:
                    continue

                # Fundamental screeners apply to BOTH timeframes; others only to their own
                is_fundamental = meta['category'] in ('fundamental', 'valuation')
                if not is_fundamental and meta['timeframe'] != tf:
                    continue

                stock_scores.setdefault(symbol, {
                    'raw_sum': 0,
                    'factors': {cat: 0 for cat in self.CATEGORY_WEIGHTS},
                    'positive_screeners': [],
                    'negative_screeners': [],
                    'sources': set(),
                    'categories': set(),
                })

                base_score = 5.0
                sentiment_mult = 1 if meta['sentiment'] == 'bullish' else -1
                cat_weight = self.CATEGORY_WEIGHTS.get(meta['category'], 0.5)
                src_weight = self.SOURCE_WEIGHTS.get(meta['source'], 0.9)

                contrib = base_score * cat_weight * src_weight * sentiment_mult
                cat_key = meta['category'] if meta['category'] in self.CATEGORY_WEIGHTS else 'other'

                stock_scores[symbol]['raw_sum'] += contrib
                stock_scores[symbol]['factors'][cat_key] += contrib
                stock_scores[symbol]['sources'].add(meta['source'])
                stock_scores[symbol]['categories'].add(meta['category'])

                reason = {
                    'name':      meta['name'],
                    'sentiment': meta['sentiment'],
                    'source':    meta['source'],
                    'category':  meta['category'],
                }
                if meta['sentiment'] == 'bullish':
                    stock_scores[symbol]['positive_screeners'].append(reason)
                else:
                    stock_scores[symbol]['negative_screeners'].append(reason)

            for symbol, data in stock_scores.items():
                cat_count = len(data['categories'])
                consensus_mult = 1 + (0.1 * (cat_count - 1)) if cat_count > 1 else 1.0
                final_score = data['raw_sum'] * consensus_mult

                screener_count = len(data['positive_screeners']) + len(data['negative_screeners'])
                source_count = len(data['sources'])
                confidence = min(100, screener_count * 10 * (1 + 0.2 * (source_count - 1)))

                if final_score > 30:       classification = "Strong Buy"
                elif final_score > 10:     classification = "Buy"
                elif final_score < -20:    classification = "Strong Sell"
                elif final_score < -5:     classification = "Sell"
                else:                      classification = "Hold"

                normalized_score = min(100, max(0, 50 + (final_score * 2)))

                top_domain = "Other"
                if data['factors']:
                    abs_factors = {k: abs(v) for k, v in data['factors'].items()}
                    top_domain = max(abs_factors, key=abs_factors.get).capitalize()

                all_timeframe_results.append({
                    'symbol':         symbol,
                    'timeframe':      tf,
                    'score':          normalized_score,
                    'confidence':     confidence,
                    'classification': classification,
                    'top_domain':     top_domain,
                    'positive_count': len(data['positive_screeners']),
                    'negative_count': len(data['negative_screeners']),
                    'reasons':        json.dumps(data['positive_screeners'] + data['negative_screeners']),
                    'factor_breakdown': json.dumps(data['factors']),
                    'last_updated':   datetime.datetime.now().isoformat(),
                })

        self.save_results(all_timeframe_results)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save_results(self, results: list):
        print(f"Saving {len(results)} ranked stock-timeframe entries...")
        with self.engine.begin() as conn:
            conn.execute(text("DELETE FROM stock_scores"))
            conn.execute(text("DELETE FROM stock_factor_breakdown"))

            if results:
                conn.execute(text("""
                    INSERT INTO stock_scores
                        (symbol, timeframe, score, confidence, classification, top_domain,
                         positive_count, negative_count, reasons, last_updated)
                    VALUES
                        (:symbol, :timeframe, :score, :confidence, :classification, :top_domain,
                         :positive_count, :negative_count, :reasons, :last_updated)
                """), results)

                breakdowns = []
                for r in results:
                    factors = json.loads(r['factor_breakdown'])
                    breakdowns.append({
                        'symbol':      r['symbol'],
                        'timeframe':   r['timeframe'],
                        'technical':   factors.get('technical',   0),
                        'fundamental': factors.get('fundamental', 0),
                        'momentum':    factors.get('momentum',    0),
                        'valuation':   factors.get('valuation',   0),
                        'delivery':    factors.get('delivery',    0),
                        'news':        factors.get('news',        0),
                        'last_updated': r['last_updated'],
                    })

                conn.execute(text("""
                    INSERT INTO stock_factor_breakdown
                        (symbol, timeframe, technical, fundamental, momentum,
                         valuation, delivery, news, last_updated)
                    VALUES
                        (:symbol, :timeframe, :technical, :fundamental, :momentum,
                         :valuation, :delivery, :news, :last_updated)
                """), breakdowns)

        print("Ranking and scoring complete!")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AlphaQuant Scoring Engine")
    parser.add_argument("--rebuild", action="store_true",
                        help="Force-rebuild screener_master even if NLP version is unchanged")
    args = parser.parse_args()

    engine = AlphaQuantScoringEngine()
    engine.process_scoring(force_rebuild=args.rebuild)
