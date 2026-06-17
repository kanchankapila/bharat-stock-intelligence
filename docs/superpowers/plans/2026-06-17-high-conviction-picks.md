# High Conviction Picks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/best-picks` page that surfaces stocks passing all 4 empirical gates simultaneously: BULL/SIDEWAYS regime + RSI_DIVERGENCE + EMA_BULL_STACK signals + Piotroski ≥ 7 / above SMA200 / Sharpe > 1.0 + proven sectors.

**Architecture:** One new tRPC procedure (`getBestComboSignals`) added to the scoring router executes a CTE SQL query across 4 tables; the new `HighConvictionPage` component queries it and renders a card grid; App.tsx and AppShell.tsx wire up the route and nav item.

**Tech Stack:** TypeScript, better-sqlite3, tRPC v10, React 19, Tailwind CSS, lucide-react

## Global Constraints

- Do NOT add comments unless the WHY is non-obvious
- Do NOT add error handling for impossible scenarios
- Follow existing glass/glass-strong Tailwind patterns from AppShell and CommandCenterDashboard
- Database file: `database.sqlite` at project root (resolved by `db.ts` — do not hardcode)
- All prices displayed in Indian Rupee format `₹X,XX,XXX`
- `refetchInterval` for the query: `5 * 60_000` ms

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/server/routers/scoring.router.ts` | Add `getBestComboSignals` procedure |
| Create | `src/components/HighConvictionPage.tsx` | Page + card components |
| Modify | `src/App.tsx` | Lazy import + 2 route entries (desktop + mobile) |
| Modify | `src/components/AppShell.tsx` | `Crosshair` import + Intelligence group nav item |

---

## Task 1: Backend — `getBestComboSignals` tRPC procedure

**Files:**
- Modify: `src/server/routers/scoring.router.ts` (append after `getStrategyPicks` at line ~170)

**Interfaces:**
- Consumes: `db` (better-sqlite3 instance), `market_regimes`, `signal_outcomes`, `quant_scores`, `nse_stocks`, `unified_recommendations` tables
- Produces: `getBestComboSignals` — input `{ limit: number, requireUnifiedRec: boolean }`, returns `{ regime, reason, stocks: ComboStock[] }`

**Return type produced for later tasks:**
```typescript
interface ComboStock {
  symbol: string; name: string; sector: string;
  signalScore: number; entryPrice: number; signalTypes: string[];
  piotroski: number; sharpeRatio: number; rankComposite: number;
  bullishScreenerCount: number; return12m: number;
  convictionLevel: string | null; avgTrackRecord: number | null;
  stopLoss: number; target: number; rrRatio: number;
}
```

- [ ] **Step 1: Verify the SQL returns rows**

Run this Python script from the project root to confirm the query works before writing TypeScript:

```python
# scripts/verify_best_picks_sql.py
import sqlite3, json

conn = sqlite3.connect("database.sqlite")
cur = conn.cursor()
cur.execute("""
  SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1
""")
row = cur.fetchone()
print("Regime:", row)

cur.execute("""
  WITH ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (
        PARTITION BY symbol ORDER BY signal_date DESC, signal_score DESC
      ) AS rn
    FROM signal_outcomes
    WHERE outcome IN ('WIN','PENDING')
      AND signal_score >= 7
      AND signals_json LIKE '%RSI_DIVERGENCE%'
      AND signals_json LIKE '%EMA_BULL_STACK%'
  )
  SELECT
    r.symbol, ns.name, ns.sector,
    r.signal_score, r.entry_price, r.signals_json,
    qs.piotroski_f_score, qs.sharpe_ratio, qs.rank_composite,
    qs.bullish_screener_count, qs.return_12m,
    ur.conviction_level, ur.avg_engine_track_record,
    COALESCE(ur.stop_loss, r.entry_price * 0.95) AS stop_loss,
    COALESCE(ur.target_1,  r.entry_price * 1.12) AS target
  FROM ranked r
  JOIN quant_scores qs ON qs.symbol = r.symbol
  JOIN nse_stocks ns ON ns.symbol = r.symbol
  LEFT JOIN unified_recommendations ur
    ON ur.symbol = r.symbol
    AND ur.computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
  WHERE r.rn = 1
    AND qs.piotroski_f_score >= 7
    AND qs.above_sma200 = 1
    AND qs.sharpe_ratio > 1.0
    AND ns.sector IN ('Financials','Healthcare','Industrials','Materials','Energy')
  ORDER BY COALESCE(ur.avg_engine_track_record, 1.0) DESC, qs.rank_composite DESC
  LIMIT 20
""")
rows = cur.fetchall()
print(f"Rows returned: {len(rows)}")
for r in rows[:5]:
    print(r[0], r[2], "P:", r[6], "Sharpe:", round(r[7],2))
