# Trendlyne Fetch Rationalization + DVM Restoration — Design

## Context

Data-fetch schedules across the platform were reviewed to reduce request volume on
providers that are hit too often relative to how slowly their data actually changes,
and to avoid soft rate-limiting. The audit narrowed to Trendlyne, where the user
reported "empty/degraded data without explicit errors" — a symptom now root-caused
to two distinct, unrelated problems rather than throttling:

1. **A live scheduling/redundancy problem**: heavy Trendlyne-hitting scripts are
   bunched into one multi-hour Sunday window, and two of them (`company-profiles-sync`,
   `trendlyne_overview_fetcher.py`) duplicate the exact same full-universe API call
   8.5 hours apart.
2. **A dead-endpoint problem**: `financial_ratios_fetcher.py` and
   `working_capital_fetcher.py` call 12 Trendlyne `chart-data` parameter codes
   (`CFO_Q`, `CAPEX_Q`, `EBIT_Q`, `INT_EXP_Q`, `TRADE_RECEIVABLE_Q`, `DEBTORS_Q`,
   `INVENTORIES_Q`, `TRADE_PAYABLE_Q`, `CREDITORS_Q`, `REVENUE_Q`, `COGS_Q`,
   `RAW_MATERIAL_Q`) that Trendlyne has retired. Confirmed via live testing across
   multiple stocks, **with and without an authenticated Trendlyne session** — every
   call returns HTTP 200 / `head.status="0"` (success) with `eodData: []`. This is
   not a rate limit or a premium gate; the parameter codes no longer exist on
   Trendlyne's side. Both scripts have been producing zero usable output on every
   run while reporting success, silently, since at least the last schema-relevant
   commit.

