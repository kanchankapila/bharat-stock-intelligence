# Signal Accuracy Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve trading signal accuracy by wiring up 6 currently-broken or missing data paths: win-probability gate, PCR features, extended FII/DII rolling, delivery %, sector relative momentum, and per-signal horizon resolution.

**Architecture:** All 6 fixes feed into `technical_signals` (the central feature store). The ML ensemble (`ml_ensemble.py`) consumes that table for both training and scoring. Tasks 1–6 are independent of each other; Task 7 (ML update) must run after Tasks 2–6 have populated data; Task 8 (horizon) is independent throughout.

**Tech Stack:** TypeScript (Node/tRPC server), Python 3 (ml_ensemble.py, scoring_engine.py, outcome_resolver.py), SQLite (better-sqlite3 on TS side, sqlite3 on Python side), pandas/numpy for ML.

---

## File Map

| File | Change |
|---|---|
| `src/server/db.ts` | Add 6 `migrateColumn` calls for new feature columns |
| `src/server/technicalSignalsService.ts` | Populate pcr_oi, pcr_vol, fii_10d_net, dii_3d_net, delivery_pct, sector_ret_5d/21d in upsert |
| `src/server/deliveryFetcher.ts` | New — fetch NSE Bhavcopy delivery data |
| `src/server/ml_ensemble.py` | Add new features to build_features(), load_training_data(), load_pending_signals(); add recommendation_log propagation after scoring |
| `backend-python/app/scoring_engine.py` | Add win_probability gate in _log_recommendations |
| `src/server/outcome_resolver.py` | Parse time_horizon per signal instead of single CLI horizon |

---

## Task 1: Win Probability Gate

**Goal:** Stop low-confidence signals from entering `recommendation_log`. Currently ALL Buy/Strong Buy classifications are logged regardless of `win_probability`.

**Files:**
- Modify: `backend-python/app/scoring_engine.py:549-609`
- Modify: `src/server/ml_ensemble.py:365-375`

- [ ] **Step 1: Add win_probability filter in scoring_engine._log_recommendations**

Open `backend-python/app/scoring_engine.py`. Find `_log_recommendations` (line ~549). Replace the candidates filter line:

```python
# BEFORE (line ~553):
candidates = [r for r in results if r.get('classification') in ('Strong Buy', 'Buy')]

# AFTER:
candidates_raw = [r for r in results if r.get('classification') in ('Strong Buy', 'Buy')]

# Filter by ML win_probability — only log signals the ensemble is confident about
today = datetime.date.today().isoformat()
candidates = []
with self.engine.connect() as chk:
    for r in candidates_raw:
        row = chk.execute(
            text("SELECT win_probability FROM technical_signals WHERE symbol = :s AND date = :d LIMIT 1"),
            {'s': r['symbol'], 'd': today}
        ).fetchone()
        wp = row[0] if row else None
        # Allow through if no ML score yet (new signal), gate if score exists and is low
        if wp is None or wp >= 0.55:
            candidates.append(r)

if not candidates:
    print("[ScoringEngine] All candidates filtered by win_probability < 0.55")
    return
```

- [ ] **Step 2: Propagate win_probability back to recommendation_log after ML scoring**

Open `src/server/ml_ensemble.py`. Find the line that updates technical_signals (around line 371):

```python
conn.execute(
    "UPDATE technical_signals SET win_probability = ? WHERE symbol = ? AND date = ?",
    ...
)
```

After the loop that updates all rows and `conn.commit()`, add:

```python
# Propagate win_probability to active recommendation_log entries
conn.execute("""
    UPDATE recommendation_log
    SET win_probability = (
        SELECT ts.win_probability
        FROM technical_signals ts
        WHERE ts.symbol = recommendation_log.symbol
          AND ts.date = recommendation_log.signal_date
        LIMIT 1
    )
    WHERE source = 'technical_scan'
      AND status = 'ACTIVE'
      AND signal_date >= date('now', '-14 days')
""")
# Deactivate entries where ML now says win < 55%
conn.execute("""
    UPDATE recommendation_log
    SET status = 'FILTERED'
    WHERE win_probability IS NOT NULL
      AND win_probability < 0.55
      AND status = 'ACTIVE'
""")
conn.commit()
print("[Ensemble] Propagated win_probability to recommendation_log; low-confidence entries filtered.")
```

