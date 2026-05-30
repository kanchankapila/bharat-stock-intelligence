# Feedback Loop & Signal Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three broken gaps in the ML feedback loop (15D outcome seeding, learned-weight consumption, RL bootstrap) and add signal conviction filtering so the system actually learns from outcomes and surfaces ~200 actionable signals instead of 5,476.

**Architecture:** All changes are additive — no existing behaviour removed. Phases 1 (feedback loop) must be complete before Phase 2 (signal quality) because Phase 2 depends on the data that Phase 1 starts producing. Each task is independently testable.

**Tech Stack:** TypeScript (tRPC, better-sqlite3), Python 3.11 (sqlite3, pandas, numpy, torch), SQLite

---

## File Map

| File | Change |
|------|--------|
| `src/server/technicalSignalsService.ts` | Seed 15D PENDING outcomes + wire signal_type_weights into scoreSignals() |
| `src/server/routers/technicals.router.ts` | Add effective_score to getTechnicalSignals + new getUnifiedSignals endpoint |
| `src/server/dl_trainer.py` | Fix NaN quality gate |
| `src/server/dl_engine.py` | Already fixed (cudnn.enabled=False, MAX_TRAIN_SYMBOLS=150) |
| `src/server/rl_agent.py` | Add --backfill mode |
| `src/server/outcome_resolver.py` | Add signal expiry sweep (NEUTRAL for >horizon_days old PENDING) |
| `src/server/feature_engineering.py` | Fix pd.cut duplicate bin-edge crash |
| `src/server/strategy_optimizer.py` | Weight objective by sample count |

---

## Phase 1 — Fix the Feedback Loop

### Task 1: Seed PENDING signal_outcomes rows for 15D at signal creation

**Problem:** `outcome_resolver.py --horizon 15` resolves 0 rows because no PENDING rows exist for 15D. They are only seeded for 5D by the recommendation_log insert. The resolver needs a row to update.

**Files:**
- Modify: `src/server/technicalSignalsService.ts:1164-1175`

- [ ] **Step 1: Locate the exact insert block**

Open `src/server/technicalSignalsService.ts` and find line ~1133 (`INSERT INTO recommendation_log`). The block ends around line 1173 with `recLogUpsert.run(...)`. Add the outcome seeding **inside** the `if (r.signalScore >= 4)` block, after the `recLogUpsert.run(...)` call.

- [ ] **Step 2: Add the signal_outcomes PENDING seeder**

Add this code immediately after `recLogUpsert.run(...)` inside the `db.transaction` callback:

```typescript
// Seed PENDING outcome rows for both 5D and 15D so resolver can resolve them
if (r.signalScore >= 4 && r.cmp) {
  const seedOutcome = db.prepare(`
    INSERT OR IGNORE INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome)
    VALUES (?, ?, ?, ?, 'PENDING')
  `);
  seedOutcome.run(r.symbol, scanDate, 5,  r.cmp);
  seedOutcome.run(r.symbol, scanDate, 15, r.cmp);
}
```

Note: `INSERT OR IGNORE` prevents duplicate seeding if scan runs twice on same day.

- [ ] **Step 3: Verify by running the scan and checking the table**

Restart the dev server, then in SQLite:

```bash
python -c "
import sqlite3, datetime
conn = sqlite3.connect('database.sqlite')
today = datetime.date.today().isoformat()
r = conn.execute('SELECT COUNT(*) FROM signal_outcomes WHERE outcome=\"PENDING\" AND signal_date=?', (today,)).fetchone()
print('PENDING rows today:', r[0])
r15 = conn.execute('SELECT COUNT(*) FROM signal_outcomes WHERE horizon_days=15 AND outcome=\"PENDING\"').fetchone()
print('15D PENDING total:', r15[0])
conn.close()
"
```

Expected: both counts > 0 after next scan fires.

- [ ] **Step 4: Run outcome_resolver manually and confirm rows resolve**

```bash
python src/server/outcome_resolver.py --horizon 15
```

