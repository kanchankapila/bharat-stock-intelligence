# Clean-slate rebuild: design and data strategy

> **Historical snapshot.** This initial 2026-11-04 design is retained as evidence for
> AF-20261104-03. It is superseded by the active revision in
> `D:/Github/bharat-edge/docs/specs/2026-11-04-clean-slate-rebuild-design.md`; do not implement
> from this copy. Phase 0 subsequently completed in the `bharat-edge-sdd` worktree.

Date 2026-11-04. Original status: **awaiting owner review; nothing here was built at this revision.** Ledger row: AF-20261104-03.
The executable sequence is in `docs/superpowers/plans/2026-11-04-clean-slate-rebuild.md`.

**How to read the evidence.** "Verified today" means queried read-only against production on 2026-11-04.
"Recorded" means taken from `.claude/rules/measurement.md` or memory with its own date and not re-run today.
"Guess" means my judgement with no measurement behind it. Every number is a dated snapshot.

---

## 1. The answer first

**A highly accurate directional system is not available from this market and this data, and a rebuild will
not change that.** What can be built is a system that tells the truth, trades only where net edge survives,
and is highly accurate about things that are forecastable. Four facts drive every decision below.

1. **Direction is weakly forecastable (recorded).** Five-session rank IC on the 2021-2026 deep panel runs
   +0.0077 in F&O names to +0.0368 below Rs 10 cr turnover. No liquidity tier reaches AUC 0.55. A realistic
   target is a rank IC of 0.03-0.08 and a hit rate of perhaps 52-56% (the hit-rate range is a guess).
2. **Costs decide (recorded).** Round trips cost about 18 bps intraday, 32 bps delivery and 20 bps on futures
   before market impact. No current recommendation label clears cost as a one-session trade. Futures carry is
   real (IC +0.022, t 5.7) and still loses as a long-only book.
3. **Edge and tradability pull apart (recorded).** IC rises as liquidity falls. An individual with Rs 1-10 lakh
   per name can trade names institutions cannot, which is the one structural advantage available here.
4. **Rebuilding has not been the bottleneck (verified today).** `greenfield/` and `bharatquant/` were never
   wired in (`CONTEXT.md`). `bharat-signal-engine` has 0 rows in `engine.prediction`. `bharat_alpha` runs daily,
   but all 80,516 of its multi-day recommendations read `edge_status = unvalidated`. Its last gated h5 and h21
   models failed its own gate (net t 0.10 and 0.82), its newer ones have no gate report, and a grep of `src/` found
   no application code reading it. Other trading repos sit in `D:\Github`; I did not read them, so they are not
   counted as attempts.

So the plan starts by testing whether anything is worth building for (Phase 0). A from-scratch codebase follows,
and it must reach a real daily output in its first build phase rather than at the end.

### What "accuracy" should mean

| Sense | Achievable? | Target in this system |
|---|---|---|
| Data accuracy: every value is right, and knowable when used | Yes | Zero look-ahead by construction; every number traceable to a payload |
| Forecasts of forecastable things | Often | Results strength (recorded: IC +0.39 for PAT growth on ep-v3), volatility, liquidity, event dates |
| Stock direction and return | Only weakly | Net excess over a random-book null, after measured costs |
| Honesty about the above | Yes | Every call carries its `n`, cost assumption, date and state; empty days are a valid output |

The arithmetic that matters: by the fundamental law of active management, an IC of 0.05 across 30 names rebalanced
monthly gives an information ratio of at most about 0.95 (0.05 times the square root of 360), and less in practice
because names are correlated. Accuracy of 55% is therefore enough to be valuable, and 75% should be read as a bug.
The same arithmetic limits proof: the years needed to reach t = 2 are (2 / IR) squared, so 4 years at IR 1.0 and
16 years at IR 0.5. **A slow strategy cannot be proven forward quickly.** The ladder in §7 grows capital in small
steps because waiting for proof is not an option.

---

## 2. What the system's own data says today

### Measured verdicts carried forward (recorded unless marked)

