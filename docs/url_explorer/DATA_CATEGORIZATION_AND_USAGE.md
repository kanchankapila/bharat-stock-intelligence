# urls.txt Data Categorization & Usage Analysis (2026-08-03)

## Methodology

`urls.txt` (1,983 deduplicated URLs) was normalized via `url_explorer.normalizer` into
**250 distinct endpoint templates** (same host + path-shape + query-key-set collapse to one
template — e.g. 1,053 Trendlyne `screenpk=...` URLs collapsed into a single template).
Every template was then **live-fetched once** (`url_explorer.fetcher`, Chrome-TLS-impersonated
via `curl_cffi`) and the real JSON response **profiled field-by-field**
(`url_explorer.profiler`: dtype, fill-rate, cardinality, NSE-universe overlap — this is the
"format where analysis can be done about each and every field"). Raw data: `field_report.md`
in this directory (4,091 lines, all 250 templates).

**212 of 250 templates returned real data; 38 failed** (confirmed-dead hosts + a handful of
malformed doubled-slash URLs from the original capture, e.g. `https:////priceapi...`).

This is cross-referenced against work **already done in this codebase**:
`src/server/endpoint_registry.py` (29 curated, live-fetchable third-party endpoints, already
wired via `extra_endpoints_fetcher.py` → `extra_features_parser.py` → 14 `ext_*` ML feature
columns on `technical_signals`) and `AI_ENDPOINT_MEMORY.md` (a 671KB doc recording three
rounds of live endpoint testing on 2026-07-30). Where this pass **confirms** that prior work,
it's noted as "already covered." Where it **contradicts or adds to** it, that's called out
explicitly.

---

## THE headline finding: `www.ndtvprofit.com` is alive, not dead

`AI_ENDPOINT_MEMORY.md` (2026-07-30) recorded `www.ndtvprofit.com` as "**403 even with full
browser headers** — real bot-protection (Cloudflare-class)." This pass's fetch — using
`curl_cffi`'s Chrome TLS-fingerprint impersonation rather than a plain `requests`-with-headers
call — got **200 on all 14 templates it produced**, with rich real data:

- `stocks/dashboard?symbol=` — per-stock quote snapshot (`lastPrice`, `prevClose`, `high52Week`/
  `low52Week` + date, `shareOutstanding`, `volume30Avg`)
- `stock-summary?symbol=` — **derivatives basis data**: `spot-price`, `1m-future`/`2m-future`,
  `roll-spread`, `roll-over-percentage`, `open-interest`, `put-call-ratio` — this is NDTV's own
  computed roll/basis metric, independent of `fno_rollover_fetcher.py`'s NSE-bhavcopy-derived one
- `open-interest?duration=&stock=` — per-strike OI + OI-change by expiry
- `stocks/movers` / `markets/summary` / `markets/all-stocks` — market-wide movers and a full
  listed-universe snapshot **with ISIN** (147 rows in the sample fetch)
- `stocks/announcements?exchangeSymbol=` — corporate announcement feed (`subject`, `details`,
  `attachment` PDF links, `broadcastTime`)
- `market-news` — a general news feed with byline/author metadata

**Caveat**: this is a single anecdotal live fetch per template, not a rigorous re-verification
across many symbols/times — the prior "dead" finding may have been a genuine transient block, or
the TLS-impersonation difference may be the real reason. Either way, it's worth a deliberate
re-test (a handful of symbols, a few hours apart) before building a fetcher on it, exactly per
this repo's own `live_datasource` test convention — but it should **not** be written off as
unreachable, which is what the current docs say.

---

## Category breakdown

### 1. Ownership & Institutional Holdings

