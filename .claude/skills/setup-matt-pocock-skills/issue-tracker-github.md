# Summary: GitHub Issue Tracker Workflow

This document outlines conventions for managing issues and pull requests in a GitHub repository using the `gh` CLI tool.

## Key Operations

**Issue Management:**
- Create issues with `gh issue create --title "..." --body "..."`, using heredocs for multi-line content
- View issues with `gh issue view <number> --comments`
- List issues with filtering by label and state
- Add/remove labels and close issues via `gh issue edit` and `gh issue close`

**Pull Request Handling:**
This repo does *not* treat external PRs as feature requests. However, equivalent `gh pr` commands exist for managing pull requests when needed, including viewing diffs and filtering external contributors.

## Advanced Features

**Wayfinder Operations** organize work around a central "map" issue:
- Child tickets link to the map as sub-issues or task list items
- Dependencies are tracked via "GitHub's native issue dependencies" to represent blocking relationships
- The frontier query identifies the next unclaimed, unblocked ticket
- Work flows from claiming (`--add-assignee @me`) through resolution with decision documentation

The system automatically infers the repository context from `git remote -v`, streamlining CLI usage within cloned repositories.