conn.close()
```

Run: `python scripts/verify_best_picks_sql.py`

Expected: prints regime + at least 1 row. If 0 rows, the filters are too tight for the current data — widen `signal_score >= 5` and check.

- [ ] **Step 2: Add the procedure to scoring.router.ts**

Open `src/server/routers/scoring.router.ts`. After the closing `}),` of the `getStrategyPicks` procedure (around line 170), add this before the final `});`:

```typescript
  getBestComboSignals: publicProcedure
    .input(z.object({
      limit: z.number().min(1).max(50).default(20),
      requireUnifiedRec: z.boolean().default(false),
    }))
    .query(({ input }) => {
      const regimeRow = db.prepare(
        'SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1'
      ).get() as { regime: string } | undefined;
      const regime = regimeRow?.regime ?? 'UNKNOWN';

      if (!['BULL', 'SIDEWAYS'].includes(regime)) {
        return { regime, reason: 'BEAR regime — gates closed', stocks: [] };
      }

      const urFilter = input.requireUnifiedRec
        ? `AND ur.conviction_level IN ('A_HIGH','B_MEDIUM')`
        : '';

      const rows = db.prepare(`
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY symbol ORDER BY signal_date DESC, signal_score DESC
            ) AS rn
          FROM signal_outcomes
          WHERE outcome IN ('WIN','PENDING')
            AND signal_score >= 7
            AND signals_json LIKE '%RSI_DIVERGENCE%'
            AND signals_json LIKE '%EMA_BULL_STACK%'
        )
        SELECT
          r.symbol, ns.name, ns.sector,
          r.signal_score, r.entry_price, r.signals_json,
          qs.piotroski_f_score, qs.sharpe_ratio, qs.rank_composite,
          qs.bullish_screener_count, qs.return_12m,
          ur.conviction_level, ur.avg_engine_track_record,
          COALESCE(ur.stop_loss, r.entry_price * 0.95) AS stop_loss,
          COALESCE(ur.target_1,  r.entry_price * 1.12) AS target
        FROM ranked r
        JOIN quant_scores qs ON qs.symbol = r.symbol
        JOIN nse_stocks ns ON ns.symbol = r.symbol
        LEFT JOIN unified_recommendations ur
          ON ur.symbol = r.symbol
          AND ur.computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
        WHERE r.rn = 1
          AND qs.piotroski_f_score >= 7
          AND qs.above_sma200 = 1
          AND qs.sharpe_ratio > 1.0
          AND ns.sector IN ('Financials','Healthcare','Industrials','Materials','Energy')
          ${urFilter}
        ORDER BY COALESCE(ur.avg_engine_track_record, 1.0) DESC, qs.rank_composite DESC
        LIMIT ?
      `).all(input.limit) as any[];

      const stocks = rows.map(row => {
        const signalTypes: string[] = [];
        try {
          (JSON.parse(row.signals_json ?? '[]') as any[])
            .forEach(s => { if (s.type) signalTypes.push(s.type as string); });
        } catch { /* malformed json — skip */ }

        const entry  = (row.entry_price as number) ?? 0;
        const stop   = (row.stop_loss as number)   ?? entry * 0.95;
        const target = (row.target as number)       ?? entry * 1.12;
        const rrRatio = entry > 0 && stop < entry
          ? parseFloat(((target - entry) / (entry - stop)).toFixed(2))
          : 0;

        return {
          symbol:               row.symbol as string,
          name:                 (row.name as string) ?? row.symbol,
          sector:               (row.sector as string) ?? 'Unknown',
          signalScore:          (row.signal_score as number) ?? 0,
          entryPrice:           parseFloat((entry).toFixed(2)),
          signalTypes,
          piotroski:            (row.piotroski_f_score as number) ?? 0,
          sharpeRatio:          parseFloat(((row.sharpe_ratio as number) ?? 0).toFixed(2)),
          rankComposite:        parseFloat(((row.rank_composite as number) ?? 0).toFixed(1)),
          bullishScreenerCount: (row.bullish_screener_count as number) ?? 0,
          return12m:            parseFloat(((row.return_12m as number) ?? 0).toFixed(1)),
          convictionLevel:      (row.conviction_level as string) ?? null,
          avgTrackRecord:       row.avg_engine_track_record != null
                                  ? parseFloat((row.avg_engine_track_record as number).toFixed(3))
                                  : null,
          stopLoss:  parseFloat(stop.toFixed(2)),
          target:    parseFloat(target.toFixed(2)),
          rrRatio,
        };
      });

      return { regime, reason: `${stocks.length} setups pass all 4 gates`, stocks };
    }),
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: no errors. If you see "Property 'getBestComboSignals' does not exist", the router merge in `server.ts` / `router.ts` needs the scoring router — check that `scoringRouter` is already merged there (it should be, since `getStrategyStocks` already works).

