# Build Spec: Stage 5 — Shadow Decisions and Cutover

**Audience: an AI coding agent executing this build.** All rules from
[BUILD_STAGE_0_2_SPEC.md](BUILD_STAGE_0_2_SPEC.md) §0 (how to execute) and §1 (invariants), and
[BUILD_STAGE_3_4_SPEC.md](BUILD_STAGE_3_4_SPEC.md)'s Stage 3/4 additions, remain in force
throughout. Work task-by-task. Every task carries a **Verify** step; run it before continuing.

Prerequisites: Stage 4 acceptance gate passed (2026-08-13 — 3,274,144 `feature_snapshot` rows,
83.3% median coverage, 72 `audit_metric` rows, all four harness negative controls green). Read
that gate's report before starting Task 5.0 — it is the reason this spec is conservative by
design, not by default caution.

---

## 0. The finding this spec is built around

Stage 4's measurement baseline is **not** a validated edge. It is a first-run, gross (no
transaction cost), single-measurement pass over a brand-new panel. Two things are true at once:

1. Several factors clear a naive significance bar by a wide margin — `delivery_pct` t=15–18,
   `div_yield_ttm` t=10–13, several others t=4–7 at one or both rebalance horizons.
2. **None of that is evidence of a tradeable factor yet.** The predecessor system found the exact
   same shape of result for `delivery_pct` — a real, significant cross-sectional spread (t=+7.82)
   that was **dead as a long-only factor once trading costs were applied** (net excess −1.04%/period
   at 21d/25bps). Stage 4's harness does not model costs at all. Treating Stage 4's numbers as
   confirmed alpha would repeat the predecessor's most-documented failure mode, on the first attempt.

**Consequence for this spec:** Stage 5 does not start by building a ranker from Stage 4's factor
list. It starts by re-measuring those factors **with costs**, then gates ranker construction on
what survives. Everything downstream — shadow period length, promotion threshold, universe size —
is sized to a scenario where zero factors survive, because that is the single most likely outcome
given the predecessor's own history (`.claude/rules/measurement.md`: "no factor in this harness has
a credible positive edge" was the terminal finding after the equivalent work on the old system).

---

## 1. Mission and additional invariants

Produce a single, append-only, gradeable ranker; run it in shadow (never publishable) for a
preregistered minimum period; only then decide, from measured shadow performance — not from Stage
4's gross numbers — whether cutover is justified.

Invariants 1–10 from BUILD_STAGE_0_2_SPEC.md §1 apply unchanged. Add:

