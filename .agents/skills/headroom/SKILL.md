---
name: headroom
description: Maintains context window headroom, enforces token limits, and prevents file read redundancy.
---

# Headroom Skill

This skill enforces token optimization, context window budget control, and minimizes redundant file reads.

## Objectives
- Minimize the number of tokens sent in each message.
- Maintain maximum headroom in the LLM's context window.
- Avoid duplicate file reading or over-fetching large files.

## Guidelines for Token Optimization

### 1. Targeted File Reading
- **Never read a whole file if you only need a snippet.** Always pass `start_line`/`end_line` bounds on the file read (this environment's `read_files` supports per-file ranges).
- **Estimate range first:** if you're looking for a specific function, class, or section, run the regex code search (`search_codebase`) to find exact line numbers first, then read only that range (+/- 10 lines of context).
- **Avoid viewing binary files** or large raw data logs unless absolutely necessary.

### 2. Output and Log Management
- When executing shell commands (`run_commands`), keep the output clean: pipe through `Select-Object -First/-Last`, `head`, `tail`, or `grep` so only relevant lines return (output is middle-truncated around ~48k chars — filtering also avoids truncation loss).
- Limit paging length: avoid listing thousands of lines from logs or lists.

### 3. Redundancy Prevention
- Before reading a file, check if its content has already been retrieved in previous turns — do not re-read it.
- Do not repeat standard setup steps or verification queries if they were run recently and their results are visible in the history transcript.

### 4. Code Generation Efficiency
- When writing files or edits, write targeted chunks instead of full-file updates.
- Keep comments and docstrings concise. Avoid boilerplate code.
