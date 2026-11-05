# Clean-Slate Rebuild Implementation Plan

> **Historical snapshot.** This initial plan is retained as evidence for AF-20261104-03 and is
> superseded by `D:/Github/bharat-edge/docs/plans/2026-11-04-clean-slate-rebuild.md`. Do not execute
> this copy; Phase 0 subsequently completed in the `bharat-edge-sdd` worktree.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. This plan is a recipe, so its steps carry no checkboxes: the repo forbids open work items outside `docs/audit-findings.md`, and status lives in row AF-20261104-03.

**Goal:** Find out whether a tradable net edge exists, then build a new point-in-time system whose first output is a real daily brief, and add strategies only as they pass frozen forward gates.

**Architecture:** Raw vault, instrument reference, insert-only fact store with three clocks, YAML semantic contracts compiled into DB checks and tests, one research harness, hash-frozen sleeves judged against random-book nulls, one portfolio step, one decision table, thin surfaces.

**Tech Stack:** Python 3.12, plain PostgreSQL with native partitioning, pandas and pyarrow, psycopg, FastAPI, React/Vite for the UI. LightGBM only if it earns its place.

**Spec:** `docs/superpowers/specs/2026-11-04-clean-slate-rebuild-design.md`

## Global Constraints

- New repo at `D:\Github\bharat-edge` (working name, decision D1). Legacy platform and `bharat_alpha` are read-only to this work.
- Production legacy databases are read with read-only sessions and a statement timeout. No writes, no migrations, no pauses.
- Frozen protocols `13210b4e2c3ae688` (forward test) and `a0dcc6ca6fd1cef2` (paper book) are never edited.
- `EDGE_DATABASE_URL` is required, with no fallback. Tests use `EDGE_TEST_DATABASE_URL`, and the code refuses any test database whose name does not end in `_test`.
- All timestamps stored in UTC; displayed in IST. Session date comes from `clock.logical_session()` only. `date.today()` fails a static test.
- NULL means unknown. `float(x or 0)` and `fillna(0)` are banned in `src/edge` by a static test.
- Open entry only. An IC printed anywhere other than `edge.research.harness` fails review.
- Test first: each task's new test is seen to fail for the right reason before the code exists. Commit by explicit path.
- First request to any source uses no headers; add the minimum one at a time. A failing source goes to the owner with a per-route breakdown and a request for a captured browser fetch.
- Hard limit: no strategy reaches the brief as a call unless its gate state allows it.

## Review Focus

These are the inputs most likely to hurt a real user that a happy-path test would miss. Each has its test in the owning task.

1. A filing broadcast after 15:30 IST, or on a weekend, is first tradeable at the next session's open (Task 13).
2. No bhavcopy today: a holiday stays quiet and an outage produces a "degraded" brief (Tasks 7 and 15).
3. A rename or a demerger with no clean ratio must not create a fake return or a second instrument (Tasks 9 and 10).
4. A vendor answers HTTP 200 with an error envelope, or with well-formed rows that stopped at an old date (Task 8).
5. Upstream data is stale at 08:45: the brief still sends, names what is stale and makes no calls (Task 15).

---

## Program overview

| Phase | Purpose | Exit test | Plan detail |
|---|---|---|---|
| **0** | Decide whether anything is worth building for | Written verdict on H1, H2, H3 and the go or shrink decision | Tasks 1-6 |
| **1** | Kernel and walking skeleton, brief live from day one | 5 consecutive sessions of the new brief, verified from the delivery log and DB readback | Tasks 7-16 |
| **2** | Data depth, one family at a time | Each family has a contract, a monitor and a named hypothesis; restatement audits stored | New plan after Phase 1 |
| **3** | Run the hypothesis registry | Every hypothesis has a verdict in the Evidence table; trial counts logged | New plan |
| **4** | Paper books with real-fill capture | Each passing sleeve frozen, graded daily, with measured slippage | New plan; broker API needed (D4) |
| **5** | Portfolio step and the five pages | Target weights shown only from allowed sleeves; every number names its harness run | New plan |
| **6** | Cutover and subtraction | Cutover test in spec section 8 | New plan; owner decision D6 |
| **7** | Live-small | Gate ladder satisfied | Owner decision D2 |

