"""
Data cards — table-level documentation.

A card is the shortest honest answer to "can I use this table, and how?". It carries the
facts that live nowhere in the database: the grain, who writes it, how stale it should be,
the traps, and — most importantly — the **training-use verdict** together with the columns
that must never be features.

`expected_lag_hours` is measured from the event a row describes to the earliest time the row
should exist (post-market bhavcopy ≈ 5h after the close; NSE delivery data is T+1; intraday
snapshots ≈ 30 minutes). It is a SERVICE-LEVEL EXPECTATION, not a measurement of actual
freshness — `introspect.freshness()` measures the real thing against the live database, and
the generated `coverage.json` reports both so the gap between intent and reality is visible.
"""
from typing import Tuple

from ..model import DataCard


def _c(table: str, label: str, entity: str, pk: tuple, description: str, *,
       grain: str = "", cadence: str = "daily", fresh: str = None, lag: float = None,
       writers: tuple = (), caveats: tuple = (), use: str = "allowed",
       forbidden: tuple = ()) -> DataCard:
    """Compact card constructor, so each card's shape stays visible in the file."""
    return DataCard(
        table=table, label=label, entity=entity, grain=grain or "(" + ", ".join(pk) + ")",
        pk=tuple(pk), description=description, cadence=cadence, freshness_column=fresh,
        expected_lag_hours=lag, writers=tuple(writers), caveats=tuple(caveats),
        training_use=use, forbidden_columns=tuple(forbidden),
    )


