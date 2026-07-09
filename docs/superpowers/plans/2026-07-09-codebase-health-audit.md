# Codebase Health Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactive backend-only error sweep (TS server layer + Python engines) — find and fix crashes, silent failures, and obvious logic bugs before building the quant-verification work (sub-project 2) on top of it.

**Architecture:** Five parallel research agents each own a disjoint file set (discovered below), run real tooling (`tsc --noEmit`, Python smoke-imports, targeted greps) plus manual review, and return structured findings. One synthesis pass merges the five reports, applies straightforward fixes inline, and produces a flagged list for user review on anything touching scoring math, trading thresholds, or DB writes/schema.

**Tech Stack:** TypeScript (tsc, Node/Express/tRPC), Python 3.11+ (db_compat, pandas/sklearn/lightgbm engines)

## Global Constraints

- Scope is backend only: `src/server/**/*.ts` and `src/server/*.py`. Frontend (`src/App.tsx`, `src/components/`, `src/v2/`, `src/v3/`) is explicitly out of scope.
- Auto-fix inline: compile/type errors, unhandled exceptions, swallowed-error anti-patterns, obvious logic bugs (wrong variable reference, off-by-one, null-deref, dead/broken imports).
- Flag for user review, do not touch: anything that changes scoring math, trading thresholds, DB writes/schema, or requires a behavioral judgment call.
- All Python DB access must go through `db_compat` (`connect`, `read_df`, `query_one`, `query_all`, `execute`) — never raw `sqlite3`/`psycopg2`. This is a known anti-pattern to grep for (see `alphaquant_split_brain` project memory: a Python engine silently writing SQLite while the app reads Postgres because it didn't load `.env`/`USE_POSTGRES=true`).
- No commit happens until verification (Task 7) passes clean.

## File Inventory (discovered, for agent scoping)

**TS — `src/server/`:** 83 top-level `.ts` files + 24 files under `routers/`. `router.ts` is now a thin 56-line merge point (already split from a former 2770-line monolith per CLAUDE.md — that doc is stale on this point).

**Python — `src/server/`:** 118 `.py` files (also more than the CLAUDE.md "~30 engines" listing — that doc only names the flagship ones; the actual count includes many fetcher/sync scripts).

---

### Task 1: Dispatch Agent A — TS API/router layer audit

**Files owned by this agent:** `src/server/router.ts`, `src/server/trpc.ts`, `src/server/context.ts`, and all 24 files under `src/server/routers/`.

**Interfaces:**
- Produces: a findings list (see format below) that Task 6 consumes.

- [ ] **Step 1: Dispatch the agent**

Use the Agent tool (`subagent_type: general-purpose`, `run_in_background: false`) with this exact prompt:

```
You are auditing part of a tRPC backend (Express + tRPC) for a stock-trading intelligence
platform. Your slice: src/server/router.ts, src/server/trpc.ts, src/server/context.ts, and
every file under src/server/routers/ (24 files — the tRPC procedure definitions, ~130+
endpoints total across the app).

Working directory: D:/Github/bharat-stock-intelligence

Do this:
1. Run `npx tsc --noEmit` from the repo root and capture all compiler errors that originate
   in router.ts, trpc.ts, context.ts, or anything under routers/. Ignore errors in files
   outside your slice (other agents own those).
2. Read through each file in routers/ and grep for these anti-patterns across your slice:
   - `catch {}`, `catch (e) {}`, `.catch(() => {})` — swallowed errors with no log/rethrow
   - `catch` blocks that return a success-shaped value instead of throwing/logging on failure
     (this exact bug caused weeks of stale data in this codebase before: a BullMQ job handler
     returned {success:false} instead of throwing, and BullMQ silently marked the job
     "completed" — grep for any handler doing something similar)
   - unhandled promise rejections: async functions called without await/catch in a fire-and-forget way
   - `any` types masking a real type error, especially on tRPC input/output schemas
3. For each issue found, classify severity: CRASH (throws/500s users), SILENT (wrong data,
   no error surfaced), or MINOR (type/lint only).
4. Report findings as a markdown list, one item per finding, in this exact format:
   - `file:line | SEVERITY | one-sentence description | proposed fix (1-2 sentences)`
   Group CRASH findings first, then SILENT, then MINOR.
5. Do NOT edit any files. Read-only investigation only. Report back under 800 words.
```

- [ ] **Step 2: Save the returned findings**

Write the agent's full findings list to `docs/superpowers/plans/audit-findings/agent-a-ts-api.md` (create the `audit-findings/` directory if it doesn't exist).