Later phases get their own plans because Phase 0 and Phase 3 results change their contents. Guess at calendar: Phase 0 about 1-2 weeks of agent work, Phase 1 about 2-4 weeks. Paper needs at least 60 sessions, about 3 months, so a real-money decision is unlikely before 2027 Q2.

---

## Phase 0: is there anything to build for?

Read-only against production. Outputs are stored files and a verdict.

### Task 1: Repo and hypothesis registry

**Files:**
- Create: `D:/Github/bharat-edge/pyproject.toml`, `README.md`, `CLAUDE.md`
- Create: `hypotheses/H1-slow-core.yaml`, `H2-residual-surprise.yaml`, `H3-next-session-reversal.yaml`, `frozen.lock`
- Create: `src/edge/research/registry.py`
- Test: `tests/test_registry.py`

**Interfaces:**
- Produces: `load_hypothesis(path) -> Hypothesis`, `check_frozen(dir) -> list[str]`, `log_trial(hypothesis_id, params, result_path) -> int`

- **Step 1: Write the failing test**

```python
def test_edit_after_freeze_is_detected(tmp_path):
    h = write_hypothesis(tmp_path, cost_bps=32); freeze(tmp_path)
    write_hypothesis(tmp_path, cost_bps=25)
    assert check_frozen(tmp_path) == ["H-test"]

def test_hypothesis_needs_kill_rule(tmp_path):
    with pytest.raises(ValueError, match="kill_rule"):
        load_hypothesis(write_hypothesis(tmp_path, kill_rule=None))
```

- **Step 2: Run it**

Run: `pytest tests/test_registry.py -v`. Expected: FAIL, module not found.

- **Step 3: Implement `registry.py`**

A hypothesis has: `id, statement, sign, universe, tiers, entry, holding, cost_bps, primary_metric, pass_rule, kill_rule, data, version`. `frozen.lock` stores SHA-256 of each file's canonical YAML. Trials append to `research/trials.jsonl`.

- **Step 4: Fill H1, H2 and H3 before any result is seen**

Fix these values:

| | H1 | H2 | H3 |
|---|---|---|---|
| Universe | ADT >= Rs 5 cr | ADT >= Rs 1 cr, reported by tier | `s1` picks as published |
| Entry | Next open after month end | Next open after `broadcast_ts`; after 15:30 IST means next session | Published open |
| Holding | One month, buffer: enter top 30, exit below top 60 | 5, 21 and 63 sessions; primary 21 | Same-session close |
| Cost | 32 bps round trip, plus 25 bps/side sensitivity | 32 bps | 18, 40 and 60 bps |
| Primary metric | Net excess vs NIFTY 500 | Net excess, top minus bottom surprise quintile, and top vs same-liquidity mean | Net excess vs same-day mean, vs matched random null |
| Pass rule | t >= 2.0 on longest history, both halves positive, positive vs universe | t >= 3.0, both halves, shuffled control t < 1 | Above 95th percentile of null at 40 bps, leak correlation < 0.15 |
| Kill rule | Fails in both halves, or negative vs index in the extended sample | t < 2 at 21 sessions after costs | Null percentile < 95 at 40 bps, or fills unobtainable for over 25% of picks |

- **Step 5: Run tests, freeze, commit**

Run: `pytest tests/test_registry.py -v`, then `python -m edge.research.registry freeze hypotheses`. Expected: PASS and `frozen.lock` written. Commit by explicit path.

### Task 2: Audit the live lead (H3)

**Files:**
- Create: `src/edge/research/h3_audit.py`
- Test: `tests/test_h3_audit.py`
- Output: `research/out/h3_audit.json`

**Interfaces:**
- Consumes: `load_hypothesis`, `log_trial`
- Produces: `forward_stats(picks, prices, universe, cost_bps) -> dict`, `matched_null(picks, candidates, n=200, seed=7) -> list[float]`, `same_day_tracking(scores, returns) -> float`

- **Step 1: Write failing tests**