def cards() -> Tuple[DataCard, ...]:
    return (
        _c("stock_ohlcv", "Daily OHLCV bars", "Bar", ("symbol", "date"),
           "One daily OHLCV bar per symbol per session. The platform's only self-owned "
           "source of truth and the basis of every return calculation.",
           cadence="per_session", fresh="date", lag=5.0, use="caution",
           writers=("nse_bhavcopy_fetcher.py", "bse_bhavcopy_fetcher.py"),
           forbidden=("is_suspect",),
           caveats=("Price basis is per ROW, in `adjustment_basis` "
                    "(nse_bhavcopy_raw / split_only / split_dividend). Mixing bases inside "
                    "one series corrupts a backtest silently.",
                    "Suspect bars are flagged, not deleted: filter `is_suspect = 0` before "
                    "building a panel, and read `suspect_reason` rather than imputing.")),

        _c("intraday_ohlcv", "Intraday bars", "IntradayBar",
           ("symbol", "datetime", "interval"),
           "Sub-daily OHLCV with VWAP for a single interval (15m) over recent history.",
           cadence="intraday_15m", fresh="datetime", lag=0.5,
           writers=("intraday_fetcher.py",),
           caveats=("History is shallow next to the daily panel — not a substitute for "
                    "`stock_ohlcv` in any long-horizon study.",)),

        _c("stock_delivery_data", "Daily delivery data", "DeliveryObservation",
           ("symbol", "date"),
           "Deliverable quantity as a share of traded quantity: the platform's highest-"
           "frequency ownership proxy, published T+1 by the exchange.",
           cadence="daily_t_plus_1", fresh="updated_at", lag=24.0, use="allowed",
           writers=("stock_delivery_fetcher.py",),
           caveats=("T+1 by construction: no signal dated the same session can have used it.",
                    "A sibling table (`stock_delivery_volume`) carries the same concept with "
                    "different column names and different series coverage.")),

        _c("stock_delivery_volume", "Delivery volume (series-level)", "DeliveryObservation",
           ("symbol", "date", "series"),
           "Delivery and traded quantity broken out by NSE trading series.",
           cadence="daily_t_plus_1", fresh="fetched_at", lag=24.0, use="caution",
           writers=("stock_delivery_fetcher.py",),
           caveats=("Series-level grain: summing across series double-counts a symbol that "
                    "trades in more than one.",)),

        _c("stock_master", "Instrument master", "Equity", ("symbol",),
           "One row per exchange ticker with its ISIN and every vendor-private id the "
           "platform uses to reach that instrument at each provider.",
           cadence="on_change", use="context",
           writers=("sync_stock_master.ts", "syncAllStockMappings.ts"),
           caveats=("Keyed on TICKER, not ISIN: a company listed on both NSE and BSE is two "
                    "rows here and one instrument elsewhere.",
                    "The vendor id columns (mcsymbol, tlid, companyid, tickertape_sid, "
                    "scripcode, fincode) are private to their providers — joining one "
                    "vendor's id to another's is a defect, not a join.",
                    "`sector` was EMPTY for every row as of 2026-09-21; sector arrives "
                    "downstream on the signal tables instead.")),

        _c("company_profiles", "Company profile", "CompanyProfile", ("symbol",),
           "Vendor narrative and high-level growth attributes for the issuer.",
           cadence="on_change", fresh="last_updated", use="caution",
           writers=("company_profile_fetcher.py",),
           caveats=("`description` is vendor free text, and `growth_score` / `ai_analysis` "
                    "are derived — neither is an observation.",)),

        _c("corporate_actions", "Corporate actions", "CorporateAction",
           ("symbol", "ex_date", "action_type"),
           "Dividends, splits, bonuses and rights with their ex/record dates — the anchor "
           "for price adjustment and event-aware risk filtering.",
           cadence="event_driven", fresh="ingested_at", use="allowed",
           writers=("mc_corporate_actions_fetcher.py",
                    "investsights_corporate_actions_fetcher.py"),
           caveats=("The table also carries `Quarterly Results` rows, which are not capital "
                    "actions at all — filter `action_type` before computing an adjustment "
                    "factor or an event count.",)),

        _c("fundamentals_history", "Fundamental snapshots", "FundamentalSnapshot",
           ("symbol", "as_of_date"),
           "Dated snapshots of accounting ratios, market cap and the Piotroski score.",
           cadence="vendor_periodic", fresh="captured_at", use="caution",
           writers=("trendlyne_fundamentals_fetcher.py",
                    "investsights_fundamentals_fetcher.py"),
           caveats=("Vendor restatements mean re-fetched history differs from what was "
                    "knowable at the as-of date; only the captured row is point-in-time "
                    "honest.",
                    "Vendor-derived ratios of undocumented derivation — NOT the same objects "
                    "as XBRL-tagged filings (see standards.py).")),

        _c("analyst_estimates_history", "Analyst estimate snapshots", "AnalystEstimate",
           ("symbol", "as_of_date"),
           "Consensus rating counts, target prices and next-period estimates captured per "
           "as-of date: one of the few genuinely leading datasets here.",
           cadence="vendor_periodic", fresh="captured_at", use="caution",
           writers=("trendlyne_analyst_targets_fetcher.py",),
           caveats=("`buy_count` / `sell_count` count ANALYSTS; they share count properties "
                    "with screener counts and must never be summed with them.",
                    "The revision trio derived from this table is not yet graded.")),

        _c("eps_surprise_history", "Earnings surprises", "EarningsSurprise",
           ("symbol", "quarter"),
           "Actual versus estimated profit and revenue per quarter, with the surprise "
           "computed per line.",
           cadence="vendor_periodic", fresh="fetched_at", use="caution",
           writers=("eps_surprise_fetcher.py",),
           caveats=("Keyed by vendor `scid` alongside `symbol`; the scid route runs through "
                    "`mc_scid_map`. Keep both when joining.",
                    "`quarter` is a fiscal label (Q2FY26), not a date — sequencing it as a "
                    "string sorts incorrectly across a year boundary.")),

        _c("insider_trades", "Insider transactions", "InsiderTransaction",
           ("symbol", "date_iso", "acquirerName"),
           "Promoter and insider buy/sell filings with quantity, rupee value and the "
           "percentage of capital transacted.",
           cadence="event_driven", use="caution",
           writers=("moneycontrol_fetcher.py",),
           caveats=("Filed with a lag: treat the filing date as the earliest knowable time, "
                    "not the trade date.",
                    "Graded WEAK standalone on this platform (net flow not significant) — "
                    "retained as a confluence input only.",
                    "`valueInr` is rupees as a bare number with no currency term attached.")),

        _c("block_deals", "Block and bulk deals", "BlockDeal", ("symbol", "date", "id"),
           "Off-book and bulk transactions with quantity, price, counterparty and value.",
           cadence="daily", fresh="fetched_at", use="caution",
           writers=("block_deals_fetcher.py", "mc_block_deal_history_fetcher.py"),
           caveats=("`value_cr` is CRORES as a bare float — multiply by 1e7 for rupees and "
                    "state that assumption wherever the number is used.",
                    "`trade_type` is stored in mixed case by different fetchers: normalise "
                    "with UPPER() before aggregating buys against sells.",
                    "Block-deal features exist downstream but graded weak standalone.")),

        _c("stock_mf_holdings", "Mutual-fund holdings", "MFHolding", ("symbol", "date"),
           "Aggregate mutual-fund ownership per disclosure date, with fund count and the "
           "change versus the previous disclosure.",
           cadence="vendor_periodic", fresh="fetched_at", use="allowed",
           writers=("mf_stock_holdings_fetcher.py",),
           caveats=("Disclosure-grain, not daily: a row describes a filing period, so any "
                    "panel build must state its carry-forward rule.",)),

        _c("news_sentiment_items", "News and announcements", "NewsItem", ("id",),
           "Scored news articles and exchange announcements across 15 years — the only "
           "panel here deep enough for a real event study.",
           cadence="intraday", fresh="published_at", lag=1.0, use="caution",
           writers=("news_fetcher.py", "finbert_scorer.py"),
           caveats=("Two sentiment sources coexist — vendor `sentiment` and FinBERT `tone_*` "
                    "— and they can disagree (`sentiment_conflict`). State which one a study "
                    "used.",
                    "`symbols_json` is an array, not a foreign key: join through "
                    "`news_symbol_link`, never by string matching.",
                    "Knowable only from `published_at`, never from the event described.")),

        _c("news_symbol_link", "News-to-symbol links", "NewsItem", ("news_id", "symbol"),
           "Exploded news/announcement to symbol mapping with per-link sentiment — the "
           "joinable form of the mention relation.",
           cadence="intraday", fresh="published_at", lag=1.0, use="allowed",
           writers=("news_fetcher.py",),
           caveats=("One article yields many rows, so counting rows counts MENTIONS, not "
                    "articles — the two differ and the difference is usually the signal.",)),

        _c("so_option_chain", "Stock option chain", "OptionChainRow",
           ("symbol", "date", "expiry", "strike"),
           "Per-strike, per-expiry option grid: call and put premium, volume, OI, IV and "
           "greeks.",
           cadence="daily", fresh="fetched_at", use="caution",
           writers=("stock_option_chain_fetcher.py",),
           caveats=("A grid, not a time series: one session produces many rows per symbol, "
                    "so a naive join multiplies the parent row count.",
                    "Stock option history is far shallower than the index panels.",)),

        _c("stock_futures_oi_history", "Stock futures positioning", "FuturesPositioning",
           ("source", "symbol", "date", "expiry"),
           "Stock-futures open interest, buildup label, rollover percentage, basis and "
           "cost of carry per expiry and session.",
           cadence="daily", fresh="fetched_at", use="caution",
           writers=("fno_oi_fetcher.py",),
           caveats=("LOW-DATA: the panel covers roughly two weeks of dates. Any 'measured' "
                    "reading built on it is a calendar artefact rather than an edge — this "
                    "is exactly the LOW-DATA verdict the master report records.",
                    "`oi_buildup` uses 'Buildup' spelling while the option-chain table uses "
                    "'Build Up': never compare those strings across the two.")),

        _c("fno_rollover", "Futures rollover", "FuturesPositioning", ("symbol", "date"),
           "Near-versus-next expiry open interest with the rollover percentage and the "
           "annualised cost of carry.",
           cadence="daily", fresh="fetched_at", use="caution",
           writers=("fno_rollover_fetcher.py",),
           caveats=("Two open-interest columns in one row share the same semantic property; "
                    "which one a study used must be stated explicitly.",)),

        _c("index_max_pain", "Index max pain", "IndexDerivativesSnapshot",
           ("index_name", "date", "expiry"),
           "Max-pain strike with aggregate call/put open interest and the index PCR, per "
           "index and expiry.",
           cadence="daily", fresh="fetched_at", use="context",
           writers=("mc_index_oi_fetcher.py",),
           caveats=("Aggregate OI columns share the leg-level OI property; they are NOT "
                    "per-strike values.",
                    "Max pain is a mechanical calculation, not a prediction — graded here as "
                    "an unvalidated research candidate.",)),

        _c("nt_index_pcr_ts", "Index PCR time series", "IndexDerivativesSnapshot",
           ("index_name", "ts", "expiry"),
           "Intraday index put-call ratio time series measured on OI, volume and OI change.",
           cadence="intraday", fresh="fetched_at", lag=0.5, use="context",
           writers=("nt_pcr_ts_fetcher.py",),
           caveats=("Three PCR columns share one property; they measure different things "
                    "(OI, volume, OI change) and are not interchangeable.",)),

        _c("mover_snapshots", "Mover snapshots", "MoverSnapshot",
           ("source", "trade_date", "symbol", "rank"),
           "Ranked intraday mover lists from vendor feeds: the within-day event backbone "
           "behind the mover studies and breakout detectors.",
           cadence="intraday", fresh="captured_at", lag=0.5, use="allowed",
           writers=("mover_screener_fetcher.py",),
           caveats=("`rank` is per source per capture — comparable only within one source "
                    "and one instant.",
                    "`metric_value` is source-specific in meaning; the raw body is retained "
                    "in `payload_json` for the cases where it matters.")),

        _c("stock_event_triggers", "Stock event triggers", "EventTrigger", ("date", "symbol"),
           "Detector output per symbol and date: which composite trigger classes fired, "
           "with news counts and bullish-tenure state.",
           cadence="daily", fresh="computed_at", use="allowed",
           writers=("event_triggers.py",),
           caveats=("`triggers` is a comma-joined string with inline thresholds "
                    "(`CROWDED_NEWS p90`) — parse the class token, never the whole value.",)),

        _c("market_regimes", "Market regimes", "RegimeState", ("date",),
           "The macro regime label per session with its posterior probability, the HMM "
           "state path and the model's input features.",
           cadence="daily", fresh="computed_at", use="context",
           writers=("regime_detector.py",),
           caveats=("This is a WEIGHT GATE, not a signal: it re-blends engine weights. "
                    "Treating a regime label as alpha inverts its role.",
                    "Regime history is short relative to price history, so per-regime splits "
                    "lose power fast — always report the per-regime n.",)),

        _c("market_breadth", "Market breadth", "BreadthObservation", ("date",),
           "Participation statistics: share of the universe above its 200-day average, "
           "advance/decline ratio, and net highs minus lows.",
           cadence="daily", fresh="computed_at", use="context",
           writers=("market_breadth.py",),
           caveats=("Computed over this platform's own universe definition, so the numbers "
                    "are not comparable to a vendor breadth series without re-basing.",)),

        _c("intraday_regime_history", "Intraday regime history", "RegimeState",
           ("computed_at", "date"),
           "Within-session risk state with the composite, VIX, PCR, INR move and basis that "
           "produced it.",
           cadence="intraday", fresh="computed_at", lag=0.5, use="context",
           writers=("intraday_ranker.py",),
           caveats=("`breadth_score` shares the composite property; it is a sub-score, not "
                    "the composite.",)),

        _c("sector_rrg_history", "Sector rotation history", "SectorRotationPoint",
           ("sector", "week_date"),
           "Weekly relative-rotation coordinates and quadrant per sector — the intended "
           "input to sector-plus-stock relative strength.",
           cadence="weekly", fresh="fetched_at", use="context",
           writers=("trendlyne_sector_rotation_fetcher.py",),
           caveats=("The sector-to-stock relative-strength link is a RESEARCH CANDIDATE: "
                    "named in the master report as an experiment, not an established edge.",
                    "Weekly cadence against a daily stock panel means any sector feature is "
                    "carried forward within the week — the carry rule must be stated.",)),

        _c("technical_signals", "Technical signal panel", "TechnicalSignal",
           ("symbol", "date"),
           "The wide per-symbol, per-date technical panel: indicators, regime stamp, flow "
           "and fundamental context columns, plus model probability outputs.",
           cadence="daily", fresh="computed_at", lag=5.0, use="caution",
           writers=("technical_analysis_engine.py", "feature_engineering.py"),
           forbidden=("win_probability", "calibrated_win_probability", "ai_insight"),
           caveats=("Over 300 columns of MIXED provenance: raw indicators, vendor opinions "
                    "(ext_* / mc_* / tl_* prefixes) and model outputs sit side by side. Use "
                    "the binding table to tell them apart.",
                    "`win_probability` and `calibrated_win_probability` are model OUTPUTS — "
                    "feeding them back in leaks the model into its own inputs.",
                    "`ai_insight` is generated text.")),

        _c("feature_store", "Feature store", "FeatureVector",
           ("symbol", "date", "timeframe"),
           "The rolling feature panel the models train on: returns, moving averages, "
           "oscillators, volatility, volume and flow families.",
           cadence="daily", fresh="date", lag=5.0, use="caution",
           writers=("feature_engineering.py",),
           caveats=("Values are the engineering layer's own output, so their meaning is set "
                    "by `feature_engineering.py` at a specific commit — cite the feature "
                    "version when a result depends on it.",
                    "Pre-rebuild rows are not comparable with post-rebuild rows.",
                    "Fast-growing hypertable, so compression and retention apply and deep "
                    "history may be compressed away.")),

        _c("unified_recommendations", "Served recommendations", "Recommendation",
           ("symbol", "computed_at", "timeframe"),
           "The authoritative served signal: composite score, conviction bucket, action, "
           "entry zone, stop, targets, risk/reward and position size per timeframe.",
           cadence="daily", fresh="computed_at", lag=5.0, use="caution",
           writers=("unified_ranker.py",),
           forbidden=("trade_reasoning",),
           caveats=("`computed_at` is TEXT here and native TIMESTAMPTZ in "
                    "`confluence_signals` — cast before joining the two.",
                    "`trade_reasoning` is generated text: an explanation, never evidence.",
                    "`position_size_pct` derives from a meta-label whose raw value lives in "
                    "the history table, not here.")),

        _c("unified_recommendations_history", "Recommendation history", "Recommendation",
           ("symbol", "computed_at"),
           "The accumulating record of every served recommendation with its raw "
           "win-probability meta-label — the substrate for forward testing the ranker.",
           cadence="daily", fresh="computed_at", use="caution",
           writers=("unified_ranker.py",),
           forbidden=("win_probability",),
           caveats=("`win_probability` here is the raw meta-label behind "
                    "`position_size_pct`: a model output, not an input.",
                    "Kept separately from the serving table so backtests need not "
                    "reconstruct history from a table that is truncated by design.",)),

        _c("intraday_recommendations", "Intraday recommendations", "Recommendation",
           ("symbol", "computed_at"),
           "Within-session picks with their intraday risk state, entry price and size.",
           cadence="intraday", fresh="computed_at", lag=0.5, use="caution",
           writers=("intraday_ranker.py",),
           forbidden=("reasoning",),
           caveats=("Carries TWO timestamp columns (`computed_at` and `computed_ts`) that "
                    "share one semantic property — pick one and state which.",
                    "`reasoning` is generated text.")),

        _c("confluence_signals", "Confluence signals", "EngineScore",
           ("symbol", "computed_at"),
           "The multi-engine agreement score with the contributing screeners, their weights "
           "at scoring time, and the model probabilities that fed it.",
           cadence="every_15m", fresh="computed_at", lag=0.5, use="caution",
           writers=("confluence_ml_engine.py",),
           forbidden=("trade_reasoning", "ai_conclusion"),
           caveats=("The only engine score with a growing positive graded reading on this "
                    "platform — which is what makes it the ranker's load-bearing input.",
                    "`computed_at` here is native TIMESTAMPTZ, unlike the TEXT "
                    "`computed_at` on `unified_recommendations`: cast across the join.",
                    "`ml_breakout_probability` / `ml_trend_probability` are model outputs.",
                    "`screener_weights_json` records the weights AT SCORING TIME — applying "
                    "today's weights to an old row is a look-ahead bug.")),

        _c("engine_composite_scores", "Engine composite scores", "EngineScore",
           ("symbol", "date"),
           "The blended multi-engine composite per symbol and date with its engine-coverage "
           "count.",
           cadence="daily", fresh="computed_at", use="allowed",
           writers=("unified_ranker.py",),
           caveats=("Coverage count matters as much as the score: a composite built from two "
                    "engines is not comparable to one built from six.",)),

        _c("signal_outcomes", "Signal outcomes", "SignalOutcome",
           ("symbol", "signal_date", "horizon_days", "signal_source"),
           "The resolved result of each technical or confluence signal: entry, exit, "
           "horizon, return and label.",
           cadence="daily", fresh="computed_at", use="labels",
           writers=("outcome_resolver.py",),
           forbidden=("return_pct", "outcome", "exit_price", "max_return_pct", "check_date"),
           caveats=("LABELS ONLY. Two labelling rules coexist (`path_barrier`, "
                    "`terminal_pct2`): filter on `label_definition` before aggregating "
                    "accuracy — mixing them makes every rate meaningless.",
                    "`PENDING` rows have not elapsed and are not negative examples.",
                    "`is_suspect` flags rows whose underlying data was quarantined.")),

        _c("unified_signal_outcomes", "Unified signal outcomes", "SignalOutcome",
           ("symbol", "signal_date", "horizon_days"),
           "Outcomes for served signals with the exit reason that closed them — the "
           "forward-test surface for the ranker.",
           cadence="daily", fresh="computed_at", use="labels",
           writers=("outcome_resolver.py",),
           forbidden=("return_pct", "outcome", "exit_price", "check_date", "exit_reason"),
           caveats=("`exit_reason` separates rule exits from integrity exits: "
                    "`NO_ENTRY_PRICE` and `SUSPECT_DATA` rows are not labels.",
                    "`TIME_EXIT_PARTIAL` means the position did not close cleanly, so its "
                    "return is not directly comparable to a full exit.",)),

        _c("signal_excursions", "Signal excursions", "SignalExcursion",
           ("symbol", "signal_date", "horizon_days"),
           "MFE/MAE path statistics per signal and horizon, with days-to-each and whether "
           "the favourable move came first.",
           cadence="daily", fresh="computed_at", use="labels",
           writers=("outcome_resolver.py",),
           forbidden=("mfe_pct", "mae_pct"),
           caveats=("This is what makes a stop-loss or trailing-exit study possible: the "
                    "terminal return alone cannot tell you whether the trade was ever "
                    "viable.",
                    "`tb_label` is a triple-barrier label sharing the label-definition "
                    "property — it is not the same rule as `path_barrier`.",)),

        _c("screener_master", "Screener catalog", "Screener", ("scan_id",),
           "The catalog of vendor screeners with this platform's inferred sentiment, "
           "category, tier and classification confidence.",
           cadence="on_change", fresh="last_updated", use="caution",
           writers=("screener_catalog_enricher.py", "trendlyne_screener_discovery.py"),
           caveats=("Sentiment, category and tier are INFERRED by this platform: model "
                    "output about a vendor product, not vendor metadata.",
                    "A screener is a candidate generator, never evidence — the aggregate "
                    "momentum score derived from these no longer clears the USABLE bar.",)),

        _c("stock_scores", "Domain scores", "EngineScore", ("symbol", "timeframe"),
           "Per-domain score rows (technical, fundamental, ownership, ...) each with a "
           "classification and a confidence value.",
           cadence="on_write", fresh="last_updated", use="caution",
           writers=("scoring_engine.py",),
           forbidden=("confidence",),
           caveats=("Several rows per symbol — one per domain — so an ungrouped join "
                    "multiplies the parent row count.",
                    "`confidence` is a derived confidence value, not a calibrated "
                    "probability, and not an input.")),

        _c("live_screener_appearances", "Live screener appearances", "ScreenerAppearance",
           ("id",),
           "Every live surfacing event: which screener listed which symbol at which instant, "
           "with the price, change and volume at that moment.",
           cadence="every_15m", use="allowed",
           writers=("mover_screener_fetcher.py", "live_screener_ml_ranker.py"),
           caveats=("12.25M rows and growing: always bound a query by run_id or symbol.",
                    "`price` is the snapshot at surfacing time, not a session close.",
                    "There is no timestamp column on the row itself — time lives on the run, "
                    "so a time filter must join through it.")),

        _c("live_screener_outcomes", "Live screener outcomes", "ScreenerOutcome",
           ("appearance_id", "symbol"),
           "Forward returns attached to each appearance at surfacing time: the platform's "
           "largest pre-labelled dataset.",
           cadence="every_15m", fresh="appeared_at", use="labels",
           writers=("live_screener_ml_ranker.py",),
           forbidden=("return_1d", "return_3d", "return_5d", "entry_price"),
           caveats=("LABELS ONLY — three horizons share one return property, distinguished "
                    "by the column name; never average them together.",
                    "The label is a forward return from the SURFACING price, so any "
                    "attribution belongs to the screener that surfaced it, not to an engine "
                    "that agreed.",
                    "Coverage is per-appearance and pre-computed, which is why the 3d/5d "
                    "columns are NULL for recent rows — those are not losses.",)),

        _c("job_heartbeat", "Job heartbeats", "JobRun", ("job_name",),
           "Per-job last status, last success, last error and run/failure counts. The "
           "operational truth behind every freshness claim.",
           cadence="continuous", fresh="last_success_at", use="forbidden",
           writers=("jobHeartbeat.ts", "pythonRunner.ts"),
           caveats=("`last_run_at` is the last ATTEMPT and `last_success_at` the last "
                    "SUCCESS — a job can run nightly, fail nightly, and still look alive by "
                    "the first column. Judge freshness on the second.",
                    "Operational metadata: useful for lineage, never a model feature.")),

        _c("data_quality_results", "Data-quality results", "DataQualityCheck", ("check_id",),
           "The latest result of each named validation check with its category, criticality "
           "and a detail string.",
           cadence="continuous", fresh="checked_at", use="forbidden",
           writers=("run_data_quality_checks.ts",),
           caveats=("`status` is stored lowercase (`pass`, `warn`), so a comparison against "
                    "'PASS' silently matches nothing.",
                    "A `warn` here is a real signal that some upstream writer misbehaved — "
                    "worth reading before trusting the affected table.")),

        _c("model_registry", "Model registry", "ModelArtifact", ("id",),
           "Every trained model version with its type, evaluation metrics, feature count, "
           "horizon and active flag.",
           cadence="on_training", fresh="trained_at", use="forbidden",
           writers=("ml_ensemble.py", "dl_engine.py", "online_learner.py"),
           caveats=("A registered model is not necessarily a serving one: promotion is gated "
                    "on holdout error plus a margin.",
                    "Metadata about a model, never a feature of the market.")),

        _c("feature_importance_log", "Feature importance log", "FeatureImportance", ("id",),
           "Per-model, per-run feature importance with rank — the audit trail behind which "
           "inputs a model actually used.",
           cadence="on_training", fresh="computed_at", use="forbidden",
           writers=("ml_ensemble.py",),
           caveats=("Two name columns exist (`model_name` and `feature_name`) that share one "
                    "property; read them by position, not by assumption.",
                    "Importance is model-internal: it is not a measure of market edge and "
                    "must not be used as a feature.",)),

        _c("factor_edge_history", "Factor edge ledger", "EdgeReading", 
           ("run_at", "table_name", "score_col", "horizon_days"),
           "The platform's own measurement ledger: rank-IC and hit-AUC per factor, regime "
           "and horizon, with the independent-observation count and a verdict.",
           cadence="on_grading", fresh="run_at", use="forbidden",
           writers=("factor_edge.py",),
           caveats=("READ `eff_dates` BEFORE the reading. Overlapping forward windows "
                    "inflate a correlation by roughly the horizon factor, and effective "
                    "dates are the guard that exposes it.",
                    "`verdict` values include the literal string `no edge` with a space, "
                    "and `n/a` — match them exactly.",
                    "`table_name` and `score_col` reuse the generic source/name properties: "
                    "this row is describing a COLUMN, not a table.",)),

        _c("market_endpoint_registry", "Endpoint discovery registry", "Endpoint", ("uid",),
           "3,408 verified market-data endpoints with provider, domain, scope, update "
           "frequency, required params and the template to call each one.",
           cadence="on_discovery", fresh="validated_at", use="forbidden",
           writers=("build_pg_registry.py (urls-explorer, outside this repo)",),
           caveats=("This is the MANDATORY FIRST STOP when a source stops returning data: a "
                    "'dead vendor' conclusion is not admissible until these endpoints have "
                    "been checked for an alternate route to the same information.",
                    "The registry is populated entirely outside this repository — grep-based "
                    "reasoning about it will come up empty."
                    )),

        _c("url_endpoints", "Consolidated endpoint templates", "Endpoint", ("id",),
           "830 consolidated endpoint templates carrying the feature targets each one can "
           "populate — the alternate-lookup index.",
           cadence="on_discovery", fresh="updated_at", use="forbidden",
           writers=("url_explorer.ingest",),
           caveats=("Use it via `python -m url_explorer.ingest --find-alternates` from "
                    "`src/server`, which is the sanctioned path.",
                    "`host` and `provider` are different grains of the same concept and "
                    "share one property here — read them by name.",)),
        # ── identity hub & vendor id crosswalk ────────────────────────────────
        _c("nse_stocks", "NSE listing snapshot", "Equity", ("symbol",),
           "One row per NSE ticker carrying ISIN, sector, industry, venue, index-membership "
           "flags, lot size and the vendor id cross-references (mcsymbol, trendlyne, "
           "tickertape, fincode, scripcode). The richest identity table in the database.",
           cadence="daily", fresh="last_updated", use="context",
           writers=("scripts/syncAllStockMappings.ts", "scripts/sync_mc_scid_map.py"),
           caveats=("NO SINGLE WRITER OWNS A ROW: the vendor-id columns, the sector/industry "
                    "columns, the surveillance flags and the index-membership flags are each "
                    "patched by a different job, each with its own `*_updated_at` stamp, so a "
                    "row is a merge of several ages.",
                    "`market_cap` is vendor-computed and its unit is NOT declared in the "
                    "schema (`market_cap` records `INR_or_crore_UNDECLARED`).",
                    "`is_asm`, `gsm_stage` and every `is_nifty*`/`is_midcap*` flag is a 0/1 "
                    "INTEGER, not a boolean.",
                    "Index-membership flags are current snapshots, not survivorship-free "
                    "history: they cannot reconstruct a past universe.")),

        _c("mc_scid_map", "Vendor scrip-code crosswalk", "ScripCodeMapping",
           ("scid", "symbol"),
           "Maps the vendor's private scid to the platform symbol and issuer name. Vendor "
           "tables reachable only by scid are joined through here.",
           cadence="on_discovery", use="context",
           writers=("scripts/sync_mc_scid_map.py",),
           caveats=("`resolved_at` records when the mapping was created, not when it was last "
                    "verified, so a mapping that has silently gone stale is indistinguishable "
                    "from a fresh one.",
                    "Uniqueness is not enforced (see the class caveat): a symbol->scid join "
                    "can fan out after a vendor scrip merge.")),



        _c("market_issuer", "Canonical issuer", "Issuer", ("issuer_key",),
           "Issuer identity keyed by a verified seven-character Indian ISIN issuer prefix when "
           "available, otherwise by an explicitly provisional exchange/symbol key.",
           cadence="on_change", fresh="recorded_at", use="context",
           writers=("semantic_identity.py",),
           caveats=("Never merge provisional symbol keys by name; absence of ISIN is an identity "
                    "gap, not permission to fuzzy-match.")),
        _c("market_instrument", "Canonical instrument", "Instrument", ("instrument_key",),
           "Stable instrument identity, normally keyed by full checksum-valid ISIN and owned by "
           "one canonical issuer.", cadence="on_change", fresh="recorded_at", use="context",
           writers=("semantic_identity.py",),
           caveats=("The instrument is distinct from an exchange listing: NSE and BSE listings "
                    "point to the same instrument when the ISIN agrees.")),
        _c("market_listing", "Canonical listing", "Listing", ("listing_key",),
           "One exchange/segment/symbol representation of an instrument with bitemporal validity.",
           cadence="on_change", fresh="recorded_at", use="context",
           writers=("semantic_identity.py",),
           caveats=("A symbol change creates a listing interval; it does not create a new issuer "
                    "or instrument when the ISIN remains stable.")),
        _c("market_identifier", "Provider identifier mapping", "ProviderIdentifier",
           ("mapping_key",),
           "Provider-qualified identifier mappings with confidence, validity, and explicit "
           "ambiguity status.", cadence="on_change", fresh="recorded_at", use="context",
           writers=("semantic_identity.py",),
           caveats=("Provider and scheme are part of identity. An ambiguous code is retained as "
                    "a gap and must never be resolved by query order or name similarity.")),
        _c("market_identifier_gap", "Identifier mapping gap", "ProviderIdentifier",
           ("provider", "scheme", "identifier_value"),
           "Queryable record of provider identifiers that could not be safely resolved.",
           cadence="on_discovery", fresh="last_seen", use="context",
           writers=("semantic_identity.py",)),


        _c("market_graph_node", "Instance graph node", "GraphNode", ("node_key",),
           "Canonical entity projection for graph traversal; normalized identity tables remain "
           "authoritative for issuer/instrument/listing resolution.", cadence="on_write",
           fresh="recorded_at", use="context", writers=("semantic_identity.py", "semantic_evidence.py")),
        _c("market_graph_edge", "Instance graph edge", "GraphEdge", ("assertion_key",),
           "Typed bitemporal assertions with source and availability metadata.",
           cadence="on_write", fresh="recorded_at", use="context",
           writers=("semantic_identity.py", "semantic_evidence.py")),
        _c("market_evidence", "Source evidence", "EvidenceRecord", ("evidence_key",),
           "Source material retained independently from claims and decision interpretations.",
           cadence="on_write", fresh="available_at", use="context",
           writers=("semantic_evidence.py",),
           caveats=("Candidate extraction is not verification; read quality_status before using "
                    "content as decision evidence.")),
        _c("market_claim", "Explicit market claim", "MarketClaim", ("claim_key",),
           "Typed claim with stance, method, status, and bitemporal availability.",
           cadence="on_write", fresh="available_at", use="context",
           writers=("semantic_evidence.py",),
           caveats=("A claim is not a fact until its status and supporting evidence say so.")),
        _c("market_claim_evidence", "Claim evidence link", "EvidenceRecord",
           ("claim_key", "evidence_key"),
           "Supports/opposes/context links from explicit claims to retained source evidence.",
           cadence="on_write", use="context", writers=("semantic_evidence.py",)),
        _c("market_decision_event", "Decision event", "DecisionEvent", ("decision_key",),
           "Append-only decision event carrying cutoff, versions, quality, watermarks, vetoes, "
           "and guardrails.", cadence="on_write", fresh="generated_at", use="context",
           writers=("unified_ranker.py",),
           caveats=("`score` is a ranking score, not a calibrated probability; `advisory` is not "
                    "the same as `publishable`.")),
        _c("market_decision_evidence", "Decision evidence", "DecisionEvent",
           ("decision_key", "evidence_key"),
           "Structured support, contradiction, context, and veto evidence for each decision.",
           cadence="on_write", fresh="available_at", use="context",
           writers=("unified_ranker.py", "semantic_evidence.py")),
        _c("market_decision_outcome", "Decision outcome", "DecisionOutcome",
           ("decision_key", "label_definition", "horizon_days"),
           "Realized outcome attached to a decision under an explicit label definition.",
           cadence="on_outcome", fresh="resolved_at", use="labels",
           writers=("outcome_resolver.py", "semantic_evidence.py"),
           forbidden=("entry_price", "exit_price", "return_pct", "mfe_pct", "mae_pct"),
           caveats=("Never aggregate across label definitions or treat PENDING as a negative "
                    "outcome.")),


        _c("market_data_contract", "Semantic data contract", "DataContract", ("contract_key",),
           "Versioned executable contract for dataset grain, timing, source, and allowed use.",
           cadence="on_change", fresh="updated_at", use="context",
           writers=("semantic_contracts.py",),
           caveats=("A contract describes safe use; it does not prove the producer is complete.")),
        _c("semantic_feature_definition", "Semantic feature definition", "FeatureDefinition",
           ("feature_key",),
           "Materialized authored feature/label contract with physical bindings and leakage rules.",
           cadence="on_change", fresh="updated_at", use="context",
           writers=("semantic_contracts.py",)),
        _c("market_data_watermark", "Data completeness watermark", "DataWatermark",
           ("dataset", "partition_key"),
           "Producer-published input/output completeness state, distinct from freshness.",
           cadence="per_run", fresh="recorded_at", use="context",
           writers=("semantic_evidence.py", "semantic_identity.py"),
           caveats=("A fresh latest row is not a complete partition; read completeness_status and "
                    "accepted/rejected counts.")),


    )
