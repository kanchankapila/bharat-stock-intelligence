---
description: Find every monitor, gate and alarm whose verdict never varies, and every threshold constant applied to data it was never calibrated on — the class where a detector sits below its own data's noise floor, fires 16/16, and silently multiplies a real haircut into live scores
---

# Threshold Calibration Audit

The master rule in this project's memory index is "no metric is accurate until reverse-engineered
against live data," and the incident that produced it is a threshold: `drift_detector.py` fired
`EMERGENCY_RETRAIN` on **16 of 16** historical evaluation points spanning 14 months, in every
market condition on record. `PSI_CRIT=0.25` was the credit-scoring convention for stable
demographic features, borrowed unmeasured and applied to z-scored financial series whose measured
per-feature PSI null on this panel is p50=0.53 / p90=2.71 / p95=3.60. The alarm sat below its own
data's noise floor, so it could never *not* fire.

**The damage was never the log line.** The permanent haircut multiplied a calibrated,
isotonic-fit probability and fed hard thresholds in `scoring_engine.apply_ml_score_adjustment` —
every symbol truly in [0.55, 0.647] silently lost a bonus it had earned. A monitor that always
fires carries zero information, and anything downstream consuming it is reading a constant.

Distinct from `/ml-promotion-gate-review` (champion/challenger comparison and CV construction) and
from `/data-coverage-audit` (whether a check exists at all). This one asks whether the checks that
exist can ever change their mind.

## 1. Find every verdict that never varies

`psql` is not on PATH here — run SQL via `backend-python/venv` + psycopg2 with `POSTGRES_URL` from
`.env` (recipe in the `weekend-audit` skill's Lane 4), or a `tsx` script that imports
`dotenv/config`. Without dotenv a `tsx` script silently reads dev SQLite and prints convincing
numbers from the wrong database.

The signature is one row:

```sql
SELECT status, count(*) FROM data_quality_results GROUP BY 1;
```

`data_quality_results` is PK'd on `check_id` and overwritten each run, so that table alone cannot
answer the question. Use `data_quality_history` (append-only, added 2026-08-15) — a check with one
distinct status across many runs is the finding:

```sql
SELECT check_id, count(*) AS runs, count(DISTINCT status) AS distinct_status,
       min(status) AS always
FROM data_quality_history GROUP BY 1 HAVING count(*) > 5 AND count(DISTINCT status) = 1
ORDER BY runs DESC;
```

Until that table has depth, corroborate from `job_heartbeat` and from any results table an engine
writes its own verdicts into:

```sql
SELECT job_name, run_count, fail_count FROM job_heartbeat
WHERE run_count > 10 AND (fail_count = 0 OR fail_count = run_count);
```

`fail_count = run_count` is a job failing every time behind a monitor nobody reads.
`fail_count = 0` over hundreds of runs is a check that may be incapable of failing — investigate
which, don't assume health.

For every engine writing a status/verdict column (`model_registry`, drift results, regime labels,
promotion decisions), run the same `GROUP BY status` over its own history. **One row is the
finding.**

## 2. Replay the detector over history

For any monitor with a threshold, the only real test is: what does it say when nothing is wrong?
Replay it over the deepest history available and look at the distribution of its own verdicts.
A detector that discriminates looks like 75% OK / 25% WARNING / 0% EMERGENCY. A detector at
16/16 — or at 0/16 — is the same defect in two directions.

**Measure the null before trusting OR fixing a threshold**, and re-replay after recalibrating.
Moving a constant until the alarm stops firing is not a fix; it is the identical defect inverted.

## 3. Constants with no recorded derivation

```bash
grep -rnE "^[A-Z_]{3,}\s*=\s*[0-9.]+" src/server/*.py | grep -v "#"
```

For each: is there a comment recording where the number came from? A round industry-convention
number (0.25, 0.05, 0.8) applied to this panel's data with no measured derivation is a finding
even if the monitor currently behaves — it will drift into the noise floor as the data changes.
The recalibrated `drift_detector.py` is the shape to look for:

```python
PSI_WARN    = 2.70   # measured p90 of the per-feature null
PSI_CRIT    = 3.60   # measured p95 of the per-feature null
```

## 4. One constant thresholding two different statistics

The compounding sibling in the same file: `PSI_CRIT` gated both a **per-feature** PSI and
`drift_score` (the *mean* across features, a quantity on a different scale, measured null
0.647–1.477). The 0.85× haircut was therefore unconditional on every run ever made.

Grep each threshold constant for all its use sites. If it compares against two quantities that are
not the same statistic — a per-item value and an aggregate, a raw score and a normalised one — at
most one of the two can be correctly calibrated.

## 5. Extreme-value statistics against a per-item bar

The third sibling: after recalibration the `WARNING` tier was *still* 16/16 because it keyed off
`max_psi > PSI_WARN`, and the max of ~62 correlated features is an extreme-value statistic that
trips against essentially any per-feature bar. Any threshold applied to a `max()`/`min()` over
many correlated series needs its own calibration, not the per-item one.

## 6. Bare-count triggers

A check firing on `count > 0` fails on correct data: `stock_delivery_data.trades = delivery_qty` is
legitimately true for an illiquid name (4 shares in 4 trades). Compare a **share of rows** against
a floor sized to the real defect's measured magnitude — the actual incident was 100% of 664,006
rows, so a 5% floor has enormous margin. A check that cries wolf on real data stops being read.

## 7. Trace what consumes the verdict

For every always-firing or never-firing monitor found above, grep every reader of its output
column before writing the report. The finding is not "the log line is wrong" — it is whatever
downstream multiplier, veto, gate or score adjustment has been reading a constant. That is the
part that belongs in the report's first line, and per `measurement.md` it usually means the fix
is a scoring-affecting change needing backtest evidence, not a one-line constant edit.

## 8. Report

Per monitor: its measured verdict distribution over history, what its threshold was calibrated
against (or that it wasn't), every downstream consumer of the verdict, and the measured null it
should be re-anchored to. Recalibration is not done until the detector has been re-replayed and
shown to *discriminate*.