- [ ] **Step 4: Commit**

```bash
git add src/server/routers/scoring.router.ts scripts/verify_best_picks_sql.py
git commit -m "feat(scoring): add getBestComboSignals 4-gate filter procedure"
```

---

## Task 2: Frontend — `HighConvictionPage` component

**Files:**
- Create: `src/components/HighConvictionPage.tsx`

**Interfaces:**
- Consumes: `trpc.getBestComboSignals` → `{ regime, reason, stocks: ComboStock[] }` (shape defined in Task 1)
- Produces: named export `HighConvictionPage` with prop `{ onSelectStock: (s: string) => void }`

- [ ] **Step 1: Create the component file**

Create `src/components/HighConvictionPage.tsx` with this full content:

```tsx
import React from 'react';
import { RefreshCw, Crosshair, Target, AlertTriangle } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ComboStock {
  symbol: string; name: string; sector: string;
  signalScore: number; entryPrice: number; signalTypes: string[];
  piotroski: number; sharpeRatio: number; rankComposite: number;
  bullishScreenerCount: number; return12m: number;
  convictionLevel: string | null; avgTrackRecord: number | null;
  stopLoss: number; target: number; rrRatio: number;
}

interface ComboResult {
  regime: string; reason: string; stocks: ComboStock[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 1) {
  return isNaN(n) ? '—' : n.toFixed(dec);
}

function fmtPrice(n: number) {
  return n > 0
    ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    : '—';
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function RegimeBadge({ regime }: { regime: string }) {
  const style =
    regime === 'BULL'     ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
    regime === 'SIDEWAYS' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                            'bg-rose-500/20 text-rose-400 border-rose-500/30';
  return (
    <span className={cn('text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border', style)}>
      {regime}
    </span>
  );
}

function ConvictionBadge({ level }: { level: string | null }) {
  if (!level) return null;
  const style =
    level === 'A_HIGH'
      ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
      : 'bg-blue-500/20 text-blue-300 border-blue-500/30';
  return (
    <span className={cn('text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border', style)}>
      {level.replace('_', ' ')}
    </span>
  );
}

function SignalPill({ type }: { type: string }) {
  const style =
    type === 'RSI_DIVERGENCE'  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
    type === 'EMA_BULL_STACK'  ? 'bg-sky-500/20 text-sky-400 border-sky-500/30' :
    type === 'NR7_COMPRESSION' ? 'bg-violet-500/20 text-violet-400 border-violet-500/30' :
                                  'bg-slate-700/60 text-slate-400 border-slate-600';
  return (
    <span className={cn('text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border', style)}>
      {type.replace(/_/g, ' ')}
    </span>
  );
}

function MetricCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="text-center">
      <div className={cn('text-sm font-black', color ?? 'text-white')}>{value}</div>
      <div className="text-[9px] text-slate-600 uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  );
}

function HighConvictionCard({
  stock,
  onSelectStock,
}: {
  stock: ComboStock;
  onSelectStock: (s: string) => void;
}) {
  const rrColor =
    stock.rrRatio >= 2 ? 'text-emerald-400' :
    stock.rrRatio >= 1 ? 'text-amber-400'   : 'text-rose-400';

  const retColor = stock.return12m >= 0 ? 'text-emerald-400' : 'text-rose-400';

  const oneLineReason = [
    'RSI div + bull stack',
    `Piotroski ${stock.piotroski}/9`,
    `${stock.bullishScreenerCount} screeners`,
    `Sharpe ${fmt(stock.sharpeRatio)}`,
  ].join(' · ');

  return (
    <div
      className="glass border border-slate-800/50 rounded-2xl p-5 cursor-pointer hover:border-slate-600/60 transition-all flex flex-col gap-4"
      onClick={() => onSelectStock(stock.symbol)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xl font-black text-white tracking-tighter">{stock.symbol}</span>
            <span className="text-[10px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded-full shrink-0">
              {stock.sector}
            </span>
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 truncate">{stock.name}</div>
        </div>
        <ConvictionBadge level={stock.convictionLevel} />
      </div>

      {/* Signal pills + score */}
      <div className="flex flex-wrap items-center gap-1.5">
        {stock.signalTypes.map(t => <SignalPill key={t} type={t} />)}
        <span className="ml-auto text-[10px] text-slate-500 font-bold shrink-0">
          ★ {stock.signalScore}/10
        </span>
      </div>

      {/* Trading levels */}
      <div className="grid grid-cols-4 gap-2 bg-slate-900/40 rounded-xl p-3">
        <div className="text-center">
          <div className="text-xs font-black text-white">{fmtPrice(stock.entryPrice)}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Entry</div>
        </div>
        <div className="text-center">
          <div className="text-xs font-black text-rose-400">{fmtPrice(stock.stopLoss)}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Stop</div>
        </div>
        <div className="text-center">
          <div className="text-xs font-black text-emerald-400">{fmtPrice(stock.target)}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Target</div>
        </div>
        <div className="text-center">
          <div className={cn('text-xs font-black', rrColor)}>{fmt(stock.rrRatio)}x</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">R:R</div>
        </div>
      </div>

      {/* Score metrics */}
      <div className="grid grid-cols-5 gap-1">
        <MetricCell
          label="Piotroski"
          value={`${stock.piotroski}/9`}
          color={stock.piotroski >= 7 ? 'text-emerald-400' : 'text-amber-400'}
        />
        <MetricCell
          label="Sharpe"
          value={fmt(stock.sharpeRatio)}
          color={stock.sharpeRatio >= 1.5 ? 'text-emerald-400' : 'text-amber-400'}
        />
        <MetricCell label="Rank" value={`${fmt(stock.rankComposite)}%`} color="text-sky-400" />
        <MetricCell label="Screeners" value={String(stock.bullishScreenerCount)} color="text-violet-400" />
        <MetricCell
          label="12M Ret"
          value={`${fmt(stock.return12m)}%`}
          color={retColor}
        />
      </div>

      {/* One-line reason footer */}
      <div className="text-[10px] text-slate-500 border-t border-slate-800/50 pt-3 leading-relaxed">
        {oneLineReason}
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function HighConvictionPage({
  onSelectStock,
}: {
  onSelectStock: (s: string) => void;
}) {
  const { data, isLoading, refetch, isRefetching } = trpc.getBestComboSignals.useQuery(
    { limit: 20 },
    { refetchInterval: 5 * 60_000 },
  );

  const result = data as ComboResult | undefined;
  const isBear  = result?.regime === 'BEAR';
  const isEmpty = !isLoading && result && result.stocks.length === 0 && !isBear;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Crosshair className="w-5 h-5 text-amber-400" />
          <div>
            <h1 className="text-xl font-black text-white italic uppercase tracking-tighter">
              Best Picks
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              4-gate filter · RSI Divergence + EMA Bull Stack · Piotroski ≥7 · Proven sectors
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {result && <RegimeBadge regime={result.regime} />}
          <span className="text-[10px] text-slate-500">
            {result?.stocks.length ?? 0} setups
          </span>
          <button
            onClick={() => refetch()}
            disabled={isRefetching || isLoading}
            className="p-2 glass-strong border border-slate-800/50 rounded-xl text-slate-400 hover:text-white transition-all disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', (isRefetching || isLoading) && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="glass border border-slate-800/50 rounded-2xl p-5 h-64 animate-pulse" />
          ))}
        </div>
      )}

      {/* Bear regime */}
      {!isLoading && isBear && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <AlertTriangle className="w-10 h-10 text-rose-400" />
          <h2 className="text-lg font-black text-white uppercase tracking-tighter">
            BEAR Regime — Gates Closed
          </h2>
          <p className="text-sm text-slate-500 text-center max-w-sm">
            No new positions. All 4 gates require BULL or SIDEWAYS market regime.
            Check back when conditions improve.
          </p>
        </div>
      )}

      {/* Empty (BULL/SIDEWAYS, 0 results) */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Target className="w-10 h-10 text-slate-600" />
          <h2 className="text-lg font-black text-white uppercase tracking-tighter">
            No Setups Right Now
          </h2>
          <p className="text-sm text-slate-500 text-center max-w-sm">
            No stocks pass all 4 gates simultaneously. Check back after market close
            once the signal scanner and quant scoring have run.
          </p>
        </div>
      )}

      {/* Card grid */}
      {!isLoading && !isBear && result && result.stocks.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {result.stocks.map(stock => (
            <HighConvictionCard
              key={stock.symbol}
              stock={stock}
              onSelectStock={onSelectStock}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: no errors. Common issue: if `trpc.getBestComboSignals` shows "does not exist on type", the tRPC client infers types lazily — ensure the server restarted or run a full tsc.

- [ ] **Step 3: Commit**

```bash
git add src/components/HighConvictionPage.tsx
git commit -m "feat(ui): add HighConvictionPage component with 4-gate card grid"
```

---

## Task 3: Route + Navigation wiring

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`

