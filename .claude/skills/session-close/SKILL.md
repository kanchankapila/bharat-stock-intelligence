---
name: session-close
description: Run this repo's "Closing a session" checklist from CLAUDE.md — append docs/session-log.md, update the memory index at C:\Users\amitk\.claude\projects\d--Github-bharat-stock-intelligence\memory\, and check whether a bug class belongs in .claude/rules/recurring-bugs.md — against what this session actually changed, not from memory of the checklist. Use at the end of a substantive session, or when asked to close out / wrap up / log this session.
---

# Session Close

CLAUDE.md's "Closing a session" section is a 3-step checklist that exists because — per its own
last line — "silence in any of these means a future session rediscovers the same thing from
scratch." Nothing enforces it automatically the way `verify-gate.mjs` enforces tests; it only
happens if it's actually run. Do all three against the real diff, not a summary of the diff.

## 0. Establish what actually happened this session

```bash
git status
git diff --stat HEAD
git log --oneline @{upstream}..HEAD 2>/dev/null || git log --oneline -10
```

Don't rely on your own running memory of the conversation for this — re-derive it from the diff
and commits, the same "reverse-engineer against what actually happened" discipline
`measurement.md` applies to signal claims. A session that felt like "just a small fix" can still
span several files; check before deciding this skill isn't worth running.

## 1. `docs/session-log.md`

Append (don't rewrite) an entry for what changed and, more importantly, *what was learned* —
a bug found, a hypothesis rejected, a measurement taken. Match the existing file's per-entry
style (date header, prose, code/table references with `file:line`). Skip this step only if the
session was pure exploration/review with zero durable finding — say so explicitly rather than
silently skipping.

## 2. Memory

Read `C:\Users\amitk\.claude\projects\d--Github-bharat-stock-intelligence\memory\MEMORY.md` first
— check whether this session's finding extends an existing memory file (most sessions do; this
repo's own memory index was consolidated once specifically because near-duplicate dated files
had piled up) before creating a new one. Follow the memory-type rules from CLAUDE.md's
system context (user/feedback/project/reference) — only save what's durable and non-obvious;
code patterns, file paths, and anything re-derivable from the repo don't belong here. If nothing
this session rises to that bar, say so rather than manufacturing a memory to fill the step.

## 3. `.claude/rules/`

Ask: did this session hit a bug whose *shape* (not just its specific instance) would bite a
future session again? If yes and it's a genuinely new class, add it to
`.claude/rules/recurring-bugs.md` with a signature grep-able enough that the next person (or
`scripts/check_recurring_bugs.py`) can catch it before it recurs a second time — match the
existing entries' format (signature, why it breaks, recurrence count). If it's a second or third
occurrence of an *existing* entry, extend that entry in place rather than duplicating it — this
file's own entries show that pattern (e.g. the skip-path-stamped-as-success class was found 5
times and lives as one entry, not five). If nothing new surfaced, say so — most sessions won't
add a rule, and that's fine.

## 4. Report

State plainly which of the three were done, which were explicitly skipped and why, and whether
`graphify update .` is warranted (significant file/structure changes, not a one-line fix).
