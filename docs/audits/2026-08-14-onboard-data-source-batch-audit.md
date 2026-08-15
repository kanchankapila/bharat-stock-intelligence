# 2026-08-14 — onboard-data-source batch: already-onboarded, registry health audit

## What was asked

`/onboard-data-source` invoked with a ~250-URL batch (Indiatimes/ET, Finology, MarketsMojo,
Trading80, NiftyTrader, StockEdge, Trendlyne, Tickertape, MoneyControl, NSE, Sensibull, MSE).

## First finding: this is not a new batch

The pasted URLs are **`src/server/urls_sample.json`** (857 entries), already committed to this
repo. Confirmed by exact match, not inference:

- The first two URLs in the paste (`marketservices.indiatimes.com/.../shareholding?companyid=11945`,
  `mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm?...companyid=11984...`) are the literal
  first two entries in `urls_sample.json`, same order, with the same `description` fields attached.
- Spot-checked 8 distinctive fragments from deep in the truncated portion of the paste
  (`smartoptions.trendlyne.com`, `oxide.sensibull.com`, `kayal.trendlyne.com`, sample tickers
  `RLXO`/`WSL`/`JKIN`) — all present in `urls_sample.json`.
- `git log --follow` on `urls_sample.json` shows one commit: `8d8e1b9` (2026-07-30), "Add
  validated endpoint registry, live-test and integrate 29 new extra-data endpoints, fix 2 real
  ML-feature bugs" — the same commit that built `src/server/endpoint_registry.py`.

This batch already went through Phases 1-8 of this skill, across at least three sessions
(2026-07-30 initial pass, 2026-08-03 "Round 4", and an undated later round — see
`docs/session-log.md` lines 519-522 and 713). Re-running the full skill top-to-bottom on it
would rebuild what already exists. Per the user's direction, this pass is a **live health audit**
of that existing system instead — not a re-onboarding.

## The system these URLs feed

`ai_endpoint_memory.json` (root, 1024 entries) is a separate, AI-fabricated discovery catalogue
— its URLs use literal `"default"` placeholders (`from=default&to=default&currencyCode=default`),
not real captured requests. `urls_sample.json` is the real reference: real captured URLs with
real parameter values, used by `endpoint_registry.py`'s `ReferenceValueIndex` to fill in sample
values when validating/rendering `ai_endpoint_memory.json`'s templated ones. **Do not confuse the
two files** — `ai_endpoint_memory.json` is bulk-discovered and mostly unusable as-is (see below);
`urls_sample.json` is the vetted source of truth this user's batch actually is.

Pipeline: `endpoint_registry.py` merges both files into one registry (synced to the
`ai_endpoint_registry` table), validates each URL (renders it, checks method/format support,
flags unfilled `default` placeholders), and marks a small hand-vetted subset
`enabled=True, parser_ready=True` — `CURATED_EXTRA_ENDPOINTS`, 34 entries. Only those 34 are
ever actually fetched. `extra_endpoints_fetcher.py` fetches them (`--scope daily` = the 5
per-stock endpoints `extra_features_parser.py` reads, nightly; `--scope weekly` = the other 29,
to keep the raw corpus warm) into `extra_endpoint_responses`. `extra_features_parser.py` parses
the 5 daily ones into `technical_signals.ext_*` columns.

## Live-verified health (queried against production Postgres, 2026-08-14)

**Registry composition:**

| Source | Count | Enabled+parser_ready+valid |
|---|---|---|
| `curated_extra` (hand-vetted, from `urls_sample.json`) | 34 | 34 (all of them) |
| `ai_memory` (bulk-discovered, from `ai_endpoint_memory.json`) | 1024 | 0 |

Of the 1024 `ai_memory` entries, 654 are `validation_status='invalid'`: 488 have an unfilled
`default` placeholder param, 84 use an unsupported data format, 82 use an unsupported HTTP
method (some overlap across categories). This is not a new problem — `ai_memory` was always
meant as a wide, low-confidence net that `curated_extra` cherry-picks from; the 0-fetchable
number confirms none of it has been promoted since the last round, which matches the "archive
first, prove value" convention documented in the registry file's own comments.