**Interfaces:**
- Consumes: `HighConvictionPage` named export from `./components/HighConvictionPage`
- Produces: `/best-picks` route live in both route blocks; "Best Picks" nav item in Intelligence group

- [ ] **Step 1: Add lazy import to App.tsx**

In `src/App.tsx`, find the block of named-export lazy wrappers (around line 89–95, where `StrategyIntelligence` is imported). Add after the `StrategyIntelligence` line:

```typescript
const HighConvictionPage = React.lazy(() =>
  import('./components/HighConvictionPage').then(m => ({ default: m.HighConvictionPage }))
);
```

- [ ] **Step 2: Add route to the desktop route block**

In `src/App.tsx`, find the first route block (desktop, around line 3780–3810). Find:
```tsx
<Route path="/strategy" element={<StrategyIntelligence onSelectStock={(s) => setDrawerSymbol(s)} />} />
```
Add immediately after it:
```tsx
<Route path="/best-picks" element={<HighConvictionPage onSelectStock={(s) => setDrawerSymbol(s)} />} />
```

- [ ] **Step 3: Add route to the mobile route block**

In `src/App.tsx`, find the second route block (mobile, around line 3939). Find:
```tsx
<Route path="/strategy" element={<StrategyIntelligence onSelectStock={(s) => setDrawerSymbol(s)} />} />
```
Add immediately after it:
```tsx
<Route path="/best-picks" element={<HighConvictionPage onSelectStock={(s) => setDrawerSymbol(s)} />} />
```

