# Scoring Authority & Signal Model (canonical)

Read before touching any scoring, ranking, or signal table.

**Scoring authority.** There are three score producers; do not invent a fourth. The canonical
cross-source ranking is `unified_recommendations`, produced by `unified_ranker.py` (scheduled via
`QUEUE_UNIFIED_RANKER`). It sits *downstream* of the component producers and is what new
ranking/UI surfaces should read:

| Producer | Writes | Role |
|---|---|---|
| `scoring_engine.py` | `stock_scores` + `stock_factor_breakdown` | screener/news composite (per timeframe) |
| `quantScoringService` / quant engines | `quant_scores` | momentum/quality/value/composite ranks |
| `unified_ranker.py` | **`unified_recommendations`** | **canonical** — merges the above + screener confluence |

**`stock_scores`/`quant_scores` are inputs to `unified_recommendations`, not duplicates of it** —
`unified_ranker.py` reads both as component scores, so they cannot be physically merged into the
table they feed. "Consolidation" here means keeping UI reads from bypassing the canonical table,
not deleting the input tables. Both closed 2026-08: `getTopRatedStocks` (`scoringService.ts`) reads
`unified_recommendations` first for `timeframe === 'long_term'` — falling back to `stock_scores`
only when UR has no rows yet (cold start) — but goes straight to `stock_scores` for `intraday`/
`swing` without checking UR at all (found by the 2026-08-18 canonical-read-audit, AF-20260818-40;
not a live gap, `TopRatedStocks.tsx` already carries a `LegacyScoreBanner` disclosing non-canonical
status regardless of timeframe); `getStrategyStocks` (`quantScoringService.ts`) surfaces UR's `unified_score`/
`classification`/`conviction_level` as read-only context columns on every row, plus an opt-in
`requireUnifiedCoverage` filter, with the same cold-start fallback. Any new engine should still
write a *component* score the ranker ingests — never a parallel "final" score.

**`timeframe_scores` is NOT a fourth producer — it is a pre-existing violation of the "never
write a parallel final score" rule above, found by the 2026-08-14 canonical-read-audit, decided
here rather than left undocumented.** `scoringService.ts`'s `computeTimeframeScores` (called from
`screeners.router.ts`'s `computeTimeframeScores`/`getTimeframeRanking` procedures, rendered by
`ScreenerRankingPanel.tsx` inside the live, routed `/screener-intelligence` page) computes its own
hand-rolled weighted blend — `momentum_score * 0.4 + technical_composite_score * 0.4 +
return_on_equity-derived * 0.2` — on demand, per screener run, writing to `timeframe_scores`. It
does not feed `unified_ranker.py`, is not blended into `unified_recommendations`, and has never
been backtested (no `factor_backtest.py` run, no entry in `measurement.md`) — exactly the
unmeasured-parallel-score shape this file exists to prevent. It predates this rule file and is
reachable in production today, so the fix is disclosure, not silent removal: `ScreenerRankingPanel.tsx`
now carries an inline caveat ("not the canonical unified model, not backtested"). Treat it as a
deprecation candidate, not a base to extend — do not add inputs to `computeTimeframeScores`'s
formula or route new UI to `getTimeframeRanking`; route new work to `unified_ranker.py`'s inputs
instead. Removing it outright needs a decision on whether `/screener-intelligence`'s
"compute rankings on this screener run" interaction has a real user, which this audit didn't
establish either way.

`quant_scores` previously had three writers with a real ordering bug: `institutional_quant_engine.py`
ran inside `ml-daily-ops` (7:30 PM IST) and did a full `DELETE`+re-`INSERT`, but `quantScoringService.ts`'s
own upsert ran 3.5h later (11 PM IST) writing the identical columns — the earlier engine's writes were
always clobbered same-night. Retired as an automatic writer (still reachable on-demand via `mcpServer.ts`'s
`run_analytical_engine`, now upsert-safe). `multi_factor_scorer.py` (writes `quant_scores.mf_*`) claimed to
depend on `quantScoringService` having already run but ran *before* it — moved to run inside the
`quant-scoring` job, after `runQuantScoring()`.

