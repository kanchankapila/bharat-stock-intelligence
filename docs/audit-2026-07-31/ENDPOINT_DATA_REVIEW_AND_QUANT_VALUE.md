# Endpoint Data Review & Quant Value Assessment

**Date:** 2026-07-31
**Inputs:** `scripts/verify_live_urls.py`, `updated_urls.json` (919 URLs), `updated_urls_verified.json`
**Method:** re-fetched all 919 URLs and recorded payload shape, record counts, and newest date
in the body — not just status codes. Probe: `scripts/probe_endpoint_payloads.py`;
raw results: `docs/audit-2026-07-31/payload_probe.json`.

> **Scope honesty.** This pass measures *availability, shape, freshness and orthogonality*.
> It does **not** measure forward-return edge for any endpoint. Per the standing lesson from
> the 2026-07-30 data-bias audit — *a mechanism that could explain an anomaly is a hypothesis,
> not a finding, until the counterfactual is actually run* — everything in §4 is labelled a
> **candidate** with a test, not a claimed edge.

---

## 1. Review of `verify_live_urls.py`

The script works and is reasonably built (concurrency 16, 20s timeout, browser UA, ordered
output). Four defects, in severity order:

### 1.1 It records status codes only — the one thing this repo knows is not sufficient

This is the central issue. A 200 proves the server answered, not that the payload is usable.
This codebase has been burned by exactly this twice, both documented in `CLAUDE.md`:

- 2026-07-23: `trendlyne_screener_discovery.py` wrote profile URLs into `symbol`, corrupting
  ~2.1M rows across 7 tables. Every request was a 200.
- 2026-07-31: NSE's bulk insider endpoint returns 200 with data **silently frozen at early May**.

Measured cost of the blind spot on this very corpus:

| Judged by | Result |
|---|---|
| Status code (the script) | 793 "OK" |
| Status + payload (this probe) | **812 reachable**, of which **5** return an error/empty body, **39** return HTML not JSON, **8** are trivial (<60 bytes) |
| …and **10** return a full schema with `"body":{}` — zero rows | see §1.3 |

So the script both **under**-reports (§1.2) and **over**-reports (§1.3).

### 1.2 15 "InvalidURL" failures are a source-data artifact, not dead endpoints

Those URLs carry doubled slashes from the capture tool:
`https:////api.moneycontrol.com//mcapi//v1//swot//details?scId=BE03`.
Collapsing runs of `/` in the path recovers **all 15** — including MC SWOT, mc-essentials,
mc-insights, the batch quote endpoint, and three `techindicator` timeframes (D/W/M).
Normalizing took the live count from **793 → 812**.

### 1.3 A 200 with an empty body is scored as success — the corruption-shaped case

Ten `trendlyne.com/futures-options/api-filter/...` URLs return **HTTP 200, ~900 bytes, a
complete `tableHeaders` array, and `"body":{}`** — headers, zero rows. My first record-counter
scored these as "12 records" because it counted *headers*. That is precisely the shape that
caused the 2.1M-row corruption: a parser sees a valid-looking schema and either yields nothing
or blindly indexes column 0.

Root cause is a **hardcoded expiry in the captured URL** — `30-sep-2021-next`, five years stale.

### 1.4 No freshness check

Of 245 payloads containing a parseable date: 148 fresh (≤1d), 45 a quarter old, **27 older than
120 days**. Most of the old ones are legitimately slow-moving (corporate actions for one stock,
quarterly financials). But without a freshness field you cannot tell those apart from the
May-frozen-insider failure mode.

### 1.5 Recommended changes

1. Normalize `//` → `/` in the path before requesting (recovers 15 endpoints).
2. Record `bytes`, parsed `kind`, **row count of the primary collection** (not headers), and the
   newest date in the body.
3. Fail an endpoint that returns 200 with zero rows — treat it as `empty_ok`, distinct from `ok`.
4. Any endpoint carrying a date/expiry in its path or query gets re-tested with a **live** value
   before being called verified.