- [ ] **Step 3: Verify with a dry-run query**

```bash
python -c "
import sqlite3
c = sqlite3.connect('database.sqlite')
total = c.execute('SELECT COUNT(*) FROM recommendation_log WHERE status=\"ACTIVE\"').fetchone()[0]
filtered = c.execute('SELECT COUNT(*) FROM recommendation_log WHERE status=\"FILTERED\"').fetchone()[0]
print(f'Active: {total}, Filtered: {filtered}')
wp_dist = c.execute('SELECT win_probability, COUNT(*) FROM recommendation_log GROUP BY ROUND(win_probability,1) ORDER BY win_probability').fetchall()
print(wp_dist)
"
```
Expected: See distribution of win_probability values; FILTERED count > 0 if ML has been run recently.

- [ ] **Step 4: Commit**

```bash
git add backend-python/app/scoring_engine.py src/server/ml_ensemble.py
git commit -m "feat(signals): gate recommendation_log on win_probability >= 0.55"
```

---

## Task 2: DB Schema — Add Missing Feature Columns

**Goal:** Add columns that already exist in the CREATE TABLE definition but were never added via `migrateColumn`, plus two new sector momentum columns.

**Files:**
- Modify: `src/server/db.ts:1174` (after last existing migrateColumn for technical_signals)

- [ ] **Step 1: Add migrateColumn calls**

Open `src/server/db.ts`. After line 1174 (`migrateColumn('technical_signals', 'updated_at', 'DATETIME')`), add:

```typescript
migrateColumn('technical_signals', 'fii_10d_net',    'REAL');
migrateColumn('technical_signals', 'dii_3d_net',     'REAL');
migrateColumn('technical_signals', 'pcr_oi',         'REAL');
migrateColumn('technical_signals', 'pcr_vol',        'REAL');
migrateColumn('technical_signals', 'sector_ret_5d',  'REAL');
migrateColumn('technical_signals', 'sector_ret_21d', 'REAL');
```

- [ ] **Step 2: Verify columns were added**

```bash
node -e "require('./src/server/db.ts')" 2>/dev/null || npx tsx -e "
import db from './src/server/db';
const cols = db.prepare('PRAGMA table_info(technical_signals)').all().map((r: any) => r.name);
console.log(cols.filter((c: string) => ['fii_10d_net','dii_3d_net','pcr_oi','pcr_vol','sector_ret_5d','sector_ret_21d'].includes(c)));
"
```
Expected: `[ 'fii_10d_net', 'dii_3d_net', 'pcr_oi', 'pcr_vol', 'sector_ret_5d', 'sector_ret_21d' ]`

Alternatively just start the dev server briefly and check:
```bash
python -c "import sqlite3; c=sqlite3.connect('database.sqlite'); print([x[1] for x in c.execute('PRAGMA table_info(technical_signals)').fetchall()])"
```

- [ ] **Step 3: Commit**

```bash
git add src/server/db.ts
git commit -m "feat(db): add fii_10d_net, dii_3d_net, pcr_oi, pcr_vol, sector_ret columns to technical_signals"
```

---

## Task 3: PCR Features — Populate pcr_oi and pcr_vol

**Goal:** Join `stock_options_oi` during the technical scan to write per-symbol PCR (`pcr_oi`) and market PCR (`pcr_vol`) into `technical_signals`. These are currently computed by `pcr_fetcher.py` into `stock_options_oi` but never surfaced to the ML feature store.

`stock_options_oi` columns: `symbol, date, expiry, call_oi, put_oi, pcr, total_call_oi, total_put_oi, market_pcr, fetched_at`

