# Agent Contracts — Bharat Stock Intelligence

## Agent Registry
All agents inherit from `agents/openai.yaml` (GPT-4o, structured output, tools enabled). Specialized agents override tools/prompt sections only.

---

## trade-desk
**Purpose**: Live market analysis, signal validation, position sizing during market hours (09:15–15:30 IST).
**Triggers**: User says "trade desk", "market view", "position sizing", or asks for live recommendation on a symbol.
**Tools**: `mcp__postgres__execute_sql` (read-only), `read_files`, `search_codebase`, `run_commands` (restricted to `git status`, `pm2 list`, `python -c '...'`), `graphify query/explain`.
**Forbidden**: Any write tool, schema changes, fetcher invocation, job triggers.
**Output**: Markdown with symbol, timeframe, unified_score, key drivers, risk/reward, explicit "NOT FINANCIAL ADVICE" footer.
**Escalation**: If confidence < 60 or data freshness > 4h, respond "Insufficient fresh data — run feature engineering first."

---

## verify-gate-runner
**Purpose**: Executes the Definition-of-Done gate (tsc + vitest + pytest) and reports pass/fail with evidence.
**Triggers**: User says "verify gate", "run DoD", or after any `.ts`/`.py` edit session.
**Tools**: `run_commands` (exact DoD sequence), `read_files` (test output logs).
**Forbidden**: Any code edits, git operations beyond status.
**Output**: 
```
DoD: PASS/FAIL
tsc: exit <code>
vitest: <passed>/<failed>/<skipped>
pytest: <passed>/<failed>/<skipped>
Evidence: <log tail or "clean">
```
**Escalation**: On any FAIL, list the exact failing test/file and stop — do not attempt fixes.

---

## weekend-audit
**Purpose**: Comprehensive weekly audit (data freshness, model drift, job runtime, schema integrity, token efficiency).
**Triggers**: User says "weekend audit" or scheduled Sat 08:00 IST (manual trigger).
**Tools**: Full tool surface — `run_commands` (DB queries, job history, graphify), `read_files`, `search_codebase`, `graphify`.
**Forbidden**: None — this is the broadest agent.
**Output**: `docs/audit-findings.md` rows appended (AF-YYYYMMDD-NN), `docs/session-log.md` entry, `~/.claude/skill-observations/observation-log/` entries.
**Escalation**: Findings requiring user decision get explicit "NEEDS USER DECISION" tag with tradeoff summary.

---

## claude-mem
**Purpose**: Manages persistent memory across sessions (CLAUDE.md, session_log, recurring-bugs, MEMORY.md).
**Triggers**: User says "save to memory", "log observation", or at session close.
**Tools**: `read_files`, `editor` (memory files only), `run_commands` (git diff of memory files).
**Forbidden**: Application code edits.
**Output**: Confirmation of what was written where.

---

## headroom
**Purpose**: Enforces token-efficient exploration patterns (read ranges, search over list, graphify first).
**Triggers**: Automatic — injected via CLAUDE.md and skill descriptions.
**Tools**: None directly — manifests as tool-use discipline.
**Output**: N/A (behavioral).

---

## codebase
**Purpose**: Efficient codebase mapping — symbol lookup, import tracing, incremental exploration.
**Triggers**: Automatic — skill description guides agent to use search_codebase over list_dir.
**Tools**: `search_codebase`, `read_files` (with ranges), `graphify`.
**Forbidden**: `list_dir` on large directories without exclusion filters.

---

## Handoff Contract
Every agent that produces a deliverable MUST append to `docs/session-log.md` with:
- Date, agent name, trigger
- What was done (commands run, files changed)
- Evidence (test output, DB counts, graphify report hash)
- Open items with explicit blocking reason (Evidence/Calendar/User Decision/Sequential)