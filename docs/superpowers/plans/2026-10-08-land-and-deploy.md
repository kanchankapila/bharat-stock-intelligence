# Land and Deploy (sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit the 2026-10-08 fixes by explicit path, build the frontend, restart `bharat-server`, and prove each change live.

**Architecture:** Three logical commits (Python data/writers, server TypeScript + checks, frontend + docs/rules), then a build and one pm2 restart outside market hours, then read-only live verification. No migrations, no data writes, no deletions.

**Tech Stack:** git, npm/vite, pm2, vitest, pytest (backend-python venv), `scripts/sql.py` (read-only).

**Spec:** `docs/superpowers/specs/2026-10-08-accuracy-and-honesty-program-design.md` (section 2.A). Evidence: `docs/expert-review-2026-10-08.md`, ledger AF-20261008-11..28.

## Global Constraints

- Authority: code, commit by explicit path, frontend build, `pm2 restart bharat-server`, live verification only.
- Never `git add -A` or `git add .`; re-check `git status` right before each commit.
- No production data writes, deletions, migrations or DROPs. No score, weight, threshold or classification change.
- Restart only outside market hours (NSE cash market 09:15-15:30 IST, Mon-Fri).
- Python tests use `backend-python/venv/Scripts/python.exe`; do not use another interpreter.

## Review Focus

- A restart drops WebSocket clients and the API for a few seconds: restart outside market hours and confirm `/api/trpc` answers afterwards.
- `getBuyRecommendations` must not 500 when `technical_signals` has no rows in the last 14 days (the helper returns NULL; the join then matches nothing).
- Python writers must still write on a normal trading day (the new `is_trading_session` guard fails open if the holiday table cannot be read).
- The new DQ checks must not page on a weekend/holiday for a missing day.
- The built bundle must still load `/alpha` (chunk split in `vite.config.ts` dropped d3 and split lightweight-charts).

---

### Task 1: Pre-flight checks

**Files:** none modified.

- [ ] **Step 1: Confirm the tree holds only this session's work**

Run: `git status --short | cat` and `git log --oneline -3 | cat`
Expected: the modified/untracked list recorded in `docs/session-log.md` 2026-10-08 (evening); HEAD is the spec commit.

- [ ] **Step 2: Confirm the gates are green on this tree**

Run: `npx tsc --noEmit && npx vitest run` then `backend-python/venv/Scripts/python.exe -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/ -q -p no:cacheprovider`
Expected: tsc silent; vitest all passed; pytest 3437 passed (a rerun only if a file changed since).

- [ ] **Step 3: Confirm market hours are over**

Run: `date` (IST). Expected: before 09:00 or after 15:45 on a trading day, or a weekend.

### Task 2: Commit 1, Python data and writers

**Files:**
- `src/server/as_of.py`, `src/server/densify_feature_matrix.py`, `src/server/feature_engineering.py`, `src/server/mc_advance_decline_fetcher.py`, `src/server/mc_broker_reco_fetcher.py`, `src/server/mc_earnings_fetcher.py`, `src/server/mc_stock_futures_oi_fetcher.py`, `src/server/mc_symbol_map.py`, `src/server/ndtv_fno_basis_fetcher.py`, `src/server/nt_dashboard_fetcher.py`, `src/server/preopen_fetcher.py`, `src/server/so_option_chain_fetcher.py`
- Tests: `src/server/tests/test_densify_never_fills_event_clocks.py`, `test_fno_writers_skip_non_trading_day.py`, `test_mc_earnings_mapping_and_freshness.py`, `test_mc_earnings_fetcher.py`, `test_mc_symbol_map.py`, `test_live_datasource_preopen_nse.py`

