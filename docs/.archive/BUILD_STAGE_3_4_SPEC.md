# Build Spec: Stages 3–4 — Class Q Transfer and Feature Recompute

**Audience: an AI coding agent executing this build.** All rules from
[BUILD_STAGE_0_2_SPEC.md](BUILD_STAGE_0_2_SPEC.md) §0 (how to execute) and §1 (invariants) remain
in force throughout. Work stage-by-stage. Every task carries a **Verify** step; run it before
continuing.

Prerequisites: Stage 2 acceptance gate passed. You have the coverage report required by §7 of the
Stage 0–2 spec. Every number below that is preceded by VERIFIED was confirmed against working
production fetcher code on 2026-08-12.

---

## 1. Context — what stages 3 and 4 accomplish

Stage 3 copies vendor point-in-time data (Class Q) that cannot be re-fetched from provider
archives: screener membership history, fundamental snapshots, FII/DII history, corporate events
already confirmed via filings. These rows are transferred with `provenance_quality = 'inferred'`
and a single boundary date recorded in `docs/measurement.md`.

Stage 4 recomputes everything derived: features, engine scores, and signals. No derived row is
transferred. Any score, feature, signal, outcome or recommendation in the old database is ignored.

---

## 2. VERIFIED provider facts — use exactly as written

### 2.1 Corporate actions — InvestSights

| Property | Value |
|---|---|
| URL | `https://investsights.in/api/v2/market/corporate-actions` |
| Params | `?days_back=45&days_ahead=180` (configurable) |
| Method | GET, unauthenticated |
| Headers | `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`, `Accept: application/json` |
| Response envelope | `{"success": true, "source": "nse_filings", "actions": [...]}` |
| Natural key | `source_url` — a URL to a specific NSE filing PDF, globally unique by construction. Use it as the stable dedup key, not a compound date+symbol. |
| Symbol format | Returns **NSE tickers directly** (`"TATAPOWER"`, `"CINEVISTA"`). No translation needed. Still validate against `security.symbol` before inserting. |
| `ex_date` | **Frequently NULL even when `record_date` is populated.** This is a normal state (NSE discloses record date before ex-date is fixed), not a parse failure. Do not reject the row. |
| `category` | Pipe-joined multi-label string (`"board_meeting|dividend|results"`), not an enum. Store as `text`. |

Live-verified 2026-08-07: returns 41 rows for the default window, each with a real
`nsearchives.nseindia.com/corporate/*.pdf` URL.

### 2.2 Trendlyne screener membership — Kayal

| Property | Value |
|---|---|
| URL template | `https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/?perPageCount=10000&pageNumber=0&screenpk={pk}&groupType=all&groupName=` |
| Headers | `User-Agent: Mozilla/5.0 ... Chrome/124.0.0.0 Safari/537.36`, `Accept: application/json`, `Referer: https://kayal.trendlyne.com/` |
| Auth | **None required.** The kayal broker-webview path is unauthenticated. No login, no session, no cookie. |
| PK seed | 1,052 known `screenpk` values. Canonical list is in `src/server/trendlyne_screener_discovery.py` `KNOWN_PKS`. Copy this list verbatim into the new ingestion code. Do not guess or auto-discover in Stage 3. |
| Symbol extraction | Match on field `unique_name` (not `field` or `key`). This was the root cause of the silent parse bug that corrupted 2.1M rows. Confirm the field name from the live response before writing the parser. |
| Identity key | `(provider='trendlyne', provider_id=str(screenpk), version=1)` maps to `screener_definition`. Membership rows use `(provider, provider_id, version, symbol, observed_at)`. |
| Rate limit | 0.4s between requests, batch size 15 with 0.5s gap. |

**Critical:** the `screenpk` is a Trendlyne-issued integer. It must always appear as
`(provider='trendlyne', screenpk)` in any key — never bare. MoneyControl, ET, and NiftyTrader
issue overlapping integer screener IDs.

### 2.3 Trendlyne fundamentals — chart-data series

