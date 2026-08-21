# Accuracy Overhaul — Implementation Prompt

**Status:** proposal, not yet started. Written 2026-08-21 from a code review conducted on the
macOS dev checkout (no DB, no test runner — see `/memories/repo/dev-vs-prod-machine.md`). **Every
measured claim below is quoted from `.claude/rules/measurement.md` or read directly out of the
source; none of it was re-run for this document.** Re-verify before acting (W0).

---

## Mission

The platform's canonical ranker has no demonstrated forward-return edge (`unified_score` 5d rank
IC ≈ 0.0001, t=0.02). This plan does **not** try to fix that by reweighting — `measurement.md`
says explicitly that reweighting is very likely the wrong fix, and that combining reduced
performance in every case tested. It fixes the *structural* reasons the current architecture
cannot express an edge even if one exists:

1. the ML label does not match the population or the objective the score is used for,
2. eight correlated engines are blended on raw, non-stationary scales with ~80 hand-set constants,
3. the largest weight in the blend sits on the one component measured significantly negative,
4. weak signals are never converted to realized return because nothing is turnover/cost aware.

**The success criterion is not "IC goes up." It is "every number in `measurement.md` that this
work touches is re-measured honestly and recorded, whichever way it comes out."** A null result
is exactly as valuable as a positive one — this repo has retracted several confident wrong numbers
and the retraction discipline is the point.

---

## Mission addendum — the rebuild already exists, and it has already answered part of this

`greenfield/` is not a sketch. All seven packages are scaffolded (~100 TS files) and Stage 5 is
substantially built: `stage5/ranker.ts`, `promotion-gate.ts`, `divergence.ts`,
`run-measurement-baseline-net.ts`, `record-shadow-preregistration.ts`. `apps/{api,web,worker}`
are still stubs.

**Read `docs/BUILD_STAGE_5_SPEC.md` §0–§3 and `greenfield/packages/ingestion/src/stage5/ranker.ts`
before starting anything below.** Several items in this plan are already solved there, better than
this document proposed:

| This plan's item | Greenfield status |
|---|---|
| W4 — engines carry hand-set weights; `max(0.0, v)` cannot express a negative loading | **Solved.** `selectSurvivingFactors()` derives weights from recorded `factor_net_tstat.*` evidence, weight = \|t\|, and `direction: 1 \| -1` **can rank a significantly negative factor the other way round**. Spec invariant 11. |
| W8 — turnover/cost awareness | **Solved.** Task 5.0.1 deducts round-trip cost against **measured** top-K set overlap between rebalance dates, not an assumed constant, with negative-controlled unit tests at 0% and 100% turnover. |
| Multiple-testing burden | **Solved.** Task 5.0.2 applies a Bonferroni bar across 12 factors × 2 horizons, critical t ≈ 3.08, computed rather than hand-estimated. |
| Pre-registered forward track | **Built.** `record-shadow-preregistration.ts`; invariants 12–13 (`is_publishable = false` throughout; shadow length preregistered in `audit_metric` and never shortened); invariant 15 (promotion is a script's exit code, not prose). |
| Honest null state | **Solved.** Zero of 24 factor × horizon combinations cleared the bar, so `buildRankerSpec` returns the null ranker with `unvalidated: true`, carried into `model_version.metrics` and every `recommendation.breakdown`. |

**The single most important fact for anyone acting on this plan:** greenfield reached the *same
terminal finding as the legacy system* — no factor survives cost-adjusted, multiple-testing-
corrected significance. Stage 4's gross numbers looked strong (`delivery_pct` t=15.67/18.69,
`div_yield_ttm` t=10.13/13.47); net of costs and corrected, none survived.

⚠ **Do not state that as "two independent systems agreeing" without qualifying it — an earlier
draft of this document did, and it was an overclaim.** Greenfield's Stage 3 includes seven
**transfer** scripts that copy from the legacy database rather than re-fetching
(`transfer-fundamentals`, `-analyst-estimates`, `-corporate-actions`, `-insider-activity`,
`-screener-definitions`, `-screener-membership`, `-fii-dii`). The corroboration is therefore
split:

| Greenfield factor | Source | Independent of legacy? |
|---|---|---|
| `momentum_21d`, `momentum_63d`, `delivery_pct`, `delivery_pct_ma20` | `nse/bhavcopy.ts`, fetched by greenfield itself | **Yes** — genuine corroboration, and it covers the most important case: `delivery_pct` looked strongest gross in both systems (legacy t=+7.82, greenfield t=15.67/18.69) and died net of costs in both |
| `pe_pct_rank_252d`, `pb_pct_rank_252d`, `eps_ttm`, `eps_growth_yoy`, `div_yield_ttm` | `transfer-fundamentals` | **No** — same rows as legacy, inherits any corruption. Agreement here is not evidence. |
| `fii_net_21d`, `dii_net_21d` | both a live `fii-dii.ts` and a `transfer-fii-dii.ts` exist | **Unresolved** — determine which populated the measured panel before citing these |
| `screener_breadth` | `transfer-screener-membership` | n/a — 0% coverage, ~1 day of history, excluded |

**Consequence: do not expect W1–W8 to reverse the null.** Their value is making today's live
output honest and making the legacy architecture *capable* of expressing an edge, not producing
one. Anything in this plan that greenfield has already solved should be built in greenfield, not
back-ported to the legacy system.

### Source coverage — greenfield is NOT a superset of legacy, and is not close

Measured 2026-08-21:

| | Greenfield | Legacy |
|---|---|---|
| Live provider adapters | **6** — `nse/` (bhavcopy, security-master), `stage3/` (et-stats, investsights, kayal, marketsmojo-financials, fii-dii) | **76** `*fetcher*.py` files; **147** `runPython` call sites in `queues.ts` |
| One-time DB transfers | 7 (above) | n/a |
| Factors measured | 12 | 26 `FACTORS` + 23 `feature_store` columns + 1,563 screeners |

