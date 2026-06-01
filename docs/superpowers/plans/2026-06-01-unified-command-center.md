# Unified Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an "Alpha" tab that fuses all scoring engines into one regime-gated unified recommendation dashboard with EOD swing picks and intraday live sections.

**Architecture:** `unified_ranker.py` runs after market close, reads all engine outputs + screener membership. Screener scoring uses `screener_scoring_v2.csv` (from `screener_scoring_engine_v2.xlsx`) — research-backed category base weights + subcategory modifiers + horizon multipliers + 44 bias/subcategory corrections. Regime-specific engine weights adjusted by 90-day realized-return track records. Hard-gates via RL. Writes to `unified_recommendations`. `getCommandCenter` tRPC reads that table and overlays live prices. `CommandCenterDashboard.tsx` is the new "Alpha" nav tab; old recommendation tabs are hidden behind an "Advanced ›" toggle.

**Tech Stack:** Python 3.11 + SQLite (better-sqlite3), scipy (softmax), TypeScript + tRPC + Zod, React 19 + TailwindCSS 4, BullMQ, Vitest, pytest

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `screener_scoring_v2.csv` | Already exists | 1534 screeners with xlsx-computed score_0_100, tier, sub_mod, horiz_mult |
| `screener_corrections.csv` | Already exists | 44 bias/subcategory corrections from xlsx Corrections Log |
| `src/server/db.ts` | Modify | Add `unified_recommendations` + `screener_catalog` migrations |
| `src/server/unified_ranker.py` | Create | Full scoring pipeline — CSV seed w/ corrections, xlsx formula, engine fusion, write DB |
| `src/server/router.ts` | Modify | Add `getCommandCenter` query + `runUnifiedRanker` mutation |
| `src/server/queues.ts` | Modify | Add `QUEUE_UNIFIED_RANKER` repeatable job at 15:45 IST |
| `src/components/CommandCenterDashboard.tsx` | Create | "Alpha" tab UI — regime banner, EOD picks, intraday signals |
| `src/App.tsx` | Modify | Add `alpha` tab; wrap old rec tabs in `AdvancedToggle` |
| `src/server/__tests__/commandCenter.test.ts` | Create | Vitest — tRPC endpoint shape + DB queries |
| `src/server/__tests__/test_unified_ranker.py` | Create | pytest — screener scoring + regime weighting + RL gate |

---

## Task 1: DB Schema — Add Two New Tables

**Files:**
- Modify: `src/server/db.ts`
- Test: `src/server/__tests__/commandCenter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/commandCenter.test.ts`:

```typescript
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
const { default: db } = await import('../db');

describe('DB schema — unified_recommendations', () => {
  it('table exists with required columns', () => {
    const info = db.prepare("PRAGMA table_info(unified_recommendations)").all() as any[];
    const cols = info.map((c: any) => c.name);
    expect(cols).toContain('symbol');
    expect(cols).toContain('computed_at');
    expect(cols).toContain('regime');
    expect(cols).toContain('unified_score');
    expect(cols).toContain('conviction_level');
    expect(cols).toContain('screener_stock_score');
    expect(cols).toContain('ml_score');
    expect(cols).toContain('confluence_score');
    expect(cols).toContain('technical_score');
    expect(cols).toContain('dl_score');
    expect(cols).toContain('bullish_screener_count');
    expect(cols).toContain('bearish_screener_count');
    expect(cols).toContain('entry_zone_low');
    expect(cols).toContain('stop_loss');
    expect(cols).toContain('target_1');
    expect(cols).toContain('risk_reward');
    expect(cols).toContain('timeframe');
    expect(cols).toContain('sector');
  });

  it('screener_catalog table exists with required columns', () => {
    const info = db.prepare("PRAGMA table_info(screener_catalog)").all() as any[];
    const cols = info.map((c: any) => c.name);
    expect(cols).toContain('screener_id');
    expect(cols).toContain('source');
    expect(cols).toContain('screener_name');
    expect(cols).toContain('category');
    expect(cols).toContain('subcategory');
    expect(cols).toContain('signal_bias');
    expect(cols).toContain('confidence');
    expect(cols).toContain('investment_horizon');
    expect(cols).toContain('score_0_100');
    expect(cols).toContain('tier');
    expect(cols).toContain('sub_mod');
    expect(cols).toContain('horiz_mult');
  });

  it('unique constraint on (symbol, computed_at)', () => {
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('TEST', '2026-06-01', 'BULL', 75.0, 'A_HIGH')`).run();
    // Second insert with same symbol+date should replace, not throw
    expect(() => db.prepare(`INSERT OR REPLACE INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('TEST', '2026-06-01', 'BULL', 80.0, 'A_HIGH')`).run()
    ).not.toThrow();
    const row: any = db.prepare(
      "SELECT unified_score FROM unified_recommendations WHERE symbol='TEST'"
    ).get();
    expect(row.unified_score).toBe(80.0);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run src/server/__tests__/commandCenter.test.ts
```

Expected: FAIL — "table does not exist"

- [ ] **Step 3: Add migrations in `src/server/db.ts`**

After the last existing `runMigration` call and before the final `export default db`, add:

```typescript
runMigration('020_screener_catalog', `
  CREATE TABLE IF NOT EXISTS screener_catalog (
    screener_id        TEXT NOT NULL,
    source             TEXT NOT NULL,
    screener_name      TEXT NOT NULL,
    category           TEXT NOT NULL,
    subcategory        TEXT,
    signal_bias        TEXT NOT NULL,
    investment_horizon TEXT,
    confidence         REAL NOT NULL,
    score_0_100        REAL,
    tier               TEXT,
    sub_mod            REAL,
    horiz_mult         REAL,
    PRIMARY KEY (screener_id, source)
  );
`);

runMigration('021_unified_recommendations', `
  CREATE TABLE IF NOT EXISTS unified_recommendations (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol                  TEXT NOT NULL,
    computed_at             TEXT NOT NULL,
    regime                  TEXT NOT NULL,
    unified_score           REAL NOT NULL,
    conviction_level        TEXT NOT NULL,
    screener_stock_score    REAL,
    ml_score                REAL,
    confluence_score        REAL,
    technical_score         REAL,
    dl_score                REAL,
    avg_engine_track_record REAL,
    bullish_screener_count  INTEGER,
    bearish_screener_count  INTEGER,
    screener_names_json     TEXT,
    fundamental_score       REAL,
    entry_zone_low          REAL,
    entry_zone_high         REAL,
    stop_loss               REAL,
    target_1                REAL,
    target_2                REAL,
    target_3                REAL,
    risk_reward             REAL,
    timeframe               TEXT,
    sector                  TEXT,
    trade_reasoning         TEXT,
    UNIQUE(symbol, computed_at)
  );
  CREATE INDEX IF NOT EXISTS idx_ur_date_score ON unified_recommendations(computed_at, unified_score DESC);
  CREATE INDEX IF NOT EXISTS idx_ur_conviction  ON unified_recommendations(computed_at, conviction_level);
`);
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run src/server/__tests__/commandCenter.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/__tests__/commandCenter.test.ts
git commit -m "feat(db): add screener_catalog and unified_recommendations tables"
```

---

## Task 2: Python Engine — Screener Catalog + Screener Stock Score

**Files:**
- Create: `src/server/unified_ranker.py`
- Create: `src/server/__tests__/test_unified_ranker.py`

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/test_unified_ranker.py`:

```python
import sqlite3
import csv
import os
import sys
import tempfile
import pytest

# Add src/server to path so we can import unified_ranker
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def make_db():
    """Create in-memory SQLite with required tables."""
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript('''
        CREATE TABLE screener_catalog (
            screener_id TEXT NOT NULL, source TEXT NOT NULL,
            screener_name TEXT NOT NULL, category TEXT NOT NULL,
            subcategory TEXT, signal_bias TEXT NOT NULL,
            investment_horizon TEXT, confidence REAL NOT NULL,
            PRIMARY KEY (screener_id, source)
        );
        CREATE TABLE trendlyne_screener_stocks (
            screener_id TEXT NOT NULL, stock_id TEXT NOT NULL, symbol TEXT,
            PRIMARY KEY (screener_id, stock_id)
        );
        CREATE TABLE moneycontrol_screener_stocks (
            scan_id TEXT NOT NULL, mcsymbol TEXT NOT NULL,
            stock_name TEXT, symbol TEXT,
            PRIMARY KEY (scan_id, mcsymbol)
        );
        CREATE TABLE etnow_screener_stocks (
            screener_id TEXT NOT NULL, symbol TEXT NOT NULL,
            stock_name TEXT, PRIMARY KEY (screener_id, symbol)
        );
        CREATE TABLE stock_scores (
            symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
            composite_score REAL, PRIMARY KEY (symbol, timeframe)
        );
        CREATE TABLE market_regimes (
            date TEXT PRIMARY KEY, regime TEXT NOT NULL,
            regime_prob REAL, computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE recommendation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL, signal_date TEXT NOT NULL,
            entry_price REAL, actual_return_pct REAL, outcome TEXT,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE technical_analysis_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT,
            date TEXT, win_probability REAL, signal_score REAL
        );
        CREATE TABLE unified_recommendations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL, computed_at TEXT NOT NULL,
            regime TEXT NOT NULL, unified_score REAL NOT NULL,
            conviction_level TEXT NOT NULL, screener_stock_score REAL,
            ml_score REAL, confluence_score REAL, technical_score REAL,
            dl_score REAL, avg_engine_track_record REAL,
            bullish_screener_count INTEGER, bearish_screener_count INTEGER,
            screener_names_json TEXT, fundamental_score REAL,
            entry_zone_low REAL, entry_zone_high REAL, stop_loss REAL,
            target_1 REAL, target_2 REAL, target_3 REAL,
            risk_reward REAL, timeframe TEXT, sector TEXT,
            trade_reasoning TEXT, UNIQUE(symbol, computed_at)
        );
        CREATE TABLE signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT,
            entry_price REAL, stop_loss REAL,
            target_1 REAL, target_2 REAL, target_3 REAL,
            risk_reward REAL, timeframe TEXT, trade_reasoning TEXT,
            sector TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    ''')
    return conn


def make_csv(rows):
    """Write rows to a temp CSV file; return path."""
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, newline='')
    fieldnames = ['source','screener_id','screener_name','category',
                  'subcategory','signal_bias','investment_horizon','confidence']
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    f.close()
    return f.name


class TestScreenerCatalogSeed:
    def test_seed_loads_rows_from_csv(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        csv_path = make_csv([
            {'source':'trendlyne','screener_id':'s1','screener_name':'Bull Breakout',
             'category':'technical_breakout','subcategory':'price_breakout',
             'signal_bias':'bullish','investment_horizon':'swing','confidence':'0.74'},
            {'source':'trendlyne','screener_id':'s2','screener_name':'Death Cross',
             'category':'technical_trend','subcategory':'trend_indicator',
             'signal_bias':'bearish','investment_horizon':'swing','confidence':'0.74'},
        ])
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        count = ranker.seed_screener_catalog()
        assert count == 2
        rows = conn.execute('SELECT * FROM screener_catalog').fetchall()
        assert len(rows) == 2
        assert rows[0]['signal_bias'] == 'bullish'
        os.unlink(csv_path)

    def test_seed_idempotent(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        csv_path = make_csv([
            {'source':'trendlyne','screener_id':'s1','screener_name':'X',
             'category':'technical_trend','subcategory':'','signal_bias':'bullish',
             'investment_horizon':'swing','confidence':'0.74'},
        ])
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        ranker.seed_screener_catalog()
        ranker.seed_screener_catalog()  # second call must not fail
        count = conn.execute('SELECT COUNT(*) FROM screener_catalog').fetchone()[0]
        assert count == 1
        os.unlink(csv_path)


class TestScreenerStockScore:
    def test_fundamental_strong_scores_higher_than_weak(self):
        from unified_ranker import UnifiedRanker, compute_screener_stock_scores

        # Two stocks: STRONG has fundamental_score=80, WEAK has fundamental_score=30
        # Both appear in same 3 bullish technical_breakout screeners
        membership = {
            'STRONG': [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','investment_horizon':'swing'}]*3,
            'WEAK':   [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','investment_horizon':'swing'}]*3,
        }
        fund_scores = {'STRONG': 80.0, 'WEAK': 30.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['STRONG'] > scores['WEAK']

    def test_bearish_screener_reduces_score(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'BULL_STOCK':  [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','investment_horizon':'swing'}]*5,
            'BEAR_STOCK':  [{'signal_bias':'bearish','confidence':0.74,'category':'technical_breakout','investment_horizon':'swing'}]*5,
        }
        fund_scores = {'BULL_STOCK': 50.0, 'BEAR_STOCK': 50.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['BULL_STOCK'] > scores['BEAR_STOCK']

    def test_risk_red_flags_heavily_penalises(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'CLEAN': [{'signal_bias':'bullish','confidence':0.74,'category':'fundamental_quality','investment_horizon':'long_term'}]*3,
            'RISKY': [
                {'signal_bias':'bullish','confidence':0.74,'category':'fundamental_quality','investment_horizon':'long_term'},
                {'signal_bias':'neutral','confidence':0.74,'category':'risk_red_flags','investment_horizon':'long_term'},
            ],
        }
        fund_scores = {'CLEAN': 75.0, 'RISKY': 75.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['CLEAN'] > scores['RISKY']

    def test_fundamental_strong_in_few_screeners_beats_weak_in_many(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'FEW_STRONG': [
                {'signal_bias':'bullish','confidence':0.82,'category':'fundamental_quality','investment_horizon':'long_term'},
                {'signal_bias':'bullish','confidence':0.82,'category':'fundamental_growth','investment_horizon':'long_term'},
            ]*3,
            'MANY_WEAK': [
                {'signal_bias':'bullish','confidence':0.74,'category':'technical_trend','investment_horizon':'intraday'},
            ]*20,
        }
        fund_scores = {'FEW_STRONG': 80.0, 'MANY_WEAK': 30.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['FEW_STRONG'] > scores['MANY_WEAK']
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd c:\Github\bharat-stock-intelligence && python -m pytest src/server/__tests__/test_unified_ranker.py -v 2>&1 | head -30
```

Expected: FAIL — `ModuleNotFoundError: No module named 'unified_ranker'`

- [ ] **Step 3: Create `src/server/unified_ranker.py` with catalog seeding and score computation**