| Source | Status | Key fields | Recommendation |
|---|---|---|---|
| `marketservices.indiatimes.com/shareholding` | **Wired** → `ext_fii_holding_pct`/`ext_dii_holding_pct`/`_qoq_chg` | `summary.fii/dii.{percentage,changeQoQ}` | Already feeding `ml_ensemble.py`. No action. |
| `mfapps.indiatimes.com/mfsInvestingInStock.htm` | Archived raw only | per-MF-scheme holding list | Parse into a `mf_scheme_breakdown` feature (which specific funds hold this stock, not just aggregate %) — genuinely different from the existing aggregate `mf_holding_pct`. |
| `api.moneycontrol.com/mcapi/v1/deals/insight` (topDeal/topInsider/topInvestor) | **New** (not in registry) | `symbol`, `deal_type`, `deal_price`, `quantity`, `boughtBy`, `sector` | Market-wide "who bought what" ranked feed — richer counterparty detail than `block_deal_fetcher.py`'s NSE pull. Frontend: a "Smart Money — Top Deals This Week" card (`SmartMoneyMonitor.tsx` currently only shows the ownership-% chart, no deal feed). |
| `analyze.api.tickertape.in/stocks/deals` + `/deals/insight` | Already curated (`tickertape_deals`, raw archive) | 659K+ bulk/block records market-wide | Already flagged in `AI_ENDPOINT_MEMORY.md` as richer than NSE's own pull. Not yet parsed into a feature — worth prioritizing given the volume. |
| `investsights.in/api/v2/investors` | **New**, genuinely valuable | `investors.{canonical_name, total_stocks_held, avg_holding_pct, new_entries_count, exits_count, increased_count, decreased_count}` | This is exactly the "superstar investor conviction tracking" gap flagged (and left unbuilt) in the 2026-07-31 endpoint-corpus review. Accuracy: a per-stock "is a tracked superstar investor currently increasing/new-entering/exiting" feature — orthogonal to the existing aggregate FII/DII %. Frontend: a "Superstar Investors" watchlist-style panel, mirroring what Trendlyne/Screener.in-style products call "guru portfolios." |

### 2. Fundamental Financials & Valuation

| Source | Status | Key fields | Recommendation |
|---|---|---|---|
| `etmarketsapis.indiatimes.com/ET_Stats/mobile` (Balance/CashFlow/Ratio) | **Wired** — `financial_ratios_fetcher.py`'s harvest | Confirmed live: 147 merged fields across the 3 event types | Already the source of the 2026-07-23 banking-ratio harvest. No action. |
| `api.tapetide.com/api/v1/companies/{symbol}/{financials}` | Archived raw only (`tapetide_analyst_ratings`/`forecasts` curated; this specific path — 222 fields — is a distinct multi-year time series) | `data.actuals.{ebitda,eps,net_income}.{YYYYMM}` back to 2021 | A clean normalized 5-year EBITDA/EPS/net-income trend, independent of MC/ET's own financials. Cheap cross-validation candidate for `fundamentals_history` — if it disagrees with MC/ET on a given quarter, that's a data-quality signal worth surfacing. |
| `api.moneycontrol.com/swiftapi/v1/stockvitals/historical` (`metric=altman/ohlson/graham/dupont`) | **CORRECTION (2026-08-04): already fully built, before this report was even written** — `mc_stockvitals_history_fetcher.py`, committed 2026-08-02, a day *before* this analysis. It writes into the SAME `proprietary_scores_history` table/`score_type` keys `moneycontrol_fetcher.py`'s existing daily widget scrape already uses (not a second copy — the smarter fix this report's own caution was asking for), deepened altman_z/ohlson_o/graham_number/dupont_score coverage from ~14-16% to ~81-85%, and wired Graham/DuPont into `ml_ensemble.py`. Scheduled monthly in `trendlyneWeekly.jobs.ts`. This report's "needs cross-validation before adding" recommendation was stale at the time of writing — should have grepped for an existing fetcher before flagging it as a gap. | — |
| `investsights.in` fundamentals cluster (`analyst-estimates`, `dcf-valuation`, `growth-metrics`, `pros-cons`) | Curated, archived raw only | DCF fair value, growth-metrics trend, structured pros/cons list | `pros-cons` in particular is ready-made structured content (not raw numbers) — cheap frontend win: render directly as a "Bull Case / Bear Case" card on `StockIntelligencePage`'s Overview tab, no ML parsing needed. |
| `api.moneycontrol.com/mcapi/v1/quarterly-earning/{balance-sheet,peers-comparison}` | Likely already covered by existing MC quarterly-financials usage (389 fields on the balance-sheet variant — full multi-year line-item balance sheet) | Full balance sheet line items | Verify against `stock_fundamentals`/`fundamentals_history` column coverage before treating as new — very likely already the source of existing balance-sheet data via a sibling MC endpoint. |

### 3. Screener & Quantitative Discovery

