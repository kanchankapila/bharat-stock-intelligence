---
paths:
  - "docs/audit-findings.md"
---
# Findings ledger: resolving, keeping open, sharing

Moved verbatim from CLAUDE.md on 2026-10-28 so it loads only when the ledger is touched; CLAUDE.md keeps the summary.

A finding is not done when written down; it is done when **fixed, verified against live production,
and closed with a date and evidence** — in the same session. Report and fix are one act: an audit that
ends in a list is unfinished. Every fix ships with a regression test written first, shown to FAIL on
the unfixed code, then passing, and named in the ledger row's `Immunized` cell.
`npm run findings:check` enforces this for rows from 2026-09-30; a red result means the session is not finished.

`docs/audit-findings.md` is the **only** open/pending tracker (stable `AF-YYYYMMDD-NN` ids; never delete
a row, close it in place). Do not create another "things to do later" file — three were retired for drifting.
Findings are not GitHub issues; GitHub (`kanchankapila/bharat-stock-intelligence`, via `gh`) is for PRs.

### Shared backlog — every agent and model

Use `docs/audit-findings.md` for **all repository work**, whether performed by Claude, ChatGPT/Codex,
Cline, Cursor, Copilot, Hermes or another assistant: bugs, audits, implementation debt, deferred
experiments, skill/process improvements, installation/deployment follow-ups and user decisions.
Read it before starting; search for an existing stable ID before adding one. Record owner/origin,
next action, verification evidence and any real blocker/unblock condition in the existing cells.
Re-read a row before updating it so concurrent agents do not overwrite each other's evidence.

Plans are designs/recipes, session logs and memory are history, and package manifests describe
artifacts; none is a second work queue. Link their relevant ledger IDs instead of maintaining
independent pending states or leaving work only in chat, local memory or a model-specific file.
Do not mark a migrated checkbox complete merely because tracking moved. Procedural verification
templates may remain checklists only when explicitly registered as templates in the ledger.

Project override for task-observer: repository-specific unresolved observations belong in this
same ledger, not a separate per-observation pending queue. Existing global observation records
remain historical evidence; do not merge unrelated projects' private work into this repository.
Run `npm run backlog:check` and `npm run findings:check` before handing off. These checks enforce
tracking contracts, not the correctness or profitability of the recommendations.

A finding may stay **open** only for one of these reasons, stated in its row:
- **EVIDENCE** — it touches a score, weight, threshold or classification, so `measurement.md` /
  `ml-model-bugs.md` require measuring first. "Resolve now" then means run the measurement now.
- **Calendar-blocked** — needs elapsed time (e.g. ~20-30 trading dates); name the unblock condition and a date.
- **Needs a user decision** — a tradeoff only the user can make. Not a lane you may enter until you have
  exhausted what you can determine yourself. For missing data that means `data-sources.md`'s RULE ZERO:
  an `information_schema` sweep for the column across every table plus a `graphify query` for an existing
  backfill — not three plausible tables. For a vendor that stopped returning data, or a new source:
  1. Query the discovery registry first: `market_endpoint_registry` in Postgres (`bharat_intel` on `:5433`,
     3,408 endpoints: 2,864 GET / 544 POST; views `v_working_market_endpoints`, `v_stock_screeners`, `v_fno_endpoints`).
  2. The consolidated catalog `url_endpoints` (834 templates): `python -m url_explorer.ingest --find-alternates "<targets>" --exclude <failing-host>` from `src/server`.
  3. If present, the optional local raw URL corpus `urls_v2.db` (SQLite: `url_catalog`, `url_data`; gitignored and
     absent from a fresh checkout). The older flat list unique_urls.txt was deleted 2026-10-23 (`c2ceae0e`);
     read it with `git show c2ceae0e^:unique_urls.txt`.
  4. Grep the repo for sibling endpoints and probe route by route with the MINIMUM headers (start from none — adding a token can lower access).
  5. Only then ask the user, with the per-route breakdown and alternates ruled in or out — never "this vendor is dead".
- **Depends on an earlier fix** — genuinely sequential; name the blocking row.

This applies equally to findings from a log sweep: a pm2 warning/error that means data was not written is a
defect to fix now, whatever level it was logged at, including a step that exited 0. Re-verify any open row
you touch and either close it or update why it is still blocked; an open row nobody re-checks is itself a finding.
