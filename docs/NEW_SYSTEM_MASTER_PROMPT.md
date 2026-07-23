# Master Prompt: Bharat Stock Intelligence V2 — Ground-Up Rebuild

_This is a prompt document, not application code. Paste the "PROMPT TO USE" section below into
a fresh Claude Code session (empty repo) to bootstrap the new system. The rest of this file is
the rationale — why each decision was made, sourced from concrete incidents in the current
codebase (`bharat-stock-intelligence`), so the new build inherits the lessons without inheriting
the debt._

---

## Why a rebuild instead of a refactor

The current system (`src/App.tsx` 3704 lines, `src/server/router.ts` 2770 lines, 130+ tRPC
procedures, 126+ DB tables, ~95 Python fetchers) works and produces real signal (breakout
classifier: honest 5yr purged-OOF AUC 0.6138, top-decile 1.47× base rate). But its accuracy and
reliability problems are architectural, not superficial:

1. **Three parallel score producers and six overlapping signal tables** (`stock_scores` /
   `quant_scores` / `unified_recommendations`; `signals` / `unified_signals` /
   `technical_signals` / `technical_analysis_signals` + two outcome tables) grew because each
   new idea got a new table instead of extending the schema of record. A rebuild gets one score
   table and one signal table from day one.
2. **The headline ML number never matched the deployed number.** Training-CV AUC hit 0.75; the
   *live, deployed* `win_probability` had per-regime AUC of ~0.50 in BULL/SIDEWAYS and only 0.613
   in BEAR. The gap was purging discipline (date-purge + embargo vs row-purge), calibration that
   only works with enough resolved outcomes per regime, and no promotion gate stopping a worse
   model from overwriting a better one. **The new system must make "live AUC per regime" a
   first-class monitored number from day one, not a thing discovered 10 months in.**
3. **Silent partial failure was the single largest recurring incident class.** A `.catch()` that
   swallows and a heartbeat that reports `{success:true}` regardless of what happened inside is
   how a 3.5-week gap in `signal_outcomes`/`technical_signals` became *unrecoverable* — nobody
   noticed for weeks because every job "succeeded." Root causes spanned the stack: a BullMQ
   worker returning `{success:false}` instead of throwing; a Python subprocess-slot counter that
   leaked +1 per hand-off under queue contention (confirmed drifting to 36/5 concurrent); raw
   `%s` placeholders bypassing a SQL-dialect translator; `date('now')` vs `current_date` vs
   `now()` mismatches across TEXT/DATE/TIMESTAMPTZ columns that "worked" on SQLite and broke on
   Postgres. **None of these were exotic bugs — they were "did the job actually check what
   happened" gaps.** The new system's monitoring must check *data outcomes* (freshness, row
   counts, plausibility), not just *job completion*.