`scripts/probe_endpoint_payloads.py` implements all four and can replace or wrap the script.

---

## 2. What the 919 URLs actually are

| Status | n | Note |
|---|---|---|
| 200 | **812** | after slash normalization |
| 403 / 401 / 444 | 60 | genuine auth walls — see below |
| 404 | 23 | dead |
| 204 | 9 | no content by design |
| 5xx / 4xx other / timeout / conn | 15 | transient or malformed |

**The 60 blocked endpoints are not recoverable by header spoofing.** I retried one per host with
a warmed session, browser UA, `Referer`, `Origin`, and `Accept-Language`: `ticker.finology.in`,
`api.stockedge.com`, `oxide.sensibull.com`, `www.ndtvprofit.com`, `ai-chat.tapetide.com`,
`webapi.niftytrader.in` (the 401 one), `subscriptions.economictimes...` and `trendlyne.com`
(444→403) all still refuse. These need real credentials. Don't spend time on them.

Content of the 812: **705** carry real record collections, 34 are scalar-dict data, 39 are HTML
(SPA/login pages, not APIs), 21 thin, 8 trivial, 5 empty/error.

By data family (773 live JSON endpoints):

| Family | n |
|---|---|
| Screeners / rankings | 203 |
| Technicals / indicators | 161 |
| Fundamentals / financials | 119 |
| **Options / OI / Greeks** | **85** |
| Index / market breadth | 58 |
| **Ownership / insider / bulk deals** | **30** |
| News / sentiment / events | 27 |
| **Analyst estimates / forecasts** | **23** |
| Price / quote / OHLC | 12 |
| F&O futures / rollover | 8 |
| Corporate actions | 5 |

---

## 3. The quant read: where the value is *not*

The two largest families are the two least valuable, and this follows directly from findings
already established in this repo's own audits:

- **203 more screeners** — the platform already ingests **1,632** screeners across five
  providers. The 2026-07-31 intraday audit measured them: informative but **wired backwards**
  (every weakness filter positive, every strength filter negative or flat), and only
  `orb5minLow` clears costs. Adding a sixth provider's screener list increases the count of a
  thing that is already mis-weighted. It does not add information.
- **161 more technical indicators** — technicals are the *one* feature family already densely
  populated in `technical_signals`, and the 2026-07-30 audit measured short-horizon momentum as
  **significantly negative** (mom21: −0.53% net per 5 days, t=−3.21) with intraday momentum
  negative too. More RSI/MACD/SMA variants re-derive the same price series that is already
  there and already known not to pay.

### 3.1 Correction: the 0%-coverage picture is largely already fixed

An earlier draft of this report repeated the 2026-07-30 bias audit's figure — *"~150 columns sit at
exactly 0%"* — as if it were current. **It is not.** `densify_feature_matrix.py` shipped on
2026-07-31 and forward-filled the matrix (+628,100 non-null cells). Measured directly against the
live DB on the last **complete** trading date:

| | |
|---|---|
| Date measured | 2026-07-30 (2,188 rows) |
| Numeric columns | 291 |
| **Exactly 0%** | **11 (4%)** |
| <25% | 107 |
| 25–70% | 31 |
| ≥70% | 142 |

A first attempt measured 2026-07-31 and got 248 zero-coverage columns — that day had only **21
rows**, a partially-built grid. Always measure coverage on the last date with a full row count;
a partial day makes almost every enrichment column look dead.

So the honest gap is **11 exactly-empty columns plus a ~30-column effectively-empty tail**, not
~150. That materially narrows what this corpus can usefully add, and it is why §4 is five
endpoints rather than fifty.

**Exactly zero (11):** `delivery_pct`, `delivery_trend_30d`, `mf_holding_pct`, `mf_chg_vs_prev`,
`sector_global_corr_21d`, `eps_revision_3m_pct`, `target_revision_3m_pct`, `analyst_count_chg`,
`pledge_chg_90d`, `fcf_yield`, `ccc_trend`.