**Fetch pipeline — all 34 curated endpoints wired and current:**

`extra_endpoint_responses`: 1,996 rows, latest `updated_at` 2026-08-14T18:56. Every one of the
34 curated `endpoint_name`s has rows (zero curated-but-never-fetched, zero fetched-but-uncurated
— clean 1:1). The 5 daily-parsed endpoints (`marketservices_shareholding`,
`trading80_header_info`, `marketsmojo_header_info`, `investsights_score`, `tapetide_score`) are
freshest (2026-08-14); the 29 weekly ones trail by a few days, consistent with their cadence.

**Feature-column population — the actual thing the 2026-08-12 SIGKILL bug broke, now confirmed
fixed and holding:**

`technical_signals` on the last completed trading day (2026-08-13, 2,189 grid rows):

| Column | Populated | % |
|---|---|---|
| `ext_fii_holding_pct` | 1,592 | 72.7% |
| `ext_t80_tech_score` | 1,534 | 70.1% |
| `ext_t80_quality_rank` | 1,011 | 46.2% |
| `ext_mojo_quality_rank` | 1,011 | 46.2% |
| `ext_is_overall_score` | 1,658 | 75.7% |
| `ext_tt_score` | 1,633 | 74.6% |

Non-zero, in the range the registry's own `technical-signals-feature-coverage` check treats as
healthy (baseline 53/302 dead columns platform-wide as of 2026-08-13). `queues.ts` confirms the
fetch and parse steps are separate (`extra_endpoints_fetcher.py` then `extra_features_parser.py`
as independent `runPython` calls, each with its own `.catch()`) — the exact fix
`recurring-bugs.md`'s "step that only runs at the end of a script that routinely gets killed"
entry documents. Both `test_endpoint_registry.py` (7 tests) and `test_extra_features_parser.py`
(14 tests) pass as of this audit.

**Freshness monitoring:** `extra-endpoint-responses-recency` (warns >10 days) and
`technical-signals-feature-coverage` (a generic `jsonb_each` dead-column-count regression guard,
not a hand-enumerated list) are both present in `dataQualityChecks.ts` and currently green.

## Real gap found: 10 of 34 curated endpoints are archived-only, never consumed

`CURATED_EXTRA_ENDPOINTS` has 14 market-wide entries (`scope="market"`, `symbol='MARKET'` in
`extra_endpoint_responses`). Of those, 4 got a dedicated structured fetcher + table in a later
round and are live with real recent data:

| Endpoint | Table | Rows |
|---|---|---|
| `investsights_sector_rrg` | `sector_rrg_history` | 1,039 |
| `investsights_sector_correlation` | `sector_correlation_pairs` | 1,330 |
| `mc_deals_insight_top_investor` | `institutional_deal_signals` | 282 |
| `investsights_concall_recent` | `concall_takeaways` | 191 |

The other **10 market-wide endpoints have never been parsed past the raw JSON blob** —
freshly fetched (most as recent as 2026-08-14) but sitting inert in `extra_endpoint_responses`,
read by nothing:

`investsights_investors_list`, `marketsmojo_marketaction`, `marketsmojo_results_corner`,
`marketsmojo_stock_picks_history`, `stockedge_high_delivery_qty`, `tickertape_deals`,
`tickertape_mmi`, `trading80_call_alerts`, `trendlyne_market_insight`, `trendlyne_mf_home`.

Two of these look like the highest-value misses, by their own session-log framing:
- **`tickertape_mmi`** — India's retail Fear & Greed-style sentiment gauge, noted at the time
  as absent from the whole codebase/frontend, still not surfaced anywhere.
- **`tickertape_deals`** — 659,545 bulk/block deal records live-verified at addition time,
  described as "materially richer" than `block_deal_fetcher.py`'s existing NSE-sourced pull;
  still nothing reads it.

This is not a bug — it's the registry's own stated "archive first, prove value before parsing"
policy working as designed — but it is real, current backlog: data being paid for in fetch cost
every week with zero downstream consumer. Flagging per the user's "document issues and
findings" ask; not fixing here (parsing any of these into a real feature is scoring/ML-adjacent
and per `measurement.md`/`recurring-bugs.md` needs its own live-verified pass and, if it's ever
wired toward `unified_ranker.py`, backtest evidence — out of scope for a health audit).