```python
def test_random_picks_have_no_edge():
    stats = forward_stats(random_picks(seed=1), planted_prices(edge=0.0), universe_of(...), 18)
    assert abs(stats["t"]) < 2

def test_planted_edge_is_found():
    assert forward_stats(top_picks(), planted_prices(edge=0.01), universe_of(...), 18)["t"] > 3

def test_tracking_detects_label_as_score():
    r = make_returns(); assert same_day_tracking(r, r) > 0.99

def test_null_matches_gap_and_liquidity_bucket():
    null = matched_null(picks(), candidates(), n=50)
    assert len(null) == 50 and bucket_mix(null_samples(null)) == bucket_mix(picks())
```

- **Step 2: Run and see them fail**

Run: `pytest tests/test_h3_audit.py -v`. Expected: FAIL, functions not defined.

- **Step 3: Implement the functions and a CLI**

Per-day means first, never pooled. The null samples same-day names from the same gap bucket and ADT decile as each pick.

- **Step 4: Run the audit against production, read-only**

Run: `python -m edge.research.h3_audit --out research/out/h3_audit.json`

The output must include:

- Resolution of all 33 unmatched picks through ISIN and symbol history.
- Separate figures per model version, per ADT tier, and with the top five picks removed.
- Same-day tracking at every date, which fills the null leak check.
- Share of picks at T2T, ASM or a lower band that could not be bought and sold the same day.
- Share of picks where the open equals the high or the low.
- Null percentile at 18, 40 and 60 bps, and breakeven cost.

- **Step 5: Reproduce the known result first**

Expected before any new reading is believed: mean excess within 0.05 percentage points of the design's +0.772% (18 bps, 22 days) on the same 187 picks. A wider gap means investigate before continuing.

- **Step 6: Commit code and output by explicit path; append the verdict to the trial log**

### Task 3: Restatement audit of vendor history

**Files:**
- Create: `src/edge/research/restatement_audit.py`
- Test: `tests/test_restatement_audit.py`
- Output: `research/out/restatement.json`

**Interfaces:**
- Produces: `compare_first_print(history, first_prints, keys, value) -> AuditResult(n, match_rate, sign_flip_rate, median_abs_pct)`, `admit(result) -> bool`

- **Step 1: Write failing tests**

```python
def test_restated_values_are_rejected():
    assert admit(compare_first_print(history(shift=0.08), first_prints(), KEYS, "pat")) is False

def test_identical_values_are_admitted():
    assert admit(compare_first_print(history(shift=0), first_prints(), KEYS, "pat")) is True

def test_too_few_rows_is_not_a_pass():
    assert admit(AuditResult(n=20, match_rate=1.0, sign_flip_rate=0.0, median_abs_pct=0.0)) is False
```

- **Step 2: Run and see them fail**

Run: `pytest tests/test_restatement_audit.py -v`. Expected: FAIL, functions not defined.

- **Step 3: Implement with fixed thresholds**

`admit` requires n >= 500, median absolute difference <= 1%, and sign flips <= 1%.

- **Step 4: Run these comparisons against production, read-only**

| Vendor history | Point-in-time reference |
|---|---|
| Dalalos PAT and revenue | `nse_filing_financials` first prints (2025-10 onward) |
| Dalalos EPS | Bharat Alpha `nse_results` by quarter (2017-2024) |
| `trendlyne_pe_history`, `trendlyne_pb_history` | Daily snapshots in `fundamentals_history` (since 2026-06-30) |
| Mojo shareholding | `nse_shareholding_history` |

Consolidated and standalone statements are compared separately. Expected: one admit or reject per field in `research/out/restatement.json`. **Rejection means the field is unusable before its point-in-time start.** It is not an error to fix.

- **Step 5: Commit by explicit path**

### Task 4: Reach of history

**Files:**
- Create: `src/edge/research/history_probe.py`
- Output: `research/out/history_probe.json`
- Test: `tests/test_history_probe.py`

**Interfaces:**
- Produces: `classify_archive_response(status, body) -> Literal["ok","empty","blocked","missing"]`, `probe(dates) -> dict[int, dict]`

- **Step 1: Write failing tests**

```python
def test_html_error_page_is_not_data():
    assert classify_archive_response(200, b"<html>Access denied</html>") == "blocked"

def test_valid_header_is_data():
    assert classify_archive_response(200, zip_of(b"SYMBOL,SERIES,OPEN")) == "ok"
```

- **Step 2: Run and see them fail**

