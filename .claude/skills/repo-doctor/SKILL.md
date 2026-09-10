---
name: repo-doctor
description: ONE consolidated health check across codebase, database, frontend and logs — run this instead of ad-hoc sweeps whenever the user asks to "make sure no errors are coming anywhere", before commits/deploys, after incidents, or as a session start/end gate. Encodes every recurring bug class the repo has seen as an executable check; FAIL = regression-guard breach that must be fixed before commit, WARN = documented-benign or trend-watch.
---

# Repo doctor

Single entry point for "is anything wrong anywhere". Replaces the per-lane ad-hoc sweeps that
used to be re-invented every session (and that each missed what the last one had learned).

## Run it

```bash
node .claude/skills/repo-doctor/doctor.mjs          # quick: static checks + DB + logs (~seconds)
node .claude/skills/repo-doctor/doctor.mjs --full   # also tsc --noEmit + vite build
```

Exit code 0 = clear (WARNs allowed), 1 = at least one FAIL.

## How to read the output

- **FAIL** — a known bug class has RECURRED or its immunization was removed. Fix before
  committing anything. Examples: the dead `winProbability` digest gate resurrected; a test file
  driving `registerJob` without mocking telegramService; the Telegram 429 retry removed;
  `fake-queue` rows in production state.
- **WARN** — one of three kinds, each says which in its detail text:
  1. *documented-benign* (vendor blocks: Trendlyne WAF captcha, NiftyTrader
     budget/unauthorized, MarketsMojo crawls — these self-clear; see `data-sources.md`),
  2. *trend-watch* (`ur-engine-dispersion-collapse`: per `measurement.md` the ml-engine
     collapse is isotonic calibration working as intended — do NOT "fix" it; watch the rate
     and the retrain freshness instead),
  3. *genuinely new* — root-cause it now (see `.claude/commands/production-debug.md`).
- **SKIP** — `--full`-only checks not run; run `--full` before any commit that touches
  `src/server` or frontend code.

## What it covers (four lanes)

1. **Code** — regression guards for every AF fix that has a static signature (429 retry,
   VITEST send-guard, per-test telegram mocks, scan-digest gate, benign-stderr classifier,
   vite watch-ignored), plus heuristics for the three named recurring classes: "notification
   gate reads a field its pipeline never populates", "SQLite-only SQL in server TS", and
   "a job name logged 'failed' from more than one literal call site" (double-counts every
   real failure — see `recurring-bugs.md`, AF-20260910-01).
2. **Frontend** — shell presence; `--full` runs `tsc --noEmit` + `vite build`.
3. **Database** — heartbeat freshness for the key jobs (epoch math — job_heartbeat stores
   naive-UTC; never `AT TIME ZONE` it), 7d fail-rates, 48h unexplained failures vs the
   known-benign vendor classes, DQ latest-per-check, dispersion trend, producer freshness
   (engine_composite_scores / recommendations / research reports), test-fixture
   contamination, Telegram settings, GEMINI key.
4. **Logs** — today+yesterday error lines grouped by normalized signature; anything not
   matching a known-benign class is surfaced for root-causing.

## Extending the registry (mandatory)

When any check FAILs and you root-cause a NEW bug class:
1. Fix the instance.
2. Add a named check to `doctor.mjs` that would have caught it — with a negative control
   (healthy code must not trip it; see how `scan-digest-gate` greps for the exact dead-gate
   string rather than any `winProbability` mention).
3. Add the class to `.claude/rules/recurring-bugs.md` with its tell and fix.
4. File the instance in `docs/audit-findings.md` with an `AF-YYYYMMDD-nn` ID.

A class that lives only in someone's memory WILL recur — the repo has already proven this
six times (skip-as-success, 429-as-final, dead gates, timeout-by-guess, exact-case filters,
unmocked network side effects in tests).
