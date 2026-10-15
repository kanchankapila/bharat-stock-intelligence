# Systems audit — data fetch → endpoints → refresh → logic → storage → ontology → frontend (2026-10-15)

Reviewer stance: senior quantitative analyst + head of equity research. Every number below was read from live
production on 2026-10-15 (read-only `scripts/sql.py`) unless it cites a ledger row. Confidence tags:
**[Certain]** reproduced on live data, **[Likely]** strong inference, **[Guessing]** hypothesis.
Open items are filed in `docs/audit-findings.md` (AF-20261015-07..13); nothing here is a second tracker.

## 0. The two things that decide whether any of this is investable

1. **The price series itself was still wrong in places.** A -91% "return" on a demerger is not noise; it is a
   fabricated loss that flows into momentum, volatility, drawdown, stop distance and every IC computed over it.
   Found 15 such declared-action seams; 3 live in the last 10 sessions. [Certain] (AF-20261015-07)
2. **The ranked list is not a tradable list.** 11 of today's top 50 trade under Rs 1 cr/day and 20 under Rs 10 cr/day,
   while the project's own grading standard only believes Rs 10 cr+ names. [Certain] (AF-20261015-10)

## 1. Data fetch

| Finding | Evidence | Severity |
|---|---|---|
| Corporate-action feed classifies by substring of the NSE `subject` and drops the text. Demerger / capital reduction / ratio-less split land as `OTHER`/`SPLIT` with `ratio=NULL`, and the subject is not stored, so nothing downstream can re-classify. | BHAGYANGR 10-08, VERANDA 10-06, HEG 09-07 all `OTHER`; live NSE returns subject `Demerger` | High [Certain] |
| `ohlcv_adjust` reverse-derives factors from prices and *rejects* anything not a clean ratio; the module header says "reported rather than guessed", but nothing consumed the report. | 15 live events with a declared action and a persisting new level | High [Certain] |
| Universe is a static list, not derived from the exchange. 594 EQ/BE symbols traded on 10-14 are not in `nse_stocks`; measured split: 192+ ETFs/funds, 234 new listings (< 60 sessions), 168 seasoned equities of which ~15 are liquid enough to rank. The reverse also holds: 13 ranked symbols are not listed at all (aliases/phantoms), now filtered. | AF-20261015-11/-12 | Low-Medium [Certain] |
| New-listing coverage is structurally late: a symbol enters only when someone adds it, so IPOs are absent for weeks and enter with truncated history, which biases any "age"/"history length" feature. | MANIPALHOS, SHIPROCKET, ORIENTCABL absent | Medium [Likely] |
| Single-source dependence on NSE for the official bar. When bhavcopy lags the Yahoo bar, the reconcile quarantines nothing. The ghost-bar rule only works on complete files (>= 1,500 symbols). | CCAVENUE 10-13..15 | Medium [Certain] |

## 2. Data endpoints

- `market_endpoint_registry`: **3,408 of 3,408 rows `is_working = true`, last validated 2026-09-13 (32 days)**. A
  registry that can never say "no" is a list, not a health record. Any consumer reading `is_working` as current is
  reading a 32-day-old probe. A DQ check now labels it as discovery evidence (`market-endpoint-validation-age`). [Certain]
- Probing minimum headers works and is already doctrine; the gap is that nothing re-probes on a schedule, so a
  vendor that moved (NiftyTrader, MarketsMojo twin payloads) is discovered only when a fetcher goes red.
  Recommendation: weekly 5% sample re-probe writing `validated_at` and a *negative* result. [Likely]
- Byte-identical payloads for different query params (MarketsMojo gainer/loser) show that "HTTP 200" is not a
  contract; response-shape assertions are per-fetcher, not per-endpoint. [Likely]

## 3. Data refresh and orchestration