Run: `pytest tests/test_history_probe.py -v`. Expected: FAIL.

- **Step 3: Implement, and probe one mid-month date per year from 2000 to 2020**

Try known NSE archive names for old-format `cm<DD><MON><YYYY>bhav.csv.zip` and for F&O. Start with no headers. Then download the IIMA factor files, record the latest date, and read the licence.

- **Step 4: Record results**

Expected: per-year status and the earliest usable year; IIMA latest date and terms. If pre-2021 is blocked, raise it with the owner with the per-route breakdown and request a captured browser fetch.

- **Step 5: Commit by explicit path**

### Task 5: Grade H1 and H2 once

**Files:**
- Create: `src/edge/research/h1_slow_core.py`, `src/edge/research/h2_residual_surprise.py`
- Test: `tests/test_h1.py`, `tests/test_h2.py`
- Output: `research/out/h1.json`, `research/out/h2.json`

**Interfaces:**
- Consumes: restatement verdicts from Task 3, history from Task 4, frozen H1 and H2
- Produces: `first_tradeable_session(broadcast_utc, calendar) -> date`, `residual_surprise(actual, forecast) -> float`, `run(hypothesis) -> dict`

- **Step 1: Write failing tests**

```python
def test_after_close_filing_trades_next_session(cal):
    assert first_tradeable_session(ist("2026-10-28 19:50"), cal) == date(2026, 10, 29)

def test_weekend_filing_trades_monday(cal):
    assert first_tradeable_session(ist("2026-10-31 11:00"), cal) == date(2026, 11, 2)

def test_midsession_filing_is_not_same_session(cal):
    assert first_tradeable_session(ist("2026-10-28 11:00"), cal) == date(2026, 10, 29)

def test_planted_drift_is_found_and_shuffled_is_not():
    assert run(synthetic(drift=0.02))["t"] > 3
    assert abs(run(synthetic(drift=0.02), shuffle=True)["t"]) < 1

def test_score_equal_to_label_raises():
    with pytest.raises(LeakDetected):
        run(synthetic(score_is_label=True))
```

- **Step 2: Run and see them fail**

Run: `pytest tests/test_h1.py tests/test_h2.py -v`. Expected: FAIL.

- **Step 3: Implement**

Reuse the legacy `factor_backtest.py` by subprocess for H1's reproduce-first check: `momentum_12_1` at 25 bps/side must land near +0.80%/period vs universe before any new H1 number counts. H2 builds one event per symbol-quarter from the first `broadcast_ts`. Surprise definitions are the frozen ones. ep-v3's forecast must be walk-forward, never in-sample.

- **Step 4: Run each frozen hypothesis once and record every trial**

Run: `python -m edge.research.h1_slow_core` and `python -m edge.research.h2_residual_surprise`. Expected: output JSON carrying n, independent periods, per-tier and per-half results, raw and winsorised t, and shuffled control. Do not change a parameter after seeing a result. A new idea becomes a new hypothesis version and raises the family's trial count.

- **Step 5: Commit by explicit path**

### Task 6: Phase 0 verdict

**Files:**
- Create: `docs/phase0-verdict.md` in the new repo
- Modify: `docs/audit-findings.md` in this repo, row AF-20261104-03 only, re-read first
- Modify: `.claude/rules/measurement.md` in this repo with a dated subsection

- **Step 1: Write the verdict with a fixed decision rule**

| Result | Decision |
|---|---|
| H1, H2 or H3 passes | Build the full plan; failing ones stay in the Evidence table |
| None passes but H4 or H10 can be measured as useful | Build Phase 1 only, as a research and risk tool with no calls |
| Nothing passes and the owner agrees | Stop building, keep the frozen tests running, and record the outcome |

- **Step 2: Verify**

Run: `npm run findings:check` and `npm run backlog:check` from this repo. Expected: both pass.

- **Step 3: Ask the owner to read the verdict before Phase 1 starts**

---

## Phase 1: kernel and walking skeleton

Begins only after the owner has read the Phase 0 verdict. Port from `bharat_alpha` where a task says so. Read the donor code and its tests first. A port still starts with a failing test here.

### Task 7: Database, safety and clock