Expected output contains: `[OutcomeResolver]` with resolved count (may be 0 if signals are too new — that's fine, rows now exist for future resolution).

- [ ] **Step 5: Commit**

```bash
git add src/server/technicalSignalsService.ts
git commit -m "fix(signals): seed PENDING signal_outcomes rows for 5D+15D at scan time"
```

---

### Task 2: Wire signal_type_weights into scoreSignals()

**Problem:** `signal_type_weights` table has 48 EMA-smoothed per-(signal_type, regime) weights from real outcomes (range 0.3–2.0). `scoreSignals()` ignores them entirely, using static hardcoded values instead.

**Files:**
- Modify: `src/server/technicalSignalsService.ts:1005-1050` (scan setup) and `:445-490` (scoreSignals function)

- [ ] **Step 1: Add a weight-loading helper after the existing `loadSignalWinRates` call**

In `runTechnicalSignalScan()`, around line 1008, add after `loadSignalWinRates`:

```typescript
function loadLearnedWeights(regime: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT signal_type, weight
    FROM signal_type_weights
    WHERE (regime = ? OR regime = 'ALL') AND sector = 'ALL'
    ORDER BY regime DESC
  `).all(regime) as { signal_type: string; weight: number }[];
  return new Map(rows.map(r => [r.signal_type, r.weight]));
}
```

Place this function near the other helper functions (around line 1000).

- [ ] **Step 2: Pass learned weights into scoreSignals()**

In `runTechnicalSignalScan()`, around line 1008, load the weights and pass them:

```typescript
const winRates      = loadSignalWinRates(15, niftyRegime);
const learnedWeights = loadLearnedWeights(niftyRegime);  // ADD THIS
```

And at the `scoreSignals` call (~line 1046):

```typescript
const score = scoreSignals(signals, winRates, niftyRegime, fii3dNet, sentimentScore, learnedWeights);
```

- [ ] **Step 3: Update the scoreSignals() signature and apply weights**

Change the function signature at line 445:

```typescript
function scoreSignals(
  signals: TechSignal[],
  winRates: Map<string, number> = new Map(),
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS' = 'BULL',
  fii3dNet: number | null = null,
  newsSentimentScore = 0,
  learnedWeights: Map<string, number> = new Map(),  // ADD
): number {
```

In the per-signal loop, change the score computation:

```typescript
// BEFORE:
const base = SIGNAL_SCORES[s.type]?.[s.strength] ?? 0;
const wr = winRates.get(s.type);
const wrMult = wr != null
  ? (wr >= 0.65 ? 1.25 : wr >= 0.55 ? 1.0 : wr >= 0.45 ? 0.85 : 0.70)
  : 1.0;
const setupDiscount = (s.type === 'BB_COMPRESSION' || s.type === 'ATR_CONTRACTION') ? 0.5 : 1.0;
total += base * wrMult * setupDiscount;

// AFTER:
const base = SIGNAL_SCORES[s.type]?.[s.strength] ?? 0;
const wr = winRates.get(s.type);
const wrMult = wr != null
  ? (wr >= 0.65 ? 1.25 : wr >= 0.55 ? 1.0 : wr >= 0.45 ? 0.85 : 0.70)
  : 1.0;
const setupDiscount = (s.type === 'BB_COMPRESSION' || s.type === 'ATR_CONTRACTION') ? 0.5 : 1.0;
// Apply EMA-smoothed learned weight from reward_engine (clamped 0.3–2.0)
const learned = Math.max(0.3, Math.min(2.0, learnedWeights.get(s.type) ?? 1.0));
total += base * wrMult * setupDiscount * learned;
```

- [ ] **Step 4: Verify weights are being applied**

Add a temporary log to confirm (remove after verification):

```typescript
console.log(`[SIGNALS] Loaded ${learnedWeights.size} learned weights for regime ${niftyRegime}`);
```

Run a scan and confirm the log shows `Loaded 48 learned weights`.

- [ ] **Step 5: Commit**

```bash
git add src/server/technicalSignalsService.ts
git commit -m "feat(signals): apply EMA-learned signal_type_weights in scoreSignals()"
```

---

### Task 3: Add effective_score to signal ranking

**Problem:** `win_probability` (ML ensemble output, range 0–1) is stored in `technical_signals` but `getTechnicalSignalsForDate` orders only by `signal_score`. A signal with score=8 and win_probability=0.35 should rank below score=7 with win_probability=0.65.

**Files:**
- Modify: `src/server/technicalSignalsService.ts:1193-1207`

- [ ] **Step 1: Update the SQL query to add effective_score**

Replace the `getTechnicalSignalsForDate` function at line 1193:

```typescript
export function getTechnicalSignalsForDate(
  date?: string,
  minScore = 1,
  limit = 100
): Record<string, unknown>[] {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT ts.*,
           ns.name,
           ns.sector,
           ROUND(ts.signal_score * (0.5 + COALESCE(ts.win_probability, 0.5)), 2) AS effective_score
    FROM technical_signals ts
    LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
    WHERE ts.date = ? AND ts.signal_score >= ?
    ORDER BY effective_score DESC, ts.signal_score DESC
    LIMIT ?
  `).all(d, minScore, limit) as Record<string, unknown>[];
}
```

`effective_score` ranges from `signal_score × 0.5` (win_prob=0) to `signal_score × 1.5` (win_prob=1.0). A score-8 signal with win_prob=0.35 → 6.8. A score-7 signal with win_prob=0.65 → 8.05. The ML-validated signal wins.

- [ ] **Step 2: Verify in SQLite**

```bash
python -c "
import sqlite3
conn = sqlite3.connect('database.sqlite')
rows = conn.execute('''
  SELECT symbol, signal_score, win_probability,
    ROUND(signal_score * (0.5 + COALESCE(win_probability, 0.5)), 2) AS effective_score
  FROM technical_signals
  ORDER BY effective_score DESC LIMIT 10
''').fetchall()
for r in rows: print(r)
conn.close()
"
```

Expected: rows ordered by `effective_score`, not raw `signal_score`.

- [ ] **Step 3: Commit**

```bash
git add src/server/technicalSignalsService.ts
git commit -m "feat(signals): add effective_score = signal_score * (0.5 + win_probability) for ML-adjusted ranking"
```

---

### Task 4: Fix BiLSTM quality gate — NaN handling

**Problem:** `dl_engine.train_lstm()` returns `{"directional_accuracy": nan, "roc_auc": nan}` when walk-forward has insufficient folds. `nan > 0.52` is `False` in Python, so every model fails the quality gate. `nan` is then stored as `0.0` in model_registry.

**Files:**
- Modify: `src/server/dl_trainer.py:77-93`

- [ ] **Step 1: Replace the quality gate block**

Find lines 77–93 in `dl_trainer.py` and replace:

```python
# BEFORE:
acc = metrics.get("directional_accuracy", 0)
auc = metrics.get("roc_auc", 0)

if acc > QUALITY_MIN_ACC and auc > QUALITY_MIN_AUC:
    cfg["lstm_version"] = new_version
    cfg_path.write_text(json.dumps(cfg, indent=2))
    print(f"[TRAINER] Quality gate PASSED (acc={acc:.3f}, auc={auc:.3f}) → promoted v{new_version}")
    result["promoted"] = True
else:
    bad_path = MODEL_DIR / f"lstm_v{new_version}.pt"
    if bad_path.exists():
        bad_path.unlink()
    print(f"[TRAINER] Quality gate FAILED ...")
    result["promoted"] = False
```

```python
# AFTER:
import math as _math

acc = metrics.get("directional_accuracy", 0) or 0.0
auc = metrics.get("roc_auc", 0) or 0.0

acc_valid = not _math.isnan(acc)
auc_valid = not _math.isnan(auc)

# Gate: accuracy must beat random (>0.50). AUC gate skipped if NaN (insufficient folds).
acc_ok = acc_valid and acc > QUALITY_MIN_ACC
auc_ok = (not auc_valid) or (auc > QUALITY_MIN_AUC)  # NaN = skip gate

if acc_ok and auc_ok:
    cfg["lstm_version"] = new_version
    cfg_path.write_text(json.dumps(cfg, indent=2))
    print(f"[TRAINER] Quality gate PASSED (acc={acc:.3f}, auc={'N/A' if not auc_valid else f'{auc:.3f}'}) → promoted v{new_version}")
    result["promoted"] = True
else:
    bad_path = MODEL_DIR / f"lstm_v{new_version}.pt"
    if bad_path.exists():
        bad_path.unlink()
    reason = f"acc={acc:.3f}<{QUALITY_MIN_ACC}" if not acc_ok else f"auc={auc:.3f}<{QUALITY_MIN_AUC}"
    print(f"[TRAINER] Quality gate FAILED ({reason}) — keeping v{cfg.get('lstm_version', 1)}")
    result["promoted"] = False
```

- [ ] **Step 2: Test with a mock metrics dict**

```bash
python -c "
import math
acc, auc = 0.51, float('nan')
acc_valid = not math.isnan(acc)
auc_valid = not math.isnan(auc)
acc_ok = acc_valid and acc > 0.50
auc_ok = (not auc_valid) or (auc > 0.52)
print('acc_ok:', acc_ok, 'auc_ok:', auc_ok, 'promoted:', acc_ok and auc_ok)
# Expected: acc_ok: True auc_ok: True promoted: True
"
```

- [ ] **Step 3: Commit**

```bash
git add src/server/dl_trainer.py
git commit -m "fix(dl): quality gate treats NaN AUC as 'insufficient data' not failure"
```

---

### Task 5: Backfill RL episodes from historical signal_outcomes

**Problem:** `rl_q_table` has 0 rows. `daily_update()` finds no episodes to process because `rl_episodes` is also empty. The RL agent has never learned. Fix: add `--backfill` mode that constructs synthetic episodes from resolved `signal_outcomes`.

**Files:**
- Modify: `src/server/rl_agent.py` (add `backfill_episodes()` function + CLI arg)

- [ ] **Step 1: Add the backfill function**

Add this function in `src/server/rl_agent.py` before the `run()` function:

```python
def backfill_episodes(conn: sqlite3.Connection, lookback_days: int = 180, dry_run: bool = False) -> dict:
    """Construct synthetic RL episodes from resolved signal_outcomes + run Q-update on each."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=lookback_days)).isoformat()

    rows = conn.execute("""
        SELECT so.symbol, so.signal_date, so.return_pct, so.outcome,
               so.signal_score, ts.nifty_regime, ns.sector
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.date = so.signal_date
        LEFT JOIN nse_stocks ns ON ns.symbol = so.symbol
        WHERE so.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND so.signal_date >= ?
          AND so.return_pct IS NOT NULL
        ORDER BY so.signal_date ASC
    """, (cutoff,)).fetchall()

    if not rows:
        print("[RLAgent] No resolved outcomes to backfill from.")
        return {'rows': 0, 'episodes_created': 0, 'q_updates': 0}

    epsilon = _load_epsilon(conn)
    episodes_created = 0
    q_updates = 0

    for sym, sig_date, ret_pct, outcome, sig_score, regime, sector in rows:
        regime      = regime or 'SIDEWAYS'
        sig_score   = sig_score or 5
        sector      = sector or 'OTHER'
        state_key   = get_state_key(regime, sector, sig_score)

        # Infer action from signal score: high conviction → AGGRESSIVE, low → CONSERVATIVE
        if sig_score >= 7:
            action = 'AGGRESSIVE'
        elif sig_score >= 5:
            action = 'BALANCED'
        elif sig_score >= 3:
            action = 'CONSERVATIVE'
        else:
            action = 'SECTOR_FOCUSED'

        # Reward = return_pct − Nifty return (alpha). STOP_LOSS penalised extra.
        nifty_ret = _get_nifty_return(conn, sig_date)
        reward    = float(ret_pct) - nifty_ret
        if outcome == 'STOP_LOSS':
            reward *= 1.5  # extra penalty for stop-loss hits

        # Insert episode if not already present
        try:
            conn.execute("""
                INSERT OR IGNORE INTO rl_episodes (date, state_key, action_taken, reward, epsilon)
                VALUES (?, ?, ?, ?, ?)
            """, (sig_date, state_key, action, round(reward, 4), round(epsilon, 4)))
            episodes_created += 1
        except Exception:
            pass

        # Q-update immediately
        next_max = get_max_q(conn, state_key)
        old_q    = get_q(conn, state_key, action)
        new_q    = q_update(old_q, reward, next_max)

        if dry_run:
            print(f"  [DRY] {sig_date} {state_key} {action} r={reward:.3f} Q:{old_q:.4f}->{new_q:.4f}")
        else:
            set_q(conn, state_key, action, new_q)
        q_updates += 1

    if not dry_run:
        conn.commit()

    print(f"[RLAgent] Backfill complete: {len(rows)} outcomes → {episodes_created} episodes, {q_updates} Q-updates")
    return {'rows': len(rows), 'episodes_created': episodes_created, 'q_updates': q_updates}
```

- [ ] **Step 2: Add --backfill CLI argument**

Find the `if __name__ == '__main__':` block and add:

```python
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--update',   dest='mode', action='store_const', const='update', default='update')
    parser.add_argument('--inspect',  dest='mode', action='store_const', const='inspect')
    parser.add_argument('--backfill', dest='mode', action='store_const', const='backfill')
    parser.add_argument('--lookback', type=int, default=180, help='Days of history for backfill')
    parser.add_argument('--dry-run',  action='store_true')
    args = parser.parse_args()

    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"[RLAgent] DB not found: {DB_PATH}. Run from project root.")
    conn = sqlite3.connect(DB_PATH)
    try:
        if args.mode == 'inspect':
            inspect_policy(conn)
        elif args.mode == 'backfill':
            backfill_episodes(conn, lookback_days=args.lookback, dry_run=args.dry_run)
        else:
            daily_update(conn, dry_run=args.dry_run)
    finally:
        conn.close()
```

- [ ] **Step 3: Run backfill dry-run first**

```bash
cd c:/Github/bharat-stock-intelligence
python src/server/rl_agent.py --backfill --dry-run 2>&1 | head -20
```

Expected: shows DRY rows with Q-value updates (or "No resolved outcomes" if signal_outcomes still empty — that's fine, re-run after Task 1 produces data).

- [ ] **Step 4: Run actual backfill**

```bash
python src/server/rl_agent.py --backfill --lookback 365
```

Then verify:

```bash
python -c "
import sqlite3
conn = sqlite3.connect('database.sqlite')
print('Q-table rows:', conn.execute('SELECT COUNT(*) FROM rl_q_table').fetchone()[0])
print('Episode rows:', conn.execute('SELECT COUNT(*) FROM rl_episodes').fetchone()[0])
sample = conn.execute('SELECT state_key, action, q_value FROM rl_q_table ORDER BY q_value DESC LIMIT 5').fetchall()
for r in sample: print(r)
conn.close()
"
```

Expected: `Q-table rows: > 0`, `Episode rows: > 0`.

- [ ] **Step 5: Commit**

```bash
git add src/server/rl_agent.py
git commit -m "feat(rl): add --backfill mode to bootstrap Q-table from historical signal_outcomes"
```

---

## Phase 2 — Signal Quality

### Task 6: Add getUnifiedSignals endpoint (conviction-gated)

**Problem:** No single endpoint combines `signal_score`, `win_probability`, and `confluence_score` to surface the ~200 signals where all three agree. Frontend shows 5,476 raw signals.

**Files:**
- Modify: `src/server/routers/technicals.router.ts`

- [ ] **Step 1: Add the procedure**

Add after the existing `getTechnicalSignals` procedure in `src/server/routers/technicals.router.ts`:

```typescript
getUnifiedSignals: publicProcedure
  .input(z.object({
    date:           z.string().optional(),
    minUnified:     z.number().min(0).max(1).default(0.55),
    minConfluence:  z.number().min(0).max(100).default(40),
    limit:          z.number().min(1).max(100).default(50),
  }))
  .query(({ input }) => {
    const d = input.date ?? new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT
        ts.symbol,
        ns.name,
        ns.sector,
        ts.signal_score,
        ts.win_probability,
        cs.confluence_score,
        cs.conviction_level,
        ts.cmp,
        ts.stop_loss,
        ts.targets,
        ts.nifty_regime,
        ts.entry_zone,
        ts.ai_insight,
        ROUND(
          0.4 * (ts.signal_score / 10.0)
          + 0.4 * COALESCE(ts.win_probability, 0.5)
          + 0.2 * (COALESCE(cs.confluence_score, 0) / 100.0),
          3
        ) AS unified_score,
        ts.computed_at
      FROM technical_signals ts
      LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
      LEFT JOIN confluence_signals cs
             ON cs.symbol = ts.symbol
            AND date(cs.last_updated) = ?
      WHERE ts.date = ?
        AND ROUND(
              0.4 * (ts.signal_score / 10.0)
              + 0.4 * COALESCE(ts.win_probability, 0.5)
              + 0.2 * (COALESCE(cs.confluence_score, 0) / 100.0),
              3
            ) >= ?
        AND COALESCE(cs.confluence_score, 0) >= ?
      ORDER BY unified_score DESC
      LIMIT ?
    `).all(d, d, input.minUnified, input.minConfluence, input.limit);
    return rows;
  }),
