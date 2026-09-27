---
paths:
  - "**/*.py"
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "scripts/**"
  - "migrations/**"
  - "db/**"
  - "**/*.sql"
  - ".claude/hooks/**"
  - "ecosystem.config.cjs"
---
# Recurring Bug Classes

Each of these has bitten this codebase **more than once**. Grep for the signature before you write, and again before you claim a fix is done. Full forensic detail (exact dates, investigation steps, specific numbers) for every entry below: `docs/recurring-bugs-history.md` (split out 2026-08-28 for length — that file is the derivation, this one is what to grep before writing).

**🤖 = enforced by `scripts/check_recurring_bugs.py`** (runs in CI on changed files). Everything unmarked is enforced only by you remembering to read this file — and the recurrence counts below were all recorded *after* the class was documented here, so assume prose alone does not hold. If you fix a class that recurs again, the durable move is a check in that script, not another paragraph here.

Currently automated (9 checks): `date.today()` write-anchor, short calendar-day read cutoff (`check_short_calendar_lookback`), raw `%s` placeholder, missing `live_datasource` test, `x != x` NaN test in SQL, multi-word `::` cast, skip-path-stamped-as-success (`.ts`, `check_skip_not_success`), unqualified `information_schema` query (`check_information_schema_missing_table_schema`), degraded-read `print()` to stdout (`check_degraded_print_to_stdout`). Also automated, in `verify-gate.mjs` rather than `check_recurring_bugs.py`: unmeasured signal/scoring changes require backtest evidence before "done" is accepted. (That class, and every other model/harness class, lives in `.claude/rules/ml-model-bugs.md`.) Deliberately not automated: `float(x or 0)` — measured at 50 matches repo-wide, mostly legitimate `None`→0 on DB aggregates; catching it needs type information the script doesn't have.

## Where each class lives (split 2026-09-26)

This file used to hold every class (~127 KB) and loaded on the first `.py`/`.ts` read. The classes now live in four area files, each with its own `paths:` scope, so Claude Code loads only the areas you touch. **Before writing code in an area, read its file** — the sections moved verbatim; nothing was dropped. A reference elsewhere to "recurring-bugs.md's X entry" means the section named X below.

| Section | File |
|---|---|
| Dates & scheduling | `bugs-data-layer.md` |
| NaN & null | `bugs-data-layer.md` |
| SQL dialect (`db_compat` / `sqlTranslate`) | `bugs-data-layer.md` |
| Writes & keys | `bugs-data-layer.md` |
| Signals, writes & job runtime | `bugs-jobs-runtime.md` |
| Provider identifiers, reverse maps and "the vendor is dead" (2026-09-12 pm2 warn/error sweep) | `bugs-data-layer.md` |
| Limits in the wrong unit, and orderings that are only a comment (2026-09-12) | `bugs-jobs-runtime.md` |
| Monitoring blind spots | `bugs-monitoring.md` |
| Noise floors, and metrics that overflow into a plausible wrong number | `bugs-monitoring.md` |
| Repairs, fallbacks and skip-lists that don't do what they say | `bugs-jobs-runtime.md` |
| Investigating production without breaking it | `bugs-testing-env.md` |
| Write amplification & memory on the hot paths (2026-09-11 performance sweep) | `bugs-data-layer.md` |
| Connection budgets | `bugs-jobs-runtime.md` |
| Automated bulk-edit passes | `bugs-testing-env.md` |
| Environment & deploy | `bugs-testing-env.md` |
| Placeholder credential in an executable alert path = registered-but-never-delivered monitoring (2026-09-14) | `bugs-monitoring.md` |
| Testing | `bugs-testing-env.md` |

When you add a class, put it in the area file whose `paths:` cover the code it bites, and add its row here.