**~8% of sources are onboarded, and that is the correct prioritisation, not a gap to close now.**
The spec is explicitly sized for a zero-survivor outcome, and W11 says the binding constraint is
calendar depth rather than source breadth. Onboarding the remaining 70 fetchers before the shadow
track returns a verdict would be spending effort on the one axis the data says is not binding.
**Do not treat this table as a backlog.**

### Routing — where each item goes

| Item | Build in | Why |
|---|---|---|
| **P0** shadow forward track | **Greenfield** | Already built. Calendar-bound, so it is the long pole on every other decision. |
| W0, W2(B), W1, W3, W5 | **Legacy** | Small, reversible diffs against the only system holding real history (5y panel, 267,976 graded outcomes, `unified_recommendations_history`). |
| W4 (engine pruning) | **Legacy, weight-zero only** | Legacy cannot express a negative loading. Set weights to 0; do not attempt to rebuild the weighting mechanism there — greenfield already has the evidence-derived version. |
| W8 (turnover/cost) | **Greenfield** | Already done there, correctly. Do not reimplement in legacy. |
| W6 (learned ranker), W7 (meta-labeling) | **Greenfield** | `stage5/ranker.ts` is the seam. Building these in legacy means building them twice. |
| W9 (`knowable_at`) | **Greenfield only** | Not retrofittable at acceptable risk — 200+ tables, compressed hypertables. Greenfield's canonical zone is bitemporal by design. **Do not attempt this in legacy.** |
| W10, W11 | Both | Hygiene / policy. |

**Freeze the legacy system to corrective work only.** No new features, no new fetchers, no new
engines. Every addition widens the migration surface and the maintenance surface that
`recurring-bugs.md` shows is already the dominant failure mode.

---

## P0. Start the pre-registered forward track — **[PROD]**, do this before any code change

**Bucket: highest priority. Calendar-bound, so every day of delay delays every downstream
decision by a day.**

After this many measurement passes over the same 5-year panel, the panel is contaminated by
researcher degrees of freedom and the accumulated multiple-testing burden is unquantified.
**Forward, out-of-sample, pre-registered performance is the only uncontaminated evidence still
available.** It is also the deciding input for both open questions — whether the corrections below
helped, and whether greenfield should take over.

1. Run `record-shadow-preregistration.ts` and confirm the preregistered shadow window is recorded
   in `audit_metric`. Per spec invariant 13 it may be **lengthened** if too few pre-market dates
   accumulate, and **never shortened** after seeing favourable results.
2. Record predictions forward from **both** systems — greenfield's shadow ranker and the legacy
   `unified_recommendations_history` — on the same dates, so they are directly comparable.
3. Grade with the panel spec (§0.4), per-date, next-open entry, `is_suspect` filtered, ≥₹1cr ADT.
4. Anchor legacy provenance on `created_at`, and restrict to rows provably written before the
   entry open. `unified_recommendations` re-runs overwrite their own key; the append-only history
   table exists for exactly this.
5. **Believe nothing until ~30+ non-overlapping pre-market dates have accumulated.** That is a
   calendar constraint, not an engineering one, and it cannot be shortened.

**This is also the kill criterion.** If the shadow track shows no edge after the preregistered
window, the finding is that this data does not support a daily cross-sectional strategy at these
horizons and costs — and that is a legitimate, valuable, publishable-internally result. Record it
and stop, rather than starting a fourth rewrite.

### P0.1 — How greenfield's accuracy is calculated: run the gate, read the exit code

**Do not compute this by hand, and do not accept a narrative summary of it.** Spec invariant 15:
*"a promotion decision is made by a script whose exit code is the decision, not by prose in a
report."* That invariant exists because this project's history is full of reweighting merged on a
green suite and a "looks good."

```
record-shadow-preregistration.ts   # ONCE, before the first shadow run
run-ranker.ts                      # daily — writes recommendation rows, is_publishable = false
run-divergence-analysis.ts         # daily — feeds the Task 5.3 monitors
promotion-gate.ts                  # the decision. exit 0 = promote, exit 1 = do not.
```

`evaluate-promotion-gate.ts` is the pure-evaluation half (DB reads only, no write — safe to
import and negative-control from a test). Four checks, **fail-closed on the first unmet
condition**:

1. **`min-dates-accumulated`** — pre-market shadow sessions counted via `queryShadowProgress`
   against the `recommendation` table, against `min_dates` preregistered in `audit_metric`. Never
   a manual count. Refuses to evaluate at all if nothing was preregistered.
2. **`live-shadow-significance`** — the shadow ranker's **own realized forward-return IC** and
   net annualized excess return, re-measured live from `queryShadowScoreSeries` +
   `queryOpenPriceSeries` at **top-50 / 25bps / 5d rebalance**, against the recorded
   `bonferroni_critical_t` (≈3.08). It **never re-quotes Task 5.0's backtest number**. 21d is
   computed and reported for transparency but **never gated on** — accepting "either horizon
   clears" would be an undisclosed second multiple-comparison the Bonferroni bar was never sized
   for.
3. **Divergence monitors** — `shadow-rank-variance` and `dual-run-divergence-sane` must never
   have raised a fail-severity result *since preregistration*, not merely on the latest reading.
4. **DQ and publishability** — `queryDqResultFailCountSince`, and
   `queryAnyPublishableRecommendationExists` confirming nothing was published early.

**Note what the metric deliberately is NOT: win rate / accuracy-%.** Per §0.4, win rate is
dominated by `label_definition` (41–44% vs 88–91% on the identical window). IC and net-of-cost
excess return are the correct metrics and are what the gate uses.