| Item | Result | Consequence |
|---|---|---|
| `momentum_12_1`, monthly, 25 bps/side (2026-10-27) | +0.96%/period vs NIFTY 500, t 1.29; +0.80% vs universe, t 1.67; max DD -21.8% vs -13.4% | Candidate, unproven |
| `value_book_to_price` (2026-10-27) | +1.19%/period vs NIFTY 500, t 1.77; negative vs universe in 2025 and 2026 | Candidate, decaying, restatement risk |
| Low volatility (2026-10-27) | -1.07%/period vs NIFTY 500, t -3.31 | Positive IC, wrong book. Rejected |
| Screeners (2026-10-26) | Of 1,078, 0 reliably profitable and 136 reliably losing | Removed |
| Broker calls, chart patterns, ET Calls, consensus upside (2026-10-26) | All lose or are unproven as trades | Removed |
| News sentiment | Same-day IC +0.13; next-day about -0.03 | Not a signal |
| Concall tone (2026-10-26) | Confident minus not-confident +0.35% at 5 sessions, t 0.83 | Not a signal |
| Results strength vs reaction (2026-10-27) | Forecasts PAT growth at IC +0.39; price reaction IC about 0 | Research output, and the input to H2 |
| Delivery % (Bharat Alpha study) | Tail separation t +4.56; group ablation dIC +0.0098, t 6.53; raw long-only book t -1.48 | Test only as a conditioner |
| DL, cross-sectional ranker, RL, online learner | No edge, retired or paused | Not rebuilt |
| Regime labels (2026-11-04) | Candidate and live HMM agree on 157 of 207 dates of 2026 on identical inputs | No HMM in the decision path |
| Sizing (2026-11-02) | 95.8% of sized weight came from an engine already removed as anti-predictive | Sizing comes from one portfolio step only |

### Frozen forward evidence (verified today)

- `forward_test_report`: 19 sessions since 2026-10-06, h5 effective dates 2.8, every tier LOW-DATA.
  Top 1% mean excess -1.71% (t -1.59).
- `paper_book_report`: 4 sessions since 2026-10-27, published arm -0.28% excess, LOW-DATA.
  Earliest verdict about 2027-01-22. **These two tests keep running and are never re-tuned.**

### The one live lead (verified today, and not yet believable)

Bharat Alpha's next-session open-to-close model (`s1-*`) is the only thing in the estate with positive forward
results. I re-derived it from `stock_ohlcv`, separately from Bharat Alpha's own price table: 187 of 220 resolved
picks matched and 0 disagreed on return. The other 33 could not be mapped by symbol and remain unchecked.

| Assumed round-trip cost | Mean daily excess | t | Positive days (of 22) |
|---|---|---|---|
| 18 bps | +0.772% | 2.82 | 17 |
| 40 bps | +0.552% | 2.02 | 17 |
| 60 bps | +0.352% | 1.28 | 16 |

The window is 2026-10-01 to 2026-11-03. Reasons not to believe it yet, each testable in Phase 0:

- **22 days, in one falling tape, spliced across two model versions.** On this platform a promising short-panel
  reading has so far never survived reaching full power (recorded).
- **Its leak check did not run.** `no_same_day_tracking.same_day_ic` is null in the gate report. The out-of-fold
  figures (IC 0.0945, net t 9.1, +0.227%/day) are the shape `ml-model-bugs.md` warns about.
- **Forward is about 3.4 times out-of-fold**, which reads as luck or regime rather than a stable level.
- **Illiquid fills.** Median capacity is Rs 4.5 cr and the 10th percentile Rs 0.72 cr. Mean pick return is +0.714%
  against a median of +0.126% and a hit rate of 52.9%. The best five picks gained 9.5-10.5% from the open, which
  suggests upper-circuit closes (a guess). Removing them leaves +0.54%, t 2.37, so they do not explain it all.
- **Real fills are unmeasured.** Bharat Alpha's own net figures assume 13.5 bps round trip with 5 bps/side
  slippage, an assumption for these names. I used 18 bps as the base, and the t-stat falls to about 2 at 40 bps.
- **The `validated` label on these rows comes from the out-of-fold gate.** It is not forward evidence.

My benchmark was the same-day mean of names with same-day turnover of at least Rs 1 cr, a simple proxy.

---

## 3. Inputs carried forward

