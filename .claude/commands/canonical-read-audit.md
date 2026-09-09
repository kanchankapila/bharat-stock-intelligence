---
description: Check every dashboard shell and every scoring/ranking-shaped tRPC procedure against scoring-authority.md's rule that UI reads must not bypass the canonical unified_recommendations table
---

# Canonical Read Audit

Read `.claude/rules/scoring-authority.md` in full first, specifically the line that
"consolidation" means "keeping UI reads from bypassing the canonical table, not deleting the
input tables." Nothing currently checks that this actually holds across the frontend —
currently one v1 shell (`AppShell` via `V1Routes`; former v2–v6 folded into
`src/components/v{2,4,5,6}/` since the 2026-08-29 consolidation). Also skim
`.claude/rules/measurement.md`'s "Known state of the edge" — a surface built
on an input that file has already measured as null-to-negative or inverted is a finding here,
even if it's technically "the ranker's own input," because a user looking at that surface has
no way to know it's not the canonical ranking.

## 1. Enumerate every score/ranking-shaped surface

Every page renders through the single v1 shell — `src/App.tsx` force-migrates `dashboardVersion`
to `'v1'`, and the pre-consolidation shells (`V2AppShell`, v4, v5's old route tree, `V6Shell`)
exist only as components under `src/components/v{2,4,5,6}/`. Enumerate across the live routes
and the shared `src/components/` pool:

```bash
grep -rlE "score|rank|recommendation|classification|conviction|screener" src --include=*.tsx \
  --exclude-dir=server
```

For each hit, find what tRPC procedure(s) it actually calls (`trpc\.[a-zA-Z0-9_.]+`) and trace
that procedure's server-side implementation to the table(s) it queries.

## 2. Classify each surface

- **Reads `unified_recommendations` (or `unified_recommendations_history`) directly, or via
  `getTopRatedStocks`/`getStrategyStocks`'s documented fallback pattern.** Compliant.
- **Reads `stock_scores` or `quant_scores` directly, bypassing the ranker.** Flag — these are
  documented *inputs*, not a substitute UI source, unless it's the explicit cold-start fallback
  path already carved out in `scoringService.ts`/`quantScoringService.ts`.
- **Reads a screener/scanner table (`screener_catalog`, `screener_appearances`,
  `trendlyne_screener_stocks`, etc.) and presents it as a signal/consensus/ranking**, not
  explicitly labeled as raw screener membership. Cross-check against `measurement.md`: bullish
  screener consensus is IC −0.027 (t=−2.36), sentiment labels are inverted (t=−4.61), and 0 of
  1,563 individual screeners survive FDR/Bonferroni. A surface presenting this as "signal" or
  "consensus" to a user is presenting a measured-negative input as if it were the platform's
  best call.
- **Reads something else entirely** (raw OHLCV, a single non-ranking table) — not in scope here.

## 3. The frontend has ONE landing shell since the 2026-08-29 consolidation

`App.tsx` force-migrates any stored `dashboardVersion` to `'v1'` on mount, and every page renders
through `V1Routes` inside `AppShell`; the former v2–v6 shells were folded into
`src/components/v{2,4,5,6}/`. Trace the v1 pages' tRPC calls explicitly, list every procedure they
make, and state plainly whether `unified_recommendations` appears anywhere in that call graph. If
it doesn't, that is the headline finding, not a footnote. (There is no `V6Shell` / `src/v6/` /
`dashboardVersion` switching left to check for — those references predate the consolidation.)

## 4. Cross-check the orphaned-procedure surface

Diff the set of procedures defined across `src/server/routers/*.ts` against every procedure
name actually referenced anywhere under `src/*.tsx`/`src/*.ts` outside `src/server/`:

```bash
grep -rhoE '^\s{2}([a-zA-Z0-9_]+):\s*(publicProcedure|protectedProcedure)' src/server/routers/*.ts \
  | sed -E 's/[: ]*(publicProcedure|protectedProcedure)//' | tr -d ' ' | sort -u > /tmp/procs.txt
while read p; do
  grep -rqF "$p" src --include=*.tsx --include=*.ts --exclude-dir=server 2>/dev/null || echo "$p"
done < /tmp/procs.txt
```

For each orphan, check whether it's dead API surface (never wired to any UI — candidate for
removal or a genuinely missing surface) versus something legitimately server-internal (used only
by another server module, a cron job, or the chatbot/MCP tool layer) — grep `src/server/` and
`mcpServer.ts` before concluding "orphaned."

## 5. Report

One table: surface (shell + component/page), procedure called, table read, classification
(compliant / bypasses ranker / presents a measured-negative input as signal). Lead with the
default-shell finding. Close with the orphaned-procedure count and a short list of the highest-risk
ones (anything whose name implies scoring/ranking, since an orphaned scoring procedure is exactly
the shape of "a parallel final score nobody wired up" that `scoring-authority.md` warns against
inventing).
