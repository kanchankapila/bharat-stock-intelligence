# Migration and Cutover Plan — parallel rebuild, not in-place mutation

Companion to [GREENFIELD_STOCK_ANALYSIS_ARCHITECTURE.md](GREENFIELD_STOCK_ANALYSIS_ARCHITECTURE.md)
(the *why*) and [GREENFIELD_BUILD_SPEC.md](GREENFIELD_BUILD_SPEC.md) (the *how*). This document is
the *how to get there from the live system without losing data*.

For the stage-by-stage implementation directive (what an AI agent executes):
[BUILD_STAGE_0_2_SPEC.md](BUILD_STAGE_0_2_SPEC.md) covers Stages 0–2 (foundation, ingestion
spine, NSE backfill). Stages 3–6 specs follow as each preceding stage's acceptance gate passes.

Supersedes the in-place approach for the data layer. It does **not** supersede
[NEW_SYSTEM_MASTER_PROMPT_INPLACE.md](NEW_SYSTEM_MASTER_PROMPT_INPLACE.md), whose completed items
(the `as_of` helper, `nse_stocks` provider columns, `engine_coverage_count`, the purge regression
test) remain valid and carry forward.

---

## 0. Decision

**Stand up a new PostgreSQL instance and a new Redis, build the target schema from migration 001,
then rebuild / quarantine / recompute — do not bulk-copy.** Keep the current database running and
authoritative until cutover, then retain it read-only as an archive.

### The premise correction

A new database yields a clean **schema**. It does not yield clean **history**. Rows copied across
carry their existing defects into the new container. "Fresh copy without bias" is only achievable
by re-deriving from source where possible and recomputing everything derived — not by moving rows.

### Verified facts this plan rests on (2026-08-12)

| Fact | Value | Consequence |
|---|---|---|
| Raw provider payload capture | **0 tables** (only `extra_endpoint_responses` for the TapeTide/Trading80 family) | Nothing can be re-parsed offline. Re-derivation means re-fetching from the provider. |
| `available_at` coverage | **0 of ~200 tables** | Historical point-in-time truth was never recorded and cannot be recovered. |
| `run_id` coverage | **10 of ~200 tables** | Almost no row is traceable to a run. |
| Redis durable state | **none** — cache + BullMQ only | A fresh Redis is safe. |
| Runtime DDL | **105 `CREATE TABLE IF NOT EXISTS` across 61 Python files** | Fetchers must be rewritten regardless of approach. |
| Compressed hypertables | several, per `CLAUDE.md` | The main reason in-place backfill was high-risk; avoided entirely here. |

### What parallel eliminates versus in-place

| In-place risk | Status here |
|---|---|
| Chunked backfill across compressed hypertables | Eliminated — tables are born with the right columns |
| Removing the SQLite path from 131 files | Eliminated — new instance is Postgres-only by construction |
| Reverse-engineering a baseline migration for ~200 tables | Eliminated — clean chain from 001 |
| Rename-and-wait retirement of dead tables | Eliminated — never created |

### What parallel does **not** save

The 105 runtime-DDL fetcher rewrites, job-catalog unification, the `JobResult` contract,
point-in-time enforcement, and data-quality coverage are code changes required either way.

---

## 1. Table classification — the only decision that matters

Classify **every** current table into exactly one class before writing any transfer code. The
decision rule is a single question: **can this be re-fetched from the provider today?**

| Class | Rule | Provenance in new DB | Volume |
|---|---|---|---|
| **R — Rebuild** | Provider serves full history on demand | `recorded` — genuinely true | Small table count, most of the rows |
| **Q — Quarantine-copy** | Point-in-time only; unrecoverable if not captured then | `inferred`, with a hard boundary date | Moderate |
| **N — Never migrate** | Derived from other tables in this system | Recomputed from rebuilt inputs | Large table count, no transfer |

### Class R — rebuild from provider archives

Re-fetch, re-parse with the new validated parsers, write with real `run_id` and `available_at`.
This is the only path that produces *true* provenance, and it is why accuracy improves rather than
merely relocating.

| Data | Source | Notes |
|---|---|---|
| Daily OHLCV | NSE `sec_bhavdata_full_DDMMYYYY.csv` | Full history downloadable per date |
| Delivery | NSE `MTO_DDMMYYYY.DAT` | Same |
| Index levels / membership | NSE archives + index files | Enables survivorship-free benchmarks |
| Corporate actions | NSE / InvestSights corporate-actions | Must precede any adjusted-return work |
| Security master | Bhavcopy union + provider mappings | Rebuilds `security` cleanly |