| Source | Status | Key fields | Recommendation |
|---|---|---|---|
| `kayal.trendlyne.com/.../all-in-one-screener-data-get` (1,053 URLs → 1 template) | **Wired** — `trendlyne_screener_discovery.py` | 243 profiled fields (the full Trendlyne screener column catalog) | Confirmed this is the exact mechanism already syncing `trendlyne_screeners`. No action — this single template accounts for over half of urls.txt's raw URL count. |
| `api.moneycontrol.com/mcapi/v1/{cat}/scanner-detail?catId&scanId` (**220 URLs → 1 template**) | **CORRECTION (2026-08-04): already wired, and had been for a while** — `moneycontrolScreener.ts`'s `MC_SCREENERS`/`syncMoneyControlScreeners()` already hits this exact endpoint (this report's "not wired anywhere found" was simply a missed grep — `moneycontrol.ts`/`moneycontrolScreener.ts` don't have "scanner" prominently in a name this pass searched for). This is the pre-existing "MC-basic" 4th screener provider `confluenceEngine.ts` already blends. Diffing urls.txt's 178 captured (catId,scanId) pairs against the 77 already wired found 24 genuinely new scanIds (after deduping — MC reuses the same scanId across several catId "category" tabs); added, live-verified, and synced. **Found while doing this: `screener_master`'s `scan_id TEXT PRIMARY KEY` has no `source` disambiguation, and 7 of the 24 new MC scanIds collide with existing, live ETnow scanIds** (e.g. MC's "Double Dhamaka" and ETnow's "Warren Buffet Screener" both use scan_id 173) — see the memory/CLAUDE.md note for the full writeup; flagged for a decision rather than fixed unilaterally, since a real fix is a schema migration touching every screener-provider sync + `confluenceEngine.ts`. |
| `trading80_header_info` / `marketsmojo_header_info` | **Wired**, but confirmed duplicate (per `AI_ENDPOINT_MEMORY.md`, and I did not re-verify byte-identity this pass) | `dot_summary.{tech_score,q_rank,v_rank,f_pts}` | No action — do not add a 3rd copy. |
| `www.trading80.com/technical_card/getCardInfo` | Curated (`trading80_technical_card`), archived raw only | **136 fields**: RSI/MACD/Bollinger/MA/KST/DOW/OBV, each split weekly vs. monthly, each with its own score | This is a genuinely richer technical composite than the header_info dot_summary already parsed — 7 independent technical sub-scores × 2 timeframes, unparsed. Worth a dedicated parser pass into `ext_t80_*` if `factor_edge.py` eventually validates the existing `ext_t80_tech_score` has edge. |
| `screener-api.tapetide.com/api/screener/trending` | **New**, not in registry | Ticker-keyed (confirmed `yes`), 50 fields | A ranked "trending stocks" screener — worth a quick look at what ranking criterion it uses before deciding whether it's redundant with existing momentum/volume screeners. |
| `frapi.marketsmojo.com/optimizer_Portfoliodignostic/getMojostocksHist` | Curated (`marketsmojo_stock_picks_history`), archived raw only | Real entry/exit dates + realized returns of MarketsMojo's own model portfolio | Already flagged in `AI_ENDPOINT_MEMORY.md` as a `factor_edge.py` candidate ("does this third party's own picks have edge") — same treatment `m_score` got (which came back **negative**). Don't build a feature on this until that check runs. |

### 4. Price & Technical Charts

| Source | Status | Recommendation |
|---|---|---|
| `priceapi.moneycontrol.com/techCharts/.../history` (all resolutions) | **Wired** — `mc_ohlcv_backfill.py`/`intraday_fetcher.py` | No action. |
| `priceapi.moneycontrol.com/technicalCompanyData/categoryTechnicalTrend/.../sector` | **New** — 386 fields, ticker-keyed | MC's own pre-computed **sector-level technical trend classification**. This platform already computes cross-sectional sector rotation independently (`relative_strength.py`, Trendlyne sector-rotation); this is a candidate for cross-validation, not a first-choice addition — check agreement before wiring. |
| NDTV Profit `stocks/graph`, `stock-summary` (basis/PCR), `open-interest` | **New**, see headline finding above | See recommendation above — independent futures-basis and per-strike OI source, useful either as a cross-check against `fno_rollover_fetcher.py`/NiftyTrader OI or (if that source proves reliable) a redundancy source the way `intraday_fetcher.py` already dual-sources MC+Yahoo. |

### 5. Analyst Estimates & Price Targets

| Source | Status | Recommendation |
|---|---|---|
| `api.moneycontrol.com/mcapi/v1/stock/estimates/*` (price-forecast/consensus/analyst-rating/earning-forecast/valuation/hits-misses) | **Wired** — existing `getMcAnalystRating`/`getMcEarningsForecast`/`getMcPriceForecast`/`getMcConsensus` tRPC procedures per this codebase's router inventory | No action — this cluster is already fully surfaced. |
| `tapetide_analyst_ratings` / `tapetide_forecasts` | Curated, archived raw only | Cross-validate against existing MC analyst consensus before adding as a second source — same duplication caution as elsewhere in this cluster. |
| `investsights.in/api/v2/fundamentals/{symbol}/analyst-estimates` | **New** | 25 fields — a third independent analyst-estimate source. Same caution: check overlap before adding. |

