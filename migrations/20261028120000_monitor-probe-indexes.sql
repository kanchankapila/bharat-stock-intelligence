-- Freshness/status probes aggregate these columns every 15 minutes; with no index each one was a
-- full scan (pg_stat_statements 2026-10-28: 1.4-47s per call, ~3h of DB time a day in total).
-- All are append-mostly tables, so the extra write cost is one small btree insert per row.
-- Plain CREATE INDEX holds a SHARE lock (writes wait): apply outside market hours.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20min';
CREATE INDEX IF NOT EXISTS idx_sout_source_horizon_computed ON signal_outcomes(signal_source, horizon_days, computed_at);
CREATE INDEX IF NOT EXISTS idx_nt_live_screener_captured_at ON niftytrader_live_screener_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_isfs_fetched_date ON investsights_factor_scores(fetched_date);
CREATE INDEX IF NOT EXISTS idx_mcgm_source_fetched_at ON mc_general_metrics(source_api, fetched_at);
CREATE INDEX IF NOT EXISTS idx_mojo_fin_hist_fetched_at ON marketsmojo_financials_history(fetched_at);
CREATE INDEX IF NOT EXISTS idx_mover_snapshots_trade_date ON mover_snapshots(trade_date);
CREATE INDEX IF NOT EXISTS idx_tl_pb_hist_fetched_at ON trendlyne_pb_history(fetched_at);
CREATE INDEX IF NOT EXISTS idx_tl_pe_hist_fetched_at ON trendlyne_pe_history(fetched_at);
CREATE INDEX IF NOT EXISTS idx_mde_available_at ON market_decision_evidence(available_at);
CREATE INDEX IF NOT EXISTS idx_lsml_scores_computed_at ON live_screener_ml_scores(computed_at);
CREATE INDEX IF NOT EXISTS idx_news_articles_timestamp ON news_articles("timestamp");
CREATE INDEX IF NOT EXISTS idx_isfh_fetched_date ON investsights_fundamentals_history(fetched_date);
CREATE INDEX IF NOT EXISTS idx_mdev_created_at ON market_decision_event(created_at);
CREATE INDEX IF NOT EXISTS idx_signal_excursions_computed_at ON signal_excursions(computed_at);
