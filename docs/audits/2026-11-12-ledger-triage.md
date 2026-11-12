# Ledger triage, 2026-11-12 night

Per-row verdicts for the 181 rows open at the start of the 2026-11-12 ledger sweep, produced by four read-only triage agents and spot-checked by the main session. Verdicts: CLOSE and CLOSE-NO-DEFECT were applied to `docs/audit-findings.md` (two of those closures were reopened on review: AF-20260827-14 and AF-20260930-26); FIXABLE-NOW, USER-DECISION, STILL-BLOCKED and CALENDAR-PASSED rows stay open and the plans below are the starting point. Clock times in the SQL the agents ran may be approximate. Read the ledger row before acting on any entry.

## Batch 1

### Batch 1 triage (2026-11-12 ~19:50 IST). Read-only. Tests run with PGTEST_DB=bharat_pgtest (preflight: empty).
Context: bharat-server up since 2026-11-12 17:50 IST (includes every commit through 3a96a3cf; only docs/deps since). Tests run today: 13 vitest files / 66 pass; pytest 147 + 172 pass; dataQualityChecks.test.ts 217 pass.

#### AF-20261111-02 (L84) — STILL-BLOCKED
Calendar-blocked: 60 forward sessions from 2026-11-12 (earliest ~2027-02-09); pre-registered, protocol must not change. test_sizing_shadow_arm.py exists and passes. Re-check app_settings['sizing_shadow_report'] then.

#### AF-20261108-02 (L87) — STILL-BLOCKED
EVIDENCE; depends on AF-20261026-73 (paper book, calendar-blocked to ~2027-01-22) and AF-20261028-15 (open). No code defect; no frozen experiment may be altered.

#### AF-20261108-01 (L88) — CLOSE
cb5724e9 on main, bharat-server restarted after it (11-08 13:31, again 11-11 18:18, 11-12 17:50). job_run_history: job-digest success 11-08, 11-09, 11-10, 11-11 (17:20 UTC each); only failure was 11-07. Test: src/server/__tests__/telegramTransientRetry.test.ts (passes today). The retry-log line cannot be forced live; the delivery condition in the row is met.

#### AF-20261107-01 (L89) — CLOSE
4a05e955 on main, live since restart. Live readback: trendlyne_stock_metrics_history rows fetched 2026-11-12 00:04 IST onward carry date 2026-11-12 (a UTC stamp would read 11-11 until 05:30 IST); rows fetched 11-11 23:58 IST carry 11-11. Test: src/server/__tests__/trendlyneDailyFetchDate.test.ts (passes).

#### AF-20261107-03 (L91) — CLOSE
Fix live. analyst-estimates-sync success 11-09, 11-10, 11-11 (~19:48 IST), duration ~212 s (< 8 min). analyst_estimates_history eps_est_next non-null 993 of 1043 per day (was 749-750), above 750. Test: src/server/__tests__/test_analyst_source_health.py (passes).

#### AF-20261107-05 (L93) — CLOSE
Code live (restarts since 11-08). Tests chatbotReingestStopped.test.ts + stockChatbotOfflineMessage.test.ts pass. chatbot-reingest success nightly 11-07..11-11 (chatbot online, so the skip path is covered by test only, not live). Chatbot /health is still 503 llm=unavailable (no LLM key): the owner's separate key decision, not this row's defect; track as its own USER-DECISION (supply a key, or leave the chatbot stopped).

#### AF-20261107-06 (L94) — STILL-BLOCKED
Needs a recurrence or a train+tune followed by real scoring in one process. ml-ensemble-train: failed 11-06 (0xC0000409), success 11-08 (40 min); ml-ensemble-score success daily. Sun 11-15 retrain will likely have nothing to score. Test pythonRunnerExitCodes.test.ts passes. Close only after a train run with pending signals exits clean, or on recurrence.

#### AF-20261107-07 (L95) — STILL-BLOCKED (new evidence)
The stack dump already fired once: app-2026-11-09 log, finbert_scorer.py --days 1, 2026-11-09 19:35 IST, "Timeout (0:02:40)" with the thread in finbert_scorer.py:167 score_batch (tone model forward pass), then the run finished successfully (peak 3,679 MB). So a slow inference (>160 s), not a load stall, and it completed. No timeouts 11-10..11-12; no non-success finbert-scorer rows. Close after 2026-11-21 if no kill. Test test_finbert_scorer_hang_dump.py passes.

#### AF-20261107-09 (L97) — USER-DECISION
Decision: obtain a Tapetide API token + permission/quota (free tier 50 req/day) OR retire the three tapetide endpoints. Recommend retire: they 404 every weekly run and the cache is frozen at 2026-09-18. Parser freshness fix is on main (36e0daa6) and live: technical_signals.ext_tt_score non-null 1,631 on 11-11 -> 0 on 11-12. Test test_extra_features_parser.py passes. Remaining: historical exposure audit (rows 08-28..11-11 carried stale scores) plus the token decision.

#### AF-20261107-10 (L98) — CLOSE
b1f3bb83 on main; deployed. Mon 11-09 batch success; 11-10 success; gated-payload log lines: 0 on 11-08/11-09, exactly 1 (LTTS, 11-10 20:22) and that batch still succeeded (invalidate+relogin works). The 11-11 failure (216/500) is NOT this defect: pm2 log shows getaddrinfo ENOTFOUND trendlyne.com from 13:19 IST 11-11 (host DNS after the lid-closed standby). Test trendlyneAuthAnonymousSession.test.ts passes.

#### AF-20261106-04 (L100) — FIXABLE-NOW
src/server/screener_features_fetcher.py:238-253 load_today_appearances still has `appeared_date >= as_of-3d`. Plan: (1) test in src/server/tests/test_screener_features_fetcher.py: an episode opened 10 days ago and still open must be returned (fails today); (2) WHERE -> `appeared_date <= as_of AND (exited_date IS NULL OR exited_date > as_of)`; (3) read-only replay of 2026-11-05 old vs new membership before commit (ml_score is out of the blend, so no live score moves); (4) re-run the AF-20261106-01 replay on the corrected capture. Verify live: next screener_membership_runs membership_count rises (~38k today).

#### AF-20261106-01 (L102) — STILL-BLOCKED
Depends on AF-20261106-04. Review-only; no application.

#### AF-20261105-05 (L107) — USER-DECISION
Code half live. Live count of wrong news_symbol_link rows is still 114 (query run). Decision: run the DELETE at docs/session-log.md line 12395 (derived, rebuildable; repair_news_link only inserts so it will not re-add). Recommend yes. Not a live score input.

#### AF-20261104-04 (L110) — USER-DECISION
alpha.* schema does not exist in this database (0 tables); the defect lives in bharat_alpha / bharat-edge, outside this repo. Decision: repair split/bonus adjustment in bharat_alpha, or in the new tree rebuilding from stock_ohlcv. Recommend the new tree; leave bharat_alpha untouched and mark its returns not-to-use.

#### AF-20261104-03 (L111) — USER-DECISION
Planning row for work living in bharat-edge. Decision: which tree continues (phase0-sdd branch vs bharat-edge) and whether to close this row with a pointer to bharat-edge's tracker. Recommend Phase 1 only (research/risk tool, no calls) per the 11-05 note, and close here with that pointer.

#### AF-20261104-01 (L113) — FIXABLE-NOW (large)
queues.ts:3365 still archives after the ranker; ranker_input_snapshot.py:339 labels manifests "unverified_database_observation" (honest, not point-in-time). Plan: unified_ranker.py writes the exact frames it read (hash + rows) at read time; failing test first: mutate a source row after the ranker call and assert the archive still equals the consumed value (extend test_ranker_input_snapshot.py). Old archives stay unverified permanently; row closes prospectively after the first verified night.

#### AF-20261103-11 (L114) — STILL-BLOCKED
Acting needs the pre-registered measurements in docs/regime-buy-step-attribution-2026-11-03.md section 6. Item 3 (re-label with final inputs) is read-only and runnable now; items 1/2 need ~20 HIGH_VOL sessions but the regime has been BULL since 11-06. Related AF-20261008-21 (open).

#### AF-20261103-12 (L115) — CALENDAR-PASSED
The 11-07 retrain ran (ml-weekly-retrain 11-08). Result: ml_models/hmm_regime.pkl mtime still 2026-10-25 14:57 (no swap); hmm_regime.pkl.candidate refreshed 2026-11-08 07:38 UTC. So no swap and no swap-driven Buy step; the archive-on-swap path is untested. Next: compare the new candidate with live (same read-only replay as 11-04) before Sun 11-15; close once a swap has been archived+replayed or gate-holds repeat with the comparison recorded. Separately the regime moved to BULL on 11-06 (Buy count 73 -> 193-210 on 11-06/11-09/11-11): note under AF-20261103-07.

#### AF-20261103-13 (L116) — STILL-BLOCKED
Keep-tilt decision recorded 11-04; display only. Next measure at paper book verdict (AF-20261026-73, ~2027-01-22) and sizing shadow (AF-20261111-02, ~2027-02-09).

#### AF-20261103-15 (L118) — USER-DECISION
Decision: cut production over to a release worktree at a pinned commit (restarts every service) or accept the shared live tree. Still bites: today's 17:50 restart deployed the working tree. Recommend a pinned release-worktree cutover in a quiet weekend window; meanwhile require a clean `git status` in the restart recipe.

#### AF-20261103-16 (L119) — USER-DECISION
Doc section 4 recommends B or C. Option C (deterministic LIMIT 1 readers) is already shipped. Since 11-09 nifty_regime has one value per date (BULL 2,159-2,164 rows); the split last appeared 11-06 (363 BEAR / 1,797 BULL). Decision: accept option C as final and close (reopen if HIGH_VOL returns and the split recurs), or choose A/B. Recommend accept C.

#### AF-20261103-17 (L120) — STILL-BLOCKED
scoring_engine.py:715 still orders by win-prob DESC over a one-trading-day window. A latest-date tie-break moves a score input (184 of 2,162 symbols) and needs frozen decision inputs to measure: depends on AF-20261104-01 and AF-20261008-25 (calendar to 2027-02-26).

#### AF-20261103-18 (L121) — STILL-BLOCKED
findings:check today: 7 FIX-relies-on-EVIDENCE warnings (L149 -07, L157 -06, L159 -99, L167 -94 from this batch; L181 AF-20261028-15, L207 AF-20261026-44, L338 AF-20261017-07) and 8 duplicate-ID warnings (history rows; cannot delete). Down from 21. Clears as those rows close/move; duplicate-ID warnings need an allow-list in scripts/checkFindingsLedger.mjs (small FIXABLE) or ID suffixing. Sweep due 11-14.

#### AF-20261103-05 (L124) — USER-DECISION
Decision: which devices legitimately reach this host (sets the binding change); restart + credential rotation are owner-authorized. Recommend loopback binding (+ firewall rule for the one remote device) and secret rotation in the same restart window as the AF-20261103-15 cutover. Details intentionally not written here (public repo).