Rebuilding OHLCV from bhavcopy also re-derives `is_suspect` with the current quality rules, rather
than importing the existing ~425 quarantined bars and whatever the old flagging logic missed.

### Class Q — quarantine-copy with an explicit boundary

Vendor-computed, observed-at-a-moment data. A screener's membership on a past date cannot be
re-fetched. Copy it, but mark it so it can never masquerade as recorded provenance.

Examples: `screener_appearances`, Trendlyne DVM scores, MarketsMojo tables, TickerTape scorecards,
`fundamentals_history` snapshots, historical news items, FII/DII history where the vendor no longer
serves it.

Rules for Class Q:
1. Every row lands with `provenance_quality = 'inferred'`.
2. `available_at` is set to the **most conservative** defensible proxy (observation date + known
   publication lag), never the current time and never a value that implies earlier knowledge.
3. A single `provenance_boundary_date` is recorded in `measurement.md`. Any research result that
   spans it must state so.
4. Known-corrupt rows are **not** copied — see §2.

### Class N — never migrate, recompute

Every score, feature, signal, outcome and recommendation. Copying these imports the exact bias the
rebuild exists to remove.

Do **not** transfer: `stock_scores`, `stock_factor_breakdown`, `stock_factor_breakdown_history`,
`quant_scores`, `feature_store`, `unified_recommendations`, `unified_signals`, `technical_signals`,
`signal_outcomes`, `unified_signal_outcomes`, `confluence_signals`, `intraday_recommendations`,
`recommendation_log`, RL/Q-tables, model registries.

Instead: rebuild Class R, copy Class Q, then run the engines forward over history to regenerate
features, scores and outcomes with correct point-in-time cutoffs. Model artifacts are **retrained**
against the rebuilt panel, never copied — a model trained on leaky or corrupt inputs stays leaky in
a new database.

---

## 2. Known-corrupt data must not be carried over

The rebuild is the opportunity to leave these behind. Copying them forward wastes it.

| Defect | Scope | Action |
|---|---|---|
| Trendlyne positional-parse corruption (profile URL written into `symbol`) | ~2.1M rows across 7 tables | Never copy. Affected tables are Class N and are recomputed. |
| `signal_generated_at` as last-seen rather than generation time | 29,433 of 55,736 rows | Class N — not copied. |
| `signal_source` case collision (`technical` vs `TECHNICAL`) | 19,482 vs 5,922 rows | Resolved by the new enum; not copied. |
| Overwritten ranker dates | 34 of 37 `computed_at` dates | Unrecoverable. Only the 3 preserved runs plus `unified_recommendations_history` survive. |
| Fabricated audit outputs (`docs/audit-2026-08-12/`) | 5 scripts, already deleted | Never an input to anything. |

Add a pre-transfer validation pass that rejects any Class Q row failing the new constraints:
symbol resolvable in `security`, identifier matching `^[A-Z0-9&$-]{1,20}$`, numerics finite,
dates parseable. Rejected rows go to a `migration_reject` table with the reason — quantified and
reviewable, never silently dropped.

---

## 3. Build order

Each stage has an exit gate. Do not start the next stage until the gate passes.

### Stage 0 — Infrastructure
New Postgres 16 instance, new Redis, object storage bucket for raw payloads. Schema created **only**
by the migration chain from 001, using the DDL in [GREENFIELD_BUILD_SPEC.md](GREENFIELD_BUILD_SPEC.md)
Part C. Ephemeral-Postgres test harness stood up.

*Gate:* migration chain replays from empty into a scratch database and matches the target schema
byte-for-byte; no table exists that a migration did not create.

### Stage 1 — Ingestion spine
`provider`, `provider_endpoint`, `job_definition`, `ingestion_run`, `raw_object`. Provider SDK with
raw-capture-before-parse. Declarative job catalog generating both scheduler registration and the
monitoring mirror (retiring the `queues.ts` ↔ `jobRegistry.ts` hand-mirroring: 48 vs 57 entries
today). `JobResult` contract with skip/degraded refusing the success heartbeat.

*Gate:* one endpoint flows provider → `raw_object` → canonical with real `run_id`; a deliberately
skipped job does not produce a success heartbeat.

### Stage 2 — Class R rebuild
Resumable, restartable backfill runner over NSE archives, oldest-first, rate-limited, recording
every fetch in `ingestion_run` and every payload in `raw_object`. Then corporate actions, then
`price_adjustment` as a derived view.

*Gate:* per-symbol dense-span coverage matches or exceeds the old database (§4); adjusted returns
reconcile against a hand-checked sample of known splits.

### Stage 3 — Class Q transfer
Validated, rejecting transfer of vendor point-in-time tables. Boundary date recorded.