**Effectively zero (1–21 non-null of 2,188):** `analyst_upside_pct` / `analyst_count` /
`analyst_buy_pct` (1 each), `roe_annual`, `roce_annual`, `ebitda_margin`, `np_margin`,
`rev_growth_yoy_q`, `np_growth_yoy_q` (1 each), all eight `tl_*` relative-strength columns (1),
`ext_is_overall_score` / `ext_is_percentile_rank` / `ext_tt_score` (1), `insider_buy_pct_90d` (4),
`days_since_upgrade` (4), `block_deal_net_qty` / `block_deal_value_cr` (6), `mf_sector_flow_pct`
(13), `pledge_pct` / `pledge_chg_qoq` (21).

### 3.2 Endpoint → column mapping — the actual gap analysis

The family counts in §2 count *endpoints*, not gaps. Mapping them onto the real holes above:

| Empty column(s) | Filled by | Verdict |
|---|---|---|
| `delivery_pct`, `delivery_trend_30d` | **nothing in the corpus needed** — `nse_bhavcopy_fetcher.py` already pulls official `DELIV_QTY`/`DELIV_PER` (3.4M rows, 2021→now) | **wiring gap, not a data gap.** Highest value-per-effort in this whole document, and it needs no new source |
| `analyst_upside_pct`, `analyst_count`, `analyst_buy_pct`, `analyst_count_chg`, `eps_revision_3m_pct`, `target_revision_3m_pct`, `days_since_upgrade` | corpus analyst family (23) + MC `newsapi` broker items with explicit targets | genuine corpus win — analyst revision is a well-documented anomaly and is currently at 1 row |
| `block_deal_net_qty`, `block_deal_value_cr` (6 rows) | §4.2 MC `deals/list` + Tickertape `stocks/deals` | genuine corpus win |
| `insider_buy_pct_90d` (4 rows) | corpus insider endpoints — but note `insider_transactions_fetcher.py` exists and was fixed 07-31 | check the existing fetcher first |
| `mf_holding_pct`, `mf_chg_vs_prev`, `mf_sector_flow_pct` | `mfsInvestingInStock.htm` (in corpus) | genuine corpus win |
| `pledge_pct`, `pledge_chg_90d`, `pledge_chg_qoq` | corpus shareholding endpoints | genuine corpus win |
| `fcf_yield`, `ccc_trend`, `roe_annual`, `roce_annual`, `ebitda_margin`, `np_margin` | corpus fundamentals family (119) — but `financial_ratios_fetcher.py` went weekly on 07-31 and already lifted this family 0%→~74% | **likely resolves itself**; re-measure before building |
| `sector_global_corr_21d` | `mc_global_macro_fetcher.py` already exists | wiring gap |

**Net:** of the corpus's 773 live endpoints, the ones that fill a real, currently-empty column
number in the low tens — concentrated in analyst revisions, deals, and MF holdings. Two of the
biggest holes (`delivery_pct`, `sector_global_corr_21d`) are **already-fetched data that isn't
wired**, and one large family (fundamentals) is mid-repair from a different fix.

The constraint on this platform is therefore not *how many features* and no longer mainly
*coverage* — it is **history and orthogonality**. Judge every endpoint below on those.

---

## 4. Where the value *is* — five candidates, ranked

Ranked by (fills a 0%-coverage hole) × (orthogonal to price) × (history available).

### 4.1 FII/DII flow history — 10.6 years in a single call ★ highest value

```
https://investsights.in/api/v2/fundamentals/market/fiidii?days=9999
```

**Verified live:** 2,584 daily rows, **2016-01-01 → 2026-07-30**, 738 KB, one request.
Non-null: `fii_net` 2571, `dii_net` 2583, `fii_equity` 2432, **`fii_derivatives` 2493**,
`mf_total` 2502. (`fii_buy`/`dii_buy` are only 87 — use the `_net` fields.)