#### AF-20261103-06 (L125) — CLOSE
6fb955e1 (ml, 11-03) and 2558811e (trendlyne TS) on main; TS live in restarts since 11-08; ml-ensemble-train retrained 11-08 with the new input (success). Live check: ml_ensemble._days_to_fno_expiry 2026-11-12 -> 12 (Tue 11-24), 11-25 -> 34 (Tue 12-29), 2025-08-20 -> 8 (Thu 08-28). Tests test_ml_ensemble.py, fnoOptionChainSummary.test.ts, trendlyneStockOptionChainExpiry.test.ts pass.

#### AF-20261103-07 (L126) — STILL-BLOCKED
Attribution done; acting needs AF-20261026-45 (open, EVIDENCE) and AF-20261008-21 (open). New data point: regime BULL since 11-06 moved Buys from 73-82 (HIGH_VOL) to 193-210 (11-06, 11-09, 11-11): the step recurred with a regime change and no weight change. No label/weight change without the re-measure.

#### AF-20261103-08 (L127) — STILL-BLOCKED
Needs >=20 independent 5-session windows with own-cost grading; costs start 2026-10-12, so ~4 disjoint windows exist now (~100 sessions needed, about March 2027). test_accuracy_scorecard.py passes.

#### AF-20261103-10 (L129) — CLOSE
Premise resolved. D: now 127 GB free (73% used) vs the 14.12 GiB the preflight needs; `docker volume ls` shows no pre_ts2 volume; backups/ holds no .dump files (nothing left to prune); PG_BACKUP_DIR=C:/Users/amitk/bharat-backups-overflow holds bharat_intel_20261111_231502.dump (7.2 GB, 11-11 23:15 IST); job_heartbeat pg-backup last_success is that night. Test scripts/test_backup_pg_capacity.py passes. Residuals tracked elsewhere: same-SSD backups (AF-20261017-11, open, needs off-host destination); only one dump retained in the overflow folder.

#### AF-20261102-01 (L134) — USER-DECISION
Decision: apply `.wslconfig` `[experimental] autoMemoryReclaim=dropcache` (needs `wsl --shutdown`, restarts Postgres+Redis) or leave as is. Today: .wslconfig has memory=12GB, swap=4GB, gradual; vmmemWSL 4.9 GB; host free RAM 0.6 GB of 23 GB, commit 50.3 of 60.9 GB. FinBERT throttle live (hourly), idle-service memory cut (memory note 2026-11-06), DL retired. Recommend: leave as is, close the .wslconfig half as declined; reopen only if commit climbs.

#### AF-20261030-19 (L137) — FIXABLE-NOW
No observation table for analyst estimates exists (only fundamental_observations, nse_filing_financial_observations, screener_membership_runs, technical_signal_observations). Plan: additive migration `analyst_estimate_observations(symbol, source, captured_at, fields jsonb, status available/failed/withdrawn)` inserted atomically with the analyst_estimates_snapshot.py upsert (pattern: migrations/20261030100000_xbrl-observations.sql); failing test first in src/server/tests/test_analyst_estimates_snapshot.py: a same-day rerun with fewer fields must leave both versions. Capture only; no training/scoring change.

#### AF-20261030-17 (L139) — STILL-BLOCKED
Depends on AF-20261030-16 (first-observed/versioned link columns are the prerequisite for any point-in-time reconciliation). After that, quantify with the bounded sample the row describes and add reconciliation.

#### AF-20261030-16 (L140) — FIXABLE-NOW
news_sentiment_items has fetched_at (advances on re-ingest); news_symbol_link has only (news_id, symbol, published_at, sentiment_score): no receipt time. Plan: additive nullable `first_observed_at` on both (no default, no backfill; old rows stay NULL); set on INSERT only in newsSentimentService.ts::persistNewsRows and data_integrity_repair.py::repair_news_link (never in the conflict-update); failing tests: re-ingest must not move first_observed_at; a late link insert gets its own later time. Verify live: new rows non-null after the next ingest.

#### AF-20261030-15 (L141) — CLOSE
Capture half on main (bf00f8e4) and live: nse_filing_financial_observations has 1,119 rows, observed_at 2026-10-30 16:06 .. 2026-11-11 16:06 UTC. test_nse_xbrl_fundamentals_fetcher.py passes. Remaining research (event-aware abstention, decision-input linkage) is covered by AF-20261104-01 and AF-20261008-25; the row's own caveat stands (observed_at is not proof of visibility).

#### AF-20261030-13 (L143) — STILL-BLOCKED
Umbrella for the six-stock review; remaining parts depend on AF-20261030-05, -09, -11 and AF-20261008-25 (calendar to 2027-02-26). AF-20261030-03 is closed.

#### AF-20261030-11 (L145) — FIXABLE-NOW
technical_signal_observations (journal of every technical_signals mutation with recorded_at/values_json; migration 20261015234500) is live, but high_flyer_retrospective.py:697 _latest_ts still reads current technical_signals rows. Plan: as-of reader that replays the journal up to the pre-open cutoff for the precursor columns, used at lines 522, 653, 663; mark pre-journal days "availability unproven". Failing test first: update a precursor after the cutoff and assert the retrospective ignores it. Research-only output.

#### AF-20261030-10 (L146) — CLOSE
Capture on main (bf00f8e4) and live: screener_membership_runs has 16 timestamped runs (2 per date since 10-30, latest 2026-11-11 18:24 UTC, membership_count 37.9k-47k). test_screener_features_fetcher.py passes. Re-evaluation of any veto replay on the legacy table continues under AF-20261106-04 / AF-20261106-01.

#### AF-20261030-09 (L147) — FIXABLE-NOW
high_flyer_retrospective.py detect_flyers / detect_divers / precision denominator still apply the Rs 20 floor to the evaluated session's close. Plan: apply the floor to the prior close side by side with the old definition, add a methodology_version field so trends are not mixed; failing test: SPENCERS-like case (prior close 19.69, close 21.65) excluded by the new definition, included by the old. Measure the 10-28/29 cohort exclusions (9 symbols crossed) read-only before switching the headline. Report-only.

#### AF-20261030-08 (L148) — CLOSE-NO-DEFECT
Not reproducing: trendlyne-daily-fetch succeeded 11-02..11-05, 11-09, 11-10 with 0 failed symbols; "405" log lines since 11-06 are only "tlid: 405" (a symbol id), not HTTP responses. The two later failures have other causes: 11-06 anonymous session (AF-20261107-10), 11-11 host DNS ENOTFOUND after standby. Reopen on a real HTTP 405 recurrence.

#### AF-20261030-07 (L149) — STILL-BLOCKED
Fix is on main (bf00f8e4); tests pass (telegramIntegrityFormatting.test.ts, dataQualityChecks.test.ts 217). But live evidence contradicts closure: telegram_report_log scheduled Daily Data-Integrity Reports 11-04..11-09 (21:30 UTC) still show `repair\_unadjusted\_splits.py` inside a code span (backslashes = invalid command). Only ids 534/535 (11-11 07:52 UTC) show it intact. Need the next scheduled report after the 11-12 17:50 restart (21:30 UTC, i.e. 03:00 IST 11-13) to show the path unescaped; if still escaped, the second escaper (telegramService.ts ~line 303, odd-count escaping on the send path) is the defect (FIXABLE: skip escaping inside backtick spans there, test first). Check: `SELECT text FROM telegram_report_log ORDER BY id DESC LIMIT 1`.

#### AF-20261030-05 (L151) — STILL-BLOCKED
Depends on AF-20261008-25 (calendar to 2027-02-26) for frozen pre-open cohorts; the 11-05 replay is not the immutable-input condition. No scoring change.

#### AF-20261030-04 (L152) — CLOSE
Capture on main (bf00f8e4) and live: nse_results_filings.first_observed_at populated on 1,846 rows (2026-11-02 16:05 .. 2026-11-11 16:05 UTC), older rows NULL as designed. test_nse_filings_fetchers.py passes. Event-aware abstention research stays with AF-20261030-13.

#### AF-20261029-06 (L157) — CLOSE
On main (bf00f8e4). src/server/mcp/market_intelligence_mcp.py:88 labels probability fields as not validated; src/server/mcpServer.ts:235 withholds the probability. MCP servers are stdio processes spawned per agent session, so the code is live on next spawn. mcpProbabilityHonesty.test.ts and test_market_intelligence_mcp.py::test_risk_profile_identifies_probability_fields_as_unvalidated pass today.

#### AF-20261029-99 (L159) — CLOSE
Fix on main (812155b3, 2026-10-29). The only remaining queue.drain(true) is src/server/jobs/registerJob.ts:321 inside the deliberate SCHEDULER_PAUSED=1 branch; the unscheduled path removes only matching repeatables/delayed jobs. registerJobUnscheduled.test.ts (asserts drain not called) passes; bharat-server restarted since.

#### AF-20261029-03 (L161) — CLOSE-NO-DEFECT
Calendar passed: the 10-29 run failed on a different step (resolveOutcomes), 10-30 passed all steps. Since 10-29, ml-ensemble-score (10) and news-symbol-link (10) have only success rows; no timeout rows for the four steps. Closed as a one-off. Separate observation for a new row: ml-daily-ops "exceeded its 210min execution budget" on 11-06 and 11-12 (each followed ~3 min later by a success row).

#### AF-20261029-97 (L164) — FIXABLE-NOW
Cause located: src/App.tsx:22 statically imports TickerTapeWidget from components/TradingViewWidgets (used at App.tsx:345) while src/v1/V1Routes.tsx:79-80 lazy-imports the same module, so Vite cannot split it. Plan: React.lazy the ticker (Suspense fallback null) in App.tsx; verify `npm run build` no longer prints the dynamic+static warning and record entry-chunk size before/after (measure route load in the browser before claiming latency). The build output is the check.

#### AF-20261029-94 (L167) — FIXABLE-NOW
Named tests pass (test_confluence_ml_engine.py, test_cs_ranker_promotion_gate.py); live active models are finite (model_registry is_active=1: BiLSTM 0.518, confluence_ml 0.674, ensemble 0.556/0.553, exit_policy 1.685; 0 NaN). Remaining defect is the shared helper: src/server/model_promotion.py:42 clears_promotion_bar returns True for a None/NaN candidate when baseline is None; callers ml_ensemble.py:3540, live_screener_ml_ranker.py:450, dl_engine.py:1271 (DL retired). Plan: make the helper refuse non-finite candidates (one root-cause fix), failing test first in new src/server/tests/test_model_promotion_nonfinite.py (clears_promotion_bar(float("nan"), None, 0.01) is False). Side note: exit_policy active cv_roc_auc 1.685 is out of AUC range (different metric in the AUC column); worth its own check.

## Batch 2

### Batch 2 triage (2026-11-12 ~19:50 IST)

Env notes: bharat-server uptime since 2026-11-12 12:20 UTC (17:50 IST); `main` contains integration commits 244c229c / b9d161e9 / 8a3bb6f2. Vitest fails in the Bash tool env ("failed to find the current suite") but passes under PowerShell; I ran vitest + pytest with PGTEST_DB=bharat_pgtest (preflight: no user tables). 15 vitest files / 106 tests, +3 files / 12 tests, and 64 pytest tests all passed.