| Date | Input | Effect here |
|---|---|---|
| 2026-10-19 | Paper today. Intended universe: all F&O, cash at Rs 1-10 lakh per name, cash under Rs 1 lakh | Tiers are first-class and everything is stratified |
| 2026-10-19 | Three horizons: intraday, short-term, long-term | Each is a sleeve with its own gate. A horizon may stay empty |
| 2026-10-19 | One pre-open artifact by 08:45 IST | The primary product |
| 2026-10-19 | Empty days are a feature | "No trade today" is a first-class state |
| 2026-10-19 | Aggressive removal of what has measured no contribution | Nothing is ported without a reason. Unmeasured is not the same as useless |
| 2026-10-19 | Anti-goals: confident dashboards, numbers without `n`, asserted accuracy | Enforced at the decision table |
| 2026-10-27 | Honest money-making; frozen forward gates | Same pattern, with hash-frozen protocols and random-book nulls |
| 2026-10-29 | Pre-registered: if `paper_book` fails, the product becomes research and monitoring until a new frozen protocol passes. Do not reopen short-horizon signals because of a slow-factor failure | Kept. I am proposing H3 as one exception, because its forward evidence is new. Reject it if you read that rule more strictly |
| 2026-09-13 | DL paused | No deep learning in the build |
| 2026-09-13 | "Never repeat the same mistakes" | §4 turns each class into a mechanism, not a document |
| 2026-09-05 | A source that stops returning data: ask for a captured browser fetch before calling it dead | Part of the source contract |
| 2026-09-11 | Advisor protocol: challenge first, rate confidence | The tone of this document |
| 2026-11-04 | Do what is best for accurate, honest recommendations | Tie-breaker |

**Earlier designs and how this relates.** `2026-10-08` and `2026-10-19` specs: findings and user decisions are
inherited; their "no rewrite" non-goal is superseded by today's request. `docs/redesign-plan-2026-10-29.md`: its
target shape (point-in-time master, one harness, portfolio replacing the blend, cut data surface) is essentially
right and is adopted. This design delivers it as a new build rather than in place, and adds the semantic layer and
data plan. `bharat_alpha/`: treated as a donor (§8).

---

## 4. Mistakes turned into mechanisms

The record shows that prose rules do not hold: recurrence counts were logged after classes were documented. So
each class below is prevented by construction or by an automated test.

| Mistake on record | Mechanism in the new system |
|---|---|
| Look-ahead joins, `prev_date` leaks (+3.6%/day phantom) | Features read only through `as_of(knowable_by)`. Replay test: adding a future fact changes no past feature |
| `fetched_at` overwritten, no ingestion clock (`first_observed_at` began 2026-11-02) | Facts are insert-only. Three clocks on every fact (§5). A database trigger rejects `UPDATE` |
| Vendor restatements | Raw payloads immutable. Signals use first print. Each vendor history must pass a restatement audit before use |
| Sentinel zeros, warm-up zeros, `float(x or 0)` | NULL means unknown. Contracts declare valid ranges, enforced by DB `CHECK`s. Warm-up rows are NULL |
| Per-symbol scaling reordered the cross-section; labels scaled | Cross-sectional transforms only, per date. Labels live in a separate table that transforms cannot reach |
| Survivorship; `is_active`-based universes | `universe(as_of)` comes from the exchange file that day, dead names included. A source test bans other readers |
| Alias tickers, rename splits, demerger seams, -90% fake returns | Instrument identity is by ISIN with dated symbol history. Adjustments are derived and reconciled, and an unresolved seam masks the name |
| Provider id collisions | `(provider, provider_id)` is the only key form the schema permits |
| HTTP 200 treated as data; frozen sources passing shape checks | Every body classified ok, empty or error-envelope. Maximum business date checked against expected |
| Overlapping windows as independent dates | One harness computes independent periods. No other code may print an IC |
| Median benchmark, winners-only studies, closed-trades-only exits, pooled numbers, clipping-made significance | Fixed in the harness: per-date, both tails, mean and buyable-index benchmarks, all entries marked to market, raw t beside winsorised t |
| Self-reported CV as evidence; gates frozen by a label change | Promotion reads realised outcomes only. Label definition is part of the protocol hash |
| Train/serve skew, three instances | One `feature_view()` used by research and live. Parity test on shared dates |
| Seed noise deciding promotions | Spread across seeds must be smaller than the gap being judged |
| Grep-driven trial counts, multiple testing | Every run is logged to the hypothesis registry. The family's trial count sets the bar |
| Conviction labels meaning opposite things, two signal vocabularies, four parallel scores | One decision table, one writer, closed enums, no conviction tier, no score without a sleeve |
| Absolute score thresholds stepping Buy counts 5x with regime weights | No absolute thresholds. Selection comes from sleeve rules and portfolio weights |
| Monitors that always fire; heartbeats that lie; skips stamped as success | A pipeline step passes only when its output assertion passes. Each monitor names the decision it guards, and is replayed against history before it ships |
| Cron offsets as dependencies; `date.today()`; UTC and IST confusion | A dependency graph with one logical session date. Times stored in UTC, displayed in IST. A static check bans `date.today()` |
| Tests that dropped production tables | Test code refuses any database whose name does not end in `_test`, and uses a role without production credentials |
| Working tree equals production; restart picks up another session's files | Production runs a tagged release checkout only |
| Memory exhaustion from concurrent jobs | One sequential daily graph. Research runs from a parquet cache on demand |
| Single sleeping Windows host, no off-host backup | Always-on Linux host, off-host backup, restore rehearsal (owner decision D3) |
| 270 tables, most unread | A source and a table exist only with a named hypothesis or operational need, and a `review_by` date |

