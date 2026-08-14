---
description: Given a feature or fix, determine which of the six coexisting dashboard shells actually have it, which shell a fresh visitor sees, and whether a claimed "fix applied to the nav/shell" landed where it was said to
---

# Shell Parity Audit

Read the "Frontend versions" table in `CLAUDE.md` first. Six dashboards coexist in one app —
v1 (`AppShell`), v2/v3 (`V2AppShell`, v3 restyled), v4 (inside `V2AppShell`), v5 (own route tree
at `/v5`), v6 (`V6Shell`, **default via `App.tsx`'s `dashboardVersion` fallback**). Nothing is
deprecated. CLAUDE.md states outright: "a comment saying it was mirrored has been wrong before."
This audit exists because there is currently no repeatable way to check that claim other than
reading all six shells by hand each time.

## 1. Identify the shell(s) in scope

If auditing a specific feature/fix: grep for the component/procedure/string involved across all
shell roots (`src/components/AppShell.tsx` or equivalent for v1, `src/v2`, `src/v3`, `src/v4`,
`src/v5`, `src/v6`) plus the shared `src/components/` pool each shell may pull from.

If auditing generally (no specific feature named): enumerate the full set of features/pages each
shell exposes as the baseline, so future feature-specific audits have something to diff against.

```bash
for d in src/components src/v2 src/v3 src/v4 src/v5 src/v6; do
  echo "=== $d ==="; find "$d" -name '*.tsx' | xargs grep -l "<feature-string>" 2>/dev/null
done
```

## 2. For each shell, answer three questions

- **Does this shell's own tree contain the feature**, or does it only reach it via a shared
  `src/components/` import? (A shared component being fixed does NOT mean every shell that
  imports it re-renders correctly — check the shell actually imports the current version, not a
  local fork; grep for a same-named file inside the shell's own directory that might shadow the
  shared one.)
- **Does this shell's data source match** (same tRPC procedure, same table per
  `/canonical-read-audit`'s classification) or has it drifted to a different endpoint over time?
- **Is this shell reachable from a fresh visitor**, or only via manual `localStorage`
  `dashboardVersion` override? (Only v6 is reachable by default — say so explicitly for any
  fix that only landed elsewhere.)

## 3. Verify a "mirrored" claim, don't take it on faith

If the task at hand is confirming a prior claim that a fix was "mirrored across shells" or
"applied to the nav": read the actual diff/commit for every shell claimed, not just the one that
prompted the claim. A comment saying it was mirrored is not evidence it was — verify each file
individually. If using `run-bharat-stock-intelligence`'s driver, load each shell (via
`localStorage.dashboardVersion`) and screenshot to confirm visually, not just via source grep —
source-level "the string exists" can pass while a build/import error silently drops the change in
one shell only.

## 4. Report

A shell × feature grid: for each of v1–v6, present/absent/shared-only, with the deciding file
path. Flag explicitly: (a) any shell claimed-fixed that isn't, (b) any drift in which table/
procedure a shell reads relative to the others for the "same" feature, (c) whether the default
shell (v6) specifically has parity, since that's what most users actually see regardless of what
the other five look like.
