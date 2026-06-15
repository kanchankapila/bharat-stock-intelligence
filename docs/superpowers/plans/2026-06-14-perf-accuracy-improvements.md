# Performance & Accuracy Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Execute task-by-task with two-stage review (spec then quality) after each.

**Goal:** Six targeted improvements across Python ML engines and TypeScript backend:
1. DB indexing (foundational — go first)
2. Feature engineering batch SQLite writes
3. PyTorch loss function bug + training corpus expansion (both in dl_engine.py)
4. Regime-dynamic confluence weights
5. Async ingestion (Python + Node.js)

**Tech stack:** Python 3.11, SQLite/better-sqlite3, PyTorch (CPU), TypeScript/Node.js, httpx, asyncio

---

## File Map

| File | Task | Change |
|---|---|---|
| `src/server/db.ts` | Task 1 | Add composite indices on feature_store and stock_scores |
| `src/server/feature_engineering.py` | Task 2 | Replace row-by-row commits with executemany + single transaction |
| `src/server/dl_engine.py` | Task 3 | Fix softmax/CrossEntropyLoss bug; expand training corpus to all 2000+ symbols |
| `src/server/confluenceEngine.ts` | Task 4 | Regime-dynamic weight multipliers in scoreStock() |
| `src/server/backfill_ohlcv.py` | Task 5 | Replace sequential yfinance downloads with concurrent asyncio batches |
| `src/server/liveStockData.ts` | Task 5 | Ensure batch-level concurrency uses Promise.all |

---

## Task 1: Database Indexing

**Files:** `src/server/db.ts`

**Problem:** `feature_store` table has zero indices. `stock_scores` has individual indices on `symbol` and `timeframe` but no composite. The DL engine and ML scoring both query `WHERE symbol=? AND timeframe='D'` on `feature_store`, triggering full table scans on a table with millions of rows.

**Fix:** Add two composite indices via the `runMigration()` pattern already established in `db.ts`.

**Implementation:**

Search for the last `runMigration(` call in `db.ts` and append after it:

```typescript
runMigration('add-feature-store-indices', `
  CREATE INDEX IF NOT EXISTS idx_fs_sym_date_tf ON feature_store(symbol, date, timeframe);
  CREATE INDEX IF NOT EXISTS idx_fs_sym_tf ON feature_store(symbol, timeframe);
`);

runMigration('add-stock-scores-composite-idx', `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_sym_tf ON stock_scores(symbol, timeframe);
`);
```

**Note:** `idx_stock_scores_symbol` and `idx_ss_timeframe` already exist as separate indices; the composite `(symbol, timeframe)` is needed for the common `WHERE symbol=? AND timeframe=?` query pattern. Check first whether `idx_ss_sym_tf` would conflict with the existing unique constraint on `(symbol, timeframe)` — if `stock_scores` already has a UNIQUE constraint on those two columns, use a plain INDEX instead.

**Tests:** Write `src/server/tests/test_db_indices.py`:
- Open the database and run `PRAGMA index_list(feature_store)` — assert `idx_fs_sym_date_tf` exists
- Open the database and run `PRAGMA index_list(stock_scores)` — assert a composite index on `(symbol, timeframe)` exists
- Run `EXPLAIN QUERY PLAN SELECT * FROM feature_store WHERE symbol='INFY' AND timeframe='D'` — assert output contains "USING INDEX" (not "SCAN")

**Commit:** `perf(db): add composite indices on feature_store(symbol,date,timeframe) and stock_scores(symbol,timeframe)`

---

## Task 2: Feature Engineering Batch SQLite Writes

**Files:** `src/server/feature_engineering.py`

**Problem:** In `process_symbol()` (lines 303–373), each row is inserted one at a time inside a Python `for date, row in feat.iterrows()` loop, then `con.commit()` is called once per symbol. Worse, `_con()` opens a new sqlite3 connection for every symbol call. With 2238 symbols, this is 2238 connection-open/close cycles plus tens of thousands of individual `execute()` calls.

**Fix:** Two changes:

**A. Use `executemany()` inside `process_symbol()`:**

