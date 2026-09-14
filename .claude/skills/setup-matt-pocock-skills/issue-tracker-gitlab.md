# GitLab Issue Tracker Guide

This repository uses GitLab for issue tracking, managed via the `glab` CLI tool.

## Key Operations

**Creating & viewing issues:**
- Create: `glab issue create --title "..." --description "..."`
- View: `glab issue view <number> --comments`
- List: `glab issue list -F json` with label filters

**Issue management:**
- Comments are called "notes" in GitLab: `glab issue note <number> --message "..."`
- Labels: `glab issue update <number> --label "..."` or `--unlabel "..."`
- Closing: Post explanation first, then `glab issue close <number>`

## Merge Requests

Merge requests (PRs) use similar commands with `mr` substituted for `issue`. This repo does **not** treat external MRs as feature requests—they don't follow the standard triage workflow.

## Wayfinding (Project Planning)

For complex work, use wayfinder issues:
- A "map" issue labeled `wayfinder:map` holds the overview
- Child issues reference the map and carry type labels (`wayfinder:research`, etc.)
- Blocking relationships use `/blocked_by #<n>` quick actions
- Claim tickets with `glab issue update <n> --assignee @me`