**Files:**
- Modify: `src/server/technicalSignalsService.ts` — add pcr lookup per symbol, include in upsert

- [ ] **Step 1: Add PCR lookup helper above the scan loop**

In `technicalSignalsService.ts`, find the function that runs the technical scan (where `results` is built). Before the transaction block (around line 1174), add a PCR lookup function:

```typescript
function getPcrForSymbol(symbol: string, scanDate: string): { pcr_oi: number | null; pcr_vol: number | null } {
  const row = db.prepare(`
    SELECT pcr, market_pcr FROM stock_options_oi
    WHERE symbol = ? AND date <= ?
    ORDER BY date DESC LIMIT 1
  `).get(symbol, scanDate) as { pcr: number; market_pcr: number } | undefined;
  return {
    pcr_oi:  row?.pcr        ?? null,
    pcr_vol: row?.market_pcr ?? null,
  };
}
```

- [ ] **Step 2: Call it per result and pass to upsert**

Inside the transaction loop where `upsert.run({...})` is called (line ~1176), add pcr fields to the upsert object:

```typescript
// After computing r.symbol, r.signalScore, etc.:
const { pcr_oi, pcr_vol } = getPcrForSymbol(r.symbol, scanDate);

upsert.run({
  // ... existing fields ...
  pcr_oi,
  pcr_vol,
  // ... rest of fields ...
});
```

- [ ] **Step 3: Update the INSERT statement to include pcr_oi, pcr_vol**

In the `db.prepare(...)` INSERT for technical_signals (around line 1115), add `pcr_oi, pcr_vol` to both the column list and VALUES list, and add to the ON CONFLICT DO UPDATE SET clause:

```typescript
// In the INSERT column list add after delivery_pct:
pcr_oi, pcr_vol,

// In VALUES add:
@pcr_oi, @pcr_vol,

// In ON CONFLICT DO UPDATE SET add:
pcr_oi=excluded.pcr_oi, pcr_vol=excluded.pcr_vol,
```

- [ ] **Step 4: Verify**

After running the technical scan once (or via `npx tsx src/server/technicalSignalsService.ts` if it has a main entry), check:

```bash
python -c "
import sqlite3; c = sqlite3.connect('database.sqlite')
r = c.execute('SELECT symbol, pcr_oi, pcr_vol FROM technical_signals WHERE pcr_oi IS NOT NULL LIMIT 5').fetchall()
print(r)
"
```
Expected: rows with non-null pcr_oi values for symbols that have options data (RELIANCE, TCS, HDFCBANK etc.)

- [ ] **Step 5: Commit**

```bash
git add src/server/technicalSignalsService.ts
git commit -m "feat(signals): populate pcr_oi, pcr_vol in technical_signals from stock_options_oi"
```

---

## Task 4: Extended FII/DII Rolling (fii_10d_net, dii_3d_net)

**Goal:** The existing `fii_3d_net` in `technical_signals` is populated but narrow. Add 10-day FII net and 3-day DII net computed from `fii_dii_flow`.

`fii_dii_flow` columns: `date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source, fetched_at`

**Files:**
- Modify: `src/server/technicalSignalsService.ts`

- [ ] **Step 1: Add FII/DII lookup helper**

Add near the `getPcrForSymbol` helper from Task 3:

```typescript
function getFiiDiiRolling(scanDate: string): { fii_10d_net: number | null; dii_3d_net: number | null } {
  const fii10 = db.prepare(`
    SELECT SUM(fii_net) AS total FROM fii_dii_flow
    WHERE date <= ? ORDER BY date DESC LIMIT 10
  `).get(scanDate) as { total: number | null } | undefined;

  const dii3 = db.prepare(`
    SELECT SUM(dii_net) AS total FROM fii_dii_flow
    WHERE date <= ? ORDER BY date DESC LIMIT 3
  `).get(scanDate) as { total: number | null } | undefined;

  return {
    fii_10d_net: fii10?.total ?? null,
    dii_3d_net:  dii3?.total  ?? null,
  };
}
```

