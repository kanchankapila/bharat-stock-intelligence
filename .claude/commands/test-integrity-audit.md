---
description: Sweep the 258 Python and 106 TypeScript test files for suites that are green while protecting nothing — tests that reimplement the logic under test, derive their expectation from the constant being tested, guard a hand-enumerated allowlist, or leak shared env state between workers
---

# Test Integrity Audit

`.claude/rules/recurring-bugs.md`'s "Testing" section documents six ways a suite here has been
**100% green while protecting nothing**, and the CLAUDE.md definition-of-done rule ("negative-control
your tests") exists because three separate suites were found in that state. `verify-gate.mjs`
blocks completion on tests-*passed*, which proves the code runs, not that any test would fail if
the bug came back. This audit is the only thing that asks the second question.

Scope: 258 `.py` tests under `src/server/tests/` + `src/server/__tests__/`, 106 `*.test.ts` under
`src/`. Sweep by signature; do not read all 364 files.

## 1. Tests that reimplement the logic under test

The highest-yield signature. A test that hand-copies the function's logic into the test file
passes identically against unfixed source — negative-controlling the *source* leaves it green
because the mirror never saw the fix or the bug. Happened 2026-08-13 to a regression test for
`screener_catalog_enricher.py`'s category-collapse bug, which had hand-copied the
`cat_norm`/`CATEGORY_DEFAULTS` resolution.

```bash
grep -rLn "^from src\.server\|^import src\.server\|from \.\." src/server/tests/*.py | head -40
```

For each test file, ask: **does it import and call the real function, or does it contain its own
copy of the rule?** A test whose body redefines a weight map, a polarity mapping, a threshold
table or a slug-normalisation is the finding. The fix is to extract the real logic into an
importable function (as `resolve_screener_defaults()` was) and call that.

## 2. Vacuous assertions

```bash
grep -rnE "assert all\(|assert not any\(|expect\(.*\.length\)\.toBe\(0\)" src/server/tests/*.py src --include=*.test.ts
```

`all([])` is `True`. A test that filters a collection down to candidates and then asserts a
property of the survivors passes when the filter returns nothing — which is exactly what happens
when the fixture stops matching. Every such test needs a companion assertion that the collection
is non-empty first.

Same class, different shape: a test that derives its expected value from the constant it is
testing (`assert score == WEIGHTS['x'] * 2` where the source computes `WEIGHTS['x'] * 2`) can
never fail. Grep for the module's own constants appearing on the right-hand side of an assertion.

## 3. Hand-enumerated allowlists

`screenerAppearedAt.test.ts` opened "pins that all three screener syncs record `appeared_at`" —
there were **four** writers, and the omitted one held 435,700 of the table's 741,251 rows. The
column was populated on 10 rows platform-wide while the suite stayed green.

Find every test containing a literal array of file names, writer names, job names, table names or
provider names, and check it against a live scan of the source tree. The fix is always the same:
derive the list by scanning (glob the writers, grep the INSERT call sites) and assert the scan
equals the allowlist, so adding a fifth writer **fails the test** instead of silently writing
NULLs forever.

## 4. Missing control assertions

A test that only asserts "the thing I excluded stayed out" passes identically against a filter
that excludes *everything*. This is how `reward_engine.py`'s dead `unified_signal_outcomes` UNION
half was found — the control assertion ("a non-technical source *should* change the weight")
failed, and nothing else would have caught it.

For every test asserting an exclusion, a filter, a veto or a gate: is there a paired assertion
that the **included** case actually does something? If not, that is the finding.

## 5. Shared-state leakage

```bash
grep -rn "^import 'dotenv/config'\|^import \"dotenv/config\"" $(find src -name "*.test.ts")
grep -rn "USE_POSTGRES" src/server/tests/*.py | grep -v fixture
```

A static top-level `import 'dotenv/config'` loads real credentials into `process.env` for the
whole vitest worker **at collection time**, even when the suite is `describe.runIf`-skipped — it
broke `niftytraderAuthService.test.ts`'s "no credentials configured" case this way. The fix is to
check the plain shell env var first and `await import('dotenv/config')` only inside that guard.
`USE_POSTGRES` is read fresh per call by the shared facade; a suite that sets it and doesn't pin
it in a fixture leaks to whichever file runs next.

## 6. Ungated live-network tests

```bash
grep -rLn "RUN_LIVE_DATASOURCE_TESTS" $(grep -rl "axios\|fetch(\|requests\.get\|curl_cffi" src --include=*.test.ts --include=test_*.py)
```

Any test hitting a real third-party endpoint without the env gate makes the suite fail on someone
else's outage — `mcapiProxy.test.ts` (28 cases) failed CI on 2026-08-11 with nothing in this repo
changed. A suite that fails on someone else's outage stops being a signal, and the pressure
becomes to ignore red CI rather than fix it.

## 7. Negative-control the highest-stakes suites

Pick the 3-5 suites guarding logic that would be most expensive to break silently (scoring
polarity, signal-source filters, PK/collision guards, the mirror-consistency suites). For each:
revert the fix it protects (`git stash` a targeted edit, or comment out the guard), confirm the
test **fails**, restore. A suite that stays green through this protects nothing, regardless of how
many assertions it has.

Do this for real, on a throwaway edit. Do not reason about whether it *would* fail.

## 8. Report

Per finding: file:line, which of the six signatures, and what the test would fail to catch. Rank
by blast radius of the unguarded logic, not by count. Then state which signatures were swept
repo-wide and which were sampled.

Where a test is worth fixing, fix it by making the test call the real code — never by loosening
the assertion. And per the definition-of-done rule, every test you touch here gets
negative-controlled before you call it done.
