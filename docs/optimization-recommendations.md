# Optimisation & Production-Hardening Recommendations

Written 2026-08-13. Every item below is justified against something actually observed in this
repo — a missing config file, a measured size, or a bug class `recurring-bugs.md` already records
as having recurred. Nothing here is "popular library, you should probably use it."

**Everything listed is free** (OSS or a free tier that covers a single-box deployment).

Cost labels: **S** = an afternoon. **M** = a few days. **L** = a multi-week project you should
not start without a reason.

---

## What the survey actually found

| Observation | Evidence |
|---|---|
| 502 `.py` files, **no linter, no formatter, no type checker** | no `pyproject.toml` / `setup.cfg` / `.ruff.toml` / `mypy.ini` anywhere |
| 425 `.ts`/`.tsx` files, **no ESLint** | no `eslint.config.*`; `npm run lint` is `tsc --noEmit` |
| Python deps **completely unpinned** | `requirements.txt` is bare names (`pandas`, `numpy`, `sqlalchemy`, …) |
| **Zero metrics instrumentation** | no `prom-client`, no OpenTelemetry, no `/metrics` anywhere |
| 34 cron registrations, 200 `runPython()` call sites | `queues.ts`, `grep -c runPython` |
| ~1 MB of static data compiled into the browser bundle | `stocklist.ts` 600 K + `nseStocks.ts` 444 K, imported by 13 frontend components |
| 110 files import pandas; DB reads go through `read_sql` | `db_compat.read_df` |
| No real-Postgres test harness | `recurring-bugs.md`: "A NaN-detection test on SQLite passes against unfixed code" |
| No experiment tracking for ~30 ML engines | no MLflow/W&B; promotion gates are hand-rolled in `model_promotion` |
| Health endpoint is a bare liveness ping | `server.ts:522` — no dependency readiness |

---

## Tier 1 — highest value for *this* codebase

These four map directly onto the failure classes that dominate `recurring-bugs.md`. If you do
nothing else, do these.

### 1.1 `ruff` + `mypy` — Python static analysis (**S**)

502 Python files with no static analysis at all, in a repo whose #1 documented bug class is
*"a column referenced in SQL that doesn't exist"* and whose #2 is *"`float(x or 0)` on a value
that can be NaN"*.