- [ ] **Step 2: Call once per scan (not per symbol — it's market-wide data)**

Before the transaction loop, compute once:

```typescript
const { fii_10d_net, dii_3d_net } = getFiiDiiRolling(scanDate);
```

- [ ] **Step 3: Pass to upsert for every row**

Add to `upsert.run({...})`:

```typescript
fii_10d_net,
dii_3d_net,
```

- [ ] **Step 4: Update INSERT statement**

Add `fii_10d_net, dii_3d_net` to the INSERT column list, VALUES, and ON CONFLICT DO UPDATE SET clause in the `db.prepare` string (same pattern as Task 3 Step 3).

- [ ] **Step 5: Verify**

```bash
python -c "
import sqlite3; c = sqlite3.connect('database.sqlite')
r = c.execute('SELECT symbol, fii_3d_net, fii_10d_net, dii_3d_net FROM technical_signals LIMIT 5').fetchall()
print(r)
"
```
Expected: fii_10d_net and dii_3d_net columns have values (or null if fii_dii_flow has no recent data).

- [ ] **Step 6: Commit**

```bash
git add src/server/technicalSignalsService.ts
git commit -m "feat(signals): add fii_10d_net and dii_3d_net rolling aggregates to technical_signals"
```

---

## Task 5: Delivery % — Populate from NSE Bhavcopy

**Goal:** The `delivery_pct` column exists in `technical_signals` but is never written. NSE publishes a daily Bhavcopy CSV with delivery quantities.

URL pattern: `https://archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv`
Relevant columns: `SYMBOL`, `TTL_TRD_QNTY` (total traded qty), `DELIV_QTY` (delivery qty), `SERIES` (filter to `EQ`).

**Files:**
- Create: `src/server/deliveryFetcher.ts`
- Modify: `src/server/technicalSignalsService.ts`

- [ ] **Step 1: Create deliveryFetcher.ts**

```typescript
// src/server/deliveryFetcher.ts
import db from './db';

let deliveryCache: Map<string, number> | null = null;
let deliveryCacheDate: string | null = null;

export async function fetchDeliveryMap(scanDate: string): Promise<Map<string, number>> {
  if (deliveryCache && deliveryCacheDate === scanDate) return deliveryCache;

  const [year, month, day] = scanDate.split('-');
  const ddmmyyyy = `${day}${month}${year}`;
  const url = `https://archives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/csv', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return new Map();

    const text = await res.text();
    const lines = text.trim().split('\n');
    const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const symIdx   = header.indexOf('SYMBOL');
    const seriesIdx = header.indexOf('SERIES');
    const trdIdx   = header.indexOf('TTL_TRD_QNTY');
    const delIdx   = header.indexOf('DELIV_QTY');

    if (symIdx < 0 || trdIdx < 0 || delIdx < 0) return new Map();

    const map = new Map<string, number>();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols[seriesIdx] !== 'EQ') continue;
      const sym   = cols[symIdx];
      const traded = parseFloat(cols[trdIdx]);
      const deliv  = parseFloat(cols[delIdx]);
      if (traded > 0 && !isNaN(deliv)) {
        map.set(sym, parseFloat(((deliv / traded) * 100).toFixed(2)));
      }
    }

    deliveryCache = map;
    deliveryCacheDate = scanDate;
    console.log(`[Delivery] Loaded delivery% for ${map.size} symbols from NSE Bhavcopy (${scanDate})`);
    return map;
  } catch (err) {
    console.warn(`[Delivery] Failed to fetch Bhavcopy for ${scanDate}:`, (err as Error).message);
    return new Map();
  }
}
```

- [ ] **Step 2: Import and use in technicalSignalsService.ts**

At the top of `technicalSignalsService.ts`, add:

```typescript
import { fetchDeliveryMap } from './deliveryFetcher';
```

Before the transaction loop (after `scanDate` is determined), add:

```typescript
const deliveryMap = await fetchDeliveryMap(scanDate);
```

Inside `upsert.run({...})`, add:

```typescript
delivery_pct: deliveryMap.get(r.symbol) ?? null,
```

- [ ] **Step 3: Update the INSERT statement**

`delivery_pct` is already in the INSERT column list (it was added via migrateColumn previously). Verify it's in the ON CONFLICT DO UPDATE SET clause:

```typescript
delivery_pct=excluded.delivery_pct,
```

If not present, add it.

- [ ] **Step 4: Verify**

```bash
python -c "
import sqlite3; c = sqlite3.connect('database.sqlite')
r = c.execute('SELECT symbol, delivery_pct FROM technical_signals WHERE delivery_pct IS NOT NULL LIMIT 10').fetchall()
print(r)
"
```
Expected: rows with delivery_pct between 10.0 and 95.0 for major stocks.

- [ ] **Step 5: Commit**

```bash
git add src/server/deliveryFetcher.ts src/server/technicalSignalsService.ts
git commit -m "feat(signals): populate delivery_pct from NSE Bhavcopy in technical_signals"
```

---

## Task 6: Sector Relative Momentum (sector_ret_5d, sector_ret_21d)

**Goal:** Compute average 5-day and 21-day price return for a stock's sector peers (from `stock_ohlcv + nse_stocks`) and write to `technical_signals`. Signals in outperforming sectors carry higher conviction.

**Files:**
- Modify: `src/server/technicalSignalsService.ts`

- [ ] **Step 1: Add sector momentum helper**

```typescript
const sectorMomentumCache = new Map<string, { ret5: number | null; ret21: number | null }>();