**⚠ Read this before quoting any shadow number: the shadow ranker is currently the NULL ranker.**
Zero of 24 factor × horizon combinations cleared the bar, so `buildRankerSpec()` returns
`variant: 'null'` with `unvalidated: true`, sorting on `momentum_63d` alone. Anything the shadow
track measures today is **the forward accuracy of `momentum_63d` as a single unvalidated
placeholder** — a legitimate baseline, and explicitly not "the model's accuracy." The gate is
expected to fail on the first attempt; per the spec that is the correct outcome, not something to
debug around, and the bar must not be lowered in reaction to it (invariant: a threshold change is
a new decision made *before* the next attempt).

---

## 0. Ground rules — read before writing any code

### 0.1 Required reading, in this order

- `fable-brain.md` (project root) — standing reasoning discipline.
- `.claude/rules/measurement.md` — **the whole file.** Every claim in this plan traces to it.
- `.claude/rules/recurring-bugs.md` — skim before writing any Python or SQL.
- `.claude/rules/scoring-authority.md` — you are touching the canonical ranker.
- `CLAUDE.md` — Definition of done, Conventions, Architecture facts.

### 0.2 Which machine you are on

Confirm first. The macOS checkout has **no Postgres on :5433, no pm2, no venv, no `tsc`, no
`vitest`, no `pandas`/`psycopg2`**. On that machine you may write and `py_compile` code and you
**must state explicitly that nothing was verified**. Do not present a `py_compile` pass as
verification. Production is the Windows/WSL2 box.

Anything in this plan marked **[PROD]** cannot be started from the dev Mac at all.

### 0.3 Definition of done — per CLAUDE.md, non-negotiable

```bash
npx tsc --noEmit                                    # any .ts change
npx vitest run                                      # any .ts logic change
python -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/   # any .py change
npm run schema:drift                                # any migration
```

Plus, for **every** item in this plan (all of them touch signal/scoring/model logic):

- **Negative-control every new test.** Revert the change, confirm the new test fails, restore.
  A green suite that never failed against the bug protects nothing.
- **`verify-gate.mjs` will demand backtest evidence.** Any diff to `unified_ranker.py`,
  `scoring_engine.py`, `factor_backtest.py`, `multi_factor_scorer.py`,
  `institutional_quant_engine.py` or `quantScoringService.ts` requires either a real
  `factor_backtest.py` run or a same-session edit to `measurement.md` /
  `measurement-history.md`. Do not attempt to satisfy this with an unrelated run — see
  `recurring-bugs.md`'s "fabricated backtest" entry. If a change genuinely cannot be measured by
  `factor_backtest.py`, say so **and say why** in `measurement.md`, following the existing
  `_log_recommendations` / `seed_screener_catalog` entries as the template.
- **Run it against live production and query the result back.** `tsc --noEmit` and a green suite
  do not tell you a job wrote the right rows.
- **Committed ≠ deployed.** `.ts` needs `pm2 restart bharat-server`; a migration needs
  `npm run migrate:up` against the real `POSTGRES_URL`.

### 0.4 The panel spec — use it verbatim for every measurement in this plan

From `measurement.md`. Deviating from any line of this invalidates the result:

- **Per-date, then average. Never pooled.** Pooling has flipped or inflated a conclusion three
  separate times in this repo.
- **Winsorise**, and use `quantile(pct, interpolation="higher")` / `quantile(1-pct,
  interpolation="lower")` — the default linear interpolation does **not** clip a lone outlier
  (`recurring-bugs.md`).
- **Filter `is_suspect = 1`.**
- **Liquidity floor ≥ ₹1cr ADT.**
- **Next-day OPEN entry.** A signal computed off a close cannot be bought at that close.
- **Check `label_definition`** before comparing any two win rates (`terminal_pct2` vs
  `path_barrier` gave 41–44% vs 88–91% on the same window).
- **Check `signal_source`** before joining `signal_outcomes` — three writers share that table.
- **Anchor provenance on `created_at`, not `signal_generated_at`.**
- **Judge coverage by dates PER SYMBOL and by the DENSE span**, never raw `min(date)` /
  `count(DISTINCT date)`.

### 0.5 Constraints that bound this work

- **Do not add a fifth signal table.** The ceiling is `unified_signals`, `technical_signals`,
  `signal_outcomes`, `unified_signal_outcomes`.
- **Do not create a fourth score producer.** Canonical is `unified_recommendations` from
  `unified_ranker.py`; `stock_scores` and `quant_scores` are its inputs. New work writes a
  *component* the ranker ingests, never a parallel "final" score.
- **Postgres/TimescaleDB is the only database.** Several tables are compressed hypertables where
  a predicate-wide `UPDATE` / `ADD CONSTRAINT` will fail or destroy compression.
- Commit **by explicit path**, never `git add -A`. Multiple sessions edit this repo concurrently.
- Do not add comments unless the WHY is non-obvious. Do not refactor beyond the task.

---

## W0. Re-verify the ground truth before acting on anything below — **[PROD]**

This document is a claim with a date on it. The code is the authority. Before starting:

1. `git rev-parse HEAD` vs `graphify-out/GRAPH_REPORT.md`'s freshness hash.
2. Re-read `REGIME_WEIGHTS` and `_classify` in `unified_ranker.py` and `load_training_data` in
   `ml_ensemble.py` — confirm the shapes described in W1–W5 still exist.
3. Query `factor_edge_history` for the current verdict and `dates` count of **every** engine
   score column (`screener_stock_score`, `ml_score`, `cs_score`, `confluence_score`,
   `technical_score`, `dl_score`, `breakout_score`, `smart_money_score`). W4's engine-pruning
   table is written against `measurement.md`'s verdicts as of 2026-08-18/19; if any has since
   cleared `LOW-DATA` or flipped, **W4 changes accordingly and this document is wrong**.
