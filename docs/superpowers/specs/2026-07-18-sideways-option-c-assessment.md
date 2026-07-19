# SIDEWAYS Regime — Option C (Per-Regime Meta-Learner) Assessment

_Design-decision spec — 2026-07-18. Follow-up to
[2026-06-21-regime-conditional-calibration-design.md](2026-06-21-regime-conditional-calibration-design.md)'s
Option A rollout, which explicitly deferred Option C ("a future regime shows AUC ≈ 0.5 in the
diagnostic... designed in a separate spec") to be triggered by evidence, not assumption._

## Problem

The 2026-06-21 doc's own escalation criterion appeared to fire: live `per_regime_auc()` shows
SIDEWAYS at 0.533 (near chance), while BEAR (0.625) and BULL (0.599) both discriminate
meaningfully. Since isotonic calibration (Option A, already live) is rank-preserving — it cannot
raise an AUC, only make the probability's value honest — a persistently-chance AUC in one regime
looks like exactly the trigger condition the original doc named for escalating to Option C (a
separate per-regime model for that regime).

This spec was commissioned to design that Option C model. **It does not do that.** Investigation
before any design work turned up that the AUC evidence itself is unreliable, for a reason that
invalidates the premise rather than just weakening it.

## Finding: the AUC diagnostic is built on a severely coverage-biased sample, not a random one

`per_regime_auc()`/`regime_readiness()` restrict to rows where `win_probability IS NOT NULL AND
win_probability <> 0.5` (i.e., rows the scoring pipeline actually got to). Live query
(2026-07-18) shows this "scored" population for SIDEWAYS is only **8 distinct days / 4,064 rows**
— but the full training-eligible population (`signal_outcomes ⋈ technical_signals`, no
scored-only filter, matching what `ml_ensemble.load_training_data()` actually trains on) for
SIDEWAYS is **26 distinct days / 20,278 rows**. Less than 20% of SIDEWAYS-regime signal days ever
got scored at all:

| date range | technical_signals rows (all) | scored (win_probability real) | coverage |
|---|---|---|---|
| 2026-05-22 → 06-01 | ~3,900 | ~3,900 | ~100% |
| 2026-06-30 → 07-16 | ~16,400 | ~160 | **~1%** |

BULL and BEAR show the identical pattern over the identical calendar window — this is **not**
SIDEWAYS-specific. It's a global scoring-pipeline coverage collapse that began around 2026-06-04
(a multi-week total gap in technical_signals volume) and, once volume resumed around 2026-06-30
(likely from the full-universe grid-ensurer backfill work), scoring coverage of that volume
collapsed to roughly 1-3%/day instead of recovering.

**Root cause located, not yet fixed:** `/api/score-pending` (`src/server/python_api.py`, the
"ml-api" service on :8000 — a third standalone Python process, distinct from AlphaQuant :8002 and
the chatbot :8001) calls `ml_ensemble.run(do_score=True)`, whose scoring query
(`src/server/ml_ensemble.py:1592-1595`) is:

```sql
WHERE ts.win_probability IS NULL AND ts.signals_json IS NOT NULL
ORDER BY ts.date DESC
LIMIT 10000
```

The port-8000 service is up right now (`Get-NetTCPConnection` confirms 8000/8001/8002/3000 all
listening), so this isn't a simple "process is down" story — the daily technical_signals volume
(up to ~2,600/day in the degraded window, per `mc_ohlcv_deep_history_backfill`'s full-universe
grid landing 2026-07-11) combined with a fixed 10k-row cap and whatever cadence/reliability
`pythonApi.scorePending()` is actually achieving from `ml-daily-ops` is the more likely
explanation — worth a dedicated ops investigation, out of scope for this design assessment.

**Consequence: BEAR's "ready" status is built on the same patchy history.** BEAR's 29
distinct-day, 3-episode readiness looks solid next to SIDEWAYS's 8/2, but a day-by-day breakdown
shows most of BEAR's post-06-13 "scored" days are single-digit-to-low-double-digit row counts —
technically nonzero, technically counted, but not remotely representative of that day's full
signal universe either. BEAR happening to clear the days/episode floor is more a function of it
having thin trickles on *more* individually-nonzero days than of the underlying data being more
complete or trustworthy. The whole per-regime AUC/readiness diagnostic should be treated as
provisional until the coverage gap is fixed and re-measured — this applies to all three regimes,
not just the one that prompted this investigation.

## Does more data (even with full coverage) actually resolve it? No — re-ran the episode math

Even using the *full* 26-day / 20,278-row population (not just the scored subset), the episode
count is still **2** (`count_episodes()`, 5-day gap rule) — identical to the narrow population.
Row-weighted concentration is worse than the raw day count suggests: **67.8% of all 20,278 rows
fall in a single 7-calendar-day window (2026-07-04 → 07-10)**. This is exactly the López de
Prado concurrency problem the 2026-06-21 doc's Data-sufficiency section described — a large row
count from massive same-day cross-sectional fan-out, correlated by market beta, collapsing to a
handful of genuinely independent observations. Fixing the scoring-coverage gap would give SIDEWAYS
more *rows*, but on the evidence of the current calendar distribution, not obviously more
*episodes* — the 2026-06-04→06-29 and intra-July gaps are structural (no signals were generated,
not just unscored), so "wait for more weeks" doesn't mechanically fix the independence problem
the way it did for BEAR (which organically accumulated a third episode over the same period).

**Purged walk-forward math (redone, current counts):** with 26 distinct days and a 15-day embargo
(the longest live horizon in this data) around an 80/20 chronological cut, the embargo window can
plausibly consume most of a 5-day test tail outright if the cut falls anywhere near the dense
07-04→07-10 cluster — there is no configuration of this specific calendar distribution that
yields a test set both (a) temporally posterior to train and (b) drawn from a different episode
than train. A purged walk-forward evaluation of a SIDEWAYS-only model on this data would either
be running on almost no test data, or silently leaking the one dense week across the boundary.
This is a harder version of the same conclusion the 2026-06-21 doc reached for the *global*
model's per-regime calibrators: SIDEWAYS (like BULL) cannot support a temporally-honest holdout
evaluation yet, regardless of row count.

## Decision (user-approved, 2026-07-18)

**Do not build Option C for SIDEWAYS now.** Not because the model provably lacks edge there —
because the evidence that would justify building it is itself compromised, and the underlying
calendar/episode structure can't yet support validating a per-regime model even if built. Building
on this data risks the exact failure mode this project has already paid for twice
(`ml_label_experiments`: triple-barrier label rejected on leak-adjacent evidence;
`signal_quality_diagnosis_2026_07`: emitted-signal geometry masked real model edge for weeks) —
shipping a change whose apparent justification doesn't survive scrutiny.

This is a "not yet" answer with a concrete trigger, not an indefinite deferral:

**Escalate to an actual Option C design only when both hold:**
1. The scoring-coverage gap is fixed (score-pending reliably covers ≥90% of each day's
   technical_signals universe going forward — verify via the day-by-day coverage query in this
   doc's Finding section, not just `regime_readiness()`'s day/episode counts, which don't measure
   coverage completeness).
2. SIDEWAYS *then* accumulates ≥3 independent episodes (matching BEAR's current bar) with the
   embargo-adjusted purged walk-forward math showing a non-degenerate test window — re-run this
   doc's episode/concentration analysis, don't just check `regime_readiness()['SIDEWAYS']['ready']`,
   since that flag doesn't currently account for row-concentration skew within an episode.

If SIDEWAYS's AUC is still ≤0.55 once both conditions hold, that is genuine escalation evidence
and a per-regime design (informed by the framework this doc started — separate model vs. hard
split, feature set, embargo sizing) should be written then, against clean data.

## Explicitly out of scope (this assessment)

- **Any Option C model code, feature selection, or architecture decision.** None of that is
  buildable against data this compromised; deferred to the future spec this doc's own trigger
  would commission.
- **Diagnosing/fixing the score-pending coverage gap.** Real, evidenced, and higher-priority than
  the Option C question that prompted this investigation, but it's an ops/reliability
  investigation, not a modeling design decision — separate scope, separate owner call.
- **Re-litigating BEAR's Option A calibration.** Still the right call per the 2026-06-21 doc's own
  logic (calibration only needs a base-rate estimate, not a temporally-honest holdout, and is
  provably a no-op when a regime doesn't clear the floor) — this finding doesn't undermine that
  decision, only flags that BEAR's AUC/readiness numbers deserve the same "provisional until
  coverage is fixed" caveat as SIDEWAYS's.

## Update (2026-07-18, same day): coverage gap fixed

Root cause found and fixed within hours of this doc: `load_pending_signals()`'s scoring-eligibility
query (`src/server/ml_ensemble.py`, both the Postgres and SQLite branches) had `AND
ts.signals_json IS NOT NULL` in its `WHERE` clause. Every row the full-universe grid-ensurer
(`backfill_technical_features.py --full-today`) writes correctly has `signals_json = NULL` (no
specific pattern matched — it's a feature-complete row for every liquid stock, not a signal hit),
so this filter silently excluded ~98% of the daily universe from ever being scored, starting
almost exactly when the grid-ensurer landed (2026-07-11) and volume outgrew the pre-existing
signal-only subset. Confirmed safe to remove: `load_training_data()`'s feature-building code
already treats a missing `signals_json` as `'[]'` (line ~886), so the filter was never protecting
against a real crash.

Fixed, verified, and cleared: removed the filter, ran two manual `ml_ensemble.run(do_score=True)`
passes (10,000 + 9,619 rows), confirmed **0 unscored rows remain** and **100% same-day coverage**
across all of July as of this fix. Also fixed the ops-monitor coverage stat itself
(`src/server/routers/monitor.router.ts`'s `ml-ensemble-score` case in `getScriptStats`), which was
computing an all-time average over the whole table — diluting a severe 3-week regression into a
still-decent-looking historical percentage, which is exactly why this went unnoticed. It now
windows to the last 7 days so a future regression is immediately visible instead of averaged away.

**This does not reopen the Option C question decided above.** The per-regime AUC/readiness
numbers in this doc are now known-stale (computed on the broken-coverage data) — a fresh read
should be taken only after enough post-fix trading days accumulate to matter, not immediately off
one day's backfill.

## Risks / notes

- If the scoring-coverage gap turns out to correlate with regime (e.g., scoring happens to run
  more reliably during volatile/BEAR-like conditions when someone's more likely to be watching
  the system), the "fix coverage, then re-measure" plan could still return a biased comparison
  across regimes even after the raw completeness problem is fixed. Worth a quick check when that
  investigation lands.
- The 10,000-row `LIMIT` in `ml_ensemble.py`'s score-pending query, combined with `ORDER BY
  ts.date DESC`, means a persistent backlog would perpetually favor scoring the newest unscored
  rows over clearing older debt — plausible partial explanation for why coverage never recovered
  after the 06-30 volume jump. Flagging for whoever picks up the coverage investigation, not
  concluding it here.
