# URLs Section Coverage Review (2026-08-05)

Scope requested: market, indices, sectors, stocks, fundamentals, news, screeners, earnings/results, financials, balance sheets, shareholdings, insights, F&O, and full urls.txt quality.

## 1) Corpus Facts (urls.txt)

- Total URLs: 1983
- Unique non-empty hosts: 39
- Malformed URLs (`https:////...`): 15
- Empty lines: 0
- Non-http lines: 0

Top host concentration (dominant source families):

- `kayal.trendlyne.com`: 1054
- `api.moneycontrol.com`: 397
- `trendlyne.com`: 75
- `investsights.in`: 52
- `moneycontrol.com`: 47
- `webapi.niftytrader.in`: 43
- `appfeeds.moneycontrol.com`: 41
- `smartoptions.trendlyne.com`: 38

Interpretation:

- Corpus is strongly screener-heavy and fundamentals-heavy.
- Coverage for shareholding/news/earnings is materially lower in absolute URL count.

## 2) Section Coverage Matrix

Notes:

- Counts below are keyword-hit counts (not unique endpoint families).
- A URL can hit multiple buckets.
- “Wired status” is based on current tRPC/frontend call sites.

| Section | urls.txt signal | Wired in app/backend | Coverage judgement |
|---|---:|---|---|
| Screeners | 1382 | Strong (`getTrendlyneScreener`, `getStockScreeners`, ET/MC/Trendlyne stacks) | Very strong |
| Fundamentals/Financials | 1481 | Strong (`getStockFundamentals`, `getRatios`, `getShareholding`, MC insights/essentials) | Very strong |
| Stocks/Price/Charts | 324 | Strong (stock detail pages, option/price views, MC consolidated paths) | Strong |
| Market + Indices | 310 | Strong (`getMarketOverview`, indices/fno dashboards, global cards) | Strong |
| F&O | 157 | Strong (`getOptionChain`, `getTrendlyneFnoScanners`, `getTrendlyneFnoHeatmap`) | Strong |
| Earnings/Results | 67 | Medium (V5 earnings panels and MC forecasts wired) | Medium |
| News/Events | 49 | Medium (news feeds and stock news wired; smaller corpus slice) | Medium |
| Sectors/Industry | 44 | Medium (sector views exist; endpoint depth in corpus is thinner) | Medium |
| Shareholding/Flows | 33 | Medium (FII/DII + stock-level ownership wired, fewer endpoint families) | Medium-weak |
| Insights (qualitative) | mostly via fundamentals/screener sources | Strong in MCStockInfoPanel + Premium/Desk pages | Strong, source-coupled |
| Balance Sheet specific | included within fundamentals keyword slice | Present via fundamentals endpoints | Medium |

## 3) Concrete Wiring Evidence (selected)

Backend procedures and UI usage are already present for core requested sections:

- F&O: `src/server/routers/fno.router.ts`, used in `src/v5/pages/OptionsDeskPage.tsx`, `src/components/FnOHeatmap.tsx`, `src/components/IndexFnoOverview.tsx`.
- Fundamentals/ownership: `src/server/routers/fundamentals.router.ts`, used in `src/v5/pages/StockIntelligenceDeskPage.tsx`, `src/components/V1MFAnalysis.tsx`.
- MoneyControl deep sections: `src/server/routers/moneycontrol.router.ts`, consumed by `src/components/MCStockInfoPanel.tsx`, `src/components/PremiumScreenersPage.tsx`, `src/v5/pages/StockIntelligenceDeskPage.tsx`.
- Trendlyne screener and DVM: `src/server/routers/screeners.router.ts`, `src/server/routers/trendlyne.router.ts`, consumed by `src/components/TrendlyneScreenerPanel.tsx`, `src/components/PremiumScreenersPage.tsx`.
- Flows: `src/server/routers/ml.router.ts` (`getFiiDiiFlow`) consumed across `src/components/AlphaCockpit.tsx`, `src/components/TradeDecisionCockpit.tsx`, `src/v5/V5App.tsx`, `src/v5/pages/MacroRegimeDeskPage.tsx`.

## 4) Gaps and Risks

1. Source concentration risk
- >50% of all URLs are from one host family (`kayal.trendlyne.com`).
- Operational outage or anti-bot changes in one provider can create broad blind spots.

2. Malformed URL quality debt
- 15 entries use `https:////...` and should be normalized before ingestion pipelines consume them.

3. Underrepresented shareholding and events endpoints
- Shareholding/insider/deals-oriented URLs are only a small fraction of corpus.
- Practical effect: less diversified ownership-signal surface compared with screener/fundamental density.

4. Screener over-weighting risk (already known system theme)
- Corpus breadth for screeners is huge relative to other domains.
- Without strict source-aware reliability weighting, this can bias downstream ranking engines.

## 5) Priority Integration Recommendations

P0 (data quality + stability):

1. Normalize malformed `https:////` URLs to canonical host/path before endpoint ingest.
2. Add a pre-ingest URL lint step for host/path sanity and duplicates.

P1 (coverage balance):

1. Expand ownership/shareholding endpoint families (institutional/insider/deals depth) to reduce reliance on screener-dominant signals.
2. Expand earnings/results endpoint families (estimates revisions, surprise context) to improve event-driven explainability.

P2 (source diversification):

1. Add more non-Trendlyne source families for sectors/industry breadth and market-internals depth.
2. Keep source-tagged reliability scoring mandatory in every screener-derived ranking path.

P3 (operational transparency):

1. Surface section-level “source health” in dashboard diagnostics (per family: freshness + last successful pull + row delta).

## 6) Answer to "all pages and sections" request

Current state is functionally broad:

- Market/indices/stocks/fundamentals/insights/F&O are strongly represented and wired.
- Screeners are very strongly represented (largest by far).
- News/earnings/shareholding are implemented but have noticeably thinner endpoint diversity.

Concrete next best action is not adding more screener URLs, but balancing ownership + earnings + event families and enforcing URL normalization and source health checks.