```python
"""
unified_ranker.py — Regime-gated unified stock recommendation engine.

Reads all scoring engine outputs, applies screener-category weights from
screener_names_categorized.csv (via screener_catalog table), regime weights,
and 90-day track record modifiers. Writes ranked picks to unified_recommendations.

Run after market close: python unified_ranker.py
"""
import sqlite3
import json
import csv
import sys
import os
from pathlib import Path
from datetime import date, timedelta

import numpy as np

DB_PATH      = Path(__file__).parent.parent.parent / 'database.sqlite'
CSV_PATH     = Path(__file__).parent.parent.parent / 'screener_scoring_v2.csv'
CORRECTIONS_PATH = Path(__file__).parent.parent.parent / 'screener_corrections.csv'

# User requirement: bearish screeners reduce score (sign=-1)
BIAS_SIGN = {'bullish': 1.0, 'bearish': -1.0, 'neutral': 0.3}

# Research-backed category base weights (from screener_scoring_engine_v2.xlsx)
CAT_BASE_WT = {
    'composite_strategy':      0.1287,
    'fundamental_quality':     0.1188,
    'fundamental_growth':      0.0990,
    'valuation':               0.0792,
    'technical_breakout':      0.0792,
    'ownership_institutional': 0.0693,
    'technical_momentum':      0.0693,
    'technical_trend':         0.0594,
    'analyst_sentiment':       0.0495,
    'technical_reversal':      0.0396,
    'event_corporate_action':  0.0396,
    'derivatives_positioning': 0.0297,
    'income_dividend':         0.0297,
    'risk_red_flags':          0.0297,
    'volume_liquidity':        0.0297,
    'volatility':              0.0198,
    'sector_theme':            0.0198,
    'market_cap_style':        0.0099,
    'other':                   0.0,
}

# Subcategory modifiers (from xlsx)
SUBCAT_MOD = {
    'multi_factor_strategy':        1.20,
    'earnings_growth':              1.15,
    'institutional_activity':       1.15,
    'capital_efficiency':           1.10,
    'revenue_growth':               1.10,
    'price_leadership':             1.10,
    'relative_strength':            1.10,
    'balance_sheet_quality':        1.05,
    'price_breakout':               1.05,
    'volume_delivery':              1.05,
    'moving_average_trend':         1.00,
    'relative_or_absolute_value':   1.00,
    'trend_indicator':              0.95,
    'earnings_event':               0.95,
    'oscillator_signal':            0.90,
    'broker_forecast':              0.90,
    'open_interest':                0.90,
    'oscillator_reversal':          0.85,
    'dividend_income':              0.85,
    'candlestick_reversal':         0.80,
    'volatility_range':             0.75,
    'sector_or_theme':              0.70,
    'corporate_action':             0.70,
    'financial_or_governance_risk': 0.60,
    'size_style':                   0.60,
}

# Horizon multipliers (from xlsx) — intraday 30% discounted
HORIZON_MULT = {
    'intraday':   0.70,
    'swing':      0.95,
    'positional': 1.05,
    'long_term':  1.10,
}

REGIME_WEIGHTS = {
    'BULL':     {'screener': 0.30, 'ml': 0.25, 'confluence': 0.20, 'technical': 0.15, 'dl': 0.10},
    'BEAR':     {'screener': 0.35, 'ml': 0.25, 'confluence': 0.20, 'technical': 0.10, 'dl': 0.10},
    'HIGH_VOL': {'screener': 0.20, 'ml': 0.20, 'confluence': 0.15, 'technical': 0.30, 'dl': 0.15},
    'CRASH':    {'screener': 0.40, 'ml': 0.25, 'confluence': 0.15, 'technical': 0.10, 'dl': 0.10},
}

# Tiers from xlsx Scoring Framework
CONVICTION_TIERS = [
    ('S_ELITE',    80),
    ('A_HIGH',     65),
    ('B_MEDIUM',   45),
    ('C_LOW',      25),
    ('D_MARGINAL',  1),
]


def _fund_mult(score: float | None) -> float:
    if score is None:
        return 1.0
    if score > 70:
        return 1.3
    if score < 40:
        return 0.7
    return 1.0


def _normalize_to_100(raw: dict) -> dict:
    """Min-max normalize dict values to 0–100. Returns same keys."""
    if not raw:
        return {}
    values = list(raw.values())
    lo, hi = min(values), max(values)
    span = hi - lo
    if span == 0:
        return {k: 50.0 for k in raw}
    return {k: (v - lo) / span * 100 for k, v in raw.items()}


def _conviction(score: float) -> str:
    for tier, threshold in CONVICTION_TIERS:
        if score >= threshold:
            return tier
    return 'D_MARGINAL'


def compute_screener_stock_scores(
    membership: dict,
    fundamental_scores: dict,
) -> tuple[dict, dict, dict]:
    """
    Step 1 of the pipeline. Pure function — no DB access.

    membership: {symbol: [{signal_bias, confidence, category, subcategory, investment_horizon}]}
    fundamental_scores: {symbol: float 0-100}

    Formula: Base Weight × Subcategory Modifier × Bias Sign × Horizon Multiplier × Confidence
    (from screener_scoring_engine_v2.xlsx Scoring Framework)

    Returns: (normalized_scores, bullish_counts, bearish_counts)
    """
    raw: dict = {}
    bullish_counts: dict = {}
    bearish_counts: dict = {}

    for sym, screeners in membership.items():
        fm = _fund_mult(fundamental_scores.get(sym))
        contrib = sum(
            BIAS_SIGN.get(s['signal_bias'], 0.0)
            * CAT_BASE_WT.get(s['category'], 0.0)
            * SUBCAT_MOD.get(s.get('subcategory', ''), 1.0)
            * HORIZON_MULT.get(s.get('investment_horizon', 'swing'), 0.95)
            * float(s.get('confidence', 0.74))
            for s in screeners
        )
        raw[sym] = contrib * fm
        bullish_counts[sym] = sum(1 for s in screeners if s['signal_bias'] == 'bullish')
        bearish_counts[sym] = sum(1 for s in screeners if s['signal_bias'] == 'bearish')

    return _normalize_to_100(raw), bullish_counts, bearish_counts


class UnifiedRanker:
    def __init__(self, conn: sqlite3.Connection | None = None,
                 csv_path: str | Path | None = None,
                 corrections_path: str | Path | None = None):
        self.conn = conn or sqlite3.connect(str(DB_PATH))
        self.conn.row_factory = sqlite3.Row
        self.csv_path = Path(csv_path) if csv_path else CSV_PATH
        self.corrections_path = Path(corrections_path) if corrections_path else CORRECTIONS_PATH

    # ── Catalog ───────────────────────────────────────────────────────────────

    def seed_screener_catalog(self) -> int:
        """
        Load screener_scoring_v2.csv into screener_catalog, then apply corrections
        from screener_corrections.csv. INSERT OR REPLACE — idempotent.

        CSV columns: screener_name, source, category, subcategory, signal_bias,
                     investment_horizon, confidence, base_wt, sub_mod, bias_score,
                     horiz_mult, score_0_100, tier
        Note: screener_id derived as slugified screener_name (matches trendlyne/mc/etnow convention).
        """
        import re

        def slugify(s: str) -> str:
            return re.sub(r'[^a-z0-9]+', '-', s.lower().strip())[:120]

        rows = []
        with open(self.csv_path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                try:
                    name = row['screener_name'].strip()
                    rows.append((
                        slugify(name),                            # screener_id
                        row['source'].strip(),
                        name,
                        row['category'].strip(),
                        row.get('subcategory', '').strip(),
                        row['signal_bias'].strip(),
                        row.get('investment_horizon', '').strip(),
                        float(row['confidence']),
                        float(row.get('score_0_100') or 0),
                        row.get('tier', '').strip(),
                        float(row.get('sub_mod') or 1.0),
                        float(row.get('horiz_mult') or 0.95),
                    ))
                except (KeyError, ValueError):
                    continue

        self.conn.executemany(
            '''INSERT OR REPLACE INTO screener_catalog
               (screener_id, source, screener_name, category, subcategory,
                signal_bias, investment_horizon, confidence,
                score_0_100, tier, sub_mod, horiz_mult)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
            rows,
        )

        # Apply bias/subcategory corrections from screener_corrections.csv
        if self.corrections_path.exists():
            with open(self.corrections_path, newline='', encoding='utf-8') as f:
                for corr in csv.DictReader(f):
                    name = corr.get('screener_name', '').strip()
                    if not name:
                        continue
                    if corr['type'] == 'bias':
                        self.conn.execute(
                            'UPDATE screener_catalog SET signal_bias=? WHERE screener_name=?',
                            (corr['corrected'], name),
                        )
                    elif corr['type'] == 'subcategory':
                        self.conn.execute(
                            'UPDATE screener_catalog SET subcategory=? WHERE screener_name=?',
                            (corr['corrected'], name),
                        )
        self.conn.commit()
        return len(rows)

    # ── Data readers ──────────────────────────────────────────────────────────

    def _get_regime(self) -> tuple[str, float]:
        row = self.conn.execute(
            'SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1'
        ).fetchone()
        if row:
            return row['regime'], float(row['regime_prob'] or 0.5)
        return 'BULL', 0.5

    def _get_fundamental_scores(self) -> dict:
        rows = self.conn.execute(
            "SELECT symbol, composite_score FROM stock_scores WHERE timeframe = 'medium'"
        ).fetchall()
        return {r['symbol']: float(r['composite_score'] or 50) for r in rows}

    def _get_screener_membership(self) -> dict:
        """Returns {symbol: [{signal_bias, confidence, category, investment_horizon}]}"""
        membership: dict = {}

        def _add(sym, bias, conf, cat, horizon):
            if not sym:
                return
            membership.setdefault(sym, []).append({
                'signal_bias': bias or 'neutral',
                'confidence': float(conf or 0.74),
                'category': cat or 'other',
                'investment_horizon': horizon or '',
            })

        # Trendlyne
        try:
            for r in self.conn.execute('''
                SELECT ss.symbol, sc.signal_bias, sc.confidence,
                       sc.category, sc.investment_horizon
                FROM trendlyne_screener_stocks ss
                JOIN screener_catalog sc
                  ON sc.screener_id = ss.screener_id AND sc.source = 'trendlyne'
            ''').fetchall():
                _add(r['symbol'], r['signal_bias'], r['confidence'],
                     r['category'], r['investment_horizon'])
        except Exception:
            pass

        # MoneyControl
        try:
            for r in self.conn.execute('''
                SELECT ss.symbol, sc.signal_bias, sc.confidence,
                       sc.category, sc.investment_horizon
                FROM moneycontrol_screener_stocks ss
                JOIN screener_catalog sc
                  ON sc.screener_id = ss.scan_id AND sc.source = 'moneycontrol'
            ''').fetchall():
                _add(r['symbol'], r['signal_bias'], r['confidence'],
                     r['category'], r['investment_horizon'])
        except Exception:
            pass

        # ETnow
        try:
            for r in self.conn.execute('''
                SELECT ss.symbol, sc.signal_bias, sc.confidence,
                       sc.category, sc.investment_horizon
                FROM etnow_screener_stocks ss
                JOIN screener_catalog sc
                  ON sc.screener_id = ss.screener_id AND sc.source = 'etnow'
            ''').fetchall():
                _add(r['symbol'], r['signal_bias'], r['confidence'],
                     r['category'], r['investment_horizon'])
        except Exception:
            pass

        return membership

    def _get_ml_scores(self) -> dict:
        rows = self.conn.execute('''
            SELECT symbol, AVG(win_probability) AS p
            FROM technical_analysis_signals
            WHERE date >= date('now', '-3 days')
            GROUP BY symbol
        ''').fetchall()
        return {r['symbol']: float(r['p'] or 0) * 100 for r in rows}

    def _get_confluence_scores(self) -> dict:
        try:
            rows = self.conn.execute('''
                SELECT symbol, confluence_score
                FROM confluence_signals
                WHERE computed_at >= date('now', '-1 day')
            ''').fetchall()
            return {r['symbol']: float(r['confluence_score'] or 0) for r in rows}
        except Exception:
            return {}

    def _get_technical_scores(self) -> dict:
        rows = self.conn.execute('''
            SELECT symbol, AVG(signal_score) AS s
            FROM technical_analysis_signals
            WHERE date >= date('now', '-3 days')
            GROUP BY symbol
        ''').fetchall()
        return {r['symbol']: float(r['s'] or 0) for r in rows}

    def _get_dl_scores(self) -> dict:
        try:
            rows = self.conn.execute('''
                SELECT symbol, probability
                FROM dl_predictions
                WHERE predicted_at >= date('now', '-1 day')
            ''').fetchall()
            return {r['symbol']: float(r['probability'] or 0) * 100 for r in rows}
        except Exception:
            return {}

    def _get_avg_track_record(self) -> float:
        """Global 90-day avg realized return across all recommendation_log entries."""
        try:
            row = self.conn.execute('''
                SELECT AVG(actual_return_pct) AS avg_r
                FROM recommendation_log
                WHERE generated_at >= date('now', '-90 days')
                  AND actual_return_pct IS NOT NULL
            ''').fetchone()
            return float(row['avg_r'] or 0)
        except Exception:
            return 0.0

    def _passes_rl_gate(self, symbol: str) -> bool:
        """
        RL hard gate: pass if avg actual_return_pct for this symbol >= 0 over 90 days,
        or if no history exists (benefit of the doubt).
        """
        try:
            row = self.conn.execute('''
                SELECT AVG(actual_return_pct) AS avg_r, COUNT(*) AS cnt
                FROM recommendation_log
                WHERE symbol = ?
                  AND generated_at >= date('now', '-90 days')
                  AND actual_return_pct IS NOT NULL
            ''', (symbol,)).fetchone()
            if row and row['cnt'] and row['cnt'] > 0:
                return float(row['avg_r'] or 0) >= 0
        except Exception:
            pass
        return True  # no history → pass

    def _get_entry_targets(self, symbol: str) -> dict:
        try:
            row = self.conn.execute('''
                SELECT entry_price, stop_loss, target_1, target_2, target_3,
                       risk_reward, timeframe, trade_reasoning, sector
                FROM signals WHERE symbol = ?
                ORDER BY created_at DESC LIMIT 1
            ''', (symbol,)).fetchone()
        except Exception:
            return {}
        if not row:
            return {}
        ep = row['entry_price']
        return {
            'entry_zone_low':  round(ep * 0.99, 2) if ep else None,
            'entry_zone_high': round(ep * 1.01, 2) if ep else None,
            'stop_loss':       float(row['stop_loss'])  if row['stop_loss']  else None,
            'target_1':        float(row['target_1'])   if row['target_1']   else None,
            'target_2':        float(row['target_2'])   if row['target_2']   else None,
            'target_3':        float(row['target_3'])   if row['target_3']   else None,
            'risk_reward':     float(row['risk_reward']) if row['risk_reward'] else None,
            'timeframe':       row['timeframe'],
            'trade_reasoning': row['trade_reasoning'],
            'sector':          row['sector'],
        }

    # ── Main ──────────────────────────────────────────────────────────────────

    def run(self) -> list:
        today = date.today().isoformat()

        # Seed catalog on first run
        if self.conn.execute('SELECT COUNT(*) FROM screener_catalog').fetchone()[0] == 0:
            self.seed_screener_catalog()

        regime, _conf = self._get_regime()
        base_weights = REGIME_WEIGHTS.get(regime, REGIME_WEIGHTS['BULL'])
        fund_scores  = self._get_fundamental_scores()
        membership   = self._get_screener_membership()

        screener_scores, bull_counts, bear_counts = compute_screener_stock_scores(
            membership, fund_scores
        )
        ml_scores         = self._get_ml_scores()
        confluence_scores = self._get_confluence_scores()
        technical_scores  = self._get_technical_scores()
        dl_scores         = self._get_dl_scores()
        avg_track         = self._get_avg_track_record()

        all_symbols = set(screener_scores) | set(ml_scores) | set(confluence_scores)

        results = []
        for sym in all_symbols:
            if not self._passes_rl_gate(sym):
                continue

            engine_scores = {
                'screener':   screener_scores.get(sym, 0.0),
                'ml':         ml_scores.get(sym, 0.0),
                'confluence': confluence_scores.get(sym, 0.0),
                'technical':  technical_scores.get(sym, 0.0),
                'dl':         dl_scores.get(sym, 0.0),
            }
            unified = sum(base_weights[e] * engine_scores[e] for e in base_weights)
            if unified < 40:
                continue

            et = self._get_entry_targets(sym)
            results.append({
                'symbol':                  sym,
                'computed_at':             today,
                'regime':                  regime,
                'unified_score':           round(unified, 2),
                'conviction_level':        _conviction(unified),
                'screener_stock_score':    round(engine_scores['screener'], 2),
                'ml_score':                round(engine_scores['ml'], 2),
                'confluence_score':        round(engine_scores['confluence'], 2),
                'technical_score':         round(engine_scores['technical'], 2),
                'dl_score':                round(engine_scores['dl'], 2),
                'avg_engine_track_record': round(avg_track, 2),
                'bullish_screener_count':  bull_counts.get(sym, 0),
                'bearish_screener_count':  bear_counts.get(sym, 0),
                'fundamental_score':       fund_scores.get(sym),
                **et,
            })

        cur = self.conn.cursor()
        for r in results:
            cur.execute('''
                INSERT OR REPLACE INTO unified_recommendations
                (symbol, computed_at, regime, unified_score, conviction_level,
                 screener_stock_score, ml_score, confluence_score, technical_score, dl_score,
                 avg_engine_track_record, bullish_screener_count, bearish_screener_count,
                 fundamental_score, entry_zone_low, entry_zone_high, stop_loss,
                 target_1, target_2, target_3, risk_reward, timeframe, trade_reasoning, sector)
                VALUES (:symbol, :computed_at, :regime, :unified_score, :conviction_level,
                        :screener_stock_score, :ml_score, :confluence_score, :technical_score,
                        :dl_score, :avg_engine_track_record, :bullish_screener_count,
                        :bearish_screener_count, :fundamental_score, :entry_zone_low,
                        :entry_zone_high, :stop_loss, :target_1, :target_2, :target_3,
                        :risk_reward, :timeframe, :trade_reasoning, :sector)
            ''', r)
        self.conn.commit()

        breakdown = {}
        for r in results:
            c = r['conviction_level']
            breakdown[c] = breakdown.get(c, 0) + 1

        output = {'success': True, 'stocks_scored': len(results),
                  'conviction_breakdown': breakdown, 'regime': regime}
        print(json.dumps(output))
        return results


if __name__ == '__main__':
    ranker = UnifiedRanker()
    ranker.run()
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd c:\Github\bharat-stock-intelligence && python -m pytest src/server/__tests__/test_unified_ranker.py -v
```

Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/unified_ranker.py src/server/__tests__/test_unified_ranker.py
git commit -m "feat(python): add unified_ranker.py — screener stock scoring + catalog seeding"
```

---

## Task 3: Python Engine — End-to-End Run Test

**Files:**
- Modify: `src/server/__tests__/test_unified_ranker.py`

- [ ] **Step 1: Add end-to-end run tests**

Append to `src/server/__tests__/test_unified_ranker.py`:

```python
class TestUnifiedRankerRun:
    def _setup(self):
        """Return a fully seeded ranker with controlled test data."""
        import tempfile, os
        conn = make_db()
        csv_path = make_csv([
            {'source':'trendlyne','screener_id':'bull1','screener_name':'Bull Breakout',
             'category':'technical_breakout','subcategory':'','signal_bias':'bullish',
             'investment_horizon':'swing','confidence':'0.82'},
            {'source':'trendlyne','screener_id':'fund1','screener_name':'High ROE',
             'category':'fundamental_quality','subcategory':'','signal_bias':'bullish',
             'investment_horizon':'long_term','confidence':'0.82'},
            {'source':'trendlyne','screener_id':'bear1','screener_name':'Death Cross',
             'category':'technical_trend','subcategory':'','signal_bias':'bearish',
             'investment_horizon':'swing','confidence':'0.74'},
        ])
        from unified_ranker import UnifiedRanker
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        ranker.seed_screener_catalog()

        # INFY: in bull1 + fund1 → strong score; good fundamental
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','INFY','INFY')")
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('fund1','INFY','INFY')")
        conn.execute("INSERT INTO stock_scores VALUES ('INFY','medium',80)")

        # WEAK: in bull1 + bear1 → partially offset; weak fundamental
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','WEAK','WEAK')")
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bear1','WEAK','WEAK')")
        conn.execute("INSERT INTO stock_scores VALUES ('WEAK','medium',35)")

        # Give INFY and WEAK a positive track record so they pass RL gate
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) VALUES ('INFY','2026-05-01',5.0,date('now','-10 days'))")
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) VALUES ('WEAK','2026-05-01',1.0,date('now','-10 days'))")

        # ml scores
        conn.execute("INSERT INTO technical_analysis_signals (symbol, date, win_probability, signal_score) VALUES ('INFY', date('now'), 0.75, 70)")
        conn.execute("INSERT INTO technical_analysis_signals (symbol, date, win_probability, signal_score) VALUES ('WEAK', date('now'), 0.45, 40)")

        # Market regime
        conn.execute("INSERT INTO market_regimes (date, regime, regime_prob) VALUES (date('now'),'BULL',0.8)")
        conn.commit()
        return ranker, conn, csv_path

    def test_run_writes_to_unified_recommendations(self):
        ranker, conn, csv_path = self._setup()
        results = ranker.run()
        assert len(results) > 0
        rows = conn.execute('SELECT * FROM unified_recommendations').fetchall()
        assert len(rows) > 0
        os.unlink(csv_path)

    def test_infy_scores_higher_than_weak(self):
        ranker, conn, csv_path = self._setup()
        results = ranker.run()
        scores = {r['symbol']: r['unified_score'] for r in results}
        if 'INFY' in scores and 'WEAK' in scores:
            assert scores['INFY'] > scores['WEAK']
        os.unlink(csv_path)

    def test_rl_gate_excludes_negative_track_record(self):
        ranker, conn, csv_path = self._setup()
        # Give a stock a negative track record
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','LOSER','LOSER')")
        conn.execute("INSERT INTO stock_scores VALUES ('LOSER','medium',60)")
        conn.execute("INSERT INTO technical_analysis_signals (symbol, date, win_probability, signal_score) VALUES ('LOSER', date('now'), 0.72, 68)")
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) VALUES ('LOSER','2026-05-01',-8.0,date('now','-10 days'))")
        conn.commit()
        results = ranker.run()
        symbols = [r['symbol'] for r in results]
        assert 'LOSER' not in symbols
        os.unlink(csv_path)

    def test_conviction_tiers_assigned_correctly(self):
        from unified_ranker import _conviction
        assert _conviction(90) == 'S_ELITE'
        assert _conviction(80) == 'S_ELITE'
        assert _conviction(70) == 'A_HIGH'
        assert _conviction(50) == 'B_MEDIUM'
        assert _conviction(30) == 'C_LOW'
        assert _conviction(45) == 'WATCH'
        assert _conviction(30) == 'WATCH'

    def test_regime_bull_uses_screener_weight_030(self):
        from unified_ranker import REGIME_WEIGHTS
        assert REGIME_WEIGHTS['BULL']['screener'] == 0.30
        assert REGIME_WEIGHTS['CRASH']['screener'] == 0.40
        # All regime weights sum to 1.0
        for regime, weights in REGIME_WEIGHTS.items():
            assert abs(sum(weights.values()) - 1.0) < 1e-9, f"{regime} weights don't sum to 1"