#### AF-20261029-91 (L170) — CLOSE
dq check `nse-filing-financials-backlog` latest result: pass, "0/932 eligible ... unparsed ... as of 2026-11-12". SUDARCOLOR period 2026-09-30 is in nse_filing_financials (parsed_at 2026-10-29 16:06 UTC, parse_error NULL). Artifact: `src/server/__tests__/dataQualityChecks.test.ts` (check id at dataQualityChecks.ts:2087).

#### AF-20261029-01 (L172) — CLOSE
Fix on main (244c229c is an ancestor of main). `pytest src/server/tests/test_mc_symbol_map.py` 10 passed. Live: technical_signals INDUSINDBK now gets mc_broker_buy_7d=0/sell=0 rows every session 10-26..11-11 (the map resolves IIB); mc_broker_upside stays NULL only because the 4 IIB recs are NEUTRAL flags (upside is computed for BUY flags only), so the row's "expect non-null" was a wrong expectation, not a failed fix. KOTAKBANK (via KMF) shows upside 16.25. Artifact: `test_mc_symbol_map.py::test_retired_aliases_do_not_make_a_live_code_ambiguous`, `test_fetch_universe_active_only.py`. Deleting the 1,554 alias rows stays a user-owned write; say so in the Closed cell.

#### AF-20261028-19 (L177) — CLOSE
Live log line, app logs 2026-11-05..11-12 every cycle: `[INTRADAY SCAN] 67/84 intraday screeners active (17 cold-dropped)` (was 84/84 through 11-04, trial expiry as predicted). Artifact: `src/server/__tests__/intradayScreenerColdDrop.test.ts` (passes).

#### AF-20261028-15 (L181) — CLOSE
Guard on main: institutional_quant_engine.py:105 (not finite / <=0 / suspect -> withheld) and :158 log; `src/server/tests/test_institutional_quant_engine.py` passes. Live: stock_ohlcv close<=0 in past 365d = 179 rows, all is_suspect=1 (0 non-suspect), matching the row. The engine is on-demand only (mcpServer.ts), spawn-per-run, no dry-run flag (it upserts canonical quant_scores), so a live write/readback was deliberately not run. Close the data-honesty defect; the return-evidence caveat is not a defect (guard is data-honesty only).

#### AF-20261028-09 (L187) — CLOSE
Live tRPC getTradeDecisionCockpitData (2026-11-12): advDecRatio=null, modelThresholdRatio=null, researchThresholdRatio=27.57, asOfDate present; misc.router.ts:643-663 labels the model ratio. Artifact: `src/components/__tests__/tradeCockpitBreadth.test.tsx` (passes). A genuine as-of A/D breadth card is a new feature, not the defect.

#### AF-20261027-08 (L193) — CLOSE
`git ls-files | grep -i v7` returns nothing; b9d161e9 is an ancestor of main; V1Routes.tsx:153-155 are redirect-only /v7-* routes; `src/components/sidebarRoutes.test.ts` passes. The user-owned restart has happened (bharat-server up since 17:50 IST today).

#### AF-20261028-08 (L194) — CLOSE-NO-DEFECT
Live cockpit response: all 20 candidates' `advice` equals canonical `unifiedClassification` (20/20), scoreResearchOnly=true on all, factors.* all null (no repeated fake factor values), verdict "NO TRADE ... research". The desk composite no longer carries action authority, so validating its 60/70 thresholds is moot; canonical-ranking edge is tracked by the frozen forward test and AF-20261026-45/-73.

#### AF-20261028-07 (L195) — STILL-BLOCKED
Depends on AF-20261111-02 (open until >= 60 forward sessions from 2026-11-12, ~2027-02-09): that shadow arm (`sizing_shadow_arm.py`, inv_vol vs inv_vol_breakout) is the pre-registered test of the breakout sizing leg. unified_ranker.py:3194 already labels the sizing "unvalidated".

#### AF-20261028-06 (L196) — STILL-BLOCKED
Monitor fix is on main (`count_cost_zeroed`, unified_ranker.py:1145/3386). The remaining EVIDENCE (is the fixed 5% edge assumption in apply_cost_penalty right) needs forward net returns: depends on AF-20261026-73 (paper book 9 of 60 sessions; earliest 2027-01-22) and AF-20261111-02.

#### AF-20261027-06 (L200) — STILL-BLOCKED
Calendar: needs 10 forward results-weeks under PROTOCOL['price_lead']; re-check 2027-02-20 as written. Nothing to do today.

#### AF-20261026-44 (L207) — CLOSE
REGIME_WEIGHTS breakout = 0.0 in all 5 regimes, each summing to 1.0 (imported and printed from unified_ranker.py); `test_regime_weights_sum_to_one` and `test_breakout_removal_redistributes_proportionally_not_a_hidden_reweight` pass. The open "later BULL verification" has now occurred: unified_recommendations has regime=BULL rows on 2026-11-06, 11-09, 11-11 (2,369-2,371 rows each) under the zero weight. Artifact: `src/server/__tests__/test_unified_ranker.py`; `scripts/measure_blend_arms.py`.

#### AF-20261026-45 (L208) — STILL-BLOCKED
Needs >= 20 independent 5-session windows on post-2026-10-26 rows; only 12 ranker dates exist since (about 2 windows). Earliest ~2027-03. Nothing to change today.

#### AF-20261026-46 (L209) — CLOSE
Calendar passed. factor_edge_history has `unified_recommendations__open_entry__generated_at` rows for runs 2026-10-31, 11-06, 11-08 including horizon 1 (unified_score 1d IC +0.0176 / +0.0147, "no edge", eff_dates 46/51). It agrees with the computed_at sweep within noise at 5d (+0.0379/+0.0355 vs +0.0419/+0.0389). Artifact: `src/server/tests/test_blend_walkforward.py::test_load_panel_dates_a_row_by_the_IST_evening_it_was_generated`. Do NOT switch the canonical label: unified_ranker.py:1270 reads factor_edge_history WHERE table_name='unified_recommendations', so switching would change a ranker input; keep the parallel sweep and record that decision.

#### AF-20261026-48 (L211) — USER-DECISION
Evidence: HKLM WindowsUpdate UX ActiveHoursStart=7, ActiveHoursEnd=1 (07:00-01:00) is already set, covering 08:30-16:30. System log since 10-26: TrustedInstaller reboots on Sun 11-01 15:23 and Sat 11-07 12:56 (weekends); 11-02 11:09 was a user restart via Start menu (market hours); 11-09 01:57 outside market. So option (1) is effectively done. Decision left: a standing rule on heavy ad-hoc analysis during 09:00-16:00 weekdays. Options: adopt a one-line rule in CLAUDE.md, or accept no rule. Recommend adopt the rule and close the row.

#### AF-20261026-54 (L217) — USER-DECISION
Decision: which new sources to onboard. Options: (a) none now (vendor-onboarding freeze; AF-20261026-73 shows no short-horizon signal clears costs; MC analyst ratings deprioritised by AF-20261026-72), (b) NSE short-selling disclosures only (free, daily, cross-sectional), (c) also ET Calls snapshot + F&O ban/MWPL. Recommend (a) and close as ACCEPT; revisit (b) only after carry/PCR (AF-20261025-08) is settled.

#### AF-20261026-73 (L221) — STILL-BLOCKED
Paper book is running: app_settings paper_book_report generated_at 2026-11-11T21:43, protocol_hash a0dcc6ca6fd1cef2, published arm 9 sessions LOW-DATA. Needs >= 60 forward sessions (earliest ~2027-01-22).

#### AF-20261026-06 (L222) — CLOSE
Integration on main (244c229c). `src/server/__tests__/testsDoNotDropProductionTables.test.ts` passes (PowerShell vitest, PGTEST_DB=bharat_pgtest).

#### AF-20261026-05 (L223) — CLOSE
On main; `scripts/vitestPoolCleanup.test.ts`, `src/server/__tests__/pgClient.test.ts`, `scripts/dbAsyncBootstrap.test.ts` pass.

#### AF-20261026-04 (L224) — CLOSE
On main; `src/server/__tests__/mlRankPct.test.ts` and `scripts/dependencySecurity.test.mjs` pass.

#### AF-20261026-41 (L226) — CLOSE-NO-DEFECT
The open question (does a ~2-3pp hit-rate excess survive costs) has been answered by other rows: AF-20261026-45 (only Buy at 5 sessions clears cost, +39.6 bps net; shorts net -5.4 bps; Strong Buy no better than Buy) and AF-20261026-73 (cost wall, paper book forward test). Persisted 2026-11-08 call_confusion run (59 dates) still shows mean long excess +2.79pp c2c / +3.46pp o2c, so the hit-rate reading is intact; no code or score change is pending. Close as superseded by -45/-73; `measurement.md` statement (no demonstrated forward-return edge) stands. Artifact: `src/server/tests/test_reverse_engineering_study.py`.

#### AF-20261026-42 (L227) — CLOSE
Persisted production rerun exists (mover_study_results call_confusion run_at 2026-11-08T14:04:30): 2026-10-13 n_obs = 1,489 (was 614), 10-12 1,489, 10-14 1,488; mean universe over dates >= 2026-09-14 = 1,393 (min 1,151). Artifact: `src/server/tests/test_reverse_engineering_study.py::test_eligible_universe_tolerates_one_suspect_bar_but_not_short_history_or_etfs` (exists, tracked).

#### AF-20261027-01 (L230) — CLOSE
On main; `src/server/__tests__/screenerAppearedAt.test.ts` and `src/server/__tests__/signalAccuracyDigest.test.ts` pass at default timeouts (PowerShell vitest).

#### AF-20261026-03 (L231) — CLOSE
On main; `src/server/tests/test_worker_service.py` and `src/server/tests/test_pg_db_fixture.py` pass against bharat_pgtest.

#### AF-20261026-02 (L232) — CLOSE
On main; `scripts/testPgExtensions.test.ts` (vitest) and `src/server/tests/test_extension_bootstrap_lock.py` (pytest) pass.

#### AF-20261025-33 (L234) — USER-DECISION
Root checkout: `npm audit` = 0 vulnerabilities (run now); `scripts/dependencySecurity.test.mjs` and `generate-job-report.test.mjs` pass. Remaining item unchanged: the PM2 daemon runs from the global install pm2 7.0.3 (`pm2 -v` and `npm ls -g pm2` both 7.0.3; latest is 7.1.2, row says 7.1.1 audits clean). Decision: upgrade the global pm2 (`npm install -g pm2@7.1.2`, `pm2 save`, `pm2 update`) which restarts every app. Recommend do it after market close on a trading day or on the weekend, then confirm `pm2 jlist` all online and re-run the global audit; I did not touch it.

