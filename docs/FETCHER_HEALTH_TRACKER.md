# Fetcher Health Tracker

_Living record of every network-calling fetcher script in `src/server/`, its current health,
and pending action items. Written 2026-07-04 after a full live audit (every fetcher run at
least once against production URLs), followed by two same-day fix passes; re-swept 2026-07-11
(all ~95 `runPython` scripts, 5 more fixes — see the 2026-07-11 section below). Update this
file whenever a fetcher's status changes — don't let it go stale._

**2026-07-19: this tracker is now backed by a continuous check, not just manual sweeps.**
Every bug logged below was a job that exited 0 while writing wrong/empty/stuck data — invisible
to job-run monitoring (`jobHeartbeat.ts`/`jobWatchdog.ts`/`MONITOR_SCRIPTS`), only ever caught by
a human running this file's audit by hand. `src/server/dataQualityChecks.ts` now runs ~24
freshness/coverage/range/plausibility checks against the tables these fetchers write, on the
same 15-min cadence as the existing watchdog, folded into the same Telegram daily digest (see
`checkAndAlertDataQuality`/`buildDailyDigest` in `jobWatchdog.ts`). Run it on demand with
`npm run dq:check` (needs a reachable live instance — the old `USE_POSTGRES=true` prerequisite
was dropped 2026-08-15; Postgres is now unconditional). When you fix a fetcher
bug found here, consider adding a check for it so a regression pages instead of waiting for the
next manual sweep.

**2026-07-19: backfilled regression tests for 6 fixes that had none.** Cross-referencing the
"Fixed" tables above against the test suite found `asm_gsm_fetcher.py`, `mc_corporate_calendar_fetcher.py`,
`credit_rating_fetcher.py`, `insider_transactions_fetcher.py`, `eps_surprise_fetcher.py`, and
`market_regime_fetcher.py`'s fixes were each verified once by hand during their fix session and
never turned into a lasting test — meaning a regression in any of them would only resurface via
the next manual audit. Added `src/server/tests/test_{asm_gsm_fetcher,mc_corporate_calendar_fetcher,
credit_rating_fetcher,insider_transactions_fetcher,eps_surprise_fetcher,market_regime_fetcher}.py`
(51 tests) encoding the exact failure mode each fix addresses.

---

## How to re-check a fetcher

```
cd src/server
PYTHONIOENCODING=utf-8 ../../backend-python/venv/Scripts/python.exe -u <script>.py
```

`PYTHONIOENCODING=utf-8` matters — without it, scripts printing ₹/→/other non-ASCII on a
Windows console will crash even though production (`pythonRunner.ts` → `runPython()`) already
sets this env var and is unaffected.

---

## ✅ Fixed 2026-07-04, pass 1 (verified live)

