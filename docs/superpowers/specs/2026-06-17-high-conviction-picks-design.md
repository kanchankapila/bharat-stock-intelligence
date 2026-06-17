# High Conviction Picks Page — Design Spec

**Date:** 2026-06-17  
**Route:** `/best-picks`  
**Status:** Approved

---

## Overview

A new dedicated page that surfaces the 3–10 highest-quality trade setups passing all four empirically-validated gates simultaneously. Based on live `strategy_performance` data showing RSI_DIVERGENCE achieves 78% win rate (Sharpe 9.1) and EMA_BULL_STACK 65% at scale, with quant quality filters restricting the universe to Piotroski ≥ 7 stocks above SMA200.

---

## Backend

### New tRPC Procedure: `getBestComboSignals`

**File:** `src/server/routers/scoring.router.ts`

**Input:**
```typescript
z.object({
  limit: z.number().min(1).max(50).default(20),
  requireUnifiedRec: z.boolean().default(false),
})
```

**Gate logic (all AND):**

| Gate | Table | Condition |
|---|---|---|
| 1. Regime | `market_regimes` | `regime IN ('BULL', 'SIDEWAYS')` — if BEAR, return early with `{ regime, stocks: [], reason: 'BEAR regime — gates closed' }` |
| 2. Signal type | `signal_outcomes` | `signals_json LIKE '%RSI_DIVERGENCE%' AND signals_json LIKE '%EMA_BULL_STACK%'` AND `signal_score >= 7` AND `outcome IN ('WIN', 'PENDING')` |
| 3. Quant quality | `quant_scores` | `piotroski_f_score >= 7 AND above_sma200 = 1 AND sharpe_ratio > 1.0` |
| 4. Sector | `nse_stocks` | `sector IN ('Financials','Healthcare','Industrials','Materials','Energy')` |

Optional gate (when `requireUnifiedRec = true`): `unified_recommendations.conviction_level IN ('A_HIGH','B_MEDIUM')`

**JOINs:**
- `INNER JOIN quant_scores qs ON qs.symbol = so.symbol`
- `INNER JOIN nse_stocks ns ON ns.symbol = so.symbol`
- `LEFT JOIN unified_recommendations ur ON ur.symbol = so.symbol AND ur.computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)`

**Selected columns:** symbol, name, sector, signal_score, entry_price, signals_json, piotroski_f_score, sharpe_ratio, rank_composite, bullish_screener_count, return_12m, conviction_level, avg_engine_track_record, stop_loss (from ur, fallback entry×0.95), target_1 (from ur, fallback entry×1.12)

**ORDER BY:** `COALESCE(ur.avg_engine_track_record, 1.0) DESC, qs.rank_composite DESC`

**GROUP BY:** `so.symbol` (deduplicate — one entry per stock)

**Return shape:**
```typescript
{
  regime: string;
  reason: string;
  stocks: Array<{
    symbol: string; name: string; sector: string;
    signalScore: number; entryPrice: number;
    signalTypes: string[];         // parsed from signals_json
    piotroski: number; sharpeRatio: number;
    rankComposite: number; bullishScreenerCount: number;
    return12m: number;
    convictionLevel: string | null;
    avgTrackRecord: number | null;
    stopLoss: number; target: number;
    rrRatio: number;               // (target - entry) / (entry - stopLoss)
  }>;
}
```

`signalTypes` is parsed server-side from `signals_json` (extract all `type` fields).  
`rrRatio` is computed server-side.

**No caching** — query is fast (indexed columns). Frontend uses `refetchInterval: 5 * 60_000`.

---

## Frontend

### New Component: `HighConvictionPage`

**File:** `src/components/HighConvictionPage.tsx`  
**Export:** named export `HighConvictionPage`

#### Page Layout

```
[Header]
  Regime badge | "N high-conviction setups" | last-computed | Refresh button

[Bear state] (if regime = BEAR)
  Full-width warning: "BEAR regime — all gates closed. No new positions."

[Empty state] (BULL/SIDEWAYS but 0 results)
  "No setups pass all 4 gates right now. Check back after market close."

[Card grid]
  CSS grid, 3 columns on lg, 2 on md, 1 on sm
  One HighConvictionCard per stock
```

#### `HighConvictionCard` Layout

```
┌─────────────────────────────────────────┐
│ SYMBOL         [Sector]  [A_HIGH badge] │
│ Full Company Name                       │
├─────────────────────────────────────────┤
│ [RSI_DIVERGENCE] [EMA_BULL_STACK]  ★7/10│
├─────────────────────────────────────────┤
│ Entry    Stop-loss   Target    R:R       │
│ ₹1234    ₹1172 (-5%) ₹1382(+12%) 2.4x  │
├─────────────────────────────────────────┤
│ Piotroski  Sharpe  Rank  Screeners 12M  │
│ 8/9        1.56    99.7  103 📈  +93%   │
├─────────────────────────────────────────┤
│ RSI divergence · bull stack · P8 · 103  │
│ screeners · Sharpe 1.56                 │
└─────────────────────────────────────────┘
```

**Conviction badge colours:**
- `A_HIGH` → amber/gold border + text
- `B_MEDIUM` → blue border + text
- no row → slate (no unified rec)

**Signal type pills:** `RSI_DIVERGENCE` = emerald, `EMA_BULL_STACK` = sky, others = slate

**R:R ratio colour:** ≥ 2.0 = emerald, 1.0–1.9 = amber, < 1.0 = rose

**Click handler:** calls `onSelectStock(symbol)` to open the global stock drawer

#### Props

```typescript
interface HighConvictionPageProps {
  onSelectStock: (symbol: string) => void;
}
```

---

## Routing & Navigation

### `App.tsx`

Add lazy import:
```typescript
const HighConvictionPage = React.lazy(() =>
  import('./components/HighConvictionPage').then(m => ({ default: m.HighConvictionPage }))
);
```

Add route in **both** route blocks (desktop + mobile):
```tsx
<Route path="/best-picks" element={<HighConvictionPage onSelectStock={(s) => setDrawerSymbol(s)} />} />
```

### `AppShell.tsx`

Add to the **Tools** nav group (alongside Trade Cockpit, AI Chat):
```typescript
{ path: '/best-picks', label: 'Best Picks', icon: Crosshair }
```

Import `Crosshair` from `lucide-react`.

---

## Data Flow

```
User loads /best-picks
  → HighConvictionPage mounts
  → trpc.getBestComboSignals.useQuery({ limit: 20 }, { refetchInterval: 300_000 })
  → scoring.router.ts: getBestComboSignals
      → check market_regimes (regime gate)
      → JOIN signal_outcomes + quant_scores + nse_stocks + unified_recommendations
      → return { regime, stocks, reason }
  → render regime badge + card grid
  → click card → onSelectStock(symbol) → global drawer opens
```

---

## Out of Scope

- Filtering/sorting controls on the page (can be added later)
- Alerting / notifications when new picks appear
- Backtesting the 4-gate combo historically (separate feature)
- The `requireUnifiedRec` toggle is backend-only for now; no UI toggle