#### AF-20261025-32 (L235) — CLOSE
Code on main (nseService.ts:49 shared `_nseSyncPromise`); `src/server/__tests__/nseSyncCompletion.test.ts` passes. Live: nse-sync heartbeat success 2026-11-07 02:18 UTC (weekly Sat run after the 10-29 restart), app log "[QUEUE] NSE sync completed, 2337 stocks updated" (actual written rows); job_run_history nse-sync success on 10-31 and 11-07.

#### AF-20261025-23 (L244) — CLOSE
`src/server/__tests__/edgePythonJson.test.ts` passes (3 tests). Live: tRPC getEdgeStatus and getEarningsPreview (routers/edge.router.ts via parsePythonJson.ts) return valid JSON now (forwardTest protocol_hash 13210b4e2c3ae688, earnings preview as_of_session 2026-11-11).

#### AF-20261025-24 (L245) — USER-DECISION
Decision: adopt the external trader-analyst skill tooling into the repo or keep it as separate tooling. Options: (a) keep external, close row as ACCEPT; (b) adopt (needs consumer inventory, canonical symbol mapping, live-provider tests per data-sources.md). Recommend (a): no repo consumer exists, and the vendor-onboarding freeze plus the cost wall (AF-20261026-73) argue against new surface area.

#### AF-20261025-25 (L246) — CLOSE-NO-DEFECT
No defect: the row retains the current writer and threshold and asks for a research sensitivity grid that has no consumer (F&O panel is not wired into scoring; carry superseded by AF-20261026-73). If the F&O universe is ever wired into the ranker, file a fresh EVIDENCE row then.

#### AF-20261025-26 (L247) — FIXABLE-NOW
Both components are routed (V1StockDetails.tsx:640 renders AiInsightsTab; V1Routes.tsx:174 MarketCommandCenter imports IndexKpiRow from v6/components/IndexKpiCard). Two small honesty fixes, no scoring change: (1) `src/components/v6/components/IndexKpiCard.tsx:21-23,64-66` renders a neutral 50% fill bar when dayLow/dayHigh are absent (and getMarketOverview never supplies them): make `dayRangePct` return null and omit the bar track when no provider range; extend `src/components/v6/components/__tests__/IndexKpiCard.test.ts` (write failing case: no range -> null) first. (2) `src/components/v2/views/stock-analysis/AiInsightsTab.tsx:10` `insights: any // TODO`: trace `trpc.getAiInsights` payload (V1StockDetails.tsx:70) and type it from the real response; test with the real payload shape. Verify live: render /stock details and the market command center; confirm no fill bar when range missing.

#### AF-20261025-08 (L254) — CLOSE-NO-DEFECT
Superseded for carry by AF-20261026-73: futures carry is real (IC +0.022, t 5.7) but worth ~3-8 bps/day against ~20 bps round trip and its pre-registered 5/10/21-session book fails; nothing should be wired into feature_store/ranker. Stock PCR (`f_so_pcr`) was not separately cost-tested; if wanted, file a narrow new EVIDENCE row (cost-aware factor_backtest on the ~216-name F&O panel) rather than keep this one open.

#### AF-20261025-09 (L255) — USER-DECISION
Presentation honesty already shipped under AF-20261025-22 (closed 2026-10-25, tooltips). Remaining FIX-lane part (rename `conviction_level` or add a veto-fired disclosure on unified_recommendations; only the single column `conviction_level` exists, no veto/flag column) is a schema/API change. The calibration re-read can no longer be done as written: signal_outcomes h=5 since 2026-07-01 is now 100% signal_source='technical' (183,465 rows, signal_score in -6..6), so the non-technical quintile population is gone from that table. Options: (a) accept AF-22 tooltips and close, moving calibration to the frozen forward test; (b) add a `veto_applied` boolean column + migration; (c) rename the column across consumers. Recommend (a).

#### AF-20261024-06 (L258) — USER-DECISION
Provenance on main (8a3bb6f2); `src/components/ProfileAnalysisProvenance.test.tsx` and `companyProfileSyncService.test.ts` pass. .env still has `GEMINI_API_KEY=` empty (names only checked; ANTHROPIC_API_KEY empty too) and company-profiles-sync is unscheduled without it (sync.jobs.ts:412, AF-20261017-08); last run 2026-10-28 failed 0/15. Decision: supply a provider key (Gemini or Anthropic/Bedrock route) or accept stale AI profiles. Recommend accept (profiles carry timestamp + unvalidated labels; AI growth score has no measured edge) and close; supply key only if the owner wants fresh text.

#### AF-20261024-02 (L260) — CLOSE
Delivery holds every session: technical_signals roce/interest_coverage/fcf_yield_approx non-null 1,585-1,593 / 1,620-1,626 of ~2,160 on each date 2026-11-02..11-12 (about 73.5%, the DQ floor); `test_financial_ratio_delivery.py` passes; deployed 8a3bb6f2. Model promotion remains gated by ml-model-bugs rules and is not a defect of this row.

#### AF-20261024-03 (L261) — FIXABLE-NOW
Reproduced today: first getModelRocDiagnostics call after the 17:50 IST bharat-server restart took 20.28 s (second identical call 0.21 s; cache-miss calls with days=364/363 took 0.97/0.69 s), i.e. over the 15 s smoke budget on a cold start, with no active DB sessions. Plan: (1) diagnose the first-call cost (cold buffers on the compressed technical_signals/outcomes chunks vs lazy router import) with `EXPLAIN (ANALYZE, BUFFERS)` of the router SQL from `src/server/routers/ml.router.ts:712-725` after a restart; (2) cheapest fix: prewarm the default input (days=365) once after `httpServer.listen` in server.ts; test in `src/server/__tests__/modelRocDiagnostics.test.ts`; (3) verify live: restart in a quiet window and time the first HTTP call < 5 s. Do not raise the smoke timeout.

#### AF-20261024-04 (L262) — STILL-BLOCKED
Calendar item passed: fundamental_observations holds 50,892 rows (max 2026-11-12 14:35 UTC; 39,945 at install), DQ checks fundamental-observations-freshness, fundamental-observation-writer-contract and earnings-revision-shadow-freshness all pass; tests `test_fundamental_observations.py` / `test_earnings_revision_shadow.py` pass. Alpha promotion needs prospective revision/surprise history across a results season (Q3 FY27 reporting, Jan-Feb 2027) plus a cost-aware both-tail test; vendor-onboarding freeze applies.

#### AF-20261021-03 (L265) — FIXABLE-NOW
Writer defect still in code: `src/server/feature_engineering.py:280` `out["above_sma200"] = (close > out["sma200"]).astype(int)` writes 0 where sma200 is NaN. Live feature_store: 6.6% of rows on 2026-11-12 have above_sma200=0 with sma200 NULL (6.9% on 11-05); adx=0 is 0.0% on recent dates (warm-up fix for adx/atr already holds), but 2025-05..07 history is 100% zero (historic block; do not rewrite compressed rows). Fix: `out["above_sma200"] = (close > out["sma200"]).astype(float).where(out["sma200"].notna())` and make the writer pass NULL. First write a failing test in `src/server/tests/` (short-history frame -> NaN, not 0), check readers (`deep_panel.FAKE_ZERO_COLUMNS`, ml_ensemble) tolerate NULL. Verify live after the next feature_store write: `count(*) WHERE above_sma200=0 AND sma200 IS NULL` on the latest date = 0. Leave the 2025 and 2021 blocks documented as the population boundary.

#### AF-20261021-04 (L266) — CLOSE-NO-DEFECT
Moot by the row's own measurement: screener_score is a constant (live: count(DISTINCT screener_score) = 1 on every date 2026-10-28..11-12), W_SCREENER = 0 measured worse, and the repaired-input question lives in AF-20261025-01. No constant should change.

#### AF-20261021-07 (L269) — USER-DECISION
5 extra worktrees remain (git worktree list): three are ancestors of main (scratchpad `wt` dirty=20, `postmerge-schema-20261029` dirty=1, `bsi-screener-verify-20261106` dirty=30 files) and two are NOT on main with clean trees (`.claude/worktrees/hermes-config-yaml-error-b4bb87` 57a25798 detached; `bharat-stock-intelligence.worktrees/audit-integration-2026-10-27` on branch codex/audit-postmerge-ledger-2026-10-28 848c9c6a). Decision: which to remove. Recommend `git worktree remove` the two clean not-on-main ones only after confirming their commits are superseded by the merged PR #129, and leave the dirty ones until their owners commit or discard.

#### AF-20261025-01 (L276) — STILL-BLOCKED
Calendar, in progress and healthy: intraday_recommendations_history.screener_score_shadow populated daily since 2026-10-29 (24k-32.5k rows/day, 397-447 distinct values) while the live screener_score is still 1 distinct value; that is about 10 of ~20 sessions. Grade shadow vs live after ~20 sessions (~2026-11-26). Do not change W_SCREENER.

#### AF-20261022-02 (L279) — FIXABLE-NOW
Still in code: `src/server/confluenceEngine.ts:367` narrates `N bullish scanner(s)` from vendor `sentiment === 'bullish'` labels (measured inverted, screener bullish consensus IC -0.027). Wording-only fix, no score change: change that string to `N scanner memberships (direction unverified)`, and update the two regexes that depend on the old text in `src/server/telegramRecommendations.ts:116` and `:371` in the same commit (plus their tests); failing test first = brief Why line for a row with a bearish-named scanner must not say "bullish". Verify live by rendering buildMorningBrief read-only. Leave the optional measurement (does scanner count correlate with confluence_score) out of scope.

#### AF-20261023-01 (L280) — USER-DECISION
`niftytrader_live_screener_snapshots` is now 8,586 MB / ~18.1M rows (was 5.5 GB / 13.0M on 10-23, about +3 GB in 20 days); whole DB 47 GB; D: has 123 GB free. Decision: (a) stop its writer, (b) thin it (full resolution for a window, sampled after), (c) compress it, (d) leave. Recommend (a) stop the writer (no reader, intraday mover use untested, freeze rule) after a fresh pg_dump; keep the other 29 small tables.

#### AF-20261019-03 (L281) — CLOSE-NO-DEFECT
Superseded by AF-20261017-08: `company-profiles-sync` is now deliberately unscheduled while GEMINI_API_KEY is unset (sync.jobs.ts:412 `unscheduledReason`); no red run since 2026-10-28 (job_heartbeat last run 10-28 failed, nothing after). The credential choice itself is carried by AF-20261024-06.

#### AF-20261019-02 (L282) — USER-DECISION
Re-checked: `investsights_pe_band_history` (373,812 rows) and `marketsmojo_fintrend_history` still have no reader outside fetchers, backfill and DQ/queue wiring (grep over src). Decision: retire both fetchers, or wire a reader and measure first. Recommend retire (frees a 20-min daily and 40-min weekly step; nothing consumes them and the freeze rule requires a hypothesis before wiring).