4. Confirm the live `Sell:Buy` ratio and `_report_buy_floor_selectivity`'s current reading, so
   you have a before-picture for W3/W4.

Record all four in the session log before any edit.

---

## Phase 1 — the label and the population (highest expected lift, self-contained)

### W1. Relabel the ML target to per-date cross-sectional forward return

**Bucket: safe to implement, requires a full retrain + backtest to accept.**

**Problem.** `ml_ensemble.load_training_data()` labels on
`so.outcome IN ('WIN','LOSS','STOP_LOSS')` — a pooled binary classification. Most of the variance
in "did this go up" is the **day effect** (market direction), which the entry rule never
monetizes and which the panel spec explicitly averages away. The model spends capacity predicting
the tape, not relative performance. Meanwhile the output (`win_probability`) is consumed and
graded **cross-sectionally**, so training and evaluation disagree about what the model is for.

**Change.**

1. Add a third `label` mode to `load_training_data()` — `label='cs_rank'` — alongside the
   existing `'horizon'` and `'triple_barrier'`. Do not remove either existing mode; they must
   remain runnable for comparison.
2. The `cs_rank` label is the **per-date cross-sectionally demeaned (or ranked) forward return**
   over `horizon_days`, computed within each `signal_date` across the liquid universe, after the
   panel spec's winsorisation and `is_suspect` filter.
3. Train with a ranking objective grouped by date — `LGBMRanker` with `group=` the per-date row
   counts, or regression on the demeaned return. Rows **must** be sorted by `signal_date` before
   grouping; a shuffled group array silently trains on garbage.
4. Keep `TimeSeriesSplit(gap=embargo)` and the `average_uniqueness` sample weights exactly as
   they are — both are correct and both address biases this change does not.
5. `CalibratedClassifierCV` is meaningless for a ranker. If the model becomes a ranker, the
   calibration layer must be **removed for that mode**, not silently fed a ranker — and
   `ml_calibration.py`'s isotonic fit and the `calibrated_win_probability` column must be left
   alone for the classifier path. Do not let the two modes write the same column.

**Traps specific to this change (all are documented recurring classes):**

- `cv=` as an **int** anywhere inside a time-series harness silently means `StratifiedKFold` and
  shuffles time order. `_base_models` already takes `cv` as a required keyword — keep it that way.
- A test that derives its expectation from the constant it tests passes vacuously.
- `float(x or 0)` on a model output: **NaN is truthy**. Use `math.isfinite` and *skip*, never
  coerce to 0.
- `ORDER BY col DESC` on a column that can be NaN ranks NaN **first** in Postgres.

**Verification.**

- New tests in the Python suite covering: the label is demeaned to ~0 mean per date; the group
  array sums to `len(X)`; rows are date-sorted before grouping; a deliberately shuffled input
  fails. Negative-control all of them.
- **[PROD]** Retrain under `label='cs_rank'`, score a held-out period, and grade the output with
  the full panel spec at h=1 (non-overlapping) and h=5, against the incumbent `'horizon'` label
  measured the identical way. Report both.
- Record the comparison in `measurement.md` under a new subsection, with the honest caveats
  (h=5 windows overlap → t-stats optimistic; date count).

**Acceptance.** Ship `cs_rank` as the default **only if** it beats the incumbent label at h=1 on
a like-for-like measurement. If it does not, keep it available, record the null result, and stop.
Do not ship it because it is theoretically better.

---

### W2. Fix the train/serve population mismatch

**Bucket: safe to implement. Decide the direction before writing code.**

**Problem.** `load_training_data()` filters `so.signal_source = 'technical'`, so the model learns
`P(win | the technical scanner already fired)`. `win_probability` is then applied **universe-wide**
by `scoring_engine`'s `ml_alignment_points` (Factor 3, 0–20 pts) and graded universe-wide. That is
a selection-biased sample scored on a different population — a leading candidate explanation for
IC ≈ 0.

Note the `signal_source` filter itself is **correct and must stay**: without it a
confluence-sourced outcome sharing `(symbol, signal_date)` with an unrelated `technical_signals`
row would be trained on as if it graded that signal. The bug is not the filter; it is that
nothing downstream respects the same restriction.

**Two mutually exclusive fixes — pick one, in writing, before coding:**

- **(A) Widen training to the full panel.** Label every liquid symbol × date with a forward
  return (not just rows where a signal fired), keeping the technical feature join. Training and
  serving populations then match. Costs: a much larger training matrix, and the label is no
  longer a graded signal outcome.
- **(B) Narrow serving to the signal population.** `scoring_engine` and `unified_ranker` consume
  `win_probability` **only** for symbols that have a technical signal on that date, and treat it
  as genuinely absent otherwise — `None`, not `0.0`. See `recurring-bugs.md`'s null-vs-zero entry:
  five of eight reporting columns in `unified_ranker.py:2271-2275` already write a literal `0.0`
  where three siblings correctly write `None`, which makes a collapse invisible.

**(B) is the smaller, safer change and I recommend starting there.** (A) is the better long-term
answer and pairs naturally with W1, but it is a much larger diff.

**Verification.** **[PROD]** Measure `win_probability`'s h=1 IC on the population it is actually
served to, before and after. Under (B) coverage will fall — report the coverage number alongside
the IC, or the comparison is meaningless.

---

## Phase 2 — the blend (do after Phase 1, before Phase 3)

### W3. Per-date cross-sectional normalisation of every engine input

**Bucket: safe to implement. This is not a tuning change — do not let it become one.**

**Problem.** Engine scores enter `REGIME_WEIGHTS` on their own raw, arbitrary, **non-stationary**
scales. `unified_ranker.py`'s own comment records the consequence: the same absolute
`DIRECTIONLESS_BUY_FLOOR` selected 15.6% of the universe on 2026-08-09 and 1.2% on 08-10 — a 13×
swing caused entirely by two unrelated and *correct* engine fixes (LSTM v4→v3 rollback,
`dl_score` avg 78.5→28.1; `_get_ml_scores` edge adjustment, `ml_score` avg 70.8→47.9). Nothing
about the Buy rule changed; the scale moved underneath it.