*Gate:* transfer report shows accepted/rejected counts per table with reasons; zero silent drops.

### Stage 4 — Recompute Class N
Features, scores, signals, outcomes regenerated forward over history with enforced `facts_cutoff`.
Models retrained on the rebuilt panel with date-purge and embargo.

*Gate:* the research harness reproduces a registered known result before any new number is quoted;
leakage negative controls fail as designed.

### Stage 5 — Dual-run
Both systems run the same schedules. New system serves **nothing**. Compare daily outputs.

*Gate:* an agreed dual-run period with divergences explained — not merely observed. A divergence is
resolved when you can say which system is right and why.

### Stage 6 — Cutover
Freeze writes on the old DB, run a final Class Q delta transfer, repoint `bharat-server`, `ml-api`,
`chatbot`, `alphaquant-api`, flip DNS/config, keep the old instance **read-only** for a full
release. Rollback is repointing back, which stays possible because the old DB was never mutated.

*Gate:* smoke test queries written rows back from the new instance; `/health/version` reports the
expected commit and migration level on all four services.

---

## 4. Accuracy gates — where "high accuracy" is actually earned

Reconciliation is the deliverable, not a formality. For every transferred or rebuilt table:

1. **Per-symbol dense-span coverage, not `min(date)`/`count(DISTINCT date)`.** Both of the naive
   forms have misled this repo before. Run both:
   `SELECT min(n), median(n), max(n) FROM (SELECT symbol, count(DISTINCT date) n FROM t GROUP BY 1)`
   and a per-year `count(DISTINCT date)`.
2. **Numeric checksums** per symbol-year on price/volume columns, old versus new.
3. **Sampled row-level diff** on a random and an adversarial sample (illiquid names, corporate-action
   dates, suspect bars, the symbols involved in known past incidents).
4. **Coverage must not regress.** Any symbol-date present in the old DB and absent in the new is an
   explicit, explained line item — never an unexplained delta.
5. **Reject accounting balances**: `rows_read = rows_accepted + rows_rejected`, per table.

⚠ The reconciliation harness is itself dangerous. This repo has already shipped five
"verification" scripts that produced evidence-shaped output while never connecting to a database.
The harness must be negative-controlled: inject a known discrepancy into a scratch copy and prove
the report catches it, before any of its green results are believed.

---

## 5. Risks specific to this approach

| Risk | Mitigation |
|---|---|
| Provider rate limits make Class R backfill slow | Resumable oldest-first runner with checkpointing in Postgres; run it early and in parallel with Stages 1–3 |
| Provider archives are incomplete for older dates | Discover the true horizon **during Stage 2**, before committing to cutover. Where NSE archives fall short, that data becomes Class Q. |
| Dual-run divergence is observed but not explained | The gate requires explanation, not tolerance. Unexplained divergence blocks cutover. |
| Two Postgres instances cost more | Time-boxed. The old instance goes read-only at cutover and is archived after one release. |
| Delta drift during dual-run | Class R re-fetches are idempotent; Class Q gets a final delta pass at freeze. |
| Cutover touches four pm2 services | Rehearse against a restored snapshot; `.ts` needs `pm2 restart`, and committed ≠ deployed. |
| The migration scripts become the new source of bugs | Same review standard as production code: contract tests, negative controls, and a check that the script actually issues queries. |

---

## 6. Prohibitions

1. Do not bulk `pg_dump | psql` the old database into the new one. That reproduces the schema you
   are leaving.
2. Do not copy any Class N table.
3. Do not copy model artifacts. Retrain.
4. Do not set `available_at` to the transfer timestamp — it implies knowledge that did not exist.
5. Do not drop or mutate the old database until a full release after cutover.
6. Do not let the new system serve users before Stage 5 completes.
7. Do not quote any accuracy number derived from the new panel until the research harness has
   reproduced a registered known result.
8. Do not treat the absence of an error during transfer as success. Balance the reject accounting.

---

## 7. What is permanently lost, and the honest statement about it

Recorded now so no future session mistakes inference for measurement:

- **Historical `available_at`.** Never captured. All pre-boundary point-in-time analysis rests on an
  inferred proxy and must say so.
- **34 of 37 ranker `computed_at` dates.** Overwritten by `UNIQUE (symbol, computed_at)` before
  `unified_recommendations_history` existed.
- **Pre-fix `signal_generated_at`.** Repaired from `created_at`, which is a proxy.
- **Vendor point-in-time state before capture began** — screener memberships, DVM scores and similar
  for dates never fetched.

The correct public statement after this rebuild is: *provenance is recorded from the boundary date
forward; earlier history is reconstructed and labelled inferred.* Not "the data is clean."