## Batch summary (per the skill's required format)

| URL / provider-group | What it is | Status | ML verdict |
|---|---|---|---|
| Indiatimes/ET (`marketservices`, `mfapps`, `json.bselivefeeds`, `etmarketsapis`, `sas.indiatimes`, `economictimes`, `etspeedapicache`) | Ownership/holdings, technical screeners, sector/index summaries, news | Mixed: 4 curated+live (`marketservices_shareholding`, `mfapps_mfsInvestingInStock`, `et_companypagedata`, `et_bsensejson`); most of the rest never promoted from `ai_memory` (unvalidated) | `ext_fii_holding_pct`/`ext_dii_holding_pct` etc. already feeding `technical_signals`, unmeasured for edge — no `factor_backtest.py` run on file |
| Finology (`ticker.finology.in/*`) | Shares, peers, volume, prices, news, valuation | **Rejected 2026-07-30, live-confirmed 403 even with full browser headers** — dead source, not pursued further | N/A |
| MarketsMojo (`frapi.marketsmojo.com/*`) | Market action, gainers/losers, quality/valuation cards, results corner, stock picks history | 6 curated+live incl. `marketsmojo_header_info` (feeds `ext_mojo_*`, **confirmed byte-identical to Trading80's `dot_summary` for 15/15 sampled stocks — not an independent signal**) | Already flagged not diversified vs. `ext_t80_*` in the parser's own code comment |
| Trading80 (`frapi.trading80.com`, `www.trading80.com`) | Header info (tech/quality/valuation scores), technical card, call alerts | 3 curated+live | `ext_t80_*` feeding `technical_signals`, unmeasured |
| NiftyTrader (`api.niftytrader.in`, `webapi.niftytrader.in`) | Gap analysis, option chain, FII/DII, symbol lists | **Not part of this registry** — already has its own dedicated `niftytraderService.ts`/`niftytraderAuthService.ts` + 5 `nt_*_fetcher.py` files (separate, pre-existing integration, unrelated to `endpoint_registry.py`). `api.niftytrader.in` itself confirmed 404/retired; `webapi.niftytrader.in` is the live host and is what those fetchers use. | N/A — out of this audit's scope |
| StockEdge (`api.stockedge.com`) | Alerts, technical indicators, sector peers, high-delivery-qty | 1 curated+live (`stockedge_high_delivery_qty`); 3 of 6 candidate market-wide URLs 404'd live and were dropped; per-stock endpoints deliberately not promoted (no symbol→StockEdge-id resolver exists) | Archived-only, never parsed (see gap above) |
| Trendlyne (`trendlyne.com`, `kayal.trendlyne.com`, `smartoptions.trendlyne.com`) | F&O screeners, fundamentals screeners, market insight, MF home | 2 curated+live; the ~35 `fundamentals/json-screener/{id}` paths are the same screenpks `trendlyne_screener_discovery.py` already syncs (confirmed by cross-referencing 6 sampled ids against the live `trendlyne_screeners` table); `overview-second-part`/`adv-technical-analysis`/`price-performance-analysis` already fetched verbatim by dedicated fetchers | Already-covered, no new work |
| Tickertape (`api.tickertape.in`, `analyze.api.tickertape.in`, `quotes-api.tickertape.in`) | Financials, estimates, deals, MMI, scorecards | 5 curated+live | `tickertape_deals`/`tickertape_mmi` archived-only, see gap above |
| MoneyControl (`api.moneycontrol.com`, `priceapi`, `appfeeds`, `www.moneycontrol.com/mc/widget/*`) | Huge surface — price/technicals/estimates/deals/earnings/seasonality | 1 curated+live (`mc_deals_insight_top_investor`, now feeding `institutional_deal_signals`); the rest already covered by ~20 existing `mc_*_fetcher.py` files; `mc/widget/*` paths confirmed live-tested as HTML fragments, not real JSON APIs — correctly excluded | Already-covered |
| NSE (`www.nseindia.com`) | Pre-open, market status, event notifications | Not in this registry; NSE has its own session-warmed fetchers elsewhere (`nse_bhavcopy_fetcher.py`, `preopen_fetcher.py`, `index_membership_fetcher.py`) | Out of scope |
| Sensibull (`oxide.sensibull.com`), MSE (`mseindia.com`), BloombergQuint (`bloombergquint.com`) | FII/DII cash, IV charts; MSE ticker; research reports | Present in `urls_sample.json`'s 857 but **not found in `CURATED_EXTRA_ENDPOINTS`** — never promoted, no live-test on record | Unassessed — genuinely open item if the user wants it pursued |
| InvestSights, Tapetide (`investsights.in`, `api.tapetide.com`) | Scores, PE bands, DCF, growth, pros/cons, forecasts, sector RRG/correlation, concalls | 12 curated+live, richest single provider in this batch; PE-band endpoint noted elsewhere (memory: `investsights_tier1_fetchers_2026_08_14`) as having gone dark mid-session on a *different*, later onboarding pass — not the same fetcher as this registry's `investsights_pe_band`, did not re-check that specific one live in this audit | 2 already feed `feature_store`-adjacent `ext_is_*` columns; forecasts/growth/pros-cons archived via per-stock tables, unmeasured for edge |

**Not re-verified live in this pass** (would need individual `curl`s, out of scope for a
registry-health audit): whether every one of the 34 curated URLs still returns 200 today vs.
when originally live-tested — the freshness check (`extra-endpoint-responses-recency`, currently
green) is the standing proxy for that, and catches drift within its 10-day window.

## Bottom line (initial pass)

Nothing to build. The batch is `urls_sample.json`, already fully processed across 3+ prior
sessions into a working, monitored, tested pipeline. Live-verified this session: fetch → parse
→ feature-column population is healthy end-to-end as of 2026-08-13/14, confirming the
2026-08-12 SIGKILL fix (`recurring-bugs.md`) is holding. One real, current gap: 10 of 34
curated market-wide endpoints (notably `tickertape_mmi`, `tickertape_deals`) are fetched weekly
and archived but never parsed into any usable table — flagged, not fixed, per the user's
"document issues and findings" scope. Sensibull/MSE/BloombergQuint URLs in the original batch
were never promoted to curated status at all — a genuinely open item if pursued further.

## 2026-08-15 follow-up: closing the archived-only gap

The user asked to onboard the flagged gaps. Before building anything, re-verified the batch
had zero genuinely new URLs: normalized host+path comparison of the full pasted list against
the root `urls.txt` (1,983 lines, the master corpus `urls_sample.json`/`urls.normalized.txt`
are both derived from) found **0 of 318 distinct host+paths missing** — confirming again this
is not new data, just under-parsed data.

Of the 10 archived-only market-wide endpoints, **2 turned out to already be properly covered
by dedicated fetchers that predate the registry entry** — caught by checking before building,
not assumed:

| Endpoint | Already covered by | Detail |
|---|---|---|
| `tickertape_mmi` | `mmi_fetcher.py` → `macro_asset_prices` (`symbol='INDIA_MMI'`) | Live-verified fresh through 2026-08-14, wired in `queues.ts`. The registry's curated entry is a harmless duplicate archive, not a gap. |
| `tickertape_deals` | `tickertape_deals_fetcher.py --insider` → `block_deals` | Wired into `ml-daily-ops`, own freshness check (`bulk-deals-recency`). Session-log's own 2026-07-31 note ("richer than the raw NSE pull") was the trigger for building this fetcher — the gap was already closed. |

Built 3 new fetchers for the remaining genuinely-uncovered ones, each following the
`institutional_deals_fetcher.py` pattern (fetch fn / parse fn / store fn kept separate,
`ON CONFLICT` upsert, real regression + `live_datasource` tests, live-verified against
production, freshness check added):

| Fetcher | Table | Live-verified rows | Notes |
|---|---|---|---|
| `stockedge_high_delivery_fetcher.py` | `stockedge_high_delivery_alerts` | 5/5 stored | `Symb` is already a real NSE ticker — no id resolution needed. Same construct as the already-dead `delivery_spike`/`delivery_trend` factors in `measurement.md` — archived for cross-check value, not expected to have edge. |
| `trading80_call_alerts_fetcher.py` | `trading80_call_alerts` | 9/10 (`new`) + 9/10 (`changes`) | **Found a real upstream quirk while building, not while reviewing**: every `changes`-list row carries `id: null` — the `new` list has real ids. Initial version silently dropped all 10 `changes` rows (0 stored). Fixed with a `stockid:calltime` composite-key fallback instead of fabricating an id; re-verified live, 9/10 now store. Vendor's own calls — do not wire into scoring without a backtest, per docstring. |
| `marketsmojo_stock_picks_fetcher.py` | `marketsmojo_stock_picks` | 5/5 stored | MarketsMojo's own model-portfolio picks (entry/exit price, running P&L) — genuinely distinct from their `dot_summary` score. Reuses `trading80_call_alerts_fetcher.py`'s `load_sid_to_symbol_map()` rather than re-deriving it (same shared `stockid` space). |

**Rejected, with reasons — not built:**

| Item | Reason |
|---|---|
| `marketsmojo_results_corner` | Its per-row `dotsum` block is the identical `q_rank`/`v_rank`/`f_pts`/`tech_score` fields `marketsmojo_header_info` already captures for the full ~1,831-stock universe (confirmed byte-identical to Trading80's own data, per `extra_features_parser.py`'s existing 2026-07-30 comment). A table would store nothing new. |
| `marketsmojo_marketaction` | 3 freeform text market-commentary lines (e.g. "Nifty closed at 24,366.00..."), not structured/tabular data. |
| `investsights_investors_list` | Aggregate investor-directory snapshot (stats per investor), not a per-stock time series. The real per-stock signal already exists, at finer grain, via `investsights_investor_activity_fetcher.py`. |
| `trendlyne_market_insight` | A news-notification feed (order wins, margin misses) that structurally overlaps this platform's existing `news_sentiment_items` pipeline. Onboarding it as a real feature needs dedup/entity-tagging work, not just a table — out of scope for this pass. |
| `trendlyne_mf_home` | Live-tested twice; returned a real schema but `tableData: []` both times. Looks like it needs an additional param (category/sort) this session didn't find — not confirmed working, not built blind. |
| Sensibull (`oxide.sensibull.com/*`, 4 URLs: `fii_dii_cash`, `fii_dii_daily`, `iv_chart/{NIFTY,BANKNIFTY}`, `instrument_metacache`) | Live-tested with and without a `Referer`/`Origin` header: `{"success":false,"errors":"invalid platform access token"}`. Needs a real session/API token this environment doesn't have — rejected, not pursued further per this repo's "report a dead/gated source and ask" convention. |
| MSE (`mseindia.com/api/ticker`) | Live and working (173 symbols, 148/173 fresh as of the fetch date), but 161/173 (93%) of its listed universe is the same companies already canonically priced via NSE `stock_ohlcv` — MSE is a much lower-liquidity secondary venue for the same names. Redundant, not a new signal. |
| BloombergQuint (`www.bloombergquint.com/route-data.json`) | `curl` returns HTTP 000 (connection never completes) — dead/unreachable domain, consistent with the outlet's known 2020s rebrand away from this URL. |

**Verification run once across everything touched**: `npx tsc --noEmit` clean;
`python -m pytest src/server/__tests__/ src/server/tests/` — 1,904 passed, 227 skipped;
`npx vitest run` — 916 passed, 40 skipped, 1 failure (`signalReportCard.test.ts`, a DB-insert
timeout unrelated to any file touched here — re-ran in isolation and it passed in 520ms,
consistent with this repo's known concurrent-session DB contention, not a regression).

## Bottom line (final)

3 of 10 archived-only endpoints closed with real fetchers, tables, tests, and freshness checks,
live-verified against production. 2 more turned out to already be fully covered elsewhere —
found by checking before building, avoiding two duplicate fetchers. 5 endpoints and 3
never-promoted providers (Sensibull, MSE, BloombergQuint) were assessed and rejected with
reasons, not built speculatively, per this repo's measurement/YAGNI discipline. Nothing here
was wired toward scoring or `unified_ranker.py` — every new table is archival/vendor-signal
data only, flagged in its own docstring as unmeasured.