The same root cause produced `factor_crowding_multiplier()` firing on **98.6% of the universe** —
a uniform ×0.9 that cannot change any ranking and whose only effect was shifting the whole
population against the absolute thresholds.

**Change.**

1. Normalise **each engine score cross-sectionally within each date** (percentile rank, or
   z-score clipped to a sane band) *before* it enters the weighted blend.
2. **Do not touch `DIRECTIONLESS_BUY_FLOOR`.** The existing decision not to recalibrate it is
   correct and well-argued: measured per-date over 30 dates, *no* score cut has significant edge
   (top-10 −0.242%/t=−0.57, top-20 +0.102%/t=0.33, top-50 −0.215%/t=−1.02, top-100 −0.001%,
   top-200 +0.160%/t=1.75 — non-monotone, with the very top negative). Any new constant or
   percentile would be a guess. This item fixes the **inputs**, which makes the floor's
   selectivity stable without anyone choosing a number.
3. Keep `_report_buy_floor_selectivity` and its `BUY_FLOOR_EXPECTED_SELECTIVITY` tripwire. After
   this change its readings should become far more stable — that stability is the acceptance
   evidence.

**Change, part 2 — degenerate inputs must fail loudly, not be discounted.** All five `mf_*`
columns in `quant_scores` were once **constants across all 2,424 symbols**, and
`drop_zero_dispersion_engines()` did not stop that from reaching the blend and moving the entire
population against the absolute thresholds. Add a **hard precondition** on every engine input:
per-date cross-sectional dispersion (std and distinct-value count) above a floor, or the engine is
excluded for that date **with a stderr line** — not silently discounted.

**Traps.**

- A gate/discount that fires on ~100% of its population carries zero information. After this
  change, measure prevalence directly:
  `count(*) FILTER (WHERE <gate fires>) / count(*)`. If any gate is still near 0% or near 100%,
  it is broken, in one direction or the other.
- `print(...)` to **stdout** is invisible: `pythonRunner.ts` only inspects **stderr** to decide
  whether an exit-0 run gets logged as degraded. Every new diagnostic here goes to
  `file=sys.stderr`.

**Verification.** **[PROD]** Re-run `unified_ranker.py`; report before/after for
`_report_buy_floor_selectivity`, the `Sell:Buy` ratio, and the crowding-gate prevalence. Confirm
the blend's *ranking* is invariant to a synthetic ×2 rescale of any single engine's raw score —
that is the property this change buys, and it is directly testable in the unit suite. Negative-
control it.

---

### W4. Prune the engine set from 8 to 4

**Bucket: needs backtest evidence per change. Do not batch all four cuts into one unmeasured
commit.**

**Problem.** The eight engines are **not independent**. `screener`, `confluence`, `breakout` and
`technical` all derive from the same underlying price + screener-membership data, so blending
them reduces variance without touching bias — and the shared source's measured direction is
negative. Additionally `_normalize_weights` clamps with `max(0.0, v)`, so **a component measured
negative cannot be given a negative weight, only shrunk toward zero.** A real inverted edge is
information the architecture cannot express.

**The table below is written against `measurement.md` as of 2026-08-18/19. W0 step 3 supersedes
it. Re-derive before acting.**

| Engine | Current weight | Proposed | Evidence |
|---|---|---|---|
| `screener` | **0.30–0.40** | **0 in the score; retain as coverage gate only** | Largest weight in the system, on the one input measured *significantly negative*: consensus IC −0.027 (t=−2.36); sentiment labels inverted (bullish−bearish = −0.11pp, t=−4.61); **0 of 1,563 individual screeners survive FDR or Bonferroni**; cleaning the labels made it *more* negative. `_classify` **already** concluded screener direction is harmful and stripped its vote (Buy under screener direction −0.440%/t=−5.14 vs +0.758%/t=+2.39 under score thresholds) — while `screener_stock_score` still supplies 30–40% of the score that `_classify` reads. **Those two decisions contradict each other.** Coverage must stay: `unified_score` ranks returns within the covered population (IC +0.0241, t=+2.36) and not outside it (−0.0150, t=−1.51). |
| `dl` | 0.072–0.12 | **remove** | No measured edge. Unstable scale (v4→v3 rollback, avg 78.5→28.1, itself the cause of the 13× selectivity swing). `flyer_classifier` is this repo's own AUC-0.81 / IC-−0.041 (t=−9.02) cautionary tale. Highest maintenance cost, lowest evidence. |
| `smart_money` | 0.05 | **0 until it clears `LOW-DATA`** | `factor_edge_history` verdict `LOW-DATA`: rank_ic +0.0671, n=275, **1 distinct date**. Closest measured analogue (`ticket_size`) is significantly *inverted*, t=−2.36. The `ENGINE_EDGE_SHRINK` infrastructure already exists to act on a real verdict — let it, rather than pre-committing 0.05. |
| `breakout` | 0.05–0.15 | **demote pending an IC / net-of-cost verdict** | Its 0.15 BULL weight is justified in-file by a **5yr OOS AUC** — in a codebase that documents AUC 0.81 alongside IC −0.041, and that has been fooled by an AUC statistic twice. `measurement.md` separately reports breakout>20d-high **inverted at 1 day**. |
| `technical` | 0.081–0.24 | **keep** | Only source that graded non-negative in live signal grading: +0.94%, 50% win at 21d, against `AI` −4.67% / 34% win over the identical window. |
| `ml` | 0.12–0.166 | **keep** | `win_probability` is the only column that has ever graded positive here (raw h=1 IC +0.0364, t=+2.58, 41 dates), with provenance now traceable via `win_probability_scored_at`. |
| `cs` | 0.05 | keep | Cross-sectional by construction — the right shape. No evidence against. |
| `confluence` | 0.12–0.166 | keep | No evidence against. |