---

## 5. Architecture

```
 NSE/BSE archives  FRED/RBI/IIMA  broker API  selected vendors
        |               |             |            |
        v               v             v            v
  L0 raw vault      immutable payloads, content hash, body classification
        |
  L1 reference      instrument, symbol history, provider ids, calendar, tradability
        |
  L2 fact store     typed, insert-only, three clocks
        |
  L3 semantic layer contracts for fields, metrics, decisions, sources  <-- governs L2 to L9
        |
  L4 feature_view   pure functions of as_of(), same code for research and live
        |
  L5 research       hypothesis registry, one harness, verdict ledger
        |
  L6 sleeves        frozen protocol, paper book, random-book null, gate state
        |
  L7 portfolio      target weights, risk caps, turnover-aware rebalance, cost model from fills
        |
  L8 decision       the one output table: calls / no trade / degraded
        |
  L9 surfaces       08:45 brief, thin read API, five-page UI, abstaining chatbot
```

**Runtime.** Python 3.12 for everything except the UI. Plain Postgres as the only database, with native
partitioning. Plain Postgres is my call: the daily panel is a few million rows and compressed hypertables have
repeatedly blocked `UPDATE`s and constraints here, so Timescale waits until a query needs it. Parquet files hold
rebuildable research panels only. Two long-running processes (`edge-pipeline`, `edge-api`) and a thin React/Vite UI
generated against the API's OpenAPI schema. No Redis, BullMQ, tRPC, ChromaDB, pm2 service mesh or model microservices.
**Models.** Rank composites and ridge first. LightGBM is admitted only if it beats ridge on a paired, cost-aware test.
LLMs may extract and explain, with citations, and are never in the scoring path.

### The semantic layer (L3)

This is the part the current platform has in pieces. The live `market_*` and `kg_*` tables have the right ideas (evidence
separated from claims; a chatbot that abstains), but they sit beside the decision path rather than governing it:
`market_decision_event` holds 69,996 rows and no `.tsx` component references it directly (grep today; a server router does).
The new layer is simpler and stricter: **plain YAML in git, compiled into DB constraints, generated tests, typed views
and agent context.** There is no graph database.

**Three clocks on every fact:**

| Clock | Meaning | Example for a quarterly result |
|---|---|---|
| `event_time` | What period or moment the fact describes | Quarter ending 30 Sep |
| `published_at` | When the source made it public | Exchange broadcast, 28 Oct 19:50 IST |
| `first_seen_at` | When this system first stored it; set by the DB; never changes | 28 Oct 21:37 IST |

Live decisions use `first_seen_at`. Backtests use `published_at` plus the field's declared lag, and a field with
no reliable `published_at` is not usable historically. An after-15:30 publication is first tradeable at the next
session's open.

**Field contract, one per field:**

```yaml
field: pat_consolidated_q
entity: instrument
unit: INR
grain: fiscal_quarter
clocks: {event: period_end, published: exchange_broadcast, lag_sessions: 0}
sources: [nse_xbrl, dalalos]       # priority order; a lower source needs a passed restatement audit
null_means: not_reported
valid_range: {min: -1.0e12, max: 1.0e13}
restatable: true
signal_uses: first_print
used_by: [H2]
review_by: 2027-05-01
```

