# Ingestion & Backfill Pipeline Guide

Living documentation of every data-fetching/backfilling process onboarded or upgraded in the
2026-08-31 → 2026-09-01 sessions: what it does, how it runs, measured performance, coverage
reality, and when to prefer it. Verification queries included so any claim here can be
re-checked against the live database in seconds.

---

## 1. `src/server/mcp_client.py` — MCP stdio client (the enabler)

Minimal MCP JSON-RPC 2.0 client over stdio, **stdlib-only** (no `mcp` pip package):

```python
from mcp_client import McpStdioClient, McpError
mcp = McpStdioClient(["python", "-m", "finstack.server"])   # any stdio MCP server command
tools = mcp.list_tools()            # handshake + tools/list (finstack: 95 tools)
text = mcp.call_tool("cash_flow", {"symbol": "INFY", "quarterly": True})
```

- Spawns the same command the user's own `mcpServers` config uses; id-correlated responses;
  banner-tolerant newline framing; raises `McpError` on transport failure.
- Tool-level business errors (e.g. "no data for RELIANCE") arrive as JSON error envelopes —
  **callers must treat them as skip signals, never fabricate data**.
- Runs under the repo venv, but spawns the server via the **PATH python** — the host needs the
  server's package installed there (`pip install finstack` for system python 3.11).
- One `McpStdioClient` per process channel; parallelize by spawning several clients
  (the fetcher below runs 6 and hands them out through a queue).
- **Hardened 2026-09-01** (after a live full-universe hang): every request is timeout-bounded
  (`CALL_TIMEOUT_SEC`, default 120s — a wedged server raises `McpError` instead of blocking
  forever); stderr is drained by a daemon thread so a chatty server can't fill the OS pipe
  buffer and deadlock; dead-server writes normalize to `McpError`.

