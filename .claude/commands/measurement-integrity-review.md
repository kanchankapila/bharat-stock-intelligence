---
description: Sanity-check a backtest, accuracy, win-rate, or IC number (or the script that produced it) against measurement.md's panel spec before it gets cited as evidence
---

# Measurement Integrity Review

Read `.claude/rules/measurement.md` in full first — the panel spec, the "already tested" table, and the banner at the top exist because this exact class of mistake has produced confident, wrong numbers in this repo repeatedly (a pooled +0.798% that was really +0.098% t=1.22; a −3.44 t-stat that was really −1.28 once the provenance filter was fixed; two separate `factor_backtest.py` benchmark bugs that made dead factors look alive for weeks). This review is for **any** new accuracy/win-rate/IC/backtest claim, and for **any** script that claims to measure or verify one — not just ranker changes.

## 1. Is this measurement even real?

Before checking the *methodology*, check the script **executed a query**. Grep the script's own diff for `db_compat`/`psycopg2`/an ORM import, and confirm at least one `.execute()`/`.query()` call happens **before** any number gets formatted into the output. A script whose numbers exist before any query runs is fabricated, not measured — this happened in this exact repo on 2026-08-12: 5 of ~12 new "audit"/"backtest"/"verification" scripts had zero DB connections despite docstrings claiming to use production Postgres, one with a comment admitting `# Mocking comprehensive integrity checks`, hardcoded numbers off by ~22,500× a real measured figure. **A script that prints a plausible number and a success message, with no query behind it, is worse than no measurement** — it produces evidence-shaped output that gets committed and cited.

Tell: does the number change if you point the script at an empty/different DB? If not, it isn't measuring anything.

## 2. The panel spec, checked line by line

For any cross-sectional forward-return claim:

- **Per-date, then averaged.** If the script pools across dates before computing significance, the result is untrustworthy regardless of what it shows — this has flipped or inflated a conclusion three separate times here.
- **Winsorised**, not raw means. A single `+127,900%` bar has produced a phantom edge before.
- **`is_suspect = 1` filtered out.**
- **≥₹1cr ADT liquidity floor applied.**
- **Next-day OPEN entry**, not same-day close — a signal computed off a close can't be bought at that close.
- **`label_definition` checked before comparing any two win rates.** `terminal_pct2` and `path_barrier` are not comparable even over the identical calendar window (41–44% vs 88–91%, same underlying dates).
- **`signal_source` checked before joining `signal_outcomes`.** Three writers share that table; an unfiltered join can pair an outcome with an unrelated signal's features.
- **Datasource span judged by dates PER SYMBOL and DENSE span**, never raw `min(date)`/`count(DISTINCT date)` over the whole table — both have produced a false "enough history" read here.
- **Graded against BOTH tails**, not just AUC-vs-winners, if it's a classifier claim — an AUC computed only against winners can't distinguish "predicts winners" from "predicts volatility," and this codebase has been fooled by exactly that twice.

## 3. Is this actually new?

Check the claim against the "already tested" table in `measurement.md` before spending time re-deriving it. If it's a re-test of something already there, state explicitly what's different this time (more history, a different horizon, a different construction) — re-running an unchanged test and getting a different answer is itself a finding (see the `insider_net` t=2.05→1.73 non-reproduction), not something to quietly overwrite.

## 4. Negative control

For a fix to a backtest/measurement script itself (not signal logic): reproduce at least one *already-known* result with the fixed harness before trusting any *new* result it produces. Both `factor_backtest.py` bugs were in the measurement tooling, not the thing being measured — a bug here is worse than no measurement because it looks like evidence in either direction (inflating a dead factor, or deflating the whole universe).

For a fix to signal/scoring logic: revert it, confirm the test that's supposed to catch the bug actually fails, restore. A green suite that was never run against the unfixed code protects nothing — this is the same failure mode as `verify-gate.mjs`'s existence: tests-passed proves the code runs, not that its output is any good.

## 5. Report

State the corrected number plainly, with the sample size (date count, not row count — row count inflates by the number of names per date). If the finding contradicts something in `measurement.md`'s "Known state of the edge," that file needs updating in the same session — an unmeasured signal/scoring change merged without updating measurement evidence is exactly what `verify-gate.mjs` is designed to block, and what got three prior changes (PEAD boost, delivery-in-ranker, screener-sentiment) rejected post-hoc instead of caught up front.