---

### Task 2: Dispatch Agent B — TS infra/plumbing audit

**Files owned by this agent:** `queues.ts`, `jobRegistry.ts`, `jobHeartbeat.ts`, `jobWatchdog.ts`, `cacheService.ts`, `db.ts`, `dbAsync.ts`, `dbBulk.ts`, `pgClient.ts`, `pgConfig.ts`, `redisConfig.ts`, `redisManager.ts`, `semaphore.ts`, `monitoringService.ts`, `monitorScripts.ts`, `logger.ts`, `envConfig.ts`, `sse.ts`, `websocketService.ts`, `mcpServer.ts`, `telegramService.ts`, `sqlTranslate.ts`, `stdioSafeConsole.ts` — all in `src/server/`.

**Interfaces:**
- Produces: a findings list that Task 6 consumes.

- [ ] **Step 1: Dispatch the agent**

Use the Agent tool (`subagent_type: general-purpose`, `run_in_background: false`) with this exact prompt:

```
You are auditing the infrastructure/plumbing layer of a Node/Express/tRPC backend for a
stock-trading intelligence platform (BullMQ job queues, Postgres/Redis clients, monitoring,
job heartbeats). Your slice, all in src/server/:
queues.ts, jobRegistry.ts, jobHeartbeat.ts, jobWatchdog.ts, cacheService.ts, db.ts, dbAsync.ts,
dbBulk.ts, pgClient.ts, pgConfig.ts, redisConfig.ts, redisManager.ts, semaphore.ts,
monitoringService.ts, monitorScripts.ts, logger.ts, envConfig.ts, sse.ts, websocketService.ts,
mcpServer.ts, telegramService.ts, sqlTranslate.ts, stdioSafeConsole.ts

Working directory: D:/Github/bharat-stock-intelligence

Known incident history to specifically re-check for recurrence (from project memory):
- A BullMQ job handler once returned {success:false} instead of throwing on failure, so
  BullMQ silently marked the job "completed" — stock_scores went stale for weeks undetected.
  Check every job handler in queues.ts and jobRegistry.ts for this exact shape: does a
  catch block or an error path return/resolve normally instead of throwing?
- A ~49-hour server crash-loop happened because of unhandled errors in job heartbeat logic
  and timezone misalignment (see jobHeartbeat.ts, jobWatchdog.ts) — check these are robust.
- Postgres connections have previously broken silently when localhost resolved to ::1 on
  Windows (IPv6) instead of 127.0.0.1 — check pgConfig.ts / pgClient.ts connection string
  construction for this class of bug.

Do this:
1. Read each file in your slice.
2. Grep for: `catch {}`, `catch (e) {}`, `.catch(() => {})`, catch blocks that swallow and
   return success, retry loops with no max-attempts/backoff cap, `setInterval`/`setTimeout`
   callbacks with no internal try/catch (an uncaught throw inside one of these can crash the
   whole Node process).
3. For db.ts specifically: this file is documented as "the SQLite-flavored schema-of-record",
   while the live DB is Postgres via pgClient.ts/dbAsync.ts. Check whether any code path in
   your slice writes through db.ts's SQLite-specific path when USE_POSTGRES=true is set,
   which would silently write to the wrong database (the "split-brain" pattern that has
   bitten this codebase before with a Python engine).
4. Classify each finding: CRASH, SILENT, or MINOR.
5. Report findings as a markdown list, one item per finding:
   - `file:line | SEVERITY | one-sentence description | proposed fix (1-2 sentences)`
   Group CRASH first, then SILENT, then MINOR.
6. Do NOT edit any files. Read-only investigation only. Report back under 800 words.
```

- [ ] **Step 2: Save the returned findings**

Write to `docs/superpowers/plans/audit-findings/agent-b-ts-infra.md`.

---

### Task 3: Dispatch Agent C — TS business/data-service layer audit

