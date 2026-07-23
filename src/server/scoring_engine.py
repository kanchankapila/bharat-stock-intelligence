from pathlib import Path
import json
import datetime
import pandas as pd
import difflib
from sqlalchemy import text
from nlp_engine import NLPScreenerInference, NLP_VERSION
from typing import Dict, Any, List

from db_compat import get_engine, connect as db_connect


# ── Pure functions: regime-edge-adjusted ML win_probability consumption ────────
# win_probability has real live discrimination only in some regimes (e.g. BEAR) and ~coin-flip
# elsewhere (see ml_calibration.py). These are pure/DB-free so they're independently unit
# testable; the class wires them in behind app_settings.edge_adjustment_enabled (default off).

def apply_edge_adjustment_to_win_probs(win_prob_map: Dict[str, float], regime_map: Dict[str, str],
                                        edge_status: Dict[str, Any]) -> Dict[str, float]:
    """Shrink each symbol's win_probability toward neutral (0.5) per its own regime's proven
    live edge. Symbols with no known regime pass through unchanged."""
    from ml_calibration import edge_adjusted_probability
    out = {}
    for sym, wp in win_prob_map.items():
        regime = regime_map.get(sym)
        out[sym] = edge_adjusted_probability(wp, regime, edge_status) if regime else wp
    return out


def apply_ml_score_adjustment(final_score: float, normalized_score: float, wp) -> float:
    """ML consensus bonus / weak-probability discount, extracted from the scoring loop for unit
    testing. `wp` should already be edge-adjusted by the caller when the flag is enabled."""
    if wp is None:
        return final_score
    if normalized_score >= 60 and wp >= 0.55:
        return final_score * 1.10   # ML consensus bonus: both systems agree bullish
    if wp < 0.40:
        return final_score * (0.85 if wp < 0.30 else 0.92)   # ML sees weak probability
    return final_score