| Script | Bug | Fix |
|---|---|---|
| `financial_ratios_fetcher.py` | `tl_financial_quality` was missing `fetched_at` — first insert failed with `UndefinedColumn`, then every subsequent symbol failed with `InFailedSqlTransaction` (no rollback) | Self-healing `ALTER TABLE ... ADD COLUMN fetched_at` in `ensure_schema()` + `con.rollback()` in the per-symbol except block. Schema-of-record (`db/schema.postgres.sql`) updated too. |
| `eps_surprise_fetcher.py` | Uncaught `orjson.JSONDecodeError` when MC's bulk `actual-estimate` endpoint returns empty — killed the whole script | Wrapped in try/except, degrades to `0 stocks resolved` and continues |
| `fii_dii_backfill.py` | Uncaught `HTTPError` on tradebrains.in 502 | Added 3x retry with backoff + graceful exit (still fails today — tradebrains.in itself is down) |
| `market_regime_fetcher.py` (USDINR) | Called the retired `currency/get-currency-data?section=major` endpoint (empty) | Switched to `us-markets/getCurrencies` (same endpoint `mc_global_macro_fetcher.py` already uses successfully) |
| `market_regime_fetcher.py` (Nifty basis) | NiftyTrader fallback parsed a `resultData.data` key that doesn't exist, and expected `spotPrice`/`futPrice` fields NT's dashboard-data never returns (it only has one price, `last_trade_price`, per index) | Rewired to read `resultData.indices`, pair NT's futures `last_trade_price` with the NIFTY50 spot close already written to `macro_indicators` by `global_macro_fetcher.py` |
| `syncProprietaryScores.ts` (`syncTrendlyneScores`) | `fetchTrendlyneDVM`/`fetchTrendlyneChecklist` were permanently stubbed to `null` elsewhere, so every stock tripped the failure-cooldown logic and the job aborted every run, misreporting the cause as Trendlyne rate-limiting | Probes once with a real symbol before looping the universe; skips cleanly with an accurate log line if both are still null. Self-heals if DVM/Checklist fetching is ever restored. |
| `asm_gsm_fetcher.py` | `upsert_flags()` unconditionally reset `is_asm`/`gsm_stage` to 0 for every stock before reapplying — a fetch **failure** (empty result) was indistinguishable from a fetch **success with zero flagged stocks**, so an NSE outage would silently wipe real surveillance flags platform-wide | `fetch_asm_symbols`/`fetch_gsm_symbols` now return `None` on failure (vs `set()`/`{}` on a real empty result); `upsert_flags` refuses to touch existing flags when either is `None`. Verified: normal run still updates 202/64 stocks; simulated total failure now leaves existing flags untouched (tested via direct `upsert_flags(None, None)` call). |
| `mc_corporate_calendar_fetcher.py` | Unguarded `date.fromisoformat()` on `corporate_actions.ex_date` (confirmed `TEXT` in Postgres) — any malformed date (e.g. a time suffix) would raise and abort the whole run | Guarded with try/except + strips a time suffix before parsing (`str(last_ex).strip().split()[0]`); unparseable dates are now skipped per-symbol instead of aborting the run. Verified against both a time-suffixed date and a totally garbage string. |
| `marketStatusService.ts` | `isMarketOpen()`'s catch/fallback path never populated `cache`, so an NSE outage caused all 4 call sites to redo two live network calls (~20s) on every single invocation instead of respecting the 60s cache | Cache the fallback result too (short 20s TTL). Also added a secondary live source — BSE's `json.bselivefeeds.indiatimes.com/ET_Community/holidaylist` feed (holiday-aware, tells you *why* the market is closed) — tried before falling back to the pure weekday/time heuristic. Verified: forced-NSE-down test correctly engages BSE, and 3 consecutive calls during an outage only hit the network once each (caching confirmed). |
| `trendlyneService.ts` (`fetchTrendlyneSectorRotation`/`fetchTrendlyneIndexRotation`) | Still used bare unauthenticated `fetch()` and lost their mock-data fallback, inconsistent with sibling functions upgraded to the auth service | Routed through `fetchTrendlyneWithAuth` for consistency — self-heals via the auth service if Trendlyne ever gates these endpoints too. Verified still returns real data today (these endpoints don't currently require auth). |

## ✅ Fixed 2026-07-11, full job sweep (67 PASS / 24 healthy-slow / 3 hard-fail before fixes)

Ran all ~95 `runPython` scripts extracted from `queues.ts` directly against live Postgres.
Five soft/hard bugs fixed + verified (`npx tsc --noEmit` clean). Committed on branch
`fix/job-reliability-sweep` (53b2851, 5b6d7dd), now merged to `main`.

| Script | Bug | Fix |
|---|---|---|
| `pcr_fetcher.py` (Nifty GEX) | MoneyControl OI endpoint `priceapi.moneycontrol.com/technicalCompanyData/oiData/*` now returns HTTP 404 — dealer gamma-exposure went empty | Rewired onto NiftyTrader index option-chain (`webapi.niftytrader.in/webapi/option/option-chain-data?symbol=NIFTY`), which carries absolute strike OI + spot + totals. `pcr_fetcher` already used NiftyTrader for equity OI/PCR — the working equity path was the tell. Verified `dealer_gex=+42283B` (long gamma). |
| `iv_features.py` | Uncommitted `ALTER TABLE` via a bare `ConnWrapper` — PG's transactional DDL rolled it back on `close()`, so a later separate-txn `executemany` hit `UndefinedColumn` (SQLite auto-commits DDL, so dev never saw it) | Switched to `db_compat.safe_alter(None, ddl)` (`ADD COLUMN IF NOT EXISTS` in its own committed `engine.begin()` txn). |
| `insider_transactions_fetcher.py` | Compared a `TEXT` `transaction_date` column against a Python `datetime.date` param → PG `no operator matches` (SQLite's dynamic typing hid it) | Bind `.isoformat()` strings (ISO dates sort lexicographically). |
| `working_capital_fetcher.py` + `financial_ratios_fetcher.py` | ET_Stats returns literal `'NA'`; `float(x or 0)` throws (`'NA'` is truthy) and `'NA' < threshold` raises `TypeError` — failing 100% of stocks silently (per-item try/except, exit 0, zero output) | Added `_num(v, default=None)` = `try: float(v) except (TypeError,ValueError): return default`. |
| `online_learner.py` (call site) | `update_priors_from_outcomes(conn, df)` called with an extra `conn` arg — signature is `(outcomes_df)`; the `TypeError` was swallowed so priors never updated | Dropped the `conn` arg (the function is file-based). |

Also hardened `queues.ts::processConfluenceOutcomes` (`Promise.all`→`Promise.allSettled` +
per-script `.catch` so one script can't abort its siblings) and added ONE safe parallel batch
in `processMlDailyOps` (`moneycontrol_fetcher || institutional_quant_engine || finbert_scorer`
— disjoint tables, no shared advisory locks). Paired with the `confluence_ml_engine.py` LATERAL
rewrite (16s vs >8min on the live 1.9M-row table).

## ✅ Fixed 2026-07-04, pass 2 (verified live)

| Script | Bug | Fix |
|---|---|---|
| `nifty_pe_fetcher.py` | MC's PE/PB graph endpoint returns corrupted single-point data (`data: 0`, wrong index level) for ~43 of ~91 indices, not just the originally-suspected 5 sector indices | `fetch_trendlyne()`'s response parsing was also broken (looked for `chart_data`/`data`/`chartData` keys; real shape is `body.eodData`) — fixed. `run()` now detects MC corruption (`len(combined) <= 1` or all-zero PE) and falls back to Trendlyne's chart-data (which has 5000+ days of history) for the requested window. Verified: full run completes cleanly, 43 indices recovered via fallback, 4885 total rows written. **Also bumped the `queues.ts` timeout from 3min → 10min** since the extra fallback round-trips make a full run take 6-7 minutes. |
| `india_macro_fetcher.py` (eco-calendar) | `get-actual-event-data` was retired (404) | Switched to `get-event-data` (singular) — real endpoint with `actual`/`previous`/`consensus` fields, but only ever returns *today's* events (no date-range param accepted, verified live). Since this job runs daily, that's sufficient — history now accumulates one day at a time instead of crashing. Verified: no more 404, correctly finds 0 India-tagged events on a day with none scheduled. |
| `india_macro_fetcher.py` (repo rate) | `section=ir` was retired (422); no MC section carries RBI's policy rate anymore | Removed the now-permanently-dead primary fetch path (`_fetch_repo_rate`/`_IR_URL`, deleted as dead code) and go straight to the existing `eco_calendar`-table-based fallback, which will pick up RBI rate-decision events whenever `mc_eco_calendar_fetcher.py` (still healthy) captures one. |
| `credit_rating_fetcher.py` | BSE's `Corpfiling/w` endpoint returns an HTML bot-check page instead of JSON | **User supplied working alternative URLs.** Rewritten to use NSE's `https://www.nseindia.com/api/corporate-credit-rating?from_date=DD-MM-YYYY&to_date=DD-MM-YYYY` — structured fields (`RatingAction`/`NameOfCRAgency`/`ISIN`/`Symbol`) replace all the old free-text headline parsing, and it supports real historical date ranges (verified: 12,749 rows for a 6-month window). Also fixed two **pre-existing, previously-dormant** bugs this exposed: (1) `upsert_events`/`update_technical_signals` called `db_compat.executemany()` with the wrong arg count and with raw Postgres `%s` placeholders that its translator doesn't convert — unified to one `?`-style query per function; (2) NSE uses multiple sentinel values for "no listed symbol" (`NA`, `NOT LISTED`, `NOTLISTED`, `NOT APPLICABLE`) and the original guard only caught one, letting placeholder text leak into the `symbol` column — broadened the check. Verified end-to-end: 12,197 events fetched, 6,698 upgrades / 17 downgrades / 5,060 reaffirms, 17 real listed stocks updated in `technical_signals`, zero placeholder symbols persisted. |

---

## 🔴 Still confirmed broken upstream — awaiting an alternative URL

Per user preference: when a URL is confirmed not returning expected data, report it here and
ask for an alternative rather than researching a replacement unprompted.

| Script | URL(s) failing | Root cause |
|---|---|---|
| `working_capital_fetcher.py` | `https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}/` for `TRADE_RECEIVABLE_Q`, `DEBTORS_Q`, `INVENTORIES_Q`, `TRADE_PAYABLE_Q`, `CREDITORS_Q`, `REVENUE_Q`, `COGS_Q`, `RAW_MATERIAL_Q` | Trendlyne returns `head.status=0` (success) but empty `eodData` for every one of these 8 params — verified against HDFCBANK (tlid 533). Trendlyne discontinued/renamed this class of quarterly line items. |
| `financial_ratios_fetcher.py` (cash-flow data, not the crash — crash already fixed) | Same base URL, params `CFO_Q`, `CAPEX_Q`, `EBIT_Q`, `INT_EXP_Q` | Same as above — verified empty for HDFCBANK. Only `market_cap` (read from the side-channel `stockHeaders`/`stockData`) still populates; FCF yield / interest coverage stay `n/a`. |
| ~~`mf_holdings_fetcher.py`~~ | ~~`mfapps.indiatimes.com/.../MFPortfolioHolding.cms`~~ | **Fixed 2026-08-13** — rewritten to `marketservices.indiatimes.com/marketservices/shareholding?companyid={cid}` (ET's shareholding-pattern endpoint, keyed by the ET `companyid` the ET_Stats fetchers already use). This row was stale, still describing the pre-rewrite dead endpoint. Re-verified live 2026-08-29: `python mf_holdings_fetcher.py --symbol RELIANCE` → real quarterly MF-holding %, written to `stock_mf_holdings` (5,616 rows / 1,403 symbols, fresh through today). Scheduled weekly, `queues.ts:1318`. |
| `mf_sector_flow_fetcher.py` | `https://portal.amfiindia.com/DownloadSchemeData_Po.aspx?mf=0&tp=1&fD=...&tD=...` | Re-confirmed still dead 2026-08-29 (tried `tp=1..4`, all return the identical scheme-master file, param ignored). AMFI restructured their entire portfolio-disclosure distribution: the disclosure page is now just a directory of links to ~54 individual AMC websites (PDF/XLSX/ZIP, inconsistent formats each) — a real replacement means scraping per-AMC workbooks, an `/onboard-data-source`-scale project, not a URL swap. The one remaining AMFI-hosted API (`schemewisedisclosure-investment`) is quarterly, not monthly, and covers only a narrow SEBI-circular subset. Checked one candidate third-party aggregator (`mfdata.in`, advertised as a free holdings/sector API) — currently returns HTTP 522 (origin unreachable), not viable today. |

---

## 🟡 False alarms from the initial audit — confirmed working, just slow/quiet

- `analyst_estimates_snapshot.py` — only prints one summary line at the very end; confirmed `3/3` written against `--symbols RELIANCE,TCS,HDFCBANK`.
- `intraday_fetcher.py` — same pattern; confirmed `501 bars upserted` against a 3-symbol test.
- `earnings_surprise_fetcher.py` — the long "no data" runs were all genuine micro/small-caps early in the alphabet with no analyst coverage; confirmed MC's forecast/hits endpoints return real data for HDFCBANK.
- `nt_change_oi_fetcher.py` / `nt_oi_snapshot_fetcher.py` / `nt_pcr_ts_fetcher.py` all report `GIFTNIFTY: Data Not Found` — NiftyTrader simply doesn't carry GIFT Nifty option-chain data; not a bug.

---

## Confirmed fully working (2026-07-04 audit)

`asm_gsm_fetcher`, `global_macro_fetcher`, `fii_dii_fetcher`, `mc_broker_reco_fetcher`,
`mc_eco_calendar_fetcher`, `mc_global_macro_fetcher`, `mc_advance_decline_fetcher`,
`mc_pricefeed_fetcher`, `mc_index_ohlc_fetcher`, `mc_index_oi_fetcher`,
`mc_chart_patterns_fetcher`, `mc_corporate_calendar_fetcher`, `nt_dashboard_fetcher`,
`nt_vix_fetcher`, `pcr_fetcher`, `stock_option_chain_fetcher`, `so_option_chain_fetcher`,
`fno_rollover_fetcher`, `sync_nt_fno_symbols`, `trendlyne_price_analysis_fetcher`,
`trendlyne_adv_tech_fetcher`, `trendlyne_fundamentals_fetcher`, `trendlyne_overview_fetcher`,
`trendlyne_screener_discovery`, `sync_tl_index_map`, `insider_transactions_fetcher`,
`block_deal_fetcher`, `delivery_volume_fetcher`, `sync_mc_index_map`, `moneycontrol_fetcher`,
`preopen_fetcher`, `index_membership_fetcher` (crash only happens without `PYTHONIOENCODING`,
non-issue in production), `delivery_trend_fetcher` (same encoding caveat), `nifty_pe_fetcher`
(post-fix), `india_macro_fetcher` (post-fix, sparse-by-nature), `credit_rating_fetcher` (post-fix).

---

## TODO / pending decisions

- [ ] **`mf_sector_flow_fetcher.py`** — need an alternative URL/source (AMFI's bulk endpoint is dead, see above; `mfdata.in` checked 2026-08-29 as a candidate, currently down).
- [x] ~~`mf_holdings_fetcher.py` needs an alternative URL/source~~ — **fixed 2026-08-13**, this row was stale. See above.
- [ ] **`financial_ratios_fetcher.py`**'s cash-flow params — need an alternative URL/source (Trendlyne's quarterly line-item params are dead, see above), or consider deriving FCF-yield/interest-coverage from `stock_fundamentals`/`fundamentals_history` we already ingest instead.
- [x] ~~`working_capital_fetcher.py` needs an alternative source~~ — **fixed 2026-08-27** (`e9daeae`): not a dead source, a one-line request-depth bug (`fetch_et_stats(..., "Quarterly", ...)` was requesting only 5 quarters instead of 20). No new data source was needed; live-verified against the full ~1,969-symbol universe (601 deteriorating / 561 improving, previously frozen at 0/0).
- [ ] No scheduler changes made for the still-broken scripts above — they still run on their existing cron per `queues.ts` / `JOB_REGISTRY`; they fail gracefully (no crashes) but produce no new data until an alternative source is found.
