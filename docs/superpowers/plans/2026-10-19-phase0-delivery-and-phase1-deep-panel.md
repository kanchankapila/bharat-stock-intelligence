# Phase 0 (honest delivery) + Phase 1 (deep-panel replay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pre-open brief deliver every trading day in an honest state (calls / no-trade / degraded) and monitor that it did, then produce the project's first statistically usable verdict on whether a cross-sectional ranking has any edge, by replaying a composite score over the 1,439-date `feature_store` panel per liquidity tier and horizon, cost-aware and negative-controlled.

**Architecture:** Phase 0 is TypeScript only: `composeMorningBrief` gains an explicit state, the three silent-failure branches in `processMorningBrief` become degraded sends, and two new `dataQualityChecks.ts` entries make a missed delivery and a dead horizon visible. Phase 1 is Python only and writes **no production rows**: a loader reads `feature_store` + `stock_ohlcv`, a scorer builds a cross-sectional composite, and grading imports `factor_edge.py`'s existing pure functions so the verdict is produced by the same estimator and the same reliability bar the repo already uses. Outputs are files under the session scratchpad.

**Tech Stack:** TypeScript (Express/tRPC, vitest), Python 3.11 on `backend-python/venv` (pandas, numpy, scipy, scikit-learn, pytest), PostgreSQL/TimescaleDB on :5433 read-only via `db_compat`.

**Spec:** `docs/superpowers/specs/2026-10-19-full-data-honest-recommendations-design.md` (Phases 0 and 1). Baseline evidence: that document's §2. Extends `docs/superpowers/specs/2026-10-08-accuracy-and-honesty-program-design.md`.

## Global Constraints

- Postgres/TimescaleDB on :5433 is the only database. No SQLite path, ever. Python tests use `pg_memory_conn()` / `pg_conn` / `pg_db_conn` from `src/server/pg_test_support.py`; `conftest.py` is at `src/server/conftest.py`.
- **Phase 1 writes no production rows and runs no migration.** Reads only. Outputs are files.
- NSE symbol is the only canonical identifier. Never construct a provider id by convention.
- `as_of.logical_trading_date()` / `as_of.trading_days_back(n, conn)` — never `date.today()`. Cron expressions in `queues.ts` / `jobRegistry.ts` are **UTC** (IST = UTC+5:30).
- Every behaviour change ships a regression test written first and **shown failing on the unfixed code**.
- Commit by explicit path. `git add -A` is forbidden — other sessions edit this repo concurrently.
- `MIN_DATES_RELIABLE = 20` and `MIN_SYMBOLS_XS = 50` from `factor_edge.py` are the reliability bar; import them, never redeclare them.
- Effective dates for an overlapping-window IC = `dates / horizon` (`factor_edge._effective_dates`). Never report a raw date count as independence.
- Standing gate after every task: `npx tsc --noEmit`, `npx vitest run`, `python -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/` on `backend-python/venv`, `npm run doc:numbers:check`, `npm run findings:check`.
- Committed is not deployed: a `.ts` change needs `pm2 restart bharat-server`.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each one's test is named in the task that owns the code.

1. **A weekend or exchange holiday must stay a skip, not become a "no trade today" send.** `processMorningBrief` already returns `{ skipped: true }` for both; the new degraded-send paths must not swallow that. Test in Task 1.
2. **A deep feature column present on a date whose forward label is NULL must be dropped, not zero-filled.** `feature_store` carries `target_ret_*` as NULL for the most recent horizon-length tail, and a missing value is not zero (`bugs-data-layer.md`). Test in Task 8.
3. **A tier/date whose cross-section is narrower than 50 symbols must read `DEGENERATE-XS`, not a verdict.** The F&O tier is ~190 names and some early-2021 dates will be thinner. Test in Task 10.
4. **A corporate-action seam (demerger, ratio-less split) inside the 2021-2026 panel must not dominate a mean.** `bugs-data-layer.md` records live −60% to −91% single-bar returns that are not real returns; the 2026-10-15 audit repaired some but the panel predates the repair. Winsorise forward returns and test the clip with an injected seam. Test in Task 8.
5. **Priced-but-unlisted alias symbols must be excluded from the panel.** Thirteen retired aliases (INDUSIND, LARSEN, KOTAK, TATAMOTORS, CHOLAFINSV, …) carry Yahoo bars and would double-count their real listing on the same date. Test in Task 7.

---

# Phase 0 — Honest delivery

### Task 0: Land the in-flight 2026-10-08 work (dependency, not new work)

**Files:** none created here.

`docs/superpowers/plans/2026-10-08-land-and-deploy.md` exists with 6 tasks / 17 steps and **zero executed**; its unlanded diff is the 23 modified files plus untracked tests currently in the working tree, and it touches `jobs/digests.jobs.ts` — the exact file Task 1 modifies. Executing Phase 0 on top of an unlanded tree produces a diff nobody can review.

- [ ] **Step 1: Confirm the working tree still matches that plan's scope**

Run: `git status --short`
Expected: the modified set still includes `src/server/jobs/digests.jobs.ts`, `src/server/dataQualityChecks.ts`, `src/v1/V1Routes.tsx`, `src/App.tsx`. If it does not, stop and report — another session has moved on and this plan's Task 1 baseline is wrong.

- [ ] **Step 2: Execute `docs/superpowers/plans/2026-10-08-land-and-deploy.md` end to end**

Follow that plan's own steps and gates. Do **not** revert or rewrite another session's hunks; commit by explicit path only.

- [ ] **Step 3: Confirm the tree is clean for the files Phase 0 will touch**

Run: `git status --short src/server/jobs/digests.jobs.ts src/server/morningBrief.ts src/server/dataQualityChecks.ts`
Expected: empty.

---

### Task 1: Three honest brief states

**Files:**
- Modify: `src/server/morningBrief.ts:95-107` (`composeMorningBrief`), `:108` (`buildMorningBrief`), `:150` (`sendMorningBrief`)
- Modify: `src/server/jobs/digests.jobs.ts:169-255` (`processMorningBrief`)
- Test: `src/server/__tests__/morningBriefState.test.ts` (new), `src/server/__tests__/morningBriefGate.test.ts` (extend)