**Signal model.** `signals` was dropped 2026-06-20 ("Cluster A" —
`docs/superpowers/plans/2026-06-19-signal-model-rationalization-cluster-a.md`); `technical_analysis_signals`
was folded into `unified_signals` (`signal_source='technical'`) 2026-08 ("Cluster B-lite", continuing
Cluster A's own deferred scope) — its writer (`technical_analysis_engine.py`, now also scheduled nightly
inside `ml-daily-ops` for the first time — it had never run on any automatic schedule before) and all 3
non-UI readers (`mcpServer.ts`, `strategySignalsService.ts`'s `qualityOversoldScanner`, chatbot
`price_tool.py`) repointed first. **Four signal tables remain**: `unified_signals`, `technical_signals`,
`signal_outcomes`, `unified_signal_outcomes`.

**`signal_outcomes` gained a `signal_source` column (2026-08), closing a real, active collision, not
just a labeling-definition footnote.** The earlier framing ("mixed label definitions across horizons")
undersold the actual mechanism: `signal_outcomes` had no way to tell which upstream signal a row
graded, so **three independent writers** — `outcome_resolver.py` (h1/5/15, grades `technical_signals`),
`confluence_outcome_tracker.py` (h1/3/7/14/30, grades the *unrelated* `confluence_signals` table), and
a previously-undiscovered third writer, `signalOutcomesService.ts` (its own separately-scheduled
`signal-outcomes-daily` cron, 9 AM IST weekdays, also grading `technical_signals` with yet another
methodology) — all guarded their dedup checks against "does *any* row exist for this
`(symbol, signal_date, horizon_days)`", regardless of which writer or source produced it. Whichever
wrote first silently won that key forever; the horizon split observed in the data (h1/5/15 vs.
h3/7/14/30) was a byproduct of that collision-avoidance, not evidence of a designed labeling scheme.
Consumers that `JOIN` back to `technical_signals` on `(symbol, date)` could pair a confluence-sourced
outcome with an unrelated technical signal's features. Fixed by widening the key to
`(symbol, signal_date, horizon_days, signal_source)` (mirroring `unified_signal_outcomes`, which
already had exactly this column for exactly this reason) and stamping all three writers —
`signalOutcomesService.ts`'s PENDING-seed counterpart in `technicalSignalsService.ts` also needed the
same stamp, or a seeded row at the column default would never be matched by any resolver's `ON
CONFLICT` target and would orphan permanently. ~20 consumer files across the ML stack
(`ml_ensemble.py`'s core training query foremost among them) now explicitly filter to the correct
`signal_source` instead of relying on which horizon happened to be collision-free. Backfilled
267,976 existing rows by inferring source from `label_definition` (sound, not a guess — the
one-writer-per-horizon-bucket mechanism made the inference exact). Live-verified: real symbols
(e.g. `ADANIPORTS`/`2026-08-02`/h1) now carry both a technical- and confluence-sourced row
simultaneously, which was structurally impossible before this fix.

**Full Cluster B remains explicitly out of scope, not just deferred without reason:** renaming
`technical_signals`→`technical_features` touches 141 files (not ~35/~69 as earlier estimated —
confirmed via exhaustive grep), purely cosmetic with zero functional benefit, not worth the mechanical
risk on a live system. Merging `signal_outcomes` into `unified_signal_outcomes` was investigated and
rejected on its merits, not deferred: `unified_signal_outcomes` is FK'd to a specific `unified_signals`
row (grades *that instance*); `signal_outcomes` grades `technical_signals`/`confluence_signals` events
that mostly have no corresponding `unified_signals` row at all (grades *the market's behavior after a
date*, decoupled from any specific signal record). These answer genuinely different questions — forcing
a merge would require either dropping the FK (defeats its purpose) or writing a `unified_signals` row
for every graded event (a much larger behavioral change). Do not re-attempt this merge without
re-deriving why it doesn't work. Do not add new signal tables.