**Why this matters more than anything else in the corpus.** Every audit conclusion about
screener, fundamental, ownership and sentiment features carries the same caveat: *only 55
distinct dates exist in the feature matrix*, so nothing can be validated across more than one
regime. This endpoint delivers **10.6 years of a genuinely orthogonal, market-wide positioning
series** — not a price transform — in one call. It directly attacks the binding constraint.

`fii_dii_fetcher.py` already exists, but this gives deep history and a derivatives split the
current path does not.

**Candidate features:** `fii_net` z-score (20d/60d), FII–DII divergence (the classic Indian
regime signal — foreign selling absorbed by domestic buying), `fii_derivatives` positioning as a
sentiment gauge, and cumulative-flow slope as a market-regime input to
`unified_ranker.REGIME_WEIGHTS`.

**Test:** regress forward NIFTY 5/10/21d returns on FII-net z-score across 2016–2026 and check
sign stability per regime. This is cheap and has enough history to actually be conclusive.

### 4.2 Bulk & block deals with named counterparties ★

```
https://api.moneycontrol.com/mcapi/v1/deals/list?limit=500&orderBy=deal_date&sortBy=DESC
https://analyze.api.tickertape.in/stocks/deals?order=desc&orderBy=date&count=40
```

MC returns 250 KB, fresh to 2026-07-30, with `deal_date`, `deal_type` (bulk/block), **`boughtBy`
as a named entity** ("fidelity funds india focus fund"), `action`, `quantity`, `tradedPrice`,
`exchange`. Tickertape reports **659,720 total deals** and — importantly — **`pctTransacted`**,
deal size as a percentage of float.

**Why it's valuable:** `pctTransacted` is *already normalized*. Raw quantity is unusable
cross-sectionally (1M shares means nothing without float); a percent-of-float is directly
comparable across the universe and is the correct ML input. This is the single most
ML-ready field in the corpus.

**Orthogonality:** transaction-based, not price-derived. Independent of every momentum feature
the audits found to be negative.

**Candidate features:** net institutional `pctTransacted` over 5/20/60d; a repeat-buyer flag from
the named counterparty; deal price vs VWAP (are they paying up or being accommodated?).

**Caveat:** bulk/block deals are disclosed *post-trade*. Stamp every row with its disclosure
date and as-of join it — the `as_of.py` helper exists for exactly this. Using `deal_date`
as the knowledge date is a look-ahead leak of the same class fixed nine times already
in this repo.

### 4.3 Full options surface — per-strike IV, Greeks and buildup, whole F&O universe

```
https://smartoptions.trendlyne.com/phoenix/api/fno/market/filter/?mtype=options&screenType=oi-gainers
```

99 KB, 200 rows per screenType, ~20 screenTypes. Columns verified by reading `tableHeaders`:
`strike_price, current_price, day_change, traded_contracts, traded_contracts_change, ttv,
open_interest, oi_difference, oi_change, implied_volatility, iv_change, currentPrice(spot),
delta_calc, gamma_calc, rho_calc, theta_calc, vega_calc, get_built_up_str`.

The platform has ATM IV and skew (`pcr_fetcher.py` → `stock_options_oi`, `iv_features.py`). This
is the **full per-strike surface plus Greeks plus a buildup label** ("Long Build Up",
"Short Build Up") in one call per screen.

**Why it's valuable:** options are the only genuinely *forward-looking* dataset here — they price
expectations rather than record history. `iv_change` combined with `oi_change` is a positioning
signal that is structurally orthogonal to realized price momentum, which matters given momentum
measures negative at both horizons studied.

**Two hard warnings:**

