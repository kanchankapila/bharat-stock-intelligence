---
name: codebase
description: Defines codebase mapping, symbol lookup, and incremental file analysis rules to avoid full-directory scans.
---

# Codebase Exploration Skill

This skill optimizes how the agent interacts with and maps the codebase structure, minimizing token-heavy recursive file searches and directory listings.

## Objectives
- Locate target code symbols (classes, functions, endpoints) efficiently.
- Understand routing and module layout without traversing every subdirectory.
- Avoid large folder lists or full-file scans during exploration.

## Guidelines for Codebase Mapping

### 1. Leverage the Architecture Map
- **Symbol Lookup**: Use `grep_search` to target class, function, or endpoint names instead of scrolling through directories or reading long files.
- **Imports Tracking**: Prioritize understanding imports at the top of active files to trace dependencies rather than searching all files in the project.
- **Data Source & Endpoint Discovery**: When exploring endpoints, financial metrics, or alternate data feeds, query the 3,000+ endpoint discovery registry in PostgreSQL (`market_endpoint_registry` on `:5433`, 3,408 live endpoints; `v_stock_screeners`, `v_fno_endpoints`), `url_endpoints` (830 templates via `--find-alternates`), or inspect `unique_urls.txt` (3,103 raw URLs) and `DATA_FETCHING_GUIDE.md` instead of performing broad directory searches or web scraping.

### 2. Incremental Exploration
- When mapping a new component:
  1. Search for references to the component name using `grep_search`.
  2. Read files incrementally: start with interface definitions or types files (e.g. `*.d.ts`, `types.ts`, `schema.sql`).
  3. Inspect only the concrete implementation lines matching the target functionality.

### 3. Avoid Broad Scans
- Never run a `list_dir` on directories that are known to contain many files (e.g. `node_modules`, `.git`, `dist`, `.venv`) unless targeting a specific nested folder.
- Always use exclusion filters (`Includes` or `!**/folder/*` flags in grep tools) to avoid scanning build artifacts, logs, or dependency folders.
- Prioritize reading `CLAUDE.md` or existing design plans to locate key assets and settings before beginning general scans.