- [ ] **Step 4: Add Crosshair import to AppShell.tsx**

In `src/components/AppShell.tsx`, find the lucide-react import block (line 3–9). Add `Crosshair` to the import list. The line currently starts with:
```typescript
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
```
Change to:
```typescript
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
  Crosshair,
```

- [ ] **Step 5: Add nav item to Intelligence group**

In `src/components/AppShell.tsx`, find the Intelligence group items array (around line 49–66). Find:
```typescript
      { icon: Sparkles, label: 'Trade Cockpit',        id: 'trade-cockpit'        },
```
Add immediately after it:
```typescript
      { icon: Crosshair, label: 'Best Picks',          id: 'best-picks'           },
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: no errors.

- [ ] **Step 7: Start dev server and verify the page loads**

Run: `npm run dev` (or `npm start`) then open `http://localhost:3000/best-picks`

Expected:
- "Best Picks" appears in the Intelligence nav group between "Trade Cockpit" and "Signal Intel"
- Page loads with header showing regime badge + "N setups"
- If stocks exist, card grid renders with Entry / Stop / Target / R:R levels
- Clicking a card opens the global stock drawer

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/components/AppShell.tsx
git commit -m "feat(nav): wire /best-picks route and Intelligence nav item"
```

---

## Self-Review Checklist

- [x] All 4 spec sections covered: backend procedure ✓, card layout ✓, page states (loading/bear/empty/cards) ✓, nav wiring ✓
- [x] No TBDs or placeholders — all code is complete and runnable
- [x] Type names consistent: `ComboStock`, `ComboResult` used identically in Task 1 return shape and Task 2 interface
- [x] `getBestComboSignals` spelled identically in Task 1 (procedure name) and Task 2 (`trpc.getBestComboSignals`)
- [x] Both route blocks updated (desktop line ~3803, mobile line ~3939)
- [x] `Crosshair` imported before use in NAV_GROUPS
- [x] `return_12m` from `quant_scores` is already a percentage value (e.g. 93.13 = 93.13%) — displayed as-is with `%`
- [x] `signal_score` max is 10 in observed data; threshold `>= 7` is correct