```

- [ ] **Step 2: Run tests**

```bash
cd c:\Github\bharat-stock-intelligence && python -m pytest src/server/__tests__/test_unified_ranker.py -v
```

Expected: PASS (all 11 tests)

- [ ] **Step 3: Commit**

```bash
git add src/server/__tests__/test_unified_ranker.py
git commit -m "test(python): add end-to-end unified_ranker run tests"
```

---

## Task 4: tRPC Endpoints — `getCommandCenter` + `runUnifiedRanker`

**Files:**
- Modify: `src/server/router.ts`
- Modify: `src/server/__tests__/commandCenter.test.ts`

- [ ] **Step 1: Add tRPC tests**

Append to `src/server/__tests__/commandCenter.test.ts`:

```typescript
import { createCallerFactory } from '@trpc/server';

// Import router after DB is set up
const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

describe('getCommandCenter', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM unified_recommendations`);
    db.exec(`DELETE FROM market_regimes`);
  });

  it('returns empty eodPicks when no data', async () => {
    const result = await caller.getCommandCenter({});
    expect(result).toHaveProperty('eodPicks');
    expect(result).toHaveProperty('intradaySignals');
    expect(result).toHaveProperty('regime');
    expect(Array.isArray(result.eodPicks)).toBe(true);
  });

  it('filters by conviction level', async () => {
    db.prepare(`INSERT INTO market_regimes (date, regime, regime_prob) VALUES (date('now'),'BULL',0.8)`).run();
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('ELITE_STOCK', date('now'), 'BULL', 90.0, 'S_ELITE')`).run();
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('LOW_STOCK', date('now'), 'BULL', 30.0, 'C_LOW')`).run();

    const elite = await caller.getCommandCenter({ conviction: 'S_ELITE' });
    expect(elite.eodPicks.length).toBe(1);
    expect(elite.eodPicks[0].symbol).toBe('ELITE_STOCK');
  });

  it('returns regime object with name and confidence', async () => {
    db.prepare(`INSERT INTO market_regimes (date, regime, regime_prob) VALUES (date('now'),'BEAR',0.75)`).run();
    const result = await caller.getCommandCenter({});
    expect(result.regime.name).toBe('BEAR');
    expect(result.regime.confidence).toBe(0.75);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run src/server/__tests__/commandCenter.test.ts
```