**Also contracted:**

- **Metrics**, each with one definition: rank IC, independent periods, net excess, null percentile, implementation shortfall.
- **Sources**: minimum headers, id scheme, expected cadence, maximum staleness, owner action on failure.
- **Decisions**: closed enums for state, action, tier and horizon. There is no conviction label.
- **Entities**: Issuer, Instrument, Listing, Index, Contract, Filing, Event, Fact, Feature, Hypothesis, Protocol,
  Sleeve, Decision, Order, Fill, Outcome, Verdict.

**What gets generated from contracts:** DB checks, validation at write, freshness and fill-rate monitors, the data
dictionary page, and `context/` files for AI agents. Generated docs cannot drift, which removes the need for
hand-maintained inventories. Agents and the chatbot read only typed views, and abstain when the view returns
nothing or data is stale.

### Layout

```
bharat-edge/            (working name)
  contracts/            fields, metrics, decisions, sources
  hypotheses/           one frozen file per hypothesis, plus frozen.lock
  migrations/           numbered SQL, schema verified after each
  src/edge/
    clock.py db.py vault.py reference.py facts.py semantic.py costs.py
    sources/  features/  research/  sleeves/  portfolio/  decisions/  pipeline/  api/  brief/
  web/                  five pages
  context/              generated
  tests/
```

### Product surface

Five pages, each answering one question. **Today:** what do I do, or why nothing? **Book:** what is held, and how is it doing
against its null? **Evidence:** what has been tested, and what was the verdict with `n`, costs and date? **Stock:** facts
and events with their clocks, and a score only if a sleeve holds a view. **System:** is the data right today? The Telegram
brief has three states, always sends, and missing it is an incident.

---

## 6. Data strategy: what comes from where, and why

**Source order.** Exchange primary files first (dated, free, hard to restate). Then public and regulatory data. Then broker
APIs for what only a broker sees. Vendors last, for history the exchange cannot supply, and only after a restatement audit.

Depths below are verified today. "Forward-only" means history cannot be graded until time passes.

### Core: build first

| Family | Primary source | Depth today | Clock | Use |
|---|---|---|---|---|
| Daily bars, universe, dead names | NSE `sec_bhavdata_full` (`nse_universe_history`) | 2021-01-01 to 2026-11-03, 1,443 dates, 4,341 symbols | Exchange date | Universe, returns, liquidity tiers, calendar |
| Delivery % | Same file | Same | Same | H6 conditioner. Recent-only legacy tables are not needed |
| Adjustments | NSE adjusted `PREV_CLOSE`, PR bundle; reconciled with `corporate_actions` | 26,345 actions | Ex-date | Masking and adjustment; a seam blocks the name |
| Result filings and timing | NSE Integrated Filing (`nse_results_filings`) | 91,094 filings, 2021 to 2026; ingest clock only since 2026-11-02 | `broadcast_ts` | Event clock for H2 and the avoid window |
| Result numbers, recent | NSE XBRL (`nse_filing_financials`) | 8,541 rows from 2025-10 | `broadcast_ts` | Actuals going forward |
| F&O bars | NSE F&O bhavcopy | Bharat Alpha `fo_daily` 2024-07-01 onward, 578 dates | Exchange date | Tier flag, carry, hedge cost |
| Index levels | NSE index close files | `index_valuation` to 2003 | Exchange date | Benchmarks, valuation context |
| Surveillance and tradability | NSE ASM/GSM, ban list, T2T, band | Current-state today; dated capture starts in the build | First-seen | Tradability mask |

### Test: enters only through the hypothesis gate