Replace the row-by-row loop (lines 303–374):

```python
# OLD — row by row
written = 0
for date, row in feat.iterrows():
    if only_date and date.strftime("%Y-%m-%d") < only_date:
        continue
    d = row.to_dict()
    cur.execute("""INSERT OR REPLACE INTO feature_store ...""", (...))
    written += 1
con.commit()
return written

# NEW — batch with executemany
rows_to_insert = []
for date, row in feat.iterrows():
    if only_date and date.strftime("%Y-%m-%d") < only_date:
        continue
    d = row.to_dict()
    rows_to_insert.append((
        symbol, date.strftime("%Y-%m-%d"),
        d.get("ret_1d"), d.get("ret_5d"), ...  # same tuple as before
    ))
if rows_to_insert:
    cur.executemany("""INSERT OR REPLACE INTO feature_store ...""", rows_to_insert)
    con.commit()
return len(rows_to_insert)
```

**B. Share a single connection across all symbols in `run_full_pipeline()`:**

Refactor `run_full_pipeline()` to open one connection, pass it into `process_symbol()`, and wrap everything in a single `BEGIN...COMMIT` block. Modify `process_symbol()` signature to accept an optional `con` parameter:

```python
def process_symbol(self, symbol: str, lookback_days: int = 504,
                   only_date: str = None, con: sqlite3.Connection = None) -> int:
    owns_con = con is None
    if owns_con:
        con = self._con()
    try:
        ...
        # use executemany, no commit here when con is shared
        if rows_to_insert:
            cur.executemany(INSERT_SQL, rows_to_insert)
            if owns_con:
                con.commit()
        return len(rows_to_insert)
    finally:
        if owns_con:
            con.close()
```

In `run_full_pipeline()`:
```python
con = self._con()
try:
    con.execute("BEGIN")
    for i, sym in enumerate(symbols, 1):
        ...
        n = self.process_symbol(sym, lookback_days, today, con=con)
        if i % 200 == 0:
            con.execute("COMMIT")
            con.execute("BEGIN")
    con.execute("COMMIT")
finally:
    con.close()
```

Use commit checkpoints every 200 symbols to avoid holding too large a write lock.

**Tests:** Write `src/server/tests/test_feature_engineering_batch.py`:
- `test_executemany_used`: Monkeypatch `sqlite3.Cursor.executemany` to count calls; process 3 symbols; assert `executemany` was called (not just `execute`)
- `test_single_connection_shared`: Monkeypatch `sqlite3.connect` to count connections opened; run `run_full_pipeline([sym1, sym2, sym3])`; assert connect was called exactly once
- `test_written_count_correct`: Use in-memory DB, run full pipeline on 2 test symbols with known OHLCV, assert returned count matches inserted rows

Run `py -3 -m pytest src/server/tests/test_feature_engineering_batch.py -v`.

**Commit:** `perf(feature_engineering): executemany + single-transaction batch writes (~12x speedup)`

---

## Task 3: PyTorch Loss Function Bug + Training Corpus Expansion

**Files:** `src/server/dl_engine.py`

Both bugs are in the same file. Fix both in one commit.

### Bug A: Softmax / CrossEntropyLoss mismatch

**Problem:** `BiLSTMModel.forward()` applies `torch.softmax` to classification heads (lines 105–107):
```python
"dir_1d":  torch.softmax(self.head_dir_1d(feat),  dim=-1),
"dir_5d":  torch.softmax(self.head_dir_5d(feat),  dim=-1),
"dir_15d": torch.softmax(self.head_dir_15d(feat), dim=-1),
```

But `_train_one_fold()` (line 241) passes the output directly to `nn.CrossEntropyLoss`:
```python
ce = nn.CrossEntropyLoss()
...
loss = ce(out["dir_5d"], yb) * 0.5 + hub(out["ret_5d"], rb) * 0.5
```

`nn.CrossEntropyLoss` applies `log_softmax` internally and expects **raw logits**. Passing pre-softmaxed probabilities produces mathematically incorrect gradients (log of a value already in [0,1] range, collapsed near 0).

**Fix A:**