**Files:**
- Create: `src/edge/db.py`, `src/edge/clock.py`, `migrations/0001_core.sql`, `tests/conftest.py`
- Test: `tests/test_db_safety.py`, `tests/test_clock.py`, `tests/test_static_bans.py`

**Interfaces:**
- Produces: `connect() -> Connection`, `to_db(value) -> value | None`, `migrate(conn) -> list[str]`, `logical_session(now_utc) -> date`, `is_session(d) -> bool`, `next_session(d) -> date`, `sessions_between(a, b) -> int`, `expected_data_state(d) -> Literal["session","holiday","unknown"]`

- **Step 1: Write failing tests**

```python
def test_test_db_must_be_named_test(monkeypatch):
    monkeypatch.setenv("EDGE_TEST_DATABASE_URL", "postgresql://x/bharat_intel")
    with pytest.raises(UnsafeDatabase): test_connect()

def test_nan_becomes_null():
    assert to_db(float("nan")) is None and to_db(float("inf")) is None

def test_after_midnight_run_keeps_prior_session():
    assert logical_session(ist("2026-11-04 01:30")) == date(2026, 11, 3)

def test_migration_applies_every_statement(empty_db):
    migrate(empty_db)
    assert table_exists(empty_db, "schema_migration") and table_exists(empty_db, "pipeline_run")

def test_no_date_today_or_zero_fill_in_source():
    assert scan("src/edge", [r"date\.today\(", r"fillna\(0", r"float\(\w+ or 0"]) == []

def test_holiday_is_not_an_outage(cal):
    assert expected_data_state(date(2026, 11, 8)) == "holiday"
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_db_safety.py tests/test_clock.py tests/test_static_bans.py -v`. Expected: FAIL.

- **Step 3: Implement**

`migrate` executes each file statement by statement and checks the expected objects afterward. The legacy runner once applied only a file's first statement and still recorded success. Past calendar comes from bhavcopy existence; the future comes from the published NSE holiday list.

- **Step 4: Run all tests against an empty `edge_test`**

Expected: PASS. Then commit by explicit path.

### Task 8: Raw vault and source contract

**Files:**
- Create: `src/edge/vault.py`, `contracts/sources.yaml`, `migrations/0002_vault.sql`
- Test: `tests/test_vault.py`

**Interfaces:**
- Produces: `store(source, url, status, body, fetched_at) -> payload_id`, `classify(source, status, body) -> Literal["ok","empty","error_envelope","blocked"]`, `check_max_business_date(source, parsed_max, today) -> None` raises `StaleSource`

- **Step 1: Write failing tests**

```python
def test_same_body_is_stored_once_with_each_fetch_logged(db): ...
def test_payload_rows_cannot_be_updated(db):
    pid = store("x", "u", 200, b"a", NOW)
    with pytest.raises(Exception): db.execute("update raw_payload set body='b' where id=%s", (pid,))
def test_error_envelope_with_200_is_not_ok():
    assert classify("niftytrader", 200, b'{"result":0,"resultMessage":"Unauthorized"}') == "error_envelope"
def test_well_formed_frozen_source_raises():
    with pytest.raises(StaleSource):
        check_max_business_date("nse_results", date(2024,12,31), date(2026,11,4))
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_vault.py -v`. Expected: FAIL.

- **Step 3: Implement**

Bodies are gzip files on disk under a content-hash path; the table holds metadata. Add a trigger that rejects `UPDATE`.

- **Step 4: Run, pass and commit by explicit path**

### Task 9: Reference and identity

**Files:**
- Create: `src/edge/reference.py`, `migrations/0003_reference.sql`
- Port from: `bharat_alpha/src/bharat_alpha/reference/__init__.py`, including its rename tests
- Test: `tests/test_reference.py`

**Interfaces:**
- Produces: `resolve(symbol, as_of) -> int | None`, `symbol_on(instrument_id, as_of) -> str`, `provider_id(instrument_id, provider) -> str | None`, `universe(as_of, tier=None) -> list[int]`, `tier_of(instrument_id, as_of) -> Literal["FNO","ADT_50CR","ADT_10CR","ADT_5CR","ADT_1CR","BELOW"]`

- **Step 1: Write failing tests**

