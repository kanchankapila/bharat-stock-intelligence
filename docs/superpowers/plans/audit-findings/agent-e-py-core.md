## Findings

- `src/server/ml_ensemble.py:2636-2659` | **SILENT** | `--dry-run` is only wired to `incremental_update()`; the default CLI path (`do_train`/`do_score`, hit whenever `--incremental` isn't also passed) never reads `args.dry_run`, so `python ml_ensemble.py --dry-run` silently runs a full production train+score — it calls `save_ensemble()` (writes `model_registry` + the `ensemble.pkl` artifact) and `score_pending()` (writes live `win_probability`) despite the operator explicitly asking for a dry run. | Thread `dry_run` into `run()`/`do_train`/`do_score` (or reject `--dry-run` without `--incremental` with an error) so the flag actually prevents writes.
- `src/server/backtest_optimizer.py:136-138` | **SILENT** | `run_grid_search()` unconditionally executes `DELETE FROM backtesting_runs WHERE run_name LIKE 'opt_%'` + `conn.commit()` *before* the `if dry_run:` check at line 156 — a `--dry-run` invocation still deletes rows from `backtesting_runs`. | Move the cleanup DELETE inside the `if not dry_run:` branch (or skip it entirely in dry-run mode).
- `src/server/unified_ranker.py:468-531` | **SILENT** | `_get_ml_scores`, `_get_cs_scores`, `_get_confluence_scores`, `_get_technical_scores`, `_get_dl_scores`, `_get_rl_gate_map` each swallow *any* exception (typo, dropped column, broken join) and return `{}`/`0.0` with zero logging — contrast with `_get_screener_membership` at line 432, which has an explicit comment ("Do NOT swallow silently…") and prints the error. A broken query in any of these components (which feed the blended win_probability/ranking) degrades to a neutral/empty contribution with no signal anywhere that it happened. | Add the same `print(f"... failed: {e}")` before `self.conn.rollback(); return {}` used at line 437, at minimum for the win-probability/ML/confluence/DL fetchers.
- `src/server/reward_engine.py:135-143` (`update_weights`) | **MINOR** (perf, borderline correctness) | The main loop issues 2 individual `SELECT` queries per resolved-outcome row (`_get_regime`, `_get_sector`) with no default `--days` cutoff, over the full `signal_outcomes ∪ unified_signal_outcomes` history (tens of thousands of rows observed live). `python reward_engine.py --dry-run` hung >150s producing zero output even after the "Processing N outcomes..." print should have fired, consistent with this N+1 pattern; in a cron context this risks silently timing out and never updating `signal_type_weights` (the multipliers `scoring_engine.py` reads at startup go stale). | Batch-fetch regime/sector via a single JOIN or `IN (...)` lookup instead of per-row queries; default to a bounded `--days` window.
- `src/server/strategy_optimizer.py:317-324` | **MINOR** | Bare `except:` around a fire-and-forget `requests.post` notification call — swallows everything including `KeyboardInterrupt`/`SystemExit`, but the fallback (skip the notification) is harmless since it's not on the scoring path. | Narrow to `except requests.RequestException:` for hygiene; not urgent.
- `src/server/scoring_engine.py:444-472` | **MINOR** | The `news_sentiment_items` load falls back to the legacy `news_articles` table on *any* exception (not just "table missing"), setting `sentiment_score=1.0` and `impact='MEDIUM'` for every article — if the new-table query fails for an unrelated reason (e.g., a transient connection error) every article silently gets maximum sentiment weight instead of being skipped. | Catch a narrower exception (e.g. table/column not found) rather than blanket `Exception`.

No division-by-zero bugs, no bare `except:` swallowing dangerous defaults (0.5-probability, etc.), and no rogue `sqlite3`/`psycopg2` imports were found in the rest of the slice — the divisions traced (`outcome_resolver.py` ATR/volatility calcs, `screener_performance.py` win-rate/Sharpe, `unified_ranker.py` position sizing/classification, `oi_delta_features.py`, `drift_detector.py` PSI) are all properly guarded with `if x > 0` / `len(...) < N: continue` / `.replace(0, np.nan)` immediately upstream.

## Smoke-import results (58/58 files)

All 58 files in the slice import cleanly (exit 0). Two are slow due to heavy runtime init and needed >60s: `nlp_engine.py` (transformer model load) and `scoring_engine.py` (DB engine + weight bootstrap) — both eventually PASS, not failures. `dl_engine.py` also takes ~15-20s (CUDA device init) but passes reliably.

## Dry-run results (10 files with `--dry-run`)

| File | Result |
|---|---|
| `daily_ml_update.py` | OK — prints planned sub-commands, no writes |
| `intraday_features.py` | OK — completes, updates in-memory only |
| `live_screener_resolver.py` | OK — prints `[DRY]` lines, no writes |
| `online_learner.py` | OK — skips update/scoring as expected |
| `outcome_resolver.py` | OK — prints `[DRY]` resolutions, no writes |
| `rl_agent.py` | OK — no episodes, no-op |
| `strategy_optimizer.py` | OK — computes weights, correctly skips save |
| `backtest_optimizer.py` | Runs a real 300-combo grid search (slow, by design) but **mutates DB before the dry-run check** (see finding above) |
| `finbert_scorer.py` | Slow (FinBERT model load + inference on up to 500 articles) but correctly gates the DB write — not a bug, just exceeded the 90s probe window |
| `ml_ensemble.py` | **Does not respect `--dry-run` at all** without `--incremental` — runs a full train+write (see finding above) |