4. **Look-ahead bias was found and fixed at least three separate times** (point-in-time
   fundamentals via as-of join; unbounded OHLCV query in `runTechnicalSignalScan` still computing
   indicators on future bars for historical `scanDate` as of the last audit; row-level vs
   date-level purging in the breakout classifier's forward label). This is the single deadliest
   class of bug in a trading ML system because it inflates backtest/CV numbers in a way that
   looks like real edge. **The new system needs one canonical, tested "as-of" data-access layer
   that every training/backtest/live-scoring path is forced through — not each engine
   re-implementing its own point-in-time join.**
5. **The database schema-of-record drifted from the live schema.** `db.ts` (SQLite) was
   documented as "schema of record" while Postgres was actually live, and column *types*
   (TEXT vs DATE vs TIMESTAMPTZ) differed between the two in ways that only broke on Postgres,
   invisibly, per-table. **The new system is Postgres-native from day one — no SQLite dev
   fallback pretending to be the same shape.**
6. **Feature sprawl outpaced value.** Chatbot, RL Q-learning meta-controller, market-map,
   multiple screener-source integrations (MC/Trendlyne/ETnow each with their own screener +
   stocks tables) — some proved out, most didn't get far enough to prove or disprove value before
   the next feature started. The Data-Gap Manifest shows the actual value concentration clearly:
   **one classifier (breakout probability) has *measured, held-out, non-degrading* edge; the
   general win/loss ensemble's edge is real in CV but does not survive deployment outside one
   regime.** The rebuild's feature list below is deliberately smaller and ranked by *measured*
   value, not by "the old system had it."

---

## Deep-dive: what an expert-trader-grade decision system requires

A follow-up review of the actual live schema (132 tables) and the current decision pipeline
(`unified_ranker.py`, `ml_ensemble.py`, `scoring_engine.py`) — done specifically to answer "what
would it take for this system to reason across every factor the way an expert trader does" —
surfaced findings that apply directly to the rebuild, on top of the incidents above.

### The current decision architecture is worth replicating, not just its data

`unified_ranker.py` already implements several things a real systematic desk does, and the
rebuild should treat these as required architecture, not optional extras:
- A **regime-gated blend of multiple independent component scores** (screener consensus, ML
  meta-label, cross-sectional rank, technical, deep-learning, a proven forward-labeled
  classifier), reweighted by market regime — not one monolithic model.
- A **fundamental quality gate** that demotes technically-strong-but-fundamentally-weak names
  (e.g. by Piotroski F-score / ROE) rather than ranking on technicals alone.
- A **hard veto** on governance/solvency red flags (rising pledge, ASM/GSM, debt-trap flags)
  that overrides a high score — a breakout on a name with a solvency red flag must never surface
  as a "Buy."
- **Meta-labeling → position sizing** (a calibrated win-probability converted into a bet size,
  inverse-volatility weighted, per-name capped) instead of naive score-ranking with no sizing
  logic.
- A **promotion gate** on every model retrain (a candidate must beat the active model by a
  margin before going live; the previous artifact is backed up, never overwritten blind).

Reproduce this shape from day one: multiple independent component scorers feeding one
regime-aware blender, with an explicit quality gate, an explicit hard-veto layer, and sizing
derived from a calibrated probability — not a growing pile of ad hoc if/else rules.

### The real bottleneck is methodology, not feature count — confirmed again

The live feature set already covers technical, fundamental (quality/value/growth/size), earnings
(surprise history, exact days-to-earnings), analyst consensus, ownership (FII/DII/MF + promoter
pledge trend), insider activity, options/derivatives (IV rank/skew, OI, max pain, rollover),
intraday microstructure, sentiment (news/FinBERT + GDELT fallback), and sector/global
correlation — nearly every category an equity analyst would look at. Market-level scalars applied
*standalone* (raw India VIX, raw MMI) were ablated **out** because they didn't help a per-stock
classifier; only per-stock interaction terms using them survived. **Keep this discipline in the
rebuild**: classify every candidate feature as cross-sectional vs market-level before wiring it
in, and require an ablation result, not intuition, to keep it.

Given that, the accuracy ceiling is set by methodology gaps that have nothing to do with data
coverage:
1. **Deployed probability discrimination doesn't match training-CV discrimination outside one
   regime** (0.75 CV vs ~0.50 live AUC in the dominant regimes, ~0.61 in the one regime with real
   edge). Live per-regime AUC must be a first-class, *alerted* metric from week one — not merely
   computed and left for someone to check manually.
2. **Binary win/loss labels throw away the magnitude and speed information a real trader uses.**
   Design for a 3-class or continuous forward-return label from the start — trained and evaluated
   alongside any binary baseline, promotion-gated the same way any other model swap would be —
   instead of retrofitting this after a binary-only system is entrenched everywhere downstream.
3. **Regime-conditional weighting must be backtestable from day one, not hand-set.** The old
   system tilts category weights per regime (overweight valuation/quality in BEAR, overweight
   momentum in BULL) using intuition-only multipliers, by its own code comments never backtested,
   because it never captured a historical trail of per-category scores to test against. Snapshot
   per-category scores daily (a `factor_breakdown_history` table) from the first day of scoring,
   specifically so any regime-conditional weighting can be fit from real outcomes instead of
   asserted.
4. **Cross-sectional comparability breaks silently when missing engines are renormalized
   around.** If a blending step re-weights over "whichever component scores exist for this
   symbol" (necessary when some engines have partial universe coverage), it must also emit how
   many components contributed to each score. Otherwise two stocks with the same final score may
   not be comparable — one backed by 7 independent engines, another by 2 — and nothing downstream
   can tell the difference. Surface engine-coverage-count as a first-class field on every score.
5. **Feedback-loop queries must be batch-safe by design**, not N+1-per-row. A slow or hanging
   outcome-resolution job means the model is training/calibrating on stale-by-days evidence,
   which silently compounds point 1 above. Build outcome resolution as set-based SQL/batched
   joins from the start, never a per-row loop of sequential queries.
6. **As-of joins must be truly universal, not "mostly."** Even after building point-in-time
   snapshot tables, the old system left one primary feature-building join on a current-snapshot
   table (accepted as "mild" look-ahead) rather than routing every consumer through the same
   as-of helper. The "one shared `as_of()` helper, no exceptions" rule must be enforced with a
   lint/test, not just convention — "mostly as-of" is exactly the kind of small leak that erodes
   trust in the accuracy numbers.

### The missing layer: reasoning/synthesis on top of the scores, not instead of them

The old system computes an excellent composite score but has no explicit layer that reasons the
way a human analyst does — weighing contradictory evidence, timing catalysts, explaining *why*.
That is the literal ask behind "the system should do all the thinking an expert trader would
do," and it does not exist even in the mature old system. Add it as a genuinely new component,
with one non-negotiable boundary carried over from the old system's own hard-won lesson:

**Two-system separation, strictly enforced:**
- **System 1 (deterministic, quant)** — every score, probability, position size, entry/stop/
  target price. Computed entirely by code (statistical models + rule-based gates/vetoes), never
  by a generative model. The old system had to build `atrBarriers.ts` specifically because an
  LLM-driven signal path once hallucinated price levels; the rebuild must never reopen that door.
  **No generative-model output is ever allowed to become a number consumed downstream.**
- **System 2 (reasoning/synthesis, LLM-assisted, strictly grounded)** — a scheduled pass, per
  top-ranked symbol, that receives ONLY already-computed structured facts (scores, factor
  breakdown, catalyst calendar, red flags, sentiment trend, regime) and produces a *structured,
  falsifiable* output: supporting facts, contradicting facts, an invalidation condition, and a
  narrative-confidence figure kept separate from the quant confidence figure. Its only allowed
  actions on the quant output are to suppress/demote or flag "caution" (the same shape as the
  existing quality-gate/veto pattern) — it can never raise a score or invent a price level.
  Sequence this **after** System 1 is proven and monitored (see delivery sequence below), not
  built in parallel with it.

---

## What to carry forward (proven, keep)

- **NSE symbol as the single canonical identifier**, all provider IDs (Yahoo `.NS`/`.BO` suffix,
  MoneyControl `mcsymbol`/`stockid`, Trendlyne `tlid`/`tlname`, ISIN, ET `companyid`) resolved
  from it via one mapping table, never the reverse, never guessed from a naming convention.
- **Cross-sectional, forward-labeled classifiers over single-stock time-series models.** The one
  component with durable out-of-sample edge (breakout classifier) is cross-sectional
  (percentile within the day's universe) with a forward, unambiguous label (≥6% move in 10
  trading days from *future* OHLCV, no signal-selection bias) — not "did our own emitted signal
  win." Design every future model this way first; only add path-dependent complexity (MFE/MAE
  exit regressors) once the entry classifier is proven.