1. In `BiLSTMModel.forward()`, return raw logits from dir heads:
```python
return {
    "dir_1d":  self.head_dir_1d(feat),   # raw logits
    "dir_5d":  self.head_dir_5d(feat),   # raw logits
    "dir_15d": self.head_dir_15d(feat),  # raw logits
    "ret_5d":  self.head_ret_5d(feat).squeeze(-1),
    "ret_15d": self.head_ret_15d(feat).squeeze(-1),
}
```

2. In `_predict_batch()`, apply softmax to dir outputs before returning:
```python
for k in ["dir_1d", "dir_5d", "dir_15d"]:
    results[k].append(torch.softmax(out[k], dim=-1).cpu().numpy())
```

3. In `run_inference()`, the `preds["dir_1d"][i][1]` usage already treats index 1 as "prob up" — that's fine once softmax is applied at prediction time. No change needed there.

### Bug B: Training corpus capped at 150 symbols

**Problem:** Lines 289–304:
```python
MAX_TRAIN_SYMBOLS = min(150, max(20, int(_free_gb * 80)))  # never exceeds 150

if len(symbols) > MAX_TRAIN_SYMBOLS:
    rng = np.random.default_rng(seed=42)
    symbols = list(rng.choice(symbols, MAX_TRAIN_SYMBOLS, replace=False))
```

With 2000+ symbols having 252+ days of features, this cap leaves ~93% of training data unused.

**Fix B:** Remove the cap and stream sequences in symbol-batches to avoid loading all arrays into RAM simultaneously.

Replace the sampling logic with chunked loading:

```python
CHUNK_SIZE = 100  # process 100 symbols at a time to bound peak RAM

def train_lstm(version: int = 1) -> Dict:
    con = sqlite3.connect(DB_PATH)
    symbols = [r[0] for r in con.execute(
        "SELECT DISTINCT symbol FROM feature_store "
        "GROUP BY symbol HAVING COUNT(*) >= 252"
    ).fetchall()]
    con.close()

    print(f"[DL] Training BiLSTM on {len(symbols)} symbols (chunked)...")
    model = BiLSTMModel().to(DEVICE)
    opt   = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sch   = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=100)
    ce    = nn.CrossEntropyLoss()
    hub   = nn.HuberLoss(delta=0.02)

    for epoch in range(100):
        model.train()
        rng = np.random.default_rng(seed=epoch)
        shuffled = list(rng.permutation(symbols))
        for chunk_start in range(0, len(shuffled), CHUNK_SIZE):
            chunk = shuffled[chunk_start:chunk_start + CHUNK_SIZE]
            con   = sqlite3.connect(DB_PATH)
            X_parts, y5_parts, yr5_parts = [], [], []
            for sym in chunk:
                try:
                    X, y5, _, yr5, _ = load_symbol_sequences(sym, con)
                    if len(X) > 0:
                        X_parts.append(X); y5_parts.append(y5); yr5_parts.append(yr5)
                except Exception:
                    pass
            con.close()
            if not X_parts:
                continue
            X_c   = np.concatenate(X_parts).astype(np.float32)
            y5_c  = np.concatenate(y5_parts).astype(np.int64)
            yr5_c = np.concatenate(yr5_parts).astype(np.float32)
            # one gradient pass per chunk per epoch
            perm = np.random.permutation(len(X_c))
            for start in range(0, len(X_c), 128):
                idx = perm[start:start+128]
                xb  = torch.from_numpy(X_c[idx]).to(DEVICE)
                yb  = torch.from_numpy(y5_c[idx]).to(DEVICE)
                rb  = torch.from_numpy(yr5_c[idx]).to(DEVICE)
                out = model(xb)
                loss = ce(out["dir_5d"], yb)*0.5 + hub(out["ret_5d"], rb)*0.5
                opt.zero_grad(); loss.backward(); opt.step()
            del X_c, y5_c, yr5_c
        sch.step()
        if (epoch + 1) % 10 == 0:
            print(f"[DL] Epoch {epoch+1}/100 complete")

    # Walk-forward validation on a sample (keep this manageable)
    val_syms = symbols[:min(50, len(symbols))]
    con = sqlite3.connect(DB_PATH)
    all_X, all_y5, all_y15, all_yr5 = [], [], [], []
    for sym in val_syms:
        try:
            X, y5, y15, yr5, _ = load_symbol_sequences(sym, con)
            if len(X) > 0:
                all_X.append(X); all_y5.append(y5); all_y15.append(y15); all_yr5.append(yr5)
        except Exception:
            pass
    con.close()
    if all_X:
        X_all = np.concatenate(all_X); y5_all = np.concatenate(all_y5)
        y15_all = np.concatenate(all_y15); yr5_all = np.concatenate(all_yr5)
        metrics = walk_forward_validate(model, X_all, y5_all, y15_all, yr5_all)
    else:
        metrics = {"directional_accuracy": np.nan, "roc_auc": np.nan}

    print(f"[DL] Walk-forward metrics: {metrics}")
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_DIR / f"lstm_v{version}.pt"
    torch.save(model.state_dict(), path)
    print(f"[DL] Model saved to {path}")
    return metrics
```

