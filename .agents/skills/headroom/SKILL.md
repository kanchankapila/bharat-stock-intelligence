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
- **Never read a whole file if you only need a snippet.** Always use `StartLine` and `EndLine` parameters when calling `view_file`.
- **Estimate range first:** If you're looking for a specific function, class, or section, use `grep_search` to find the exact line numbers first, then read only that range (+/- 10 lines of context).
- **Avoid viewing binary files** or large raw data logs unless absolutely necessary.

### 2. Output and Log Management
- When executing terminal commands (`run_command`), keep the output clean. Use filters like `head`, `tail`, or grep to output only relevant lines.
- Limit paging length: avoid listing thousands of lines from logs or lists.

### 3. Redundancy Prevention
- Before reading a file, check if its content has already been retrieved in previous turns or if it's already open in the active documents tab.
- Do not repeat standard setup steps or verification queries if they were run recently and their results are visible in the history transcript.

### 4. Code Generation Efficiency
- When writing files or edits, write targeted chunks instead of full-file updates.
- Keep comments and docstrings concise. Avoid boilerplate code.