11. **A factor enters the ranker only after clearing a cost-adjusted, multiple-testing-corrected
    significance bar on the Stage 4 panel.** Gross IC alone (Stage 4's current state) is not
    sufficient. See Task 5.0.
12. **The ranker publishes nothing during shadow mode.** Every `recommendation` row is written with
    `is_publishable = false` until Acceptance Gate 5 passes. No code path may flip this outside the
    promotion procedure in Task 5.4.
13. **The shadow period length is preregistered before the first shadow run, in `audit_metric`, and
    is never shortened.** It may be lengthened if the data disagrees with the plan (e.g. too few
    pre-market dates accumulate) but a shortened window after seeing favorable results is exactly
    the kind of post-hoc data-snooping this project's own history warns against.
14. **Old-system writes are never touched.** Stage 5 reads the old DB only where Task 5.5 explicitly
    requires it (delta Q-transfer at cutover), and never writes to it, at any point, under any
    circumstance.
15. **A promotion decision is made by a script whose exit code is the decision, not by prose in a
    report.** `verify-gate.mjs`'s own history — reweighting changes merged on a green test suite
    with no backtest evidence — is the reason this project no longer accepts a narrative "looks
    good" as a promotion criterion anywhere.

---

## 2. Grounding facts — Stage 4's actual measured state

Do not re-derive these; they are the reason Task 5.0 exists. Full detail: Stage 4's acceptance-gate
report and `audit_metric` (`metric_name LIKE 'factor_%'`, run recorded 2026-08-13).

| Factor | 5d IC (t) | 21d IC (t) | Coverage | Note |
|---|---|---|---|---|
| `momentum_21d` | t=−4.49 | t=−0.01 | 97.5% | negative at short horizon, matches predecessor |
| `momentum_63d` | t=0.50 | t=5.35 | 92.8% | only 21d clears significance |
| `delivery_pct` | t=15.67 | t=18.69 | 90.0% | **gross only — predecessor found this dead after costs** |
| `delivery_pct_ma20` | t=6.84 | t=12.82 | 92.0% | same caveat |
| `pe_pct_rank_252d` | t=5.20 | t=6.84 | 54.2% | cross-sectional, liquid-peer-only rank |
| `pb_pct_rank_252d` | t=4.35 | t=4.30 | 54.2% | same construction |
| `eps_ttm` | t=4.17 | t=5.86 | 13.0% | thin — n≈316–332 dates, not n≈1,300+ like the others |
| `eps_growth_yoy` | t=2.72 | t=1.87 | 0.7% | n≈26–51 dates — not measurable yet, calendar-bound |
| `div_yield_ttm` | t=10.13 | t=13.47 | 55.0% | **gross only**, same caveat as delivery_pct |
| `fii_net_21d` | t=−3.74 | t=−2.85 | 100% | negative both horizons |
| `dii_net_21d` | t=−4.51 | t=−6.13 | 57.3% | negative both horizons |
| `screener_breadth` | no data | no data | 0% | excluded — screener_membership has ~1 day of real history |

None of the positive-IC rows above have been tested net of transaction costs, sector-neutralized,
or checked against a second independent measurement run. Task 5.0 does all three before any of
them may appear in a ranker weight.

---

## 3. Task 5.0 — Cost-aware re-measurement (blocks everything else)

### Task 5.0.1 — Add cost modeling to the research harness

Extend `computeAnnualizedExcessReturn` (or add a sibling function) in `research-harness.ts` to
accept a `costBps` parameter and deduct round-trip transaction cost on every rebalance:
`netReturn = grossReturn - (costBps / 10000) * turnoverFraction`. Use `costBps = 25` as the default
(matches the predecessor's own convention, `.claude/rules/measurement.md`), and additionally report
at `costBps = 15` for the higher-liquidity subset if time allows.

Turnover fraction: for a top-K rebalanced portfolio, turnover per period is the fraction of the
portfolio that changes membership between rebalance dates (not a fixed constant) — compute it from
the actual top-K set overlap between consecutive rebalance dates, not assumed.

**Verify:** a unit test with a synthetic universe where turnover is 100% every period (completely
different top-K each time) shows `netReturn` collapsing toward `grossReturn - costBps/10000` per
period; a test with 0% turnover (identical top-K every period) shows `netReturn ≈ grossReturn`.

### Task 5.0.2 — Bonferroni correction across the factor panel

12 factors were tested at 2 horizons = 24 comparisons (matching the predecessor's own "N-factor
Bonferroni" convention). Compute the corrected significance threshold
(`t_critical ≈ Φ⁻¹(1 - 0.05/(2×24))`, computed via Acklam's rational approximation to the inverse normal CDF, packages/ingestion/src/stage4/stats.ts -- the real value is ≈3.08, not a hand-estimate)
and apply it to the **net-of-cost** t-stats from Task 5.0.1, not the gross ones from Stage 4.

### Task 5.0.3 — Re-run and record

Re-run the full measurement baseline (`run-measurement-baseline.ts`, extended per 5.0.1) against
the same panel. Record net-of-cost IC, t-stat, and annualized net excess return in `audit_metric`
under `metric_name` prefix `factor_net_*`, distinct from Stage 4's `factor_*` rows — never
overwrite Stage 4's gross numbers, both are evidence.

**Verify:** every `factor_net_*` row has a non-NULL `data_watermark`/`code_commit`; the harness's
four Task 4.3 negative controls still pass unmodified (cost modeling must not break leakage/
exit-pricing/benchmark/known-null detection — add a fifth negative control here: a factor with
100% one-way turnover every period and zero real skill must show net excess not significantly
different from `-costBps` itself, i.e. the cost model is actually being subtracted, not silently
ignored).

### Acceptance Gate 5.0

1. Task 5.0.1's unit tests pass, including the new turnover-sensitivity negative control.
2. `factor_net_*` rows exist in `audit_metric` for all 12 factors at both horizons.
3. A published list of which factors (if any) clear the computed Bonferroni bar (≈3.08) net of
   costs. **If the honest answer
   is zero factors, that is a valid, expected outcome — do not lower the bar to manufacture a
   result.** Proceed to Task 5.1 either way; a zero-factor outcome still has a ranker (an
   equal-weight or single-best-available-factor baseline), it just starts from a position of
   admitted uncertainty rather than false confidence, exactly as the predecessor system had to.

---

## 4. Task 5.1 — Ranker construction

### Task 5.1.1 — Weight only what survived Task 5.0

Build `unified_ranker` (a new package or module — do not resurrect the predecessor's
`unified_ranker.py`, this is a fresh implementation reading only `feature_snapshot`) with a linear
combination of the factors that cleared Task 5.0's Bonferroni bar, weighted by their net-of-cost
t-stat (a "quality of evidence" weighting, not a discretionary choice). If zero factors survive,
implement a **null ranker**: sorts by `momentum_63d` alone (the single most theoretically-motivated
survivor in the predecessor's own history, even if it did not clear significance here) purely as a
placeholder that produces a deterministic, gradeable ranking — labelled explicitly as unvalidated
in its own `model_version.metrics` JSON, never silently presented as "the ranker."

### Task 5.1.2 — Write `recommendation` rows

Every session, for the current `feature_snapshot`, compute a rank and write one `recommendation`
row per symbol per `.claude/rules/scoring-authority.md`'s shape (adapted: this is the *only*
ranker in the greenfield system, there is no `stock_scores`/`quant_scores` split to preserve).
`is_publishable = false` unconditionally during Stage 5. `facts_cutoff` must equal the
`feature_snapshot` row's own `facts_cutoff` it was computed from — never a later timestamp
(mirrors Task 4.2's exact discipline).

**Verify:** a test that a `recommendation` row's `facts_cutoff` never exceeds its
`feature_snapshot` source row's `facts_cutoff`; a test that re-running the ranker for an
already-scored session produces a **new** row (append-only, per invariant in
`GREENFIELD_BUILD_SPEC.md` C6), never an update to the existing one.

---

## 5. Task 5.2 — Preregister the shadow period

Before the first live shadow run, insert into `audit_metric`:

```sql
INSERT INTO audit_metric (run_id, metric_name, metric_version, dimensions, value,
  data_watermark, params_hash, code_commit, generated_at)
VALUES (current_run_id, 'shadow_period_preregistration', 'v1',
  '{"min_dates": 30, "min_calendar_weeks": 6}'::jsonb, NULL,
  '<first shadow session date>', '<params_hash>', '<commit>', now());
```

`min_dates: 30` mirrors Stage 3's own precedent (`unified_recommendations_history`'s "roughly six
trading weeks... before a t-stat means anything"). Do not shorten this after seeing early shadow
results — if 15 days look great, that is exactly the small-sample trap `measurement.md`'s panel
spec exists to prevent.

**Verify:** the `audit_metric` row exists before the first `recommendation` row is written; a
`dq_check` (Task 5.6) fails loudly if a promotion is attempted before `min_dates` pre-market
sessions have accumulated.

---

## 6. Task 5.3 — Dual-run divergence analysis

While the shadow ranker runs, compare its calls against the old system's live
`unified_recommendations` for the same trading dates (read-only join, old DB never written).

Report, per date: rank correlation between the two rankers' top-50, and directional agreement rate
(fraction of symbols both call the same broad direction). This is **descriptive**, not a promotion
criterion by itself — the old ranker has no demonstrated edge either
(`.claude/rules/measurement.md`: `unified_score` 5d rank IC ≈ 0.0001), so agreement or disagreement
with it says nothing about correctness. Its purpose is operational: catching a shadow ranker that
is broken in some way the old system's monitoring would have caught (e.g. producing the same rank
for every symbol, a `NaN`-poisoned score, a symbol universe collapsed to a handful of names).

**Verify:** a dq_check that fires if the shadow ranker's rank distribution has near-zero variance
on any session (the concrete historical bug this guards against: a broken RL gate once excluded
825 symbols platform-wide and nothing caught it for a full session).

---

## 7. Task 5.4 — Promotion gate

A script, `promotion-gate.ts`, whose **exit code is the decision** (0 = promote, 1 = do not
promote), run only after Task 5.2's `min_dates` threshold is met. It must check, in order, failing
closed on the first unmet condition:

1. `min_dates` pre-market shadow sessions exist (query `recommendation`, not a manual count).
2. The shadow ranker's own realized forward-return IC (using `research-harness.ts`'s
   `computeIC`, net-of-cost per Task 5.0.1) over the shadow window is positive and significant
   at the SAME computed Bonferroni bar Task 5.0 used — re-measured on live shadow data, not re-quoting
   Task 5.0's backtest number. A backtest and a live shadow run can disagree; this is the check
   that would catch it.
3. Task 5.3's divergence monitor has raised zero `fail`-severity dq_check results during the
   shadow window.
4. No `is_publishable = true` row exists anywhere yet (idempotency / already-promoted guard).

**This gate is very likely to fail on the first attempt, and that is the correct, expected
outcome given Task 5.0's own likely finding.** Do not treat a failing gate as something to debug
around; it is the gate doing its job. Re-attempt after a longer shadow window or a revised factor
set, following the same procedure — never by editing the gate's thresholds after seeing why it
failed.

**Verify:** negative-control the gate itself — feed it a synthetic shadow run with a known-zero-IC
ranker and confirm exit code 1; feed it one with an injected, deliberately strong synthetic
IC signal and confirm exit code 0. Same "prove the check can both pass and fail" discipline as
every dq_check in Stages 2–4.

---

## 8. Task 5.5 — Cutover sequence (only after Acceptance Gate 5.4 passes)

1. **Freeze old DB writes.** Coordinate with whatever process owns the live `bharat-server`/
   `ml-daily-ops` schedule — this is a real, external, hard-to-reverse action requiring explicit
   user confirmation before execution, per this session's own operating rules. Do not automate
   this step without a human confirming the freeze window.
2. **Delta Q-transfer.** Re-run Stage 3's transfer scripts scoped to `available_at` after the
   original `provenance_boundary_date` (2026-08-12), closing the gap between Stage 3's snapshot
   and the cutover date. Same idempotency guarantees (`ON CONFLICT DO NOTHING`) apply.
3. **Repoint services.** Update whatever consumes `unified_recommendations` today to read the new
   `recommendation` table instead. This is application code outside `greenfield/` — identify call
   sites via `graphify query` before editing, do not assume the call-site list from memory.
4. **Smoke test.** The same shape of check as Stage 0-2's Acceptance Gate 1/2: a real query against
   the newly-repointed read path, not a code review, confirming rows are actually flowing.

**Verify:** each of the 4 steps above has its own command-exit-0 check; Acceptance Gate 5 (final)
does not pass until all 4 have run in sequence against real infrastructure, not a staging copy.

---

## 9. Task 5.6 — DQ checks for Stage 5

| check_id | Asserts |
|---|---|
| `shadow-recommendation-freshness` | latest `recommendation.generated_at` is current (trading-day aware) |
| `shadow-rank-variance` | rank distribution on the latest session isn't degenerate (near-zero variance) |
| `promotion-not-premature` | `is_publishable = true` never exists before `min_dates` shadow sessions have accumulated |
| `dual-run-divergence-sane` | Task 5.3's agreement metrics are being computed and are not all-NULL (monitoring itself hasn't silently stopped) |

All four negative-controlled per this project's now-standing convention.

---

## 10. Prohibitions (additive to BUILD_STAGE_0_2_SPEC.md §6 and BUILD_STAGE_3_4_SPEC.md §6)

21. Do not construct a ranker from Stage 4's gross factor numbers. Task 5.0's cost-adjusted,
    corrected re-measurement is a hard prerequisite, not a parallel option.
22. Do not shorten the preregistered shadow period after seeing early results.
23. Do not promote (`is_publishable = true`) via any path other than `promotion-gate.ts` exiting 0.
24. Do not freeze old-DB writes, or perform any cutover step, without explicit user confirmation —
    these are exactly the hard-to-reverse, shared-state actions this session's own operating rules
    require pausing for.
25. Do not treat old-system/new-system agreement (Task 5.3) as evidence of correctness in either
    direction. The old system's own ranker has no demonstrated edge.
26. Do not edit `promotion-gate.ts`'s thresholds after running it and seeing why it failed in a
    specific instance. A threshold change is a new decision, made before the next attempt, not a
    reaction to one specific unwanted result.

---

## 11. Report back on completion

After Task 5.0: which factors (if any) cleared the net-of-cost, Bonferroni-corrected bar; full
comparison table of gross (Stage 4) vs net (Stage 5.0) IC/t-stat per factor.

After Task 5.4 (whether the gate passes or fails): the gate's own exit code and the value of each
of its 4 checks — never summarized as "looks promising," always the literal numbers the gate
computed.

After Task 5.5 (only if reached): confirmation of each of the 4 cutover steps' independent
verification, plus the smoke test's actual query result.

If any gate is red, state it plainly — including, and especially, if Task 5.0 finds zero
surviving factors. That is a legitimate, reportable outcome, not a failure of this spec.
