# Memory index (claude-mem)
> One-read pointer so a new session never re-discovers where state lives. Update this
> index whenever one of these artifacts moves or a new one is added — that is what
> CLAUDE.md's "Closing a session" step 2 ("update MEMORY.md's index") means.

- **Session journal (append a dated section per session):** `.agents/memory/session_journal.md`
- **Findings ledger (fix-and-close in session; stable `AF-YYYYMMDD-NN` ids):** `docs/audit-findings.md`
- **Session log (what changed + what was learned):** `docs/session-log.md`
- **Recurring bug classes (check before debugging):** `.claude/rules/recurring-bugs.md`
- **Repo rules:** `CLAUDE.md` — "Read first", with domain rules load-on-demand (pointed to by `.claude/hooks/rules-pointer.mjs` on every Edit/Write)
- **Knowledge graph:** `graphify-out/` — `graphify query`/`explain`/`path` BEFORE reading source files (enforced by `.claude/hooks/graphify-pointer.mjs` via PreToolUse in `.claude/settings.json`); check `GRAPH_REPORT.md`'s "Built from commit" against HEAD before trusting it
- **Definition of done:** `tsc --noEmit` / `vitest run` / full pytest / `schema:drift` — enforced by `.claude/hooks/verify-gate.mjs` (Stop hook); local DoD env state surfaces at every session start via `.claude/hooks/run-session-start.mjs` → `.claude/hooks/session-start.sh`
- **Hook wiring is itself guarded (2026-09-15):** all three settings.json hooks were dead on this Windows host — every hook command must be a `node .claude/hooks/*.mjs` module with a colocated `.test.mjs` (the two that had none were the two that silently emitted nothing), `*.sh` is pinned `eol=lf` in `.gitattributes`, and `.claude/hooks/settings-hooks.replay.test.mjs` replays the declared commands and asserts they fire. Full story: `hook_wiring_dead_on_windows_2026_09_15.md` in the memory dir.