- **A host outage silently skipped the nightly backup.** The 2026-10-14 23:15 IST slot never fired, the 00:26 launch
  was discarded as "off-schedule", and the monitor stayed green because it only warns above 2 days. Fixed: catch-up
  outside market hours + verified fresh dump (5,552 MB). Recommendation: warn above 1.3 days. (AF-20261015-08) [Certain]
- **The day's bar lands ~16:00 IST and a signal-expiry check judged it before the 16:30 closer**, failing every
  weekday for 30 minutes (11 false pages). Fixed (AF-20261008-46). General lesson: a check keyed on "latest session"
  must know the slot of the job that is supposed to act on it. [Certain]
- **`mover-study-weekly` timed out at 30 then 45 min** because one CTE was inlined with a 2-row estimate and rescanned
  the window per symbol (166 dates x ~8 s). 195 s after the fix. Lesson: raising a timeout is not a fix; the stage
  log that would have shown it did not exist. (AF-20261015-06) [Certain]
- Cadence mismatches recur because schedules, `jobRegistry.ts` mirrors and DQ thresholds are three copies of one
  fact. Five consistency suites exist; they guard drift, not wrongness. [Likely]

## 4. Data logic and the model layer

- **Edge.** Thin, regime-dependent and unproven; forward test cannot reach 20 independent 5d windows before
  2027-02-26. The honest sentence the product can say is "this is a rank that has not been shown to predict returns".
  [Certain, per measurement.md]
- **Probability honesty.** `calibrated_win_probability` is a rank, not a probability; no recalibration beats the
  trailing base rate. UI now shows rank. Remaining risk: five consumers apply absolute thresholds (0.55/0.40/0.30)
  to it. (AF-20261008-45) [Certain]
- **Percentile normalisation over a moving population.** `_normalize_to_100` re-spreads every engine over 0-100 each
  run, so adding 100 ETFs or 60 IPOs changes every existing score. Admitting names is therefore an EVIDENCE item, not
  a data chore. [Certain by construction]
- **Uniform overlays.** Quality gate / red-flag veto / crowding multipliers fire on large shares of the universe;
  a multiplier that fires on ~100% of names changes no rank and only shifts absolute thresholds. Check prevalence
  before touching thresholds. [Likely]
- **Trade geometry is formulaic.** Swing: median stop -5.8%, T1 +9.2%, R:R 1.14, est. cost 37 bps; intraday names
  carry a +6.1% T1 (22 names). Nothing shows these targets are reached at the frequency implied by R:R. Targets are an
  output of the score, not of a hit-rate-calibrated distribution. [Likely]
- **Liquidity is a presentation filter, not a ranking input** (AF-20261015-10). Expected cost (`est_cost_bps`) exists
  and is not subtracted before ranking. [Certain]

## 5. Biases (ordered by how much they can move a headline number)

1. **Price-basis contamination** (above): -60..-91% single-day returns inside the sample. Survives every winsorise-free
   statistic, and vanishes only in rank-based ones, which is why rank ICs looked "fine".
2. **Survivorship.** The universe is the current listing set; `stock_ohlcv` holds 2,428 symbols, 66 outside the
   universe and 32 stale > 30 days. Names that died are present as stale rows but not as *rankable* candidates on
   their historical dates. [Likely]
3. **Tradability.** Untradable top-ranked names inflate paper returns at the exact end of the distribution that
   signals are read from. [Certain]
4. **Regime.** All 104 graded signal dates sat with NIFTY below its 200-session mean, so no result generalises to a
   bull regime; every "calibration" is a bear-tape calibration. [Certain]
5. **Overlap / multiple testing.** Already corrected in `measurement.md` (windows = dates/h, Bonferroni). Keep.
6. **Float32 storage** in `nse_universe_history` is a precision bias only at 7 significant digits; low. (AF-20261015-13)

## 6. Data storage and database

- 264 public tables: **53 empty, 46 with < 100 rows**. Each is a feature someone wired and nothing fills; the
  freshness-coverage suite counts them as "covered". An empty table that no reader needs is a deletion candidate;
  one that a reader needs is an outage. Triage list = `pg_stat_user_tables` where `n_live_tup = 0`. [Certain]