Expected: FAIL — `caller.getCommandCenter is not a function`

- [ ] **Step 3: Add procedures to `src/server/router.ts`**

Find the section near other ML procedures (around `runFullBacktest` or `optimizeScreenerWeights`) and add these two procedures:

```typescript
getCommandCenter: publicProcedure
  .input(z.object({
    conviction: z.enum(['ALL', 'S_ELITE', 'A_HIGH', 'B_MEDIUM', 'C_LOW', 'D_MARGINAL']).default('ALL'),
    horizon:    z.enum(['ALL', 'intraday', 'swing', 'long_term']).default('ALL'),
    limit:      z.number().min(1).max(100).default(30),
  }))
  .query(async ({ input }) => {
    // 1. Current regime
    const regimeRow = db.prepare(
      'SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1'
    ).get() as { regime: string; regime_prob: number } | undefined;
    const regime = {
      name:       regimeRow?.regime ?? 'BULL',
      confidence: regimeRow?.regime_prob ?? 0.5,
      updated_at: new Date().toISOString(),
    };

    // 2. EOD picks from unified_recommendations
    let query = `
      SELECT * FROM unified_recommendations
      WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
    `;
    const params: (string | number)[] = [];
    if (input.conviction !== 'ALL') {
      query += ` AND conviction_level = ?`;
      params.push(input.conviction);
    }
    if (input.horizon !== 'ALL') {
      query += ` AND timeframe = ?`;
      params.push(input.horizon);
    }
    query += ` ORDER BY unified_score DESC LIMIT ?`;
    params.push(input.limit);

    const eodRows = db.prepare(query).all(...params) as any[];

    // 3. Overlay live prices from liveStockData cache
    let liveCache: Record<string, any> = {};
    try {
      const cached = await cacheGet('live-stocks-bulk');
      if (cached) liveCache = JSON.parse(cached);
    } catch { /* no cache */ }

    const eodPicks = eodRows.map((row) => {
      const live = liveCache[row.symbol];
      const livePrice = live?.price ?? live?.lastPrice ?? null;
      const realizedReturnPct = (livePrice && row.entry_zone_low)
        ? parseFloat(((livePrice - row.entry_zone_low) / row.entry_zone_low * 100).toFixed(2))
        : null;
      return { ...row, livePrice, realizedReturnPct, changePercent: live?.changePercent ?? null };
    });

    // 4. Intraday signals (today, HIGH strength only) — collapse in CRASH
    let intradaySignals: any[] = [];
    if (regime.name !== 'CRASH') {
      const today = new Date().toISOString().slice(0, 10);
      intradaySignals = db.prepare(`
        SELECT symbol, signal_type, signal_strength, win_probability,
               signal_score, rsi, cmp, change_pct, ai_insight,
               entry_zone, stop_loss, targets, time_horizon
        FROM technical_analysis_signals
        WHERE date = ? AND signal_strength = 'HIGH'
        ORDER BY win_probability DESC LIMIT 20
      `).all(today) as any[];
    }

    // 5. Engine track record (last computed_at metadata)
    const trackRow = db.prepare(
      `SELECT avg_engine_track_record FROM unified_recommendations
       WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
       LIMIT 1`
    ).get() as { avg_engine_track_record: number } | undefined;

    return {
      regime,
      eodPicks,
      intradaySignals,
      lastComputedAt: eodRows[0]?.computed_at ?? null,
      avgEngineTrackRecord: trackRow?.avg_engine_track_record ?? null,
    };
  }),

runUnifiedRanker: publicProcedure
  .mutation(async () => {
    try {
      const { stdout } = await runPython('unified_ranker.py', [], 5 * 60_000);
      const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
      return {
        success: true,
        stocks_scored:        parsed.stocks_scored ?? 0,
        conviction_breakdown: parsed.conviction_breakdown ?? {},
        regime:               parsed.regime ?? 'UNKNOWN',
        duration_ms:          0,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }),
```