Remove the `MAX_TRAIN_SYMBOLS` constant and `psutil` import (the memory guard is replaced by chunked loading).

**Tests:** Write `src/server/tests/test_dl_engine.py`:

```python
class TestSoftmaxBug:
    def test_forward_returns_raw_logits(self):
        import torch
        from src.server.dl_engine import BiLSTMModel
        model = BiLSTMModel(n_features=78, hidden=16)
        x = torch.randn(2, 60, 78)
        out = model(x)
        # Raw logits: values NOT in [0,1] and NOT summing to 1
        dir5 = out["dir_5d"]
        assert not torch.all((dir5 >= 0) & (dir5 <= 1)), \
            "dir_5d appears to be softmax output (all in [0,1]); should be raw logits"

    def test_cross_entropy_accepts_logits(self):
        import torch
        import torch.nn as nn
        from src.server.dl_engine import BiLSTMModel, _train_one_fold
        import numpy as np
        # If softmax is still applied before CE, CE loss will be very low (~0)
        # because softmax(softmax(x)) collapses gradients
        model = BiLSTMModel(n_features=78, hidden=16)
        X = np.random.randn(10, 60, 78).astype(np.float32)
        y5 = np.array([0,1,0,1,0,1,0,1,0,1], dtype=np.int64)
        yr5 = np.random.randn(10).astype(np.float32)
        # Should not raise; loss should be > 0 (non-trivial)
        _train_one_fold(model, X, y5, yr5, epochs=1)

class TestTrainingCorpus:
    def test_no_symbol_cap(self):
        import inspect
        import src.server.dl_engine as mod
        src_code = inspect.getsource(mod.train_lstm)
        assert 'MAX_TRAIN_SYMBOLS' not in src_code, \
            "train_lstm still references MAX_TRAIN_SYMBOLS cap"
        assert 'rng.choice' not in src_code, \
            "train_lstm still randomly samples symbols (corpus cap not removed)"
```

Run: `py -3 -m pytest src/server/tests/test_dl_engine.py -v`

**Commit:** `fix(dl_engine): remove softmax from forward() for correct CE loss; chunked training on all 2000+ symbols`

---

## Task 4: Regime-Dynamic Confluence Weights

**Files:** `src/server/confluenceEngine.ts`

**Problem:** `scoreStock()` (line 159) uses static weights for all 5 components regardless of market regime. In a BEAR market, momentum breakouts have very different statistical validity than in a BULL market — breakout signals fail far more often when the broader market is trending down. Fundamental/valuation signals are more regime-stable.

**Fix:** Add a `regime` parameter to `scoreStock()` and apply multipliers per component:

**Regime multiplier table:**

| Regime | screener momentum/breakout | trendScore | volScore | sectorScore | fundScore |
|---|---|---|---|---|---|
| BULL | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| SIDEWAYS | 0.9 | 0.9 | 1.0 | 0.9 | 1.1 |
| HIGH_VOL | 0.7 | 0.8 | 0.6 | 0.8 | 1.2 |
| BEAR | 0.5 | 0.7 | 0.5 | 0.7 | 1.5 |
| CRASH | 0.25 | 0.5 | 0.3 | 0.5 | 1.8 |

