---
description: Check BullMQ jobs and cron-scheduled scripts for silent budget-kill truncation, tail-of-script steps that never execute, and write-amplification patterns — the class of bug where the pipeline reports health while quietly producing nothing or costing far more than expected
---

# Job Runtime Audit

Read the "Writes & keys" and "Environment & deploy" sections of `.claude/rules/recurring-bugs.md`
first. This audit targets a specific bug family already found twice, both times by accident
rather than by a repeatable check: `extra_endpoints_fetcher.py` was SIGKILLed at its 30-minute job
budget every single night for weeks, silently before ever reaching `extra_features_parser.run()`
(its last statement) — the fetcher's own freshness check passed nightly (it *was* writing fresh
rows) while all 14 downstream `ext_*` feature columns sat at ~0% populated. Separately,
`marketsmojo_technical_fetcher.py` re-upserted each stock's entire ~9,900-row history nightly for
~13 genuinely new rows (721:1 write amplification), which made one symbol cost ~11s of DB time and
got the step killed at 12% of universe coverage — same failure shape, different cause.

## 1. Enumerate scheduled work

```bash
grep -n "runPython\|cronPattern\|addJob\|scheduleJob" src/server/queues.ts src/server/jobs/*.jobs.ts
```

Cross-reference against `jobRegistry.ts`/`monitorScripts.ts` per the existing
"mirror-consistency" concern in `recurring-bugs.md` — a `cronPattern` that drifted between the two
has caused phantom stale alerts before; confirm this audit isn't chasing a monitor bug instead of
a job bug.

## 2. Check for budget-kill truncation

For every `runPython()`/long-running step: what is its configured timeout, and does its own
recent log history show `Timed out after Nms (killed by timeout)` (or an equivalent kill signal)
on a **recurring** basis, not a one-off? A step that hits its budget occasionally under load is
normal; one that hits it every night is not "a bit slow" — treat it as "has never completed."

For any script that was found to be timing out: read what comes **after** the kill point in its
source. If a downstream parse/enrichment/write step sits at the tail of a script that reliably
dies before reaching it, assume that step has never executed, regardless of what the table's own
freshness check reports — the freshness check on the *producer's own table* cannot see whether
the *consumer* step at the end of the same script ever ran.

```sql
-- corroborate from the consumption side: are the downstream columns actually populated?
SELECT column_name FROM information_schema.columns WHERE table_name = '<target_table>';
-- then, per column the tail step is supposed to write:
SELECT COUNT(*) FILTER (WHERE <col> IS NOT NULL) * 100.0 / COUNT(*) AS pct_populated
FROM <target_table> WHERE date = (SELECT MAX(date) FROM <target_table>);
```

## 3. Check for write-amplification on incremental fetchers

For any fetcher hitting a per-symbol/per-entity API with no `since`/incremental parameter: does
the writer re-upsert the full response every run, or does it read `MAX(date)`/a high-water mark
per key first and skip what's already held? Measure the ratio directly rather than assuming:

```sql
-- rows written this run vs rows that were actually new (requires a run-tagged column or before/after count)
SELECT COUNT(*) FROM <table> WHERE <write_timestamp_col> >= '<run_start>';
-- compare against genuinely new content, e.g. distinct (symbol, date) pairs not present before the run
```

A healthy fetcher's write count should track its *new* content, not its full historical payload.
If a single symbol's write time is disproportionate to its row *growth*, this is very likely the
same shape as the MarketsMojo incident — check whether the step is getting killed partway through
the universe as a result (12% coverage before the timeout, in that case).

## 4. Check the skip-path-vs-success collision, orthogonal to the above

This is `recurring-bugs.md`'s own `check_skip_not_success` class (already automated in
`check_recurring_bugs.py` for `.ts`) — confirm it's not silently reintroduced in any script this
audit touches, and check whether the same shape exists in a **Python** job runner path the
automated checker doesn't scan (the checker note says `.py` coverage there is unconfirmed for this
specific pattern — verify by reading, don't assume the `.ts` checker's coverage extends to it).

## 5. Report

Per job: configured budget vs measured typical/worst runtime, whether it has been observed hitting
the budget, what (if anything) sits after the kill point and whether that code path is provably
dead, and — for incremental-shaped fetchers — the measured write-to-new-content ratio. Prioritize
by what's downstream: a truncated tail step feeding `ml_ensemble.py`/`unified_ranker.py` outranks
one feeding an unused table.