### 6. News, Filings & AI Sentiment

| Source | Status | Key fields | Recommendation |
|---|---|---|---|
| `www.moneycontrol.com/newsapi/mc_news.php` | Partially wired (per-stock news via `getMcStockNews`, per the 2026-07-31 `mc_stock_news_endpoint` work) — but this template is a **search-query** variant (`query=tags_slug:...`), 529 fields, likely a different, broader news-search surface than the per-stock one already wired | Check whether this is the same underlying endpoint the existing `McNewsCard.tsx` already covers, or a genuinely separate market-wide news search worth a "Market News Search" frontend feature. |
| `investsights.in/api/v2/news` | **New** | `title`, `summary`, `content`, `symbols`, `sentiment_score`, `sentiment_explanation`, `subcategory` | **Already AI-sentiment-scored, per-article, with an explanation string** — this is a materially richer, already-labeled sentiment feed than this codebase's own FinBERT pipeline has to compute itself. Accuracy: a genuinely new, orthogonal sentiment feature (`ext_is_news_sentiment`) if cross-validated against FinBERT scores. Frontend: could populate `SentimentIntelligence.tsx`/the News tab with pre-written sentiment explanations instead of just a numeric score. |
| `investsights.in/api/v2/concall/recent` | **New, high-value** | `key_takeaway`, `tone_assessment`, `quarter`, `fiscal_year`, per company | This is **exactly** the "unstructured-text LLM edge" opportunity CLAUDE.md's own quant-strategy audit (2026-07-30/31) flagged as the one legitimate place an LLM layer earns its keep — and InvestSights has apparently already built it (AI-generated concall tone/takeaway), third-party. Worth evaluating as a bounded, timestamped component score feeding `unified_ranker.py` (per that audit's own stated constraint: never a free-floating verdict) rather than building an in-house concall-NLP pipeline from scratch. Frontend: a "Latest Earnings Call Takeaways" panel — genuinely new content type, nothing like it exists in this frontend today. |
| `investsights.in/api/v2/market-pulse/items` / `market-pulse/stock/{symbol}/documents` | **New** | Corporate-announcement feed with `has_ai_analysis`/`has_ai_research` flags | Overlaps conceptually with NSE corporate announcements + MC news; worth checking for genuinely unique coverage (e.g. does it catch filings MC/NSE fetchers miss) before treating as redundant. |
| `www.ndtvprofit.com/market-news`, `/{blog-id}` | **New**, see headline finding | Standard news feed, byline metadata | Lower priority — this codebase already has 3+ news sources; only worth adding if a coverage gap is demonstrated. |

### 7. General Market Metadata / Macro & Sector

| Source | Status | Recommendation |
|---|---|---|
| `investsights.in/api/v2/market/sector-rrg` | **New, high-value** | A genuine **Relative Rotation Graph** (`rs_ratio`, `rs_momentum`, `quadrant` — Leading/Weakening/Lagging/Improving, the standard RRG framework) computed by a third party. This platform's own sector rotation is `relative_strength.py`'s cross-sectional rank — RRG's quadrant classification is a different, well-known professional framework. Frontend: a genuinely new visualization — no RRG chart exists anywhere in this app's Sector Intelligence tab today; this would be a distinctive, recognizable addition for anyone familiar with the RRG concept from other platforms. |
| `investsights.in/api/v2/market/sector-correlation` | **New** | Full sector×sector correlation matrix + explicit "diversifiers"/"redundant pairs" lists | Directly useful for the platform's own position-sizing/sector-cap logic (`unified_ranker.py`'s `MAX_SECTOR_EXPOSURE` cap, added 2026-07-30 as a first-order approximation) — a real correlation matrix is the "fuller fix" that audit note explicitly flagged as future work. |
| `investsights.in/api/v2/market/index-valuation`, `economic-events`, `economic-indicators` | **New** | Index-level PE/valuation bands, forward economic calendar, macro indicator series | `economic-events`/`economic-indicators` overlaps with the existing macro-snapshot work (`mc_global_macro_fetcher.py`, `getMacroSnapshot` pre-market briefing in `MarketCommandCenter`) — worth checking for gaps rather than replacing. |
| `frapi.marketsmojo.com/apiv1/markets/indices` | **New** | 64-71 fields across a large `index_ids` batch | Likely redundant with existing MC/NSE index feeds — lower priority. |
| `api.tickertape.in/mmi/now` (Market Mood Index) | **New**, not in registry | 75 fields | India's best-known retail sentiment gauge (analogous to CNN's Fear & Greed Index) — **nowhere in this codebase or frontend today** (confirmed via grep). Cheap, high-visibility frontend win: a single gauge widget on the Dashboard/`MarketCommandCenter` header, next to the existing regime/breadth indicators. Accuracy use is secondary (one scalar, likely low marginal value over existing breadth/regime features) but the frontend value is real and the integration cost is small (single unauthenticated GET, no per-stock resolution needed). |

