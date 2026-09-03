# 02 — Duplication Report (2026-09-02)

Every claim cites ≥2 `file:line`. Verdicts: [DUP-ACCIDENTAL] worth consolidating ·
[DUP-LEGIT] legitimate specialization — do not consolidate. Pre-adjudicated designs
(four signal tables; `stock_scores`/`quant_scores` layering; greenfield's clean-room schema)
are excluded per repo rules.

## A. Cross-feature (consolidation value ranked)

**A1. Provider-id resolution — 9 hand-rolled Python loaders, no shared module.** TS canonical:
`stockMapping.ts:3-13,80` (hardcoded→cache→autocomplete). Python: `marketsmojo_technical_fetcher.py:81`,
`et_stats_client.py:95`, `tickertape_client.py:43`, `trendlyne_fundamentals_fetcher.py:79,:389`,
`extra_endpoints_fetcher.py:53`, `finstack_cashflow_fetcher.py:53`, `mover_screener_fetcher.py:143,:370`,
`trading80_call_alerts_fetcher.py:73` (an inverted re-implementation of the same field).
Greenfield has its own: `greenfield/packages/ingestion/src/stage3/stocklist.ts:16-30`.
[DUP-ACCIDENTAL], risk **low** — additive `stocklist_loader.py`; identifier bugs here caused the
2.1M-row 2026-07-23 corruption.

**A2. Trading-day arithmetic — 3 frameworks + 5 surviving hand-rolls.** Canonical Python
`as_of.py:81,112,167,204` (~57 importers); TS heuristic `tradingDaysStale` dataQualityChecks.ts:73
(deliberately weekend-only, holiday-blind); greenfield table-backed calendar
(session-calendar.ts:22-71). Hand-rolls left: `block_deal_fetcher.py:311`,
`data_integrity_repair.py:553`, `nse_bhavcopy_fetcher.py:255,:373`, `scoring_engine.py:586`.
[DUP-LEGIT] the three frameworks; [DUP-ACCIDENTAL] the 5 hand-rolls, risk **medium** (scoring
path — each needs the recurring-bugs triage, not a mechanical sweep). Watch-item: greenfield
vs `as_of` derive "trading day" from different truth sources (own table vs OHLCV grid).

**A3. Retry/backoff — TS canonical helper unused; 3 hand-rolled live loops.** `withRetry`
lib/async.ts:72 (only its own test imports it); live: `mcApiService.ts:317-348` (503-only),
`liveStockData.ts:58-88` (retry-all), `trendlyneAuthService.ts:140`. Python side is the healthy
contrast: `retry_get` fetch_utils.py:46 in 121 sites/45 files. [DUP-ACCIDENTAL], risk **low**
(per-site retry-policy decision needed, no new machinery).

**A4. Four FastAPI bootstraps with asymmetric health/CORS.** `python_api.py:19` (**no /health**,
no CORS), `worker_service.py:23`, `chatbot/app.py:62` (CORS+health), `backend-python/main.py:69`
(CORS+health). ml-api — the service BullMQ calls most — is the one without /health.
[DUP-ACCIDENTAL], risk **low** (shared `create_service_app()`; net change = adding monitoring
surface).

**A5. Env/port config in 3 layers + 4 .env loaders.** `db_compat.py:30-38`, pm2
`ecosystem.config.cjs:28-31`, 3 backfill scripts each with own `load_dotenv()`; port constants
duplicated own-default + sibling-fallback (`pythonApi.ts:3`, `alphaQuantClient.ts:1`); hardcoded
`http://127.0.0.1:3000/api/internal/notify` in `scoring_engine.py:1277`, `strategy_optimizer.py:402`.
[DUP-ACCIDENTAL], risk **low**.

**A6. DB access — 5 production setups, 2 bypass families.** Facades are [DUP-LEGIT]
(pgClient.ts:53; db_compat.py:85; greenfield db/index.ts:22). Bypasses [DUP-ACCIDENTAL]:
`scripts/retag_news.ts:13` (own Pool, missing pgClient's type parsers), raw `psycopg2.connect` in
`backfill_pe_valuation_bands.py:10`, `backfill_working_capital_signals.py:74`,
`backfill_financial_trends_all.py:25` (no translate, no ConnWrapper rollback). Risk **medium**
(bypass scripts get copy-pasted as templates).

## B. Within-feature (evidence-backed worst ten)

**B1. Dead fetcher framework coexisting with the live helper.** `base_fetcher.py:87-181`
(`@governed_fetcher`, `BaseFetcher`, DLQ `data_ingestion_dlq` :72): ~84 injected
`*FetcherBaseFetcher` classes, **0 instantiations** (verified: the 5 "deliberate-looking" ones —
asm_gsm:18, credit_rating:22, delivery_trend:46, delivery_volume:35, marketsmojo_stock_picks:45 —
are themselves the injected template). `to_polars_df` verbatim in **203 files, 0 call sites**.
Meanwhile `retry_get` (fetch_utils.py:46) is the real, adopted layer and 39 fetchers hand-roll
`time.sleep` pacing. [DUP-ACCIDENTAL]; deletion near-zero-risk.

**B2. Point-in-time guard SQL per fetcher.** `mc_pricefeed_fetcher.py:451-467` (17 cols),
`trendlyne_overview_fetcher.py:585-591`, `index_membership_fetcher.py:206-236` + 12 more files;
**pre-fix `ELSE NULL END` variant still live** in `mf_holdings_fetcher.py:159-160`,
`mf_stock_holdings_fetcher.py:227-233`. [DUP-ACCIDENTAL]; the divergence is already
correctness-relevant (the 2026-09-01 77-column bug class).

**B3. MoneyControl headers ×24.** e.g. `india_macro_fetcher.py:57`, `earnings_surprise_fetcher.py:64`,
`pcr_fetcher.py:69` — with casing drift (`Referer` vs `referer`: eps_surprise:68,
mc_corporate_calendar:51, mc_global_macro:83). [DUP-ACCIDENTAL], risk **low**.

**B4. Freshness probe — 4 router copies, already diverged.** `commandCenter.router.ts:7-18`,
`misc.router.ts:21-33`, `scoring.router.ts:15-24` (no CAST — NUMERIC/timestamp-as-string hazard),
`confluence.router.ts:31-41` (different table). **CONSOLIDATED 2026-09-02** →
`src/server/latestComputedAt.ts` (this session).

**B5. Symbol normalization — ~19 inline `toUpperCase()` sites, none trims.**
`portfolio.router.ts:105`, `fno.router.ts:30,40`, `fundamentals.router.ts:73,190,266,290,316`,
`misc.router.ts:230,283,302,371`, `stocks.router.ts:44,74`, `screeners.router.ts:109` (a third
variant). [DUP-ACCIDENTAL], risk **low**.

**B6. "Latest technical_signals row" SELECT ×4.** `mcpServer.ts:174`, `fundamentals.router.ts:72`,
`technicals.router.ts:47`, `misc.router.ts:46`. [DUP-ACCIDENTAL], risk **low**.

**B7. Staleness computed by 3 systems that fix bugs independently.** `monitor.router.ts:121-213`
(~20 hand-rolled MAX() probes), `dataQualityChecks.ts` factory + `tradingDaysStale`,
`jobHeartbeat.ts:148`. Delivery channels [DUP-LEGIT]; the staleness *math* [DUP-ACCIDENTAL], risk **medium**.

**B8. Date-anchor idioms interleaved in one file.** `unified_ranker.py`: 6 `trading_days_back`
sites vs 9 calendar-cutoff sites, with the same justification comment re-pasted 6 times
(:1657,:1685,:1765,:1843,:1866,:1885). [DUP-ACCIDENTAL]; each site needs the documented triage.

**B9. Champion/challenger gate — 6 near-copies.** `ml_ensemble.py:3365`, `cs_ranker.py:283`,
`exit_policy.py:193`, `confluence_ml_engine.py:279-374`, `online_learner.py:194-212`,
`dl_engine.py:815-889` (config-file variant). [DUP-ACCIDENTAL], risk **medium** (gates are
load-bearing; consolidate the harness, not the thresholds).

**B10. Train/score feature SQL pair kept in sync by prose.** `ml_ensemble.py:1051` vs `:1312`
(their own comment :1331 admits it); diverged once already (cr_upgrades, fixed 2026-08-30).
[DUP-ACCIDENTAL]; the durable fix is a column-set-equality assertion test, not a rewrite.

## C. Deliberately not flagged (checked, legitimate)
`stock_scores`/`quant_scores` input layering; four-signal-table design; per-provider header
*values* (WAF vs auth differences); per-fetcher parse functions (documented convention,
tl_fetch.py:18); the 6 engines' consistent use of `db_compat` (no duplication found);
`fetchWithCache` usage (already the shared helper); greenfield's clean-room schema and packages.