- **Point-in-time ("as-of") joins for every slow-moving feature** (fundamentals, analyst
  estimates, shareholding) — snapshot table + as-of join, never "current value joined onto a
  historical date."
- **Purge-by-date + embargo for any forward-looking label**, never purge-by-row. This was
  proven to matter: an early "0.73 AUC" breakout result was entirely a purging artifact and the
  honest number was 0.61.
- **A single Redis-then-fallback cache layer, a single background-job runner, one retry/backoff
  convention** (`AbortSignal.timeout`, exponential backoff+jitter) applied uniformly, not
  reinvented per fetcher.
- **A living fetcher/data-quality health tracker backed by automated checks**, not a doc that
  goes stale — the current system only converted its manual audit doc into 24 automated
  freshness/coverage/plausibility checks after already shipping ~95 fetchers; build the
  equivalent from day one.
- **Ask-before-guessing on dead upstream URLs** rather than silently substituting a scraped
  workaround — several vendor endpoints go dead permanently (AMFI bulk MF holdings, ET Markets
  MF portfolio endpoint, Trendlyne quarterly cash-flow line items) and the right behavior is a
  clearly logged "blocked, need alternative source," not a fragile guess.

## What to drop (didn't pay for itself, or is a known bias trap)

- **Do not build separate scoring "authorities" per idea.** One score table, one signal table,
  one outcome table, versioned engines as *inputs* to a single ranker — not three producers with
  a "deferred Phase 3" migration plan that never arrives on schedule.
- **Do not gate anything on an uncalibrated win-probability across all regimes.** Prove
  per-regime live discrimination (not train-CV) before it drives sizing or emission gating
  anywhere. Ship the calibration/AUC-by-regime monitor *before* the gate that depends on it.
- **Do not build a generic multi-screener-provider ingestion layer speculatively** (MC + Trendlyne
  + ETnow screeners each got their own schema + sync jobs). Pick the 1–2 screener sources that
  actually differentiate outcomes; add a new provider only when a specific missing signal is
  identified, following the "add a new provider" checklist pattern, not "ingest everything
  available."
- **Do not build a chatbot, RL meta-controller, or market-map before the core scoring pipeline is
  proven and monitored.** These are legitimate ideas but they were built in parallel with the
  core accuracy work in the old system and diluted engineering attention without a measured
  accuracy payoff. Sequence: correctness + one proven model + monitoring, then expand surface
  area.
- **Do not carry SQLite as a "dev fallback with a translation layer."** The translation layer
  (`sqlTranslate.ts`-equivalent) is exactly where the TEXT/DATE/TIMESTAMPTZ and `%s`-vs-`?`
  placeholder bugs lived, because it made two schemas *look* compatible while their actual column
  types silently diverged. Postgres/TimescaleDB only, with a real local Postgres in Docker for
  dev — no shadow schema.
- **Do not add a feature/table because "the old system had it" without checking whether it was
  ever wired into a live consumer.** The old system has multiple "empty scaffolding" tables
  (`stock_options_oi`, `bulk_deals`, `institutional_rankings`) that existed for months before
  anything wrote or read them. Build fetcher → feature → consumer → retrain as one atomic unit
  of work, never a table alone.