| Family | Source | Depth today | Hypothesis | Caution |
|---|---|---|---|---|
| Deep quarterly actuals | `dalalos_financial_trends_history` joined to filings | 62,655 rows, 2005 to 2026; 31,651 joined to a broadcast timestamp across 1,572 symbols | H2, quality in H1 | Vendor history; restatement audit first |
| Exchange results, pre-2025 | Bharat Alpha `nse_results` | 37,110 facts from 2017-08 | H2 | Route frozen at 2024-12 |
| Valuation history | `trendlyne_pe_history`, `trendlyne_pb_history` | 3,089 dates from 2013 | H1 | Prefer price times reported fundamentals; restatement audit |
| Current ratios | InvestSights, same-definition ROE (recorded corr 0.96) | Forward since 2026-08 | H1 quality | Two InvestSights tables hold different ROE definitions |
| Ownership and pledge | NSE shareholding; Mojo for backfill | NSE 27,805 from 2022; Mojo 75,932 from 2018 | H7 | Use broadcast, or SEBI deadline for backfill |
| Insider and promoter trades | NSE PIT; `insider_trades` as check | PIT 99,566 **ending 2026-05-02**; `insider_trades` 104,782 to 2026-11-02 | H8 | PIT feed is stale (AF-20260929-08). Ask before calling it dead |
| Option-derived features | Stitch `stock_option_features_history` (2021-01 to 2024-07-05) and `alpha.option_daily` (2024-07-01 onward) | About 5.8 years combined, if methods reconcile on the overlap | H5, H4 | The old table's `spot_proxy` derives from the future; use bar close |
| FII/DII, participant OI | NSE | FII/DII 2,659 dates from 2016; participant OI 1,439 dates from 2021 | H10 market risk | Time-series use only: few rules, few parameters |
| Macro and overnight | FRED/ALFRED (vintages), `macro_indicators`, GIFT Nifty | 1,551 dates from 2020-12 | H10 market risk | Not a stock-level signal |
| Factor benchmark | IIMA Indian Fama-French-Momentum library (not yet downloaded) | Library lists Oct 1993 to Mar 2023 on one mirror | H1 sanity and long-run prior | Check latest release and licence |

### Collect forward: cannot be graded yet

| Family | Source | Depth today | Why keep collecting |
|---|---|---|---|
| Pre-open auction | NSE | 84 dates from 2026-06-30 | H3 and open-fill realism |
| Analyst estimates | MoneyControl, InvestSights | 67 dates from 2026-06-21 | True consensus surprise for H2 |
| Quotes, spreads, own fills | **Broker API (Kite Connect, D4)** | No table holds these (likely; not swept column by column) | Largest gap: costs are decisive and unmeasured |
| Option quotes | Broker API | None | No option product can publish without measured spreads |
| Futures OI, rollover | NSE-derived | 47-81 dates | Only if H4 or H5 needs them |
| Intraday bars | Broker API, legacy `intraday_ohlcv` as bridge | Present for 2,411 symbols since 2026-10-01 (earlier depth not checked) | H3 execution study only |

### Reject: do not port

| Family | Depth or size | Evidence |
|---|---|---|
| All screener memberships | 20M+ rows in `live_screener_appearances` alone | 0 of 1,078 reliably profitable; 0 of 1,563 survive FDR; volatility detectors |
| Vendor composites (Mojo, Trendlyne DVM, proprietary scores) | Millions of rows | `mojo_indigraph` no edge; two "independent" vendor ranks had corr 1.0 |
| Broker recommendations, targets | `mc_broker_reco`, `trendlyne_analyst_targets` | Negative after posting |
| Chart patterns, ET Calls, Trading80 | Various | Lose, or no reliable edge for a reader |
| News sentiment as signal, GDELT, concall tone | 195k news rows | No next-day edge. News is kept for display only, with clocks |
| Stock-level HMM regimes, RL, DL, online learner | Models | Retired or no edge |

**Vendor freeze stays.** A new source needs a named hypothesis first. The first request to any source starts with no
headers. A failing source goes to the owner with a per-route breakdown and a request for a captured browser fetch.

**The biggest unbought improvement is more history.** 2021-2026 misses the 2008, 2011, 2013 and 2018-19 small-cap and 2020
crash regimes. I am assuming NSE's older bhavcopy archives extend well before 2021. If they do not, the slow sleeve
rests on 5.8 years and the IIMA series alone, and its bar in §7 gets harder to clear. Phase 0 probes this first.

---

## 7. Strategy: the sleeves and how they would be judged

These are hypotheses, not recommendations. Each one is pre-registered before any result is seen.