**Procedure — one engine per commit.** For each cut: re-derive the verdict live, make the weight
change, renormalise (all five regimes must sum to exactly 1.0 — the drafted 9th `delivery` engine
left BEAR and SIDEWAYS at 0.995, catch that class), run `factor_backtest.py` / the panel-spec
grading before and after, and record the result in `measurement.md` **whichever way it comes out**.

**Expected outcome, stated in advance so it can be falsified:** removing a large-weight negative
term should *raise* measured IC. If pruning `screener` to a coverage gate does **not** improve the
measurement, that is a genuinely surprising result and must be recorded as such, not buried.

**Do not** delete the engines' producing code or their component tables in this step — set the
weight to 0 and keep writing the component score, so the decision is reversible and
`factor_edge_history` keeps accumulating evidence on it.

---

### W5. Delete `REGIME_CAT_TILT`

**Bucket: safe. Small.**

~40 hand-set multipliers across 5 regimes. The file's own comment already establishes they cannot
be fitted *or* sign-validated: **BULL and CRASH carry the most extreme multipliers (0.30, 1.50)
and have ZERO days of per-category history** (3 and 6 lifetime episodes); the 170+ HIGH_VOL /
SIDEWAYS "episodes" are day-to-day alternation, not durable regimes, so they supply no independent
samples either.

`TILT_SHRINKAGE = 0.5` was the right instinct, but halving an unmeasurable prior still leaves an
unmeasurable prior. Set the tilts to neutral and delete the table, or — if the direction is
considered economically load-bearing enough to keep — set `TILT_SHRINKAGE = 0.0` behind a single
constant with a comment pointing at this document, so re-enabling it is one edit.

**Verification.** Measure the before/after per the panel spec like any other scoring change. It
should be close to a no-op; confirm that rather than assuming it.

---

## Phase 3 — the better architecture (only after Phases 1–2 are measured)

### W6. Replace the hand-set blend with a single learned ranker

**Bucket: large. Do not start until W1–W5 are landed and measured.**

`REGIME_WEIGHTS` is a hand-set linear combination of eight opaque scalars — ~40 constants, none
individually validatable, each engine having already discarded its features before the blend sees
it. Replace it with **one `LGBMRanker` over the union of raw features**, `group=date`, target =
W1's per-date demeaned forward return. The 8 engine scores become *features*, not weighted votes.

This buys three things the current design cannot have: evidence-based combination instead of
constants; the ability to express a **negative** loading; and learned regime interactions instead
of five hardcoded weight vectors.

Constraints: it writes `unified_recommendations` as before — this is **not** a new score producer.
It must ship behind a flag with the existing blend runnable for comparison, and it must beat the
pruned blend from W4 on the panel spec at h=1 before becoming default.

---

### W7. Meta-labeling — the highest-value model not currently being built

**Bucket: new model. Self-contained. Can be built in parallel with W6.**

Given IC ≈ 0, the honest read is that the primary direction signal is weak on this data and may
always be. López de Prado's answer to exactly that situation: keep the primary model for
**direction**, and train a **secondary model that only decides take / skip**.

This fits this platform specifically:

- It is a much easier problem than direction.
- It is what you have the most labeled data for — **267,976 backfilled `signal_outcomes` rows**.
- The machinery is already familiar: `ml_ensemble.py` already implements `average_uniqueness` for
  overlapping labels.

**Build.** Primary = the technical scanner (the one source that grades non-negative). Secondary =
a binary "will this specific signal resolve WIN" model over the technical scanner's *own* signals.
Objective is **precision**, and coverage is allowed to collapse to a handful of names per day —
being right 55% of the time on 15 names beats 50.1% on 2,400.

**Non-negotiable for this item:**

- Filter `signal_source = 'technical'` (three writers share `signal_outcomes`) and check
  `label_definition` — `terminal_pct2` and `path_barrier` are **not** comparable.
- The secondary model must **not** be trained on outcomes that its own primary signals'
  calibration was fitted on. Keep `TimeSeriesSplit(gap=embargo)` and `average_uniqueness`.
- It writes a **component** consumed by `unified_ranker.py`, not a parallel final score, and not a
  fifth signal table.
- Grade it with the panel spec, per-date, next-open entry, before it influences anything live.

---

### W7.1. State-conditional specialists instead of a universal daily ranker

**Bucket: research direction. Build in greenfield. Pairs with W7.**

Every universal, everything-every-day construction on this platform has measured null. The **one**
thing that did not is state-conditional and rare: the capitulation triple in
`screener_combo_finder.py --tier1` / `live_capitulation_screener.py` — `gap_down` AND
`open_eq_low` AND `top_loser`, next-session open→close.

Reproduced live 2026-08-13 under `/measurement-integrity-review`: 425 days / 651 signal-rows,
spread **+0.53%/day net of 15bps, t=+3.61, p=0.0003**, clearing a 41-combination Bonferroni bar.
Robust — winsorising at 1/2/5% *strengthens* it (t 3.69–3.94), dropping the 3 most extreme days
still gives t=3.25. **6/6 years positive**, 3 of 6 individually significant.

This does **not** contradict `measurement.md`'s significantly-negative `gap_down` row: those
rank-and-hold the top-K gapped names for a 21d rebalance and eat ~90% turnover drag, whereas this
is a same-next-session open→close return on a much narrower AND'd condition. Different construct,
different answer.

**The generalisable lesson: on this data, rare-and-conditional beats universal-and-daily.** Build
two or three more specialists in that shape — forced-selling states, event windows — rather than
one more engine in a blend. Each one is independently gradeable, independently killable, and adds
no weight to a blend nobody can validate.