- **Do not default any fallback value to something directionally biased.** A known bug: a news
  sentiment fallback path set every article to `sentiment_score=1.0` (maximally bullish) on
  *any* exception, not just "table missing." Every fallback needs a neutral value and a logged
  reason, reviewed explicitly for bias direction — this is a systemic category to eliminate by
  code-review checklist, not a one-off fix.
- **Do not let a generative/LLM component output a number that anything downstream trusts** —
  no score, probability, position size, or price level. The old system already learned this the
  expensive way (an LLM-driven signal path hallucinated entry/target/stop levels until
  `atrBarriers.ts` forced deterministic ATR-based geometry instead). Any LLM/agentic layer in the
  rebuild is reasoning-and-narrative only, strictly grounded on precomputed facts, and may only
  suppress/demote/flag — never raise a score or invent a number.
- **Do not hand-set regime-conditional weights or category tilts and leave them unbacktested
  indefinitely.** If a regime-conditional heuristic is shipped before enough historical data
  exists to fit it, ship the daily snapshot table that will let it be backtested *at the same
  time* — don't defer the history-capture and let the hand-set values calcify as "obviously
  right" for months, which is what happened in the old system.
- **Do not treat training-CV AUC as a proxy for live deployed edge.** Never let any gating,
  sizing, or emission-filtering logic key off a probability until its *live, per-regime* AUC has
  cleared an explicit, monitored trust floor. A 0.75 CV number and a 0.50 live number in the
  dominant regime can and did coexist for months before anyone measured the live number directly.
- **Do not silently renormalize a blended score across missing components without exposing
  coverage.** A score built from 2 of 7 engines and a score built from 7 of 7 must not look
  identical downstream — always carry an engine-coverage-count (or equivalent confidence
  signal) alongside the blended score.
- **Do not defer the label-design decision (binary vs. multi-class/continuous) as a "someday"
  improvement.** Decide it as a first-class methodology choice at the start of ML work, evaluated
  with the same promotion-gate discipline as any other model swap — not bolted onto a
  binary-only system that every downstream consumer has since assumed.
- **Do not build the System-2 reasoning/narrative layer before System 1's scores are measured
  trustworthy.** A confident-sounding narrative synthesized on top of an unreliable score is
  worse than no narrative — it adds false authority. Sequence it last, per the delivery sequence.

---

## Target architecture (production-grade, but not overbuilt)

**Principle:** boring, typed, observable, single-source-of-truth. Complexity is earned by a
measured accuracy or reliability win, not added speculatively.

### Data layer
- **PostgreSQL 16 + TimescaleDB** as the only database. Hypertables for OHLCV, technical
  signals, and any other append-heavy time-series table from day one (not retrofitted).
- **One schema-of-record file** (`db/schema.sql`) that IS the live schema — no parallel
  SQLite-flavored file that's allowed to drift. Migrations via a real migration tool
  (e.g. `node-pg-migrate` or `drizzle-kit` / `Prisma Migrate`) — every schema change is a
  migration file, never a hand-run `ALTER TABLE`.
- **One canonical `as_of()` data-access function per snapshot table**, used by training, backtest,
  and live-scoring alike. This is the single fix for the look-ahead-bias class of bug — if every
  consumer is forced through the same as-of join helper, there is no second implementation to
  drift out of sync.
- **Column types checked against `information_schema.columns`, not assumed** — no code path
  should special-case "this works differently in Postgres vs SQLite" because there is only
  Postgres.

### Backend
- **TypeScript, Express + tRPC** for the typed API layer (kept — this worked well, gave
  end-to-end type safety frontend↔backend with no schema drift between the two).
- **One score table (`recommendations`), one signal table (`signals`), one outcome table
  (`signal_outcomes`)** with a `source_engine` column identifying which model/version produced
  each row, rather than a table per engine. Engines write *component scores* into a normalized
  `engine_scores(symbol, date, engine, score, metadata)` table; a single ranker blends them into
  `recommendations`. This is the current system's own stated Phase-3 target — start there
  instead of arriving after three parallel tables already exist.
- **BullMQ for scheduling**, but every job handler follows one contract: throw on failure (never
  return `{success:false}` and let the wrapper report success), and `recordHeartbeat` /
  equivalent is mandatory middleware around every job, not opt-in per worker.
- **A single Python subprocess runner with a concurrency semaphore that is unit-tested for
  the exact failure mode that bit this codebase**: decrement-then-handoff on every release, with
  a test that simulates queue contention and asserts the counter returns to exactly zero. This
  is cheap insurance against a bug class that caused weeks of cascading "stale data" alerts.