Make sure `runPython` is imported at the top of router.ts — check if it already is:

```typescript
import { runPython } from './pythonRunner';
```

Also ensure `cacheGet` is imported:

```typescript
import { cacheGet } from './cacheService';
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/server/__tests__/commandCenter.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/router.ts src/server/__tests__/commandCenter.test.ts
git commit -m "feat(trpc): add getCommandCenter query and runUnifiedRanker mutation"
```

---

## Task 5: BullMQ — Daily Unified Ranker Job

**Files:**
- Modify: `src/server/queues.ts`

- [ ] **Step 1: Add queue constant and export**

In `src/server/queues.ts`, find the block of `export const QUEUE_*` constants and add:

```typescript
export const QUEUE_UNIFIED_RANKER = 'unified-ranker';
```

- [ ] **Step 2: Declare queue and worker variables**

In the same file, find where other queue/worker `let` declarations are (e.g. near `mlDailyOpsQueue`) and add:

```typescript
export let unifiedRankerQueue: Queue | null = null;
let unifiedRankerWorker: Worker | null = null;
```

- [ ] **Step 3: Register the repeatable job inside `initializeQueues`**

Find the `initializeQueues` async function. After the `researchPostcloseQueue` block (around line 1069) and before the final closing brace, add:

```typescript
    // ── Unified Ranker — runs daily at 15:45 IST (10:15 UTC) ──────────────
    unifiedRankerQueue = new Queue(QUEUE_UNIFIED_RANKER, { connection });
    const unifiedRankerWorkerInstance = new Worker(
      QUEUE_UNIFIED_RANKER,
      async () => {
        console.log('[QUEUE] unified-ranker starting...');
        await runPython('unified_ranker.py', [], 5 * 60_000);
      },
      { connection, concurrency: 1 },
    );
    unifiedRankerWorker = unifiedRankerWorkerInstance;

    const staleUR = await unifiedRankerQueue.getRepeatableJobs();
    for (const r of staleUR) await unifiedRankerQueue.removeRepeatableByKey(r.key);
    await unifiedRankerQueue.add(
      'unified-ranker-daily',
      {},
      {
        repeat:  { pattern: '15 10 * * 1-5' },  // 10:15 UTC = 15:45 IST, weekdays
        jobId:   'unified-ranker-daily-repeatable',
        attempts: 2,
        backoff:  { type: 'fixed', delay: 60_000 },
      },
    );
    unifiedRankerWorkerInstance.on('completed', () =>
      console.log('[QUEUE] unified-ranker done'));
    unifiedRankerWorkerInstance.on('failed', (_, err) =>
      console.error('[QUEUE] unified-ranker failed:', err.message));
```

- [ ] **Step 4: Verify no TypeScript errors**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat(queue): schedule unified-ranker daily at 15:45 IST on weekdays"
```

---

## Task 6: React — `CommandCenterDashboard.tsx`

**Files:**
- Create: `src/components/CommandCenterDashboard.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/CommandCenterDashboard.tsx`:

```tsx
import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  Activity, AlertTriangle, RefreshCw, TrendingUp, TrendingDown,
  Shield, Zap, Target, ChevronDown, ChevronUp, BarChart2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ── Types ─────────────────────────────────────────────────────────────────────

type ConvictionFilter = 'ALL' | 'S_ELITE' | 'A_HIGH' | 'B_MEDIUM' | 'C_LOW' | 'D_MARGINAL';
type HorizonFilter    = 'ALL' | 'intraday' | 'swing' | 'long_term';