#### AF-20261017-11 (L285) — USER-DECISION
Still on the same host: PG_BACKUP_DIR is set to a folder on C: (`bharat-backups-overflow`, latest dump bharat_intel_20261111_231502.dump present), which is a different volume but the same laptop. Decision: choose an encrypted off-host target (cloud bucket, NAS or external drive), retention and restore-test cadence. Recommend an encrypted off-site copy of the weekly full dump plus a monthly restore test; I copied nothing.

#### AF-20261017-03 (L292) — CLOSE-NO-DEFECT
Evidence-only row with an explicit "do not tune the ranker"; the frozen forward gate (hash 13210b4e2c3ae688, 24 sessions per getEdgeStatus) and AF-20261026-45/-73 own the verdict. No code change is pending. Close as superseded; the symbol-level exceptions stay in `docs/digest-reverse-audit-2026-10-17.md`.

## Batch 3

### Batch 3 triage (2026-11-12 ~19:30 IST). Read-only.

#### AF-20261007-05 (L298) — STILL-BLOCKED
Arbiter forward_test_report.py needs ~100 sessions / 20 independent 5d windows; unblocks ~2027-02-26. measurement.md forbids acting on in-sample reading. No action possible today.

#### AF-20261008-05 (L304) — STILL-BLOCKED
Depends on AF-20261007-05 (same forward-test arbiter, 2027-02-26). Misleading-copy half already fixed (BuyRecommendationsPage/DashboardPage).

#### AF-20261008-16 (L315) — STILL-BLOCKED
EVIDENCE, 2027-02-26. Shadow-arm instrument (accuracy_shadow_arms.py) already running nightly; nothing to change before the forward-test floor.

#### AF-20261008-17 (L316) — STILL-BLOCKED
Live: `select count(distinct fitted_at::date) from calibration_shadow` = 9 fit dates (2026-10-29..11-11), shadow table writing. Grade shadow vs live Brier after ~20 sessions (~2026-11-26); swap decision then.

#### AF-20261008-21 (L320) — CALENDAR-PASSED
Live: `select count(distinct date) from market_regimes where date>='2026-08-10'` = 71 point-in-time dates (>=60 threshold met; row said ~2026-11-10). Next step: run the replay (flag `regime_macro_ret_from_close` ON vs OFF, 200DMA objective conditioner) read-only; that measurement is now producible. Flipping the flag / retrain-decoupling changes labels => needs measurement.md reading first, so row stays open until the replay verdict is recorded.

#### AF-20261008-22 (L321) — STILL-BLOCKED
Live: 95 sessions since 2026-06-30 (`count(distinct date) stock_ohlcv RELIANCE`); needs 100 => ~2026-11-19/20. Then drop-one ablation of the date-constant macro block. Do not unify INDIA_VIX/INDIAVIX before it.

#### AF-20261008-25 (L324) — STILL-BLOCKED
Prospective capture verified live: unified_recommendations_history last 7d 11,825 rows, 9,478 with `penalties` non-null (max generated_at 2026-11-11 17:00 UTC). Grading the red-flag veto as shadow arm is EVIDENCE-blocked to 2027-02-26.

#### AF-20261008-27 (L326) — STILL-BLOCKED
Architecture decision waits on paper_book.py forward verdict (~2027-01-22). Nothing to fix.

#### AF-20261008-30 (L329) — USER-DECISION
Program record; remainder = (E) accuracy levers stay shadow-only, (F) simplification steps one by one, DB-write backfills (filing-date, options 2021-24, shareholding, insider) and AF-20261008-13 repair `--apply`. Decision: authorise or decline each of backfills/--apply. Recommendation: decline backfills until a forward-test arm needs them; approve F items individually; close the program row once those answers are recorded.

#### AF-20261017-06 (L337) — CLOSE
Catch-up exercised live: pm2 log lines `[QUEUE] confluence-compute FORCED — no write in the last elapsed window (overdue catch-up)` at 2026-11-09 16:00 IST and 2026-11-11 16:00 IST (logs/pm2-out__2026-11-10_*.log, __2026-11-12_*.log); job_run_history confluence-compute: after host sleep (last run 11-10 18:02Z) next success 11-11 10:30Z, then every 30 min; 12:30Z 11-12 etc success. Code: src/server/jobs/confluence.jobs.ts isConfluenceOverdue (L99, wired L149-160), commits e3c9f5ae, 5f34da61. Tests exist: src/server/__tests__/confluenceMissedWindowCatchup.test.ts, confluenceForceWindow.test.ts. bharat-server restarted 2026-11-12 12:20Z (after those commits).

#### AF-20261017-07 (L338) — CLOSE
Live evidence of the corrected 405 behaviour: logs/pm2-out__2026-11-12_00-00-00.log L27414 `HTTP 405 for SCHAEFFLER; opening local cooldown` 20:07:38 IST, next fetch of SCHAEFFLER 20:18:38 (11 min, past the 10-min cooldown, vs 5 s before), cooldown skips logged for GRAPHITE/HAPPYFORGE, then GRAPHITE fetched fine 20:22. The 11-11 run's 216/500 failure was the DNS outage at standby wake, already triaged and refetched (214/216) under AF-20261111-03. Fix bf00f8e4 on main, bharat-server restarted after. Tests: src/server/__tests__/trendlyneStockIdResolution.test.ts, trendlyneDailyFetchTopN.test.ts exist. Only the 11-06 failure (244/500) predates evidence; no tolerance added.

#### AF-20261017-08 (L339) — USER-DECISION
`.env` still has `GEMINI_API_KEY=` (empty; checked, value not printed). Scheduler-side disable + monitor disabledReason live (bf00f8e4). Decision: supply a Gemini key (restores company-profiles + chatbot answers) OR formally retire company-profiles-sync + the chatbot Gemini path. Recommendation: supply the key if the chatbot is wanted; else retire the job and close with "accepted: feature off". Agent cannot supply a secret.

#### AF-20261008-39 (L341) — STILL-BLOCKED
Depends on AF-20261008-22 (same date-constant macro-block ablation, ~2026-11-19/20). Do not change GIFT series / ret_5d first.

#### AF-20261008-42 (L344) — STILL-BLOCKED
Pre-registered forward shadow arm; verdict pools Q2-Q4 FY27, unblocks 2027-06-30.

#### AF-20261004-05 (L353) — USER-DECISION
BullMQ legacy repeatable APIs still used everywhere (migration debt, v6 not in use). Decision: migrate to upsertJobScheduler now (large staged change, parity tests) or accept until a v6 upgrade is wanted. Recommendation: ACCEPT-and-close with one guard: a test failing if package.json bullmq major >= 6 (forces the migration at upgrade time); do not migrate speculatively.

#### AF-20261004-06 (L354) — CLOSE-NO-DEFECT
Superseded by AF-20261107-09 (open, user decision: Tapetide API token + permission; same 404/401 vendor move, plus stale-cache lineage fix). Duplicate tracking of the same defect; RULE ZERO owner decision lives there.

#### AF-20261004-07 (L355) — FIXABLE-NOW
Re-ran `scripts/integrity_sweep.py --table X` today: feature_store dead = days_to_next_earnings, earnings_in_5d; technical_signals dead = days_to_next_results; unified_signals clean. pledge_chg_90d and ext_* (the other live inputs in the row) are no longer dead. Root cause of the remainder, traced live: days_to_next_results is non-null on 11-03/04/06 (611/561/289) and 0 on 11-02, 11-05, 11-09, 11-11, 11-12 although stock_earnings_dates holds 501 current future rows (max fetched_at 2026-11-06). src/server/mc_earnings_fetcher.py:192-196 `fetch_earnings_dates` returns early on `if not data:` ("Upcoming: no data returned", seen 11-11 20:27 after a curl 28 timeout) and so skips `_backfill_days_to_results(con)` at L238; feature_store earnings_in_5d derives from the same table.
Fix: call `_backfill_days_to_results(con)` before that early return (stored rows are still valid future dates). First test: in src/server/tests/test_mc_earnings_fetcher.py stub `_get` -> None, seed stock_earnings_dates + a technical_signals row for logical_trading_date(), assert days_to_next_results written (fails on current code; PG-backed so needs PGTEST_DB). Verify live: next ml-daily-ops run, then `select date,count(days_to_next_results) from technical_signals` non-zero on a timeout night; re-run integrity_sweep. Not verified: that the 0-days on 11-02/11-05 had the same timeout cause (only 11-11 log seen).

#### AF-20260924-02 (L356) — CLOSE
On main: marketsmojo_stock_picks_fetcher.py store() sets `fetched_at=now()` on conflict (L136-150); newsSentimentService.ts L379-388 same; dataQualityChecks.ts has RETIRED_FEATURE_COLUMNS + assertsStaticProperty. Live: `max(fetched_at) marketsmojo_stock_picks` = 2026-11-11 14:35 UTC (advancing daily). Tests: src/server/__tests__/dataQualityChecks.test.ts (preopen ceiling REGRESSION GUARD at L837-859), dataQualityFrozenDetailRegression.test.ts. Regime mechanism-health reframe is intentional; re-open trigger already encoded.

#### AF-20260925-03 (L359) — CLOSE
Verified on main: src/server/seed_news.cjs absent; `grep -c better-sqlite3 package.json` = 0; backend-python/requirements.txt carries the tabulate comment and joblib/matplotlib unpin note (L124-128); README says Python 3.11+; graphify-out/.graphify_python has no BOM. Item (b): root requirements.txt was later deleted in c2ceae0e (stale data cleanup), so it is moot. One-time hygiene, no recurring class; artifact = repo state + `npx tsc --noEmit`.

#### AF-20260926-05 (L365) — CLOSE
Artifacts exist: .claude/hooks/claude-config.test.mjs (7 tests incl. rules `paths:` frontmatter check), scripts/sql.py (used all session: "read-only, timeout 60s" banner; writes rejected by design). Did not re-run vitest (globalSetup demands PGTEST_DB; refused to point at prod).

#### AF-20260926-08 (L368) — USER-DECISION
Two definitions of news_sentiment_score still exist (feature_store discrete vs technical_signals continuous). DL retirement (AF-20261111-01) removes the retrain-skew objection: dl_engine is no longer scheduled. Remaining readers of the discrete column: factor_backtest.py (and feature_engineering writer). Decision: declare technical_signals' continuous column canonical and repoint factor_backtest, or keep both and rename. Recommendation: canonical = continuous (ml_ensemble, scoring_engine, UI already use it; news sentiment has no edge anyway), repoint/retire the feature_store column, add the r>=0.9 paired assertion only if both survive.

#### AF-20260925-05 (L371) — CLOSE
Code on main (438e8fdd 2026-09-27); chatbot pm2 process online since 2026-11-12 08:51 UTC (after the commit). Live today (read-only, production venv, same code): get_sector_momentum -> dict in 0.3 s, get_signal_accuracy -> dict 2.2 s, get_top_confluence_stocks -> 20 rows 2.4 s (was >290 s). Test: tests/chatbot/test_market_tool.py (18 tests; DB-backed so not re-run here).