```python
def test_rename_is_one_instrument(db):
    assert resolve("TATAMOTORS", date(2024,1,2)) == resolve("TMPV", date(2026,1,2))

def test_dead_name_is_in_the_past_universe(db):
    assert dead_id in universe(date(2022,1,3)) and dead_id not in universe(date(2026,1,2))

def test_no_lookahead_in_liquidity_tier(db):
    assert tier_of(iid, D) == tier_of_recomputed_without_rows_after(iid, D)

def test_provider_key_includes_provider(db):
    add_provider_id(1, "tl", "533"); add_provider_id(2, "mc", "533")
    assert provider_id(1, "tl") == "533" and provider_id(2, "mc") == "533"

def test_no_module_builds_a_universe_itself():
    assert scan("src/edge", [r"from\s+instrument\b(?!.*reference)"], exclude="reference.py") == []
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_reference.py -v`. Expected: FAIL.

- **Step 3: Implement by porting and adapting**

- **Step 4: Run, pass and commit by explicit path**

### Task 10: Bhavcopy, adjustments and suspect bars

**Files:**
- Create: `src/edge/sources/nse_bhavcopy.py`, `src/edge/marketdata.py`, `migrations/0004_bars.sql`
- Port from: `bharat_alpha` `ingest/sources/nse_bhavcopy.py`, `nse_pr.py`, the adjustment and suspect logic, and `test_sim_ingest_split_rename_badprint_delist`
- Test: `tests/test_bars.py`, `tests/live/test_live_bhavcopy.py`

**Interfaces:**
- Consumes: `vault.store`, `reference.resolve`
- Produces: `ingest(session) -> IngestResult`, `load_panel(start, end, knowable_by) -> Panel`

- **Step 1: Write failing tests**

```python
def test_split_is_not_a_minus_50_percent_day(): ...
def test_bad_print_is_flagged_not_treated_as_action(): ...
def test_unresolved_demerger_masks_the_name_instead_of_a_fake_return():
    panel = load_panel(D0, D2, knowable_by=D2)
    assert np.isnan(panel.ret_1d.loc[D1, seam_id])
def test_delisted_name_exits_at_last_close(): ...
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_bars.py -v`. Expected: FAIL.

- **Step 3: Implement by porting and adapting**

- **Step 4: Backfill and verify against live data**

Run: `python -m edge.sources.nse_bhavcopy --start 2021-01-01`, then the live test with `RUN_LIVE_DATASOURCE_TESTS=1`. Expected: about 1,443 session dates through 2026-11-03, and closes matching `nse_universe_history` for a sample of 1,000 name-dates, with every mismatch explained.

- **Step 5: Commit by explicit path**

### Task 11: Semantic contracts

**Files:**
- Create: `contracts/fields.yaml`, `contracts/metrics.yaml`, `contracts/decisions.yaml`, `src/edge/semantic.py`, `scripts/generate_context.py`
- Test: `tests/test_semantic.py`

**Interfaces:**
- Produces: `field(name) -> FieldContract`, `validate(name, value) -> None`, `ddl_checks() -> list[str]`, `monitors() -> list[Monitor]`, `generate_context(out_dir) -> None`

- **Step 1: Write failing tests**

```python
def test_field_requires_clocks_and_a_consumer():
    with pytest.raises(ContractError): parse_field({"field": "x", "unit": "INR"})
def test_out_of_range_value_is_rejected():
    with pytest.raises(ContractError): validate("rsi_14", 4_090_000)
def test_every_table_column_has_a_contract(db):
    assert uncovered_columns(db) == []
def test_context_is_generated_not_edited():
    assert generated_context() == read_committed_context()
def test_decision_enums_have_no_conviction():
    assert "conviction" not in decision_contract().fields
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_semantic.py -v`. Expected: FAIL.

- **Step 3: Implement with PyYAML and dataclasses**

Do not add a graph store or a framework.

- **Step 4: Run, pass and commit by explicit path**

### Task 12: Facts store and `as_of`

**Files:**
- Create: `src/edge/facts.py`, `migrations/0005_facts.sql`
- Test: `tests/test_facts.py`