Separately, DVM data restoration was folded into this design: `fetchTrendlyneDVM()`/
`fetchTrendlyneChecklist()` are dead stubs (Trendlyne's DVM widget has no JSON API),
but DVM scores are already being fetched as a free byproduct of the working
`EPS_TTM` chart-data call and stored in `trendlyne_dvm_scores` — just never wired
back to the consumers that display it.

A live URL audit additionally confirmed: Trendlyne's screener-data endpoint has
**no premium paywall** — all 14 tested "(subscription)"-labeled screener pks return
full real data through the plain unauthenticated call. And new provider exploration
(user-supplied URLs) found `etmarketsapis.indiatimes.com/ET_Stats/mobile` — already
reachable via the `companyid` field every stock already has in `StockMapping` — as
a clean, currently-unused, live replacement for the dead Trendlyne financial-statement
params, plus Tickertape's `stocks/scorecard` as a new supplementary signal.

## Goals

- Reduce peak Trendlyne request concentration (de-conflict the Sunday burst) and
  eliminate confirmed duplicate/dead requests.
- Restore DVM to its consumers using data already being fetched — no new requests.
- Replace the dead financial-ratio / working-capital data source with a working one.
- Make a silent all-empty run detectable going forward.

## Non-goals

- Full param-taxonomy rediscovery for every retired Trendlyne code (only the
  confirmed-dead 12 params in scope here).
- General Trendlyne auth/session hardening beyond what's needed to explain the
  symptom (already recently reworked in the auth-migration commit).
- Touching non-Trendlyne schedules (Yahoo/MoneyControl/NiftyTrader cadences) —
  out of scope for this pass.

## Design

### 1. Weekly bulk-fetcher spread

| Day/Time (UTC) | Job | Change |
|---|---|---|
| Sun 04:00 | Merged profile+overview fetch | `company-profiles-sync` and `trendlyne_overview_fetcher.py` both call `equity/overview-second-part/{tlid}/` for the full ~3,022-stock universe, 8.5h apart. Merge into one fetch feeding both consumers (company description → Ollama scoring; financials/shareholding/analyst targets → ML). Cadence: bi-weekly (was weekly each) |
| Sun 12:30 | `trendlyne_fundamentals_fetcher.py` (EPS_TTM + DVM only — PE/PB calls removed, see §3) | Stays weekly; ~50% fewer requests since PE/PB dropped |
| Tue 12:30 (moved off Sunday) | `trendlyne_adv_tech_fetcher.py` + `trendlyne_price_analysis_fetcher.py` | Stay weekly, relocated to de-conflict from the Sunday cluster |
| First Sun of month, 12:30 UTC (replaces the old weekly slot, see §4) | `financial_ratios_fetcher.py` + `working_capital_fetcher.py` | Repointed to ET_Stats; monthly cadence (Balance/CashFlow/Ratio are annual-refresh data) |
| Daily "known" mode | `trendlyne_screener_discovery.py` | No change — already self-limiting (converges to ~0 new PKs/day after first run) |
| Every 15 min, market hours | Intraday screener scan | Keep cadence; replace forced `skipCache=true` with a 3–5 min TTL to cut redundant same-window hits |

### 2. Deduplication

`company-profiles-sync` and `trendlyne_overview_fetcher.py` both hit
`equity/overview-second-part/{tlid}/` for the same ~3,022-stock universe. Merge into
one script/step: fetch once per stock, feed the company-description consumer
(Ollama growth-potential scoring) and the financials/shareholding/analyst-target ML
consumer from the same response.

### 3. PE/PB redundancy removal

`mc_pricefeed_fetcher.py` (daily, `ml-daily-ops`) already fetches each stock's own
daily `PE`/`PB` (not just industry-average). Trendlyne's `PE_TTM_SHARE_NOW`/
`PBV_A_SHARE_NOW` calls in `trendlyne_fundamentals_fetcher.py` re-pull a full
1,500+-point history every week for data already covered daily elsewhere — cut them.

New daily step (piggybacking on the existing `mc_pricefeed_fetcher.py` run): append
that day's MC `pe`/`pb` value into `trendlyne_pe_history`/`trendlyne_pb_history`, so
`pe_pct_rank_252d`/`pb_pct_rank_252d`/`pe_vs_median_1yr` keep computing from the
stored history tables — now updated daily instead of weekly, as a side effect, from
data already being fetched.

### 4. Financial-ratio / working-capital data source replacement

**Confirmed dead** (live-tested, with and without Trendlyne auth): all 12
`chart-data` params consumed by `financial_ratios_fetcher.py` and
`working_capital_fetcher.py`. Root cause is not rate-limiting or a premium gate —
Trendlyne retired this parameter family. (Separately confirmed: quarterly balance
sheet/cash-flow data has never existed for Indian-listed companies at quarterly
granularity on Trendlyne or ET — companies only file P&L quarterly, so
`working_capital_fetcher.py`'s cash-conversion-cycle inputs were always going to be
annual-cadence data at best; this isn't a fetcher bug.)

**Replacement**: `etmarketsapis.indiatimes.com/ET_Stats/mobile?companyId={id}&events={type}`,
keyed by the `companyid` field already present in `StockMapping` for every stock.
Live-verified, unauthenticated, working:

| `events=` | Cadence available | Fields covering the gap |
|---|---|---|
| `Balance` | Annual, 5 years back | `inventories`, `tradeReceivables`, `tradePayables` — directly, by name |
| `CashFlow` | Annual, 5 years back | `netCashFlowFromOperatingActivities` (CFO) |
| `Quarterly` | Quarterly, 8 quarters back | `totalIncome` (revenue), `totalExpenses`, `ebit`, `pat` (net profit), margins, EPS |
| `Ratio` | Annual, 5 years back | `interestCoverage` (pre-computed — no manual EBIT/interest derivation needed), `inventoryTurnoverRatio`, `currentRatio`, `quickRatio`, `roce`, `ronw`, `assetTurnover`, `debtEquity` |

No CAPEX field was found in `CashFlow` (only `netCashUsedInInvestingActivities`, a
noisier proxy) — same ceiling Trendlyne had. Tickertape's
`stocks/financials/income/{annual,interim}/normal` is a secondary/backup source for
quarterly raw-material/COGS breakdown if a cleaner figure is needed later.

`financial_ratios_fetcher.py` and `working_capital_fetcher.py` are rewritten against
this endpoint (same `db_compat` / `technical_signals` backfill pattern as
`trendlyne_fundamentals_fetcher.py`), keyed by `companyid` instead of `tlid`.

### 5. DVM restoration

`fetchTrendlyneDVM()`/`fetchTrendlyneChecklist()` (`trendlyneService.ts:102-110`) are
dead stubs (no surviving Trendlyne JSON API for the DVM widget). DVM is already
fetched as a byproduct of the working `EPS_TTM` chart-data call
(`trendlyne_fundamentals_fetcher.py::_extract_dvm`) and stored in
`trendlyne_dvm_scores` (`d_score`/`v_score`/`m_score` + colors) — just disconnected
from every consumer.

- New `getTrendlyneDVMFromDb(symbol)` in `trendlyneService.ts`: reads the latest
  `trendlyne_dvm_scores` row, returns
  `{durability:{score,color}, valuation:{score,color}, momentum:{score,color}}` or
  `null`. This shape matches the frontend's existing fallback chains exactly
  (`MCStockInfoPanel.tsx`, `V2StockDetails.tsx` already do
  `dvm.durability?.score`, `dvm.valuation?.score`, `dvm.momentum?.score`,
  insight optional) — no frontend changes needed.
- Repoint `getTrendlyneOverview()`'s `dvm` field and the standalone
  `getTrendlyneDVM` tRPC procedure (`trendlyne.router.ts:26`) to it.
  `checklist` stays `null` — genuinely no surviving data source.
- Un-suppress the DVM half of `syncTrendlyneScores()`
  (`syncProprietaryScores.ts:88`) so `proprietary_scores_history` keeps a DVM trend
  history (`source='trendlyne'`, `score_type` in `durability`/`valuation`/`momentum`)
  for future use. The `checklist` half stays skipped (still no data).
- Cadence: DVM refreshes exactly when `trendlyne_fundamentals_fetcher.py` runs
  (weekly). No new Trendlyne request.

### 6. Bonus signal: Tickertape scorecard

`api.tickertape.in/stocks/scorecard/{sid}` — live-verified, unauthenticated,
returns a proprietary Performance/Valuation/Growth-style composite score, similar
in spirit to DVM but from an independent provider. Requires resolving Tickertape's
`sid` per stock (not currently in `StockMapping` — needs a new resolver, likely via
Tickertape's own search/autocomplete, following the existing
"Adding a New Provider" pattern in `CLAUDE.md`). Folded in as a new low-priority
addition: new `tickertape_sid` field on `StockMapping`, a resolver, and a fetcher
storing into `proprietary_scores_history` (`source='tickertape'`) alongside the
Trendlyne DVM restoration — same table, parallel pattern, no schedule conflicts
(distinct provider/host).

### 7. Monitoring

Add individual `MONITOR_SCRIPTS` entries (currently only tracked at the
`ml-weekly-retrain`/`company-profiles-sync` queue level, `staleLimitHours: 200`) for:
`trendlyne_fundamentals_fetcher.py`, the merged profile+overview job,
`trendlyne_adv_tech_fetcher.py`, `trendlyne_price_analysis_fetcher.py`, and the new
ET_Stats-based `financial_ratios_fetcher.py`/`working_capital_fetcher.py`, each with
a staleness threshold matching its new cadence — so a future silent all-empty run
(the exact failure mode that hid this issue for however long it's been broken)
pages instead of reporting success.

## Testing

- Unit tests for the ET_Stats parser (`Balance`/`CashFlow`/`Quarterly`/`Ratio`
  response → feature extraction), mirroring `test_fundamentals_pit.py`'s AS-OF
  pattern.
- Unit test for `getTrendlyneDVMFromDb` (row found / not found / partial scores).
- Live-PG smoke test per rewritten script (row-count delta), per the project's
  existing P3f verification pattern.
- Verify `syncTrendlyneScores()`'s DVM half writes real rows to
  `proprietary_scores_history` without breaking the still-skipped checklist path.

## Open follow-ups (not blocking this design)

- Tickertape `sid` resolution mechanism (search/autocomplete vs. hardcoded map) —
  to be decided during implementation planning.
- Whether to also repoint `financial_ratios_fetcher.py`'s FCF-yield calculation
  now that CAPEX has no clean source anywhere found (MC/Trendlyne/ET/Tickertape) —
  may need to drop FCF yield or approximate via CFI, flagged for the plan.