- [ ] **Step 1: Run the targeted tests**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_densify_never_fills_event_clocks.py src/server/tests/test_fno_writers_skip_non_trading_day.py src/server/tests/test_mc_earnings_mapping_and_freshness.py src/server/tests/test_mc_earnings_fetcher.py src/server/tests/test_mc_symbol_map.py -q -p no:cacheprovider`
Expected: all pass.

- [ ] **Step 2: Commit by explicit path**

```bash
git add src/server/as_of.py src/server/densify_feature_matrix.py src/server/feature_engineering.py src/server/mc_advance_decline_fetcher.py src/server/mc_broker_reco_fetcher.py src/server/mc_earnings_fetcher.py src/server/mc_stock_futures_oi_fetcher.py src/server/mc_symbol_map.py src/server/ndtv_fno_basis_fetcher.py src/server/nt_dashboard_fetcher.py src/server/preopen_fetcher.py src/server/so_option_chain_fetcher.py src/server/tests/test_densify_never_fills_event_clocks.py src/server/tests/test_fno_writers_skip_non_trading_day.py src/server/tests/test_mc_earnings_mapping_and_freshness.py src/server/tests/test_mc_earnings_fetcher.py src/server/tests/test_mc_symbol_map.py src/server/tests/test_live_datasource_preopen_nse.py
git commit -m "fix(data): stop forward-filling event clocks, unambiguous mcsymbol joins, skip non-trading days (AF-20261008-12,-14,-23)"
```

### Task 3: Commit 2, server TypeScript and checks

**Files:**
- `src/server/technicalSignalsDate.ts` (new), `src/server/routers/commandCenter.router.ts`, `src/server/routers/misc.router.ts`, `src/server/routers/signals.router.ts`, `src/server/confluenceEngine.ts`, `src/server/dataQualityChecks.ts`
- Tests: `src/server/__tests__/technicalSignalsDate.test.ts`, `commandCenter.test.ts`, `accuracyMetricsResolvedCount.test.ts`, `confluenceSectorLabel.test.ts`, `dataQualityPerSeriesMacro.test.ts`

- [ ] **Step 1: Run the targeted tests and typecheck**

Run: `npx tsc --noEmit && npx vitest run src/server/__tests__/technicalSignalsDate.test.ts src/server/__tests__/commandCenter.test.ts src/server/__tests__/accuracyMetricsResolvedCount.test.ts src/server/__tests__/confluenceSectorLabel.test.ts src/server/__tests__/dataQualityPerSeriesMacro.test.ts`
Expected: pass.

- [ ] **Step 2: Commit by explicit path**

```bash
git add src/server/technicalSignalsDate.ts src/server/routers/commandCenter.router.ts src/server/routers/misc.router.ts src/server/routers/signals.router.ts src/server/confluenceEngine.ts src/server/dataQualityChecks.ts src/server/__tests__/technicalSignalsDate.test.ts src/server/__tests__/commandCenter.test.ts src/server/__tests__/accuracyMetricsResolvedCount.test.ts src/server/__tests__/confluenceSectorLabel.test.ts src/server/__tests__/dataQualityPerSeriesMacro.test.ts
git commit -m "fix(server): latest complete signal day, honest regime/accuracy queries, per-series DQ checks (AF-20261008-11,-18,-23,-24)"
```

### Task 4: Commit 3, frontend, docs and rules

**Files:**
- Components: `src/components/CanonicalSourceNote.tsx`, `CommandCenterDashboard.tsx`, `DashboardPage.tsx`, `IntradayPage.tsx`, `InvestmentStrategy.tsx`, `SignalIntelligence.tsx`, `TradeDecisionCockpit.tsx`, `TrendlyneScreenerPanel.tsx`, `UltimateDecisionMatrix.tsx`, `V1StockDetails.tsx`, `decisionMatrixInputs.ts`, `__tests__/decisionMatrixInputs.test.ts`, plus `vite.config.ts`
- Docs and rules: `CLAUDE.md`, `docs/audit-findings.md`, `docs/session-log.md`, `docs/expert-review-2026-10-08.md`, `.claude/rules/measurement.md`, `.claude/rules/bugs-data-layer.md`, `.claude/rules/recurring-bugs.md`, `.agents/memory/session_journal.md`

- [ ] **Step 1: Verify docs gates**

Run: `npm run findings:check && npm run doc:numbers:check`
Expected: OK / all match.

- [ ] **Step 2: Commit by explicit path**

```bash
git add src/components/CanonicalSourceNote.tsx src/components/CommandCenterDashboard.tsx src/components/DashboardPage.tsx src/components/IntradayPage.tsx src/components/InvestmentStrategy.tsx src/components/SignalIntelligence.tsx src/components/TradeDecisionCockpit.tsx src/components/TrendlyneScreenerPanel.tsx src/components/UltimateDecisionMatrix.tsx src/components/V1StockDetails.tsx src/components/decisionMatrixInputs.ts src/components/__tests__/decisionMatrixInputs.test.ts vite.config.ts CLAUDE.md docs/audit-findings.md docs/session-log.md docs/expert-review-2026-10-08.md .claude/rules/measurement.md .claude/rules/bugs-data-layer.md .claude/rules/recurring-bugs.md .agents/memory/session_journal.md
git commit -m "fix(ui): honest Alpha/Dashboard/Cockpit surfaces; expert review, ledger and rules (AF-20261008-11..28)"
```

### Task 5: Build and restart

**Files:** `dist/` (build output, not committed).

- [ ] **Step 1: Build the frontend**

Run: `npm run build`
Expected: exit 0; no chunk-resolution warnings for `d3`.

- [ ] **Step 2: Restart the server**

Run: `pm2 restart bharat-server` then `pm2 list`
Expected: `bharat-server` online, restart count +1.

- [ ] **Step 3: Wait for boot**

Run: poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` until 200 (max 90 s).

### Task 6: Live read-only verification

- [ ] **Step 1: Alpha page data carries plan status and a real regime**

Run: `curl -s "http://localhost:3000/api/trpc/getCommandCenter?input=%7B%22json%22%3A%7B%7D%7D"` and inspect: `eodPicks[0]` has `planStatus`, `classification`, `timeframe`; `regime.name` is a real label or `UNKNOWN`, never an invented BULL.

- [ ] **Step 2: Buy recommendations join the latest complete day**

Run: `backend-python/venv/Scripts/python.exe scripts/sql.py "SELECT date, count(*) n FROM technical_signals WHERE date >= current_date - 7 GROUP BY 1 ORDER BY 1 DESC"` and compare with `getBuyRecommendations`: picks show `win_probability` from the complete day, not blanks.

- [ ] **Step 3: Accuracy tile is LONG-only 15d**

Run the `getAccuracyMetrics` endpoint; expected fields: win rate with neutral and decisive counts and an as-of.

- [ ] **Step 4: New DQ checks report**

Run: `npm run dq:check 2>&1 | grep -E "macro-series-freshness|market-breadth-trading-day"`
Expected: both listed; the breadth check warns on 2026-09-14, 10-02, 10-04 (historical rows, AF-20261008-13).

- [ ] **Step 5: Record**

Update the AF-20261008-11/-18/-23/-24 "Status" cells from "deploy pending" to "deployed 2026-10-08 (date/time), verified" and commit `docs/audit-findings.md` by path.

## Rollback

`git revert <commit>` per commit, rebuild, `pm2 restart bharat-server`. The Python writers take effect per run and need no restart; a revert applies on their next run.