**Files owned by this agent:** the remaining `src/server/*.ts` files not covered by Agents A or B — `alphaQuantClient.ts`, `backtestRunner.ts`, `companyProfileSyncService.ts`, `confluenceEngine.ts`, `correlationService.ts`, `deliveryFetcher.ts`, `etnow.ts`, `etnowScreenerSync.ts`, `fnoService.ts`, `fundamentalsSyncService.ts`, `gdeltService.ts`, `globalMarketService.ts`, `import_et_screeners.ts`, `indexApiService.ts`, `indexMapping.ts`, `insightService.ts`, `liveScreenerCollector.ts`, `liveStockData.ts`, `marketData.ts`, `marketIntelService.ts`, `marketStatusService.ts`, `mcApiService.ts`, `moneycontrol.ts`, `moneycontrolScreener.ts`, `moneycontrolService.ts`, `newsEntityTagger.ts`, `newsSentimentService.ts`, `niftytraderService.ts`, `nseService.ts`, `ollamaManager.ts`, `optionChainService.ts`, `portfolio.ts`, `pythonApi.ts`, `pythonRunner.ts`, `quantScoringService.ts`, `quantScoringWorker.ts`, `researchEngine.ts`, `scoringService.ts`, `screenerClassifier.ts`, `sectorApiService.ts`, `signalOutcomesService.ts`, `signals.ts`, `stockMapping.ts`, `strategySignalsService.ts`, `symbolResolver.ts`, `syncProprietaryScores.ts`, `technicalIntelligenceService.ts`, `technicalScanner.ts`, `technicalSignalsService.ts`, `topMoversService.ts`, `tradebrainsService.ts`, `trendlyneAuthService.ts`, `trendlyneChecklistCycle.ts`, `trendlyneChecklistParser.ts`, `trendlyneDailyFetchService.ts`, `trendlyneScreener.ts`, `trendlyneService.ts`.

**Interfaces:**
- Produces: a findings list that Task 6 consumes.

- [ ] **Step 1: Dispatch the agent**

Use the Agent tool (`subagent_type: general-purpose`, `run_in_background: false`) with this exact prompt:

```
You are auditing the business/data-service layer of a Node/Express/tRPC backend for a stock-
trading intelligence platform (external API clients: MoneyControl, Trendlyne, NSE, ETnow,
NiftyTrader, options chains, scoring orchestration, sync jobs). Your slice, all in
src/server/: alphaQuantClient.ts, backtestRunner.ts, companyProfileSyncService.ts,
confluenceEngine.ts, correlationService.ts, deliveryFetcher.ts, etnow.ts,
etnowScreenerSync.ts, fnoService.ts, fundamentalsSyncService.ts, gdeltService.ts,
globalMarketService.ts, import_et_screeners.ts, indexApiService.ts, indexMapping.ts,
insightService.ts, liveScreenerCollector.ts, liveStockData.ts, marketData.ts,
marketIntelService.ts, marketStatusService.ts, mcApiService.ts, moneycontrol.ts,
moneycontrolScreener.ts, moneycontrolService.ts, newsEntityTagger.ts,
newsSentimentService.ts, niftytraderService.ts, nseService.ts, ollamaManager.ts,
optionChainService.ts, portfolio.ts, pythonApi.ts, pythonRunner.ts, quantScoringService.ts,
quantScoringWorker.ts, researchEngine.ts, scoringService.ts, screenerClassifier.ts,
sectorApiService.ts, signalOutcomesService.ts, signals.ts, stockMapping.ts,
strategySignalsService.ts, symbolResolver.ts, syncProprietaryScores.ts,
technicalIntelligenceService.ts, technicalScanner.ts, technicalSignalsService.ts,
topMoversService.ts, tradebrainsService.ts, trendlyneAuthService.ts,
trendlyneChecklistCycle.ts, trendlyneChecklistParser.ts, trendlyneDailyFetchService.ts,
trendlyneScreener.ts, trendlyneService.ts

Working directory: D:/Github/bharat-stock-intelligence

Do this:
1. Read each file (this is a lot of files — prioritize scoringService.ts, signals.ts,
   signalOutcomesService.ts, technicalScanner.ts, quantScoringService.ts,
   quantScoringWorker.ts, backtestRunner.ts first since they're on the trading-signal
   critical path; spend proportionally less time on single-purpose fetcher/sync files).
2. Grep across your slice for: `catch {}`, `catch (e) {}`, `.catch(() => {})`, external API
   calls with no timeout (this codebase's convention is `AbortSignal.timeout(10000)` — flag
   any fetch() missing it), retry loops with no cap, and any place a numeric parse
   (parseFloat/parseInt/Number()) isn't guarded against NaN before being used in a calculation
   or DB write.
3. Check ticker/symbol resolution: per this codebase's convention, provider IDs should always
   be resolved via src/server/stockMapping.ts's getStockMapping()/resolver functions, never
   constructed by string convention. Flag any place in your slice that builds a provider ID
   (MoneyControl mcsymbol, Trendlyne tlid, ET companyid) by string concatenation instead of
   going through stockMapping.ts.
4. Classify each finding: CRASH, SILENT, or MINOR.
5. Report findings as a markdown list, one item per finding:
   - `file:line | SEVERITY | one-sentence description | proposed fix (1-2 sentences)`
   Group CRASH first, then SILENT, then MINOR.
6. Do NOT edit any files. Read-only investigation only. Report back under 1000 words (this
   slice is larger — prioritize the highest-severity, highest-confidence findings if you have
   to cut for length).
```

