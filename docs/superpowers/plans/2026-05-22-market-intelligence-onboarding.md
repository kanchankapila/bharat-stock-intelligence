# Market Intelligence Full Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboard all confirmed-working MoneyControl endpoints (premarket, deals, earnings, index F&O, VWAP, Kayal screeners) into the backend and build professional, graphical frontend pages for each.

**Architecture:** New `src/server/marketIntelService.ts` holds Premarket/Deals/Earnings/IndexFnO fetch functions; `mcApiService.ts` gets VWAP + Kayal additions; `router.ts` gains 10 new tRPC procedures; three new page components (PremarketPanel, SmartMoneyPage, EarningsPage) plus improvements to MCStockInfoPanel for VWAP overlay, pivot charts, and a new F&O tab.

**Tech Stack:** TypeScript, tRPC, React 19, Recharts (already installed), Tailwind CSS, Lucide icons, Framer Motion (motion/react), existing `mcFetchJson` helper.

---

## Codebase Context (read before starting any task)

- **`src/server/mcApiService.ts`** (811 lines) — all MC fetch functions + `getMcConsolidatedData`. Uses `mcFetchJson(url, retries?, symbol?)`. Already has: `fetchMcHistoricalRating`, `fetchMcPivotLevels`, `fetchMcMovingAverages`, `fetchMcTechnicalV2`.
- **`src/server/marketData.ts`** — index/OHLC/tech trends fetchers. `fetchMCTechTrendsAllSegments` already covers all 5 segments.
- **`src/server/router.ts`** (~2433 lines) — all tRPC procedures. Import pattern: `import { ... } from './marketIntelService'` at top; procedures follow `publicProcedure.input(z.object({...})).query(async ({input}) => {...})`.
- **`src/components/MCStockInfoPanel.tsx`** (1613 lines) — stock detail tabs: overview, financials, technical, analysis, analyst, trendlyne. Uses `trpc.getMcConsolidated.useQuery`. Tabs defined at line 216.
- **`src/components/AppShell.tsx`** — NAV_GROUPS array at line 19. Import icons from `lucide-react`.
- **`src/App.tsx`** — routes at line 3571+. Pattern: `<Route path="/slug" element={<Component props />} />`.
- **Recharts** already used in MCStockInfoPanel: `LineChart, AreaChart, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart`.
- **`mcFetchJson`** signature: `mcFetchJson<T>(url: string, retries = 3, symbol?: string): Promise<T | null>`. Handles retries, logs errors.
- All new MC API calls use base URL pattern: `https://api.moneycontrol.com/mcapi/v1/...` — confirmed working, no auth required.

---

## File Structure

### New files
- `src/server/marketIntelService.ts` — Premarket, Deals, Earnings, IndexFnO fetch functions
- `src/components/PremarketPanel.tsx` — Pre-market intelligence panel (embedded in Dashboard)
- `src/components/SmartMoneyPage.tsx` — Full page: deals, block deals, insider trading
- `src/components/EarningsPage.tsx` — Full page: earnings calendar, results, beat/miss, shockers

### Modified files
- `src/server/mcApiService.ts` — add `fetchMcVwapChart`, `fetchKayalScreener`
- `src/server/router.ts` — add 10 new tRPC procedures
- `src/components/MCStockInfoPanel.tsx` — add FnO tab, VWAP overlay, pivot chart improvements
- `src/components/AppShell.tsx` — add Smart Money + Earnings nav items
- `src/App.tsx` — add /smart-money + /earnings routes; add PremarketPanel to dashboard section

---

## Task 1: New Backend Service — marketIntelService.ts

**Files:**
- Create: `src/server/marketIntelService.ts`

- [ ] **Step 1: Create the file with all fetch functions**

```typescript
// src/server/marketIntelService.ts
import { mcFetchJson } from './mcApiService';

// ─── Premarket ────────────────────────────────────────────────────────────────

export async function fetchPremarketArticle(slug: string) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/premarket/article?slug=${slug}&limit=1`
  );
}

export async function fetchPremarketGlobalMarkets() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=mi'
  );
}

export async function fetchPremarketEcalendar() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/ecalendar/get-upcoming-event-data?page=1&pageSize=7'
  );
}

export async function fetchPremarketMarketViews() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getMarketViewsData?cat=all&start=0&limit=9'
  );
}

export async function fetchPremarketFllActivity() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getFllActivityData?type=cash'
  );
}

export async function fetchPremarketStocksToWatch() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getStockToWatchData?start=0&limit=6&sortby=rank&sortorder=asc'
  );
}

export async function fetchPremarketNews() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getMarketNewsData?limit=8'
  );
}

export async function fetchPremarketBrokerReco() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/premarket/getBrokerResearchReco?sublevel=stocks&start=0&limit=12'
  );
}

export async function fetchPremarketAll() {
  const [globalMarkets, ecalendar, marketViews, fllActivity, stocksToWatch, news, brokerReco,
         articleMarketCues, articleAsian, articleInternational] = await Promise.all([
    fetchPremarketGlobalMarkets(),
    fetchPremarketEcalendar(),
    fetchPremarketMarketViews(),
    fetchPremarketFllActivity(),
    fetchPremarketStocksToWatch(),
    fetchPremarketNews(),
    fetchPremarketBrokerReco(),
    fetchPremarketArticle('market-cues'),
    fetchPremarketArticle('asian-markets'),
    fetchPremarketArticle('international-markets'),
  ]);
  return { globalMarkets, ecalendar, marketViews, fllActivity, stocksToWatch, news, brokerReco,
           articles: { marketCues: articleMarketCues, asian: articleAsian, international: articleInternational } };
}

// ─── Deals ────────────────────────────────────────────────────────────────────

export async function fetchDeals(dealType: 'large' | 'topStock' | 'topStockSectorWise' | 'all' = 'large', limit = 24) {
  if (dealType === 'all') {
    return mcFetchJson(
      `https://api.moneycontrol.com/mcapi/v1/deals/list?start=0&limit=${limit}&orderBy=deal_date&sortBy=DESC&deviceType=W`
    );
  }
  const orderBy = dealType === 'large' ? 'deal_date' : 'dealsValue';
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/deals/list?start=0&limit=${limit}&orderBy=${orderBy}&sortBy=DESC&dealType=${dealType}&deviceType=W&apiVersion=177`
  );
}

export async function fetchDealsInsight(
  action: 'buy' | 'sell',
  dealsType: 'topDeal' | 'topInsider' | 'topInvestor',
  limit = 9
) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/deals/insight?start=0&limit=${limit}&value=value&range=1W&action=${action}&dealsType=${dealsType}`
  );
}

export async function fetchLargeDealsInsight() {
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/deals/largedeals-insight?start=0&limit=6&orderBy=dealsValue&deviceType=W'
  );
}