def ml_alignment_points(wp) -> int:
    """Factor 3: ML win_probability alignment (0-20 points), extracted for unit testing."""
    if wp is None:
        return 8  # neutral if no ML signal
    return min(20, int(wp * 24))   # wp=0.55 -> 13pts, wp=0.80 -> 19pts


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
        'Trendlyne':      1.0,
        'MoneyControl':   0.9,
        'ETnow':          0.85,
        'ETMarketstats':  0.8,
    }

    def __init__(self):
        self.engine = get_engine()
        self.nlp = NLPScreenerInference()
        self.stock_stats = {}
        self._drift_multiplier: float = 1.0
        self._drift_checked_ts: float = 0.0
        self._edge_status: Dict[str, Any] = {}
        self._edge_adjustment_enabled: bool = False
        self._edge_status_checked_ts: float = 0.0
        self._load_optimised_weights()
        self.etnow_screeners = self._load_etnow_screeners()
        self.et_marketstats_screeners = self._load_et_marketstats_screeners()

    def _refresh_drift_multiplier(self) -> None:
        import time
        if time.time() - self._drift_checked_ts < 3600:
            return
        try:
            from drift_detector import get_drift_multiplier
            self._drift_multiplier = get_drift_multiplier()
            self._drift_checked_ts = time.time()
            if self._drift_multiplier < 1.0:
                print(f"[Scoring] Drift haircut active: {self._drift_multiplier:.2f}x")
        except Exception:
            pass

    def _refresh_edge_status(self) -> None:
        """TTL-cached read of the regime_edge_status snapshot + the edge_adjustment_enabled
        flag (see ml_calibration.py) -- same 1hr cadence as _refresh_drift_multiplier. Uses
        db_compat.connect() (ConnWrapper), not self.engine -- ml_calibration's functions are
        written against ConnWrapper's ?-placeholder/dict-row API, not raw SQLAlchemy text()."""
        import time
        if time.time() - self._edge_status_checked_ts < 3600:
            return
        conn = None
        try:
            from ml_calibration import load_regime_edge_status, is_edge_adjustment_enabled
            conn = db_connect()
            self._edge_status = load_regime_edge_status(conn)
            self._edge_adjustment_enabled = is_edge_adjustment_enabled(conn)
            self._edge_status_checked_ts = time.time()
        except Exception:
            pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

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

    def _load_et_marketstats_screeners(self) -> list:
        """Read ET Marketstats/Technicals screeners from the database (source of truth)."""
        try:
            with self.engine.connect() as conn:
                rows = conn.execute(
                    text("SELECT screener_key AS scan_id, label AS name FROM et_marketstats_screeners")
                ).fetchall()
                return [{'scan_id': r.scan_id, 'name': r.name, 'is_positive': None} for r in rows]
        except Exception as e:
            print(f"[SCORING] Warning: could not load ET Marketstats screeners from DB: {e}")
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
            # symbol NOT LIKE guard: defense in depth against the URL-as-symbol corruption
            # class (root cause: a since-fixed trendlyne_screener_discovery.py bug; a DB
            # CHECK constraint now blocks it at the source, this is a second layer).
            tl_mappings = pd.read_sql(
                "SELECT screener_id AS scan_id, stock_id, symbol, last_seen FROM trendlyne_screener_stocks "
                "WHERE symbol IS NULL OR symbol NOT LIKE '%://%'",
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
                "SELECT scan_id, mcsymbol AS stock_id, symbol, last_seen FROM moneycontrol_screener_stocks",
                conn,
            )

            # ETnow (loaded from instance variable)
            et_screeners = pd.DataFrame(self.etnow_screeners)
            et_screeners['source'] = 'ETnow'
            et_screeners['description'] = ""

            et_mappings = pd.read_sql(
                "SELECT screener_id AS scan_id, symbol, stock_name AS stock_id, last_seen FROM etnow_screener_stocks",
                conn,
            )

            # ET Marketstats/Technicals (loaded from instance variable)
            ems_screeners = pd.DataFrame(self.et_marketstats_screeners)
            ems_screeners['source'] = 'ETMarketstats'
            ems_screeners['description'] = ""

            ems_mappings = pd.read_sql(
                "SELECT screener_key AS scan_id, symbol, stock_name AS stock_id, last_seen FROM et_marketstats_screener_stocks",
                conn,
            )

        screeners = pd.concat([tl_screeners, mc_screeners, et_screeners, ems_screeners], ignore_index=True)
        mappings  = pd.concat([tl_mappings, mc_mappings, et_mappings, ems_mappings],     ignore_index=True)
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
            INSERT INTO app_settings (key, value, "updatedAt")
            VALUES ('screener_nlp_version', :v, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = CURRENT_TIMESTAMP
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

                confidence = inference.get('confidence', 0.0)
                sentiment = inference['sentiment']

                # Skip NLP override if model is uncertain (< 80% confidence)
                if confidence < 0.8:
                    sentiment = 'neutral'

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
                    'confidence':         confidence,
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

        # Apply CSV bias overrides — CSV is authoritative over NLP inference
        self._apply_csv_bias_overrides()

        # Return full metadata from DB (includes previously-computed rows)
        return self._load_screener_metadata()

    def _apply_csv_bias_overrides(self):
        """Sync screener_master with curated values from screener_scoring_v2.csv.

        CSV is authoritative for: sentiment, timeframe, category, subcategory,
        confidence, and tier. NLP inference is a fallback only.
        """
        import csv as csv_mod, re
        csv_path = Path(__file__).parent.parent.parent / 'screener_scoring_v2.csv'
        if not csv_path.exists():
            return

        def slugify(s):
            return re.sub(r'[^a-z0-9]+', '-', s.lower().strip())[:120]

        # CSV investment_horizon → DB inferred_timeframe
        HORIZON_MAP = {
            'intraday':   'intraday',
            'long_term':  'long_term',
            'swing':      'long_term',
            'positional': 'long_term',
        }

        # CSV tier → weight_override (scoring engine multiplier)
        TIER_WEIGHT = {
            'S — Elite':   1.5,
            'A — High':    1.3,
            'B — Medium':  1.0,
            'C — Low':     0.7,
            'D — Marginal': 0.4,
            'F — Excluded': 0.0,
        }

        updates = []
        with open(csv_path, newline='', encoding='utf-8') as f:
            for row in csv_mod.DictReader(f):
                name = row.get('screener_name', '').strip()
                if not name:
                    continue
                sid = slugify(name)

                bias      = row.get('signal_bias', '').strip()
                horizon   = HORIZON_MAP.get(row.get('investment_horizon', '').strip())
                category  = row.get('category', '').strip()
                subcategory = row.get('subcategory', '').strip()
                tier      = row.get('tier', '').strip()
                try:
                    confidence = float(row.get('confidence') or 0) or None
                except ValueError:
                    confidence = None

                if bias not in ('bullish', 'bearish', 'neutral'):
                    bias = None

                weight = TIER_WEIGHT.get(tier) if tier else None

                updates.append({
                    'sid': sid,
                    'bias': bias,
                    'horizon': horizon,
                    'category': category or None,
                    'subcategory': subcategory or None,
                    'tier': tier or None,
                    'confidence': confidence,
                    'weight': weight,
                })

        if not updates:
            return

        with self.engine.begin() as conn:
            applied = 0
            for u in updates:
                fields, params = [], {'sid': u['sid']}
                if u['bias']:
                    fields.append('inferred_sentiment=:bias'); params['bias'] = u['bias']
                if u['horizon']:
                    fields.append('inferred_timeframe=:horizon'); params['horizon'] = u['horizon']
                if u['category']:
                    fields.append('inferred_category=:category'); params['category'] = u['category']
                if u['subcategory']:
                    fields.append('subcategory=:subcategory'); params['subcategory'] = u['subcategory']
                if u['tier']:
                    fields.append('tier=:tier'); params['tier'] = u['tier']
                if u['confidence'] is not None:
                    fields.append('confidence=:confidence'); params['confidence'] = u['confidence']
                if u['weight'] is not None:
                    fields.append('weight_override=:weight'); params['weight'] = u['weight']
                if not fields:
                    continue
                result = conn.execute(
                    text(f"UPDATE screener_master SET {', '.join(fields)} WHERE scan_id=:sid"),
                    params
                )
                applied += result.rowcount

        print(f"[ScoringEngine] CSV sync applied to {applied} screener_master rows.")

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
            import math
            last = datetime.datetime.fromisoformat(str(last_updated_str))
            # Strip tzinfo so arithmetic works regardless of DB backend (SQLite naive vs Postgres aware)
            if last.tzinfo is not None:
                last = last.replace(tzinfo=None)
            age_days = max(0, (datetime.datetime.utcnow() - last).days)
            return math.exp(-math.log(2) * age_days / AlphaQuantScoringEngine.DECAY_HALFLIFE_DAYS)
        except Exception:
            return 1.0

    @staticmethod
    def _news_recency_weight(published_at_str) -> float:
        try:
            import math
            published = datetime.datetime.fromisoformat(str(published_at_str))
            # Normalise to naive UTC to avoid SQLite-naive vs Postgres-aware mismatches
            if published.tzinfo is not None:
                published = published.replace(tzinfo=None)
            now = datetime.datetime.utcnow()

            # Count weekend days between published and now
            weekend_days = 0
            current = published.date()
            while current <= now.date():
                if current.weekday() >= 5:  # 5=Sat, 6=Sun
                    weekend_days += 1
                current += datetime.timedelta(days=1)

            age_hours = max(0, (now - published).total_seconds() / 3600)
            # Subtract weekend hours (max subtracting age_hours to prevent negative)
            adjusted_age_hours = max(0, age_hours - (weekend_days * 24))

            return math.exp(-math.log(2) * adjusted_age_hours / 48)  # 2-day half-life
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
                # cutoff computed in Python — datetime('now',...) is SQLite-only and these
                # text() / read_sql strings bypass the translator (raw SQLAlchemy engine).
                news_cutoff = (datetime.datetime.now() - datetime.timedelta(days=7)).isoformat()
                news_df = pd.read_sql(
                    text("""SELECT symbols_json AS symbols, sentiment, sentiment_score, impact, title, source, published_at
                       FROM news_sentiment_items
                       WHERE published_at >= :cutoff
                         AND sentiment != 'NEUTRAL'"""),
                    conn,
                    params={"cutoff": news_cutoff},
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
                news_df['sentiment_score'] = 1.0  # Fallback
                news_df['impact'] = 'MEDIUM'      # Fallback
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
                    'sentiment_score': n.get('sentiment_score', 1.0),
                    'impact':    n.get('impact', 'MEDIUM'),
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

        # Load latest win_probability (+ the regime it was set in) per symbol from ML-scored
        # technical signal rows. DISTINCT ON picks the row that supplied the MAX probability.
        win_prob_map: Dict[str, float] = {}
        win_prob_regime_map: Dict[str, str] = {}
        try:
            wp_cutoff = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
            with self.engine.connect() as conn:
                wp_rows = conn.execute(text("""
                    SELECT DISTINCT ON (symbol) symbol, nifty_regime,
                           COALESCE(calibrated_win_probability, win_probability) AS wp
                    FROM technical_signals
                    WHERE date >= :cutoff
                      AND win_probability IS NOT NULL
                    ORDER BY symbol, COALESCE(calibrated_win_probability, win_probability) DESC
                """), {"cutoff": wp_cutoff}).fetchall()
            win_prob_map = {r[0]: float(r[2]) for r in wp_rows}
            win_prob_regime_map = {r[0]: r[1] for r in wp_rows}
        except Exception:
            pass

        # Apply drift multiplier to win_probability values (haircut when feature drift detected)
        self._refresh_drift_multiplier()
        if self._drift_multiplier < 1.0:
            win_prob_map = {sym: round(wp * self._drift_multiplier, 4)
                           for sym, wp in win_prob_map.items()}

        # Edge-adjust win_probability per symbol's own regime when enabled (see ml_calibration.py
        # -- win_probability has real live discrimination only in some regimes, e.g. BEAR; this
        # shrinks it toward neutral 0.5 elsewhere instead of trusting it uniformly). Off by
        # default -- app_settings.edge_adjustment_enabled='true' to activate.
        self._refresh_edge_status()
        if self._edge_adjustment_enabled:
            win_prob_map = apply_edge_adjustment_to_win_probs(
                win_prob_map, win_prob_regime_map, self._edge_status)

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

        # Load realized signal-type performance weights (EMA-smoothed reward multipliers)
        # and map each symbol to the performance of its BEST currently-active setup.
        # This makes the composite performance-AWARE: a stock carrying a historically
        # high-accuracy setup (e.g. EMA_BULL_STACK, ~65% realized 5d win-rate) is no longer
        # diluted down to the mean by a basket of weak screeners. We gate on the best setup
        # (max) rather than averaging, to preserve the edge. Bounded to [0.7, 1.4] so it
        # tilts the ranking without dominating it. Empty data => 1.0 (no behaviour change).
        signal_quality_map: Dict[str, float] = {}
        sym_signal_types: Dict[str, list] = {}  # used later for prior blend
        try:
            with self.engine.connect() as conn:
                stw = conn.execute(text(
                    "SELECT signal_type, AVG(weight) FROM signal_type_weights GROUP BY signal_type"
                )).fetchall()
                type_weight = {r[0]: float(r[1]) for r in stw if r[0]}
                sig_cutoff = (datetime.date.today() - datetime.timedelta(days=3)).isoformat()
                sig_rows = conn.execute(text("""
                    SELECT symbol, signals_json FROM technical_signals
                    WHERE date >= :cutoff AND signals_json IS NOT NULL
                """), {"cutoff": sig_cutoff}).fetchall()
            for sym, sj in sig_rows:
                try:
                    types = [s.get('type') for s in json.loads(sj) if isinstance(s, dict)]
                except Exception:
                    continue
                sym_signal_types[sym] = types
                weights = [type_weight[t] for t in types if t in type_weight]
                if weights:
                    signal_quality_map[sym] = max(0.7, min(1.4, max(weights)))
            if signal_quality_map:
                print(f"[SCORING] Loaded signal-quality multipliers for {len(signal_quality_map)} symbols "
                      f"({len(type_weight)} signal types).")
        except Exception as e:
            print(f"[SCORING] signal-quality map unavailable (defaulting to neutral): {e}")

        # Blend win_probability with Beta-Bernoulli signal-type priors (15% prior weight)
        # Priors encode each signal type's historical win-rate; prevents overconfidence on
        # rare setups with few observations while preserving ensemble signal for common ones.
        if win_prob_map and sym_signal_types:
            try:
                with self.engine.connect() as conn:
                    pr_row = conn.execute(text(
                        "SELECT value FROM app_settings WHERE key = 'signal_type_priors'"
                    )).fetchone()
                if pr_row:
                    _priors = json.loads(pr_row[0])
                    from signal_type_priors import get_posterior_mean
                    prior_weight = 0.15
                    blended = 0
                    for sym, types in sym_signal_types.items():
                        if sym not in win_prob_map or not types:
                            continue
                        post = get_posterior_mean(_priors, types[0])  # best (most recent) signal type
                        wp = win_prob_map[sym]
                        win_prob_map[sym] = round((1 - prior_weight) * wp + prior_weight * post, 4)
                        blended += 1
                    if blended:
                        print(f"[SCORING] Signal-type prior blend applied to {blended} symbols.")
            except Exception as e:
                print(f"[SCORING] Prior blend skipped: {e}")

        # Load Global Market Score for True Alpha (Beta) adjustment
        market_global_score = 0.0
        try:
            with self.engine.connect() as conn:
                g_row = conn.execute(text("""
                    SELECT global_score FROM market_sentiment_snapshots 
                    ORDER BY snapshot_at DESC LIMIT 1
                """)).fetchone()
                if g_row:
                    market_global_score = float(g_row[0])
        except Exception as e:
            print(f"[SCORING] Failed to load market_global_score: {e}")

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
                
                # Sort news by recency first to prioritize the most recent ones in deduplication
                news_items = sorted(news_items, key=lambda x: x.get('recency', 0), reverse=True)
                
                processed_titles = []
                
                for item in news_items:
                    # 1. Syndicate Spam Deduplication
                    is_syndicated = False
                    for p_title in processed_titles:
                        if difflib.SequenceMatcher(None, str(item['name']).lower(), str(p_title).lower()).ratio() > 0.85:
                            is_syndicated = True
                            break
                    
                    if not is_syndicated:
                        processed_titles.append(item['name'])
                    
                    # Sentiment direction
                    mult = 1 if item['sentiment'] == 'positive' else (-1 if item['sentiment'] == 'negative' else 0)
                    if mult == 0:
                        continue
                        
                    # Magnitude and Impact
                    continuous_score = abs(float(item.get('sentiment_score', 1.0)))
                    impact_val = item.get('impact', 'MEDIUM').upper()
                    impact_mult = 1.5 if impact_val == 'HIGH' else (0.5 if impact_val == 'LOW' else 1.0)
                    
                    bucket = f"news|news|{'bullish' if mult > 0 else 'bearish'}"
                    
                    # If syndicated, it doesn't count towards the source limit (treated as already hitting the decay cap)
                    if is_syndicated:
                        decay = self.SOURCE_CAT_DECAY
                    else:
                        cnt = news_src_counts.get(bucket, 0)
                        decay = 1.0 if cnt < self.SOURCE_CAT_CAP else self.SOURCE_CAT_DECAY
                        news_src_counts[bucket] = cnt + 1
                        
                    recency = item.get('recency', 1.0)
                    source_quality = self.NEWS_SOURCE_QUALITY.get(item.get('source', ''), 0.90)
                    
                    # Calculate contribution using continuous score and impact multiplier
                    contrib = 5.0 * mult * continuous_score * impact_mult * decay * recency * source_quality
                    
                    stock_scores[symbol]['raw_sum'] += contrib
                    stock_scores[symbol]['factors']['news'] += contrib
                    
                    if not is_syndicated:
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

                # Recency decay: prefer stock-level last_seen, fall back to screener last_updated
                stock_last_seen = m.get('last_seen')
                recency = self._recency_weight(
                    stock_last_seen if (stock_last_seen and not pd.isna(stock_last_seen))
                    else (screener_updated.get(scan_id) or '')
                )

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
                final_score = apply_ml_score_adjustment(final_score, normalized_score, wp)

                screener_count = len(data['positive_screeners']) + len(data['negative_screeners'])
                source_count   = len(data['sources'])
                cat_count      = len(data['categories'])

                # Factor 1: source diversity (0–40 points) — cross-source agreement is strongest signal
                source_pts = min(40, source_count * 14)  # 1 src=14, 2 src=28, 3 src=40

                # Factor 2: category breadth (0–30 points) — multi-domain consensus
                cat_pts = min(30, cat_count * 8)  # 1 cat=8, 2=16, 3=24, 4+=30

                # Factor 3: ML win_probability alignment (0–20 points)
                wp = win_prob_map.get(symbol)
                ml_pts = ml_alignment_points(wp)

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
                    
                # True Alpha (Market Beta Adjustment)
                # Bullish stocks in a bull market: slight discount (beta-adjusted, not pure alpha).
                # Bullish stocks in a bear market: amplify (stock fighting the tide = strong signal).
                # Bearish stocks in a bear market: amplify (bear momentum confirmation).
                # Bearish stocks in a bull market: discount (contrarian, less reliable).
                if final_score > 0:
                    if market_global_score > 0.3:
                        final_score *= 0.90   # bullish stock, bullish market → trim beta
                    elif market_global_score < -0.3:
                        final_score *= 1.10   # bullish stock, bearish market → amplify alpha
                elif final_score < 0:
                    if market_global_score < -0.3:
                        final_score *= 1.10   # bearish stock, bearish market → amplify (was 0.90 — BUG FIXED)
                    elif market_global_score > 0.3:
                        final_score *= 0.90   # bearish stock, bullish market → discount (was 1.10 — BUG FIXED)

                # Signal-quality tilt: respect the realized performance of the stock's
                # best active technical setup instead of letting the screener basket dilute it.
                sq_mult = signal_quality_map.get(symbol, 1.0)
                if sq_mult != 1.0:
                    final_score *= sq_mult

                # Max total points: 40 + 30 + 20 + 10 + 20 = 120. Scale down to 100.
                raw_confidence = source_pts + cat_pts + ml_pts + vol_pts + tc_pts
                
                # Divergence Penalty
                pos_count = len(data['positive_screeners'])
                neg_count = len(data['negative_screeners'])
                if pos_count > 0 and neg_count > 0:
                    ratio = min(pos_count, neg_count) / max(pos_count, neg_count)
                    # If high divergence (ratio > 0.3) and meaningful volume, penalize confidence
                    if ratio > 0.3 and (pos_count + neg_count) >= 4:
                        penalty = 20 * ratio # Up to 20 points penalty for complete divergence (1.0 ratio)
                        raw_confidence = max(0, raw_confidence - penalty)
                
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
            if results:
                conn.execute(text("""
                    INSERT INTO stock_scores
                        (symbol, timeframe, score, confidence, classification, top_domain,
                         positive_count, negative_count, reasons, last_updated)
                    VALUES
                        (:symbol, :timeframe, :score, :confidence, :classification, :top_domain,
                         :positive_count, :negative_count, :reasons, :last_updated)
                    ON CONFLICT(symbol, timeframe) DO UPDATE SET
                        score=excluded.score, confidence=excluded.confidence,
                        classification=excluded.classification, top_domain=excluded.top_domain,
                        positive_count=excluded.positive_count, negative_count=excluded.negative_count,
                        reasons=excluded.reasons, last_updated=excluded.last_updated
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
                    ON CONFLICT(symbol, timeframe) DO UPDATE SET
                        technical=excluded.technical, fundamental=excluded.fundamental,
                        momentum=excluded.momentum, valuation=excluded.valuation,
                        delivery=excluded.delivery, news=excluded.news,
                        last_updated=excluded.last_updated
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
                    updates = ', '.join(
                        f'{k}=excluded.{k}' for k in row.keys()
                        if k not in ('symbol', 'signal_date', 'timeframe', 'source')
                    )
                    conn.execute(text(f"""
                        INSERT INTO recommendation_log ({keys}) VALUES ({places})
                        ON CONFLICT(symbol, signal_date, timeframe, source) DO UPDATE SET {updates}
                    """), row)
            print(f"[ScoringEngine] Logged {len(rows)} recommendations to recommendation_log.")
        except Exception as e:
            print(f"[ScoringEngine] recommendation_log error: {e}")


from pydantic import BaseModel

class ScoringRequest(BaseModel):
    rebuild: bool = False

def run_scoring(req: ScoringRequest):
    engine = AlphaQuantScoringEngine()
    engine.process_scoring(force_rebuild=req.rebuild)

    import requests
    try:
        requests.post("http://127.0.0.1:3000/api/internal/notify", json={
            "type": "SUCCESS",
            "title": "Scoring Complete",
            "message": "The AI Quant Engine has finished calculating new scores."
        }, timeout=2)
    except requests.RequestException:
        pass

    return {"message": "Scoring engine completed successfully", "rebuild": req.rebuild}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AlphaQuant Scoring Engine")
    parser.add_argument("--rebuild", action="store_true",
                        help="Force-rebuild screener_master even if NLP version is unchanged")
    args = parser.parse_args()

    engine = AlphaQuantScoringEngine()
    engine.process_scoring(force_rebuild=args.rebuild)