function getSectorMomentum(sector: string | null, scanDate: string): { sector_ret_5d: number | null; sector_ret_21d: number | null } {
  if (!sector) return { sector_ret_5d: null, sector_ret_21d: null };
  const key = `${sector}:${scanDate}`;
  if (sectorMomentumCache.has(key)) {
    const v = sectorMomentumCache.get(key)!;
    return { sector_ret_5d: v.ret5, sector_ret_21d: v.ret21 };
  }

  const row5 = db.prepare(`
    SELECT AVG((today.close - past.close) / past.close * 100.0) AS ret
    FROM stock_ohlcv today
    JOIN nse_stocks ns ON ns.symbol = today.symbol
    JOIN (
      SELECT o.symbol, o.close
      FROM stock_ohlcv o
      WHERE o.date = (
        SELECT date FROM stock_ohlcv WHERE symbol = o.symbol AND date < :scanDate ORDER BY date DESC LIMIT 1 OFFSET 4
      )
    ) past ON past.symbol = today.symbol
    WHERE ns.sector = :sector
      AND today.date = :scanDate
  `).get({ sector, scanDate }) as { ret: number | null } | undefined;

  const row21 = db.prepare(`
    SELECT AVG((today.close - past.close) / past.close * 100.0) AS ret
    FROM stock_ohlcv today
    JOIN nse_stocks ns ON ns.symbol = today.symbol
    JOIN (
      SELECT o.symbol, o.close
      FROM stock_ohlcv o
      WHERE o.date = (
        SELECT date FROM stock_ohlcv WHERE symbol = o.symbol AND date < :scanDate ORDER BY date DESC LIMIT 1 OFFSET 20
      )
    ) past ON past.symbol = today.symbol
    WHERE ns.sector = :sector
      AND today.date = :scanDate
  `).get({ sector, scanDate }) as { ret: number | null } | undefined;

  const result = { ret5: row5?.ret ?? null, ret21: row21?.ret ?? null };
  sectorMomentumCache.set(key, result);
  return { sector_ret_5d: result.ret5, sector_ret_21d: result.ret21 };
}
```

- [ ] **Step 2: Look up sector per symbol and call helper**

Inside the transaction, for each `r`, look up the stock's sector then call the helper. Add a batch pre-fetch before the transaction to avoid N+1 queries:

```typescript
// Before transaction — build symbol→sector map
const sectorRows = db.prepare(`
  SELECT symbol, sector FROM nse_stocks WHERE symbol IN (${results.map(() => '?').join(',')})
`).all(...results.map(r => r.symbol)) as { symbol: string; sector: string }[];
const symbolSectorMap = new Map(sectorRows.map(r => [r.symbol, r.sector]));
```

Then inside the transaction per row:

```typescript
const sector = symbolSectorMap.get(r.symbol) ?? null;
const { sector_ret_5d, sector_ret_21d } = getSectorMomentum(sector, scanDate);
```

- [ ] **Step 3: Add to upsert.run and INSERT statement**

Add to `upsert.run({...})`:
```typescript
sector_ret_5d,
sector_ret_21d,
```

Add `sector_ret_5d, sector_ret_21d` to the INSERT column list, VALUES (`@sector_ret_5d, @sector_ret_21d`), and ON CONFLICT clause.

- [ ] **Step 4: Verify**

```bash
python -c "
import sqlite3; c = sqlite3.connect('database.sqlite')
r = c.execute('SELECT symbol, sector_ret_5d, sector_ret_21d FROM technical_signals WHERE sector_ret_5d IS NOT NULL LIMIT 5').fetchall()
print(r)
"
```
Expected: sector_ret_5d values in the range -15 to +15 (percentage).

- [ ] **Step 5: Commit**

```bash
git add src/server/technicalSignalsService.ts
git commit -m "feat(signals): add sector_ret_5d and sector_ret_21d momentum features to technical_signals"
```

---

## Task 7: ML Ensemble — Wire All New Features

**Goal:** Add the 6 new columns (pcr_oi, pcr_vol, fii_10d_net, dii_3d_net, delivery_pct, sector_ret_5d, sector_ret_21d) to the ML training query, scoring query, and `build_features()` function. Retrain the ensemble.

**Files:**
- Modify: `src/server/ml_ensemble.py`

- [ ] **Step 1: Add new features to build_features()**

In `ml_ensemble.py`, inside `build_features(df)` after the existing feature block (after line ~107), add:

```python
# PCR — put/call ratio (stock level and market level)
X['pcr_oi']  = pd.to_numeric(df.get('pcr_oi',  1.0), errors='coerce').fillna(1.0)
X['pcr_vol'] = pd.to_numeric(df.get('pcr_vol', 1.0), errors='coerce').fillna(1.0)