- **An expired `expDate` returns a payload that passes every null/coverage check and is still
  wrong.** Re-tested explicitly against live and expired expiries on 2026-07-31 (near expiry
  `2026-08-04`):

  | `expDate` | rows | IV non-null | Greeks | OI / price / volume |
  |---|---|---|---|---|
  | omitted (auto) | 112 | **106/112** | real | real |
  | `2026-08-04` (live near) | 112 | **106/112** | real | real |
  | `2026-08-25` (next monthly) | 200 | **187/200** | real | real |
  | `2026-07-28` (expired 3d) | 200 | **0/200** | **all identically 0.0** | real (frozen) |
  | `2026-05-26` (expired 9wk) | 200 | **0/200** | **all identically 0.0** | real (frozen) |
  | `2021-01-01` | 0 | — | — | — |

  This is worse than "stale". On an expired contract the price/OI/volume block is **fully
  populated** with the contract's frozen final values, `implied_volatility` and `iv_change` go
  **NULL**, and `delta`/`gamma`/`rho`/`theta`/`vega` come back **0.0 — not NULL**. So:
  a row-count check passes (200 rows); a non-empty check passes; an OI-populated check passes;
  and a **Greeks null-coverage check passes at 100%**, because 0.0 is a value. Only a
  *value* check catches it. Zero Greeks are also individually plausible for a deep-OTM strike,
  so nothing about a single row looks wrong.

  Ingesting this writes NULL into `atm_iv`/`iv_rank`/`iv_skew` (already only 9.4% covered, so it
  reads as "coverage didn't improve" rather than an error) and **0.0 into the Greeks columns**,
  which `dataQualityChecks.ts`'s freshness/coverage/range checks would not flag.

  **Rule:** the expiry must be *live*; how you specify it doesn't matter — omitting it and passing
  the current near date returned byte-identical data apart from the `near`/`next` label in the row
  URLs. Validate on ingest that `implied_volatility` is non-null on a majority of rows and that
  the Greeks are not all-zero; reject the batch otherwise. Every captured URL in the corpus carries
  a stale hardcoded date.
- **Header key is `name` here, not `unique_name`.** `CLAUDE.md` documents `unique_name` for the
  Kayal screener API. This Trendlyne family uses `name`. Resolve columns from `tableHeaders` at
  parse time and never index positionally — the 2026-07-30 max-pain call/put swap and the
  2.1M-row corruption were both positional-indexing bugs.

**Candidate features:** IV-change percentile, put-call IV skew slope, `oi_change` concentration
at the max-pain strike, buildup-label counts per symbol.

### 4.4 Superstar / institutional investor tracking — genuinely novel

```
https://investsights.in/api/v2/investors/?only_superstars=true&sort_by=last_activity_date&page=0&limit=60
```

**31,001 investors** with `total_stocks_held`, `avg_holding_pct`, `max_holding_pct`,
**`new_entries_count`, `exits_count`, `increased_count`, `decreased_count`**,
`last_activity_date`.

The platform has aggregate shareholding percentages. It has **no per-investor conviction
tracking**. Entry/exit/increase/decrease counts per named investor are a different and much
sharper object than "FII % went from 12.1 to 12.4".

**Candidate features:** count of tracked investors newly entering a symbol this quarter;
conviction-weighted ownership change; a concentration measure (few holders at high % = higher
idiosyncratic risk).

**Caveat:** quarterly disclosure, so a slow feature with real publication lag — apply the
`PERIOD_LAG_DAYS` convention already used in `earnings_beat_features.py`.

### 4.5 Forward corporate-event calendar

```
https://frapi.marketsmojo.com/market_events/getData
```

98 KB keyed by **future** dates (`2026-08-03`: board meetings, `details: "Quarterly Results"`,
`bse500_flag`).

**Why it matters:** enables *event-conditional* modelling — "days until next earnings" is a
well-established conditioning variable, and the 2026-07-31 intraday audit found mean-reversion
that may well behave differently into an event. It also lets you **exclude** names with a
pending binary event from mean-reversion baskets, which is risk control rather than alpha.