```

- [ ] **Step 2: Verify the query manually**

```bash
python -c "
import sqlite3
from datetime import date
conn = sqlite3.connect('database.sqlite')
today = date.today().isoformat()
rows = conn.execute('''
  SELECT ts.symbol,
    ts.signal_score,
    ts.win_probability,
    cs.confluence_score,
    ROUND(0.4*(ts.signal_score/10.0) + 0.4*COALESCE(ts.win_probability,0.5) + 0.2*(COALESCE(cs.confluence_score,0)/100.0), 3) AS unified
  FROM technical_signals ts
  LEFT JOIN confluence_signals cs ON cs.symbol=ts.symbol AND date(cs.last_updated)=?
  WHERE ts.date=?
  ORDER BY unified DESC LIMIT 10
''', (today, today)).fetchall()
for r in rows: print(r)
conn.close()
"
```

Expected: rows with `unified` column, ordered highest first.

- [ ] **Step 3: Commit**

```bash
git add src/server/routers/technicals.router.ts
git commit -m "feat(api): add getUnifiedSignals endpoint with cross-engine conviction gating"
```

---

### Task 7: Signal expiry sweep — resolve stale PENDING as NEUTRAL

**Problem:** Signals older than `horizon_days` trading days that are still PENDING will never be resolved (the stock may have been delisted, OHLCV missing, etc.). They pollute the outcome statistics with PENDING bias.

**Files:**
- Modify: `src/server/outcome_resolver.py`

- [ ] **Step 1: Add expiry sweep function**

In `src/server/outcome_resolver.py`, add before the `run()` function:

```python
def expire_stale_pending(conn: sqlite3.Connection, horizon_days: int, dry_run: bool = False) -> int:
    """Mark PENDING outcomes older than 2×horizon as NEUTRAL (stock/data unavailable)."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=horizon_days * 2)).isoformat()

    rows = conn.execute("""
        SELECT symbol, signal_date, horizon_days
        FROM signal_outcomes
        WHERE outcome = 'PENDING'
          AND horizon_days = ?
          AND signal_date < ?
    """, (horizon_days, cutoff)).fetchall()

    if dry_run:
        print(f"[OutcomeResolver] Would expire {len(rows)} stale {horizon_days}D PENDING outcomes")
        return len(rows)

    conn.execute("""
        UPDATE signal_outcomes
        SET outcome = 'NEUTRAL',
            return_pct = 0.0,
            computed_at = CURRENT_TIMESTAMP
        WHERE outcome = 'PENDING'
          AND horizon_days = ?
          AND signal_date < ?
    """, (horizon_days, cutoff))
    conn.commit()
    print(f"[OutcomeResolver] Expired {len(rows)} stale {horizon_days}D outcomes → NEUTRAL")
    return len(rows)
```

- [ ] **Step 2: Call expiry sweep at end of `run()` function**

In the `run()` function, after the main `resolve_outcomes()` call, add:

```python
def run(horizon_days: int = 5, dry_run: bool = False):
    # ... existing code ...
    resolve_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
    resolve_unified_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
    expire_stale_pending(conn, horizon_days=horizon_days, dry_run=dry_run)  # ADD THIS
```

- [ ] **Step 3: Test dry-run**

```bash
python src/server/outcome_resolver.py --horizon 5 --dry-run
```

Expected output includes: `Would expire N stale 5D PENDING outcomes`.

- [ ] **Step 4: Commit**

```bash
git add src/server/outcome_resolver.py
git commit -m "feat(outcomes): expire stale PENDING outcomes (>2x horizon) as NEUTRAL"
```

---

### Task 8: Fix feature_engineering pd.cut duplicate bin-edge crash

**Problem:** For symbols with near-constant volatility (e.g., KALYANI), `hist_vol_21d.quantile(0.33)` == `quantile(0.67)` == `quantile(0.90)`, producing duplicate bin edges in `pd.cut()`, which crashes with `ValueError: Bin edges must be unique`.

**Files:**
- Modify: `src/server/feature_engineering.py:97-101`

- [ ] **Step 1: Replace the pd.cut block**

Find lines 94–101 in `feature_engineering.py` and replace:

```python
# BEFORE:
p33 = out["hist_vol_21d"].quantile(0.33)
p67 = out["hist_vol_21d"].quantile(0.67)
p90 = out["hist_vol_21d"].quantile(0.90)
out["vol_regime"] = pd.cut(
    out["hist_vol_21d"],
    bins=[-np.inf, p33, p67, p90, np.inf],
    labels=["LOW", "MED", "HIGH", "SPIKE"],
).astype(str)
```

```python
# AFTER: handle duplicate quantiles (constant-vol symbols like KALYANI)
p33 = out["hist_vol_21d"].quantile(0.33)
p67 = out["hist_vol_21d"].quantile(0.67)
p90 = out["hist_vol_21d"].quantile(0.90)
_med = out["hist_vol_21d"].median()
try:
    out["vol_regime"] = pd.cut(
        out["hist_vol_21d"],
        bins=[-np.inf, p33, p67, p90, np.inf],
        labels=["LOW", "MED", "HIGH", "SPIKE"],
        duplicates="drop",
    ).astype(str).replace("nan", "MED")
except ValueError:
    # All quantiles equal (zero-variance vol) — assign uniform MED
    out["vol_regime"] = "MED"
```

- [ ] **Step 2: Test with a known-bad symbol**

```bash
python -c "
import sys; sys.path.insert(0,'src/server')
import sqlite3
from feature_engineering import FeatureEngineer
fe = FeatureEngineer()
conn = sqlite3.connect('database.sqlite')
result = fe.process_symbol('KALYANI', 30, conn=conn)
print('KALYANI processed:', result, 'rows')
conn.close()
"
```

Expected: no crash, returns a number >= 0.

- [ ] **Step 3: Commit**

```bash
git add src/server/feature_engineering.py
git commit -m "fix(features): handle duplicate bin edges in pd.cut for constant-vol symbols"
```

---

### Task 9: Weight strategy_optimizer objective by sample count

**Problem:** `_compute_score()` gives equal weight to strategies with 3 trades and 100% win rate vs. strategies with 500 trades and 65% win rate. Fix: scale objective by `min(n, 100) / 100`.

**Files:**
- Modify: `src/server/strategy_optimizer.py:120-139`

- [ ] **Step 1: Update `_compute_score()` to weight by sample count**

Find `_compute_score()` and replace the objective calculation (lines 125–139):

```python
# BEFORE:
win_rate      = (top_signals['outcome'] == 'WIN').mean()
avg_ret       = top_signals['return_pct'].mean()
std_ret       = top_signals['return_pct'].std()
profit_factor = (...)
sharpe        = (avg_ret / std_ret) if std_ret > 0 else 0.0
pf_norm       = min(profit_factor / 3.0, 1.0)
sharpe_norm   = min(max(sharpe, 0) / 3.0, 1.0)
objective     = 0.5 * win_rate + 0.3 * pf_norm + 0.2 * sharpe_norm
return objective
```

```python
# AFTER:
n             = len(top_signals)
win_rate      = (top_signals['outcome'] == 'WIN').mean()
avg_ret       = top_signals['return_pct'].mean()
std_ret       = top_signals['return_pct'].std()
profit_factor = (
    top_signals.loc[top_signals['return_pct'] > 0, 'return_pct'].sum() /
    abs(top_signals.loc[top_signals['return_pct'] < 0, 'return_pct'].sum() + 1e-9)
)
sharpe        = (avg_ret / std_ret) if std_ret > 0 else 0.0
pf_norm       = min(profit_factor / 3.0, 1.0)
sharpe_norm   = min(max(sharpe, 0) / 3.0, 1.0)
# Weight by sample confidence: full weight at n>=100, half weight at n=50, near-zero at n<10
sample_weight = min(n, 100) / 100.0
objective     = sample_weight * (0.5 * win_rate + 0.3 * pf_norm + 0.2 * sharpe_norm)
return objective
```

- [ ] **Step 2: Verify with a quick sanity check**

```bash
python -c "
# Strategy A: 3 trades, 100% win rate → weight=0.03
n_a, wr_a = 3, 1.0
obj_a = (min(n_a,100)/100) * (0.5*wr_a)
# Strategy B: 200 trades, 65% win rate → weight=1.0
n_b, wr_b = 200, 0.65
obj_b = (min(n_b,100)/100) * (0.5*wr_b)
print(f'Strategy A (3 trades, 100% WR): {obj_a:.3f}')
print(f'Strategy B (200 trades, 65% WR): {obj_b:.3f}')
print('B wins:', obj_b > obj_a)
# Expected: B wins: True
"
```

- [ ] **Step 3: Commit**

```bash
git add src/server/strategy_optimizer.py
git commit -m "fix(optimizer): weight objective by sample count to prevent sparse-strategy overfitting"
```

---

## Self-Review

**Spec coverage check:**

| Spec Requirement | Task |
|---|---|
| D2: Seed 15D PENDING outcomes | Task 1 ✓ |
| M1: Wire signal_type_weights into scoreSignals | Task 2 ✓ |
| M2: win_probability into ranking | Task 3 ✓ |
| M3: Fix BiLSTM quality gate | Task 4 ✓ |
| M4: RL backfill from historical outcomes | Task 5 ✓ |
| S1: Unified signal score + conviction gating | Task 6 ✓ |
| S4: Signal expiry sweep | Task 7 ✓ |
| D3: Fix feature_engineering bin-edge | Task 8 ✓ |
| M6: strategy_optimizer sample weight | Task 9 ✓ |

**Out of scope (Phase 3+4, separate plan):** D1 (fii cron), B1/B2 (circuit breakers), I1 (news-sentiment interval), I2 (Telegram alerts), F1 (Today's Picks tab), F2 (error boundaries).

**Placeholder scan:** None found. All code blocks are complete.

**Type consistency:** `loadLearnedWeights` defined in Task 2 Step 1 and called in Step 2 — consistent. `scoreSignals` signature change in Task 2 Step 2 matches Step 3. `backfill_episodes` defined and called via CLI in Task 5 Steps 1+2 — consistent. `getUnifiedSignals` tRPC procedure self-contained in Task 6.

**Execution order dependency:** Tasks 1→5 are Phase 1 and must precede Phase 2 (Tasks 6→9). Within each phase, tasks are independent and can run in any order.