- Provenance of price basis is heterogeneous: 866,574 rows since 2025-01-01 carry `adjustment_basis IS NULL`
  (before 2026-07-30), the rest are `split_only`, `split_dividend`, `nse_bhavcopy_raw`; **2,259 of 2,419 symbols
  switch basis inside the last 140 days**. Returns across a switch are only valid if each basis is already on the
  same share count, which is exactly what AF-20261015-07 repairs. [Certain]
- Four signal tables is the stated ceiling; keep it. Mixed time types persist: `data_quality_history.checked_at`
  is epoch-ms bigint, 10 date columns in 7 tables are still TEXT. [Certain]
- Backups: nightly full dump 5.5 GB through a Docker `pg_dump`; the 7-day retention was one missed night from a
  ~2-day recovery point. [Certain]

## 7. Ontology and identity

- **ISIN INE470A01017 is on both 3MINDIA and CHOLAFINSV.** One is wrong; any ISIN-keyed join (filings,
  fundamentals, holdings) assigns Cholamandalam Financial's data to 3M India. (AF-20261015-12) [Certain]
- Alias pairs (LARSEN/LT, INDUSIND/INDUSINDBK, M&M/MAHINDRA, TATAMOTORS/TMPV, LTIM/LTM) are intentional but are not
  modelled as aliases: both rows rank and both appear in `unified_recommendations` (verified in the latest run, see
  section 8). POLICYBZR/POLICYBAZAAR carried the same -36% day. [Certain]
- Sector is a 14-value label mixing three communication variants and 3 `Unknown`; there is `industry` on the row but
  peer-relative valuation needs a stable industry key and a point-in-time membership history. [Likely]
- Provider ids are derived from the NSE symbol, never the reverse (doctrine); `mcsymbol` is still ambiguous for
  62 codes. The guard exists (`mc_symbol_map.py`); the residual risk is any new code path that re-types the dict. [Likely]

## 8. Frontend

- No orphan component remains (188 `.tsx`, one barrel file never imported). The earlier "fixes in unrouted
  components" class is closed. [Certain]
- Displayed vocabulary still promises more than the evidence: "Strong Buy / Buy / Sell" on a ranker without a
  demonstrated forward edge, with 74 Strong Buys at coverage 3. A rank percentile and the scorecard's *measured*
  hit rate beside it would be the honest pair; the rank is now shown, the vocabulary is not changed (a
  classification change is an EVIDENCE item). [Likely]
- Entry/stop/target are rendered as points; the data supports bands (swing stop sits 5.8% away, T1 +9.2%). Cost is
  small against the target (37 bps vs 920 bps, ~4%), so the issue is not cost but that nobody can see how often the
  target is reached; no hit-rate sits beside it. [Likely]
- **The same company is ranked twice with different verdicts.** Latest run: INDUSIND Hold 42 vs INDUSINDBK **Sell 23**
  (same ISIN), LT Hold 58 vs LARSEN Hold 37, M&M 48 vs MAHINDRA 39, CHOLAFINSV 42 vs 3MINDIA 62 (wrong ISIN). A user
  can be told to hold and to sell one company on the same page. [Certain] (AF-20261015-12)

## 9. What I would do next, in order

1. Approve the production writes for AF-20261015-07 and -09 (dump is verified and valid until 2026-10-16 18:53 IST).
2. Measure the Rs 10 cr tradability floor on the frozen forward-test cohort (AF-20261015-10) before any change.
3. Re-probe 5% of the endpoint registry weekly and store negative results.
4. Derive the universe from the latest complete bhavcopy; decide on ETFs (AF-20261015-11).
5. Store the corporate-action `subject` text and classify demerger / consolidation / capital reduction explicitly.
6. Add a per-feature point-in-time table (as-of date, filing date) so fundamentals can never be joined on period end.