| Id | Hypothesis | Data | Current evidence | Role if it passes |
|---|---|---|---|---|
| **H1** | Monthly long-only momentum, quality and value beat a buyable index after costs, in tiers with ADT of at least Rs 5 cr | Bars, actuals, valuations | Recorded t 1.29-1.96; decaying in 2025-26. Quality in India: Jacob, Pradeep and Varma report 0.92%/month alpha; not tested here | Core long-term sleeve |
| **H2** | Drift after results follows the part of the surprise the forecast missed, entered at next open after broadcast | Filings, actuals, ep-v3 forecast, consensus later | Beats move +1.07% next day (recorded), but predictable growth is priced in. `pead_score` no edge; literature for India is mixed. Residual surprise is untested | Short-term sleeve |
| **H3** | Next-session open-to-close reversal survives real fills | Bars, pre-open, broker fills | §2 lead | Small intraday sleeve, capped by capacity |
| **H4** | An avoid-list lowers left-tail losses at no turnover cost | Surveillance, pledge, ban, result window, bottom-decile signals | Bottom decile -0.35% vs top +0.19% in `s1` out-of-fold; Sell side +41 bps gross at 5 sessions (recorded) | Overlay on every sleeve |
| **H5** | Below-cost short-horizon signals improve fills on trades already being made | Carry, next-session signals | Carry IC +0.022, technical IC +0.034 (recorded) | Execution timing; adds no turnover |
| **H6** | Delivery improves momentum in H1 names | Delivery | Separation t +4.56; raw factor loses | H1 conditioner |
| **H7** | Ownership changes (promoter, pledge, MF) predict slow returns | Shareholding | Never properly tested | H1 input or avoid-list input |
| **H8** | Promoter open-market buying predicts returns | PIT, `insider_trades` | `insider_net` t 1.73 | H1 tilt |
| **H9** | Index additions drift between announcement and effective date | Dated index lists | Literature old and weak (Joshipura and Janakiramanan 2015) | Parked unless the list is cheap to build |
| **H10** | Volatility-scaled sizing and simple observable market risk rules cut drawdown without lowering net return | Bars, VIX, flows | Volatility is forecastable (recorded repeatedly) | Portfolio risk step |

**Not being built:** a blended many-engine score, Buy/Sell labels, conviction tiers, win probabilities, stock option calls,
short recommendations in cash (I am assuming retail cannot hold cash shorts overnight; verify with the broker), and a
daily intraday ranker. F&O starts with index futures as a hedge for H1. Stock-futures shorts wait because the F&O tier
has the weakest IC on record.

### The gate ladder

| Step | Bar |
|---|---|
| **RESEARCH to SHADOW** | One harness. Open entry. Tiered by ADT. Costs from the cost model. Beats the same-liquidity mean and a buyable index. Both halves positive. Raw t beside winsorised t. Shuffled control t under 1. Label-leak correlation under 0.15. Trial logged. Fast sleeves need t of at least 3.0 (a 12-test Bonferroni is about 2.9). Slow sleeves need t of at least 2.0 on the longest available history, plus an outside prior, because t 3 is out of reach in the available years; this is a weaker standard and the book says so |
| **SHADOW to PAPER** | Protocol hash frozen. Decisions written and graded every session whether or not published, so a closed gate cannot latch shut |
| **PAPER to LIVE-SMALL** | At least 60 forward sessions, above the 95th percentile of 200 random books with identical mechanics, both halves positive, and measured slippage inside the assumed cost. For a monthly sleeve 60 sessions is only three rebalances, so it remains an unproven book at small size |
| **LIVE-SMALL to LIVE** | Owner decision, with the record in hand. Suggested start: at most 10% of intended capital (guess) |
| **Automatic demotion** | Net excess below the null's 5th percentile over 60 sessions, slippage above 1.5 times assumed, or a data contract breach. Demotion needs no review; promotion always does |

**Pre-registered outcomes.**

- If H1, H2 and H3 all fail, the product becomes the research, risk and earnings-strength tool, and publishes no calls.
- If only H3 passes, it stays a small, capacity-limited sleeve, not a platform.
- Parameters never change in place. A change is a new version with a new forward clock.

---

## 8. What happens to existing work