| Property | Value |
|---|---|
| URL template | `https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}/` |
| Required query param | `?format=json` — DRF returns HTML without it. |
| Headers | `User-Agent: Mozilla/5.0 ... Chrome/124.0.0.0 Safari/537.36`, `Accept: application/json`, `Referer: https://trendlyne.com/` |
| Auth | Uses `tlid` resolved from `scripts/stocklist.json` (or the new `provider_security_id` table in the rebuilt DB). |
| Active params | `EPS_TTM`, `DIVIDEND_YIELD_TTM_Q`. |
| Dead params | `CFO_Q`, `CAPEX_Q`, `EBIT_Q`, `INT_EXP_Q`, `TRADE_RECEIVABLE_Q`, `DEBTORS_Q`, `INVENTORIES_Q`, `TRADE_PAYABLE_Q`, `CREDITORS_Q`, `REVENUE_Q`, `COGS_Q`, `RAW_MATERIAL_Q` — VERIFIED DEAD 2026-07-04. Each returns HTTP 200, `head.status="0"`, `eodData: []`. Do not implement fetchers for these params. |
| Rate limit | 0.5s between requests, batch size 15 with 0.5s gap. |
| Stock universe | `scripts/stocklist.json`, ~2,005 stocks. |

### 2.4 Trendlyne advanced technical — daily

| Property | Value |
|---|---|
| URL template | `https://trendlyne.com/equity/api/stock/adv-technical-analysis/{tlid}/24/` |
| Required query param | `?format=json` |
| Headers | Same as 2.3. |
| Frequency code | `24` = 1-day. |
| MA count | 16 (8 SMA + 8 EMA). Use as the denominator for `ma_bull_frac`. |
| Oscillator count | 9. Use as the denominator for `osc_bull_frac`. |

This endpoint returns a single-day snapshot, not history. In Stage 3 it is run forward only — no
backfill of prior dates is possible from this source.

### 2.5 ET Stats — quarterly/annual fundamentals

| Property | Value |
|---|---|
| URL | `https://etmarketsapis.indiatimes.com/ET_Stats/mobile` |
| Params | `?companyId={id}&events={Balance|CashFlow|Quarterly|Ratio}&last={n}&bType=all` |
| `events` values | `Balance` (annual balance sheet, 5 years), `CashFlow` (annual cash flow, 5 years), `Quarterly` (8 quarters P&L), `Ratio` (annual ratios, 5 years) |
| Identifier | `companyid` from `scripts/stocklist.json`. Not Trendlyne's `tlid`. |
| Publication lag | 90 days from fiscal year-end (SEBI LODR Reg 33 mandates 60 days; use 90 as a conservative floor). `publication_lag_days = 90`. An annual figure is only knowable 90d after its `yearEnding`. **Do not stamp a figure onto any row with a date before `yearEnding + 90d`.** |