#### AF-20260924-01 (L372) — FIXABLE-NOW
src/server/queues.ts:1063 now `runPython('mc_broker_reco_fetcher.py', ['--days','7'], 15 * 60_000)`; pm2 logs show mc_broker_reco completing 11-05, 11-06, 11-09, 11-11 with no timeout. No regression test exists (grep of __tests__ finds none). Add src/server/__tests__/mcBrokerRecoBudget.test.ts: read queues.ts, assert the mc_broker_reco_fetcher runPython budget >= 12*60_000 (fails against the old 6*60_000), then close the row citing it.

#### AF-20260918-06 (L377) — CLOSE-NO-DEFECT
The "re-open on second occurrence" trigger fired: dl-macro-fetch sector_global_corr failed again 2026-11-02 and 11-04 (02:33Z) and was root-caused/fixed as AF-20261107-04 (3-min budget raised to 10 min, commit 2ba65370, test src/server/__tests__/sectorGlobalCorrBudgetParity.test.ts). Live: dl-macro-fetch success on every run 2026-11-05..11-12. Superseded by AF-20261107-04.

#### AF-20260913-02 (L397) — CLOSE-NO-DEFECT
Moot: remaining half was the DL retrain/gating of dl_score; DL inference+retraining retired 2026-11-11 (AF-20261111-01 closed, dlRetired.test.ts) and AF-20260913-05 closed as superseded. The feature_store half already landed (1728f3a2, test_feature_engineering_deep_history.py).

#### AF-20260913-03 (L398) — USER-DECISION
Live: technical_signals.insider_buy_pct_90d now produced by corrected logic (11-09: 174 zeros of 456 populated = 38%, 71 at neutral 0.5; 2026-08-03: 160 of 171 = 94% zeros). Open item is only whether to backfill technical_signals HISTORY (DB write to a hypertable) so ml_ensemble's training history matches serving. Recommendation: do not backfill (ranker smart_money weight is 0.0, `ml` has own IC +0.016 per AF-20261008-16); accept mixed history and close; backfill only if the ml arms are ever promoted.

#### AF-20260913-07 (L402) — STILL-BLOCKED
ml_ensemble.py:246 still `num('return_on_equity', 0)`; drop_untrainable_features (L3077) still tests non-null on post-fill data. The 2026-09-19 "closed" addendum in docs/audit-findings.md measured score-NULL rate, not pre-fill feature coverage, so it does not answer this row. Real test (retrain with pre-fill guard + InvestSights ROE vs incumbent on realized factor_edge_history) depends on AF-20261008-16: ml's own IC is +0.016 and dropping it raises the re-blend, so whether ml inputs are worth repairing waits on the shadow-arm verdict (2027-02-26).

#### AF-20260911-04 (L409) — USER-DECISION
Live `pg_stat_bgwriter` since reset 2026-11-09 04:50 UTC: 835 timed + 5 req checkpoints, checkpoint_sync_time 11,375,396 ms = ~13.5 s mean per checkpoint (the row had p50 0.06 s, p99 103 s), so the fsync stall is still present. Decision (needs admin): add a Defender exclusion for D:\DockerData (trades scan coverage for I/O) or not. Recommendation: add it (data volume only), re-measure sync time after a week; if mean stays >2 s, investigate the Docker VHDX/disk.

#### AF-20260910-21 (L413) — CLOSE-NO-DEFECT
Dependency AF-20260910-18 closed 2026-09-10 (raw feature_store). drift_detector's only action, the DL emergency retrain, no longer exists: queues.ts:1271-1275 logs "EMERGENCY_RETRAIN signalled (DL retrain retired; nothing queued)". The PSI constants (drift_detector.py L69-71) now gate nothing but a log line, so re-calibrating them has no consumer. Any future recalibration is new work.

#### AF-20260910-30 (L418) — CLOSE-NO-DEFECT
Premise disproven on today's data. DBEIL/E2E/AQYLON 2025-05-12 are flagged `impossible_move` and the bars are true level shifts (DBEIL 1.30 -> 13.2, E2E 26.7 -> 280.5 vs prior close; same date on all three). All currently-flagged `impossible_move` bars (62): min close ratio 0.00076, median 5.47, max 1280, 0 within +-20% of prior close; the 148 other impossible_move bars were already un-quarantined (is_suspect=0) by the corporate-action repair. Current is_suspect=1 population is 9,409 bars / 2,346 symbols (8,499 universe-wide flat zero-volume closed sessions, 630 absent_from_official_bhavcopy, 84 nonpositive, 31 ohlc_inconsistent, 62 impossible_move), not the 474/87 of the row. Side note for a new row if wanted: those three symbols show a ~10x seam on 2025-05-12 (history before the date looks 10x low), a corporate-action adjustment question.

#### AF-20260910-26 (L420) — USER-DECISION
Startup-folder rung installed: `bharat-pm2-resurrect.cmd` in the user Startup folder (LastWriteTime 2026-10-04); `Get-ScheduledTask bharat-pm2-resurrect` returns nothing. Only an elevated run adds the boot/wake trigger. Decision: run `powershell -ExecutionPolicy Bypass -File scripts/install-pm2-autostart.ps1` once from an admin shell, or accept the Startup rung (covers Windows-Update restarts that auto-sign-in). Recommendation: accept and close; the outages since are sleep/standby (host standby 2026-11-11), whose fix is the power plan (never sleep on AC), not a scheduled task. Cross-ref AF-20260917-14.

#### AF-20260910-27 (L421) — FIXABLE-NOW
Not done: commit 2ba65370 only fixed the log-file naming. .claude/skills/repo-doctor/doctor.mjs:455 BENIGN_LOG list and the L482 classification still treat the 0x40010004/0xC0000142 pair and ECONNRESET bursts as unclassified. Plan: in doctor-lib.mjs add `classifyRestartBurst(...)`; treat `[PY] ... exit code 1073807364|3221225794` as benign when near a bharat-server pm_uptime/host boot, and ECONNRESET benign only when most of the burst's timestamps fall within a window of such a restart; a non-restart ECONNRESET must still WARN. Test first in .claude/skills/repo-doctor/doctor-lib.test.mjs (negative control: ECONNRESET burst far from any restart stays WARN). Verify: run doctor.mjs after the next pm2 restart; log-errors PASS with the burst named.

#### AF-20260910-05 (L435) — STILL-BLOCKED
(a) pythonRunner.describeExitCode (pythonRunner.ts:62; test src/server/__tests__/pythonRunnerExitCodes.test.ts) and (b) repo-doctor `platform-outage-gaps` (doctor.mjs:350) are landed and exist. Remaining (c) is the same elevated-installer question as AF-20260910-26 / AF-20260917-14; cannot close before that decision.

#### AF-20260815-05 (L466) — CLOSE-NO-DEFECT
Duplicate of the closed copy at docs/audit-findings.md:489 ("closed 2026-08-18, all three sub-issues independently resolved"). Insider half superseded by AF-20260926-09 (closed 2026-10-05): the dead NSE corporates-pit pull was removed deliberately; live `insider_transactions` max(transaction_date)=2026-05-02, max(fetched_at)=2026-10-02 is the expected frozen state, and the live feature path reads insider_trades (max date 2026-11-09). Ledger cleanup: drop the open duplicate at L466.

#### AF-20260816-14 (L470) — FIXABLE-NOW
The row is "open by design" because nothing automated checks that the running server contains the committed .ts. Today it is current (bharat-server started 2026-11-12 12:20 UTC; no .ts/.tsx commit after it; only package.json dep bump 250c4743 at 18:04 IST, so confirm node_modules were installed before the restart). Make it executable: add a repo-doctor check `server-stale-vs-ts` in .claude/skills/repo-doctor/doctor.mjs comparing `pm2 jlist` bharat-server pm_uptime to the newest mtime of src/server/**/*.ts + server.ts (WARN if newer). Pure verdict function in doctor-lib.mjs with a doctor-lib.test.mjs case (uptime older than newest ts => WARN, newer => PASS). Then close the row citing that check.

#### AF-20260816-15 (L471) — CLOSE-NO-DEFECT
ACCEPT recorded 2026-08-18 (docs/audit-findings.md:491; reasoning still holds): no root cause, no symptom. Today: `grep -l UV_HANDLE_CLOSING logs/*.log` returns nothing; bharat-server restart_time=5 (was 38). The open copy at L471 is a stale duplicate. Re-open trigger: any recurrence of the assertion. (Separate open row AF-20261107-06 covers a different native crash, 0xC0000409.)

#### AF-20260817-24 (L483) — CLOSE-NO-DEFECT
Split rows all closed: AF-20260817-27 (0.65 cluster threshold measured t=16.47, kept, closed 2026-08-17), AF-20260817-28 (crowding 0.70 ACCEPT, closed 2026-09-30, see AF-20260902-09), AF-20260817-29 (UPDATE_THRESHOLD replaced by multi-fold gate, test_backtest_optimizer.py, closed 2026-08-17). Nothing left under the parent.

#### AF-20260823-71 (L846) — USER-DECISION
Floor still in place (backfill_technical_features.py:355 `min_price=15.0`, applied at L405; 2 sub-15 rows in the 11-09 grid). Whether sub-Rs15 grid rows are usable is a universe-widening scoring change and the ranker has no demonstrated edge (measurement.md). Decision: widen (needs a measurement first) or keep the floor and document it. Recommendation: keep the floor, document its derivation as "unmeasured, kept for comparability" in the code comment and close as ACCEPT; revisit only if the forward test shows an edge worth extending.

#### AF-20260823-72 (L847) — CLOSE-NO-DEFECT
ACCEPT with reasoning intact (cross-universe comparability is a design question, recorded in measurement.md). Visibility artifact exists under a new name: src/server/e2e_lifecycle_check.py:103 stage `canonical:contributing engine coverage`.

#### AF-20260823-81 (L964) — CLOSE-NO-DEFECT
Superseded: the Buy-side vs Hold probe was redone properly as AF-20261007-05 (open-entry, non-overlapping, liquidity-stratified) and is scored forward by forward_test_report.py; the IC-tilt gate stays OFF with tests/test_ranker_ic_tilt.py guarding it. No separate probe owed.

#### AF-20260827-05 (L977) — FIXABLE-NOW
Fix is on main and live: ecosystem.config.cjs carries IST cron strings and the LOCAL-TIME header (L90-97); pm2 jlist shows pg-backup-nightly `15 23 * * *` and bqa-daily `0 6 * * *`; pg-backup-nightly last started 2026-11-11 17:45:00 UTC = 23:15 IST and bqa-daily 2026-11-12 00:30 UTC = 06:00 IST (fired at the intended IST time). The 11 gf-* cron apps were deregistered 2026-09-10. No regression test pins the strings. Add src/server/__tests__/ecosystemCronRestartIst.test.ts: parse ecosystem.config.cjs, assert each cron_restart app's string equals an expected IST map (pg-backup-nightly '15 23 * * *', bqa-daily '0 6 * * *') and fail on an unlisted cron_restart app; fails against the pre-fix '45 17 * * *'. Close after it passes.