**Interfaces:**
- Consumes: `buildRecommendationsDigest()`, `formatForwardTestLine(raw)`, `formatAccuracyScorecard(accuracy)`, `splitForTelegram(text)`, `telegramService.sendMarkdownMessage(chunk)` — all unchanged.
- Produces:
  - `export type BriefState = 'calls' | 'no-trade' | 'degraded'`
  - `export function composeMorningBrief(date: string, picksBody: string, scorecard: string | null, forwardLine: string, state: BriefState, stateReason: string | null): string`
  - `export async function sendMorningBrief(state?: BriefState, stateReason?: string | null): Promise<{ sent: boolean; picks: number; state: BriefState }>`
  - `buildMorningBrief()` returns `{ text, picks, state }`, deriving `state` as `'no-trade'` when `picks === 0` and `'calls'` otherwise; an explicit `state` argument overrides it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/__tests__/morningBriefState.test.ts
describe('composeMorningBrief state header', () => {
  it('labels a no-trade day unmistakably', () => {
    const out = composeMorningBrief('2026-10-19', '', null, 'fwd', 'no-trade', null);
    expect(out).toContain('NO TRADE TODAY');
    expect(out).not.toContain('PRE-OPEN BRIEF —');   // the calls header must not also appear
  });
  it('names the reason on a degraded day and does not present picks as current', () => {
    const out = composeMorningBrief('2026-10-19', 'ACME +1', null, 'fwd',
      'degraded', 'ranking is 58h old');
    expect(out).toContain('DEGRADED');
    expect(out).toContain('ranking is 58h old');
  });
  it('keeps the normal header when there are calls', () => {
    const out = composeMorningBrief('2026-10-19', 'ACME +1', null, 'fwd', 'calls', null);
    expect(out).toContain('PRE-OPEN BRIEF');
    expect(out).not.toContain('DEGRADED');
  });
});
```

```ts
// extend src/server/__tests__/morningBriefGate.test.ts
it('sends a degraded brief instead of failing when unified_recommendations is empty', async () => {
  // dbGet stubbed so the UR probe returns { g: null, d: null }
  const res = await processMorningBrief();
  expect(sendMorningBrief).toHaveBeenCalledWith('degraded', expect.stringContaining('no ranking'));
  expect(res?.success).not.toBe(false);
});
it('sends a degraded brief instead of failing when the ranking session does not match', async () => {
  const res = await processMorningBrief();
  expect(sendMorningBrief).toHaveBeenCalledWith('degraded', expect.stringContaining('matches neither'));
  expect(res?.success).not.toBe(false);
});
it('still skips — and sends nothing — on a weekend', async () => {   // Review Focus 1
  const res = await processMorningBrief();
  expect(res).toEqual({ skipped: true });
  expect(sendMorningBrief).not.toHaveBeenCalled();
});
it('still skips — and sends nothing — on a listed NSE holiday', async () => {   // Review Focus 1
  expect(await processMorningBrief()).toEqual({ skipped: true });
  expect(sendMorningBrief).not.toHaveBeenCalled();
});
it('refuses to send a pre-open brief after 09:15 IST and records the miss', async () => {
  const res = await processMorningBrief();
  expect(sendMorningBrief).not.toHaveBeenCalled();
  expect(res?.success).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/__tests__/morningBriefState.test.ts src/server/__tests__/morningBriefGate.test.ts`
Expected: FAIL — `composeMorningBrief` takes 4 arguments, and the gate tests fail on `{ success: false }`.

- [ ] **Step 3: Add `BriefState` and the state header to `composeMorningBrief`**

`'calls'` keeps today's `🌅 *PRE-OPEN BRIEF* — <date>` header. `'no-trade'` uses `🚫 *NO TRADE TODAY* — <date>` followed by the gate's own words, and still prints the scorecard and the forward-test line (the honesty blocks are the point of an empty day). `'degraded'` uses `⚠ *PRE-OPEN BRIEF (DEGRADED)* — <date>` and puts `stateReason` on its own line directly under the header, before any picks.

- [ ] **Step 4: Thread the state through `buildMorningBrief` and `sendMorningBrief`**

`buildMorningBrief(state?, stateReason?)` derives `'no-trade'` from `picks === 0` when no state is passed. Keep both existing try/catch degradations exactly as they are — neither honesty block may fail a send.

- [ ] **Step 5: Convert the two data branches in `processMorningBrief` from failures to degraded sends**

In `src/server/jobs/digests.jobs.ts`: the empty-`unified_recommendations` branch and the session-mismatch branch each call `sendMorningBrief('degraded', msg)` and return the normal success path, still writing `MORNING_BRIEF_LAST_SENT_KEY`. Keep the weekend, holiday and post-09:15 branches byte-for-byte as they are: the first two are correct skips, and the third is a correct refusal whose visibility is Task 2's job, not a send.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/server/__tests__/morningBriefState.test.ts src/server/__tests__/morningBriefGate.test.ts src/server/__tests__/morningBriefTradingSession.test.ts`
Expected: PASS, including the pre-existing trading-session suite.

- [ ] **Step 7: Commit**

```bash
git add src/server/morningBrief.ts src/server/jobs/digests.jobs.ts src/server/__tests__/morningBriefState.test.ts src/server/__tests__/morningBriefGate.test.ts
git commit -m "feat(brief): deliver an explicit calls/no-trade/degraded state instead of silence"
```

---

### Task 2: Make a missed delivery visible

**Files:**
- Modify: `src/server/dataQualityChecks.ts` (add one check to the registry)
- Test: `src/server/__tests__/dataQualityChecks.test.ts` (extend)

**Interfaces:**
- Consumes: the registry entry shape already used at `dataQualityChecks.ts:643-649` (`{ id, label, category, critical, table, dateColumn, tradingDayAware, warnDays, failDays }`) and, for a custom-SQL check, whichever `customSql`/`run` field the neighbouring non-table checks in that file use — follow the closest existing sibling rather than inventing a field.
- Produces: check id `morning-brief-delivery`.

Evidence this check must catch (spec B7): the brief delivered on 5 of 7 trading days; on 2026-10-12 and 2026-10-19 nothing was sent and no check noticed. `app_settings.morning_brief_last_sent_ranking` is the delivery receipt.

- [ ] **Step 1: Write the failing test**

```ts
it('morning-brief-delivery fails when the latest trading day has no delivery receipt', async () => {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === 'morning-brief-delivery');
  expect(check).toBeDefined();
  expect(check!.critical).toBe(true);
});
it('morning-brief-delivery passes on a day whose receipt matches the latest ranking', async () => { /* seeded receipt */ });
it('morning-brief-delivery does not fail on a weekend or listed holiday', async () => { /* Review Focus 1 */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/__tests__/dataQualityChecks.test.ts -t morning-brief-delivery`
Expected: FAIL — no such check id.

- [ ] **Step 3: Add the check**

Compare `app_settings.morning_brief_last_sent_ranking` against the latest completed NSE session, holiday-aware via the same session source `processMorningBrief` uses. FAIL when a trading day passed with no receipt; pass on weekends and listed holidays. Do **not** key it on `job_heartbeat` — a heartbeat is the last run and `bugs-monitoring.md` records it being overwritten by a retry.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/server/__tests__/dataQualityChecks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/dataQualityChecks.ts src/server/__tests__/dataQualityChecks.test.ts
git commit -m "feat(dq): fail when a trading day passes with no pre-open brief delivered"
```

---

### Task 3: Make a dead horizon visible

**Files:**
- Modify: `src/server/dataQualityChecks.ts`
- Test: `src/server/__tests__/dataQualityChecks.test.ts` (extend)

**Interfaces:** produces check id `unified-recommendations-timeframe-coverage`.

**Premise corrected 2026-10-20.** Spec B8 is withdrawn: `LONG_TERM` last produced 2026-09-30 (not 09-28) and its disappearance was **deliberate** — folded onto `POSITIONAL` on 2026-10-03 (`unified_ranker.py:192-215`, `CANONICAL_TIMEFRAMES`, commit `8645d47c`, AF-20261001-06). So this check must expect the **union** of the hardcoded canonical three (`INTRADAY`/`SWING`/`POSITIONAL`, sourced from the ranker's own tuple and guarded by a source-parity test) and the trailing-window set. A missing canonical horizon fails and never ages out; a retired non-canonical label ages out of the window and self-heals. What remains true from C2 is that 87% of rows carry a NULL `timeframe`.

- [ ] **Step 1: Write the failing test**

```ts
it('fails when a timeframe that produced rows last week produced none on the latest ranking day', () => { /* seeded: SWING present, LONG_TERM absent */ });
it('passes when every timeframe seen in the trailing window is present', () => {});
it('does not fail for a timeframe that has never been produced', () => {});  // no false alarm on an unused label
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/server/__tests__/dataQualityChecks.test.ts -t timeframe-coverage`. Expected: FAIL, no such check.

- [ ] **Step 3: Add the check.** Compare the distinct non-NULL `timeframe` set on the latest `generated_at::date` against the set seen in the trailing 10 trading days. A timeframe in the trailing set and absent today is a FAIL naming it. Key the comparison on the trailing set, not a hardcoded list of four labels, so retiring a horizon deliberately does not become a permanent red.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/server/__tests__/dataQualityChecks.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/dataQualityChecks.ts src/server/__tests__/dataQualityChecks.test.ts
git commit -m "feat(dq): fail when a previously-produced recommendation timeframe goes silent"
```

---

### Task 4: Root-cause `company-profiles-sync`

**Files:**
- Modify: whichever writer `src/server/jobs/sync.jobs.ts`'s `QUEUE_COMPANY_PROFILES_SYNC` step invokes (identify in Step 1; do not assume)
- Test: a `live_datasource`-marked test beside that writer

Evidence (spec B11/C8): "0/15 profiles synced (15 failed)" on 2026-10-16, -17, -18 and -19.

- [ ] **Step 1: Establish what actually fails, before changing anything**

Read the step's own stderr from pm2 stdout as well as the app log (`bugs-monitoring.md`: the runtime numbers were in `logs/pm2-out.log` all along), then run the writer standalone for one symbol and print the exact request it sends.

- [ ] **Step 2: Follow `data-sources.md`'s mandatory sequence before declaring the provider dead**

In order: `market_endpoint_registry` (3,408 endpoints; views `v_working_market_endpoints`), then `python -m url_explorer.ingest --find-alternates "<target>" --exclude <failing-host>` from `src/server`, then `unique_urls.txt`, then sibling routes probed one at a time with the **minimum** headers — start from none, because `bugs-data-layer.md` records a token *lowering* access on exactly this class of route.

- [ ] **Step 3: Write the failing test for the real cause**

A `live_datasource` test that hits one real symbol and asserts a non-empty parsed row. It must fail against the current code.

- [ ] **Step 4: Fix the cause and make the failure loud if it recurs**

If the provider genuinely changed, repoint to the alternate found in Step 2. Exit non-zero on sustained failure so the step cannot report success over zero rows, and classify a throttle separately from a genuine empty (`bugs-jobs-runtime.md`).

- [ ] **Step 5: Verify live**

Run the job's step and query the written rows back with `backend-python/venv/Scripts/python.exe scripts/sql.py "<SQL>"`. A green test does not show a fetcher wrote the right rows.

- [ ] **Step 6: Commit, and open/close the ledger row**

```bash
git add <writer> <test> docs/audit-findings.md
git commit -m "fix(company-profiles): repair the sync writer and fail loudly on zero rows"
```

---

### Task 5: Remove the stale agent worktrees

**Files:** none in the repo tree.

Evidence (spec B13/C10): five full copies under `.claude/worktrees/` multiply every repo-wide count by six and already corrupted one measurement this session.

- [ ] **Step 1: List them and confirm each is spent**

Run: `git worktree list` and `git -C .claude/worktrees/<each> status --short`
Expected: each is either clean or holds only work already on `main`. **If any has unique uncommitted work, stop and report it** — do not remove another session's work.

- [ ] **Step 2: Remove the spent ones**

Run: `git worktree remove .claude/worktrees/<name>` per spent worktree, then `git worktree prune`.

- [ ] **Step 3: Verify the multiplier is gone**

Run: `grep -rl "niftytrader_live_screener_snapshots" --include=*.py --include=*.ts . | grep -v node_modules | wc -l`
Expected: a count consistent with one checkout (single digits), not ~6x.

---

# Phase 1 — The deep-panel replay

No task in this phase writes a production row or runs a migration.

**On `purged_cv`:** the spec's §7.1 says to reuse `purged_cv.make_purged_group_time_series_split`. No task here does, deliberately — the Phase 1 baseline is an *equal-weight* composite with nothing fitted, so there is no train/test split to purge and an embargo would be ceremony. `purged_cv` becomes mandatory the moment Phase 2 fits weights to this panel; the spec's instruction is recorded against that phase, not dropped.

### Task 6: Derive the deep column set (never hardcode it)

**Files:**
- Create: `src/server/deep_panel.py`
- Test: `src/server/tests/test_deep_panel_columns.py`

**Interfaces:**
- Produces:
  - `DEEP_COVERAGE_FLOOR = 0.60`
  - `LABEL_COLUMNS = ("target_ret_1d", "target_ret_5d", "target_ret_15d", "target_dir_1d", "target_dir_5d", "target_dir_15d")`
  - `def deep_feature_columns(conn, *, start: str = "2021-01-01", end: str = "2022-01-01", floor: float = DEEP_COVERAGE_FLOOR) -> list[str]` — numeric `feature_store` columns whose non-null share over `[start, end)` is at least `floor`, **excluding** `LABEL_COLUMNS` and the key columns `symbol`/`date`.

The measured answer today is 59 columns including the labels; excluding the 6 labels leaves 53 features. Deriving it keeps the set honest as coverage changes, and excluding the labels by explicit name is the fix for the `select_dtypes`-swept-the-label class in `ml-model-bugs.md`.

- [ ] **Step 1: Write the failing test**

```python
def test_excludes_label_columns(pg_db_conn):
    cols = deep_feature_columns(pg_db_conn)
    assert not set(cols) & set(LABEL_COLUMNS)

def test_excludes_keys_and_respects_the_floor(pg_db_conn):
    cols = deep_feature_columns(pg_db_conn, floor=0.60)
    assert "symbol" not in cols and "date" not in cols
    assert "iv_rank" not in cols          # 8.4% populated, must not qualify
    assert "rsi_14" in cols               # deep, must qualify

def test_floor_is_applied_not_ignored(pg_db_conn):
    assert len(deep_feature_columns(pg_db_conn, floor=0.99)) < len(deep_feature_columns(pg_db_conn, floor=0.10))
```

- [ ] **Step 2: Run to verify it fails** — `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_deep_panel_columns.py -v`. Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement `deep_feature_columns`**

Read candidate names from `information_schema.columns` **qualified with `table_schema`** (`check_information_schema_missing_table_schema` enforces this), then one aggregate query computing per-column non-null share over the window. Use `db_compat` and `?` placeholders.

- [ ] **Step 4: Run to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/deep_panel.py src/server/tests/test_deep_panel_columns.py
git commit -m "feat(deep-panel): derive the deep feature column set from measured coverage"
```

---

### Task 7A: Point-in-time F&O eligibility

**Files:**
- Create: `src/server/fno_universe_asof.py`
- Test: `src/server/tests/test_fno_universe_asof.py`

**Interfaces:**
- Produces:
  - `def fno_eligible_asof(conn, date: str) -> set[str]` — the NSE symbols that were F&O-eligible **on that date**.
  - `def fno_series_coverage(conn) -> tuple[str, str]` — the first and last date for which a dated series can be built.

The spec settles this explicitly and it is the one contaminable input in the whole phase: `nse_stocks.fno_eligible` is a **current-state** flag (209 symbols) and applying it backwards injects survivorship into the tier the user cares most about. Derive the dated series from the F&O bhavcopy (the 2026-10-08 review records the old-format bhavcopy returning 2022 history at ~62k stock-option rows/day); treat `technical_signals.mc_fno_eligible` as corroboration only, since it starts late and is written with the `date >= floor` pattern. Where the series cannot reach, the F&O tier's verdict is bounded to the dates it covers and says so.

- [ ] **Step 1: Write the failing tests**

```python
def test_never_falls_back_to_the_current_state_flag(pg_conn):
    # seed nse_stocks.fno_eligible = true for NEWFNO, with no dated row on the asked date
    assert "NEWFNO" not in fno_eligible_asof(pg_conn, "2021-06-01")

def test_returns_the_dated_membership_for_a_covered_date(pg_conn):
    assert fno_eligible_asof(pg_conn, "2022-06-01") == {"OLDFNO"}

def test_coverage_reports_the_real_span_not_the_requested_one(pg_conn):
    first, last = fno_series_coverage(pg_conn)
    assert first >= "2021-01-01"

def test_an_uncovered_date_returns_empty_rather_than_guessing(pg_conn):
    assert fno_eligible_asof(pg_conn, "1999-01-01") == set()
```

- [ ] **Step 2: Run to verify they fail** — `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_fno_universe_asof.py -v`. Expected: FAIL, module does not exist. The first test is the load-bearing one: confirm it fails for the right reason (the current-state flag leaking in), not merely on the missing import.

- [ ] **Step 3: Establish what dated source actually exists, then implement**

Before writing the derivation, check what is already stored: `nt_index_oi_eod`, `index_max_pain`, `trendlyne_fno_activity` and `so_option_chain` all hold rows and three of them are on the spec's write-only list. If one carries dated per-symbol F&O presence, use it and skip the bhavcopy work entirely. Report which source was chosen and its real span.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/fno_universe_asof.py src/server/tests/test_fno_universe_asof.py
git commit -m "feat(deep-panel): dated F&O eligibility, never the current-state flag"
```

---

### Task 7: Panel loader with the universe cleaned

**Files:**
- Modify: `src/server/deep_panel.py`
- Test: `src/server/tests/test_deep_panel_loader.py`

**Interfaces:**
- Consumes: `deep_feature_columns` (Task 6), `fno_eligible_asof` (Task 7A), `as_of.trading_days_back`.
- Produces:
  - `def load_panel(conn, columns: list[str], start: str, end: str) -> pd.DataFrame` — one row per `(symbol, date)` with `columns` plus `LABEL_COLUMNS` plus `adt_20d` and `tier` (the `tradable_tier` result for that row's own date, using Task 7A's dated eligibility), alias symbols excluded. `tier` is the column Task 10 groups on.
  - `def tradable_tier(adt_cr: float, fno_eligible: bool) -> str` — returns one of `"FNO"`, `"ADT50CR"`, `"ADT10CR"`, `"BELOW10CR"`.
  - `def exclude_alias_symbols(conn, symbols: Iterable[str]) -> set[str]` — symbols priced but with no `nse_universe_history` row in 45 days, plus any symbol sharing an ISIN with another (`GROUP BY isin HAVING count(*) > 1`).

- [ ] **Step 1: Write the failing tests**

```python
def test_drops_priced_but_unlisted_alias_symbols(pg_conn):   # Review Focus 5
    # seed: REALCO listed+priced, ALIASCO priced with no exchange row in 45 days, same ISIN
    panel = load_panel(pg_conn, ["rsi_14"], "2021-01-01", "2021-02-01")
    assert "ALIASCO" not in set(panel.symbol)
    assert "REALCO" in set(panel.symbol)

def test_tier_boundaries_are_inclusive_at_the_floor():
    assert tradable_tier(50.0, False) == "ADT50CR"
    assert tradable_tier(49.9, False) == "ADT10CR"
    assert tradable_tier(9.9, False) == "BELOW10CR"
    assert tradable_tier(1.0, True) == "FNO"      # F&O eligibility wins over ADT

def test_one_row_per_symbol_date(pg_conn):
    panel = load_panel(pg_conn, ["rsi_14"], "2021-01-01", "2021-02-01")
    assert not panel.duplicated(subset=["symbol", "date"]).any()

def test_empty_window_returns_empty_frame_not_an_exception(pg_conn):
    assert load_panel(pg_conn, ["rsi_14"], "1990-01-01", "1990-02-01").empty
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL, functions do not exist.

- [ ] **Step 3: Implement the three functions**

`adt_20d` is a 20-session rolling median of `close * volume` from `stock_ohlcv`, in crore. Build the frame from the row dicts and rename after, never `pd.DataFrame(rows, columns=[...])` (`bugs-data-layer.md`). Stream large reads with `db_compat.iter_rows`.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/deep_panel.py src/server/tests/test_deep_panel_loader.py
git commit -m "feat(deep-panel): load the panel with alias symbols excluded and ADT tiers attached"
```

---

### Task 8: Cross-sectional composite score

**Files:**
- Create: `src/server/deep_panel_score.py`
- Test: `src/server/tests/test_deep_panel_score.py`

**Interfaces:**
- Produces:
  - `FACTOR_GROUPS: dict[str, tuple[str, ...]]` — `momentum`, `value`, `quality`, `flow`, `volatility`; every column from Task 6 assigned to exactly one group, and a column the mapping does not name raises rather than being silently dropped.
  - `def zscore_by_date(panel: pd.DataFrame, columns: list[str]) -> pd.DataFrame` — per-date cross-sectional z-scores, winsorised at the 1st/99th percentile with `interpolation="higher"/"lower"`.
  - `def composite_score(panel: pd.DataFrame, columns: list[str], groups=FACTOR_GROUPS) -> pd.Series` — equal weight within a group, equal weight across groups, so no hand-fitted weights exist.
  - `def winsorise_returns(s: pd.Series, pct: float = 0.01) -> pd.Series`

Equal weight is deliberate: `measurement.md`'s Finding #31 forbids hand-fitting weights, and a fitted model is Phase 2's job after this baseline has a number.

- [ ] **Step 1: Write the failing tests**

```python
def test_quantile_winsorise_actually_clips_a_lone_extreme():   # Review Focus 4
    s = pd.Series([1.0] * 99 + [249900.0])
    assert winsorise_returns(s).max() <= 2.0      # linear interpolation leaves ~25.0 and fails this

def test_zscore_is_cross_sectional_not_pooled():
    # two dates with different levels but identical ordering -> identical z-scores per date
    ...

def test_null_feature_does_not_become_zero():     # Review Focus 2
    out = zscore_by_date(panel_with_one_nan, ["rsi_14"])
    assert pd.isna(out.loc[nan_row_index, "rsi_14"])

def test_unmapped_column_raises():
    with pytest.raises(KeyError):
        composite_score(panel, ["a_column_no_group_claims"])

def test_composite_is_group_equal_weighted():
    # a 10-column momentum group must not outvote a 2-column value group
    ...
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL, module does not exist. Confirm the winsorise test fails specifically on the ~25.0 value — that is the documented trap, and a test that passes before the fix proves nothing.

- [ ] **Step 3: Implement the four functions.** Use `interpolation="higher"` / `"lower"` on the quantiles so the cutoff is an observed value.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/deep_panel_score.py src/server/tests/test_deep_panel_score.py
git commit -m "feat(deep-panel): equal-weight cross-sectional composite with observed-value winsorisation"
```

---

### Task 9: Leak guard and shuffled control

**Files:**
- Modify: `src/server/deep_panel_score.py`
- Test: `src/server/tests/test_deep_panel_leak_guard.py`

**Interfaces:**
- Produces:
  - `LEAK_CORR_LIMIT = 0.15` (was 0.2; lowered with the guard rename, commit 56ebc0bb)
  - `def assert_no_label_leak(panel, score, label_col, limit=LEAK_CORR_LIMIT) -> float`, in `deep_panel_score.py` (renamed 2026-10-20 from the same-day-return guard; it now guards the LABEL the score is graded on) — returns the absolute correlation, raises `LeakDetected` at or above `LEAK_CORR_LIMIT`.
  - `def shuffled_control(panel: pd.DataFrame, score: pd.Series, seed: int = 20261019) -> pd.Series` — the score permuted **within each date**, so the control keeps the cross-sectional shape and destroys only the symbol mapping.
  - `class LeakDetected(RuntimeError)`

This is the one-line check `ml-model-bugs.md` says would have caught a +3.6%/day fabrication in seconds. It runs before any verdict is written, not after.

- [ ] **Step 1: Write the failing tests**

```python
def test_raises_when_the_score_is_the_same_day_return():
    with pytest.raises(LeakDetected):
        assert_no_label_leak(panel, panel["fwd_5"], "fwd_5")

def test_passes_for_an_honest_score():
    assert assert_no_label_leak(panel, honest_score, "fwd_5") < LEAK_CORR_LIMIT

def test_shuffle_permutes_within_date_only():
    ctl = shuffled_control(panel, score)
    # per-date value multiset is unchanged; symbol mapping is not
    for d, g in panel.groupby("date"):
        assert sorted(ctl[g.index]) == sorted(score[g.index])

def test_shuffle_is_reproducible_from_the_seed():
    assert shuffled_control(panel, score).equals(shuffled_control(panel, score))
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL, functions do not exist.

- [ ] **Step 3: Implement them.**

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/deep_panel_score.py src/server/tests/test_deep_panel_leak_guard.py
git commit -m "feat(deep-panel): assert no same-day leak and add a within-date shuffled control"
```

---

### Task 10: Tiered grading, reusing `factor_edge`'s estimator

**Files:**
- Create: `src/server/deep_panel_grade.py`
- Test: `src/server/tests/test_deep_panel_grade.py`

**Interfaces:**
- Consumes: `factor_edge._metrics`, `factor_edge._effective_dates`, `factor_edge._verdict`, `factor_edge._forward_returns`, `factor_edge.MIN_DATES_RELIABLE`, `factor_edge.MIN_SYMBOLS_XS` — imported, never reimplemented, so this verdict is comparable with every other verdict in the repo.
- Produces:
  - `HORIZONS = (1, 5, 15, 21)`
  - `def grade_tier(panel: pd.DataFrame, score: pd.Series, tier: str, horizons=HORIZONS) -> list[dict]` — one row per horizon with `tier`, `horizon`, `rank_ic`, `hit_auc`, `n`, `dates`, `eff_dates`, `symbols`, `verdict`.
  - `def grade_all_tiers(panel, score, horizons=HORIZONS) -> pd.DataFrame`

- [ ] **Step 1: Write the failing tests**

```python
def test_a_narrow_tier_reads_degenerate_xs():        # Review Focus 3
    rows = grade_tier(panel_with_30_symbols, score, "FNO")
    assert all(r["verdict"] == "DEGENERATE-XS" for r in rows)

def test_eff_dates_is_dates_over_horizon_not_raw_dates():
    rows = grade_tier(panel_1439_dates, score, "ADT50CR", horizons=(5,))
    assert rows[0]["eff_dates"] == pytest.approx(rows[0]["dates"] / 5)

def test_rows_whose_label_is_null_are_dropped_not_zeroed():   # Review Focus 2
    # a panel whose last 5 dates have NULL target_ret_5d must report fewer dates, not a depressed IC
    ...

def test_a_wide_deep_panel_can_read_usable():        # non-vacuity: the grader must be able to say yes
    rows = grade_tier(synthetic_panel_with_real_signal, planted_score, "ADT50CR", horizons=(5,))
    assert rows[0]["verdict"] == "USABLE"
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement `grade_tier` / `grade_all_tiers`** by grouping the panel on the tier column and delegating each group to the imported `_metrics` / `_verdict`.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS, including the non-vacuity case.

- [ ] **Step 5: Commit**

```bash
git add src/server/deep_panel_grade.py src/server/tests/test_deep_panel_grade.py
git commit -m "feat(deep-panel): grade per tier and horizon through factor_edge's own estimator"
```

---

### Task 11: Cost-aware net expectancy and turnover

**Files:**
- Modify: `src/server/deep_panel_grade.py`
- Test: `src/server/tests/test_deep_panel_costs.py`

**Interfaces:**
- Consumes: `indian_market_costs.round_trip_cost_bps(notional, asset_class, trade_type, participation_rate, market_cap_cr, volatility_pct, include_slippage)` — note its docstring: it returns a **decimal fraction**, not bps, despite the name.
- Produces:
  - `def net_expectancy(panel, score, tier: str, horizon: int, top_frac: float = 0.1) -> dict` — `gross_pct`, `cost_pct`, `net_pct`, `turnover`, `n_periods`, using **disjoint** holding periods (rebalance every `horizon` sessions), so `n_periods` is already an independent count and needs no `/h` correction.
  - `def rank_buffer_turnover(ranks_by_date: pd.DataFrame, top_n: int, buffer_k: int) -> float`

Disjoint rebalances are the point: `ml-model-bugs.md` records that `factor_backtest.py`'s periods are independent while `factor_edge.py`'s overlap, and applying the overlap correction to disjoint periods would throw away real evidence.

- [ ] **Step 1: Write the failing tests**

```python
def test_cost_is_charged_per_side_and_reduces_gross():
    out = net_expectancy(panel, score, "ADT50CR", 5)
    assert out["net_pct"] < out["gross_pct"]

def test_periods_are_disjoint_not_overlapping():
    out = net_expectancy(panel_1439_dates, score, "ADT50CR", 5)
    assert out["n_periods"] == pytest.approx(1439 / 5, rel=0.02)

def test_rank_buffer_reduces_turnover_versus_no_buffer():
    assert rank_buffer_turnover(ranks, 50, 10) < rank_buffer_turnover(ranks, 50, 0)

def test_round_trip_cost_is_read_as_a_fraction_not_bps():
    # a 25bps round trip must subtract ~0.25%, not ~25%
    ...
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement both functions.**

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/deep_panel_grade.py src/server/tests/test_deep_panel_costs.py
git commit -m "feat(deep-panel): net expectancy over disjoint rebalances with real Indian costs"
```

---

### Task 12: The replay CLI and the verdict report

**Files:**
- Create: `src/server/deep_panel_replay.py`
- Test: `src/server/tests/test_deep_panel_replay.py`

**Interfaces:**
- Consumes: every function from Tasks 6-11.
- Produces: `python -m deep_panel_replay --start 2021-01-01 --end 2026-10-19 --out <dir>`, writing `verdicts.csv` (one row per tier × horizon from Task 10, plus Task 11's net columns), `control.csv` (the same grid for the shuffled control) and `REPORT.md`.

- [ ] **Step 1: Write the failing tests**

```python
def test_refuses_to_write_a_report_when_the_leak_guard_trips():
    # the guard must run BEFORE any output file is created
    with pytest.raises(LeakDetected):
        main(["--start", ..., "--out", tmpdir, "--score-col", "ret_1d"])
    assert not (tmpdir / "verdicts.csv").exists()

def test_report_prints_eff_dates_and_the_control_beside_every_verdict():
    main([...])
    report = (tmpdir / "REPORT.md").read_text()
    assert "eff_dates" in report and "control" in report

def test_writes_no_production_rows(pg_db_conn):
    before = row_counts(pg_db_conn)
    main([...])
    assert row_counts(pg_db_conn) == before
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement `main(argv)`** in this order: derive columns → load panel → score → **leak guard** → grade all tiers → net expectancy → shuffled control through the identical grid → write the three files. The guard precedes every write.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Run the real replay and read the verdict**

Run: `backend-python/venv/Scripts/python.exe -m deep_panel_replay --start 2021-01-01 --end 2026-10-19 --out <scratchpad>/replay` from `src/server`.
Expected: `verdicts.csv` with `eff_dates >= 20` on at least the 5d horizon for the ADT tiers, a shuffled control whose rank IC sits near zero, and a stated verdict per tier. **A `no edge` verdict here is a successful run.**

- [ ] **Step 6: Record the verdict where the next session will find it**

Append the measured table to `.claude/rules/measurement.md` with its date, method, `eff_dates` and cost assumption, and open the ledger row. Per the spec's §8, also correct `CONTEXT.md`'s "Measured State Of The Edge" and the 2026-10-08 design's §G claim about pre-2026-08-10 inputs.

- [ ] **Step 7: Commit**

```bash
git add src/server/deep_panel_replay.py src/server/tests/test_deep_panel_replay.py .claude/rules/measurement.md CONTEXT.md docs/superpowers/specs/2026-10-08-accuracy-and-honesty-program-design.md docs/audit-findings.md
git commit -m "feat(deep-panel): replay CLI, and record the first well-powered edge verdict"
```

---

### Task 13: Documentation audit

**Files:**
- Modify: `CONTEXT.md`, `.claude/rules/scoring-authority.md`, `src/server/intraday_ranker.py` (comment only), `docs/master-build-prompt.md`, `docs/audit-findings.md`
- Test: `src/server/__tests__/docClaims.test.ts` (extend if a guard already exists there; otherwise create)

The spec's §8 lists eight corrections. Two method notes, both learned on this plan's own evidence:

- **`npm run doc:numbers:check` already passes**, so none of these are count drift. They are reasoning errors, and no automated check can find them.
- **A raw grep for a retired name is not a staleness finding.** Measured 2026-10-19: `greenfield`, `bharatquant`, `V2AppShell`, `V6Shell`, `dashboardVersion`, `timeframe_scores` and `better-sqlite3` all still appear in docs and rules — and **every occurrence is a note saying the thing is gone**, which is exactly what those files should say. Classify each hit as *gone-note* or *live assumption* before changing anything; only the second is a defect.

- [ ] **Step 1: Write the failing test**

```ts
it('CONTEXT.md states the effective-date range behind the edge claim, not just the LOW-DATA label', () => {
  const ctx = readFileSync('CONTEXT.md', 'utf8');
  expect(ctx).toMatch(/effective dates/i);
});
it('CONTEXT.md marks which ranker engines carry non-zero weight', () => {
  expect(readFileSync('CONTEXT.md', 'utf8')).toMatch(/weight 0\.0|zero-weight/i);
});
it('scoring-authority.md documents that conviction_level is direction-agnostic', () => {
  expect(readFileSync('.claude/rules/scoring-authority.md', 'utf8')).toMatch(/direction-agnostic/i);
});
it('scoring-authority.md documents the two signal_type vocabularies', () => {
  const r = readFileSync('.claude/rules/scoring-authority.md', 'utf8');
  expect(r).toContain('Bullish');
  expect(r).toContain('BUY');
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/server/__tests__/docClaims.test.ts`. Expected: FAIL on all four.

- [ ] **Step 3: Apply the eight corrections from the spec's §8**, including the `intraday_ranker.py` header whose reasoning and constants disagree (comment only — the constants need their own measurement, per the spec's C5 resolution).

- [ ] **Step 4: Run to verify it passes, and run the doc-number gate** — `npx vitest run src/server/__tests__/docClaims.test.ts && npm run doc:numbers:check`. Expected: PASS and no drift.

- [ ] **Step 5: Commit**

```bash
git add CONTEXT.md .claude/rules/scoring-authority.md src/server/intraday_ranker.py docs/master-build-prompt.md docs/audit-findings.md src/server/__tests__/docClaims.test.ts
git commit -m "docs: correct the edge claim, the live engine set and two undocumented contracts"
```


---

# AMENDMENT 2026-10-21 — Tasks 8-12 SUPERSEDED, Phase 1 re-scoped

**Why.** `measurement.md` records that the deep-panel replay this phase proposed has already been run twice, on a broader panel, with a conclusive answer:

- **AF-20261008-29 (2026-10-09)** — survivorship-reduced 2021-2026 panel (3,058,836 rows, 3,491 symbols, 1,431 sessions, bhavcopy unioned with `stock_ohlcv`, 132 renames de-duplicated). Price-only ranker rebuild: IC +0.073 in the published window, **+0.003..+0.014 at 5d over 2022-2026 (t <= 1.1)**. Equal-weight price+delivery combination, signs fixed on the first half: **OOS IC +0.050 (t 5.4), positive in every regime, top-decile net -0.022%/period (t -0.38)**.
- **AF-20261008-31 (2026-10-09)** — 58 structural levers against a Bonferroni |t| 3.33 bar; **none reached t 2 out of sample**. Recorded conclusion: *"the limit is signal strength, not cost structure."*
- **2026-09-26** — individual `feature_store` columns graded on the liquid panel at **eff 130 at h=5**; a 5-column OOS composite read **+0.049** and then **-0.53 to -0.94%/period** after costs.

So the spec's B1/B2 ("no usable edge reading exists; the deep panel is ungraded") were true of `unified_recommendations`' own 42-date panel and wrong as generalisations about the data. Rebuilding Tasks 8-12 would duplicate 11-day-old work.

**Tasks 8, 9, 10, 11 and 12 are superseded.** The modules already built stand and are inputs either way: Task 6's 47-column corrected set, Task 7A's dated F&O universe with `is_covered`, and `column_zero_shares()`.

### Task 8R: Composite scorer with the leak guard built in

**Files:** Create `src/server/deep_panel_score.py`; Test `src/server/tests/test_deep_panel_score.py`

**Interfaces — Consumes:** `deep_panel.deep_feature_columns`, `deep_panel.column_zero_shares`.
**Produces:**
- `FACTOR_GROUPS: dict[str, tuple[str, ...]]` over the 47 columns — `momentum`, `value`, `quality`, `flow`, `volatility`; a column no group names raises rather than being dropped.
- `def zscore_by_date(panel, columns) -> pd.DataFrame` — per-date cross-sectional z-scores, winsorised with `interpolation="higher"/"lower"` so the cutoff is an observed value.
- `def composite_score(panel, columns, groups=FACTOR_GROUPS) -> pd.Series` — equal weight within a group, equal weight across groups. No fitted weights (Finding #31).
- `def winsorise_returns(s, pct=0.01) -> pd.Series`
- `LEAK_CORR_LIMIT = 0.15`; `class LeakDetected(RuntimeError)`; `def assert_no_label_leak(panel, score, label_col, limit=LEAK_CORR_LIMIT) -> float`; `def shuffled_control(panel, score, seed=20261021) -> pd.Series` permuting **within each date**.

Measured parameters to use rather than guess: the 1%/99% clip lands at about -14.7%/+25.2% on `target_ret_5d`; p50 is -0.23% against a mean of +0.62%; exactly one row sits at 99.0 (a single bad print, not a clamp).

### Task 9R: Tiered grading, both benchmarks, and reconciliation

**Files:** Create `src/server/deep_panel_grade.py`; Test `src/server/tests/test_deep_panel_grade.py`

**Interfaces — Consumes:** `factor_edge._metrics`, `_effective_dates`, `_verdict`, `_forward_returns`, `MIN_DATES_RELIABLE`, `MIN_SYMBOLS_XS` (imported, never reimplemented); `fno_universe_asof.fno_eligible_asof` / `is_covered`; Task 8R's scorer and guards.
**Produces:** `HORIZONS = (1, 5, 15, 21)`; `def grade_tier(panel, score, tier, horizons=HORIZONS) -> list[dict]`; `def grade_all_tiers(panel, score, horizons=HORIZONS) -> pd.DataFrame`. Every row carries `tier`, `horizon`, `rank_ic`, `hit_auc`, `n`, `dates`, `eff_dates`, `symbols`, `verdict`, **`median_benchmark_excess`**, **`mean_benchmark_excess`**, and `zero_share_max`.

Three requirements that are the whole point of the re-scope:

1. **The dated F&O tier**, which no recorded reading has. Gate every date through `is_covered`; the F&O verdict is bounded to 2021-01-01..2024-07-05 and says so on every row. Resolve F&O symbols to the price panel **by ISIN** when the literal symbol has no bars (TATAMOTORS -> TMPV via INE155A01022, LTIM -> LTM via INE214T01019), keep only unambiguous single-priced-twin ISINs, and report the match rate plus every unresolved symbol. 190 of 206 resolve directly; never intersect-and-drop.
2. **Both benchmarks on every row.** `factor_edge` centres on the per-date MEDIAN while `factor_backtest` benchmarks the universe MEAN, and `measurement.md` records this as the trap that let a well-powered +0.049 IC lose money on right-skewed Indian returns. Print both; a positive median excess beside a negative mean excess is flagged on the row.
3. **ADT uses the frozen protocol's convention verbatim** — 20-session rolling MEAN of `close*volume` with `min_periods=15`, and the Rs 1cr floor — so the tiers are comparable with `forward_test_report.py`. Not a median.

**Reconciliation, not re-derivation.** The report states, for each tier and horizon, how the reading compares with the recorded AF-20261008-29 figures (OOS IC +0.050, top-decile net -0.022%/period) and the 2026-09-26 column readings, and says plainly whether it agrees. Agreement hardens the existing result; disagreement is the finding.

**One genuinely open technical question to answer here:** the 2026-09-26 low-volatility reading used `atr_pct` on a 2024-01-01+ panel, and `atr_pct` is one of the six columns whose zeros are warm-up artifacts. On a 2024+ panel warm-up affects only newly-listed names, so that reading is probably sound — but `atr_pct -0.077 @21d` is the strongest single-column result on this platform's record, so measure it rather than assuming. Report `atr_pct`'s zero-share and companion-NULL coincidence on the 2024+ window.

**Writes no production rows.** Outputs are files under the session scratchpad: `verdicts.csv`, `control.csv`, `REPORT.md`.