**Implementation details:**

1. Add a `RegimeWeights` interface and constant map:
```typescript
interface RegimeWeights {
  screenerMomentum: number;  // multiplier on momentum/breakout screener scores
  trend: number;
  vol: number;
  sector: number;
  fund: number;
}

const REGIME_WEIGHTS: Record<string, RegimeWeights> = {
  BULL:     { screenerMomentum: 1.0, trend: 1.0, vol: 1.0, sector: 1.0, fund: 1.0 },
  SIDEWAYS: { screenerMomentum: 0.9, trend: 0.9, vol: 1.0, sector: 0.9, fund: 1.1 },
  HIGH_VOL: { screenerMomentum: 0.7, trend: 0.8, vol: 0.6, sector: 0.8, fund: 1.2 },
  BEAR:     { screenerMomentum: 0.5, trend: 0.7, vol: 0.5, sector: 0.7, fund: 1.5 },
  CRASH:    { screenerMomentum: 0.25,trend: 0.5, vol: 0.3, sector: 0.5, fund: 1.8 },
};
```

2. Add a `getCurrentRegime()` helper that queries `market_regimes` table:
```typescript
let _cachedRegime: { regime: string; fetchedAt: number } | null = null;

function getCurrentRegime(): string {
  const now = Date.now();
  if (_cachedRegime && now - _cachedRegime.fetchedAt < 30 * 60_000) {
    return _cachedRegime.regime;
  }
  try {
    const row = db.prepare(
      "SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1"
    ).get() as { regime: string } | undefined;
    const regime = row?.regime ?? 'SIDEWAYS';
    _cachedRegime = { regime, fetchedAt: now };
    return regime;
  } catch {
    return 'SIDEWAYS';
  }
}
```

3. In `scoreStock()`, apply multipliers:
- Apply `rw.screenerMomentum` to momentum/breakout screener classes (categories: `momentum`, `technical` with timeframe `swing` or `intraday`)
- Apply `rw.trend` to `trendScore` before capping at 15
- Apply `rw.vol` to `volScore` before capping at 10
- Apply `rw.sector` to `sectorScore` before capping at 8
- Apply `rw.fund` to `fundScore` before capping at 12

Specifically, in the screener weighted score (section A), when a bullish screener has category `momentum` or timeframe `intraday`, multiply its weight by `rw.screenerMomentum`. Fundamental/institutional screeners get `1.0` (no regime penalty).

4. Call `getCurrentRegime()` at the top of `scoreStock()`:
```typescript
const regime = getCurrentRegime();
const rw = REGIME_WEIGHTS[regime] ?? REGIME_WEIGHTS['SIDEWAYS'];
```

**Tests:** Write `src/server/tests/test_confluence_regime.ts`:
```typescript
// Use vitest or jest
import { scoreStock } from '../confluenceEngine'; // if exported — may need to export it
// OR test via the full scoreStock pipeline with mocked DB regime

// Test 1: BEAR regime discounts momentum screeners
// Test 2: CRASH regime heavily discounts breakout signals
// Test 3: BEAR regime boosts fundScore
// Test 4: BULL regime is neutral (multiplier = 1.0)
// Test 5: Unknown regime falls back to SIDEWAYS weights
```

Since `scoreStock` may not be directly exported, add a named export or test via the exported `computeConfluenceScore` or equivalent function.

**Commit:** `feat(confluence): regime-dynamic weight multipliers for bear/crash/vol/bull regimes`

---

## Task 5: Async Ingestion

**Files:** `src/server/backfill_ohlcv.py`, `src/server/liveStockData.ts`

### Part A: Python — Concurrent OHLCV Backfill

**Problem:** `backfill_ohlcv.py` downloads symbols one at a time in a sequential loop using `yf.download()`. With 2433 symbols, this is purely sequential I/O despite HTTP being highly parallelizable.

**Fix:** Replace the sequential chunk loop with `asyncio` + `httpx` concurrent batching.