#### AF-20260827-14 (L986) — CLOSE-NO-DEFECT
Cause chain addressed elsewhere: the per-column ALTER pattern was fixed by AF-20260829-26 (closed 2026-08-29: IF NOT EXISTS + SET lock_timeout='2s'; same guard now in exit_labeler.py:301 and trendlyne_adv_tech_fetcher.py:153) and the orphan-spawning gf-* jobs were deregistered 2026-09-10. No lock pile-up recurrence in the ledger since. (10 bare `ADD COLUMN` without IF NOT EXISTS remain in src/server/*.py; hygiene, not this incident.)

#### AF-20260827-16 (L1011) — FIXABLE-NOW
On main (1fdb9279): call_wall_dist_pct appears 11x, put_wall_dist_pct 10x, near_expiry_gamma 9x in ml_ensemble.py. No test pins that every SELECT site includes them. Add src/server/tests/test_ml_ensemble_select_columns.py: for each of the 5 SELECT sites assert the three columns appear in the query text (fails if one is dropped from any site). Then close.

#### AF-20260827-18 (L1013) — FIXABLE-NOW
Fix on main (e9daeaed): working_capital_fetcher.py:249 `fetch_et_stats(..., "Quarterly", session, last=20)`; test src/server/tests/test_working_capital_fetcher.py::TestQuarterlyFetchDepthMatchesBalanceDepth passes (ran: 1 passed). Backfill happened: working_capital_history now has >=4 fiscal years for 1,678 of 1,858 symbols (was 1 each); technical_signals wc flags 504/474 on 10-12 and 499/471 on 11-04 (ccc_trend non-null ~1,286). NEW live defect: on rows dated 2026-11-09 and later ccc_trend is still populated (1,286-1,288) but wc_deteriorating/wc_improving sum to 0. Probable cause (not confirmed): update_technical_signals writes `WHERE date >= floor` only to rows that exist at run time, and rows created afterwards get the column DEFAULT 0 for the flags while ccc_trend is carried by some path I did not locate. exit_policy.py:415 and ml_ensemble read the flags. Plan: locate the ccc_trend carry-forward, then derive/carry the two flags the same way (or recompute them from ccc_trend in the daily scan); test first in test_working_capital_fetcher.py; verify `select date,count(ccc_trend),sum(wc_deteriorating) from technical_signals` on the next trading day.

#### AF-20260828-20 (L1015) — CLOSE
On main (032e38e0): tickertape_scorecard_fetcher.py uses ThreadPoolExecutor (L27, L149); tests src/server/tests/test_tickertape_scorecard_fetcher.py 5 passed today. Live: proprietary_scores_history written on every trading day (11-11: 7,703 rows; 11-09: 7,699; 11-06: 7,694; 11-05: 7,682).

#### AF-20260828-21 (L1016) — CLOSE
Both parts on main: index_membership_fetcher.py prints no longer contain the arrow; `index-membership-daily` registered at src/server/jobs/sync.jobs.ts:501-512 (commit a75f1623) and pinned in jobRegistryCronMirror.test.ts and jobRegistryGraceMinutesConsistency.test.ts. Live: job_run_history `index-membership` success every trading day 2026-11-02..11-11; technical_signals is_nifty50 sum = 50 on 11-04, 11-05, 11-06, 11-09, 11-11 (the 11-12 row is 0 only because the 21:05 IST run has not happened yet).

## Batch 4

#### AF-20260828-22 (L1017) — CLOSE
Evidence: ThreadPoolExecutor/MAX_WORKERS present on main (commit e1db34b0) in marketsmojo_{financials,fintrend,shareholding}, investsights_{fundamentals,announcement_intel}, pcr_fetcher; live DQ freshness heartbeats for all marketsmojo-*/investsights-*/nt-index-pcr all success 2026-11-12 19:22 IST. pe_band/investor_activity deliberately stay sequential (documented), not a defect.
Artifact: src/server/tests/test_marketsmojo_incremental_write_siblings.py (6 pass with PGTEST_DB=bharat_pgtest; skips without PG). Python is spawn-per-run so deployed.

#### AF-20260828-24 (L1019) — CLOSE-NO-DEFECT
Evidence: .env GEMINI_API_KEY len=0 still (credential only the user can supply). Superseded by AF-20261017-08 (company-profiles-sync unscheduled, runState disabled, owner decision pending) and AF-20260905-26. ACCEPT-lane, reasoning holds.

#### AF-20260828-25 (L1021) — CLOSE-NO-DEFECT
Evidence: job_run_history trendlyne-midweek: success on every weekly run 09-08 .. 11-10 (10 consecutive, 11-10 20:04). Block was transient/time-windowed; premise (persistent lower ceiling) disproven. Consecutive-failure alarm is covered by digest fail-rate lanes.

#### AF-20260829-11 (L1032) — USER-DECISION
Evidence: both keyword impls are one (classify_screener imported by scripts/reclassify_screener_sentiments_all.py). Remaining: ETnow "Increasing Trading Activity with Negative Weekly returns" (3 variants) and "Turnaround Champs" stored bearish (keyword) vs FinBERT bullish; "Decreasing Promoter Pledge" now stored bullish (agrees). catalog vs master mismatch now 0 of 1,675 pairs (live).
Decision: which producer is authoritative for screener sentiment tie-break. Options: (a) keyword classify_screener authoritative, FinBERT infer() advisory only; (b) FinBERT. Recommend (a): stored values already match it, DQ check screener-sentiment-catalog-master-divergence enforces it, and screener sentiment has no measured edge so 3 labels are immaterial. Then close.

#### AF-20260829-12 (L1033) — CALENDAR-PASSED
Ran read-only SQL (rank IC of technical_signals.screener_momentum_score vs open-entry forward return, dates 2026-08-31..2026-11-03, 44 post-reclass dates): 1d IC -0.0079 (t -1.36), 5d IC -0.0238 (naive t -4.58, overlapping windows so inflated; effective ~ -2). No positive effect from the relabel. Result closes the EVIDENCE question: relabel produced no forward edge (consistent with measurement.md "screener engine harmful"); do not add weight. Next: append this reading to measurement.md "Open/pending", set row closed with date. No relabel/sync needed.

#### AF-20260829-20 (L1041) — CLOSE
Evidence: live join of screener_catalog.signal_bias vs screener_master.inferred_sentiment on (scan_id/screener_id, source) = 1,675 pairs, 0 mismatched (was 222/972). DQ check screener-sentiment-catalog-master-divergence last_status success 11-12 19:21.
Artifact: check screener-sentiment-catalog-master-divergence in src/server/dataQualityChecks.ts:3018; tests in src/server/__tests__/dataQualityChecks.test.ts:509-.

#### AF-20260829-21 (L1042) — CLOSE-NO-DEFECT
Evidence: git grep to_polars_df finds 0 occurrences in *.py; helper deleted in 9ac1c2d1 (on main). pyarrow absent from venv and requirements carry DO-NOT-RE-ADD comment (backend-python/requirements.txt:20). Moot.

#### AF-20260829-29 (L1061) — CLOSE
Evidence: ran `python scripts/integrity_sweep.py --table confluence_signals` = 9.4 s total (was 100+ min). scripts/test_integrity_sweep.py 9 passed. _date_eq_filter at scripts/integrity_sweep.py:220.
Artifact: scripts/test_integrity_sweep.py.

#### AF-20260905-03 (L1144) — CLOSE-NO-DEFECT (superseded for the credential half)
Evidence: reporting fix on main (5d7e3b1e), src/server/__tests__/companyProfileSyncVerdict.test.ts passes (vitest 110 passed in 6-file run). company-profiles-sync last 10-28 failed 0/15 then unscheduled; credential half tracked by AF-20261017-08 (user decision). Close this row citing that.

#### AF-20260905-15 (L1156) — STILL-BLOCKED
Evidence: reconcile_stock_ohlcv_from_bhavcopy.py docstring + queues.ts:785-795 still say dual-write validation phase; no cutover. dl-feature-refresh kept (cron 30 11 UTC = 17:00 IST) after DL retirement (AF-20261111-01). Waits on the bhavcopy cutover decision. Note newer AF-20261112-09 (feature refresh before flow inputs) overlaps; fold this row into it.

#### AF-20260905-26 (L1167) — CLOSE-NO-DEFECT
Evidence: premise stale: .env ANTHROPIC_API_KEY len=0 now as well as GEMINI_API_KEY len=0 (key no longer in the wrong variable). Superseded by AF-20261017-08.

#### AF-20260906-01 (L1171) — CLOSE-NO-DEFECT
Evidence: dl-retrain-weekly retired 2026-11-11 (cf0d6051, AF-20261111-01; src/server/__tests__/dlRetired.test.ts passes). Moot.

#### AF-20260906-02 (L1172) — CLOSE-NO-DEFECT
Evidence: DL engine retired (AF-20261111-01); fresh-fold walk-forward fix on main with src/server/__tests__/test_dl_walkforward_date_split.py. Leak magnitude measurement no longer needed.

#### AF-20260917-14 (L1229) — USER-DECISION
Evidence: job_run_history gaps >90 min over 30 days (live): 10-14 149m, 10-17 424m, 10-19 551m, 11-02 148m, 11-09 517m, 11-11 510m+185m. 11-09/11-11 are host standby, closed by AF-20261111-04 (lid-close on AC set to Do nothing 2026-11-12). Startup-folder bharat-pm2-resurrect.cmd exists; Task Scheduler rungs still need elevation (boot trigger for crash/power-loss).
Decision: run install-pm2-autostart.ps1 once elevated (adds boot trigger) vs accept the Startup-folder rung and close. Recommend accept + close after 14 days with no gap >90 min after 2026-11-12 (check same gap query); laptop on battery makes power-loss reboot rare.

#### AF-20260917-20 (L1241) — CLOSE
Evidence: live unified-ranker job_run_history 12/12 success 10-27..11-11 (max 20.8 min, budget now 75 min: src/server/jobBudgets.ts:2; registry grace 95), 0 failures in 14 days. Digest waits on freshness (unifiedRankingIsFresh in src/server/jobs/digests.jobs.ts). bharat-server restarted 2026-11-12 17:50 IST, after those commits.
Artifact: src/server/__tests__/recommendationsDigestFreshness.test.ts and jobRegistryGraceMinutesConsistency.test.ts (both pass, vitest 6 files/110 tests with PGTEST_DB=bharat_pgtest).

#### AF-20260927-03 (L1524) — CLOSE
Evidence: pytest src/server/tests/test_ontology_metrics.py passes against empty bharat_pgtest (48 passed across 5 files). Artifact: test_every_bound_column_exists in src/server/tests/test_ontology_metrics.py.

#### AF-20260927-04 (L1525) — CLOSE
Evidence: vitest src/tala/TalaApp.test.tsx passes (9 cases, in the 110-test run). TALA files now tracked (24). Artifact: src/tala/TalaApp.test.tsx.

#### AF-20260927-05 (L1526) — FIXABLE-NOW
Evidence: git grep still finds section-named pointers into the split recurring-bugs.md: .claude/commands/job-runtime-audit.md:26 ("mirror-consistency"), .claude/commands/temporal-correctness-audit.md:106, .claude/rules/data-sources.md:379 and :387, .claude/rules/measurement.md:928. These are the "3 docs" the row left unresolved.
Fix: repoint each to the bugs-*.md file holding that section (grep the section title across .claude/rules/bugs-*.md). Verify: git grep for each title only hits bugs-*.md. Tiny doc-only change; then close.

#### AF-20260927-06 (L1527) — CLOSE
Evidence: vitest .claude/hooks/graphify-pointer.test.mjs passes in the 6-file run. Artifact: that file (30_000 timeout argument).

#### AF-20260927-08 (L1529) — CLOSE
Evidence: live regime_edge_status has calib_slope populated for all regimes (HIGH_VOL -0.1195, BEAR 0.028, SIDEWAYS 0.162, __GLOBAL__ 0.0015; computed 2026-11-11). Artifact: src/server/tests/test_ml_calibration.py (stratified AUC tests), migration 20260927160000 applied.

#### AF-20260927-09 (L1530) — CLOSE-NO-DEFECT
Evidence: premise disproven (WAF block uses record_allowance_exhausted, not consecutive-fail counter). src/server/tests/test_fetch_utils.py passes (in the 48-test pytest run).

#### AF-20260927-10 (L1531) — USER-DECISION
Evidence: items 1,2,3a closed with test (available_at immutability). Open 3(b): src/server/semantic_evidence.py build_decision_evidence (lines 113-146) still labels zero-weight engines (dl/screener/cs/smart_money) supports/contradicts; decision_outcome_resolver.py is now a caller.
Decision: how zero-weight engines appear in the decision evidence. Options: (a) emit relation "context" with a note "zero weight in this regime"; (b) drop the rows. Recommend (a): no scoring effect, keeps rows, stops them reading as evidence. With DL retired it is a small edit plus a test.

#### AF-20260927-11 (L1532) — CLOSE
Evidence: git ls-files src/tala = 24 files; zero UTF-8 BOMs (head -c3 loop) and git grep for the mojibake sequence in src/tala returns nothing. Artifact: src/tala/TalaApp.test.tsx (9/9) plus the re-sweep.

#### AF-20260927-12 (L1533) — FIXABLE-NOW (immunization only)
Evidence: fix on main and live: queues.ts:1211-1212, 1612-1614, 1703-1706 pass 15*60_000; ml-weekly-retrain success 10-11..11-08 (one unrelated ml-ensemble-train failure 11-06). No test pins it; a scan of 230 runPython( calls shows 8 still rely on the 5-min default (dataQualityChecks.ts:206,773; jobSteps.ts:114; mcpServer.ts:535; pythonRunner.ts:328,373,399; queues.ts:1334).
Fix: add src/server/__tests__/runPythonExplicitTimeout.test.ts scanning src/server/**/*.ts non-test for runPython( calls with fewer than 3 top-level args, with an allowlist of those 8 (each justified or given an explicit timeout; queues.ts:1334 first). Negative control: remove the timeout from queues.ts:1212 and see it fail. Then close.

#### AF-20260927-20 (L1534) — CLOSE-NO-DEFECT
Evidence: dl-retrain-weekly retired 2026-11-11 (AF-20261111-01, cf0d6051; dlRetired.test.ts passes); chunk guard tests src/server/tests/test_dl_chunk_oom_guard.py still pass (3). Moot.

#### AF-20260927-18 (L1540) — STILL-BLOCKED
Evidence: needs a horizon-specific label/calibration contract, which freezes the promotion gate and needs a retrain. Depends on AF-20261008-17 (calibration_shadow has 9 dates, 19,423 rows per horizon, 2026-10-29..11-11; grading needs ~20 sessions, about 2026-11-26) and AF-20260913-02. Full-panel win_probability re-read today (factor_edge, open entry): 1d IC +0.011 (108 dates, no edge), 5d +0.049 (20.8 eff dates, no edge), 15d +0.054 LOW-DATA.

#### AF-20260927-19 (L1541) — STILL-BLOCKED
Evidence: calendar-blocked by the row's own rule (15d SIDEWAYS panel ~20 effective dates, not before ~2027). Nothing changed.

#### AF-20260928-03 (L1544) — CLOSE-NO-DEFECT
Evidence: (1) dl-trainer retired; (2) pm2 jlist: chatbot online (started 2026-11-12 14:21, 0 restarts); (3) ~/.wslconfig now memory=12GB, swap=4GB, autoMemoryReclaim=gradual; vmmemWSL 5.7 GB. Moving Postgres/Redis out of WSL stays an optional architecture choice, not a defect. Free RAM 1.8 of 23 GB is tight but no service is stopped.

#### AF-20260929-04 (L1553) — CLOSE
Evidence: 14-day job_run_history: unified-ranker 0/10 failed, quant-eod-sync 0/9 failed, ml-daily-ops last two runs success (11-09, 11-11; earlier failures were step-level and unrelated). Budget chain 75/85/95 on main (da033faa, src/server/jobBudgets.ts:2). Artifact: src/server/__tests__/jobRegistryGraceMinutesConsistency.test.ts (passes).

#### AF-20260929-05 (L1554) — CLOSE-NO-DEFECT
Evidence: WATCH lane, recurrence check: no whole-fleet stop since; gap analysis since 10-14 shows only host-standby gaps (11-09, 11-11), and pm2 apps are online (pm2 jlist: bharat-server, ml-api, engine-worker, chatbot, alphaquant-api online). Not immunizable in-repo; stable 6 weeks.

#### AF-20260929-08 (L1575) — USER-DECISION
Evidence: unchanged; nse_results_rss and nse_insider_pit still defined in bharat_alpha/config/source_catalog.yaml and ingest/sources/nse_corporate.py, no alternate onboarded.
Decision: onboard MoneyControl/Trendlyne insider alternate (full onboard-data-source pass) vs mark both connectors retired. Recommend retire both (set verdict retired in source_catalog.yaml, drop from live tests): they are corporate-filings extras with no measured use, and the core price/derivatives path is green.

#### AF-20260929-10 (L1577) — STILL-BLOCKED
Evidence: data import done (coverage 54.1%); the remaining cap-semantics question for the `__unknown__` bucket is EVIDENCE (needs a measured before/after of exempting/scaling it), not producible today. Cheap addition meanwhile: a test pinning the intended low-sector-coverage behaviour (row's own Immunized gap). Could not re-read alpha.instrument coverage (scripts/sql.py is bound to bharat_intel).

#### AF-20260930-03 (L1585) — CLOSE
Evidence: `npm run findings:check` prints "audit-findings.md: OK" and backlog:check OK (only duplicate-ID warnings on old rows). scripts/checkFindingsLedger.mjs reports "row is outside any table" and checks widths; test scripts/__tests__/checkFindingsLedger.test.ts exists. That is the parse check the row said was missing.

#### AF-20260930-14 (L1628) — STILL-BLOCKED
Evidence: trendlyne_technical_snapshots: 110 names refreshed per trading day (11-12: 110, 11-11: 110, 11-09: 110), quant-eod-sync success every run. Not yet converged: 1,537 of 2,002 rows updated within 20 days, 877 within 10; 320 rows from October and 118 from July (likely out of the rotation universe, check). At 110/day the rotation completes about 2026-11-20. Re-check then: max age of in-universe rows <= 18 days. Test: src/server/__tests__/technicalIntelligenceService.test.ts.

#### AF-20260930-26 (L1594) — CLOSE-NO-DEFECT
Evidence: host now commit 47.3 of 60.9 GB (78%, was 91%), vmmemWSL 5.7 GB capped by .wslconfig 12GB, DL retired (13.8 GB retrain gone), AF-20260930-10 and -13 closed. Free RAM 1.8 GB. Remaining reducible items are the user's own idle terminals/Claude sessions, not a code defect.

#### AF-20261001-01 (L1648) — CLOSE
Evidence: stale_pending_horizons/expire_stale_pending_all in src/server/outcome_resolver.py:1445-1475 cover every horizon; test_expire_all_horizons_covers_horizons_no_caller_passes and test_stale_pending_horizons_includes_unified_and_coalesces_rec_log_null exist and src/server/tests/test_outcome_resolver.py passes (53 passed with the marketsmojo files). Note: AF-20260930-16 later made the sweep count-only (no synthetic NEUTRAL), so 269 stray h7 confluence rows dated 2026-05-16 (pre-06-30 remnant; h7 resolves normally since 06-30) stay PENDING by design.

#### AF-20261001-50 (L1656) — USER-DECISION
Decision: build retail SHORT trade geometry or not. Options: build for F&O/intraday only (needs instrument column, short-aware sizing) vs won't-build. Recommend won't-build and close as ACCEPT: no instrument on unified_recommendations, short side measured negative expectancy, long-book sizing assumptions.

#### AF-20261001-48 (L1697) — STILL-BLOCKED
Evidence: depends on AF-20261008-17 (calibration_shadow: 9 signal dates 2026-10-29..11-11, grading after ~20 sessions about 2026-11-26) and the coordinated retrain window (AF-20260913-02). Reward/online-learner pooling half unchanged.

#### AF-20261001-49 (L1698) — CALENDAR-PASSED
Evidence: ran factor_edge.py (technical_signals, win_probability, open entry, no persist): 1d IC +0.011 (108 dates, no edge), 5d +0.049 (20.8 eff dates, t_eff 2.28, no edge), 15d +0.054 LOW-DATA. My SQL IC since 2026-08-10 (59 dates): 1d +0.0065, 5d +0.033. No improvement trend vs +0.003 in the triple-barrier era; "loop improves picks" not supported. Result answers the row: record in measurement.md and close as observation.

#### AF-20261003-08 (L1711) — STILL-BLOCKED
Evidence: exp 6 (index PCR conditioning) needs ~20 five-session periods, history from 2026-06-30, so about 2026-11-20 or later; exps 3 and 8 not built (sector series now exists: nse_stocks.sector 100% populated, which unblocks exp 8 build). Test: src/server/tests/test_factor_backtest_regime_split.py passes.

#### AF-20261003-09 (L1712) — USER-DECISION
Decision: (a) end-to-end docker compose run, (b) knowable_at schema invariant, (c) fetcher framework. Recommend per the row: do (b) only for the three burned tables, treat (c) as unjustified, and run (a) in a planned stop window or drop it since pm2 is the deployment.

#### AF-20261002-03 (L1777) — CLOSE-NO-DEFECT
Evidence: its dependency AF-20260930-26 is closed above (commit 78%, DL retired); the failures were a one-off manual holiday-pipeline run over four restarts, and later holiday runs (11-10 skipped cleanly, ranker/ml-daily-ops success 11-11) show no recurrence.

#### AF-20261013-07 (L1848) — STILL-BLOCKED
Evidence: depends on AF-20261008-16 (calendar-blocked to 2027-02-26) and AF-20261008-17 shadow (9 dates so far). No threshold/weight change is authorised before that.