| Asset | Decision |
|---|---|
| Legacy platform | **Keeps running, unchanged, until cutover.** No big-bang switch. Frozen forward tests continue |
| `bharat_alpha` | **Main donor.** Port with tests: exchange connectors, adjustment logic, instrument identity, `to_db` NULL coercion, `knowable_at` joins, harness, option IV, step ledger, simulated planted-edge and noise tests. Not ported by default: Hedge, conformal, LambdaRank, the auto-retrain loops; each must earn its place |
| `bharat-signal-engine` | Read `validation/` and `pit.py` for ideas. Do not port wholesale |
| Legacy fetchers | Reference for headers and payload shapes only |
| `src/server/ontology`, `market_*` | Ideas adopted (evidence vs claim, abstention). Tables not ported |
| `earnings_preview.py`, `paper_book.py`, forward test | Logic ported with their hashes recorded. Forward clocks stay with the legacy runs until cutover |
| `market_endpoint_registry`, `url_endpoints` | Stay as discovery catalogs for source hunting |
| Rules and memory | The rules stay as the design record. New repo gets a short CLAUDE.md pointing to contracts and tests, because enforcement is by test |

**Why a new repo rather than growing `bharat_alpha`** (my call, D1): its core shape is model-first, whereas this design is
hypothesis-first with sleeves and a portfolio. Its schema also lacks the three clocks and contract layer. Rewriting those
foundations in place would touch nearly everything, while its connectors and harness can be moved intact.

**Cutover test.** The new brief has run 20 consecutive sessions with no misses. The Evidence page reproduces the legacy
momentum result within tolerance. The owner has chosen to retire legacy pages. Only then are legacy services stopped; table
drops are a separate owner decision after a verified off-host backup.

---

## 9. Decisions only the owner can make

The plan proceeds on the recommended default until told otherwise. None blocks Phase 0.

| # | Decision | Recommendation |
|---|---|---|
| D1 | New repo, or continue inside `bharat_alpha` | New repo, with `bharat_alpha` as donor |
| D2 | Capital and timing for any real money | No real money before the ladder allows it. State the intended amount, because it sets tier floors and the H3 cap |
| D3 | Always-on Linux host and off-host backup | Yes. Evidence: about 40 hours of undetected downtime in 14 days (recorded 2026-09-10) and backups on one physical SSD. Cost not researched |
| D4 | Broker API for quotes and fills | Yes. Kite Connect lists Rs 500/month per key, including historical and live data; confirm current terms |
| D5 | Paid point-in-time fundamentals | Not yet. Decide after the restatement audit. CMIE pricing not researched |
| D6 | Retire legacy pages at cutover | Decide at cutover, with the record in hand |

---

## 10. Risks and open doubts

- **The strongest objection to this design:** the edge, not the code, is the constraint, so a new codebase may be expensive
  procrastination. Phase 0 is how this design answers it. If Phase 0 finds nothing, the build shrinks to a small research and
  risk tool, and I would recommend that over the full plan.
- **Phase 0 reuses a peeked panel.** 2021-2026 has been mined heavily here, so only forward results are clean holdout. The
  extended pre-2021 history, if it exists, is the only other untouched sample. It must be graded once, and not used for tuning.
- **Assumption: pre-2021 NSE archives are reachable.** If wrong, H1 rests on 5.8 years plus IIMA, and may stay at paper.
- **Assumption: cash shorts are not available overnight to retail.** If wrong, the short side reopens, though recorded evidence
  says illiquid short names are the ones carrying the signal.
- **Assumption: Rs 1-10 lakh per name is still the intended size.** If capital is much larger, the illiquid edge disappears
  and H1 must be re-tiered.
- **The SEBI ban framework** was only checked through broker blogs. Encode it as dated exchange data, not rules, and read the
  circular before relying on thresholds.
- **Single operator.** A one-person system needs few moving parts, which is why this design has two processes.
- **Literature cited here is a prior, not evidence on this data.** Indian PEAD findings conflict, and index effects are old.
- **Decay.** Any edge that passes may fade. Automatic demotion exists because of this.

Sources for outside claims: [IIMA Indian Fama-French-Momentum library](https://faculty.iima.ac.in/~iffm/Indian-Fama-French-Momentum/);
[Gupta and Dhusia on NSE PEAD](https://journals.vutbr.cz/index.php/trends/article/view/541);
[Agarwal and Sridharan, IIMB](https://repository.iimb.ac.in/handle/2074/17935);
[Joshipura and Janakiramanan on NIFTY inclusions](https://ideas.repec.org/a/ids/afasfa/v5y2015i1p21-36.html);
[Zerodha on Kite Connect pricing](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/historical-data-and-live-market-data-payment-plan).
The Jacob, Pradeep and Varma quality result is SSRN 4284686, seen through a search summary; read the paper before citing further.