**Future candidates via this same client** (finstack inventory, live-verified 95 tools):
`nse_insider_trading`, `promoter_shareholding`, `promoter_pledge` (P0 #4 insider wake-up),
`options_greeks`/`options_oi_analytics` (P4 #17 IV rank), `credit_ratings`,
`nse_quarterly_results`. DalalOS stays MCP-only (REST is plan-gated 403) and joins the moment
its launch command is known — same client.

## 2. FinStack quarterly cash-flow — `finstack_cashflow_fetcher.py`

| What | Where |
|---|---|
| Data | Quarterly CFO/CFI/CFF/capex/FCF per stock (finstack `cash_flow` tool → yfinance `quarterly_cashflow`) |
| Table | `finstack_cashflow_history` — PK `(symbol, period_end)`; columns `ocf, cfi, cff, capex, fcf, currency`; idempotent weekly convergence |
| Schedule | Weekly step in `processMlWeeklyRetrain` (`queues.ts`), 40-min budget, after the marketsmojo trio |
| Manual run | `backend-python\venv\Scripts\python.exe src/server/finstack_cashflow_fetcher.py` (flags: `--symbols A,B`, `--limit N`, `--workers 6`, `--server-cmd`) |
| Measured | Full universe 2,005 symbols ≈ 8 min at 6 workers; INFY/TCS/WIPRO 4 quarters each in the validation run |
| Coverage truth | **Partial by vendor**: Yahoo carries quarterly CF for a subset of NSE (INFY yes — and in **USD**, stored per-row in `currency`; RELIANCE no). Error envelope → skip, never fabricate |
| Currency caveat | INFY is USD-reported; never mix currencies without grouping by `currency` |

Verification:

```sql
SELECT currency, COUNT(*), COUNT(DISTINCT symbol) FROM finstack_cashflow_history GROUP BY currency;
SELECT * FROM finstack_cashflow_history WHERE symbol='INFY' ORDER BY period_end DESC;
```


## 3. `dalalos_financial_trends_history` — table name is legacy, live data is MarketsMojo-sourced

**Corrected 2026-09-01 — this section previously conflated two different, independent
mechanisms that happen to write the same table.** `dalalos_financial_trends_backfill.py`
(the MCP-bridge harvester below) only ever reached a 16-symbol seed — DalalOS is
interactive-MCP-only, so a "64-second harvest window" could not and did not produce
1,684-symbol coverage. The current **62,655 quarterly rows / 1,684 symbols** (period_end
2005-03-31 → 2026-06-30) all carry `source = 'marketsmojo_financials'`, written by a
**different, separately-reviewed script**, `backfill_financial_trends_all.py` — it reshapes
the already-fetched `marketsmojo_financials_history` (4.25M raw line-items, normally
scheduled, no MCP bottleneck) into this table's shape and overwrote every DalalOS-sourced
row via `ON CONFLICT DO UPDATE (symbol, period_end, period_type)`. That script is a genuine
improvement (eliminates the fetch bottleneck instead of just caching around it), but as of
this correction it is not wired into the scheduler and the table has no freshness check.

| What | Where |
|---|---|
| Data | Up to 12+ real quarters per stock: revenue, EPS, margins, QoQ/YoY growth (+ company-level fields) |
| Table | `dalalos_financial_trends_history` — PK `(symbol, period_end, period_type)`; migration `20260831143000_dalalos-financial-trends-history.sql`. Name is now misleading — see correction above |
| Live coverage | **62,655 quarterly rows / 1,684 symbols** (72% of universe), 100% `source='marketsmojo_financials'` |
| DalalOS MCP bridge (original mechanism, superseded) | `dalalos_financial_trends_backfill.py` — `parse_financial_trends()` + `write_financial_trends_rows()` over `dalalos_financial_trends_seed.json` (16-symbol seed, `d1d1a5e`). DalalOS is MCP-tool-only (REST returns `403 {"error": "The rest API is not included in your plan"}`) — a Claude session has to be the bridge, Python can't call MCP tools itself. Still usable for any symbol the MarketsMojo reshape doesn't cover, but no longer the live data source for this table |

**To extend coverage further**: re-run `backfill_financial_trends_all.py` after
`marketsmojo_financials_fetcher.py` refreshes (currently manual — neither is scheduled
together). The DalalOS MCP path remains available as a fallback for symbols MarketsMojo
doesn't have. Verification:

```sql
SELECT COUNT(*), COUNT(DISTINCT symbol),
       MIN(period_end), MAX(period_end),
       COUNT(*) FILTER (WHERE revenue IS NOT NULL AND eps IS NOT NULL)
FROM dalalos_financial_trends_history;
```

## 4. ET annual cash-flow harvest — `et_cashflow_history` (automatic piggyback)

The ET_Stats fetch in `financial_ratios_fetcher.py` already pulled a 6-year annual
CFO/CFI/CFF CashFlow payload and discarded it; commit `192e6b2` now upserts it into
`et_cashflow_history (symbol, year_ending)`. **No separate job/backfill is needed** — it
accumulates automatically on the fetcher's own monthly cadence (annual-refresh data).
Quarterly granularity from ET remains unavailable; that gap is covered by FinStack (§2).

## 5. Hybrid analyst-estimates engine — `analyst_estimates_snapshot.py`

| What | Where |
|---|---|
| Data | Target high/mean/low, n_analysts, final_rating, buy/hold/sell counts, forward EPS, revenue estimate — 12 columns in `analyst_estimates_history` |
| Engine | `_fetch_symbol_hybrid`: **yfinance direct structured feed first** (0.04% mean target-price delta vs MC across 48 overlapping names), **MoneyControl merge as fallback** for real buy/hold/sell counts; 12-worker thread pool |
| Schedule | `analyst-estimates-sync-daily` (sync.jobs.ts, Mon–Fri 14:15 UTC, 8-min budget); the old weekly call inside `processMlWeeklyRetrain` was removed (double-scheduling defect) |
| Measured | **Full universe 2,338 symbols in 156.6s (2.6 min), 1,052 rows written** — live-run 2026-09-01, matches the documented ~47 min → ~2.5 min upgrade; yfinance 401/404 per-symbol noise is absorbed by the MC fallback |
| Coverage delta | Hybrid measurably improved forward-EPS coverage: `eps_est_next` NULLs **38.8% → 25.9%** vs the old engine's 2026-08-29 snapshot; rating columns ~0.1–0.4% NULL; remaining NULLs are genuine no-coverage microcaps (both sources) — honest unknowns, never synthetic splits |
| Guardrail | `buy/hold/sell` are NEVER derived from `recommendationMean` (would poison ML training); real counts only |

Verification:

```sql
SELECT COUNT(*),
       COUNT(*) FILTER (WHERE eps_est_next IS NULL)      AS eps_null,
       COUNT(*) FILTER (WHERE buy_count   IS NULL)       AS buy_null
FROM analyst_estimates_history WHERE as_of_date = (SELECT MAX(as_of_date) FROM analyst_estimates_history);
```

Tests: `src/server/tests/test_analyst_estimates_snapshot.py` (24 cases).

## 6. Which source to use, for what (decision matrix)

| Need | Best source today | Why |
|---|---|---|
| Quarterly cash-flow (OCF/FCF…) | **FinStack MCP** (§2) | Only real quarterly CF feed; partial NSE coverage, per-row currency |
| Annual cash-flow (6y) | ET harvest (§4) | Automatic, already flowing |
| Quarterly revenue/EPS/growth history (deep, 2005+) | **DalalOS table** (§3) | Largest, deepest; extend via MCP bridge |
| Analyst targets/consensus/forward EPS | **Hybrid engine** (§5) | Fastest (2.6 min), widest coverage, daily |
| Revenue estimates next-period | MC fallback inside hybrid | Only source carrying them |

## 7. Operational notes

- **Deploy coupling**: schedule changes (new jobs, removed weekly call) take effect only when
  the pm2 `bharat-server` worker restarts. Deferred restarts are safe — catch-up machinery
  re-queues missed scheduled runs — but do NOT restart while a heavy training job is in flight
  (check `Get-Process python` for a multi-GB/CPU-hours process first).
- `finstack` must be installed for the **PATH python** on the host (`pip install finstack`),
  not only in the repo venv — the MCP server process is spawned via PATH.
- **Throttling reality check** (live 2026-09-01): under a hard Yahoo throttle the FinStack
  pass crawls (~5 symbols/6 min) — each wedged call now times out at 120s, the channel is
  recycled (cap 50), the symbol honest-skips, and the run always tears down every MCP server
  process (`finally` close-by-registry; verified zero orphans). The weekly cadence + PK
  upsert is what converges coverage, so a slow pass is safe, never wrong.
- Budgets: analyst daily 8 min (uses ~3 of it), finstack weekly 40 min (uses ~8), ET harvest
  rides the existing monthly ET budget. No new timeouts introduced.
- Honest-unknown rule applies across all four pipelines: a missing symbol/figure is skipped
  and stays NULL — it is never fabricated, never backfilled with guesses.

