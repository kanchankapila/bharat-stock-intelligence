---
name: claude-mem
description: Manages persistent project memory, context checkpointing, and incremental workspace state.
---

# Claude-Mem Skill

This skill governs persistent memory tracking, session-to-session continuity, and incremental state compression.

## Objectives
- Track task status and decisions across sessions.
- Maintain a local memory profile to avoid re-discovering project structure or database schemas on every session.
- Document resolved issues and design rules so they don't get lost or re-evaluated.

## Guidelines for Memory & State Management

### 1. Incremental Checkpointing
- When a complex task is completed or a significant architectural choice is made, update the `walkthrough.md` or a local session journal in `.agents/memory/` or `CLAUDE.md`.
- Keep memory artifacts lean: focus on *decisions*, *known bugs*, *port settings*, and *dependencies*.

### 2. Schema and State Caching
- Reuse database schema files (e.g., `db/schema.postgres.sql`) or generated metadata reports instead of query-intensive metadata commands (e.g., querying tables or schemas repeatedly).
- If a schema has been mapped, cache it in memory rather than running a new DB scan.

### 3. Read Memory Before Research
- At the start of a session, check if there are existing memory logs or active plans (e.g., `implementation_plan.md`, `CLAUDE.md`).
- Do not repeat investigations that have been logged in the "Recent session notes" section of `CLAUDE.md` or in the walkthrough logs.