- **MCP server exposing the platform's read tools** (stock lookup, technical scan, screener
  query, backtest run) so the same tRPC-backed data layer is usable from Claude Code / other
  agent tooling during development and, if wanted, as an internal ops interface — this is a
  cheap, high-leverage add given the system will be built with Claude Code anyway. Do not build a
  bespoke chatbot RAG stack (LangGraph + ChromaDB + custom FastAPI) as an early feature; an MCP
  server over the existing tRPC procedures gets 90% of the value for a fraction of the surface
  area, and a chat UI can be layered on later only if usage demands it.

### ML layer
- **One feature store** (`feature_store` table, point-in-time, symbol+date keyed), built once,
  extended by column — not a `build_features()` function per engine re-deriving overlapping
  features.
- **Cross-sectional, forward-labeled classifiers first** (breakout-style: P(≥X% move in N days)
  from forward OHLCV, universe percentile). This is the model family with proven, replicated
  edge in the old system (0.61 AUC, 1.47× top-decile lift, stable across 5 years) — start here,
  not with a general win/loss ensemble.
- **Purge-by-date + embargo enforced in one shared training-split utility**, not re-implemented
  per model. Add a test that fails if OOF AUC on a *known-leaky* row-purge split differs
  materially from the date-purged split — that regression test would have caught the old
  system's 0.73→0.61 leak on day one instead of after deployment.
- **Per-regime live AUC monitoring from the first week of deployment**, not after 10 months.
  Persist a small `model_live_performance(model, regime, date, auc, n)` table and refuse to let
  any gating/sizing logic key off calibrated probability until that regime clears an explicit,
  documented trust floor (e.g. AUC ≥ 0.55 on N ≥ some minimum resolved outcomes) — mirroring the
  regime-edge-adjustment mechanism the old system eventually built, but live from day one instead
  of retrofitted.
- **A promotion gate on every model retrain**: new model must beat the currently active model on
  held-out AUC by a margin AND not regress top-decile precision, before `is_active` flips.
  Version and back up every model artifact (timestamped, never overwrite-in-place) — the
  absence of this was a standing P0 item in the old system, i.e. a real incident waiting to
  happen, not a hypothetical.
- **Explicit bias checks baked into CI, not code review alone**: (a) no fallback value may be
  directionally non-neutral without a named justification in the same commit; (b) survivorship
  bias is tracked as a known/accepted limitation (current-listed-only universe) with a comment
  at the point features are built, not discovered ad hoc; (c) every new feature source is graded
  cross-sectional (has real information) vs market-level (repeatedly shown in this codebase's own
  ablations *not* to help a per-stock classifier) before being wired in — this distinction alone
  determined which of a dozen candidate features actually moved AUC in the old system.
- **A `factor_breakdown_history(symbol, date, category, score)` snapshot table from the first day
  of scoring** — not retrofitted once someone wants to backtest a regime-conditional tilt. This
  is what makes point 3 in the deep-dive above (backtestable regime tilts, not hand-set ones)
  possible on schedule instead of blocked on months of accumulated history.
- **Label design decided up front, not deferred**: train a 3-class or continuous forward-return
  target alongside the primary classification target from the first model, comparing both
  through the same promotion gate, rather than shipping binary-only and revisiting "later."
- **Every blended/composite score carries an engine-coverage field** (how many independent
  component scorers actually had data for this symbol) so consumers — including any future
  reasoning layer — can distinguish a well-supported score from a thin one instead of treating
  every score as equally comparable.

### Decision layer (regime-gated multi-engine blend — this is the "thinks like a trader" core)
- **One ranker blends multiple independent component scores** (e.g. screener/rules consensus,
  calibrated ML meta-label, cross-sectional rank, technical composite, a proven forward-labeled
  classifier), reweighted by market regime — never a single monolithic score.
- **A fundamental quality gate** (e.g. Piotroski-style + profitability check) demotes names that
  are technically strong but fundamentally weak, and **a hard veto** removes names with a
  governance/solvency red flag from the buy pool outright, regardless of score.
- **Position sizing derived from a calibrated probability** (meta-labeling → bet size, inverse-
  volatility weighted, per-name capped) — never naive score-ranking with no sizing logic attached.
- **Regime-conditional weights and category tilts are fit from `factor_breakdown_history` once
  enough data accumulates**, with hand-set priors only as an explicitly temporary bootstrap,
  clearly labeled as such and revisited on a schedule — not left as permanent intuition.

### Reasoning/synthesis layer (System 2 — build only after System 1 is proven, see deep-dive above)
- A scheduled, structured-output pass over top-ranked symbols that cross-checks the deterministic
  facts already computed (scores, factor breakdown, catalyst calendar, red flags, sentiment
  trend, regime) for **contradictions** a pure weighted blend can't articulate (e.g. "technical
  breakout, but pledge rising and earnings in 2 days") and produces a falsifiable thesis:
  supporting facts, contradicting facts, an invalidation condition, a narrative-confidence score
  kept separate from the quant score.
- **Hard boundary**: this layer can only suppress/demote/flag, never raise a score or emit a
  price/probability. Any output is stored, not just displayed, so narratives that flagged
  contradictions can later be checked against whether they actually preceded worse outcomes.