`available_at` formula: `yearEnding + 90 days`. This is the `as_of_floor` logic verified in
`src/server/et_stats_client.py`. For missing or unparseable `yearEnding`, use the latest
completed trading session date from `trading_session` — not `date.today()`, which fails on
non-trading days (the exact bug fixed in the predecessor's `as_of_floor` function).

### 2.6 MarketsMojo financials

| Property | Value |
|---|---|
| URL | `https://frapi.marketsmojo.com/apiv1/financials/get-financials` |
| Params | `?qtype=qoq&card=1&page={n}&sid={stockid}` |
| `qtype` | `qoq` only. `yoy` was tested and rejected: it returns one same-quarter-last-year pair per page and skips ~7 quarters between pages — a sparse sample. |
| `card` | `1` only. Other values return HTTP 500. |
| Pages | Fetch pages 1–8 (confirmed real data through page 5 for HDFCBANK: Dec'17–Jun'26, ~34 quarters). Stop when a page returns empty `rows`. |
| Identifier | `stockid` from `scripts/stocklist.json`. This is the **same field as MoneyControl's `stockid`**. The provider must be stored as `'marketsmojo'` in the key — never bare. |
| Headers | Import from `marketsmojo_technical_fetcher.py`'s `HEADERS` constant, shared across all MarketsMojo fetchers. |
| Referer | `https://www.marketsmojo.com/` — required. The endpoint 403s without it. |
| Rate limit | 0.5s between requests. |

### 2.7 MarketsMojo technical card

| Property | Value |
|---|---|
| URL | `https://www.marketsmojo.com/technical_card/getCardInfo` |
| Identifier | `stockid` (same as 2.6). |
| Auth | None beyond the `Referer` header. |

### 2.8 FII/DII flow — NSE API

| Property | Value |
|---|---|
| URL | `https://www.nseindia.com/api/fiidiiTradeReact` |
| Method | GET |
| Headers | `User-Agent`, `Accept: application/json`, `Accept-Language: en-US,en;q=0.9`, `Referer: https://www.nseindia.com/market-data/fii-dii-activity`, `DNT: 1` |
| Session bootstrap | Same NSE cookie-bootstrap pattern as Stage 2: GET `https://www.nseindia.com/` first to acquire session cookies. |
| History depth | Returns the last N days. For full history, page backward using the `--days` parameter pattern from the existing `fii_dii_fetcher.py`. |

---

## 3. Stage 3 — Class Q transfer

### Task 3.0 — Establish the boundary date

Before writing any transfer code: run the Stage 2 coverage report from §7 of
`BUILD_STAGE_0_2_SPEC.md`. The last date with a complete `market_bar` panel is the
**provenance boundary date**. Record it now:

```sql
INSERT INTO audit_metric (run_id, metric_name, metric_version, dimensions, value,
  data_watermark, params_hash, code_commit, generated_at)
VALUES (current_run_id, 'provenance_boundary_date', 'v1', '{}', NULL,
  '<YYYY-MM-DD>', '<params_hash>', '<commit>', now());
```

And add a line to `docs/measurement.md`:
```
provenance_boundary_date: YYYY-MM-DD
meaning: rows with session_date < this date have provenance_quality='inferred'.
         Point-in-time research spanning this boundary must state it.
```

**Verify:** the `audit_metric` row exists and `docs/measurement.md` contains the boundary date.

### Task 3.1 — Schema additions for Stage 3

Run migration 006:

```sql
-- migration 006: fundamentals_events_screeners
```

Add the tables from GREENFIELD_BUILD_SPEC.md Part C that were deferred from Stage 0:
`fundamental_fact`, `ownership_fact`, `analyst_estimate`, `market_flow`, `event_fact`,
`screener_definition`, `screener_membership` (partitioned by `observed_at`, yearly).

Also add for Stage 3 transfer:
```sql
CREATE TABLE transfer_reject (
  reject_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_table  text NOT NULL,
  source_pk     text NOT NULL,
  reason        text NOT NULL,
  raw_snippet   jsonb,
  rejected_at   timestamptz NOT NULL DEFAULT now()
);
```

Every row that fails validation during transfer goes here. **Never silently drop.** Balance the
counts: `rows_read = rows_accepted + rows_rejected` per source table.

**Verify:** migration replays cleanly from Stage 0+1+2+new to a scratch database.

### Task 3.2 — Corporate actions transfer

Source: both the old `corporate_actions` table and a fresh fetch from InvestSights (§2.1) to
pick up any actions declared after the last old-DB fetch.

Transfer logic:

1. Fetch InvestSights with `days_back=1825` (5 years). Parse with the rules in §2.1.
2. For each row, look up `source_url` in the new `event_fact` table. If present, skip.
3. Validate: `symbol` in `security`, dates parseable, `source_url` non-empty.
4. Reject failures to `transfer_reject` with reason. Accept to `event_fact` with
   `provenance_quality = 'inferred'`, `available_at` = `filing_date + 1 day` (the earliest a
   filed PDF is publicly viewable — a conservative proxy).
5. Copy any rows from the old `corporate_actions` table not already covered, subject to the same
   validation. Assign `provenance_quality = 'inferred'`.

**Verify:** count of accepted rows matches between a dry-run report and the live insert;
`transfer_reject` count is reported; `rows_read == rows_accepted + rows_rejected`.

### Task 3.3 — Trendlyne screener membership transfer

Source: the old `screener_appearances` table (or equivalent) plus a fresh run against all 1,052
known PKs (§2.2).

Transfer logic:

1. Run a fresh kayal fetch against all 1,052 PKs. This captures today's membership as
   `observed_at = now()`.
2. For the old DB rows: validate that `symbol` resolves in `security` and that `screenpk` is an
   integer. Reject if either fails.
3. Insert into `screener_definition` (using `(provider='trendlyne', provider_id=str(screenpk),
   version=1)`), then `screener_membership`. Both `ON CONFLICT DO NOTHING`.
4. All transferred rows: `provenance_quality = 'inferred'`.

**Critical:** parse screener member symbols from the `unique_name` field, not from `field` or
`key`. Confirm the field name from the live kayal response before writing the parser. This is the
exact rule violation that caused the 2.1M-row corruption in the predecessor system.

**Verify:** a unit test that feeds a mock kayal response and asserts the symbol comes from
`unique_name`, with a negative control that feeds a response where only `field` is present and
asserts zero accepted rows.

### Task 3.4 — FII/DII flow history transfer

Source: old `fii_dii_flow` table plus a fresh NSE API fetch (§2.8).

1. Fresh fetch covers the last 180 days (to bridge any gap between the old DB's last run and the
   transfer date).
2. Old DB rows: validate that `date` is parseable, numerics are finite, scope/segment are non-null.
3. Insert into `market_flow` with `provenance_quality = 'inferred'`.

**Verify:** date range spans from the old DB's earliest row to the transfer date with no gap wider
than 3 trading days (holidays excluded using `trading_session`).

### Task 3.5 — Fundamental facts transfer

Source: fresh ET Stats fetch (§2.5) + fresh MarketsMojo financials fetch (§2.6). Do **not** bulk
copy old `fundamentals_history` rows directly — use a fresh provider fetch so the new
`available_at` formula (`yearEnding + 90d`) is applied correctly. Old rows used `CURRENT_TIMESTAMP`
or a similar proxy; they would corrupt the point-in-time logic.

For each symbol in `security` with `status = 'listed'`:

1. Fetch all four `events` from ET Stats. Parse into `fundamental_fact` with the publication-lag
   formula of §2.5.
2. Fetch up to 8 pages from MarketsMojo financials. Parse, dedup by `(symbol, period_end,
   metric, source)`. `ON CONFLICT DO NOTHING`.
3. Both sources labelled with their `provider` in the row.
4. `provenance_quality = 'inferred'` for all.

**Verify:** at least one `fundamental_fact` row exists for ≥95% of currently listed symbols;
zero rows have `available_at` before `period_end + 89 days` (the publication-lag floor).

### Task 3.6 — Screener definitions — MC and ETNow

Source: the existing `screener_master` table from the old DB. These are catalog entries, not
membership history; they transfer cleanly.

1. Validate: `(source, scan_id)` is unique. Reject duplicates with reason.
2. Map `source` to the new `provider` column; `scan_id` to `provider_id`.
3. Insert into `screener_definition` with `enabled = false`. Promotion to `enabled = true`
   requires a live shape test; do not promote during transfer.

**Verify:** row count in `screener_definition` for `provider IN ('moneycontrol', 'etnow')` matches
the accepted count from the transfer report.

### Task 3.7 — Data quality checks for Stage 3 tables

Insert `dq_check` rows in the same migration as each table:

| check_id | Asserts |
|---|---|
| `corporate-actions-freshness` | latest `event_fact` with `kind = 'announcement'` within N trading days |
| `fundamentals-coverage` | `fundamental_fact` has at least one row per listed symbol |
| `fundamentals-lag-floor` | no `fundamental_fact` row with `available_at < period_end + 89 days` |
| `fii-dii-freshness` | latest `market_flow` session within 1 trading day |
| `screener-membership-freshness` | latest `screener_membership` observed_at within 3 trading days |

All checks: trading-day aware. All: negative-controlled before being considered passing.

**Verify:** for each check_id above, inject a violating row into a scratch database and confirm
the check returns status `fail`; then remove the row and confirm it returns `pass`.

### Acceptance Gate 3

1. `transfer_reject` count is published per source table with reasons. Zero unexplained rejects.
2. `rows_read == rows_accepted + rows_rejected` for every transfer task.
3. `audit_metric` contains the `provenance_boundary_date` row.
4. `fundamental_fact`: ≥95% of listed symbols have at least one row; zero rows violate the
   publication-lag floor.
5. `screener_membership`: all 1,052 kayal PKs have at least one membership snapshot from today's
   fresh run.
6. All Task 3.7 DQ checks pass; all are negative-controlled.
7. `fundamental_fact` rows with `available_at > now()` = 0. (Future-dated provenance is a parser
   bug.)

---

## 4. Stage 4 — Feature recompute and engine rebuild

### Overview

No row from the old database is used in Stage 4. Every number comes from the rebuilt canonical
layer (Stage 2) and the quarantine-copied enrichment (Stage 3). Models are retrained, not copied.

### Task 4.1 — Feature set spec

Publish `feature_set` version `v1` as a JSON document in the migration:

```sql
INSERT INTO feature_set (feature_set_version, spec, created_at, code_commit)
VALUES ('v1', '{
  "sources": ["market_bar", "delivery_stat", "fundamental_fact", "market_flow",
              "screener_membership", "event_fact"],
  "metrics": [
    "momentum_21d", "momentum_63d",
    "delivery_pct", "delivery_pct_ma20",
    "pe_pct_rank_252d", "pb_pct_rank_252d",
    "eps_ttm", "eps_growth_yoy",
    "div_yield_ttm",
    "ma_bull_frac", "osc_bull_frac", "adx_tl", "atr_pct_tl",
    "fii_net_21d", "dii_net_21d",
    "screener_breadth"
  ],
  "exclusions": ["pcr_oi", "pcr_vol", "rev_growth", "eps_growth"],
  "horizon": "session",
  "entry_rule": "next_session_open"
}'::jsonb, now(), '<commit>');
```

**Exclusions are mandatory and not optional:** `pcr_oi`, `pcr_vol`, `rev_growth`, `eps_growth`
were confirmed as 100% NULL in the predecessor (`feature_store` schema contained them but
nothing ever wrote to them). Do not include them. Their presence caused silent zero-imputation
in training code and contributed to inflated AUC.

Measured and dead from prior research — **do not include**: `stoch_d`, `williams_r`, `stoch_k`,
`cci`, `di_plus`, `dist_sma20_pct`, `vwap_dist_pct`, `volume_ratio_20d`, `obv_slope`, `atr_pct`,
`volume_ratio_5d`, `macd_hist`, `mtf_alignment_score`, `bb_width`. Every one of these had
`|t| ≥ 3.15` against the negative tail at 5d/15bps in the predecessor's factor harness (the
verified table in `.claude/rules/measurement.md`). Including them inverts the model.