Also worth noting: `www.moneycontrol.com/newsapi/mc_news.php` with broker tags returns parseable
analyst actions with explicit targets ("Buy Bharat Electronics; target of Rs 530: Motilal
Oswal") — a route to an analyst-revision feature, which is one of the better-documented
cross-sectional anomalies and currently sits at 0% coverage.

---

## 5. Recommended sequence

Ordered by (value ÷ effort), and deliberately narrow — the corpus's failure mode is breadth.

1. **FII/DII deep history** (§4.1). One endpoint, one table, 10.6 years, no symbol resolution
   needed. Highest value, lowest effort. Do this first.
2. **Bulk/block deals with `pctTransacted`** (§4.2). Already-normalized, ML-ready, orthogonal.
   Requires the disclosure-date as-of discipline.
3. **Options surface with live expiry** (§4.3). Highest ongoing value but needs the expiry fix
   and header-name resolution done correctly.
4. **Event calendar** (§4.5) as a conditioning/exclusion variable, not as alpha.
5. **Superstar investors** (§4.4). Novel, but quarterly and lag-sensitive — do it once the
   faster three are proven.

**Do not** bulk-ingest the 203 screeners or 161 technical-indicator endpoints. They add rows to
a feature matrix that is already 71% empty and duplicate signals already measured as unprofitable.

### Preconditions before any of this ships

- Every new fetcher needs a `@pytest.mark.live_datasource` test. Coverage is currently
  **16 of ~140** DB-writing Python files (~11%); this corpus is precisely the class of source
  that control exists for.
- Any endpoint with a date/expiry in the URL gets a live-value re-test in that test — §1.3 and
  §4.3 are both instances of a stale-parameter URL returning a confident 200.
- Resolve columns by header name from the response, never positionally.
- Stamp every ownership/deal/analyst row with its **disclosure** date, not its event date, and
  join via `as_of.py`.

---

## 6. Summary

The script is sound but judges endpoints on the one criterion this codebase has twice proven
insufficient. Fixing that changed the picture in both directions: **+15 endpoints recovered** by
normalizing slashes, **−10 exposed** as 200-with-empty-body from five-year-stale hardcoded
expiries.

The corpus is real and mostly live (812/919), but its *composition* is inverted relative to what
the platform needs: it is heaviest exactly where the platform is already saturated (screeners,
technicals) and thin where the feature matrix is empty (ownership, analyst, events). The value is
concentrated in roughly **five endpoints**, of which one — 10.6 years of FII/DII flow in a single
call — attacks the 55-day history constraint that currently limits every other conclusion this
platform can draw.

None of the five has a measured forward-return edge yet. Each has a stated test.

---

## 7. FIX STATUS — implemented 2026-07-31

Suites after: **936 Python passed / 69 skipped / 0 failed**; `tsc --noEmit` clean; **323 TS
tests passed**. Both items were live-run against real endpoints and the real production
Postgres, not accepted on code-reading.

### §5-1 — FII/DII deep history: SHIPPED, and §4.1's own recommendation was wrong

New `src/server/fii_dii_history_fetcher.py` + migration `1785600000000_fii-dii-flow-segments`.
Live result: **`fii_dii_flow` 682 → 2,592 rows, 2023-11-01 → now becomes 2016-01-01 → now**
(3.8× depth, 1,910 dates inserted, 610 rows gap-filled across 4,767 cells, 0 existing values
clobbered).

**§4.1 said "`fii_net`/`dii_net` are ~97% non-null — use the `_net` fields". Following that
literally would have corrupted the platform's macro-flow column.** Measured live against all
2,584 rows and cross-checked against the 589 overlapping `tradebrains` rows already in the DB,
the endpoint reuses `fii_net` for **two different quantities**, with no era flag in the payload:

| era | discriminator | `fii_net` means | verified |
|---|---|---|---|
| recent (87 rows) | `fii_buy`/`fii_sell` present | cash equity, `buy − sell` | 82/87 exact |
| historical (2,497 rows) | buy/sell NULL | **all-segment**, `fii_equity + fii_debt + fii_derivatives` | 2,472/2,497 exact |

On 2024-09-26 the raw `fii_net` reads **132,159 Cr against a true cash-equity 8,538 Cr — a 15×
overstatement**, because `fii_derivatives` is 123,443 Cr. The cash-equity series in that era is
`fii_equity`, and it matches the existing tradebrains rows **exactly: 506 of 506 comparable
overlap rows agree within 1 Cr, median absolute difference 0.03 Cr** (pure rounding).

Two further traps, both handled:

- **The endpoint's "DII" is not DII.** Its `dii_net` equals `mf_total` (2,484/2,497) — SEBI
  mutual-fund flows only — while `fii_dii_flow.dii_net` means NSE's DII aggregate (banks +
  insurers + MFs + others). On the overlap the two disagree by a **median of 3,786 Cr and agree
  within 1 Cr on 0 of 576 rows**. Historical rows therefore leave `dii_net` NULL and the MF
  series lands in its own `mf_*` columns. (My first read of this dismissed it as a NULL
  artifact; re-testing on non-null rows only showed the mismatch is real. Both directions were
  checked before the mapping was fixed.)
