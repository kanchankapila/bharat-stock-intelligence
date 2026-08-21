---
name: verify-gate-runner
description: Run all three verification gates (tsc, vitest, pytest) in sequence and report pass/fail status
disable-model-invocation: false
user-invocable: true
---

# Verify Gate Runner

Runs the three mandatory verification gates used by `verify-gate.mjs`:

1. **`npx tsc --noEmit`** — TypeScript type checking (TS/TSX files changed)
2. **`npx vitest run`** — Vitest unit tests (TS/TSX files changed)
3. **`python -m pytest src/server/__tests__/ src/server/tests/`** — Python integration tests (PY files changed)

Plus, for signal/scoring logic changes:
4. **`python src/server/factor_backtest.py`** — Measurement gate (only if touching unified_ranker.py, scoring_engine.py, etc.)

## Invocation

**User**:
```bash
/verify-gate-runner
```

**Claude** (internal):
```
I'll run the verification gates to confirm the changes pass all validation.
```

## What It Does

1. **Detects changed files** via `git diff --name-only HEAD`
2. **Classifies changes**: distinguishes code (*.py, *.ts, *.tsx) from docs/config
3. **Runs required gates** based on what changed:
   - Changed `.ts` or `.tsx` → run tsc + vitest
   - Changed `.py` → run pytest
   - Changed signal/scoring logic → run factor_backtest.py (or update measurement.md)
4. **Reports status**:
   - ✅ Pass: gate ran and exited 0
   - ❌ Fail: gate ran but exited non-zero (real failure)
   - ⏭️ Skipped: gate not applicable to the changed files
   - ⚠️ Missing: gate should have run but didn't

## Exit Codes

- **0**: All applicable gates passed
- **1**: One or more gates failed or are missing
- **2**: Cannot determine (git unavailable, transcript unreadable)

## Example Output

```
Verify Gate Runner Report
========================

Changed files: 35
  - TypeScript: 30 files
  - Python: 5 files
  - Signal/scoring surface: NO (no risk to measurement)

Gates Status:
  ✅ tsc --noEmit                          PASS (0.2s)
  ✅ npx vitest run                        PASS (27.96s, 1066 passed)
  ✅ python -m pytest src/server/...       PASS (9m 41s, 2097 passed)

Result: ALL GATES PASSED ✅

Ready to commit.
```

## When to Run

- **Before committing**: Ensure all changes pass validation
- **Before pushing**: Double-check remote-push readiness
- **On demand**: Run anytime to verify current state
- **In CI**: Automated by verify-gate.mjs hook (this skill is its manual equivalent)

## What It Verifies

### TypeScript Gate
- No type errors in `.ts` or `.tsx` files
- Catches: type mismatches, missing imports, incorrect prop types

### Vitest Gate
- All unit tests in `src/**/__tests__/**` pass
- Catches: logic errors, broken tests, API contract violations

### Pytest Gate
- All Python tests in `src/server/__tests__/` and `src/server/tests/` pass
- Catches: ML logic errors, SQL dialect issues, fixture failures

### Factor Backtest Gate (optional)
- Measurement evidence for signal/scoring changes
- Triggers when: unified_ranker.py, scoring_engine.py, factor_backtest.py, etc. changed
- Catches: unmeasured scoring changes that gate is designed to prevent

## Troubleshooting

**All gates pass but verify-gate.mjs still blocks?**
- Check: did you change measurement.md or measurement-history.md to document a scoring change?
- The gate allows skipping backtest if measurement docs are updated

**Pytest hangs or times out?**
- This is normal for Postgres integration tests (~10 minutes)
- Check: is POSTGRES_URL set and reachable?
- Run: `npx pm2 logs ml-api` to see if the database is responding

**Vitest fails but same test passes locally?**
- Check: did you edit a fixture or conftest file?
- Vitest runs a throwaway Postgres schema; schema drift can cause isolated failures
- Run: `npm run schema:drift` to regenerate the throwaway schema

## Integration with verify-gate.mjs

This skill is a **manual companion** to the `verify-gate.mjs` hook. The hook:
- Runs automatically at commit time
- Reads the transcript to check if gates passed
- Blocks completion if gates are missing or failed

This skill:
- Lets you run gates on demand (before committing)
- Gives full output and pass/fail status
- Helps debug gate failures interactively

Both use the same gate logic. Passing this skill means verify-gate.mjs will also pass.