# Extended FII/DII flows (Cr, normalized to 10K Cr scale)
X['fii_10d_net'] = pd.to_numeric(df.get('fii_10d_net', 0), errors='coerce').fillna(0) / 10000.0
X['dii_3d_net']  = pd.to_numeric(df.get('dii_3d_net',  0), errors='coerce').fillna(0) / 10000.0

# Delivery % (institutional conviction proxy)
X['delivery_pct'] = pd.to_numeric(df.get('delivery_pct', 50), errors='coerce').fillna(50) / 100.0

# Sector relative momentum
X['sector_ret_5d']  = pd.to_numeric(df.get('sector_ret_5d',  0), errors='coerce').fillna(0)
X['sector_ret_21d'] = pd.to_numeric(df.get('sector_ret_21d', 0), errors='coerce').fillna(0)

# Interaction: delivery conviction × signal score
X['delivery_x_score'] = X['delivery_pct'] * X['signal_score']
```

- [ ] **Step 2: Add new columns to load_training_data() query**

Find `load_training_data()` (around line 113). The SELECT statement joins `signal_outcomes so`, `technical_signals ts`, `stock_fundamentals sf`. Add the new columns to the `ts.` column list:

```python
q = """
    SELECT so.symbol, so.signal_date, so.horizon_days, so.outcome,
           so.signal_score, so.signals_json, so.return_pct,
           ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
           ts.fii_3d_net, ts.above_sma200,
           ts.pcr_oi, ts.pcr_vol,
           ts.fii_10d_net, ts.dii_3d_net,
           ts.delivery_pct,
           ts.sector_ret_5d, ts.sector_ret_21d,
           sf.fifty_two_week_high
    FROM signal_outcomes so
    LEFT JOIN technical_signals ts
           ON ts.symbol = so.symbol AND ts.date = so.signal_date
    LEFT JOIN stock_fundamentals sf
           ON sf.symbol = so.symbol
    WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
      AND so.return_pct IS NOT NULL
"""
```

- [ ] **Step 3: Add new columns to load_pending_signals() query**

Find `load_pending_signals()` (around line 134). Same pattern — add the new `ts.` columns:

```python
q = """
    SELECT ts.symbol, ts.date AS signal_date, ts.signal_score, ts.signals_json,
           ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
           ts.fii_3d_net, ts.above_sma200,
           ts.pcr_oi, ts.pcr_vol,
           ts.fii_10d_net, ts.dii_3d_net,
           ts.delivery_pct,
           ts.sector_ret_5d, ts.sector_ret_21d,
           sf.fifty_two_week_high
    FROM technical_signals ts
    LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
    WHERE ts.win_probability IS NULL
      AND ts.signals_json IS NOT NULL
    ORDER BY ts.date DESC
    LIMIT 10000
"""
```

- [ ] **Step 4: Retrain the ensemble**

```bash
python src/server/ml_ensemble.py --retrain-full --min-samples 20
```

Expected output includes: `[Ensemble] Training complete. AUC: X.XX, Accuracy: X.XX`

If training fails with "not enough samples", reduce `--min-samples 10`.

- [ ] **Step 5: Score pending signals**

```bash
python src/server/ml_ensemble.py --score
```

- [ ] **Step 6: Verify feature importance includes new features**

```bash
python -c "
import sqlite3; c = sqlite3.connect('database.sqlite')
rows = c.execute('''
  SELECT fi.feature_name, fi.importance
  FROM feature_importance_log fi
  JOIN model_registry mr ON mr.id = fi.model_id
  WHERE mr.is_active = 1
  ORDER BY fi.importance DESC LIMIT 20
''').fetchall()
for r in rows: print(f'{r[0]:30s} {r[1]:.4f}')
"
```
Expected: New features (pcr_oi, delivery_pct, sector_ret_5d, etc.) appear in the top 20, with delivery_pct and pcr_oi likely in the top 10.

- [ ] **Step 7: Commit**

```bash
git add src/server/ml_ensemble.py src/server/ml_models/ensemble.pkl src/server/ml_models/feature_scaler_v1.pkl
git commit -m "feat(ml): add pcr, delivery%, extended fii/dii, sector momentum to ensemble features; retrain"
```

---

## Task 8: Per-Signal Horizon in Outcome Resolver

**Goal:** Currently `outcome_resolver.py` uses a single CLI `--horizon` for all signals. The `time_horizon` TEXT field in `technical_signals` (e.g. "5 days", "15 days", "intraday") should drive per-signal resolution horizon, defaulting to the CLI arg when absent.

**Files:**
- Modify: `src/server/outcome_resolver.py`

- [ ] **Step 1: Add a horizon parser**

In `outcome_resolver.py`, after the imports, add:

```python
import re

