# Project Context — Bharat Stock Intelligence

## Overview
Real-time Indian stock market intelligence platform (NSE/BSE). Express + tRPC backend, React 19 + Vite frontend, PostgreSQL/TimescaleDB, BullMQ jobs, ~210 Python modules in `src/server/` (81 fetchers + ML engines/jobs/helpers).

## Core Domain
- **Universe**: NIFTY 50/500, BSE 500, F&O eligible, SME — mapped via `nse_universe` / `bse_universe` tables
- **Timeframes**: INTRADAY (5m/15m/60m), SWING, POSITIONAL, LONG_TERM — enum stored upper-case
- **Signal Surface**: `unified_recommendations` — single authoritative table per timeframe+symbol+date
- **Scoring**: Multi-engine ensemble (technical, fundamental, flow, ML/DL) → `unified_score` (0-100)

## Data Sources (Canonical)
| Domain | Primary Provider | Fetcher | Freshness Gate |
|--------|------------------|---------|----------------|
| OHLCV (NSE/BSE) | NSE Bhavcopy + NSE API | `nse_bhavcopy_fetcher.py` | Daily 18:30 IST |
| F&O OI/PCR/Max Pain | NSE Option Chain | `nse_option_chain_fetcher.py` | Daily 18:30 IST |
| Delivery / FII-DII | NSE | `stock_delivery_fetcher.py` / `fii_dii_fetcher.py` | Daily 19:00 IST |
| Insider Trades | Moneycontrol | `moneycontrol_fetcher.py` (insider) | Event-driven |
| Earnings / Board Meetings | Moneycontrol | `mc_earnings_fetcher.py` | Event-driven (90-day forward window) |
| News / Sentiment | MarketsMojo + custom | `news_fetcher.py` | Intraday |
| Bulk / Block Deals | NSE + MoneyControl | `bulk_deals_fetcher.py` | Daily |
| Screener Movers | Trendlyne / NSE | `mover_screener_fetcher.py` | 15m during market hours |

## Architecture Notes
- **DB**: TimescaleDB hypertables (`stock_ohlcv`, `feature_store`, `signals`) — compression + retention policies active
- **Jobs**: BullMQ on Redis — `pythonRunner.ts` enforces per-script memory ceilings (Job Objects on Windows)
- **ML/DL**: `dl_trainer.py` / `exit_policy.py` / `cs_ranker.py` — promotion gate = holdout MAE + margin
- **Feature Store**: `feature_engineering.py` — 230+ columns, pipeline order critical (run after upstream writers)

## Operational Rhythms
- **Daily (post-market)**: Bhavcopy → OI/PCR → Delivery/FII-DII → Feature Engineering → Signal generation
- **Intraday (market hours)**: Screener movers every 15m → live recommendations update
- **Weekly (Sat 06:00)**: ML retrain (`ml-weekly-retrain`) + DL retrain (`dl-retrain-weekly`) — exclusive heavy slot
- **Monthly**: ECC quality gates, dependency audit, schema drift check

## Key Constraints
- **Python interpreter**: `backend-python/venv/Scripts/python.exe` (3.11) — CI uses 3.12, test locally with prod venv
- **PostgreSQL only**: SQLite decommissioned 2026-08-19 — `usePostgres()` / `use_postgres()` unconditional
- **pm2 on Windows**: watches wrapper PID; real process memory via Job Objects (`pyboot/sitecustomize.py`)
- **Graphify**: Knowledge graph at `graphify-out/` — query before reading source (`graphify query "..."`)

## Token Reduction Discipline
- `graphify query/path/explain` before raw reads/greps
- `read_files` with line ranges, not full files
- `search_codebase` over `list_dir`/`glob`
- `run_commands` with filtered/tailed output
- Skills (claude-mem, headroom, codebase) as first-class tools — not view_file/grep_search/run_command

## Audit Discipline
- `docs/audit-findings.md` = single open-items tracker (AF-YYYYMMDD-NN)
- Findings closed in same pass unless: Evidence lane, Calendar-blocked, User decision, Sequential dependency
- DoD: `tsc --noEmit` + `vitest run` + `pytest src/server/__tests__/ src/server/tests/ tests/chatbot/` all green

## Issue Tracker (Matt Pocock Config)
- **Location**: GitHub Issues (`kanchankapila/bharat-stock-intelligence/issues`)
- **Triage Labels**: See `.claude/skills/setup-matt-pocock-skills/triage-labels.md`
- **Domain Docs**: `CONTEXT.md` (this file), `AGENTS.md` (agent contracts), `docs/` (deep dives)

## Agent Contracts (Matt Pocock Config)
- **Default Agent**: `agents/openai.yaml` — GPT-4o, structured output, tool-calling
- **Specialized Agents**: `trade-desk`, `verify-gate-runner`, `weekend-audit` — defined in `.claude/skills/`

## Handoff Protocol
- Session handoff → `docs/session-log.md` (dated entries)
- Skill observations → `~/.claude/skill-observations/observation-log/` (task-observer)
- Cross-cutting principles → `~/.claude/skill-observations/cross-cutting-principles.md`