### Frontend
- React 19 + Vite + tRPC client (`httpBatchLink`) — kept, this combination worked well and gives
  full type safety without a GraphQL layer.
- Keep the tab surface small at launch: dashboard, stock detail, screener, signals, backtest,
  watchlist. Add sector/index/F&O/sentiment/portfolio surfaces only after the core ranking +
  signal pipeline is live and monitored — sequencing, not exclusion.

### Observability (this is not optional, it is where most incidents actually happened)
- **Data-quality checks over job-success checks.** A job that exits 0 while writing wrong, empty,
  or stuck data was the dominant failure mode in the old system's incident history — several
  fetcher bugs ran silently for weeks before anyone noticed because monitoring only asked "did
  the job run," never "is the data any good." Ship freshness/coverage/range/plausibility checks
  against every table a scheduled job writes, alongside job-heartbeat monitoring, from the first
  production job — not bolted on after ~95 fetchers exist.
- **Every swallowed exception must log its content before falling back**, and any catch-and-continue
  path must be visible in a status/health endpoint, not just the server console.
- **A daily digest of "needs attention / changed / unchanged"** rather than re-running every check
  on every digest build — cheap to get right at the start, expensive to retrofit once every job
  already re-executes its own checks synchronously.

---

## PROMPT TO USE (paste this into a fresh Claude Code session / new repo)