### 8. Derivatives & F&O Analytics

| Source | Status | Recommendation |
|---|---|---|
| `webapi.niftytrader.in/*`, `api.moneycontrol.com/mcapi/v1/fno/*`, `smartoptions.trendlyne.com/.../filter` | **Wired** — extensive existing `nt_*.py`/`so_option_chain_fetcher.py`/`fno_rollover_fetcher.py` coverage | Confirmed via this pass's fetch — all working, all already-covered categories. No action, but note the `smartoptions.../filter` URLs in this batch carry a stale hardcoded `expDate=2026-05-26` (an expired date) — per the 2026-07-31 endpoint-corpus finding, an expired `expDate` on this exact endpoint returns 200 with real OI but **NULL IV and all-zero Greeks**, which is silently wrong, not absent. If any future fetcher is built off URLs captured in `urls.txt` directly (rather than the existing live-expiry-resolving fetchers), it must resolve the expiry live, never reuse the captured date. |
| `www.ndtvprofit.com/open-interest`, `stock-summary` (PCR/basis) | **New**, see headline finding | Independent F&O cross-check source, see Category 4. |

---

## Confirmed dead / blocked (this pass, live-tested)

`ticker.finology.in` (all templates failed), `oxide.sensibull.com` (all failed — matches prior "401 invalid platform access token" finding), `mseindia.com`, `www.bloombergquint.com`, `api.niftytrader.in` (retired subdomain — `webapi.niftytrader.in` is live and already used), `ai-chat.tapetide.com` (all failed — matches prior 401 finding), plus several malformed doubled-slash URLs from the original capture (`https:////...`) that are broken by construction, not a real endpoint failure.

## Do NOT re-build (already covered, confirmed again this pass)

Trendlyne screener catalog (`kayal.trendlyne.com`), Trendlyne per-stock overview/adv-technical/price-performance, MC OHLCV history at all resolutions, MC analyst-estimates cluster, NiftyTrader/MC/Trendlyne F&O surfaces, ET_Stats Balance/CashFlow/Ratio harvest, MC per-stock news (`getMcStockNews`), `ext_fii_holding_pct`/`ext_t80_*`/`ext_mojo_*`/`ext_is_*`/`ext_tt_*` ML features.

---

## Prioritized recommendations

1. **`investsights.in/api/v2/investors`** (superstar-investor tracking) — closes a named, previously-flagged gap. Low integration cost (symbol-keyed, no ID resolver needed, matches existing `investsights_*` pattern in `endpoint_registry.py`).
2. **`investsights.in/api/v2/concall/recent`** (AI-scored earnings-call takeaways) — directly matches this codebase's own stated LLM-integration philosophy (bounded, timestamped, non-authoritative component score) and adds a content type genuinely absent from the frontend.
3. **`investsights.in/api/v2/market/sector-rrg` + `sector-correlation`** — a recognized professional framework (RRG) not present anywhere in this app, plus a real correlation matrix that upgrades the existing first-order sector-exposure cap.
4. **`api.tickertape.in/mmi/now`** — trivial integration cost, real frontend visibility (a well-known sentiment gauge), for a Dashboard/MarketCommandCenter header widget.
5. **`api.moneycontrol.com/mcapi/v1/deals/insight`** (topDeal/topInsider/topInvestor) — feeds a "Smart Money — Top Deals" card that `SmartMoneyMonitor.tsx` currently lacks.
6. **Re-test `www.ndtvprofit.com`** properly (a `live_datasource` test, a few symbols, spread over a few hours) before deciding whether to build on it — this pass's single fetch contradicts the existing "dead" record and that contradiction needs resolving one way or the other, not just noting.

**Explicitly not recommended without further work**: MC's 220-scanner screener surface and any new screener source in general (this codebase's own 2026-07-30/31 audits found the *existing* screener weighting is already miscalibrated against measured forward returns — adding a 5th source compounds that risk before it's fixed); anything in the "cross-validate before adding" list above (Trading80/MarketsMojo duplicates, MC's Ohlson/Dupont/Altman/Graham historical scores vs. this codebase's own independently-computed Altman Z/Piotroski, Tapetide's financials vs. MC/ET's).