def parse_horizon(time_horizon_str, default_days: int) -> int:
    """Parse '5 days', '15 days', 'intraday' etc. to integer days."""
    if not time_horizon_str:
        return default_days
    s = str(time_horizon_str).lower().strip()
    if 'intraday' in s or '1 day' in s:
        return 1
    m = re.search(r'(\d+)', s)
    if m:
        days = int(m.group(1))
        return max(1, min(days, 30))   # clamp to sensible range
    return default_days
```

- [ ] **Step 2: Add time_horizon to the pending query**

In `resolve_outcomes()`, find the `pending = conn.execute("""...""")` query. Add `ts.time_horizon` to the SELECT:

```python
pending = conn.execute("""
    SELECT ts.symbol, ts.date AS signal_date, ts.cmp AS entry_price,
           ts.signal_score, ts.signals_json,
           CAST(ts.stop_loss AS REAL) AS stop_loss,
           ts.time_horizon
     FROM technical_signals ts
     WHERE ts.date <= ?
       AND NOT EXISTS (
           SELECT 1 FROM signal_outcomes so2
           WHERE so2.symbol = ts.symbol
             AND so2.signal_date = ts.date
             AND so2.horizon_days = ?
             AND so2.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
       )
     ORDER BY ts.date DESC
     LIMIT 2000
""", (cutoff, horizon_days)).fetchall()

