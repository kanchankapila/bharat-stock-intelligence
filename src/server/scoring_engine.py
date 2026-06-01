from pathlib import Path
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
DB_PATH      = Path(__file__).parent.parent.parent / "database.sqlite"
DATABASE_URL = f"sqlite:///{DB_PATH}"


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
        self._load_optimised_weights()
        self.etnow_screeners = self._load_etnow_screeners()

    def _load_optimised_weights(self):
        """Override default weights with ML-optimised values from app_settings if available."""
        try:
            with self.engine.connect() as conn:
                row = conn.execute(
                    text("SELECT value FROM app_settings WHERE key = 'optimal_category_weights'")
                ).fetchone()
                if row:
                    loaded = json.loads(row[0])
                    self.CATEGORY_WEIGHTS = {**self.CATEGORY_WEIGHTS, **loaded}

                row2 = conn.execute(
                    text("SELECT value FROM app_settings WHERE key = 'optimal_source_weights'")
                ).fetchone()
                if row2:
                    loaded2 = json.loads(row2[0])
                    self.SOURCE_WEIGHTS = {**self.SOURCE_WEIGHTS, **loaded2}
        except Exception:
            pass  # use defaults if app_settings not populated yet

    def _load_etnow_screeners(self) -> list:
        """Read ETnow screeners from the database (source of truth)."""
        try:
            with self.engine.connect() as conn:
                rows = conn.execute(
                    text("SELECT screener_id AS scan_id, screener_name AS name FROM etnow_screeners")
                ).fetchall()
                return [{'scan_id': r.scan_id, 'name': r.name, 'is_positive': None} for r in rows]
        except Exception as e:
            print(f"[SCORING] Warning: could not load ETnow screeners from DB: {e}")
            return []

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

            # ETnow (loaded from instance variable)
            et_screeners = pd.DataFrame(self.etnow_screeners)
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
                    'signal_type_tag':    inference.get('signal_type_tag', 'OTHER'),
                    'last_updated':       datetime.datetime.now().isoformat(),
                })

            if new_master_data:
                conn.execute(text("""
                    INSERT INTO screener_master
                        (scan_id, name, source, inferred_sentiment, inferred_category,
                         inferred_timeframe, confidence, signal_type_tag, last_updated)
                    VALUES
                        (:scan_id, :name, :source, :inferred_sentiment, :inferred_category,
                         :inferred_timeframe, :confidence, :signal_type_tag, :last_updated)
                    ON CONFLICT(scan_id) DO UPDATE SET
                        name=excluded.name,
                        inferred_sentiment=excluded.inferred_sentiment,
                        inferred_category=excluded.inferred_category,
                        inferred_timeframe=excluded.inferred_timeframe,
                        confidence=excluded.confidence,
                        signal_type_tag=excluded.signal_type_tag,
                        last_updated=excluded.last_updated
                """), new_master_data)

            # Persist version so next run skips rebuild
            self._set_stored_nlp_version(conn, NLP_VERSION)

        # Return full metadata from DB (includes previously-computed rows)
        return self._load_screener_metadata()

    def _load_screener_metadata(self) -> Dict[str, Any]:
        with self.engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT scan_id, name, source, inferred_sentiment, inferred_category, "
                "inferred_timeframe, confidence, COALESCE(weight_override, 1.0) AS weight_override, "
                "COALESCE(signal_type_tag, 'OTHER') AS signal_type_tag "
                "FROM screener_master"
            )).fetchall()
        return {
            r[0]: {
                'name':            r[1],
                'source':          r[2],
                'sentiment':       r[3],
                'category':        r[4],
                'timeframe':       r[5],
                'confidence':      r[6],
                'weight_override': float(r[7]),
                'signal_type_tag': r[8],
            }
            for r in rows
        }

    # ------------------------------------------------------------------
    # Scoring
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Source deduplication: cap contribution per (source, category, sentiment)
    # bucket so correlated signals don't inflate raw_sum.
    # E.g. 8 bullish Trendlyne technical screeners → max 2.5× base, not 8×.
    # ------------------------------------------------------------------
    SOURCE_CAT_CAP = 2.5   # max screeners per (source, category) that count fully
    SOURCE_CAT_DECAY = 0.3  # each additional screener beyond cap adds only 30%

    @staticmethod
    def _source_cat_key(meta: dict) -> str:
        return f"{meta['source']}|{meta['signal_type_tag']}|{meta['sentiment']}"

    # ------------------------------------------------------------------
    # Recency decay: screeners last_updated > DECAY_HALFLIFE_DAYS ago
    # are down-weighted exponentially. Keeps stale data from over-influencing.
    # ------------------------------------------------------------------
    DECAY_HALFLIFE_DAYS = 30  # score halves every 30 days

    # Quality tier for news sources (used as multiplier on news contribution)
    NEWS_SOURCE_QUALITY: dict[str, float] = {
        # Tier 1 — institutional / wire services
        'Reuters Business':          1.3,
        'Reuters India':             1.3,
        'Financial Times':           1.3,
        'Business Standard Markets': 1.2,
        'Business Standard Companies': 1.2,
        # Tier 2 — established financial media
        'Economic Times Markets':    1.0,
        'Economic Times Economy':    1.0,
        'LiveMint Markets':          1.0,
        'LiveMint Companies':        1.0,
        'MoneyControl Latest':       1.0,
        'MoneyControl Markets':      1.0,
        # Tier 3 — commentary / aggregators
        'Hindu BusinessLine':        0.85,
        'NDTV Profit':               0.80,
    }

    @staticmethod
    def _recency_weight(last_updated_str: str) -> float:
        try:
            last = datetime.datetime.fromisoformat(str(last_updated_str))
            age_days = max(0, (datetime.datetime.now() - last).days)
            import math
            return math.exp(-math.log(2) * age_days / AlphaQuantScoringEngine.DECAY_HALFLIFE_DAYS)
        except Exception:
            return 1.0

    @staticmethod
    def _news_recency_weight(published_at_str) -> float:
        try:
            import math
            published = datetime.datetime.fromisoformat(str(published_at_str))
            age_hours = max(0, (datetime.datetime.now() - published).total_seconds() / 3600)
            return math.exp(-math.log(2) * age_hours / 48)  # 2-day half-life
        except Exception:
            return 1.0

    def process_scoring(self, force_rebuild: bool = False):
        print(f"Starting AlphaQuant Scoring Engine v3 (Dedup+Decay) at {datetime.datetime.now()}")
        self._load_optimised_weights()
        print(f"[SCORING] Reloaded optimised weights from app_settings")
        screeners, mappings = self.load_data()

        print("Building screener metadata (NLP inference)...")
        screeners_meta = self.build_screener_metadata(screeners, force_rebuild=force_rebuild)
        print(f"screener_master has {len(screeners_meta)} entries.")

        # Load news sentiment from enriched table first, fall back to legacy
        print("Loading news sentiment data...")
        with self.engine.connect() as conn:
            try:
                news_df = pd.read_sql(
                    """SELECT symbols_json AS symbols, sentiment, title, source, published_at
                       FROM news_sentiment_items
                       WHERE published_at >= datetime('now', '-7 days')
                         AND sentiment != 'NEUTRAL'""",
                    conn,
                )
                # Normalise: BULLISH→positive, BEARISH→negative
                news_df['sentiment'] = news_df['sentiment'].str.lower().map(
                    {'bullish': 'positive', 'bearish': 'negative'}
                ).fillna('neutral')
                news_df['is_json_symbols'] = True
            except Exception:
                news_df = pd.read_sql(
                    "SELECT symbols, sentiment, title, source, timestamp AS published_at FROM news_articles",
                    conn,
                )
                news_df['sentiment'] = news_df['sentiment'].str.lower()
                news_df['is_json_symbols'] = False

        news_map: Dict[str, list] = {}
        for _, n in news_df.iterrows():
            raw = n.get('symbols') or ''
            if not raw:
                continue
            # Support both JSON arrays (new table) and comma-separated (legacy)
            try:
                sym_list = json.loads(raw) if str(raw).startswith('[') else [s.strip() for s in str(raw).split(',')]
            except Exception:
                sym_list = [s.strip() for s in str(raw).split(',')]
            recency = self._news_recency_weight(n.get('published_at') or '')
            for s in sym_list:
                if not s or not isinstance(s, str) or pd.isna(s) or s.strip() == '' or s.upper() in ('NAN', 'NULL', '#N/A'):
                    continue
                news_map.setdefault(s, []).append({
                    'name':      n['title'],
                    'sentiment': n['sentiment'],
                    'source':    n.get('source', 'news'),
                    'category':  'news',
                    'recency':   recency,
                })

        # Attach last_updated to screener metadata for recency decay
        with self.engine.connect() as conn:
            sm_rows = conn.execute(text(
                "SELECT scan_id, last_updated FROM screener_master"
            )).fetchall()
        screener_updated = {r[0]: r[1] for r in sm_rows}

        # Load latest win_probability per symbol from ML ensemble
        win_prob_map: Dict[str, float] = {}
        try:
            with self.engine.connect() as conn:
                wp_rows = conn.execute(text("""
                    SELECT symbol, MAX(win_probability) AS wp
                    FROM technical_analysis_signals
                    WHERE created_at >= datetime('now', '-1 day')
                      AND win_probability IS NOT NULL
                    GROUP BY symbol
                """)).fetchall()
            win_prob_map = {r[0]: float(r[1]) for r in wp_rows}
        except Exception:
            pass

        # Load Technical Composite Score
        tech_composite_map: Dict[str, float] = {}
        try:
            with self.engine.connect() as conn:
                tc_rows = conn.execute(text("""
                    SELECT symbol, composite_score
                    FROM technical_composite_scores
                """)).fetchall()
            tech_composite_map = {r[0]: float(r[1]) for r in tc_rows}
        except Exception as e:
            print(f"[SCORING] Failed to load technical_composite_scores: {e}")

        # Score per timeframe
        timeframes = ['long_term', 'intraday']
        all_timeframe_results = []

        for tf in timeframes:
            print(f"Processing {tf} rankings...")
            stock_scores: Dict[str, dict] = {}

            def _init_stock(sym: str):
                stock_scores.setdefault(sym, {
                    'raw_sum': 0.0,
                    'factors': {cat: 0.0 for cat in self.CATEGORY_WEIGHTS},
                    'positive_screeners': [],
                    'negative_screeners': [],
                    'sources': set(),
                    'categories': set(),
                    'source_cat_counts': {},  # tracks dedup per (src|cat|sent) bucket
                })

            # ── News seed (both timeframes) ──────────────────────────────
            for symbol, news_items in news_map.items():
                _init_stock(symbol)
                news_src_counts: Dict[str, int] = {}
                for item in news_items:
                    mult = 1 if item['sentiment'] == 'positive' else (-1 if item['sentiment'] == 'negative' else 0)
                    if mult == 0:
                        continue
                    bucket = f"news|news|{'bullish' if mult > 0 else 'bearish'}"
                    cnt = news_src_counts.get(bucket, 0)
                    # Dedup: first SOURCE_CAT_CAP news items count fully, rest at DECAY
                    decay = 1.0 if cnt < self.SOURCE_CAT_CAP else self.SOURCE_CAT_DECAY
                    news_src_counts[bucket] = cnt + 1
                    recency = item.get('recency', 1.0)
                    # News base is 5.0 (same as screeners — was 7.0, reduced to prevent over-dominance)
                    source_quality = self.NEWS_SOURCE_QUALITY.get(item.get('source', ''), 0.90)
                    contrib = 5.0 * mult * decay * recency * source_quality
                    stock_scores[symbol]['raw_sum'] += contrib
                    stock_scores[symbol]['factors']['news'] += contrib
                    stock_scores[symbol]['sources'].add(item['source'])
                    stock_scores[symbol]['categories'].add('news')
                    lst = stock_scores[symbol]['positive_screeners' if mult > 0 else 'negative_screeners']
                    lst.append({'name': item['name'], 'sentiment': item['sentiment'],
                                'source': item['source'], 'category': 'news'})

            # ── Screener scoring ─────────────────────────────────────────
            for _, m in mappings.iterrows():
                symbol = m['symbol']
                if not symbol or not isinstance(symbol, str) or pd.isna(symbol) or symbol.strip() == '' or symbol.upper() in ('NAN', 'NULL', '#N/A'):
                    continue
                scan_id = m['scan_id']
                meta = screeners_meta.get(scan_id)
                if not meta:
                    continue

                is_fundamental = meta['category'] in ('fundamental', 'valuation')
                if not is_fundamental and meta['timeframe'] != tf:
                    continue

                _init_stock(symbol)

                base_score  = 5.0
                sentiment_mult = 1 if meta['sentiment'] == 'bullish' else -1
                cat_weight  = self.CATEGORY_WEIGHTS.get(meta['category'], 0.5)
                src_weight  = self.SOURCE_WEIGHTS.get(meta['source'], 0.9)

                # Recency decay on screener itself
                recency = self._recency_weight(screener_updated.get(scan_id) or '')

                # Source-category deduplication
                bucket = self._source_cat_key(meta)
                scc = stock_scores[symbol]['source_cat_counts']
                cnt = scc.get(bucket, 0)
                dedup = 1.0 if cnt < self.SOURCE_CAT_CAP else self.SOURCE_CAT_DECAY
                scc[bucket] = cnt + 1

                override = meta.get('weight_override', 1.0)
                contrib = base_score * cat_weight * src_weight * sentiment_mult * recency * dedup * override
                cat_key = meta['category'] if meta['category'] in self.CATEGORY_WEIGHTS else 'other'

                stock_scores[symbol]['raw_sum'] += contrib
                stock_scores[symbol]['factors'][cat_key] += contrib
                stock_scores[symbol]['sources'].add(meta['source'])
                stock_scores[symbol]['categories'].add(meta['category'])

                reason = {'name': meta['name'], 'sentiment': meta['sentiment'],
                          'source': meta['source'], 'category': meta['category']}
                lst_key = 'positive_screeners' if meta['sentiment'] == 'bullish' else 'negative_screeners'
                stock_scores[symbol][lst_key].append(reason)

            # ── Final score aggregation ──────────────────────────────────
            for symbol, data in stock_scores.items():
                cat_count = len(data['categories'])
                # Multi-category consensus bonus (capped at 3 categories → +20%)
                consensus_mult = 1.0 + min(0.1 * (cat_count - 1), 0.20)
                final_score = data['raw_sum'] * consensus_mult

                normalized_score = min(100, max(0, 50 + (final_score * 2)))
                wp = win_prob_map.get(symbol)
                if wp is not None:
                    if normalized_score >= 60 and wp >= 0.55:
                        final_score *= 1.10   # ML consensus bonus: both systems agree bullish
                    elif wp < 0.40:
                        # ML sees weak probability — discount composite score
                        discount = 0.85 if wp < 0.30 else 0.92
                        final_score *= discount

                screener_count = len(data['positive_screeners']) + len(data['negative_screeners'])
                source_count   = len(data['sources'])
                cat_count      = len(data['categories'])

                # Factor 1: source diversity (0–40 points) — cross-source agreement is strongest signal
                source_pts = min(40, source_count * 14)  # 1 src=14, 2 src=28, 3 src=40

                # Factor 2: category breadth (0–30 points) — multi-domain consensus
                cat_pts = min(30, cat_count * 8)  # 1 cat=8, 2=16, 3=24, 4+=30

                # Factor 3: ML win_probability alignment (0–20 points)
                wp = win_prob_map.get(symbol)
                if wp is not None:
                    ml_pts = min(20, int(wp * 24))   # wp=0.55 → 13pts, wp=0.80 → 19pts
                else:
                    ml_pts = 8  # neutral if no ML signal

                # Factor 4: screener volume (0–10 points) — secondary signal of conviction
                vol_pts = min(10, screener_count * 2)

                # Factor 5: Technical Composite Score (0-20 points) — distinct technical pillar
                tc_score = tech_composite_map.get(symbol, 0)
                tc_pts = 0
                if tc_score > 0:
                    tc_pts = min(20, (tc_score / 100.0) * 20)
                    # Inject into the technical factor to ensure it shows up alongside fundamental/momentum/valuation
                    data['factors']['technical'] = data['factors'].get('technical', 0) + (tc_score / 10.0)
                    # Also boost the raw final_score slightly based on technical strength
                    final_score += (tc_score - 50) / 10.0

                # Max total points: 40 + 30 + 20 + 10 + 20 = 120. Scale down to 100.
                raw_confidence = source_pts + cat_pts + ml_pts + vol_pts + tc_pts
                confidence = int(min(95, max(5, raw_confidence * (100/120))))   # cap at 95 (never report 100% certainty)

                # Calibrated classification thresholds
                if   final_score > 30:   classification = "Strong Buy"
                elif final_score > 10:   classification = "Buy"
                elif final_score < -20:  classification = "Strong Sell"
                elif final_score < -5:   classification = "Sell"
                else:                    classification = "Hold"

                normalized_score = min(100, max(0, 50 + (final_score * 2)))

                top_domain = "Other"
                if data['factors']:
                    abs_f = {k: abs(v) for k, v in data['factors'].items()}
                    top_domain = max(abs_f, key=abs_f.get).capitalize()

                all_timeframe_results.append({
                    'symbol':           symbol,
                    'timeframe':        tf,
                    'score':            normalized_score,
                    'confidence':       confidence,
                    'classification':   classification,
                    'top_domain':       top_domain,
                    'positive_count':   len(data['positive_screeners']),
                    'negative_count':   len(data['negative_screeners']),
                    'reasons':          json.dumps(data['positive_screeners'] + data['negative_screeners']),
                    'factor_breakdown': json.dumps(data['factors']),
                    'last_updated':     datetime.datetime.now().isoformat(),
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
        self._log_recommendations(results)

    def _log_recommendations(self, results: list):
        """Write top BUY/STRONG BUY recommendations to recommendation_log for outcome tracking."""
        now        = datetime.datetime.now().isoformat()
        today      = datetime.date.today().isoformat()
        candidates = [r for r in results if r.get('classification') in ('Strong Buy', 'Buy')]
        if not candidates:
            return

        rows = []
        for r in candidates:
            rows.append({
                'symbol':         r['symbol'],
                'rec_type':       'BUY' if r['classification'] == 'Buy' else 'STRONG_BUY',
                'signal_date':    today,
                'generated_at':   now,
                'timeframe':      r.get('timeframe', 'medium'),
                'confidence_score': r.get('confidence'),
                'screener_score': r.get('score'),
                'reasoning':      r.get('reasons', ''),
                'source':         'scoring_engine',
                'status':         'ACTIVE',
                'horizon_days':   15,
            })

        try:
            with self.engine.begin() as conn:
                for row in rows:
                    keys   = ', '.join(row.keys())
                    places = ', '.join(f':{k}' for k in row.keys())
                    conn.execute(text(f"""
                        INSERT OR IGNORE INTO recommendation_log ({keys}) VALUES ({places})
                    """), row)
            print(f"[ScoringEngine] Logged {len(rows)} recommendations to recommendation_log.")
        except Exception as e:
            print(f"[ScoringEngine] recommendation_log error: {e}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AlphaQuant Scoring Engine")
    parser.add_argument("--rebuild", action="store_true",
                        help="Force-rebuild screener_master even if NLP version is unchanged")
    args = parser.parse_args()

    engine = AlphaQuantScoringEngine()
    engine.process_scoring(force_rebuild=args.rebuild)
