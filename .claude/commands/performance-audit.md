---
description: Find and fix real performance bottlenecks on this single-box stack — write amplification, missing resumability, work after a kill point, subprocess pool starvation, duplicate scheduled runs — with a measured before-number for every claim
---

# Performance Audit

**The workload is a SINGLE BOX**, and every recommendation must fit it: 24GB RAM, WSL2 capped at
14GB, TimescaleDB tuned `TS_TUNE_MEMORY=6GB` / `TS_TUNE_NUM_CPUS=4` / `max_connections=60` /
`shm_size=1gb` / `work_mem=32MB`. Optimize for this, not for horizontal scale.

`/job-runtime-audit` covers the budget-kill and write-amplification classes in depth — run it
first if the symptom is a job. This command is the broader sweep.

## Known-real bottleneck classes — check these before profiling anything new

1. **Write amplification on per-symbol full-history fetchers.**
   `marketsmojo_technical_fetcher` re-upserted each stock's ~9,900-row history nightly to gain
   ~13 new rows — measured **2,010,101 writes for 2,787 genuinely new ones (721:1)** against a
   3.4GB table, ~11s of DB time per symbol, step killed at 12% of the universe. **It looked
   healthy from outside** (rows written was in the millions). The fix is on the WRITE side, not
   the fetch side — read `MAX(date)` per key once and skip what you already hold. Audit every
   fetcher that pulls a full series per symbol: *what fraction of each response is actually new?*
   If <1%, the upsert is the bottleneck.
   ⚠ When adding such a guard, use `key in known and known[key] == value`, **not**
   `known.get(key) == value` — the bare `.get()` form can't distinguish "never written" from
   "stored as NULL" and silently skips the first write forever.

2. **No resumability.** `trendlyne_adv_tech_fetcher` had no "skip what's already done today"
   check, so every catch-up retry re-fetched the whole ~2,200-stock universe: **24 of 31 runs
   killed by the 40-min timeout, zero successes in 11 days** — while the endpoint and the
   fetcher's own logic both measured healthy in isolation (300/300 stocks, ~2.5 min projected).
   Lack of resumability compounds whatever the real cause is into total failure instead of
   graceful degradation. **Tell:** a `job_heartbeat` row with `fail_count` approaching
   `run_count` and `last_success_at` far behind `last_run_at`.

3. **Work after a kill point never runs.** A step at the END of a script that reliably hits its
   time budget has never executed. 419MB of responses accumulated while every `ext_*` column sat
   at ~0%, and the producer's own freshness check passed nightly throughout. Grep logs for
   `Timed out after Nms (killed by timeout)` on a **recurring** basis, then read what follows the
   kill point in that script's source.

4. **Subprocess pool starvation.** `pythonRunner.ts` has a shared `MAX_PYTHON_CONCURRENT=5`. One
   `dl_engine.py` LSTM run held a slot for **10h12m**. Measure real slot occupancy before blaming
   a slow fetcher for its own timeout.

5. **Duplicate scheduled runs.** `addJobWithCatchup`'s guard matched on `data.isCatchup` alone, so
   a restart during a legitimate long run queued a duplicate behind it — `ml-daily-ops` ran its
   entire ~120-step chain twice in a day (**49% job-level fail rate, 44/89**; 129 catch-up events
   logged since 2026-07-25). For `trendlyne-midweek` it burned a finite per-session WAF request
   allowance three times over on one Wednesday.

6. **Local-LLM reload tax.** `keep_alive: 0` forced a full unload+reload between calls. A cold
   `mistral` load is **~20.5s** (`load_duration` ≈99% of `total_duration`; `eval_duration` ≈40ms),
   and both `auditor_agent.py` and `strategist_agent.py` call it once **per timeframe** in a loop.
   Any "unload immediately" flag on a repeatedly-called local endpoint is this bug.

7. **N+1 queries** inside symbol loops across ~140 fetchers and ~30 engines. `reward_engine`'s
   regime/sector lookups were one such, since batched.

8. **Frontend** — six lazy-loaded shells reading the same tRPC surface. Look for duplicate or
   uncoordinated queries across shells, missing memoization on ~2,400-row tables, unvirtualized
   lists. **Name which shell** (`/shell-parity-audit`): "mirrored into the other shells" has been
   a false claim before.

## Method — mandatory

- **Measure first.** Produce a before-number from live production for every claim. An
  optimization with no before/after measurement is a guess with a diff attached.
- Query work: `pg_stat_statements`, `EXPLAIN (ANALYZE, BUFFERS)`.
- Job work: `job_heartbeat` (`run_count`, `fail_count`, `last_success_at`, `last_run_at`).
- **`SET LOCAL statement_timeout` on every investigative query.** A client-side `timeout` orphans
  the backend query rather than cancelling it — that exact mistake produced a *wrong performance
  conclusion* here ("TimescaleDB decompression is too slow") from self-inflicted lock contention;
  after cancelling the orphan the same `count(*)` returned in **0.7s**. See `/production-debug`.
- Several tables are **compressed hypertables** — a predicate-wide `UPDATE`/`ADD CONSTRAINT` will
  fail or destroy compression. Check before proposing an index or a backfill.

## Guardrails

- **Do not change any score, weight, threshold, or classification while "optimizing."** If the
  diff touches `unified_ranker.py`, `scoring_engine.py`, `factor_backtest.py`,
  `multi_factor_scorer.py`, `institutional_quant_engine.py`, or `quantScoringService.ts`,
  `verify-gate.mjs` requires backtest evidence.
- **Do not batch a sequential loop without finding out why it was sequential** — rate limits, WAF
  request allowances, and provider politeness are real constraints here, not oversights.
- Do not add caching in front of a correctness bug.

## Deliver

1. **Bottleneck table**: component | measured cost (**with the query that measured it**) |
   estimated gain | risk.
2. **Ranked fixes by (gain ÷ risk)**, not by how interesting they are.
3. Production-ready diffs for the top items.
4. **After-measurements from live**, proving each one.
5. What you did **not** touch, and why.