**Verify:** (1) the JSON in `feature_set` does not contain any excluded column name; (2) a query
`SELECT feature_set_version FROM feature_set WHERE feature_set_version = 'v1'` returns one row.

### Task 4.2 — Feature snapshot computation

For each trading session from 2021-01-04 to present, compute `feature_snapshot` per symbol using
only data with `available_at <= session_close_timestamptz`. This is the point-in-time constraint.

Mandatory implementation rules:

1. Read all inputs through `packages/db`'s PIT API. No direct table access from the feature
   computation code.
2. Winsorise return metrics at the 1st and 99th percentile, per date, before any further use.
3. Exclude `market_bar` rows with `is_suspect = true`.
4. Apply the liquidity floor (≥₹1cr ADT) for any cross-sectional ranking feature.
5. `feature_snapshot.facts_cutoff` = the timestamp of the most recent input row consumed.
   `feature_snapshot.coverage` = fraction of `metrics` that are non-NULL for this symbol.

**Verify:** for any given symbol and session date, the feature snapshot must be identical whether
computed in a batch over the full history or computed on-demand for a single date. Test this.

### Task 4.3 — Research harness validation

Before training any model, validate the harness. From `.claude/rules/measurement.md`, the harness
must pass these negative controls before any of its results are trusted:

1. **Leakage control:** introduce a future-date feature (tomorrow's return as a predictor). The
   harness must report AUC significantly > 0.5. If it does not, `facts_cutoff` enforcement is
   broken.
2. **Exit-pricing control:** introduce a bug that prices every non-closing name at −100%. The
   harness must report significantly negative excess returns for good factors.
3. **Benchmark control:** at `--rebalance 1` vs `--rebalance 21`, results must be within ~5pp of
   each other. The predecessor had a bug where `--rebalance 1` was off by ~35pp/yr due to a
   wrong benchmark.
4. **Known-null control:** a feature known to be 100% NULL must produce IC ≈ 0 and t ≈ 0.

All four must pass before any factor is declared significant.

**Verify:** a CI-runnable test suite that runs each negative control automatically. Output must
be explicit pass/fail, not a number to inspect. The test must fail if the leakage control does
not detect the injected leak.

### Task 4.4 — Measurement baseline

Run the harness over the rebuilt panel. Record results in `audit_metric`. Before publishing any
number:

1. The harness has passed all four negative controls in Task 4.3.
2. The measurement matches the panel spec: per-date then averaged (not pooled); winsorised;
   `is_suspect` excluded; liquidity floor applied; next-session-open entry; both tails graded.
3. Results are stored in `audit_metric` with `run_id`, `code_commit`, `data_watermark`,
   `params_hash`.

**Known verdicts from the predecessor — treat as priors, not conclusions:**

| Factor | Prior verdict | Action |
|---|---|---|
| `momentum_21d`, `63d` | negative, `t` up to −3.96 | Include in harness; expect negative |
| `delivery_pct` (raw level) | long-only loses despite real directional spread | Test, do not assume transfers |
| `screener_breadth` | negative point estimate, not significant (low power, <3 months history) | Test with full panel — verdict may change |
| `insider_net` | t=1.73, not significant | Test; report honestly |
| All 14 `feature_store` technical metrics | Bonferroni-significant negative | Do not include in any positive model |

A prior is an informed starting point, not a certainty. Re-measure on the rebuilt panel. If the
rebuilt result disagrees, the rebuilt panel's result takes precedence — but explain the divergence.

**Verify:** every `audit_metric` row has a non-NULL `data_watermark` and `code_commit`.

### Task 4.5 — DQ checks for derived tables

| check_id | Asserts |
|---|---|
| `feature-snapshot-coverage` | median `coverage` per session ≥ 0.8 |
| `feature-snapshot-freshness` | latest session within 1 trading day |
| `feature-suspect-exclusion` | zero `feature_snapshot` rows where the underlying `market_bar.is_suspect = true` |
| `model-artifact-hash` | active model artifact's stored hash matches on-disk file |

**Verify:** all four checks pass negative controls.

### Acceptance Gate 4

1. Research harness passes all four negative controls in Task 4.3.
2. Every metric cited from the harness exists in `audit_metric`.
3. `feature_snapshot` coverage report: median per-session coverage ≥ 0.8.
4. No `feature_snapshot` row was computed using a future-dated input (verify via
   `facts_cutoff <= session_close` for every row).
5. Excluded column names are absent from all model training runs (grep model input specs).
6. All Task 4.5 DQ checks pass; all are negative-controlled.

---

## 5. What comes next — Stages 5 and 6

Stage 5 (shadow decisions and cutover) depends on Stage 4's acceptance gate. It will cover:

- A single ranker writing append-only `recommendation` rows with `is_publishable = false`
  during shadow mode.
- A preregistered live shadow period (minimum dates before publication is considered) recorded
  in `audit_metric`.
- Dual-run divergence analysis between old and new systems.
- Cutover sequence: freeze old DB writes → delta Q-transfer → repoint services → smoke test.

Stage 5 spec will be authored after Stage 4's acceptance gate result is reported. Do not begin
Stage 5 design work before that — the shadow-period length and the promotion gate threshold both
depend on the Stage 4 harness results.

---

## 6. Prohibitions (additive to BUILD_STAGE_0_2_SPEC.md §6)

13. Do not bulk-copy any Class N table (`stock_scores`, `quant_scores`, `unified_recommendations`,
    `feature_store`, `unified_signals`, `signal_outcomes`, `technical_signals`,
    `confluence_signals`, `intraday_recommendations`, `recommendation_log`, model artifacts).
14. Do not set `available_at` to the transfer timestamp or `now()` for any historical fact.
15. Do not use `tqtype=yoy` for MarketsMojo — it is verified to return a sparse sample.
16. Do not fetch Trendlyne chart-data params `CFO_Q`, `CAPEX_Q`, or the nine other confirmed-dead
    params listed in §2.3.
17. Do not include `pcr_oi`, `pcr_vol`, `rev_growth`, `eps_growth`, or any of the 14 Bonferroni-
    significant negative `feature_store` metrics in any model.
18. Do not parse screener member symbols from the `field` or `key` fields — use `unique_name`.
19. Do not declare Stage 4 complete until all four negative controls pass as a command exit 0.
20. Do not copy model artifacts. Retrain from the rebuilt panel.

---

## 7. Report back on completion

After Stage 3, report:
- accepted/rejected counts per transfer task, with reject reasons;
- provenance boundary date;
- `fundamental_fact` coverage (% of listed symbols);
- `screener_membership` snapshot count for today's fresh kayal run;
- exit code of each acceptance gate command.

After Stage 4, report:
- harness negative control results (pass/fail per control);
- per-factor IC, t-stat, and comparison to predecessor priors;
- `feature_snapshot` coverage summary;
- `audit_metric` row count;
- exit code of each acceptance gate command.

If any gate is red, state it plainly.