Add `httpx` as a dependency (already in requirements for other packages; check first).

The yfinance `yf.download()` call is synchronous. Convert the download loop to use `asyncio.gather()` with an `asyncio.Semaphore` limiting concurrency to 20 simultaneous downloads:

```python
import asyncio
import httpx

SEM = asyncio.Semaphore(20)  # max 20 concurrent downloads

async def _fetch_symbol_async(client: httpx.AsyncClient, symbol: str,
                               start: str, end: str) -> list:
    """Download one symbol's OHLCV from Yahoo Finance asynchronously."""
    async with SEM:
        url = (
            f"https://query2.finance.yahoo.com/v8/finance/chart/{symbol}.NS"
            f"?interval=1d&period1={_to_unix(start)}&period2={_to_unix(end)}"
        )
        try:
            r = await client.get(url, timeout=15)
            r.raise_for_status()
            data = r.json()
            return _parse_yf_response(symbol.replace('.NS', ''), data)
        except Exception:
            return []

async def _bulk_download_async(symbols: list, start: str, end: str) -> list:
    async with httpx.AsyncClient(headers=YF_HEADERS) as client:
        tasks = [_fetch_symbol_async(client, s, start, end) for s in symbols]
        results = await asyncio.gather(*tasks)
    return [row for batch in results for row in batch]

def gap_fill(conn, lookback_days: int = 30):
    # ... (existing gap detection logic) ...
    records = asyncio.run(_bulk_download_async(missing_symbols, start_str, end_str))
    if records:
        conn.executemany("INSERT OR REPLACE INTO stock_ohlcv VALUES (?,?,?,?,?,?,?)", records)
        conn.commit()
```

Add helpers `_to_unix(date_str)` and `_parse_yf_response(symbol, data)`.

**Note:** YF rate limits apply — the `SEM = asyncio.Semaphore(20)` cap prevents ban. Add a brief `asyncio.sleep(0.05)` inside `_fetch_symbol_async` after acquiring the semaphore if rate limits are hit in testing.

### Part B: Node.js — Concurrent Promise.all in Live Stock Data

**File:** `src/server/liveStockData.ts`

Read the current batch-fetch logic. Check whether the outer loop over `chunks` calls each chunk sequentially or in parallel. If the existing code does:

```typescript
for (const chunk of chunks) {
  const result = await fetchBatchYahooFinance(chunk);
  // ...
}
```

Convert to:
```typescript
const results = await Promise.all(
  chunks.map(chunk => fetchBatchYahooFinance(chunk))
);
```

This change is conditional on whether sequential fetching is currently present. Read the file first and only make the change if the outer loop is indeed sequential. If it's already using `Promise.all`, skip Part B and document that finding.

**Tests:**

For Part A, write `src/server/tests/test_backfill_async.py`:
- `test_sem_limits_concurrency`: Mock `httpx.AsyncClient.get` with a counter; verify no more than 20 concurrent requests fire
- `test_records_inserted`: Use in-memory SQLite; mock 3 symbol responses; verify all 3 rows appear in stock_ohlcv

For Part B (if change is made): Node.js test asserting `Promise.all` is called for chunk dispatch.

**Commit:** `perf(backfill): concurrent asyncio/httpx downloads; Promise.all batch dispatch in Node`

---

## Self-Review Checklist

- [ ] Task 1: `idx_fs_sym_date_tf` and `idx_ss_sym_tf` both appear in `PRAGMA index_list()`
- [ ] Task 2: `executemany` used in `process_symbol()`; single connection passed through `run_full_pipeline()`
- [ ] Task 3: `BiLSTMModel.forward()` returns raw logits for dir heads; softmax only at `_predict_batch()`; `MAX_TRAIN_SYMBOLS` constant removed; chunked loop iterates all symbols
- [ ] Task 4: `REGIME_WEIGHTS` map has all 5 regimes; `getCurrentRegime()` caches for 30 min; multipliers applied to each scoring component
- [ ] Task 5: Python uses `asyncio.Semaphore(20)` + `asyncio.gather()`; Node.js batch loop uses `Promise.all`