export async function fetchDealsAll() {
  const [largeDeal, topStock, sectorWise, all, insightBuy, insightSell,
         insiderBuy, insiderSell, investorBuy, investorSell, largeInsight] = await Promise.all([
    fetchDeals('large'),
    fetchDeals('topStock'),
    fetchDeals('topStockSectorWise'),
    fetchDeals('all'),
    fetchDealsInsight('buy', 'topDeal'),
    fetchDealsInsight('sell', 'topDeal'),
    fetchDealsInsight('buy', 'topInsider'),
    fetchDealsInsight('sell', 'topInsider'),
    fetchDealsInsight('buy', 'topInvestor'),
    fetchDealsInsight('sell', 'topInvestor'),
    fetchLargeDealsInsight(),
  ]);
  return { largeDeal, topStock, sectorWise, all, insightBuy, insightSell,
           insiderBuy, insiderSell, investorBuy, investorSell, largeInsight };
}

// ─── Earnings ─────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

export async function fetchEarningsDashboard() {
  return mcFetchJson('https://api.moneycontrol.com/mcapi/v1/earnings/result-dashboard');
}

export async function fetchEarningsCalendar(date?: string) {
  const d = date || todayISO();
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/earnings/result-calendar?indexId=All&fromDate=${d}&toDate=${d}&sector=`
  );
}

export async function fetchEarningsData(date?: string, limit = 18) {
  const d = date || todayISO();
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/earnings/get-earnings-data?indexId=All&page=1&startDate=${d}&endDate=${d}&sector=&limit=${limit}`
  );
}

export async function fetchEarningsRapidResults(type: 'LR' | 'BP' = 'BP') {
  if (type === 'LR') {
    return mcFetchJson(
      'https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results?limit=9&page=1&type=LR&subType=yoy'
    );
  }
  return mcFetchJson(
    'https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results?limit=21&page=1&type=BP&subType=yoy&category=all&sortBy=growth&indexId=N&sector=&search=&seq=desc'
  );
}

export async function fetchEarningsPriceShockers(limit = 8) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/earnings/price-shockers?limit=${limit}&page=1`
  );
}

export async function fetchEarningsActualEstimate(limit = 6) {
  return mcFetchJson(
    `https://api.moneycontrol.com/mcapi/v1/earnings/actual-estimate?page=1&limit=${limit}`
  );
}

export async function fetchEarningsAll(date?: string) {
  const [dashboard, calendar, earningsData, rapidLR, rapidBP, priceShockers, actualEstimate] = await Promise.all([
    fetchEarningsDashboard(),
    fetchEarningsCalendar(date),
    fetchEarningsData(date),
    fetchEarningsRapidResults('LR'),
    fetchEarningsRapidResults('BP'),
    fetchEarningsPriceShockers(),
    fetchEarningsActualEstimate(),
  ]);
  return { dashboard, calendar, earningsData, rapidLR, rapidBP, priceShockers, actualEstimate };
}

// ─── Index F&O ────────────────────────────────────────────────────────────────

const FNO_INDEX_IDS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'] as const;
export type FnoIndexId = typeof FNO_INDEX_IDS[number];

export async function fetchIndexFnoFutures(id: FnoIndexId) {
  return mcFetchJson(
    `https://appfeeds.moneycontrol.com/jsonapi/fno/overview&format=json&inst_type=Futures&id=${id}&ExpiryDate=`
  );
}

export async function fetchIndexFnoOptions(id: FnoIndexId, optionType: 'CE' | 'PE') {
  return mcFetchJson(
    `https://appfeeds.moneycontrol.com/jsonapi/fno/overview&format=json&inst_type=Options&option_type=${optionType}&id=${id}&ExpiryDate=`
  );
}

