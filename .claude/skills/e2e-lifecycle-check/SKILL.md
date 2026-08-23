---
name: e2e-lifecycle-check
description: Run one end-to-end lifecycle check over 10 real stocks (default, the day's top movers inside the tradeable universe) — every scoring engine, the ML ensemble, the RL Q-table/gate, the reward engine, outcome resolution and the canonical ranker — and report per-stage PASS/FAIL plus the final Buy/Sell/Hold for each name. Use when asked to "run an end-to-end test", "check the whole pipeline works", "smoke-test the scoring/ML/RL stack", "does the system still produce recommendations", or after a deploy/restart/migration that touched the scoring or ML path.
---

# End-to-end lifecycle check

One command, from the repo root, ~2–4 minutes:

```powershell
backend-python/venv/Scripts/python.exe src/server/e2e_lifecycle_check.py --n 10
```

Exit 0 = PASS, exit 1 = FAIL. `--json out.json` writes the full report. Use the venv, not bare
`python` — that is a different install with a different sklearn.

## What the pass condition actually is — read this before quoting a green run

**"It printed Buy/Sell/Hold" is NOT the pass condition, deliberately.** On 2026-08-17 one
missing advisory table made `unified_ranker.run()` classify the **entire universe as Hold and
exit 0** (`recurring-bugs.md`, the `except Exception: pass` / aborted-transaction entry). Hold
is a valid label, so any check that stops at "we got a label" reports green on exactly that
failure.

The verdict is **per stage, on three axes**, because each catches a failure the others read as
healthy:

| Axis | Reading | Verdict |
|---|---|---|
| **alive** | map empty universe-wide, or collapsed below 100 symbols | **FAIL** |
| **alive** | `_degraded_count` rose — a getter swallowed an exception and still returned data | **FAIL** |
| **fresh** | newest row older than the stage's tolerance (daily tables 5d, RL/reward 10d) | **FAIL** |
| **coverage** | symbol absent from a live, fresh stage | reported, **not fatal** |

Freshness is not decoration: `COUNT(*) > 0` only asks "did this table ever have a row", so a
pipeline dead for a month passes it and still prints Buy/Sell/Hold for all 10 names — the "a
fresh table is not a delivered feature" class, inverted. Coverage is separated from aliveness
because a live stage legitimately has no row for every name; collapsing the two makes the check
useless in both directions.

**This is a plumbing check, not an edge check.** A green run says every stage produced current
values. It says nothing about whether they predict anything — `unified_score`'s 5d rank IC is
~0.0001 (`.claude/rules/measurement.md`). Never cite a PASS here as evidence of accuracy.

## What it covers (27 stages)

Calls `unified_ranker.py`'s **own** getters rather than reimplementing their SQL (a test that
reimplements the logic under test passes against the unfixed source):

- **8 blended engines** — ml, cs, confluence, technical, dl, breakout, smart_money, screener
- **ML** — `win_probability` (ml_ensemble), `feature_store`, `engine_composite_scores`
- **RL** — `rl_q_table`, `rl_episodes`, and `_passes_rl_gate` per symbol (who got excluded)
- **Reward engine** — `signal_type_weights`, `signal_source_weights`
- **Outcome resolution** — `signal_outcomes`, `signal_excursions.tb_label`
- **Other scoring authorities** — `stock_scores` (scoring_engine), `quant_scores`, multi-factor,
  `unified_signals`, event triggers
- **Canonical output** — `unified_recommendations` classification / conviction / score

Symbol selection is the day's biggest movers **inside `_restrict_to_tradeable_universe`**, with
`is_suspect` excluded and a turnover floor. Raw top movers are illiquid microcaps the ranker
correctly refuses to rank, so selecting that way self-selects names that "fail" for reasons that
are the pipeline working as designed. `--symbols RELIANCE,INFY` overrides.

## Not covered — say so rather than implying otherwise

- **No training paths.** `dl_engine --mode train` is a ~10h LSTM; `ml_ensemble --train --tune`
  is hours. This checks that trained models are *producing*, not that they retrain.
- **`quant_scores` is written by `quantScoringService.ts`.** A Python trace verifies the row,
  it can never produce it.
- **No engine takes `--symbols`**, so "run the lifecycle for 10 stocks" is universe-wide or
  nothing. Default is a read-only trace of what the scheduled pipeline already produced.
  `--run-ranker` re-runs `unified_ranker.py` first — a **production write** (it appends a
  snapshot to `unified_recommendations_history`), which is why it is opt-in; a non-zero exit
  from it is itself a FAIL.

## Reading a FAIL

- **Many stages failing together is usually ONE cause** — an aborted transaction poisons every
  later query on the connection, or one upstream table is missing. Fix the first failure listed
  and re-run; the script says this too.
- `DEGRADED` prints the getter's own swallowed error next to the stage. That message is the
  diagnosis; start there, not with the stage name.
- A single stage failing right after a slow run is worth one re-run before investigating —
  `_get_confluence_scores` alone takes ~15s over `confluence_signals`' 4.5M rows, and heavy DB
  contention has made it degrade once. The script's `statement_timeout` is 180s for that reason.
- `input:event_triggers` reporting `date=<older> (NOT <session>)` is normal, not a failure:
  `event_triggers.py` writes after the ranker's 07:30 IST run, so the advisory disclosure is a
  day behind. It only fails if the table has nothing within 5 days at any date.
- Coverage gaps concentrate on names with no `technical_signals` row (the daily grid did not
  reach them). That is a data-coverage question for `backfill_technical_features.py`, not a
  broken stage.

## After a FAIL

Do not stop at reporting it — the `audit-loop` skill applies. Trace the first failing stage
against live data (`measurement.md`'s reverse-engineering rule), fix it, re-run this check, and
only then call it closed.

## Maintaining this

The verdict logic lives in one pure function, `stage_verdict()`, pinned by
`src/server/tests/test_e2e_lifecycle_check.py` (13 tests, no DB, negative-controlled: deleting
the degraded and stale branches fails 3 of them). Change the tolerances there, not inline.
