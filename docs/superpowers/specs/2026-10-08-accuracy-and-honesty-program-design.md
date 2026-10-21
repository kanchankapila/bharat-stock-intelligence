# Accuracy and honesty program: design

Date 2026-10-08. Status: awaiting review. Source evidence: `docs/expert-review-2026-10-08.md`, ledger rows
AF-20261008-11..28, `.claude/rules/measurement.md` (2026-10-08 entry).

## 1. Intent

Make every number the platform shows true and labelled, every score measured against real outcomes, and let the
scoring improve only where evidence allows. Success is **honest, calibrated and measured**, not a promised hit rate.
The measured edge today is a rank IC of about 0.05 over one falling-tape window of 40 sessions, with no closed forward
window; the frozen forward test cannot reach 20 independent 5-day windows before 2027-02-26. "Highly accurate" is a
claim this program tests, not one it assumes.

**Authority granted (2026-10-08):** code, commits by explicit path, frontend build, `pm2 restart bharat-server`, live
verification. **Not granted:** production data writes or deletes, migrations, DROPs, file or table deletions, pausing jobs.
Every item below that needs one of those is marked NEEDS-APPROVAL and is prepared as a reviewed script or proposal, not run.

**Invariants (from the repo's rules):** no score, weight, threshold or classification changes without a cost-aware
measurement (EVIDENCE); the frozen forward-test protocol (hash `13210b4e2c3ae688`) is never edited; no parallel final
score; no fifth signal table; every fix ships a regression test shown failing first; commit by explicit path only.

## 2. Sub-projects and order

Each is independently shippable and gets its own plan task list. Order is by dependency: land what exists, make the data
true, build the instrument that can prove anything, then build on it.

### A. Land what is done
Commit the working-tree fixes of 2026-10-08 by explicit path (three logical commits: data and writers, routers and DQ checks,
frontend and docs), build the frontend, restart `bharat-server`, and verify each change live.
- Acceptance: `tsc`, full `vitest`, full `pytest` (backend-python venv) green on the final tree; `findings:check` and
  `doc:numbers:check` pass; live queries confirm (1) `getBuyRecommendations` joins the latest complete signal day, (2) Alpha
  shows plan status, classification, horizon, the disclosure strip and "Ranker date", (3) the new DQ checks report, (4) the
  Python writers skip a non-trading day on the next closed day.
- Rollback: `git revert` per commit; restart again.

### B. Data truth (code only)
Fix the remaining defects that are code, and prepare the data repairs as reviewed scripts.
1. Regime detector: compute the 5-day macro returns from closes instead of `fillna(0)`; decouple the HMM retrain from the DL
   retrain; stamp `backfilled` in code paths that write regime rows. (Changes labels, so it ships **behind an `app_settings`
   flag defaulting OFF**, with a replay report; enabling it is a later EVIDENCE decision.)
2. ROE coverage: let `quantScoringService.loadFundamentals` read the investsights-backed history (Pearson 0.96) as a
   COALESCE fallback, also behind a default-OFF flag, with the measured +0.003 quality-gate effect recorded as the baseline.
3. Pre-open writers: add the 09:00-09:20 IST window guard; unify `INDIA_VIX` / `INDIAVIX` reads in one helper without
   changing stored names.
4. Repair scripts (NEEDS-APPROVAL to run): countdown and shocker recompute, mis-attributed `eps_surprise_history` rows,
   phantom non-trading-day rows, analyst look-ahead rows, regime `backfilled` flag. Each is a dry-run-by-default script that
   prints a diff count, requires `--apply`, and refuses without a fresh `pg_dump -t` path argument.
- Acceptance: each script has a test on a throwaway schema that fails before the logic exists; flags default OFF and a test
  proves OFF is bit-identical to today.

### C. Measurement spine (no schema change)
The instrument that can prove or disprove anything else.
1. **Shadow arms recomputed at grading time** from the append-only `unified_recommendations_history` columns, so no migration
   is needed: published, plain re-blend, re-blend + vol veto, re-blend without `ml`, and a seeded random-matched control. A
   sibling of `forward_test_report.py` that imports its grading functions and never touches `PROTOCOL`.
2. **Scorecard job** (weekly and monthly), registered like the existing jobs: per tier, per horizon, per liquidity bucket
   (Rs 10cr and Rs 50cr), per *objective* regime (index vs 200-day mean and breadth, not the HMM), with n, independent windows,
   hit rate and lift with CI, net expectancy, payoff ratio, drawdown, turnover and a reliability curve with Brier score against
   the base rate. LOW-DATA below 20 independent windows.
3. **Alerts:** published-tier lift CI includes zero for 3 consecutive weekly runs after the window floor; Brier worse than the
   base rate; top-decile dispersion collapse; an engine's rolling IC changes sign; any ranker input's non-null share or
   distinct-value count collapses (the countdown class).
4. **Grade `bharat_alpha`** under the same frozen rules plus a shuffled-score negative control (t-statistic under 1).
5. **One definition of "win"** exposed through one helper; the Dashboard, report cards and Telegram read it. The frozen forward
   test is the arbiter.
6. **Survivorship-reduced and ISIN-continuous loader** for `factor_backtest.py` (the survivorship result was small, so this is
   hygiene, not a blocker).
- Acceptance: negative-control tests (shuffled control reads lift near zero; an injected duplicated-countdown column trips the
  collapse alert); scorecard snapshot written to `app_settings` (a code-path write the existing jobs already perform) and
  watched by a freshness check.

### D. Honest product surface
Everything additive and display-only, in the routed v1 tree (confirm each component is imported by a route before editing).
- A **"no call" state** when the published tier shows no usable spread or the scorecard is LOW-DATA; the page then says so and
  shows the ranking as a watch-list.
- What-changed-since-yesterday, reliability curve and score-decile chart, forward-test view (hash and calendar-blocked note),
  plan lifecycle timeline, signed score decomposition (weight x (engine - 50)), market-pulse strip, sector-rotation chart from the
  unused `getSectorRotationHistory`, F&O build-up table, earnings chips on pick cards, a11y and mobile pass, as-of lines on the
  data pages, polling aligned to data cadence, and the stale `Stock Intelligence` "composite / % confidence" labels.
- Dead components, duplicate nav entries: removals are listed for you (NEEDS-APPROVAL, not done by default).
- Acceptance: every number on a touched page shows source, units, as-of and n; component tests for the disclosure and
  expiry tags; server-query tests where a query changed.

### E. Accuracy levers, evidence-gated and shadow-only
Hypotheses with a mechanism, built as shadow arms in C and promoted only by evidence. Nothing here changes the live score.
1. Rank-buffer (hysteresis) turnover control: hold a name until it falls below rank N+k.
2. Beta-neutral expression of the ranking (long top decile, hedge ratio from 60d beta) reported beside the long-only book.
3. Objective regime conditioner replacing the HMM in by-regime splits.
4. Earnings-window **risk** flag (size down / avoid new entries), not a direction factor.
5. Drop-one of confluence's own-momentum slot; `ml` removal from the blend; overlays one at a time.
- Promotion rule: a lever goes live only if, on the forward test at >= 20 independent windows (2027-02-26 for 5d) or a
  cost-aware multi-regime replay where one is reconstructible, it improves net top-decile excess by more than 1 standard
  error with the shuffled control near zero. Until then it is disclosed as "tested, not adopted".
- Multiple testing: every lever and its outcome is recorded in a hypothesis register (a section of `measurement.md`), and
  results are reported against the count of looks.

### F. Simplify (proposals; NEEDS-APPROVAL for each action)
Prepare, don't execute: the list of zero-weight compute to pause (about 45 job-hours a month), dead code, write-only tables
with their per-table reader check, and the TALA/v1 overlap. Each step carries risk, rollback and an acceptance criterion
(see section 3 of the expert review).

### G. Data-source review for accuracy
A read-only review of what additional or better data could raise honest accuracy, run before building anything that needs it.
RULE ZERO first (what is already in the database), then the endpoint registry and catalog, then a handful of minimal-header
probes. Output: a ranked table (gap, existing data, endpoints, history depth, point-in-time safety, expected information beyond
volatility/size/momentum/beta, effort, verdict). The review is running now (`audit_G_data_gaps.md` in the session scratchpad)
and its BUILD-NOW items are appended to this spec before the plan is written. Principle: more data is not more edge; the
platform's own record is about 16 independent signals in 196 columns, so each candidate must show information beyond the
existing factors on a panel deep enough to test, ideally one that spans bull and bear regimes (2021-2026 price, delivery and
F&O bhavcopy history already exist; the ranker's engine inputs do not before 2026-08-10).

> **Correction 2026-10-21.** The parenthetical above is true of the 8-engine blend but reads as "no deep panel is possible", and it
> closed off the only path to significance before 2027. Measured 2026-10-19: of 104 numeric `feature_store` columns, 59 are >=60%
> populated back to 2021 (labels included), over 2.73M rows (248 dates / 1,698 symbols in 2021, 199 / 2,431 in 2026), which supports
> ~287 independent windows at h=5 and ~68 at h=21. The deep panel is gradeable; see `.claude/rules/measurement.md`, 2026-10-21.

## 3. Testing and verification strategy
- Test-first for every behaviour change; show the test failing on the unfixed code; vitest unit project uses the throwaway
  schema, pytest uses `pg_conn` / `pg_memory_conn`, and tests run against an EMPTY database before they are believed.
- After each sub-project: `tsc`, full `vitest`, full `pytest` (backend-python venv), `findings:check`, `doc:numbers:check`,
  then a live read-only query-back (the repo's rule: a green suite does not show the right rows were written).
- Ledger rows are updated in the same session as the fix; EVIDENCE rows keep their unblock dates.

## 4. Risks
- A rate limit stopped two agent runs today; long agent tasks must write their report first and refine after.
- Several tests touch live Postgres by design; the unit project must stay on the private schema.
- Restarting `bharat-server` interrupts the API for a few seconds and drops WebSocket clients; do it outside market hours.
- The shadow arms approximate the ranker's overlays from stored columns (reconstruction correlates 0.5-0.64 with the stored
  score). They are for ranking the levers, not for reporting a precise effect size.

## 5. Out of scope
Any live score, weight, veto or threshold change before its evidence; new engines or signal tables; deleting tables or files;
production data repair; migrations; a third frontend.

## 6. Data-source review results (sub-project G, read-only, 2026-10-08)

Report: `audit_G_data_gaps.md` (session scratchpad). Verdict: **the best next step needs no new vendor.** [Likely]

**Already in the database, unused or under-used** [Certain]: `nse_universe_history` has delivery % for 3,995 symbols since 2021
(`stock_delivery_data` starts 2025-06); `dalalos_financial_trends_history` has 26 quarters for 1,206 symbols (used with a fixed lag
because it has no filing date); `mc_estimates_hits_misses` (2021-12 to 2025-09) and `investsights_pe_band_history` have no reader;
1,214 bhavcopy symbols are missing from `stock_ohlcv` (218 averaging Rs10cr+/day; many are renames).

**Probed, returns dated history** [Certain] (NSE needs a browser user-agent; bare requests drop): the results-filings API
(broadcast timestamp and XBRL link per filing), old-format F&O bhavcopy (62k stock-option rows/day in 2022), the shareholding master
(20 quarters with submission and broadcast dates), the market-wide insider (PIT) API with disclosure timestamps, participant OI
(2021), daily price-band files and the delisted list. **No free history** for analyst revisions, bid-ask spreads, index
constituents or ASM/GSM lists. NiftyTrader per-stock IV starts 2025-07.

**Skip** as ranker inputs: news, macro and global series, index-constituent and ASM history, more futures OI/basis/PCR history,
vendor scores and screeners (all null or untestable in the record).

### What this changes in the plan
1. **New sub-project H, "multi-regime replay panel" (read-only, file-based, no DB write):** rebuild 2021-2026 point-in-time inputs
   for the ranker's price, delivery and fundamentals engines from existing tables (bhavcopy incl. delivery %, survivorship-reduced and
   corporate-action checked), stored as a parquet file under the scratchpad/data directory, then replay the ranking across bull and bear
   regimes. This answers the main open question: is IC ~0.05 only a falling-tape artifact? It also turns E's levers from
   "calendar-blocked to 2027" into testable now where an input is reconstructible. Engines that cannot be reconstructed
   (confluence ML, screeners) are reported as untestable, not assumed.
2. **Cost and capacity model by turnover bucket** from bhavcopy, plus a circuit-limit filter. Adds no IC; it decides whether any IC is
   tradeable. Built in C's scorecard.
3. **Filing-date backfill, options backfill (2021-2024), shareholding and disclosure-dated insider backfills** are database writes
   plus external requests. They are **NEEDS-APPROVAL and not part of the authorised scope**; the plan prepares dry-run fetch scripts
   and a request budget only. Pre-registered hypotheses if approved: growth / earnings surprise / Piotroski over about 20 results
   seasons, implied-minus-realised volatility, put-call skew (two signals only, to limit multiple testing). Expect nulls.
4. Analyst revisions can only be collected going forward; start a forward collector only with approval.