- **21 "transitional" rows carry both** the buy/sell pair *and* the segment breakdown
  (2026-03-20…2026-03-25). There `fii_net` is cash equity (2026-03-25: −1508.89 = buy−sell,
  against equity+debt+deriv = 4242.8), confirming buy/sell-presence — not the mere existence of
  segment fields — is the correct discriminator. **This case was found by the mandatory
  `live_datasource` test, not by construction**, and the first implementation silently dropped
  their derivatives data.

Design choices worth keeping: the fetcher is **gap-fill by default** — an existing non-NULL
value and its `source` provenance are never overwritten — so it is order-independent against
the NSE/tradebrains writers and safe to re-run. One call returns all history in ~3 s, so
backfill and daily top-up are the same operation; it is wired into `ml-daily-ops` *after*
`fii_dii_fetcher.py` (today's authoritative NSE row lands first and wins) as a tolerated
`T.run(...).catch(...)` step, so a third-party outage cannot fail the daily ML chain.

Tests: 17 unit (**negative-controlled** — reverting to the naive `fii_net` passthrough fails 3
targeted assertions) + 4 `live_datasource`, which re-verify **both era invariants against the
live response on every run**, so an upstream semantics change fails there rather than silently
poisoning the column.

### §1.5 — `verify_live_urls.py` hardened: all four changes

Rewritten to import its parsing/normalization helpers from `probe_endpoint_payloads.py` rather
than reimplement them — a second, drifting copy of a parser is precisely how the 2026-07-23
corruption survived. It now emits a **verdict**, not a status code.

Live re-run over the real 919-URL corpus (53 s):

```
ok 616 · empty_ok 76 · needs_live_param 75 · auth_blocked 60 · not_json 39
http_404 23 · stale 14 · http_5xx/4xx 10 · timeout 3 · error 3
URLs recovered by collapsing doubled slashes: 24 (17 now 'ok')
```

**The headline number: 820 endpoints returned HTTP 2xx, and 204 of them (24.9%) are not
usable.** The old status-code-only script blessed all 820. All 10 `trendlyne.com/futures-
options/api-filter/*` endpoints are correctly caught as `needs_live_param` — they return 200
with 123 "records" that are actually `tableHeaders`, off a hardcoded `30-sep-2021` expiry.

One implementation note: an undelimited 8-digit run is genuinely ambiguous (NSE's own bhavcopy
uses **DDMMYYYY**, `sec_bhavdata_full_04012021.csv`; other providers use YYYYMMDD), so
candidates are **parsed** rather than regex-matched — otherwise every numeric `companyid` in
the corpus would false-flag and the signal would be worthless. 24 tests, each pinning a failure
mode that actually occurred against this corpus.

### Not done from §5, and why

Items 2–5 (bulk/block deals with `pctTransacted`, the options surface, the event calendar,
superstar investors) are each a **new fetcher plus its mandatory `live_datasource` test**, and
§5 explicitly sequences them behind item 1. They remain open as scoped. The options surface in
particular must not be attempted without the live-expiry discipline in §4.3 — an expired
`expDate` returns 200 with real OI, NULL IV and every Greek exactly `0.0`, which passes row
count, non-empty *and* null-coverage checks.