**Interfaces:**
- Consumes: `semantic.validate`, `clock`
- Produces: `write_fact(instrument_id, field, event_time, published_at, value, source, payload_id) -> bool`, `as_of(fields, instruments, knowable_by, mode: Literal["live","backtest"]) -> DataFrame`

- **Step 1: Write failing tests**

```python
def test_future_fact_changes_no_past_view(db):
    before = as_of(F, I, D, "backtest"); write_future_fact(after=D)
    assert_frame_equal(before, as_of(F, I, D, "backtest"))

def test_first_seen_never_changes_on_refetch(db):
    write_fact(...); s = seen(); write_fact(...same...)
    assert seen() == s

def test_restatement_is_a_new_revision_and_signals_keep_first_print(db):
    write_fact(value=100, ...); write_fact(value=120, ...)
    assert as_of(["pat_q"], I, LATER, "live").iloc[0].pat_q == 100

def test_live_mode_uses_first_seen_backtest_uses_published_plus_lag(db): ...

def test_update_is_rejected(db):
    with pytest.raises(Exception): db.execute("update fact set value=1")
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_facts.py -v`. Expected: FAIL.

- **Step 3: Implement with one insert-only `fact` table**

Key: `(instrument_id, field, event_time, source, revision)`. `first_seen_at DEFAULT now()`.

- **Step 4: Run, pass and commit by explicit path**

### Task 13: Filing clock

**Files:**
- Create: `src/edge/sources/nse_results.py`
- Port from: `bharat_alpha` `nse_results` and legacy filing fetcher payload shapes
- Test: `tests/test_filings.py`, `tests/live/test_live_results.py`

**Interfaces:**
- Consumes: `facts.write_fact`, `vault.store`, `clock.next_session`
- Produces: `ingest(session) -> IngestResult`, `first_tradeable_session(broadcast_utc) -> date`

- **Step 1: Write failing tests**

```python
def test_after_close_and_weekend_filings_trade_next_session(): ...
def test_first_broadcast_wins_for_a_symbol_quarter(): ...
def test_original_is_preferred_over_revised_for_signals(): ...
def test_consolidated_and_standalone_are_separate_facts(): ...
def test_null_payload_for_one_symbol_keeps_the_rest_of_the_batch(): ...
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_filings.py -v`. Expected: FAIL.

- **Step 3: Implement, then run the live test with `RUN_LIVE_DATASOURCE_TESTS=1`**

Expected: newest `broadcast_ts` within the source's staleness limit.

- **Step 4: Commit by explicit path**

### Task 14: One harness and the cost model

**Files:**
- Create: `src/edge/research/harness.py`, `src/edge/costs.py`, `src/edge/research/null_books.py`
- Port from: `bharat_alpha` `evaluation/metrics.py`, `evaluation/backtest.py`, `sim.py`; legacy `paper_book.py` null logic
- Test: `tests/test_harness.py`, `tests/test_costs.py`

**Interfaces:**
- Consumes: `marketdata.load_panel`, `reference.universe`
- Produces: `grade(scores, protocol) -> Verdict`, `backtest(weights, panel, cost_model) -> BacktestResult`, `null_percentile(book, n=200, seed=7) -> float`, `round_trip_bps(trade_type, participation, adt_inr) -> float`

- **Step 1: Write failing tests**

```python
def test_planted_edge_passes_and_noise_fails(): ...
def test_overlap_is_corrected():
    assert grade(daily_scores_h21(n_dates=42), P).independent_periods == pytest.approx(2, abs=0.1)
def test_winsorize_clips_a_lone_outlier(): ...
def test_median_beater_is_flagged(): ...
def test_label_as_score_raises_leak(): ...
def test_all_entries_marked_to_market_not_closed_only(): ...
def test_raw_and_winsorised_t_are_both_returned(): ...
def test_higher_participation_costs_more():
    assert round_trip_bps("delivery", 0.05, 1e8) > round_trip_bps("delivery", 0.01, 1e8)
def test_reproduces_legacy_momentum(real_panel):
    assert grade_momentum_12_1(real_panel).net_excess_per_period == pytest.approx(0.0080, abs=0.0030)
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_harness.py tests/test_costs.py -v`. Expected: FAIL.

- **Step 3: Implement by porting and adapting**

Statutory rates are taken from `indian_market_costs.py` and checked against the current Finance Act before use. Slippage is an explicit assumption until fills exist.