**Two known defects in the existing harness to fix first**, both found in the same review:

1. `screener_combo_finder.py` has **no winsorisation step**, despite §0.4 requiring one. Checked
   live it does not change this result — fix it anyway, for consistency.
2. `run_tier1`'s verdict logic is `is_edge = spread_pct > 0`, so it only ever surfaces the best
   *positive*-direction combo. The single most significant combo in the full 41-row table is
   negative-direction (`gap_down,open_eq_high`, t=−4.12, spread −0.53% — stronger than the
   "winning" positive one) and the console output never shows it. Same class as W4's
   `max(0.0, v)` clamp: **the harness cannot report an inverted edge.**

**Honest limit:** ~1.5 signals/day when it fires, ~651 stock-days across 5.5y. Narrow enough to
watch, nowhere near capacity-proven at scale. Any sizing work needs the capital number that
§"What this plan does NOT fix" item 3 says nobody has stated.

---

### W8. Turnover- and cost-awareness — likely worth more than any direction improvement

**Bucket: BUILD IN GREENFIELD — already done there. Verify, do not reimplement in legacy.**
Stage 5 Task 5.0.1 already deducts round-trip cost against **measured** top-K set overlap between
consecutive rebalance dates (not an assumed constant), negative-controlled at 0% and 100%
turnover. Read it before writing anything. What remains here is the *rationale*, which is why
the item is kept, and the hysteresis rule, which greenfield does not yet have.

This repo's own evidence that this is the binding constraint on *realized* return:

- `delivery_pct`: quintile spread +0.19pp/day, **t=+7.82** — and **dead** long-only, −1.04%/period
  at 21d/25bps.
- `gap_down` and `gap_up` are **both** significantly negative net of costs (t=−3.54 / −3.55),
  driven by ~90–93% one-way turnover per rebalance, not by direction.
- Intraday: 23 days, 256 configs, best net at 15bps = **−0.004%** — the edge exists in sign and is
  smaller than costs.
- The `factor_backtest.py` universe is near-invariant to rebalance frequency post-fix
  (+26.13%/yr @ 1, +23.30% @ 5, +20.31% @ 21) — so slower is close to free.

**Change.** Add an explicit turnover penalty and **rank hysteresis** (a name must clear a wider
band to enter than to stay) to the ranker's selection step, and surface realized turnover as a
first-class reported number alongside every backtest.

This is also where the platform's data *breadth* actually pays: liquidity, spread, ADT, realized
volatility and event proximity are the columns with real measurable structure, unlike the
direction columns. Spend the 200 tables here.

---

## Phase 4 — invariants and hygiene

### W9. `knowable_at` point-in-time correctness as a schema invariant — **greenfield only**

**Bucket: BUILD IN GREENFIELD. Do NOT attempt to retrofit the legacy system.** Retrofitting means
200+ tables, several of them compressed hypertables where a predicate-wide `ADD CONSTRAINT` /
`UPDATE` fails or destroys compression — unbounded risk on a live system. Greenfield's canonical
zone is specified append-only and bitemporal from the start, where this is free rather than
retrofitted. Scoped in `.claude/skills/production-grade-hardening/SKILL.md` §5; that skill's
"requires owner sign-off" gate still applies to any legacy-side work.

PIT correctness today is per-table *convention* (`as_of.py`, `fundamentals_history`,
`analyst_estimates_history` all do it right) with nothing enforcing it. Vendor fundamentals get
retrospectively restated — `measurement.md` flags this for `value_book_to_price` explicitly — so
any feature joined "latest known" instead of "known at `signal_date`" silently injects look-ahead
into training. That inflates CV, deflates live, and is indistinguishable from model decay. **This
is the highest-leverage remaining accuracy fix**, and also the riskiest: 200+ tables, several
compressed hypertables where a predicate-wide `ADD CONSTRAINT` / `UPDATE` can fail or destroy
compression.

Until it is signed off, do the cheap subset: for every feature W1/W6/W7 consume, verify by hand
that its join is as-of `signal_date`, and write down the ones that are not.

### W10. Give provisional constants an expiry

Several load-bearing rules are fitted on samples the code itself calls insufficient. The clearest:
`_classify`'s coverage requirement rests on IC +0.0241 (t=+2.36) vs −0.0150 from a sample its own
docstring describes as **n=135 over 7 days with overlapping 21d windows**, and the docstring is
explicit that "every |t| here is inflated."

The rule is plausible and I am not proposing to remove it. I am proposing that **any constant
derived from fewer than ~30 non-overlapping dates is tagged provisional with a re-check date**,
and that a check surfaces it when the date passes — the same treatment `measurement.md` already
gives `screener_breadth`, `earnings_beat_*` and `smart_money`.

### W11. Policy: stop onboarding data sources; let the existing ones accumulate

`measurement.md`'s own audit: of 60 symbol+date tables, **9 have enough history to test anything**;
35 start ~2026-06-30. `earnings_beat_yoy` has 19 trading days of real depth.
`screener_appearances` ~2.5 months. `win_probability` starts 2026-05-16. The canonical ranker had
2 provably pre-market gradeable dates as of 2026-08-13.

**The data is wide, not deep. The binding constraint is calendar, not coverage.** A 141st fetcher
adds maintenance surface and no measurable capability. Three things unblock on their own with
elapsed time and should simply be waited for: the three analyst-revision columns (~2026-09-05),
`ccc_trend` (needs a second fiscal year in `working_capital_history`), and `smart_money`'s
`factor_edge_history` verdict.

---

## What this plan does NOT fix — known gaps, stated so they are not mistaken for covered

Implementing everything above is **not sufficient**, and this section exists so nobody reads the
plan as complete. Each of these is a real gap with no owner:

1. **No portfolio construction.** A ranker is not a strategy. There is no position sizing, no
   covariance, no sector/size exposure control, no drawdown control. `factor_backtest.py` is
   top-K equal-weight, which means **every existing result is confounded with whatever incidental
   sector and size bets the top-K happened to carry.**
2. **Market beta is never neutralized before grading.** The clearest tell is already in
   `measurement.md`: the Sell bucket's win rate flips with the day's market direction (66.7% on a
   down day, 45.8% on an up day). That is consistent with the system measuring **beta, not alpha**.
   Nothing here demeans by market return before measuring, and it should.
3. **Costs are modelled as flat bps.** Greenfield's Task 5.0.1 is a real improvement (measured
   turnover), but impact is nonlinear in participation rate and neither system models it. A ₹1cr
   ADT floor is **low**: at meaningful capital the tradeable universe may be ~200 names, not 2,400.
   **Nobody has stated what capital this is for, and that single unstated number determines which
   results matter.**
4. **The horizon most likely to work is untested and calendar-blocked.** Everything is 1/5/21d.
   Fundamental and ownership data plausibly carries signal at 3–6 months, where the turnover that
   killed `gap_down`, `gap_up` and `delivery_pct` largely disappears. Not testable yet (~2 quarters
   of history) — but it should be the explicit thing the platform is accumulating toward.
5. **Survivorship and delisting handling is unproven.** `factor_backtest.py` had an exit-accounting
   bug that wrote off eligible-but-unpriced names at −100%. `nse_universe_history` exists; confirm
   the panel's universe is genuinely point-in-time rather than assuming it.
6. **Complexity is itself an accuracy risk, and nothing here reduces it.** ~140 fetchers, 6
   dashboard shells, ~30 ML engines, 200+ tables, ~150 quality checks. Read `recurring-bugs.md`
   end to end and count: the overwhelming majority of incidents are **maintenance failures, not
   modelling failures.** W6 and W7 add surface to a system whose dominant failure mode is already
   surface area — which is the strongest argument for building them in greenfield instead.

---

## Explicitly out of scope — do not do these

- **Do not reweight the existing blend to chase a number.** `measurement.md`: there is no
  incumbent factor to beat, and combining reduced performance in every case tested. W4 is a
  pruning of measured-negative and measured-absent components, not a search over weights.
- **Do not recalibrate `DIRECTIONLESS_BUY_FLOOR` or convert it to a percentile.** No score cut has
  significant edge over 30 measured dates, and the cuts are non-monotone. W3 fixes the input
  scale instead.
- **Do not re-test anything in `measurement.md`'s "already tested" table** without first stating
  what changed (more history, different horizon, different construction).
- **Do not re-attempt** merging `signal_outcomes` into `unified_signal_outcomes`, or renaming
  `technical_signals` → `technical_features` (141 files, cosmetic).
- **Do not re-enable** the Smart Money Override (`unified_ranker.py:2077`, reverted) or set
  `ML_INCREMENTAL_WARMSTART=1` — both need evidence nobody has gathered.
- **Do not write a script that formats plausible numbers without connecting to the database.**
  Five such "verification" scripts were found and deleted on 2026-08-12. Evidence-shaped output is
  worse than none.

---

## Reporting — a phase is not finished until all four are done

1. **`measurement.md`** — every number this work produced, positive or null, with the honest
   caveats (date counts, window overlap, whether costs were included). Retract anything this work
   invalidates, with a dated banner, rather than editing it silently.
2. **`docs/session-log.md`** — what changed, what was learned, and **explicitly which checks were
   not run and why** (especially if any of it was done from the dev Mac).
3. **`.claude/rules/recurring-bugs.md`** — if a bug class recurs during this work, add its
   signature. If it is statically detectable, the durable move is a check in
   `scripts/check_recurring_bugs.py`, not another paragraph. When writing such a check, state in
   the check's own comment **what file layout makes the class invisible to it** — otherwise "the
   checker is clean" gets read as "the class is extinct."
4. **Memory** — `MEMORY.md` index plus any durable, non-obvious finding.

---

## Suggested order

```
P0   shadow forward track        GREENFIELD   start NOW — calendar-bound, gates every decision
W0   verify ground truth         LEGACY       blocks all legacy work; may invalidate W4's table
W11  stop onboarding sources     BOTH         policy, immediate, free

── legacy: corrective only, then freeze ─────────────────────────────────────────
W2(B) narrow serving population  LEGACY       smallest real accuracy fix, do first
W1   relabel to cross-sectional  LEGACY       highest expected lift in legacy
W3   per-date normalisation      LEGACY       makes W4 measurable; kills the 13x scale swing
W5   delete REGIME_CAT_TILT      LEGACY       small, do alongside W3
W4   prune 8 engines -> 4        LEGACY       weight-zero only, one engine per commit, each measured
W10  provisional-constant expiry LEGACY       hygiene, anytime

── greenfield: all new architecture ─────────────────────────────────────────────
W8   turnover/cost layer         GREENFIELD   already built (Task 5.0.1) — verify, do not rebuild
W7   meta-labeling               GREENFIELD   parallelisable with W6W7.1 state-conditional specialists GREENFIELD the one measured-positive shape; pairs with W7W6   learned ranker              GREENFIELD   stage5/ranker.ts is the seam
W9   knowable_at / bitemporal    GREENFIELD   sign-off required; do NOT attempt in legacy
```

**Stop and report after each item.** Do not chain several of these into one commit — this repo's
history is full of unmeasured signal changes merged on a green test suite, which is precisely what
`verify-gate.mjs`'s backtest requirement exists to prevent.

**Hard stop after W3.** Re-measure, and re-read the shadow track's accumulated dates, before
committing to W6 or W7. Both are substantial projects, and if P0 is trending null there is no case
for either.