```
I'm building a new Indian stock market intelligence platform from scratch — call it
"<name>". This is a ground-up rebuild informed by a prior system's real production
incidents and proven/unproven features (details below). Build for accuracy, reliability,
and a small proven feature set — not maximum feature count.

STACK (fixed, do not deviate without discussing first):
- DB: PostgreSQL 16 + TimescaleDB (hypertables for all time-series tables). No SQLite,
  no dual-schema dev fallback — one schema-of-record, managed by real migrations
  (drizzle-kit or node-pg-migrate).
- Backend: TypeScript, Express + tRPC (httpBatchLink), BullMQ for scheduled jobs,
  Redis for cache + queue broker (single instance, no dual local/prod configs that drift).
- Frontend: React 19 + Vite + the same tRPC client for full type safety end-to-end.
- ML: Python engines invoked as subprocesses with a single, unit-tested concurrency
  semaphore (test must simulate queue contention and assert the counter returns to
  exactly zero after N acquire/release cycles under contention — this exact bug class
  caused a multi-hour production incident in the prior system).
- Add an MCP server exposing read-only tRPC procedures (stock lookup, technical scan,
  screener query, backtest) as MCP tools, for agent-driven ops and future chat features.
  Do not build a bespoke RAG chatbot stack up front.

DATA MODEL (single source of truth, no parallel tables per idea):
- One canonical identifier: NSE symbol. One `symbol_mapping` table resolving every
  provider's opaque ID (Yahoo `.NS` suffix, MoneyControl, Trendlyne, ISIN, etc.) FROM
  the NSE symbol — never derive the NSE symbol from a provider ID, never guess a
  provider ID by string convention.
- One `engine_scores(symbol, date, engine, score, metadata)` table that every scoring
  engine writes a *component* score into (never a competing "final" score table).
  One `recommendations` table produced by a single ranker that blends engine_scores.
  One `signals` table + one `signal_outcomes` table for anything that looks like a
  trade call — do not create a second signals table for a "better" version of the
  same concept; extend the one table.
- One `feature_store(symbol, date, ...)` table, point-in-time keyed, extended by
  column as new features are added — not a per-engine feature builder re-deriving
  overlapping features.
- Every slow-moving fact (fundamentals, analyst estimates, shareholding) gets a
  `<fact>_history(symbol, as_of_date, ...)` snapshot table, accessed ONLY through one
  shared `as_of(table, symbol, date)` helper used identically by training, backtesting,
  and live scoring. This is the single most important anti-look-ahead-bias mechanism —
  do not let any engine implement its own "latest value as of date" join. Enforce this with
  a lint/test — "mostly as-of, one exception" is exactly the leak class that bit the prior
  system.
- One `factor_breakdown_history(symbol, date, category, score)` snapshot table, written from
  the very first day scoring runs — this is what lets any regime-conditional weighting be
  fit from real outcomes later instead of staying a hand-set, never-validated guess.
- Every blended/composite score row carries an explicit engine-coverage field (how many
  independent component scorers had data for this symbol) — a score built from 2 components
  and one built from 7 must never look identical downstream.

DATA CATEGORIES TO COVER (breadth already proven valuable in the prior system — build all of
these, but each MUST go through the fetcher → feature → consumer → retrain pipeline as one
atomic unit of work, never a table alone; do not add more than this list without a specific,
named gap):
technical (RSI/ADX/volume/SMA/52w-high, cross-sectional relative strength, momentum),
fundamental (quality/value/growth/size ratios, Piotroski F-score, Altman Z / Ohlson O),
earnings (surprise history, beat/miss streaks, exact days-to-earnings from a real calendar,
not a coarse "results season" flag), analyst consensus (buy%, coverage count, target upside),
ownership (FII/DII/MF % + deltas, promoter pledge level + trend, insider buy/sell activity,
block deals), options/derivatives (IV rank/skew, OI change, max-pain distance, rollover %,
cost-of-carry), intraday microstructure (opening-range break, VWAP deviation, volume share),
sentiment (news-model tone, e.g. FinBERT, with a secondary broad-coverage fallback source),
sector/global correlation used ONLY as a per-stock interaction term (a raw market-level
scalar like VIX or a sentiment index applied identically to every stock has been shown NOT
to help a per-stock classifier — ablate before keeping any market-level feature standalone),
and market regime (a small number of classes gating both engine weights and category tilts).

ML METHODOLOGY (non-negotiable, each point traces to a real prior incident):
1. Prefer cross-sectional, forward-labeled classifiers (e.g., P(stock moves >= X% within
   N days), labeled from FUTURE OHLCV, ranked as a universe percentile) over path-dependent
   win/loss-on-our-own-signal labels. The former is leak-resistant by construction; the
   latter carries selection bias from whatever emitted the original signal.
2. Any forward-looking label MUST be purged by DATE with an embargo period, never by row.
   Row-level purging silently leaks and inflates AUC (an early version of this pattern
   without the fix produced a 0.73 AUC that was really 0.61 once fixed — 20% inflated,
   entirely a purging artifact, not a real improvement). Write a regression test that
   would catch this: assert OOF AUC from a deliberately-row-purged split differs from the
   date-purged split beyond a small tolerance, and treat a pass as a red flag to investigate.
3. Track LIVE, deployed, per-regime AUC of any probability you ship — not just training-CV
   AUC — from week one. Persist it (model, regime, date, auc, n). Do not let any downstream
   gating, position sizing, or emission-filtering logic key off a probability until its
   regime has cleared an explicit, documented live-AUC trust floor with a minimum sample
   size. Training-CV AUC of 0.75 can coexist with live AUC of 0.50 in the dominant regime —
   assume this gap exists until measured otherwise, don't assume CV number transfers.
4. Every model retrain must pass an explicit promotion gate (beats the currently active
   model on held-out AUC by a margin, doesn't regress top-decile precision) before flipping
   is_active. Back up the previous model artifact with a timestamp before overwriting —
   never overwrite-in-place with no rollback path.
5. No fallback value may default to something directionally biased (e.g., a sentiment
   fallback defaulting to "maximally bullish" on any parse failure). Every fallback needs
   an explicitly neutral value and a logged reason for taking that path.
6. Classify every candidate feature as cross-sectional (per-stock, ranks within the day's
   universe) vs market-level (a single time series like an index or VIX applied to every
   stock) BEFORE wiring it into a per-stock model, and validate market-level features
   actually help via ablation before keeping them — this distinction determined which
   features had real value versus none in the prior system's experiments.
7. Decide the label design (binary win/loss vs. 3-class vs. continuous forward-return) up
   front as a first-class methodology choice — train the alternative alongside the primary
   target from the first model and compare through the same promotion gate as #4, rather
   than shipping binary-only and treating a redesign as a future, high-blast-radius project
   once dozens of consumers already assume a binary probability.
8. Any regime-conditional weight/tilt shipped before enough history exists to fit it must be
   clearly marked as a temporary hand-set prior (not asserted as correct) and must be paired,
   in the same piece of work, with the `factor_breakdown_history` capture that will let it be
   backtested and replaced with a fitted value once enough data accumulates.
9. Outcome-resolution / feedback-loop queries must be set-based/batched from the first
   version — never a per-row loop of sequential queries. A feedback loop that lags due to a
   slow batch job is training/calibrating on stale evidence, which silently masks whether the
   model has real live edge (see #3).

DECISION ARCHITECTURE (the part that makes the system "think like a trader," not just score):
- One ranker blends multiple independent component scores (rules/screener consensus, calibrated
  ML meta-label, cross-sectional rank, technical composite, any proven forward-labeled
  classifier), reweighted by market regime. Never rely on one monolithic model's score alone.
- A fundamental quality gate demotes technically-strong-but-fundamentally-weak names; a hard
  veto removes any name with a governance/solvency red flag from the buy pool regardless of
  score — implement both as explicit, testable functions, not scattered conditionals.
- Position sizing is derived from a calibrated win-probability via a meta-labeling bet-size
  function (inverse-volatility weighted, per-name capped) — never naive score-ranking with no
  sizing logic.

REASONING LAYER (System 2 — build only once the above is live, measured, and trustworthy):
- Add a scheduled, structured-output synthesis pass over top-ranked symbols that reads ONLY
  already-computed facts (scores, factor breakdown, catalyst/earnings calendar, red flags,
  sentiment trend, regime) and produces: supporting facts, contradicting facts, an
  invalidation condition, and a narrative-confidence score kept separate from the quant score.
  This is what actually reasons across domains the way a human analyst weighs conflicting
  evidence — a weighted blend alone cannot articulate "breakout, but pledge rising and
  earnings in 2 days."
- Hard boundary, no exceptions: this layer may only suppress/demote/flag the deterministic
  score — it can never raise a score, and it can never emit a probability or a price level.
  All numeric outputs stay entirely inside System 1 (the deterministic quant layer). Store
  every synthesis output so its flags can later be checked against realized outcomes.

RELIABILITY / OBSERVABILITY (build these WITH the first production job, not after):
- Every scheduled job handler throws on failure; nothing may catch-and-report success
  regardless of internal step outcomes. A job orchestrator wrapper enforces this contract
  once, centrally — not per-worker convention.
- Ship automated data-quality checks (freshness, coverage, plausibility ranges) against
  every table a scheduled job writes, running on the same cadence as job-heartbeat
  monitoring, from the very first fetcher/job. A job that "succeeds" while writing empty,
  stuck, or implausible data must be caught by a check, not discovered by a human running
  a manual audit weeks later.
- Every swallowed exception logs enough content (the actual error/response, not just
  "caught") to diagnose without reproducing.
- Any catch-and-continue fallback path is visible in a health/status endpoint, not just
  server console output.

WHAT NOT TO BUILD (explicitly out of scope at launch — proven low-value, premature, or a known
bias trap in the prior system; revisit only after the core pipeline is live and monitored):
- No chatbot/RAG stack, no RL meta-controller, no market-map visualization, no more than
  one external screener-data provider, no SQLite dev-fallback schema, no per-idea scoring
  table. Add any of these later only against a specific measured gap, not by default.
- No generative/LLM output is ever allowed to become a number anything downstream trusts —
  no score, probability, position size, or price/target/stop level. Ever. This is a hard
  boundary, not a style preference — the prior system had to build a deterministic override
  specifically because this went wrong once already.
- No regime-conditional weight or category tilt shipped as a permanent hand-set value without
  the history-capture table that will let it be backtested — ship the snapshot alongside the
  heuristic, not "later."
- No gating, sizing, or emission logic keyed off a probability's training-CV AUC — only its
  measured, live, per-regime AUC, cleared against an explicit trust floor.
- No System-2 reasoning/narrative layer before System 1's scores are proven and monitored —
  sequencing matters; a confident narrative over an unreliable score is worse than none.

DELIVERY SEQUENCE (in order — do not parallelize past step 3 until it's proven):
1. Schema + migrations + symbol_mapping + as_of() helper + factor_breakdown_history +
   one ingestion pipeline (OHLCV) with data-quality checks wired in from the start.
2. One cross-sectional forward-labeled classifier end-to-end: feature_store → training
   with date-purged CV → engine_scores write → a trivial ranker → recommendations table.
   Include the label-design comparison (point 7 above) in this same first pass, not later.
   Prove the leak-free methodology on this ONE model before adding a second.
3. Live per-regime AUC monitoring for that model, ALERTED not just computed, running against
   real (or replayed historical) data, BEFORE building a second model or any UI beyond a
   minimal internal view of its output.
4. The decision layer: regime-gated multi-engine blend + quality gate + hard veto + 
   meta-labeling position sizing, once there are at least two independent component scores
   worth blending.
5. tRPC API surface + MCP server exposing it + minimal React frontend (dashboard, stock
   detail, signals, backtest, watchlist).
6. Expand feature surface (sector/index/F&O/sentiment/portfolio, more screener sources,
   more ML engines) only after 1-5 are live and monitored, each new addition following
   the same "prove leak-free, prove live edge, prove reliability" bar.
7. Only once 1-6 are live and monitored: the System-2 reasoning/synthesis layer, strictly
   grounded and strictly non-numeric per the hard boundary above.

Ask me clarifying questions about scope, deployment target, and data-vendor budget before
writing code. Do not guess vendor API endpoints — if you need a data source not specified
here, ask for a working URL/API key rather than researching or scraping speculatively.
```

---

## Notes for whoever runs this prompt

- The prompt above is intentionally opinionated and narrower than the old system's final
  feature set. That's deliberate — the old system's own audit trail shows the accuracy ceiling
  is currently set by *methodology correctness* (leak-free labels, live-vs-CV AUC gap,
  reliability of the data pipeline feeding the model), not by feature count. Adding features
  before that foundation is proven repeats the mistake.
- If reusing any code from the old repo (symbol mapping tables, the breakout classifier's
  feature logic, the atr-barrier exit geometry), port the *logic*, not the surrounding
  infrastructure (SQLite fallback, per-engine table, ad hoc fetch/retry code) — re-implement
  those pieces against the new architecture's shared helpers instead of copying the file.
- Revisit the "what to drop" list before each new feature addition, not just at project start —
  the old system's sprawl happened incrementally, one reasonable-looking addition at a time.