- **Step 4: Negative-control one test**

Remove the overlap correction, confirm `test_overlap_is_corrected` fails, and restore it.

- **Step 5: Run, pass and commit by explicit path**

### Task 15: Decision table and the brief

**Files:**
- Create: `src/edge/decisions/publish.py`, `src/edge/brief/brief.py`, `migrations/0006_decision.sql`
- Test: `tests/test_decisions.py`, `tests/test_brief.py`

**Interfaces:**
- Consumes: `semantic`, `clock`, `monitors`, `sleeves` gate state (empty in this phase)
- Produces: `publish(as_of, rows, state, reason) -> int`, `render(as_of) -> str`, `send(as_of) -> DeliveryReceipt`

- **Step 1: Write failing tests**

```python
def test_no_allowed_sleeve_means_no_trade_state(db):
    assert publish_today(db).state == "NO_TRADE"

def test_call_from_unallowed_sleeve_is_rejected(db):
    with pytest.raises(GateClosed): publish(D, [row(sleeve="H3", gate="PAPER")], "CALLS", "x")

def test_stale_input_gives_degraded_brief_that_still_sends(db, fake_telegram):
    make_bars_stale(db); r = send(D)
    assert r.delivered and "DEGRADED" in r.text and stale_source_name in r.text

def test_every_number_in_brief_has_n_and_date(db): ...

def test_rate_limit_is_retried_and_failure_is_an_incident(fake_telegram): ...
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_decisions.py tests/test_brief.py -v`. Expected: FAIL.

- **Step 3: Implement**

One decision table with one writer. A rerun replaces that `(as_of, sleeve)` set. The brief states what the system has proven, which on day one is nothing, and says so plainly.

- **Step 4: Run, pass and commit by explicit path**

### Task 16: Pipeline, release and live readback

**Files:**
- Create: `src/edge/pipeline/dag.py`, `src/edge/pipeline/steps.py`, `deploy/edge-pipeline.service`, `deploy/release.sh`
- Port from: `bharat_alpha` step ledger and advisory lock
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: every ingest and publish function above
- Produces: `Step(name, needs, run, assert_output)`, `run_session(session) -> RunReport`, `status() -> SystemStatus`

- **Step 1: Write failing tests**

```python
def test_step_with_failed_output_assertion_is_failed_not_success(): ...
def test_downstream_runs_in_degraded_mode_when_upstream_failed(): ...
def test_concurrent_runs_of_one_session_cannot_overlap(db): ...
def test_rerun_is_idempotent(db): ...
def test_catch_up_after_outage_does_not_skip_the_missed_session(db): ...
def test_holiday_is_recorded_as_holiday_not_success(db): ...
```

- **Step 2: Run them to fail**

Run: `pytest tests/test_pipeline.py -v`. Expected: FAIL.

- **Step 3: Implement steps in order**

Vault, bars, filings, monitors, publish, then brief at 08:30 IST. Keep it sequential. A release is a git tag checked out to its own directory.

- **Step 4: Deploy to the chosen host from a tag**

Until D3 is decided, run on the current host under a separate database `bharat_edge`, without touching legacy services.

- **Step 5: Verify against live results for 5 consecutive sessions**

```sql
SELECT as_of, state, reason FROM decision_run ORDER BY as_of DESC LIMIT 5;
SELECT session, step, status, output_rows FROM pipeline_run WHERE session = '<today>';
```

Expected: 5 sessions, each with a delivered Telegram brief before 08:45 IST, and the decision state matching the message. **The Phase 1 exit test is these readbacks, not a green suite.**

- **Step 6: Update the ledger row and the session log; ask the owner to review before Phase 2**

---

## Self-review notes

- **Spec coverage.** Semantic layer: Task 11. Three clocks: Task 12. Mistake mechanisms: Tasks 7-16, with remaining ones (monitors replayed against history, seeds, portfolio caps) falling in Phases 2-5, which get their own plans.
- **Deliberately not task-level yet.** Phases 2-7, because Phase 0 and Phase 3 outcomes decide them.
- **Proportion.** Bodies are left to the implementer. Test skeletons marked `...` take their assertion from the test name and the spec section it cites.