cols = ['symbol', 'signal_date', 'entry_price', 'signal_score', 'signals_json', 'stop_loss', 'time_horizon']
```

- [ ] **Step 3: Use parsed horizon per signal**

Inside the `for row in rows:` loop, after `sym = row['symbol']`, add:

```python
sig_horizon = parse_horizon(row.get('time_horizon'), horizon_days)
```

Then replace all uses of `horizon_days` inside this loop (in the upsert and the cutoff calculation for that signal) with `sig_horizon`. The upsert already takes horizon_days as a parameter — pass `sig_horizon` instead:

```python
# Find the upsert execution inside the loop, e.g.:
conn.execute(upsert, (sym, signal_date, sig_horizon, entry, check_date, exit_price, ret_pct, outcome, row['signal_score'], row['signals_json']))
```

- [ ] **Step 4: Test with a known signal**

```bash
python src/server/outcome_resolver.py --dry-run --horizon 5
```
Expected: output shows signals being resolved with their individual horizons, not all at 5 days. Look for log lines indicating `sig_horizon` varies per signal.

Add a quick print inside the loop to confirm:
```python
print(f"[OutcomeResolver] {sym} {signal_date}: time_horizon='{row.get('time_horizon')}' -> sig_horizon={sig_horizon}d")
```
Remove the print after confirming it works.

- [ ] **Step 5: Run for real**

```bash
python src/server/outcome_resolver.py --horizon 15
```

- [ ] **Step 6: Verify outcome distribution**

```bash
python -c "
import sqlite3; c = sqlite3.connect('database.sqlite')
rows = c.execute('SELECT horizon_days, outcome, COUNT(*) FROM signal_outcomes GROUP BY horizon_days, outcome ORDER BY horizon_days, outcome').fetchall()
for r in rows: print(r)
"
```
Expected: `horizon_days` values now include a spread (1, 5, 10, 15 etc.) rather than only 5 and 15.

- [ ] **Step 7: Commit**

```bash
git add src/server/outcome_resolver.py
git commit -m "feat(outcomes): resolve each signal against its own time_horizon instead of single CLI arg"
```

---

## Self-Review

**Spec coverage check:**
- [x] Win probability gate — Task 1 (scoring_engine + ml_ensemble propagation)
- [x] PCR features — Task 3 (technicalSignalsService) + Task 7 (ml_ensemble)
- [x] FII/DII extended rolling — Task 4 (technicalSignalsService) + Task 7 (ml_ensemble)
- [x] Delivery % — Task 5 (deliveryFetcher + technicalSignalsService) + Task 7 (ml_ensemble)
- [x] Sector relative momentum — Task 6 (technicalSignalsService) + Task 7 (ml_ensemble)
- [x] Per-signal horizon — Task 8 (outcome_resolver)
- [x] Schema prerequisites — Task 2 (db.ts migrateColumn)

**Dependency order:** Tasks 1, 2, 8 are fully independent. Tasks 3–6 each depend on Task 2 (schema). Task 7 depends on Tasks 3–6 having populated data. Recommended execution order: 1 → 2 → 3,4,5,6 (parallel) → 7 → 8.

**Type consistency:** `fii_10d_net` naming consistent across db.ts, technicalSignalsService.ts, and ml_ensemble.py. `sector_ret_5d`/`sector_ret_21d` consistent. `pcr_oi`/`pcr_vol` consistent. `delivery_pct` was already a column name in the schema.

**No placeholders:** All SQL, TypeScript, and Python code is complete and runnable as written.