- **[`ruff`](https://github.com/astral-sh/ruff)** — one binary, replaces flake8/isort/pyupgrade/pylint, runs the whole tree in <1 s. The rule sets that pay for themselves here: `B` (bugbear — catches mutable defaults, `except Exception: pass`), `PD` (pandas-vet), `DTZ` (**flags naive `datetime.now()`/`date.today()` — the exact 11-file write-anchor class**), `S608` (SQL injection / string-built SQL), `RUF` .
- **[`mypy`](https://github.com/python/mypy)** in `--strict`-off mode, opted in per-module via `[[tool.mypy.overrides]]`. Start with `as_of.py`, `db_compat.py`, `sql_translate.py`, `unified_ranker.py`, `scoring_engine.py` — the five files everything else depends on. `recurring-bugs.md` explicitly notes that `float(x or 0)` "needs type information the script doesn't have"; mypy is that type information.
- **[`ty`](https://github.com/astral-sh/ty)** (Astral's new type checker) is worth watching but is not yet a mypy replacement — don't bet the repo on it.

Wire both into `scripts/check_recurring_bugs.py`'s CI lane, `--diff`-scoped exactly as that
script already is, so you block new violations without clearing the backlog.

### 1.2 `uv` + a locked, hashed `requirements.txt` (**S**)

`recurring-bugs.md` has a whole "Environment & deploy" section whose first entry is
**"Declared ≠ installed"** — `node-pg-migrate` declared but not installed, `nse` in
`requirements.txt` but not in the venv, both silently breaking live jobs for days. An unpinned
`requirements.txt` guarantees this recurs, and also means CI and production are running
different sklearn/pandas versions on any given day.

- **[`uv`](https://github.com/astral-sh/uv)** — 10–100× faster than pip, and crucially gives you `uv lock` / `uv sync --frozen`: a real lockfile with hashes. `uv sync --frozen` fails loudly when the venv doesn't match the lock, which turns "declared ≠ installed" from a silent multi-day outage into a startup error.
- Keep the CUDA torch install as a separate `[tool.uv.sources]` index entry — `uv` handles the `--index-url` split cleanly, which the current `grep -v '^torch'` hack in CI is working around.
- Same move on the Node side is already done (`package-lock.json` + `npm ci`); Python is the asymmetry.

### 1.3 `prom-client` + `OpenTelemetry` + Grafana — the missing observability layer (**M**)

This is the single biggest structural gap. Read the monitoring blind spots in
`recurring-bugs.md` and note what they have in common:

- a job whose skip path stamped `success` over 13 real failures, **daily, for two sessions**;
- `extra_endpoints_fetcher.py` SIGKILLed at its 30-min budget **every night**, so its last
  statement never ran and 14 feature columns stayed at 0%;
- `marketsmojo_technical_fetcher.py` doing 2,010,101 writes for 2,787 new rows (721:1) and
  getting killed at 12% of the universe;
- a freshness monitor reading a correctly-gated job as "stale".

Every one of those is *invisible in logs and visible in a metric*. Concretely:

- **[`prom-client`](https://github.com/siimon/prom-client)** in `bharat-server`, exposed at `/metrics`. Instrument in `pythonRunner.ts` (one place, covers all 200 call sites): a histogram of `python_script_duration_seconds{script}`, a counter of `python_script_exits{script,reason="ok|timeout|buffer|error"}`. The `reason="timeout"` counter alone would have surfaced the `extra_endpoints_fetcher` kill on night one.
- BullMQ metrics: job duration, wait time, `failed`/`completed`/`stalled` counters per queue. `bullmq` exposes the events; ~40 lines in `queues.ts`.
- DB write amplification: rows-written vs rows-changed per fetcher. This is the metric that makes a 721:1 ratio a chart instead of an archaeology session.
- **[`prometheus`](https://github.com/prometheus/prometheus) + [`grafana`](https://github.com/grafana/grafana)** — two more services in the existing `docker-compose.yml`, ~30 lines. Add **[`postgres_exporter`](https://github.com/prometheus-community/postgres_exporter)** and **[`redis_exporter`](https://github.com/oliver006/redis_exporter)** while you're there.
- Alerting: you already push to Telegram from `dataQualityChecks.ts`. Point Grafana's alertmanager at the same webhook rather than building a second path.
- **[`@opentelemetry/auto-instrumentations-node`](https://github.com/open-telemetry/opentelemetry-js-contrib)** gives you HTTP/pg/ioredis/express spans for free, and Sentry (already installed, `src/server/sentry.ts`) ingests OTel traces natively — so you get distributed tracing without adding a backend.

**Caveat, stated plainly:** metrics tell you a job wrote 0 rows. They do *not* tell you the rows
it wrote are wrong. `dataQualityChecks.ts` remains the layer that answers that, and
`recurring-bugs.md`'s "a fresh table is not a delivered feature" finding still applies.

### 1.4 `testcontainers` + `freezegun` + `hypothesis` — close the three test-harness holes (**S–M**)

`recurring-bugs.md`'s "Testing" section is a list of ways this repo's tests have been green while
protecting nothing. Three specific libraries close three specific holes:

- **[`testcontainers-python`](https://github.com/testcontainers/testcontainers-python)** — spins a real TimescaleDB per test session. This closes *"A NaN-detection test on SQLite passes against unfixed code"* (SQLite coerces NaN to NULL on insert) and *"A column type assumed from `db.ts`"*. CI already runs a Postgres service for the smoke lane; testcontainers extends that to pytest without hand-managing the service block.
- **[`freezegun`](https://github.com/spulec/freezegun)** — the `date.today()` write-anchor class has **11 files / 10 recurrences** and the `CASE WHEN date >= x ELSE NULL` variant nulls entire column histories on weekends. A test that runs under `@freeze_time("2026-08-15")` (a Saturday) makes that class fail in CI instead of silently in production on Saturday morning. Pair it with the `DTZ` ruff rules from §1.1.
- **[`hypothesis`](https://github.com/HypothesisWorks/hypothesis)** — property-based testing for `as_of.py` (`trading_days_back`, `logical_trading_date`, `logical_session_date`) and `sql_translate.py`. The `::double precision` multi-word-cast bug is exactly what a generative test over type names finds and a hand-written test does not.
- **[`pytest-xdist`](https://github.com/pytest-dev/pytest-xdist)** for the 391-test suite, and **[`pytest-randomly`](https://github.com/pytest-dev/pytest-randomly)** to surface the shared-state leaks `recurring-bugs.md` already flags (`USE_POSTGRES` leaking between files in one worker).

---

## Tier 2 — measurement integrity

`measurement.md` opens with a banner about two bugs *in the backtest harness itself*, and states
the principle directly: **"A bug in the measurement tooling itself is worse than no measurement,
because it looks like evidence."** The fix for that class is to stop hand-rolling the parts that
are standard.

### 2.1 `statsmodels` — correct t-stats (**S**, high value)

Every t-stat in `measurement.md` is a per-date-then-average t-stat. If those are computed as a
plain `mean / (std / sqrt(n))`, they are **overstated** on overlapping-horizon returns — a 21-day
forward return sampled daily has ~21 days of autocorrelation, and the naive t-stat ignores it.

- **[`statsmodels`](https://github.com/statsmodels/statsmodels)** gives you Newey–West HAC standard errors in one line (`OLS(...).fit(cov_type='HAC', cov_kwds={'maxlags': h})`). This is the standard correction in every published factor paper and it is not optional for overlapping returns.
- Practical consequence: some of the "significantly negative" verdicts (`stoch_d` t=−9.28 etc.) will survive comfortably; several of the marginal ones (`insider_net` t=1.73, `value_book_to_price` t=1.99) will move. Given `measurement.md` already retracted `insider_net` once for failing to reproduce, this is worth knowing before another number gets cited.
- Also gives you `multipletests()` for the FDR/Bonferroni corrections the file applies by hand.

### 2.2 `alphalens-reloaded` / `vectorbt` — cross-check `factor_backtest.py` (**M**)

Not a replacement — a **control**. `measurement.md` says to "reproduce at least one already-known
result before trusting a harness change's new ones." A second, independently-written harness is
the strongest form of that.

- **[`alphalens-reloaded`](https://github.com/stefan-jansen/alphalens-reloaded)** — the maintained fork. Takes `(date, symbol) -> factor value` plus a price panel and produces quantile returns, IC (including rank IC with proper decay), turnover, and sector-neutral variants. Its turnover accounting would have flagged the 90–93% one-way turnover on `gap_down`/`gap_up` immediately.
- **[`vectorbt`](https://github.com/polakowo/vectorbt)** (OSS version) — fast vectorised portfolio simulation; useful specifically for the exit-pricing accounting that produced the −100%-on-unpriced-name bug.
- **[`empyrical-reloaded`](https://github.com/stefan-jansen/empyrical-reloaded)** for the risk statistics (Sharpe, max DD, tail ratio) rather than hand-rolling them.
- Run one already-settled factor (`high_vol`, t=−6.09) through the external harness. If it reproduces, you have a trustworthy control; if it doesn't, you've learned something important.

### 2.3 `pandera` — schema contracts at the fetcher boundary (**S**)

The `trendlyne_screener_discovery.py` incident — a raw profile URL written into the `symbol`
column, corrupting ~2.1M rows across 7 tables — was found by a live DB review, not a test.
`data-sources.md`'s `live_datasource` test mandate is the right fix and is already in place, but
it only fires when someone runs it.

**[`pandera`](https://github.com/unionai-oss/pandera)** adds a declarative DataFrame schema that
runs on **every** write, in production:

```python
class OhlcvSchema(pa.DataFrameModel):
    symbol: Series[str] = pa.Field(str_matches=r"^[A-Z0-9&\-]{1,20}$")   # not a URL
    close:  Series[float] = pa.Field(gt=0, nullable=False)
```

That `str_matches` is a one-line, permanent version of `assert_looks_like_ticker`. Its
`nullable=False` + finite checks are the permanent version of `assert_numeric_and_finite`.
Cheapest available insurance against the single most expensive incident in this repo's history.

### 2.4 `mlflow` — experiment tracking for ~30 engines (**M**)

`recurring-bugs.md`: *"A champion/challenger gate is meaningless if run-to-run seed noise is wider
than the champion/challenger gap"* — measured at 9.95–11.17 across 6 seeds against an incumbent at
11.02. That finding required someone to manually re-run six seeds and compare.

**[`mlflow`](https://github.com/mlflow/mlflow)** (self-hosted, free, backs onto your existing
Postgres) logs every training run's params/metrics/artifacts automatically. The seed-spread
question becomes a chart. Its Model Registry also gives you a real answer to *"A stale baseline
can become permanently unbeatable"* — staged/production/archived model versions with explicit
promotion, instead of the ad-hoc `model_promotion.staleness_override_applies` flag.

---

## Tier 3 — performance

### 3.1 Frontend: stop shipping ~1 MB of static data to the browser (**S**, biggest single win)

`src/data/stocklist.ts` (600 K) and `src/data/nseStocks.ts` (444 K) are imported by **13 frontend
components** — `CommandPalette`, `AppShell`, `TopRatedStocks`, etc. That is ~1 MB of raw source
(several hundred KB gzipped) in the first-load path, on top of the 2.2 MB entry chunk the
`vite.config.ts` comment already documents.

The current `manualChunks` split explicitly notes it "doesn't reduce first-load bytes". This does:

- Move both to a tRPC procedure backed by a Postgres table (the mappings already exist server-side via `stockMapping.ts`), cached in `@tanstack/react-query` — which is already installed.
- If a synchronous client-side list is genuinely needed for `CommandPalette` typeahead, ship a **trimmed** JSON (symbol + name only, no provider IDs — the provider IDs are server concerns and shouldn't be in a browser bundle at all) and fetch the full mapping on demand.
- **[`vite-bundle-visualizer`](https://github.com/KusStar/vite-bundle-visualizer)** (**S**) — run it once before deciding anything else here; it will tell you exactly what the other 1.2 MB is.
- **[`@tanstack/react-virtual`](https://github.com/TanStack/virtual)** — `react-window` v2 is installed; TanStack Virtual handles variable-height rows and grids better for the dense terminal-style tables in v3/v5.

### 3.2 Python data path: `polars` + `connectorx` (**M**, selective)

110 files import pandas, and reads go through SQLAlchemy `read_sql`, which is the slowest
available path (row-by-row Python object construction).

- **[`connectorx`](https://github.com/sfu-db/connector-x)** — drop-in `cx.read_sql(conn_str, query, return_type="polars"|"pandas")`, typically 3–10× faster than `pandas.read_sql` on wide result sets because it builds Arrow buffers in Rust instead of Python tuples. Lowest-effort win: change `db_compat.read_df` in one place.
- **[`polars`](https://github.com/pola-rs/polars)** — worth it specifically for `factor_backtest.py` and `ml_ensemble.py` (3,352 lines), where the panel operations are group-by-date-then-rank. Do **not** attempt a repo-wide pandas→polars migration; that is an **L** with no payoff outside the hot paths.
- **[`duckdb`](https://github.com/duckdb/duckdb)** — for ad-hoc panel analysis and the backtest harness, it queries Parquet/Arrow directly with correct window functions and no server. Pairs well with caching the 5-year price panel to Parquet once per day rather than re-reading it from Postgres per factor.
- **[`orjson`](https://github.com/ijl/orjson)** / **[`msgspec`](https://github.com/jcrist/msgspec)** — `extra_endpoint_responses` accumulated 419 MB of JSON; stdlib `json` is the wrong parser at that volume.

### 3.3 Python fetchers: concurrency and rate limiting (**M**)

30 raw `requests.get()` call sites, only 2 files use `httpx`, and only 3 files touch `asyncio`.
`fetch_utils.retry_get` is good and should stay — but it's sequential, and
`marketsmojo_technical_fetcher.py` getting killed at 12% of the universe is partly a concurrency
problem.

- **[`httpx`](https://github.com/encode/httpx)** with `AsyncClient` + HTTP/2 and connection pooling, replacing `requests` behind the existing `retry_get` signature so call sites don't change.
- **[`tenacity`](https://github.com/jd/tenacity)** — replaces the hand-rolled backoff loop with a declarative decorator that also handles `retry_if_exception_type`, jitter, and *per-status-code* policies (a 429 should back off differently from a 503; right now they're identical).
- **[`pyrate-limiter`](https://github.com/vutran1710/PyrateLimiter)** or **[`aiolimiter`](https://github.com/mjpieters/aiolimiter)** — per-provider token buckets. `queues.ts:1378` already notes vendor rate-limit trouble with Trendlyne, currently handled by hand-tuned sleeps scattered across fetchers.
- **[`hishel`](https://github.com/karpetrosyan/hishel)** — HTTP caching layer for httpx that honours `ETag`/`Last-Modified`. Directly attacks the 721:1 write-amplification class from the provider side.

**Sequencing note:** fix the write side first. `recurring-bugs.md` is explicit that for the
MarketsMojo case *"the fix is on the write side, not the fetch side"* — read `MAX(date)` per key
and skip what you already hold. Making the fetch faster without that just amplifies faster.

### 3.4 Database (**S**)

- **`pg_stat_statements`** — one line in the `docker-compose.yml` `command:` block (`-c shared_preload_libraries=pg_stat_statements`). Without it you cannot answer "which query is slow" at all, on a database that has already OOM-killed backends and hit `DiskFull` on shm.
- **[`pgvector`](https://github.com/pgvector/pgvector)** — the chatbot uses ChromaDB as a separate store. Moving RAG embeddings into the Postgres you already run removes an entire service and lets you join embeddings against `stock_ohlcv` in one query. The `timescale/timescaledb` image ships pgvector.
- **[`squawk`](https://github.com/sbdchd/squawk)** — migration linter, runs on the `.sql` files in `migrations/` (35 of them). Catches exactly the hazard `CLAUDE.md` warns about: *"Several tables are compressed hypertables where a predicate-wide `UPDATE`/`ADD CONSTRAINT` will fail or destroy compression."* Add it to CI next to `npm run schema:drift`.
- **[`pgbouncer`](https://github.com/pgbouncer/pgbouncer)** — `max_connections=60` with four services plus N spawned Python processes each building their own SQLAlchemy engine is a connection-exhaustion setup. Transaction-pooling mode in front of Postgres fixes it for ~20 lines of compose.

---

## Tier 4 — production hardening

### 4.1 Express (**S**)

`server.ts:295` explicitly says "Not a full helmet() setup (no CSP)".

- **[`helmet`](https://github.com/helmetjs/helmet)** with a CSP configured for Vite's dev inline scripts — the comment says CSP was skipped because of Vite, but `helmet` supports per-environment config, so production can have a real CSP even if dev doesn't.
- **[`express-rate-limit`](https://github.com/express-rate-limit/express-rate-limit)** + **[`rate-limit-redis`](https://github.com/wyattjoh/rate-limit-redis)** — `internalAuth.ts` has a hand-rolled in-memory limiter; Redis-backed makes it survive restarts and work across processes.
- **[`compression`](https://github.com/expressjs/compression)** — not currently applied. On JSON responses carrying 2,000-row screener results this is a large, free win.
- **[`pino`](https://github.com/pinojs/pino)** — 5–10× faster than winston with structured JSON output that Grafana Loki ingests directly. Marginal on its own; worth it if you adopt §1.3.

### 4.2 Health and job visibility (**S**)

- Split `/api/health` (liveness — already correct) from `/api/ready` (readiness: Postgres reachable, Redis reachable, all four pm2 services responding). PM2 restarts a *crashed* process; it cannot see a process that's alive and wedged — which is precisely the AlphaQuant incident `ecosystem.config.cjs` was written for.
- **[`@bull-board/express`](https://github.com/felixmosh/bull-board)** — a real UI over the 34 BullMQ queues: in-flight jobs, failure reasons, retry, stalled counts. This is the single cheapest thing on this list relative to how much time it saves debugging job failures.
- **[`terminus`](https://github.com/godaddy/terminus)** — graceful shutdown so a `pm2 restart` drains in-flight BullMQ jobs instead of orphaning them.

### 4.3 ESLint (**S**)

425 TS/TSX files and the only check is `tsc --noEmit`. **[`typescript-eslint`](https://github.com/typescript-eslint/typescript-eslint)** with `@typescript-eslint/no-floating-promises` alone is worth the setup — an unawaited promise in a BullMQ worker is a silently-swallowed job failure, which is this repo's most-documented failure shape in TypeScript form. Add `eslint-plugin-react-hooks` (the `vite.config.ts` comment documents a real "Invalid hook call" incident) and **[`oxlint`](https://github.com/oxc-project/oxc)** if ESLint's speed on 425 files becomes annoying.

---

## Tier 5 — MCP servers, Claude Code features, and agent tooling

You already have `src/server/mcpServer.ts` (`alphaquant-pro-mcp`, 569 lines, 6 tools). Additions
worth having:

### MCP servers

| Server | Why here |
|---|---|
| **[Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp)** | Read-only DB access **plus index tuning and `EXPLAIN` analysis**. Given how much of this repo's debugging is "query the live DB and check what the fetcher actually wrote", this is the highest-value addition. Configure with a read-only role. |
| **[Sentry MCP](https://github.com/getsentry/sentry-mcp)** | Sentry is already installed in both `@sentry/node` and `@sentry/react`. Lets an agent pull the actual stack trace instead of guessing. |
| **[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)** | Six coexisting dashboard shells, and `CLAUDE.md` warns that "a comment saying it was mirrored has been wrong before". Real browser inspection settles which shell a fix landed in. |
| **[Grafana MCP](https://github.com/grafana/mcp-grafana)** | Only after §1.3. Then an agent can query metrics directly when diagnosing a job failure. |

**Extend your own MCP server** rather than adding more third-party ones: the highest-value tools
you could expose are `check_data_quality(check_id)`, `grade_signals(date_range)`, and
`run_factor_backtest(factor, rebalance, cost_bps)` — the three things every session in
`docs/session-log.md` ends up doing by hand.

### Claude Code features you're not using

- **Hooks** (`.claude/settings.json`) — the biggest one. `scripts/check_recurring_bugs.py` runs in CI *after* the code is written. As a **`PostToolUse` hook on `Edit|Write`**, it fires the moment a violating line is written, when the fix is free. `recurring-bugs.md` says this itself: *"If you fix a class that recurs again, the durable move is a check in that script, not another paragraph here."* A hook is the next step past that. Same for `PreToolUse` on `Bash(git commit:*)` running `npx tsc --noEmit`.
- **`/loop`** — `measurement.md` says the signal-accuracy review is "re-measured weekly by the `signal-accuracy-review-weekly` scheduled task". A `/loop` or a Routine (`create_trigger`) makes that self-driving.
- **Subagents** — you have `.claude/skills/` well developed, but no `.claude/agents/`. A `measurement-auditor` subagent with read-only tools and `measurement.md` preloaded is the natural fit, given how consistently that review has caught real bugs.
- **Output styles / `--append-system-prompt`** — `fable-brain.md` is loaded via `CLAUDE.md` prose. As an output style it applies without competing for attention against the rest of the file.

### GitHub Actions (free for public repos, 2,000 min/mo private)

- **[`dependabot`](https://docs.github.com/code-security/dependabot)** or **[`renovate`](https://github.com/renovatebot/renovate)** — nothing currently updates dependencies. Renovate handles both npm and Python and can group ML-stack bumps into one PR so a torch/sklearn upgrade is reviewed as a unit.
- **[`pip-audit`](https://github.com/pypa/pip-audit)** + `npm audit --production` in CI.
- **[`gitleaks`](https://github.com/gitleaks/gitleaks)** — `.env` is parsed and injected into every pm2 service; a pre-commit + CI scan is cheap insurance.
- **[`pre-commit`](https://github.com/pre-commit/pre-commit)** — runs ruff/gitleaks/`check_recurring_bugs.py` locally before the commit exists.

---

## Explicitly *not* recommended

Honest omissions, because the interesting part of a list like this is what's left off:

- **Prefect / Dagster / Airflow.** The "step at the end of a killed script never runs" bug is a textbook argument for a DAG orchestrator with per-task retries. But migrating 34 cron registrations and 200 `runPython` call sites off BullMQ is a genuine **L** with real regression risk on a live system, and the specific bug is fixed by moving the consumer into its own queue step — which `recurring-bugs.md` already prescribes. Revisit only if the per-task-boundary problem recurs after that fix.
- **Feast / a real feature store.** You already have a `feature_store` table, and `measurement.md` shows the constraint is *data depth* (most tables start 2026-06-30), not feature-serving infrastructure. Feast solves a problem you don't have yet.
- **Ray / Dask.** Single box, 24 GB RAM. `polars` + `connectorx` covers the actual bottleneck; distributed compute adds operational surface for no gain.
- **A pandas→polars repo-wide migration.** 110 files. Hot paths only.
- **Full Cluster B (`technical_signals`→`technical_features`).** `scoring-authority.md` already rejected it on merits — 141 files, cosmetic. Not re-litigating it.
- **Any reweighting-oriented ML library (optuna for factor weights, etc.).** `measurement.md` is unambiguous: *"reweighting the existing engines is not a fix... There is no incumbent factor to beat."* Better optimisation of a zero-edge blend produces a better-optimised zero edge. **The binding constraint on this platform is data depth and measurement integrity, not model sophistication** — which is why Tiers 1 and 2 above are ordered the way they are.

---

## Suggested order

1. **Week 1** (all **S**): `ruff` + `mypy` on the 5 core files · `uv lock` · `pg_stat_statements` · `bull-board` · `helmet`/`compression`/`express-rate-limit` · `squawk` in CI.
2. **Week 2**: `statsmodels` HAC t-stats on `factor_backtest.py` (**this may change published verdicts — treat it as a measurement change and negative-control it**) · `pandera` on the 5 highest-volume fetchers · `freezegun` over the `as_of.py` suite.
3. **Week 3–4**: `prom-client` + Grafana + exporters · `/api/ready` · frontend data-file removal · `connectorx` in `db_compat.read_df`.
4. **Ongoing**: `testcontainers` as pytest fixtures replace SQLite-based DB tests one suite at a time · `alphalens-reloaded` as an independent control on one settled factor · `mlflow` when the next model retrain happens.

Nothing above changes a score, a weight, or a classification, so none of it trips the
`verify-gate.mjs` backtest requirement — **except §2.1 (`statsmodels`)**, which changes the
significance of published numbers and must be treated as a measurement change under
`measurement.md`'s own rules.