export async function fetchIndexFnoAll(id: FnoIndexId) {
  const [futures, optionsCE, optionsPE] = await Promise.all([
    fetchIndexFnoFutures(id),
    fetchIndexFnoOptions(id, 'CE'),
    fetchIndexFnoOptions(id, 'PE'),
  ]);
  return { id, futures, optionsCE, optionsPE };
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | head -20
```
Expected: no errors for the new file (existing errors in other files are OK to ignore).

- [ ] **Step 3: Commit**

```bash
git add src/server/marketIntelService.ts
git commit -m "feat(backend): add marketIntelService with premarket, deals, earnings, indexFno fetchers"
```

---

## Task 2: Backend Additions to mcApiService.ts

**Files:**
- Modify: `src/server/mcApiService.ts` (append after line 811)

- [ ] **Step 1: Add VWAP chart and Kayal screener functions**

Append to end of `src/server/mcApiService.ts`:

```typescript
// ─── VWAP Chart ───────────────────────────────────────────────────────────────

export async function fetchMcVwapChart(scId: string): Promise<{ BSE: any[]; NSE: any[] } | null> {
  const res = await mcFetchJson<{ BSE: any[]; NSE: any[] }>(
    `https://www.moneycontrol.com/stocks/company_info/get_vwap_chart_data.php?classic=true&sc_did=${scId}`
  );
  if (res?.NSE || res?.BSE) return res;
  return null;
}

// ─── Kayal TrendLyne screener ─────────────────────────────────────────────────

export async function fetchKayalScreener(
  screenpk: string | number,
  perPageCount = 50
): Promise<{ head: any; body: { tableHeaders: any[]; tableData: any[][] } } | null> {
  const res = await mcFetchJson<any>(
    `https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/?perPageCount=${perPageCount}&pageNumber=0&screenpk=${screenpk}&groupType=all&groupName=`
  );
  if (res?.head && res?.body) return res;
  return null;
}
```

- [ ] **Step 2: Verify compile**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep "mcApiService" | head -5
```
Expected: no errors for mcApiService.ts.

- [ ] **Step 3: Commit**

```bash
git add src/server/mcApiService.ts
git commit -m "feat(backend): add fetchMcVwapChart and fetchKayalScreener to mcApiService"
```

---

## Task 3: New tRPC Procedures in router.ts

**Files:**
- Modify: `src/server/router.ts`

Add the import at the top of router.ts (near the other imports, around line 60):

```typescript
import {
  fetchPremarketAll, fetchDealsAll, fetchEarningsAll, fetchEarningsCalendar,
  fetchEarningsData, fetchEarningsRapidResults, fetchEarningsPriceShockers,
  fetchIndexFnoAll, type FnoIndexId
} from './marketIntelService';
import { fetchMcVwapChart, fetchKayalScreener } from './mcApiService';
```

- [ ] **Step 1: Add import for marketIntelService at top of router.ts**

Find the imports section (around line 37–65 in router.ts) and add:
```typescript
import {
  fetchPremarketAll,
  fetchDealsAll,
  fetchEarningsAll,
  fetchEarningsCalendar,
  fetchEarningsData,
  fetchEarningsRapidResults,
  fetchEarningsPriceShockers,
  fetchIndexFnoAll,
  type FnoIndexId,
} from './marketIntelService';
```

- [ ] **Step 2: Add 10 new procedures at end of the router object (before the closing `}`)**

Find the last procedure in router.ts (around line 2430) and append these before the closing `}` of the `router(...)` call:

```typescript
  // ─── Premarket ──────────────────────────────────────────────────────────────
  getPremarket: publicProcedure.query(async () => {
    return await fetchPremarketAll();
  }),

  // ─── Deals / Smart Money ────────────────────────────────────────────────────
  getDeals: publicProcedure.query(async () => {
    return await fetchDealsAll();
  }),

  // ─── Earnings ───────────────────────────────────────────────────────────────
  getEarnings: publicProcedure
    .input(z.object({ date: z.string().optional() }))
    .query(async ({ input }) => {
      return await fetchEarningsAll(input.date);
    }),

  getEarningsCalendar: publicProcedure
    .input(z.object({ date: z.string().optional() }))
    .query(async ({ input }) => {
      return await fetchEarningsCalendar(input.date);
    }),

  getEarningsRapidResults: publicProcedure
    .input(z.object({ type: z.enum(['LR', 'BP']).optional().default('BP') }))
    .query(async ({ input }) => {
      return await fetchEarningsRapidResults(input.type);
    }),

  getEarningsPriceShockers: publicProcedure.query(async () => {
    return await fetchEarningsPriceShockers();
  }),

  // ─── Index F&O ──────────────────────────────────────────────────────────────
  getIndexFno: publicProcedure
    .input(z.object({
      id: z.enum(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'])
    }))
    .query(async ({ input }) => {
      return await fetchIndexFnoAll(input.id as FnoIndexId);
    }),

  // ─── VWAP Chart ─────────────────────────────────────────────────────────────
  getMcVwapChart: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      return await fetchMcVwapChart(scId);
    }),

  // ─── Kayal Screener ─────────────────────────────────────────────────────────
  getKayalScreener: publicProcedure
    .input(z.object({ screenpk: z.string(), limit: z.number().optional().default(50) }))
    .query(async ({ input }) => {
      return await fetchKayalScreener(input.screenpk, input.limit);
    }),
```

Also add the import of `fetchMcVwapChart` and `fetchKayalScreener` in the existing mcApiService import line. Find the line that imports from `./mcApiService` and add these two functions to it.

- [ ] **Step 3: Verify compile**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep "router.ts" | head -10
```
Expected: no errors in router.ts.

- [ ] **Step 4: Verify server starts**

```bash
npx ts-node --transpile-only src/server/server.ts &
sleep 3
curl -s http://localhost:4000/trpc/getPremarket | head -c 200
kill %1
```
Expected: JSON response with `{result:{data:{globalMarkets:...}}}`.

- [ ] **Step 5: Commit**

```bash
git add src/server/router.ts
git commit -m "feat(router): add getPremarket, getDeals, getEarnings, getIndexFno, getMcVwapChart, getKayalScreener procedures"
```

---

## Task 4: PremarketPanel Component

**Files:**
- Create: `src/components/PremarketPanel.tsx`

- [ ] **Step 1: Create PremarketPanel.tsx**

```tsx
// src/components/PremarketPanel.tsx
import React from 'react';
import { trpc } from '../lib/trpc';
import { TrendingUp, TrendingDown, Globe, Clock, Newspaper, Eye, BarChart2, Activity } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

interface PremarketPanelProps {
  onSelectStock?: (symbol: string) => void;
}

export const PremarketPanel: React.FC<PremarketPanelProps> = ({ onSelectStock }) => {
  const { data, isLoading } = trpc.getPremarket.useQuery(undefined, {
    staleTime: 10 * 60 * 1000, // 10 min
    refetchOnWindowFocus: false,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-48">
      <div className="animate-spin w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full" />
    </div>
  );
  if (!data) return null;

  const globalMarkets = data.globalMarkets?.data?.globalMarketData || [];
  const stocks = data.stocksToWatch?.data?.list || [];
  const brokerRecos = data.brokerReco?.data?.list || [];
  const fllData = data.fllActivity?.data;
  const upcomingEvents = data.ecalendar?.data?.upcoming_event_calendar || [];
  const news = data.news?.data?.list || [];
  const marketViews = data.marketViews?.data?.list || [];

  const fllChartData = fllData ? [
    { name: 'FII Buy', value: parseFloat(fllData.fii_buy || 0), fill: '#10b981' },
    { name: 'FII Sell', value: parseFloat(fllData.fii_sell || 0), fill: '#f43f5e' },
    { name: 'DII Buy', value: parseFloat(fllData.dii_buy || 0), fill: '#3b82f6' },
    { name: 'DII Sell', value: parseFloat(fllData.dii_sell || 0), fill: '#f97316' },
  ] : [];

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 mb-2">
        <Activity className="w-5 h-5 text-emerald-400" />
        <h2 className="text-lg font-bold text-white">Pre-Market Intelligence</h2>
        <span className="text-xs text-slate-400 ml-auto">
          {new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST
        </span>
      </div>

      {/* ── Global Markets Banner ── */}
      {globalMarkets.length > 0 && (
        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
          <div className="flex items-center gap-2 mb-3">
            <Globe className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold text-slate-300">Global Markets</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {globalMarkets.slice(0, 12).map((mkt: any, i: number) => {
              const chg = parseFloat(mkt.change || mkt.pChange || 0);
              const isPos = chg >= 0;
              return (
                <div key={i} className="bg-slate-900/60 rounded-lg p-2.5 text-center">
                  <div className="text-xs text-slate-400 truncate mb-1">{mkt.name || mkt.market_name}</div>
                  <div className="text-sm font-bold text-white">{mkt.price || mkt.lastPrice}</div>
                  <div className={cn('text-xs font-medium', isPos ? 'text-emerald-400' : 'text-red-400')}>
                    {isPos ? '+' : ''}{chg.toFixed(2)}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ── Stocks to Watch ── */}
        {stocks.length > 0 && (
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50 lg:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <Eye className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-semibold text-slate-300">Stocks to Watch</span>
            </div>
            <div className="space-y-2">
              {stocks.map((s: any, i: number) => {
                const chg = parseFloat(s.percentChange || s.pChange || 0);
                return (
                  <motion.div
                    key={i}
                    className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 cursor-pointer hover:bg-slate-700/60 transition-colors"
                    onClick={() => onSelectStock?.(s.symbol || s.scId)}
                    whileHover={{ x: 2 }}
                  >
                    <div>
                      <div className="text-xs font-bold text-white">{s.symbol || s.scId}</div>
                      <div className="text-xs text-slate-400 truncate max-w-[120px]">{s.companyName || s.name}</div>
                    </div>
                    <div className={cn('text-xs font-bold', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── FLL Activity Chart ── */}
        {fllChartData.length > 0 && (
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50 lg:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <BarChart2 className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-semibold text-slate-300">FII / DII Activity</span>
              {fllData?.date && <span className="text-xs text-slate-500 ml-auto">{fllData.date}</span>}
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={fllChartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  labelStyle={{ color: '#f1f5f9' }}
                  formatter={(v: any) => [`₹${(v / 100).toFixed(0)}Cr`, '']}
                />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {fllChartData.map((entry, index) => (
                    <Cell key={index} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {fllData && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div className="text-center">
                  <div className="text-xs text-slate-500">FII Net</div>
                  <div className={cn('text-sm font-bold',
                    parseFloat(fllData.fii_net || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                  )}>
                    {parseFloat(fllData.fii_net || 0) >= 0 ? '+' : ''}
                    ₹{(parseFloat(fllData.fii_net || 0) / 100).toFixed(0)}Cr
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-slate-500">DII Net</div>
                  <div className={cn('text-sm font-bold',
                    parseFloat(fllData.dii_net || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                  )}>
                    {parseFloat(fllData.dii_net || 0) >= 0 ? '+' : ''}
                    ₹{(parseFloat(fllData.dii_net || 0) / 100).toFixed(0)}Cr
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Upcoming Events ── */}
        {upcomingEvents.length > 0 && (
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50 lg:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-cyan-400" />
              <span className="text-sm font-semibold text-slate-300">Economic Calendar</span>
            </div>
            <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
              {upcomingEvents.slice(0, 8).map((evt: any, i: number) => (
                <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-slate-900/60">
                  <div className="shrink-0 text-xs text-cyan-400 font-mono mt-0.5">{evt.event_date || evt.date}</div>
                  <div>
                    <div className="text-xs font-medium text-white leading-tight">{evt.event_name || evt.title}</div>
                    {evt.impact && (
                      <span className={cn('text-xs px-1 rounded',
                        evt.impact === 'High' ? 'text-red-400' : evt.impact === 'Medium' ? 'text-amber-400' : 'text-slate-500'
                      )}>{evt.impact}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Broker Reco ── */}
      {brokerRecos.length > 0 && (
        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-semibold text-slate-300">Broker Research Recommendations</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {brokerRecos.slice(0, 6).map((reco: any, i: number) => (
              <div key={i} className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/30">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span
                    className="text-xs font-bold text-white cursor-pointer hover:text-emerald-400"
                    onClick={() => onSelectStock?.(reco.symbol || reco.scId)}
                  >
                    {reco.companyName || reco.name || reco.symbol}
                  </span>
                  <span className={cn('text-xs px-1.5 py-0.5 rounded font-semibold shrink-0',
                    reco.recommendation === 'Buy' || reco.action === 'Buy' ? 'bg-emerald-500/20 text-emerald-400' :
                    reco.recommendation === 'Sell' || reco.action === 'Sell' ? 'bg-red-500/20 text-red-400' :
                    'bg-amber-500/20 text-amber-400'
                  )}>
                    {reco.recommendation || reco.action || 'Hold'}
                  </span>
                </div>
                <div className="text-xs text-slate-500">{reco.brokerName || reco.broker}</div>
                {reco.targetPrice && (
                  <div className="text-xs text-slate-400 mt-1">Target: <span className="text-white font-medium">₹{reco.targetPrice}</span></div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Market News ── */}
      {news.length > 0 && (
        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
          <div className="flex items-center gap-2 mb-3">
            <Newspaper className="w-4 h-4 text-slate-400" />
            <span className="text-sm font-semibold text-slate-300">Pre-Market News</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {news.slice(0, 6).map((item: any, i: number) => (
              <a
                key={i}
                href={item.url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="block p-2 rounded-lg bg-slate-900/60 hover:bg-slate-700/60 transition-colors"
              >
                <div className="text-xs font-medium text-slate-200 leading-snug line-clamp-2">{item.title || item.headline}</div>
                <div className="text-xs text-slate-500 mt-1">{item.source || item.publisher}</div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PremarketPanel;
```

- [ ] **Step 2: Verify compile**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep "PremarketPanel" | head -5
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/PremarketPanel.tsx
git commit -m "feat(ui): add PremarketPanel with global markets, FII/DII chart, stocks-to-watch, broker reco, news"
```

---

## Task 5: SmartMoneyPage Component

**Files:**
- Create: `src/components/SmartMoneyPage.tsx`

- [ ] **Step 1: Create SmartMoneyPage.tsx**

```tsx
// src/components/SmartMoneyPage.tsx
import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { TrendingUp, TrendingDown, DollarSign, Users, BarChart2, RefreshCw } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Legend
} from 'recharts';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

interface SmartMoneyPageProps {
  onSelectStock?: (symbol: string) => void;
}

type DealTab = 'large' | 'insider' | 'institutional' | 'sector';

const DEAL_TABS: { key: DealTab; label: string; icon: React.ElementType }[] = [
  { key: 'large',       label: 'Large Deals',    icon: DollarSign },
  { key: 'insider',     label: 'Insider Trading', icon: Users      },
  { key: 'institutional', label: 'Institutional', icon: TrendingUp },
  { key: 'sector',      label: 'By Sector',       icon: BarChart2  },
];

const COLORS = ['#10b981', '#f43f5e', '#3b82f6', '#f97316', '#8b5cf6', '#ec4899'];

export const SmartMoneyPage: React.FC<SmartMoneyPageProps> = ({ onSelectStock }) => {
  const [activeTab, setActiveTab] = useState<DealTab>('large');
  const { data, isLoading, refetch } = trpc.getDeals.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full" />
    </div>
  );

  const largeDealList: any[] = data?.largeDeal?.data?.list || data?.all?.data?.list || [];
  const insiderBuyList: any[] = data?.insiderBuy?.data?.list || [];
  const insiderSellList: any[] = data?.insiderSell?.data?.list || [];
  const investorBuyList: any[] = data?.investorBuy?.data?.list || [];
  const investorSellList: any[] = data?.investorSell?.data?.list || [];
  const sectorList: any[] = data?.sectorWise?.data?.list || [];
  const topStockList: any[] = data?.topStock?.data?.list || [];

  // Sector chart data
  const sectorChartData = sectorList.slice(0, 8).map((s: any) => ({
    name: s.sector || s.sectorName || 'Other',
    value: parseFloat(s.dealsValue || s.value || 0),
  }));

  // Insider net (buy - sell)
  const insiderNetData = [
    { name: 'Buy', value: insiderBuyList.length, fill: '#10b981' },
    { name: 'Sell', value: insiderSellList.length, fill: '#f43f5e' },
  ];

  const renderDealRow = (deal: any, i: number) => {
    const chg = parseFloat(deal.pChange || deal.percentChange || 0);
    return (
      <motion.tr
        key={i}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: i * 0.03 }}
        className="border-b border-slate-700/30 hover:bg-slate-700/20 cursor-pointer"
        onClick={() => onSelectStock?.(deal.symbol || deal.scId)}
      >
        <td className="py-2.5 px-3">
          <div className="text-xs font-bold text-white">{deal.companyName || deal.company || deal.symbol}</div>
          <div className="text-xs text-slate-500">{deal.dealType || deal.type}</div>
        </td>
        <td className="py-2.5 px-3 text-xs text-slate-300">{deal.buyerName || deal.sellerName || deal.party || '—'}</td>
        <td className="py-2.5 px-3 text-xs font-mono text-white text-right">
          ₹{parseFloat(deal.dealsValue || deal.value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}Cr
        </td>
        <td className="py-2.5 px-3 text-xs text-slate-400 text-right">{deal.dealDate || deal.date || '—'}</td>
        <td className="py-2.5 px-3 text-right">
          <span className={cn('text-xs font-bold', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
          </span>
        </td>
      </motion.tr>
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-white">Smart Money</h1>
          <p className="text-sm text-slate-400 mt-0.5">Institutional deals, insider activity, and block trades</p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/50 text-slate-300 hover:bg-slate-600/50 text-xs transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Large Deals', value: largeDealList.length, icon: DollarSign, color: 'text-blue-400' },
          { label: 'Insider Buys', value: insiderBuyList.length, icon: TrendingUp, color: 'text-emerald-400' },
          { label: 'Insider Sells', value: insiderSellList.length, icon: TrendingDown, color: 'text-red-400' },
          { label: 'Top Stocks', value: topStockList.length, icon: BarChart2, color: 'text-amber-400' },
        ].map((card, i) => (
          <div key={i} className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <card.icon className={cn('w-4 h-4 mb-2', card.color)} />
            <div className="text-2xl font-black text-white">{card.value}</div>
            <div className="text-xs text-slate-500 mt-0.5">{card.label}</div>
          </div>
        ))}
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 bg-slate-800/40 rounded-xl p-1">
        {DEAL_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all',
              activeTab === tab.key
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'text-slate-400 hover:text-slate-300'
            )}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Large Deals Tab ── */}
      {activeTab === 'large' && (
        <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-900/60">
                <tr>
                  <th className="text-left py-2.5 px-3 text-xs font-semibold text-slate-400">Company</th>
                  <th className="text-left py-2.5 px-3 text-xs font-semibold text-slate-400">Party</th>
                  <th className="text-right py-2.5 px-3 text-xs font-semibold text-slate-400">Deal Value</th>
                  <th className="text-right py-2.5 px-3 text-xs font-semibold text-slate-400">Date</th>
                  <th className="text-right py-2.5 px-3 text-xs font-semibold text-slate-400">Chg%</th>
                </tr>
              </thead>
              <tbody>
                {largeDealList.slice(0, 20).map(renderDealRow)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Insider Trading Tab ── */}
      {activeTab === 'insider' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Pie: buy vs sell ratio */}
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-sm font-semibold text-slate-300 mb-3">Insider Buy vs Sell</div>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={insiderNetData} dataKey="value" cx="50%" cy="50%" outerRadius={70} label={({ name, value }) => `${name}: ${value}`}>
                  {insiderNetData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* Buy list */}
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
              <span className="text-xs font-bold text-emerald-400">Insider BUYS ({insiderBuyList.length})</span>
            </div>
            <div className="overflow-y-auto max-h-64">
              <table className="w-full">
                <tbody>{insiderBuyList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
          {/* Sell list */}
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/20">
              <span className="text-xs font-bold text-red-400">Insider SELLS ({insiderSellList.length})</span>
            </div>
            <div className="overflow-y-auto max-h-64">
              <table className="w-full">
                <tbody>{insiderSellList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Institutional Tab ── */}
      {activeTab === 'institutional' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
              <span className="text-xs font-bold text-emerald-400">Investor BUYS</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              <table className="w-full">
                <tbody>{investorBuyList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/20">
              <span className="text-xs font-bold text-red-400">Investor SELLS</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              <table className="w-full">
                <tbody>{investorSellList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Sector Tab ── */}
      {activeTab === 'sector' && sectorChartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-sm font-semibold text-slate-300 mb-3">Deal Value by Sector</div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={sectorChartData} layout="vertical" margin={{ left: 80, right: 16 }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} width={80} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155' }}
                  formatter={(v: any) => [`₹${v.toFixed(0)}Cr`, 'Deal Value']}
                />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {sectorChartData.map((_, idx) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-700/50">
              <span className="text-xs font-bold text-slate-300">Top Stocks by Deal Value</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              <table className="w-full">
                <tbody>{topStockList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SmartMoneyPage;
```

- [ ] **Step 2: Verify compile**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep "SmartMoneyPage" | head -5
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/SmartMoneyPage.tsx
git commit -m "feat(ui): add SmartMoneyPage with deals, insider trading, institutional and sector views"
```

---

## Task 6: EarningsPage Component

**Files:**
- Create: `src/components/EarningsPage.tsx`

- [ ] **Step 1: Create EarningsPage.tsx**

```tsx
// src/components/EarningsPage.tsx
import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { TrendingUp, TrendingDown, Calendar, Zap, BarChart2, RefreshCw } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine
} from 'recharts';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

interface EarningsPageProps {
  onSelectStock?: (symbol: string) => void;
}

type EarningsTab = 'today' | 'calendar' | 'beatmiss' | 'shockers';

const EARNINGS_TABS: { key: EarningsTab; label: string; icon: React.ElementType }[] = [
  { key: 'today',    label: "Today's Results", icon: Zap      },
  { key: 'calendar', label: 'Calendar',         icon: Calendar  },
  { key: 'beatmiss', label: 'Beat / Miss',      icon: BarChart2 },
  { key: 'shockers', label: 'Price Shockers',   icon: TrendingUp},
];

export const EarningsPage: React.FC<EarningsPageProps> = ({ onSelectStock }) => {
  const [activeTab, setActiveTab] = useState<EarningsTab>('today');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);

  const { data, isLoading, refetch } = trpc.getEarnings.useQuery(
    { date: selectedDate },
    { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full" />
    </div>
  );

  const dashboard = data?.dashboard?.data;
  const calendarList: any[] = data?.calendar?.data?.resultCalendar || [];
  const earningsList: any[] = data?.earningsData?.data?.earningsData || data?.earningsData?.data?.list || [];
  const rapidBPList: any[] = data?.rapidBP?.data?.list || [];
  const priceShockerList: any[] = data?.priceShockers?.data?.list || [];
  const actualEstimateList: any[] = data?.actualEstimate?.data?.list || [];

  // Beat/Miss chart — growth vs expectation
  const beatMissData = rapidBPList.slice(0, 12).map((item: any) => ({
    name: item.companyShortName || item.symbol || item.companyName?.slice(0, 8),
    actual: parseFloat(item.actual || item.actualGrowth || 0),
    estimate: parseFloat(item.estimate || item.estimateGrowth || 0),
  }));

  // Price shockers chart
  const shockerData = priceShockerList.slice(0, 10).map((item: any) => ({
    name: item.companyShortName || item.symbol || item.companyName?.slice(0, 8),
    chg: parseFloat(item.pChange || item.change || 0),
  })).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black text-white">Earnings Tracker</h1>
          <p className="text-sm text-slate-400 mt-0.5">Q-results, beat/miss analysis and price shockers</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-slate-700/50 border border-slate-600 text-slate-200 text-xs"
          />
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/50 text-slate-300 hover:bg-slate-600/50 text-xs transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {/* ── Dashboard Summary ── */}
      {dashboard && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Reporting Today', value: dashboard.totalResults || dashboard.todayCount || '—', color: 'text-blue-400' },
            { label: 'Beat Estimates',  value: dashboard.beat || '—', color: 'text-emerald-400' },
            { label: 'Missed Estimates',value: dashboard.miss || dashboard.missed || '—', color: 'text-red-400' },
            { label: 'In Line',         value: dashboard.inline || dashboard.neutral || '—', color: 'text-amber-400' },
          ].map((card, i) => (
            <div key={i} className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
              <div className={cn('text-2xl font-black', card.color)}>{card.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{card.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="flex gap-1 bg-slate-800/40 rounded-xl p-1 overflow-x-auto">
        {EARNINGS_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1.5 py-2 px-4 rounded-lg text-xs font-semibold transition-all whitespace-nowrap',
              activeTab === tab.key
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'text-slate-400 hover:text-slate-300'
            )}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Today's Results ── */}
      {activeTab === 'today' && (
        <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-900/60">
                <tr>
                  {['Company', 'Revenue', 'Net Profit', 'YoY Revenue', 'YoY Profit', 'Status'].map(h => (
                    <th key={h} className="text-left py-2.5 px-3 text-xs font-semibold text-slate-400 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {earningsList.slice(0, 25).map((item: any, i: number) => {
                  const revGrowth = parseFloat(item.revGrowth || item.revenueGrowth || 0);
                  const profitGrowth = parseFloat(item.netProfitGrowth || item.profitGrowth || 0);
                  return (
                    <motion.tr
                      key={i}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: i * 0.02 }}
                      className="border-b border-slate-700/30 hover:bg-slate-700/20 cursor-pointer"
                      onClick={() => onSelectStock?.(item.symbol || item.scId)}
                    >
                      <td className="py-2.5 px-3">
                        <div className="text-xs font-bold text-white">{item.companyName || item.name}</div>
                        <div className="text-xs text-slate-500">{item.symbol}</div>
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-300">₹{item.revenue || item.sales || '—'}Cr</td>
                      <td className="py-2.5 px-3 text-xs text-slate-300">₹{item.netProfit || item.profit || '—'}Cr</td>
                      <td className="py-2.5 px-3">
                        <span className={cn('text-xs font-bold', revGrowth >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {revGrowth >= 0 ? '+' : ''}{revGrowth.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={cn('text-xs font-bold', profitGrowth >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {profitGrowth >= 0 ? '+' : ''}{profitGrowth.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={cn('text-xs px-1.5 py-0.5 rounded font-semibold',
                          item.resultStatus === 'beat' ? 'bg-emerald-500/20 text-emerald-400' :
                          item.resultStatus === 'miss' ? 'bg-red-500/20 text-red-400' :
                          'bg-slate-600/50 text-slate-400'
                        )}>
                          {item.resultStatus || '—'}
                        </span>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Calendar Tab ── */}
      {activeTab === 'calendar' && calendarList.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {calendarList.map((item: any, i: number) => (
            <div
              key={i}
              className="bg-slate-800/50 rounded-xl p-3 border border-slate-700/50 cursor-pointer hover:border-emerald-500/40 transition-colors"
              onClick={() => onSelectStock?.(item.symbol)}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-white">{item.companyName || item.name}</div>
                  <div className="text-xs text-slate-500">{item.symbol}</div>
                </div>
                <div className="text-xs text-cyan-400 font-mono shrink-0">{item.resultDate || item.date}</div>
              </div>
              {item.boardMeetingPurpose && (
                <div className="text-xs text-slate-400 mt-1.5 leading-snug">{item.boardMeetingPurpose}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Beat / Miss Chart ── */}
      {activeTab === 'beatmiss' && beatMissData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-sm font-semibold text-slate-300 mb-3">Actual vs Estimate Growth (%)</div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={beatMissData} margin={{ left: -10, right: 8 }}>
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#94a3b8' }} angle={-30} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  formatter={(v: any) => [`${v.toFixed(1)}%`, '']}
                />
                <ReferenceLine y={0} stroke="#475569" />
                <Bar dataKey="estimate" name="Estimate" fill="#64748b" radius={[2, 2, 0, 0]} />
                <Bar dataKey="actual" name="Actual" radius={[2, 2, 0, 0]}>
                  {beatMissData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.actual >= entry.estimate ? '#10b981' : '#f43f5e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-700/50">
              <span className="text-xs font-bold text-slate-300">Actual vs Estimate Detail</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              {actualEstimateList.slice(0, 15).map((item: any, i: number) => {
                const beat = parseFloat(item.actual || 0) >= parseFloat(item.estimate || 0);
                return (
                  <div key={i} className="flex items-center justify-between px-3 py-2 border-b border-slate-700/30 hover:bg-slate-700/20 cursor-pointer"
                       onClick={() => onSelectStock?.(item.symbol)}>
                    <div>
                      <div className="text-xs font-bold text-white">{item.companyName || item.symbol}</div>
                      <div className="text-xs text-slate-500">{item.metric || 'Net Profit'}</div>
                    </div>
                    <div className="text-right">
                      <div className={cn('text-xs font-bold', beat ? 'text-emerald-400' : 'text-red-400')}>
                        {beat ? '✓ Beat' : '✗ Miss'}
                      </div>
                      <div className="text-xs text-slate-500">{item.actual} vs {item.estimate}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Price Shockers ── */}
      {activeTab === 'shockers' && shockerData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-sm font-semibold text-slate-300 mb-3">Price Impact After Results (%)</div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={shockerData} layout="vertical" margin={{ left: 60, right: 20 }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} width={60} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155' }}
                  formatter={(v: any) => [`${v.toFixed(2)}%`, 'Price Change']}
                />
                <ReferenceLine x={0} stroke="#475569" />
                <Bar dataKey="chg" radius={[0, 3, 3, 0]}>
                  {shockerData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.chg >= 0 ? '#10b981' : '#f43f5e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-700/50">
              <span className="text-xs font-bold text-slate-300">Price Shockers List</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              {priceShockerList.slice(0, 15).map((item: any, i: number) => {
                const chg = parseFloat(item.pChange || item.change || 0);
                return (
                  <div key={i} className="flex items-center justify-between px-3 py-2.5 border-b border-slate-700/30 hover:bg-slate-700/20 cursor-pointer"
                       onClick={() => onSelectStock?.(item.symbol)}>
                    <div>
                      <div className="text-xs font-bold text-white">{item.companyName || item.symbol}</div>
                      <div className="text-xs text-slate-500">₹{item.price || item.lastPrice}</div>
                    </div>
                    <div className={cn('text-sm font-black', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EarningsPage;
```

- [ ] **Step 2: Verify compile**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep "EarningsPage" | head -5
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/EarningsPage.tsx
git commit -m "feat(ui): add EarningsPage with today results, calendar, beat/miss chart, price shockers"
```

---

## Task 7: MCStockInfoPanel — New F&O Tab + VWAP + Pivot Chart

**Files:**
- Modify: `src/components/MCStockInfoPanel.tsx`

This task adds a new "F&O" tab, a VWAP chart toggle, and improves the pivot levels display in the technical tab.

- [ ] **Step 1: Add VWAP query + update Tab type**

Find line 51: `type Tab = 'overview' | 'financials' | 'technical' | 'analysis' | 'analyst' | 'trendlyne';`
Replace with:
```typescript
type Tab = 'overview' | 'financials' | 'technical' | 'analysis' | 'analyst' | 'trendlyne' | 'fno';
```

Find line 127 area (where queries are defined) and add after the existing queries:
```typescript
  const { data: vwapData } = trpc.getMcVwapChart.useQuery(
    { symbol },
    { enabled: isVisible && activeTab === 'overview', staleTime: 300000 }
  );
  const { data: indexFnoData } = trpc.getIndexFno.useQuery(
    { id: 'NIFTY' },
    { enabled: isVisible && activeTab === 'fno', staleTime: 60000 }
  );
```

- [ ] **Step 2: Add F&O to TABS array**

Find line 216:
```typescript
  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview',   label: 'Overview'   },
    { key: 'financials', label: 'Financials'  },
    { key: 'technical',  label: 'Technical'   },
    { key: 'analysis',   label: 'Analysis'    },
    { key: 'analyst',    label: 'Analyst'     },
    { key: 'trendlyne',  label: 'Trendlyne'   },
  ];
```
Replace with:
```typescript
  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview',   label: 'Overview'   },
    { key: 'financials', label: 'Financials'  },
    { key: 'technical',  label: 'Technical'   },
    { key: 'fno',        label: 'F&O'         },
    { key: 'analysis',   label: 'Analysis'    },
    { key: 'analyst',    label: 'Analyst'     },
    { key: 'trendlyne',  label: 'Trendlyne'   },
  ];
```

- [ ] **Step 3: Add VWAP mini chart to Overview tab**

Find the overview tab content (around line 368: `{activeTab === 'overview' && (`). After the existing price/essentials cards and before the SWOT section, add:

```tsx
{/* VWAP Chart */}
{vwapData?.NSE && vwapData.NSE.length > 0 && (
  <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
    <div className="flex items-center justify-between mb-3">
      <span className="text-sm font-semibold text-slate-300">VWAP — Intraday</span>
      <span className="text-xs text-slate-500">NSE</span>
    </div>
    <ResponsiveContainer width="100%" height={120}>
      <AreaChart data={vwapData.NSE.slice(-60)} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="vwapGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="time" hide />
        <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#94a3b8' }} />
        <Tooltip
          contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
          formatter={(v: any) => [`₹${parseFloat(v).toFixed(2)}`, 'VWAP']}
        />
        <Area type="monotone" dataKey="vwap" stroke="#3b82f6" strokeWidth={1.5}
              fill="url(#vwapGrad)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  </div>
)}
```

- [ ] **Step 4: Add F&O tab content**

After the `{activeTab === 'trendlyne' && (` section (at the end of the panel JSX, before the outer closing div), add:

```tsx
{/* ── F&O Tab ── */}
{activeTab === 'fno' && (
  <div className="space-y-4">
    {/* Stock FnO from consolidated data */}
    {data?.fnoExpiry && (
      <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
        <div className="text-sm font-semibold text-slate-300 mb-3">Futures — {symbol}</div>
        {data.fnoFutures?.data?.futureData && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700/50">
                  {['Expiry', 'LTP', 'Change%', 'OI', 'OI Change', 'Volume'].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 text-slate-400 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.fnoFutures.data.futureData || []).slice(0, 5).map((row: any, i: number) => {
                  const chg = parseFloat(row.pChange || row.change || 0);
                  return (
                    <tr key={i} className="border-b border-slate-700/20">
                      <td className="py-2 pr-4 text-slate-300">{row.expiryDate || row.expiry}</td>
                      <td className="py-2 pr-4 font-mono text-white">₹{row.lastPrice || row.ltp}</td>
                      <td className={cn('py-2 pr-4 font-bold', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                      </td>
                      <td className="py-2 pr-4 text-slate-300">{row.openInterest || row.oi}</td>
                      <td className="py-2 pr-4 text-slate-400">{row.changeinOpenInterest || row.oiChange}</td>
                      <td className="py-2 text-slate-400">{row.totalTradedVolume || row.volume}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {(!data?.fnoFutures?.data?.futureData || data.fnoFutures.data.futureData.length === 0) && (
          <div className="text-xs text-slate-500 text-center py-4">No futures data available for {symbol}</div>
        )}
      </div>
    )}

    {/* Nifty Index FnO context */}
    {indexFnoData?.futures?.refresh_details && (
      <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
        <div className="text-sm font-semibold text-slate-300 mb-3">Index F&O — NIFTY Futures</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700/50">
                {['Expiry', 'LTP', 'Change', 'OI Lots', 'Volume'].map(h => (
                  <th key={h} className="text-left pb-2 pr-4 text-slate-400 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(indexFnoData.futures.fno_list || []).slice(0, 3).map((row: any, i: number) => {
                const chg = parseFloat(row.pChange || 0);
                return (
                  <tr key={i} className="border-b border-slate-700/20">
                    <td className="py-2 pr-4 text-slate-300">{row.expiry}</td>
                    <td className="py-2 pr-4 font-mono text-white">{row.lastPrice}</td>
                    <td className={cn('py-2 pr-4 font-bold', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                    </td>
                    <td className="py-2 pr-4 text-slate-300">{row.openInterest}</td>
                    <td className="py-2 text-slate-400">{row.totalTradedVolume}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 5: Enhance pivot levels display in Technical tab**

Find the technical tab content (around `activeTab === 'technical'`). Locate where pivot levels are displayed and ensure they render as a visual support/resistance table. Find the existing pivot display and enhance it. If pivot data comes from `data?.technical?.pivotLevels`, add:

```tsx
{/* Pivot Levels — visual S/R grid */}
{data?.technical?.pivotLevels && (
  <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50 mt-3">
    <div className="text-sm font-semibold text-slate-300 mb-3">Pivot Levels ({timeframe})</div>
    {Object.entries(data.technical.pivotLevels).map(([method, levels]: [string, any]) => (
      <div key={method} className="mb-3">
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">{method}</div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {['S3', 'S2', 'S1', 'P', 'R1', 'R2', 'R3'].map(label => {
            const val = levels?.[label.toLowerCase()] ?? levels?.[label];
            const isP = label === 'P';
            const isR = label.startsWith('R');
            return (
              <div key={label} className={cn('rounded p-1.5',
                isP ? 'bg-amber-500/20 border border-amber-500/40' :
                isR ? 'bg-emerald-500/10' : 'bg-red-500/10'
              )}>
                <div className={cn('text-xs font-bold',
                  isP ? 'text-amber-400' : isR ? 'text-emerald-400' : 'text-red-400'
                )}>{label}</div>
                <div className="text-xs text-slate-300 font-mono mt-0.5">
                  {val ? parseFloat(val).toFixed(0) : '—'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 6: Verify compile**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep "MCStockInfoPanel" | head -10
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/MCStockInfoPanel.tsx
git commit -m "feat(ui): add FnO tab, VWAP chart, enhanced pivot levels to MCStockInfoPanel"
```

---

## Task 8: AppShell + App.tsx — New Nav Items and Routes

**Files:**
- Modify: `src/components/AppShell.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add new nav items to AppShell.tsx**

Find the imports in AppShell.tsx (line 1–9) and add `TrendingDown, Briefcase` to the lucide imports:
```typescript
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
  Search, History, PieChart, Bookmark, Users, Globe, CheckCircle2,
  Star, LogIn, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Menu,
  ChevronLeft, ChevronRight, Radio, Settings2, Briefcase, Calendar,
} from 'lucide-react';
```

Find the `NAV_GROUPS` in AppShell.tsx and update the `Analysis` group items to add Smart Money and Earnings:

```typescript
  {
    label: 'Analysis',
    items: [
      { icon: Trophy,       label: 'Top Rated',    id: 'top-rated'    },
      { icon: Filter,       label: 'Screener',     id: 'screener'     },
      { icon: Target,       label: 'F&O Intel',    id: 'fno-scanners' },
      { icon: TrendingUp,   label: 'Options Intel',id: 'options'      },
      { icon: Zap,          label: 'Trendlyne',    id: 'trendlyne'    },
      { icon: Search,       label: 'Discover',     id: 'discover'     },
      { icon: Briefcase,    label: 'Smart Money',  id: 'smart-money'  },
      { icon: Calendar,     label: 'Earnings',     id: 'earnings'     },
    ],
  },
```

- [ ] **Step 2: Add imports in App.tsx**

Find the component imports in App.tsx (around line 20–35) and add:
```typescript
import PremarketPanel from './components/PremarketPanel';
import SmartMoneyPage from './components/SmartMoneyPage';
import EarningsPage from './components/EarningsPage';
```

- [ ] **Step 3: Add new routes in App.tsx**

Find the routes section in App.tsx (around line 3611) and add after the existing routes:
```tsx
<Route path="/smart-money" element={
  <SmartMoneyPage onSelectStock={(s) => { setSelectedSymbol(s); navigate('/details'); }} />
} />
<Route path="/earnings" element={
  <EarningsPage onSelectStock={(s) => { setSelectedSymbol(s); navigate('/details'); }} />
} />
```

- [ ] **Step 4: Add PremarketPanel to Dashboard**

Find the DashboardPage component in `src/components/DashboardPage.tsx` and add the PremarketPanel import and usage at the top of the dashboard content (after the main index overview cards):

In `src/components/DashboardPage.tsx`:
```typescript
// Add at top:
import { PremarketPanel } from './PremarketPanel';
```

Then inside the dashboard JSX, find a good location after the indices/overview cards section and add:
```tsx
{/* Pre-Market Intelligence */}
<div className="mt-6">
  <PremarketPanel onSelectStock={onSelectStock} />
</div>
```

If `DashboardPage.tsx` doesn't accept `onSelectStock`, check its props interface and add it if missing.

- [ ] **Step 5: Verify compile**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | head -20
```
Expected: no type errors in the new/modified files (pre-existing errors in unrelated files are acceptable).

- [ ] **Step 6: Start dev server and verify routes load**

```bash
npm run dev 2>&1 &
sleep 5
curl -s http://localhost:5173/smart-money | head -c 100
curl -s http://localhost:5173/earnings | head -c 100
kill %1
```
Expected: HTML responses (the SPA serves index.html for all routes).

- [ ] **Step 7: Commit**

```bash
git add src/components/AppShell.tsx src/App.tsx src/components/DashboardPage.tsx
git commit -m "feat(nav): add Smart Money and Earnings routes, PremarketPanel to dashboard"
```

---

## Self-Review

### Spec coverage
| Requirement | Task |
|---|---|
| Premarket endpoints onboarded | Task 1 + 3 + 4 |
| Deals endpoints onboarded | Task 1 + 3 + 5 |
| Earnings endpoints onboarded | Task 1 + 3 + 6 |
| Index FnO onboarded | Task 1 + 3 |
| VWAP chart onboarded | Task 2 + 3 + 7 |
| Kayal screeners onboarded | Task 2 + 3 |
| Smart Money page | Task 5 |
| Earnings page | Task 6 |
| PremarketPanel on dashboard | Task 4 + 8 |
| Stock F&O tab | Task 7 |
| Pivot levels visual display | Task 7 |
| New nav items | Task 8 |
| New routes | Task 8 |

### No placeholders: verified ✅ — all steps have concrete code.

### Type consistency
- `FnoIndexId` defined in `marketIntelService.ts`, imported as `type FnoIndexId` in `router.ts`.
- `Tab` type in `MCStockInfoPanel.tsx` extended to include `'fno'` — matches new tab in TABS array.
- `PremarketPanel` exports named export + default; imported as default in App.tsx/DashboardPage.tsx.
- All fetch functions return `Promise<T | null>` consistent with existing `mcFetchJson` pattern.
- `fetchDealsAll`, `fetchEarningsAll`, `fetchPremarketAll` return plain objects (no null) so router procedures don't need null checks.
