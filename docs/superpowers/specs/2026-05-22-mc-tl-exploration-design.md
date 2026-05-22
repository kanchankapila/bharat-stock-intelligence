# Design: MoneyControl + Trendlyne Data Exploration Script

**Date:** 2026-05-22  
**Status:** Approved  
**Phase:** 1 of 2 — Exploration (Phase 2 = production integration plan, after data review)

---

## Goal

Fetch and store raw API responses from all known MoneyControl and Trendlyne endpoints into a standalone SQLite database. After the run, produce a summary report showing which endpoints returned data, what the response shapes look like, and which are gated/empty. This drives the Phase 2 integration plan.

---

## Approach

Two-stage process:
1. **Python async exploration script** — fetches all URLs, stores raw JSON + metadata
2. **Data review** — read the summary report, decide which endpoints are production-worthy
3. (Future) **TypeScript production integration** — only for endpoints confirmed to return useful data

---

## Database

**File:** `mc_tl_explore.db` (project root, gitignored)

**Table:** `api_responses`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `domain` | TEXT | `moneycontrol` or `trendlyne` |
| `category` | TEXT | `indices`, `stock_detail`, `screeners`, `deals`, `earnings`, `premarket`, `tech_trends`, `fno`, `mf` |
| `subcategory` | TEXT | Fine-grained label e.g. `index_overview`, `proscanner`, `techscanner` |
| `url` | TEXT | Full URL as called |
| `http_status` | INTEGER | HTTP status code; NULL on network error |
| `latency_ms` | INTEGER | Request round-trip time |
| `top_keys` | TEXT | JSON array of top-level response keys (pre-extracted for report) |
| `item_count` | INTEGER | Length of primary list in response, if any |
| `raw_json` | TEXT | Full response body |
| `error_msg` | TEXT | Exception message if request failed |
| `fetched_at` | TEXT | ISO timestamp |

---

## URL Registry

All endpoints are defined as `EndpointSpec` dicts with `domain`, `category`, `subcategory`, and `url`. Parameterized patterns are expanded at script startup.

### MoneyControl — Indices (~760 calls across 40 indices)

| Subcategory | Pattern | Calls |
|---|---|---|
| `index_overview` | `appfeeds.../market/indices&ind_id={id}` | 40 |
| `index_pricefeed` | `priceapi.../pricefeed/notapplicable/inidicesindia/{symbol}` | 40 |
| `index_marketmap_stocks` | `appfeeds.../marketmap&type=0&ind_id={id}` | 40 |
| `index_marketmap_industries` | `appfeeds.../marketmap&type=1&ind_id={id}` | 40 |
| `index_marketmap_type2` | `appfeeds.../marketmap&type=2&ind_id={id}` | 40 |
| `index_graph` | `appfeeds.../graph&ind_id={id}&range={range}&type=line` — ranges: 1d,5d,1m,3m,6m,1yr,2yr,5yr,max | 40×9=360 |
| `index_technicals` | `priceapi.../techindicator/{period}/{symbol}` — D/W/M | 40×3=120 |
| `index_fundamentals_overview` | `api.../indices/fundamentals/overview?indId={id}` | 40 |
| `index_fundamentals_eps` | `api.../indices/fundamentals/epsdetail?indId={id}` | 40 |
| `index_fundamentals_pe` | `api.../indices/fundamentals/graph/pe?indId={id}&duration=1Y` | 40 |
| `index_fundamentals_pb` | `api.../indices/fundamentals/graph/pb?indId={id}&duration=1Y` | 40 |
| `index_historical_rating` | `moneycontrol.com/mc/widget/historicalrating?indice_id={symbol}&period={D/W}` | 40×2=80 |
| `advance_decline` | `api.../indices/chart/exchange-advdec?ex=N` | 1 |
| `indices_list` | `api.../indices/get-indices-list`, `get-indian-indices` | 2 |

### MoneyControl — Stock Detail (BE03 only, ~35 calls)