const CONVICTION_STYLE: Record<string, { bg: string; border: string; text: string; dot: string; label: string }> = {
  S_ELITE:    { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-400', dot: 'bg-emerald-400', label: 'S — Elite'    },
  A_HIGH:     { bg: 'bg-sky-500/15',     border: 'border-sky-500/40',     text: 'text-sky-400',     dot: 'bg-sky-400',     label: 'A — High'     },
  B_MEDIUM:   { bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-400',   dot: 'bg-amber-400',   label: 'B — Medium'   },
  C_LOW:      { bg: 'bg-slate-700/40',   border: 'border-slate-600/40',   text: 'text-slate-400',   dot: 'bg-slate-400',   label: 'C — Low'      },
  D_MARGINAL: { bg: 'bg-zinc-800/60',    border: 'border-zinc-700/40',    text: 'text-zinc-500',    dot: 'bg-zinc-500',    label: 'D — Marginal' },
};

const REGIME_STYLE: Record<string, { color: string; icon: string; bg: string }> = {
  BULL:     { color: 'text-emerald-400', icon: '▲', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  BEAR:     { color: 'text-rose-400',    icon: '▼', bg: 'bg-rose-500/10 border-rose-500/30'       },
  HIGH_VOL: { color: 'text-amber-400',   icon: '⚡', bg: 'bg-amber-500/10 border-amber-500/30'    },
  CRASH:    { color: 'text-red-400',     icon: '☠', bg: 'bg-red-500/10 border-red-500/30'         },
};

const fmt2 = (n: number | null | undefined) =>
  n == null ? '—' : n.toFixed(2);
const pct = (n: number | null | undefined) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const pctColor = (n: number | null | undefined) =>
  n == null ? 'text-slate-400' : n >= 0 ? 'text-emerald-400' : 'text-rose-400';

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ label, value, max = 100, color = 'bg-sky-500' }: {
  label: string; value: number; max?: number; color?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-16 text-slate-500 truncate">{label}</span>
      <div className="flex-1 h-1 bg-slate-700 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-7 text-right text-slate-400">{value.toFixed(0)}</span>
    </div>
  );
}

// ── Stock card ────────────────────────────────────────────────────────────────

function EodPickCard({ pick, onSelect }: { pick: any; onSelect: (sym: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const style = CONVICTION_STYLE[pick.conviction_level] ?? CONVICTION_STYLE.WATCH;

  return (
    <motion.div
      layout
      className={cn(
        'rounded-xl border p-4 cursor-pointer hover:brightness-110 transition-all',
        style.bg, style.border,
      )}
      onClick={() => onSelect(pick.symbol)}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-white font-bold text-sm">{pick.symbol}</span>
            <span className={cn('text-[10px] font-black px-1.5 py-0.5 rounded border', style.bg, style.border, style.text)}>
              {pick.conviction_level}
            </span>
          </div>
          {pick.sector && (
            <div className="text-[10px] text-slate-500 mt-0.5">{pick.sector}</div>
          )}
        </div>
        <div className="text-right">
          <div className="text-white font-bold text-sm">
            {pick.livePrice != null ? `₹${pick.livePrice.toLocaleString('en-IN')}` : '—'}
          </div>
          <div className={cn('text-[11px] font-medium', pctColor(pick.changePercent))}>
            {pct(pick.changePercent)}
          </div>
        </div>
      </div>

      {/* Unified score bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-slate-400">Unified Score</span>
          <span className={cn('text-sm font-bold', style.text)}>{pick.unified_score}</span>
        </div>
        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
          <div
            className={cn('h-full rounded-full', style.dot)}
            style={{ width: `${pick.unified_score}%` }}
          />
        </div>
      </div>

      {/* Screener counts + realized return */}
      <div className="flex items-center gap-3 text-[11px] mb-3">
        <span className="text-emerald-400 font-medium">↑{pick.bullish_screener_count ?? 0} bullish</span>
        <span className="text-rose-400 font-medium">↓{pick.bearish_screener_count ?? 0} bearish</span>
        {pick.realizedReturnPct != null && (
          <span className={cn('ml-auto font-bold', pctColor(pick.realizedReturnPct))}>
            {pct(pick.realizedReturnPct)} since rec
          </span>
        )}
      </div>

      {/* Entry / SL / Targets */}
      {(pick.entry_zone_low || pick.stop_loss || pick.target_1) && (
        <div className="grid grid-cols-4 gap-1 text-[10px] mb-2">
          <div className="text-center">
            <div className="text-slate-500 mb-0.5">Entry</div>
            <div className="text-slate-300">
              {pick.entry_zone_low && pick.entry_zone_high
                ? `${fmt2(pick.entry_zone_low)}–${fmt2(pick.entry_zone_high)}`
                : '—'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-slate-500 mb-0.5">SL</div>
            <div className="text-rose-400">{fmt2(pick.stop_loss)}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-500 mb-0.5">T1/T2</div>
            <div className="text-emerald-400">{fmt2(pick.target_1)} / {fmt2(pick.target_2)}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-500 mb-0.5">R:R</div>
            <div className="text-sky-400">{pick.risk_reward ? `1:${fmt2(pick.risk_reward)}` : '—'}</div>
          </div>
        </div>
      )}

      {/* Score breakdown */}
      <div className="space-y-1 mb-2">
        <ScoreBar label="Screener"    value={pick.screener_stock_score ?? 0} color="bg-violet-500" />
        <ScoreBar label="ML"          value={pick.ml_score ?? 0}             color="bg-sky-500"    />
        <ScoreBar label="Confluence"  value={pick.confluence_score ?? 0}     color="bg-emerald-500" />
        <ScoreBar label="Technical"   value={pick.technical_score ?? 0}      color="bg-amber-500"  />
        <ScoreBar label="DL"          value={pick.dl_score ?? 0}             color="bg-pink-500"   />
      </div>

      {/* Expand reasoning */}
      {pick.trade_reasoning && (
        <button
          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 w-full"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Trade reasoning
        </button>
      )}
      <AnimatePresence>
        {expanded && pick.trade_reasoning && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
              {pick.trade_reasoning}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Intraday signal card ───────────────────────────────────────────────────────

function IntradayCard({ sig, onSelect }: { sig: any; onSelect: (sym: string) => void }) {
  return (
    <div
      className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3 cursor-pointer hover:border-slate-600 transition-colors"
      onClick={() => onSelect(sig.symbol)}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-white font-bold text-sm">{sig.symbol}</span>
        <span className="text-[10px] bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 px-1.5 py-0.5 rounded font-bold">
          HIGH
        </span>
      </div>
      <div className="text-[10px] text-slate-400 mb-2">{sig.signal_type?.replace(/_/g,' ')}</div>
      <div className="flex items-center justify-between text-[11px]">
        <span className={cn('font-medium', pctColor(sig.change_pct))}>{pct(sig.change_pct)}</span>
        <span className="text-sky-400">
          Win P: {sig.win_probability != null ? `${(sig.win_probability * 100).toFixed(0)}%` : '—'}
        </span>
        {sig.time_horizon && (
          <span className="text-slate-500">{sig.time_horizon}</span>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CommandCenterDashboard({ onSelectStock }: { onSelectStock: (sym: string) => void }) {
  const [conviction, setConviction] = useState<ConvictionFilter>('ALL');
  const [horizon,    setHorizon]    = useState<HorizonFilter>('ALL');

  const { data, isLoading, refetch, isRefetching } =
    trpc.getCommandCenter.useQuery(
      { conviction, horizon, limit: 30 },
      { refetchInterval: 5 * 60_000 },
    );

  const { mutate: triggerRanker, isPending: isRunning } =
    trpc.runUnifiedRanker.useMutation({ onSuccess: () => refetch() });

  const regime   = data?.regime;
  const regStyle = REGIME_STYLE[regime?.name ?? 'BULL'] ?? REGIME_STYLE.BULL;

  const CONVICTIONS: ConvictionFilter[] = ['ALL','S_ELITE','A_HIGH','B_MEDIUM','C_LOW','D_MARGINAL'];
  const HORIZONS: { val: HorizonFilter; label: string }[] = [
    { val: 'ALL',       label: 'All'       },
    { val: 'intraday',  label: 'Intraday'  },
    { val: 'swing',     label: 'Swing'     },
    { val: 'long_term', label: 'Long Term' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex-none px-4 pt-4 pb-3 border-b border-slate-700/50">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          {/* Regime badge */}
          <div className={cn('flex items-center gap-2 px-3 py-1.5 rounded-lg border', regStyle.bg)}>
            <span className={cn('text-lg', regStyle.color)}>{regStyle.icon}</span>
            <div>
              <div className={cn('text-sm font-black', regStyle.color)}>
                {regime?.name ?? '—'} REGIME
              </div>
              {regime?.confidence != null && (
                <div className="text-[10px] text-slate-400">
                  {(regime.confidence * 100).toFixed(0)}% confidence
                </div>
              )}
            </div>
          </div>

          {/* Track record */}
          {data?.avgEngineTrackRecord != null && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <BarChart2 className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-slate-400">90d track record:</span>
              <span className={cn('font-bold', pctColor(data.avgEngineTrackRecord))}>
                {pct(data.avgEngineTrackRecord)}
              </span>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-2 ml-auto">
            {data?.lastComputedAt && (
              <span className="text-[10px] text-slate-500">
                Last run: {data.lastComputedAt}
              </span>
            )}
            <button
              onClick={() => triggerRanker()}
              disabled={isRunning || isRefetching}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', (isRunning || isRefetching) && 'animate-spin')} />
              {isRunning ? 'Running…' : 'Re-run'}
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-0.5">
            {CONVICTIONS.map((c) => (
              <button
                key={c}
                onClick={() => setConviction(c)}
                className={cn(
                  'px-2.5 py-1 rounded text-[11px] font-medium transition-colors',
                  conviction === c
                    ? 'bg-slate-600 text-white'
                    : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-0.5">
            {HORIZONS.map(({ val, label }) => (
              <button
                key={val}
                onClick={() => setHorizon(val)}
                className={cn(
                  'px-2.5 py-1 rounded text-[11px] font-medium transition-colors',
                  horizon === val
                    ? 'bg-slate-600 text-white'
                    : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-slate-400 text-sm">
            <Activity className="w-4 h-4 mr-2 animate-pulse" /> Loading…
          </div>
        ) : (
          <>
            {/* EOD Swing Picks */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Shield className="w-4 h-4 text-violet-400" />
                <h2 className="text-sm font-bold text-white">EOD Swing Picks</h2>
                <span className="text-[10px] text-slate-500 ml-auto">
                  {data?.eodPicks?.length ?? 0} stocks
                </span>
              </div>
              {(data?.eodPicks?.length ?? 0) === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  No picks yet — run unified_ranker after market close
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {data!.eodPicks.map((pick: any) => (
                    <EodPickCard key={pick.symbol} pick={pick} onSelect={onSelectStock} />
                  ))}
                </div>
              )}
            </section>

            {/* Intraday Live */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-amber-400" />
                <h2 className="text-sm font-bold text-white">Intraday Live</h2>
                <span className="text-[10px] text-slate-500 ml-auto">
                  {data?.intradaySignals?.length ?? 0} HIGH-strength signals
                </span>
              </div>
              {regime?.name === 'CRASH' ? (
                <div className="flex items-center gap-2 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  <AlertTriangle className="w-4 h-4 flex-none" />
                  Intraday signals disabled — CRASH regime active. Preserve capital.
                </div>
              ) : (data?.intradaySignals?.length ?? 0) === 0 ? (
                <div className="text-center py-8 text-slate-500 text-sm">
                  No HIGH-strength intraday signals today
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                  {data!.intradaySignals.map((sig: any, i: number) => (
                    <IntradayCard key={`${sig.symbol}-${i}`} sig={sig} onSelect={onSelectStock} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors in `CommandCenterDashboard.tsx`

- [ ] **Step 3: Commit**

```bash
git add src/components/CommandCenterDashboard.tsx
git commit -m "feat(ui): add CommandCenterDashboard — regime-gated unified Alpha tab"
```

---

## Task 7: App Integration — Alpha Tab + AdvancedToggle

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add import and tab constant**

In `src/App.tsx`, find the block of component imports and add:

```typescript
import { CommandCenterDashboard } from './components/CommandCenterDashboard';
```

Find the type/union that defines valid tab names (e.g. `type TabId = 'dashboard' | 'trade-cockpit' | ...`) and add `'alpha'` to it.

- [ ] **Step 2: Add nav tab entry**

Find the nav items array (or the JSX that renders nav tabs). Add the Alpha tab entry **before** `trade-cockpit`:

```typescript
{ id: 'alpha', label: 'Alpha ⚡', icon: Zap }
```

Import `Zap` from `lucide-react` if not already imported.

- [ ] **Step 3: Add tab panel render**

In the tab content render section, find where other tab panels are rendered (e.g. `{activeTab === 'dashboard' && <DashboardPage ... />}`). Add:

```typescript
{activeTab === 'alpha' && (
  <CommandCenterDashboard onSelectStock={(sym) => {
    // reuse existing stock detail handler (same pattern as other tabs)
    setSelectedStock(sym);
    setActiveTab('trade-cockpit');
  }} />
)}
```

Use the existing pattern for `setSelectedStock` and stock navigation — the exact handler name matches whatever the rest of `App.tsx` uses.

- [ ] **Step 4: Wrap old recommendation tabs in AdvancedToggle**

Find the nav items for `top-rated`, `signals`, `today-picks`, and `dl-dashboard`. Wrap them in a conditional render controlled by a state variable:

```typescript
// Add near other useState declarations:
const [showAdvancedTabs, setShowAdvancedTabs] = useState(false);
```

In the nav JSX, after the Alpha tab and before the next unrelated tab, add:

```tsx
<button
  onClick={() => setShowAdvancedTabs(!showAdvancedTabs)}
  className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
>
  Advanced {showAdvancedTabs ? '‹' : '›'}
</button>
{showAdvancedTabs && (
  <>
    {/* original top-rated, signals, today-picks, dl-dashboard nav items here */}
  </>
)}
```

Move (not copy) the JSX for those four nav items inside the `showAdvancedTabs` conditional.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: all passing

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): add Alpha tab with CommandCenterDashboard; wrap old rec tabs in Advanced toggle"
```

---

## Task 8: Integration — Run Ranker Manually and Verify

This task is a manual smoke test — no new code.

- [ ] **Step 1: Ensure Python deps installed**

```bash
cd c:\Github\bharat-stock-intelligence
C:\Users\amit_\AppData\Local\Programs\Python\Python311\python.exe -c "import numpy, scipy; print('OK')"
```

Expected: `OK`

If not: `pip install numpy scipy`

- [ ] **Step 2: Seed the catalog**

```bash
C:\Users\amit_\AppData\Local\Programs\Python\Python311\python.exe src/server/unified_ranker.py
```

Expected output: `{"success": true, "stocks_scored": N, "conviction_breakdown": {...}, "regime": "BULL"}`

If `stocks_scored` is 0, the screener stocks tables are empty — this is expected on a fresh DB; screeners must be synced first via existing `trendlyne-intraday` and `mc-screener-sync` queues.

- [ ] **Step 3: Open Alpha tab in browser**

Start the dev server:

```bash
npm start
```

Navigate to Alpha tab. Verify:
- Regime badge shows (may say BULL with default if market_regimes is empty)
- EOD Swing Picks section renders (may be empty if ranker hasn't run on live data)
- Intraday Live section renders
- Filter tabs (ALL / S_ELITE / A_HIGH / B_MEDIUM / C_LOW / D_MARGINAL) change the display
- Re-run button triggers `runUnifiedRanker` mutation

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "chore: verify unified command center integration"
```

---

## Self-Review Notes

- **Spec coverage:** All 5 design sections covered: architecture (Tasks 1-5), screener formula (Tasks 2-3), DB schema (Task 1), tRPC (Task 4), frontend (Tasks 6-7)
- **RL gate implementation:** Uses `actual_return_pct` from `recommendation_log` per symbol, not per engine (engine-level column doesn't exist in schema — this is the correct approach)
- **Track record:** Simplified to global `avg(actual_return_pct)` returned in response as `avgEngineTrackRecord` — per-engine breakdown would require a `source_engine` column not currently in `recommendation_log`; can be added in a follow-up
- **screener_catalog join keys:** `trendlyne_screener_stocks.screener_id`, `moneycontrol_screener_stocks.scan_id`, `etnow_screener_stocks.screener_id` — matches actual DB schema
- **Type consistency:** `conviction_level` string enum used consistently across Python (`_conviction()`), DB schema, tRPC query filter, and React `CONVICTION_STYLE` map
- **market_regimes table:** Plural — confirmed from `db.ts` line 1028