- [ ] **Step 2: Save the returned findings**

Write to `docs/superpowers/plans/audit-findings/agent-c-ts-services.md`.

---

### Task 4: Dispatch Agent D — Python data-fetcher/sync layer audit

**Files owned by this agent:** all `src/server/*.py` files whose name matches `*_fetcher.py`, `sync_*.py`, `backfill_*.py`, `*_client.py`, plus `explore_mc_tl.py`, `python_api.py`, `test.py`. (Run `ls src/server/*_fetcher.py src/server/sync_*.py src/server/backfill_*.py src/server/*_client.py` to get the exact current list — approximately 65 files as of this plan's writing.)

**Interfaces:**
- Produces: a findings list that Task 6 consumes.

- [ ] **Step 1: Dispatch the agent**

Use the Agent tool (`subagent_type: general-purpose`, `run_in_background: false`) with this exact prompt:

```
You are auditing the data-ingestion layer of a Python backend for a stock-trading
intelligence platform. Your slice: every file in src/server/ matching *_fetcher.py,
sync_*.py, backfill_*.py, *_client.py, plus explore_mc_tl.py, python_api.py, test.py.
Get the exact current list by running, from the repo root:
  ls src/server/*_fetcher.py src/server/sync_*.py src/server/backfill_*.py src/server/*_client.py
(approximately 65 files).

Working directory for all Python: D:/Github/bharat-stock-intelligence/src/server/

Critical project rule to check for violations: ALL DB access in these files must go through
db_compat.py's connect()/read_df()/query_one()/query_all()/execute() — never raw sqlite3 or
psycopg2 calls. A prior incident ("AlphaQuant split-brain") happened because a Python engine
didn't load .env / USE_POSTGRES=true and silently wrote to SQLite while the live app read
from Postgres, causing stale data that went unnoticed for a long time. This is the single
highest-value thing to check across all 65 files.

Do this:
1. For each file, grep for `import sqlite3` or `import psycopg2` (excluding db_compat.py
   itself and sql_translate.py, which are allowed to touch drivers directly). Any fetcher/sync
   script importing these directly instead of using db_compat is a HIGH severity finding.
2. Grep for bare `except:` or `except Exception: pass` — these silently swallow fetch
   failures, which means a data source can go stale for weeks with the process reporting
   success. Flag every instance.
3. Smoke-import a representative sample: for at least 20 of the files (prioritize the ones
   referenced in CLAUDE.md's "Daily ops" and "Weekly/Monthly" sections: fii_dii_fetcher.py,
   pcr_fetcher.py, credit_rating_fetcher.py, insider_transactions_fetcher.py,
   mc_broker_reco_fetcher.py, delivery_volume_fetcher.py, analyst_estimates_snapshot.py, plus
   13 more of your choosing), run `python -c "import <module_name_without_.py>"` from
   src/server/ and record any ImportError/SyntaxError/other crash on import.
4. Check date-handling: this codebase's convention (per rl_agent.py rule #6, referenced in
   project docs) is that DATE columns on Postgres need datetime.date objects as bind params,
   not strings. Spot-check a handful of files for string dates being passed directly into
   date-column comparisons/inserts.
5. Classify each finding: CRASH (import/runtime error), SILENT (swallowed exception or
   split-brain DB write), or MINOR.
6. Report findings as a markdown list, one item per finding:
   - `file:line | SEVERITY | one-sentence description | proposed fix (1-2 sentences)`
   Group CRASH first, then SILENT, then MINOR. Also report the full list of files you
   smoke-imported and their pass/fail status as a separate section.
7. Do NOT edit any files. Read-only investigation only. Report back under 1000 words for the
   findings list; the smoke-import pass/fail table can be terse (filename: OK/FAIL).
```

- [ ] **Step 2: Save the returned findings**

Write to `docs/superpowers/plans/audit-findings/agent-d-py-fetchers.md`.

---

### Task 5: Dispatch Agent E — Python scoring/ML/backtesting/RL core audit

**Files owned by this agent:** every `src/server/*.py` file NOT covered by Agent D — the scoring, ML, backtesting, RL, and feature-engineering core. Exact list (run `ls src/server/*.py` and subtract Agent D's list to confirm, but as of this plan's writing this includes): `analyst_revision.py`, `avwap_features.py`, `backtest_live_screener.py`, `backtest_optimizer.py`, `backtester.py`, `bse_event_classifier.py`, `commodity_sensitivity.py`, `confluence_ml_engine.py`, `confluence_outcome_tracker.py`, `cs_ranker.py`, `daily_ml_update.py`, `db_compat.py`, `dl_engine.py`, `dl_trainer.py`, `drift_detector.py`, `early_hours_predictor.py`, `earnings_beat_features.py`, `exit_labeler.py`, `exit_policy.py`, `feature_engineering.py`, `finbert_scorer.py`, `hv_features.py`, `insider_features.py`, `institutional_quant_engine.py`, `intraday_features.py`, `iv_features.py`, `live_screener_optimizer.py`, `live_screener_resolver.py`, `market_breadth.py`, `ml_calibration.py`, `ml_ensemble.py`, `ml_signal_scorer.py`, `multi_factor_scorer.py`, `nlp_engine.py`, `ohlcv_quality.py`, `oi_delta_features.py`, `online_learner.py`, `outcome_resolver.py`, `pead_model.py`, `performance_tracker.py`, `regime_detector.py`, `relative_strength.py`, `reward_engine.py`, `risk_metrics_engine.py`, `rl_agent.py`, `scoring_engine.py`, `screener_features_fetcher.py`, `screener_ohlcv_backfill.py`, `screener_performance.py`, `screener_sector_rotation.py`, `screener_signal_generator.py`, `screener_catalog_enricher.py`, `sector_fo_proxy.py`, `sector_global_corr.py`, `signal_type_priors.py`, `sql_translate.py`, `strategy_optimizer.py`, `technical_analysis_engine.py`, `unified_ranker.py`.

**Interfaces:**
- Produces: a findings list that Task 6 consumes.

- [ ] **Step 1: Dispatch the agent**

Use the Agent tool (`subagent_type: general-purpose`, `run_in_background: false`) with this exact prompt:

```
You are auditing the scoring/ML/backtesting/RL core of a Python quant-trading backend. This
is the highest-stakes slice — it computes the win_probability and signal scores the whole
platform trades on. Your slice, all in src/server/: analyst_revision.py, avwap_features.py,
backtest_live_screener.py, backtest_optimizer.py, backtester.py, bse_event_classifier.py,
commodity_sensitivity.py, confluence_ml_engine.py, confluence_outcome_tracker.py,
cs_ranker.py, daily_ml_update.py, db_compat.py, dl_engine.py, dl_trainer.py,
drift_detector.py, early_hours_predictor.py, earnings_beat_features.py, exit_labeler.py,
exit_policy.py, feature_engineering.py, finbert_scorer.py, hv_features.py,
insider_features.py, institutional_quant_engine.py, intraday_features.py, iv_features.py,
live_screener_optimizer.py, live_screener_resolver.py, market_breadth.py, ml_calibration.py,
ml_ensemble.py, ml_signal_scorer.py, multi_factor_scorer.py, nlp_engine.py, ohlcv_quality.py,
oi_delta_features.py, online_learner.py, outcome_resolver.py, pead_model.py,
performance_tracker.py, regime_detector.py, relative_strength.py, reward_engine.py,
risk_metrics_engine.py, rl_agent.py, scoring_engine.py, screener_features_fetcher.py,
screener_ohlcv_backfill.py, screener_performance.py, screener_sector_rotation.py,
screener_signal_generator.py, screener_catalog_enricher.py, sector_fo_proxy.py,
sector_global_corr.py, signal_type_priors.py, sql_translate.py, strategy_optimizer.py,
technical_analysis_engine.py, unified_ranker.py.

Working directory for all Python: D:/Github/bharat-stock-intelligence/src/server/

Do NOT re-litigate the design of these engines (that's a separate, already-scoped review).
You are hunting for correctness bugs only: things that produce a wrong number, crash, or
silently no-op.

Do this:
1. Grep your whole slice for bare `except:` / `except Exception: pass` — in a scoring engine,
   a swallowed exception can mean a feature silently defaults to 0/NULL and skews every score
   downstream without anyone noticing. Flag every instance with enough context to tell if the
   default fallback value is dangerous (e.g. defaulting a probability to 0.5 vs to 0).
2. Grep for `import sqlite3` or `import psycopg2` outside of db_compat.py/sql_translate.py —
   same split-brain risk as elsewhere in this codebase, but higher stakes here since these
   engines write win_probability/scores that gate real trading signals.
3. Check for division-by-zero risk: grep for `/` divisions involving variables that could
   plausibly be 0 (counts, totals, ATR, volume) without a guard (`max(x, 1)`, `if x > 0`,
   `.clip(lower=...)`, etc.) immediately before them.
4. Smoke-import every file in your slice: `python -c "import <module_name_without_.py>"` from
   src/server/. Record pass/fail for all ~58 files.
5. For files with a `--dry-run` or `--dry_run` CLI flag (grep argparse blocks to find them),
   run them with that flag and record whether they crash.
6. Classify each finding: CRASH (import/runtime error), SILENT (swallowed exception, wrong
   default, or split-brain DB write), MATH (division-by-zero or similar numeric bug), or
   MINOR.
7. Report findings as a markdown list, one item per finding:
   - `file:line | SEVERITY | one-sentence description | proposed fix (1-2 sentences)`
   Group CRASH first, then MATH, then SILENT, then MINOR. Also report the full smoke-import
   pass/fail table and the dry-run results as separate sections.
8. Do NOT edit any files. Read-only investigation only. Report back under 1200 words for the
   findings list (this is the highest-priority slice — be thorough, but the pass/fail tables
   can be terse).
```

- [ ] **Step 2: Save the returned findings**

Write to `docs/superpowers/plans/audit-findings/agent-e-py-core.md`.

---

### Task 6: Synthesize findings and classify fix vs. flag

**Files:**
- Read: all 5 files under `docs/superpowers/plans/audit-findings/`
- Create: `docs/superpowers/plans/audit-findings/synthesis.md`

**Interfaces:**
- Consumes: the 5 findings files from Tasks 1–5 (format: `file:line | SEVERITY | description | proposed fix`)
- Produces: `synthesis.md` with two sections — "Auto-fix" and "Flagged for review" — each finding assigned per the Global Constraints fix policy.

- [ ] **Step 1: Read all 5 findings files**

Read each of `agent-a-ts-api.md` through `agent-e-py-core.md`.

- [ ] **Step 2: Deduplicate and classify**

Merge into one list. Drop exact duplicates (same file:line reported by two agents — this can happen at slice boundaries). For each remaining finding, apply the Global Constraints fix policy:
- **Auto-fix** if it's a compile/type error, unhandled exception, swallowed-error anti-pattern, or an obviously-wrong-not-ambiguous logic bug (off-by-one, null-deref, wrong variable, broken import).
- **Flag for review** if it touches scoring math, trading thresholds, DB writes/schema, or requires a judgment call about intended behavior.

- [ ] **Step 3: Write `synthesis.md`**

Two sections, each finding as `file:line | description | proposed fix`. Include a total count per section.

- [ ] **Step 4: Report a short summary to the user in chat**

State: total findings found, count auto-fixed vs flagged, and the flagged list in full (since that's what needs the user's judgment) — before proceeding to Task 7.

---

### Task 7: Apply auto-fixes

**Files:**
- Modify: whichever files `synthesis.md`'s "Auto-fix" section names (exact set unknown until Task 6 completes — this is inherent to audit work, not a planning gap).

**Interfaces:**
- Consumes: `docs/superpowers/plans/audit-findings/synthesis.md`
- Produces: modified source files, ready for verification in Task 8.

- [ ] **Step 1: Fix each TS finding**

For each auto-fix item in a `.ts` file, apply the proposed fix using the Edit tool. Preserve existing code style (this codebase writes no comments unless the WHY is non-obvious, per CLAUDE.md).

- [ ] **Step 2: Fix each Python finding**

For each auto-fix item in a `.py` file, apply the proposed fix using the Edit tool. Follow the Global Constraints rule: any DB access fix must go through `db_compat`, never raw `sqlite3`/`psycopg2`.

- [ ] **Step 3: Re-read synthesis.md and confirm every Auto-fix item has a corresponding diff**

Cross-check: every `file:line` in the Auto-fix section should map to an edit made in Step 1 or 2. If any were skipped (e.g. the file no longer matches the described context because another fix already changed nearby lines), note why and either resolve or move it to the flagged list.

---

### Task 8: Verify

**Files:** none created — this task runs checks only.

- [ ] **Step 1: TypeScript compile check**

Run: `npx tsc --noEmit` from the repo root.
Expected: no errors originating from files touched in Task 7. (Pre-existing unrelated errors outside this audit's scope, if any, should be noted but are not a blocker for this task.)

- [ ] **Step 2: Python smoke-import all touched files**

For every `.py` file touched in Task 7, run from `src/server/`:
```bash
python -c "import <module_name_without_.py>"
```
Expected: no `ImportError`/`SyntaxError` for any touched file.

- [ ] **Step 3: Re-run `--dry-run` for any touched engine that supports it**

For each touched Python file with a `--dry-run` flag (per Agent E's dry-run inventory from Task 5), run it and confirm no crash.

- [ ] **Step 4: If any verification step fails, fix and re-verify**

Do not proceed to Task 9 until Steps 1–3 all pass clean.

---

### Task 9: Commit and report

**Files:**
- Stage: only the files touched in Task 7 (do not run a blanket `git add -A`/`git add .` — this repo has substantial unrelated in-progress staged work from the user that must not be swept into this commit).

- [ ] **Step 1: Review the diff**

Run `git diff` (unstaged) scoped to the exact list of files touched in Task 7, e.g.:
```bash
git diff -- <file1> <file2> ...
```
Confirm every change matches an item in `synthesis.md`'s Auto-fix section.

- [ ] **Step 2: Stage and commit only those files**

```bash
git add <file1> <file2> ...
git commit -m "$(cat <<'EOF'
fix: codebase health audit — crashes, swallowed errors, split-brain DB writes

Auto-fixed straightforward bugs found by a 5-agent parallel audit of the TS
server layer and Python engines (routers, infra, services, fetchers, ML/scoring
core). See docs/superpowers/plans/audit-findings/synthesis.md for full findings.
EOF
)"
```

- [ ] **Step 3: Report to the user**

Summarize in chat: what was fixed (count + one-line highlights of the most significant), and restate the flagged-for-review list from Task 6 Step 4 so the user can decide on those separately. Point to `docs/superpowers/plans/audit-findings/synthesis.md` for the full detail.

---

## Self-Review

**Spec coverage check:**
- ✅ Three audit angles from the spec (TS server layer, Python engines, DB/schema consistency) → expanded to 5 agents (A/B/C for TS given 107 TS files vs the spec's rough estimate; D/E for Python given 118 files vs the spec's "~30" estimate) — DB/schema consistency folded into Agent B (db.ts split-brain check) and Agent D/E (db_compat split-brain check) rather than a standalone 6th agent, since it's the same anti-pattern checked in-place across both languages.
- ✅ Fix policy (auto-fix vs flag) → Task 6
- ✅ Verification before commit → Task 8
- ✅ Frontend explicitly out of scope → stated in Global Constraints, no task touches `src/App.tsx`/`src/components/`/`src/v2/`/`src/v3/`
- ✅ Deliverable = findings summary + fixes, not a big doc → Task 9 Step 3 reports in chat; `synthesis.md` is a working artifact, not a polished doc

**Note on scale discovery:** the spec estimated "~30 Python engines"; the actual count is 118. The spec estimated router.ts as the main TS surface; it's actually already split into 24 `routers/*.ts` files plus 83 other service/infra `.ts` files. The task breakdown above reflects the real numbers, not the spec's estimate — this doesn't change the spec's intent (backend-only, proactive general audit, fix-straightforward/flag-risky), just the agent count needed to cover it.