| Subcategory | Endpoints |
|---|---|
| `stock_price` | equitycash, price-volume, get-stock-price batch |
| `stock_technicals` | techindicator D/W/M, technicals/v2/details D/W/M, rating_summary D/W/M, moving_average D/W/M, technical_indicator D/W/M, moving_average_crossovers D/W/M, pivot_level D/W/M |
| `stock_historical_rating` | historicalrating/ratingPro D/W/M |
| `stock_swot` | swot/details |
| `stock_essentials` | mc-essentials, mc-insights type=c and type=d |
| `stock_estimates` | price-forecast, consensus, analyst-rating, earning-forecast, valuation, hits-misses |
| `stock_fno` | getFuturesData, getOptionsData, getStrikePrice, getExpDts |
| `stock_financial` | financial-historical/overview |

### MoneyControl — Market Intelligence (~73 calls)

| Subcategory | Endpoints | Calls |
|---|---|---|
| `tech_trends` | bullish/turning-bullish/bearish/turning-bearish × index=7,FNO,LCAP,MDCAP,SMCAP | ~20 |
| `deals` | large deals, top stock, sector-wise, insight buy/sell, largedeals-insight | ~10 |
| `earnings` | inc-widget, price-shockers, actual-estimate, rapid-results, get-earnings-data, result-calendar, result-dashboard | ~8 |
| `premarket` | articles (5 slugs), global-marketdata, ecalendar, getMarketViewsData, getFllActivityData, getStockToWatchData, getMarketNewsData, getBrokerResearchReco | ~15 |
| `news` | deals/get-stock-news, newsapi query | ~2 |

### MoneyControl — Screeners (~170 calls)

| Subcategory | Calls |
|---|---|
| `proscanner` (catId 1-9 × scanIds) | ~130 |
| `techscanner` (catId 17, 25 × scanIds) | ~40 |

### Trendlyne (~80 calls)

| Subcategory | Endpoints | Calls |
|---|---|---|
| `tl_json_screener` | json-screener/{id}/5/0/index/NIFTY500 — 30 screener IDs | 30 |
| `tl_allone_screener` | tl-all-in-one-screener-data-get/?screenpk={id} — bullish (27 IDs) + bearish (10 IDs) | 37 |
| `tl_fno_filter` | futures-options/api-filter/ — gainers, most active, OI | ~10 |
| `tl_mf` | mutual-fund/getMFhome/?category= | 2 |
| `tl_custom_query` | all-in-one-screener-data-get with custom query strings | ~4 |

**Total: ~1,100 calls**

---

## Fetch Engine

- **Library:** `aiohttp` + `asyncio`
- **Concurrency:** `asyncio.Semaphore(10)`
- **Timeout:** 10 seconds per request
- **Headers:**
  ```
  User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
  Referer: https://www.moneycontrol.com
  Accept: application/json, text/plain, */*
  ```
- **Auth:** None — failed/gated responses stored with error_msg, script never aborts
- **DB writes:** Batched in groups of 50 rows via `executemany`

---

## Summary Report

Printed to stdout after all fetches complete. Format:

```
=== MC + TL EXPLORATION SUMMARY ===
Total calls : 1,100
Success     : 982   (http 200 with non-empty body)
Failed      : 87    (non-200 or network error)
Empty       : 31    (200 but empty/null body)
Runtime     : 61s

CATEGORY BREAKDOWN
domain          category        subcategory              total  ok  fail  empty  avg_ms  sample_top_keys
moneycontrol    indices         index_overview              40  38     2      0     312  [data, indicesData, change]
moneycontrol    indices         index_graph                360 340    15      5     280  [graphData, points]
moneycontrol    screeners       proscanner                 130  95    20     15     445  [scan_result, stocks, total]
trendlyne       screeners       tl_json_screener            30  28     1      1     520  [data, total, columns]
...

FAILURES BY STATUS
403  → 45 URLs  (auth-gated, list follows)
500  → 12 URLs
timeout → 30 URLs

EMPTY RESPONSES
moneycontrol  proscanner  catId=9 scanId=525  →  {}
...
```

---

## File

**Script:** `src/server/explore_mc_tl.py`  
**Output DB:** `mc_tl_explore.db` (project root)  
**Add to `.gitignore`:** `mc_tl_explore.db`

---

## Out of Scope (Phase 1)

- No tRPC endpoints or frontend changes
- No schema migrations to the live app DB
- No per-stock expansion beyond BE03
- No cookie/session auth injection

---

## Success Criteria

- Script runs to completion without crashing
- All ~1,100 URLs attempted and stored
- Summary report clearly identifies: which categories returned rich data, which are gated, which are redundant
- Ready to hand off findings into a Phase 2 production integration plan
