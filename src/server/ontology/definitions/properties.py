"""
Datatype properties — the semantics a database column cannot carry.

A column called `win_probability` looks exactly like `delivery_pct` to a model consumer;
both are floats. Here they are different kinds of thing with different rules:

    win_probability   semantic_type=probability  leakage=high    -> never an input
    delivery_pct      semantic_type=ratio        leakage=none    -> an input, T+1 lagged
    outcome           semantic_type=label        leakage=target  -> IS the target
    close             semantic_type=measure      timing=coincident
    fii_3d_net        semantic_type=ratio        timing=leading

Properties are declared in groups sharing a (semantic_type, datatype, timing, derivation,
leakage_risk) profile, with a per-property `OVERRIDES` map for anything surprising. The
descriptions sit beside the group rows so a reader sees every property at once.
`properties()` raises if an override key is not a real field, so a typo fails loudly.
"""
from typing import Dict, Tuple

from ..model import PropertyDef

P = PropertyDef


def _g(semantic_type: str, datatype: str, timing: str, derivation: str,
       leakage_risk: str = "none", unit: str = None, vocabulary: str = None) -> Dict:
    """Group defaults. Explicit rather than **kwargs, so a typo cannot invent a new axis."""
    return {
        "semantic_type": semantic_type, "datatype": datatype, "timing": timing,
        "derivation": derivation, "leakage_risk": leakage_risk, "unit": unit,
        "vocabulary": vocabulary,
    }


def _groups() -> Tuple[Tuple[Dict, list], ...]:
    return (
        # ── identifiers ────────────────────────────────────────────────────────
        (_g("identifier", "string", "context", "raw"), [
            ("symbol", "Symbol",
             "Exchange ticker, NSE/BSE convention embedded in the string. The platform's "
             "universal join key across ~40 tables."),
            ("isin", "ISIN",
             "ISO 6166 identifier. The only globally-unique key here; coverage is partial, "
             "which makes an ISIN-first instrument master a project, not a rename."),
            ("scid", "MoneyControl scid",
             "Vendor-private MoneyControl id. Reachable from `symbol` only through "
             "`mc_scid_map`, and comparable to no other vendor's id."),
            ("company_name", "Company name",
             "Issuer name as supplied by the writer. Free text: one company can appear under "
             "two names across tables."),
            ("id", "Row id",
             "Surrogate key that is NOT stable across a re-fetch or backfill. Never join on "
             "this across runs — use the table's natural key."),
            ("check_id", "Check id", "Stable identifier of a data-quality check definition."),
            ("issuer_key", "Issuer key",
             "Stable internal issuer key. ISIN issuer-prefix keys are authoritative; provisional symbol keys are explicitly low-confidence."),
            ("instrument_key", "Instrument key",
             "Stable internal instrument key, normally derived from the full ISIN rather than a ticker."),
            ("listing_key", "Listing key",
             "Exchange/segment/symbol identity for one tradable listing."),
            ("provider", "Provider",
             "Namespace that owns a private identifier. Provider is always part of an identifier key."),
            ("scheme", "Identifier scheme",
             "Meaning of a provider identifier, such as ticker, scrip_code or company_id."),
            ("identifier_value", "Identifier value",
             "Provider-issued identifier value; comparable only within the same provider and scheme."),
            ("identity_basis", "Identity basis",
             "Evidence used to construct an issuer or instrument identity."),
            ("mapping_status", "Mapping status",
             "Whether an identifier mapping is verified, ambiguous, unresolved or rejected."),
        ]),

        # ── dimensions ─────────────────────────────────────────────────────────
        (_g("dimension", "string", "context", "raw"), [
            ("sector", "Sector",
             "Industry grouping label as supplied by the writing fetcher. No canonical table "
             "backs it, so a cross-table sector join can silently lose names."),
            ("industry", "Industry",
             "Finer-grained grouping than sector, same provenance caveat. Carried as its own "
             "column only in `stock_master` and `nse_stocks`."),
            ("exchange", "Exchange",
             "Venue: NSE or BSE. Usually encoded inside `symbol`, but carried as its own "
             "column in seven tables — `nse_stocks.exchange` is the canonical one. That "
             "column-count is the reason `Exchange` is modelled as a reference class rather "
             "than a table."),
            ("series", "Series",
             "NSE trading series (EQ, BE, BZ, ...). Distinguishes liquidity tiers; mixing "
             "them silently changes a universe."),
            ("index_name", "Index name",
             "Index identifier used by the derivatives, PCR and max-pain tables."),
            ("source", "Source",
             "Which provider or fetcher wrote the row. Provenance is per-row on this "
             "platform, so this is the first column to check before trusting a value."),
            ("session", "Session",
             "Trading-session segment a row belongs to (block deals carry this)."),
        ]),

        # ── time coordinates ───────────────────────────────────────────────────
        (_g("timestamp", "date", "context", "raw", unit="calendar_day"), [
            ("date", "Date",
             "Trading-session date. Day cuts are Asia/Kolkata: a date column is a session, "
             "not a midnight-to-midnight instant."),
            ("signal_date", "Signal date",
             "Session a signal was generated for. Entry happens at the NEXT session's open — "
             "the most common off-by-one in this repo."),
            ("check_date", "Check date",
             "Session an outcome was resolved on; with `signal_date` it bounds the window."),
            ("as_of_date", "As-of date",
             "Point-in-time stamp on vendor snapshots: the value is knowable only from this "
             "date, whatever period it describes."),
            ("ex_date", "Ex-date",
             "First session on which a symbol trades without the benefit of a corporate "
             "action. The anchor for every price adjustment."),
            ("expiry", "Expiry",
             "Derivative contract expiry. Several expiries coexist per symbol per date."),
            ("week_date", "Week date", "Weekly anchor used by the sector-rotation panel."),
        ]),
        (_g("timestamp", "timestamp", "context", "raw"), [
            ("datetime", "Timestamp", "Intraday bar timestamp, Asia/Kolkata."),
            ("computed_at", "Computed at",
             "When the platform produced the row. NOT uniform across tables: TEXT in "
             "`unified_recommendations`, native TIMESTAMPTZ in `confluence_signals`. Cast "
             "before comparing the two."),
            ("fetched_at", "Fetched at",
             "When the provider response was received — distinct from the date the "
             "observation refers to."),
            ("captured_at", "Captured at",
             "Snapshot capture time for vendor grids that are otherwise undated."),
            ("published_at", "Published at",
             "Publication time of a news item or announcement. Such an item is knowable only "
             "from this instant, never from the event it describes."),
            ("last_updated", "Last updated",
             "Writer-supplied modification stamp. Trust it only when the writer is known to "
             "set it on every write."),
        ]),

        # ── prices, volumes and holdings ───────────────────────────────────────
        (_g("measure", "decimal", "coincident", "raw"), [
            ("open", "Open", "Session open, in the row's recorded price basis."),
            ("high", "High", "Session high."),
            ("low", "Low", "Session low."),
            ("close", "Close", "Session close. The reference price for almost every "
                               "downstream calculation."),
            ("vwap", "VWAP", "Volume-weighted average price; present on intraday bars only."),
            ("volume", "Volume", "Shares traded in the session."),
            ("cmp", "Current market price",
             "Last traded price at the moment the row was written — a point-in-time snapshot, "
             "not a session close. Do not substitute it for `close`."),
            ("entry_price", "Entry price",
             "Assumed or realised entry fill used by an outcome calculation."),
            ("exit_price", "Exit price",
             "Realised exit fill; only exists on resolved outcomes."),
            ("open_interest", "Open interest", "Outstanding contracts on a derivative."),
            ("strike", "Strike", "Option contract strike price."),
            ("max_pain", "Max pain",
             "Strike at which the largest number of option contracts expire worthless."),
            ("market_cap", "Market capitalisation",
             "Vendor-computed market cap. The stored unit is NOT declared anywhere in the "
             "schema — confirm it before aggregating across tables."),
            ("quantity", "Quantity", "Shares transacted in an insider or bulk transaction."),
        ]),
        (_g("measure", "decimal", "coincident", "raw", unit="shares"), [
            ("delivery_qty", "Delivered quantity", "Shares actually delivered."),
            ("traded_qty", "Traded quantity", "Total shares traded."),
            ("deliverable_qty", "Deliverable quantity", "Shares eligible for delivery."),
            ("contracts", "Contracts", "Number of derivative contracts."),
            ("total_oi", "Total open interest",
             "Open interest summed across the expiries a rollover row spans."),
            ("lot_size", "Lot size", "Contract multiplier — required to convert a price move "
                                     "into a rupee P&L."),
        ]),

        # ── ratios ─────────────────────────────────────────────────────────────
        (_g("ratio", "decimal", "coincident", "raw", unit="percent"), [
            ("delivery_pct", "Delivery percentage",
             "Delivered shares as a share of traded shares. T+1 by construction, underexploited "
             "here, and the platform's best high-frequency ownership proxy."),
            ("change_pct", "Change percent", "Session or snapshot price change."),
            ("oi_pct_change", "OI change percent", "Session-over-session open-interest change."),
            ("rollover_pct", "Rollover percent",
             "Share of open interest rolled from the near to the next expiry."),
            ("pct_transacted", "Percent transacted",
             "Transacted shares as a share of the float or of outstanding capital, depending on "
             "the writer."),
            ("pledge_pct", "Pledged percent", "Promoter shares pledged as collateral."),
            ("mf_holding_pct", "Mutual-fund holding percent",
             "Aggregate mutual-fund ownership of the symbol."),
            ("revenue_growth", "Revenue growth", "Vendor-computed revenue growth."),
            ("earnings_growth", "Earnings growth", "Vendor-computed earnings growth."),
            ("operating_margins", "Operating margin", "Vendor-computed operating margin."),
            ("return_on_equity", "Return on equity", "Vendor-computed ROE."),
            ("debt_to_equity", "Debt to equity", "Vendor-computed leverage ratio."),
            ("price_to_book", "Price to book", "Vendor-computed P/B."),
            ("pct_above_200dma", "Percent above 200-DMA",
             "Breadth measure: share of the universe trading above its 200-day average."),
            ("adv_decline_ratio", "Advance/decline ratio", "Advancing over declining names."),
        ]),
        (_g("ratio", "decimal", "coincident", "raw", unit="ratio"), [
            ("risk_reward", "Risk/reward",
             "Target distance over stop distance on a served recommendation."),
            ("position_size_pct", "Position size percent",
             "Recommended allocation. Its raw meta-label is stored in the history table."),
            ("cost_of_carry_ann", "Annualised cost of carry",
             "Futures basis expressed as an annualised rate."),
            ("basis", "Basis", "Futures price minus spot price."),
            ("volume_ratio", "Volume ratio", "Session volume over its recent average."),
            ("bb_width", "Bollinger band width", "Band width, a volatility proxy."),
            ("iv_hv_ratio", "IV/HV ratio",
             "Implied over historical volatility — a cheap richness measure."),
            ("fii_3d_net", "FII net 3-day flow",
             "Foreign-institutional net cash flow over three sessions. Coincident-to-lagging, "
             "not leading."),
            ("dii_3d_net", "DII net 3-day flow", "Domestic-institutional net flow over three "
                                                  "sessions."),
        ]),

        # ── platform scores ────────────────────────────────────────────────────
        (_g("score", "decimal", "coincident", "platform", unit="score_0_100"), [
            ("unified_score", "Unified score",
             "The composite the unified ranker serves. An OUTPUT of the platform, so it is a "
             "legitimate feature only for a model predicting something else."),
            ("confluence_score", "Confluence score",
             "Cross-evidence agreement score. The only engine score with a growing positive "
             "graded reading on this platform."),
            ("ml_score", "ML score", "Ensemble output; measured to add roughly +0.02 rank "
                                     "quality over the blend."),
            ("technical_score", "Technical score", "Rule-based technical engine output."),
            ("dl_score", "Deep-learning score",
             "BiLSTM output, currently paused at a measured 0.0 contribution."),
            ("cs_score", "Cross-sectional score",
             "Rank-based cross-sectional output; measured 0.0 across all regimes."),
            ("breakout_score", "Breakout score", "Breakout probability model output."),
            ("smart_money_score", "Smart-money score",
             "Flow-aggregation score; measured 0.0 across all regimes."),
            ("fundamental_score", "Fundamental score", "Vendor-derived fundamental composite."),
            ("screener_stock_score", "Screener stock score",
             "Aggregate screener evidence for the symbol."),
            ("signal_score", "Signal score", "Score attached to a technical signal at creation."),
            ("composite", "Composite", "Multi-engine composite stored per symbol and date."),
            ("piotroski_f_score", "Piotroski F-score",
             "Vendor-computed 0-9 accounting quality score."),
            ("rsi", "RSI (14)",
             "Wilder RSI. Graded on this platform as a mean-reversion input with NEGATIVE "
             "rank-IC at 5 days — a finding, not a defect."),
            ("adx", "ADX", "Trend-strength indicator; measured edge approximately zero."),
            ("macd", "MACD", "MACD line value."),
            ("atr", "ATR", "Average true range, used for stop placement."),
            ("sma50", "SMA 50", "50-session simple moving average level."),
            ("sma200", "SMA 200", "200-session simple moving average level."),
        ]),

        # ── model outputs that must never be inputs ────────────────────────────
        (_g("probability", "decimal", "coincident", "platform", leakage_risk="high",
            unit="probability"), [
            ("win_probability", "Win probability",
             "Raw model probability, isotonic-banded downstream. Forbidden as a feature: it is "
             "a model output, so feeding it back leaks the model into its own inputs."),
            ("calibrated_win_probability", "Calibrated win probability",
             "Isotonic-calibrated variant of the above; same prohibition."),
            ("regime_prob", "Regime probability",
             "Posterior probability of the HMM regime state for the date."),
        ]),

        # ── counts ─────────────────────────────────────────────────────────────
        (_g("count", "integer", "coincident", "platform", unit="count"), [
            ("engine_coverage_count", "Engine coverage",
             "How many engines produced a score for this row — a coverage multiplier rather "
             "than a feature of the market."),
            ("bullish_screener_count", "Bullish screener count",
             "Screener appearances with an inferred bullish bias."),
            ("bearish_screener_count", "Bearish screener count",
             "Screener appearances with an inferred bearish bias."),
            ("active_screener_count", "Active screener count",
             "Distinct screeners holding the name at once."),
            ("n_analysts", "Analyst count", "Contributing analysts in the consensus snapshot."),
            ("num_funds", "Fund count", "Mutual funds holding the symbol."),
            ("stocks_count", "Constituent count", "Members in a sector or index aggregate."),
            ("news_count_5d", "News count (5 sessions)", "Articles mentioning the symbol."),
            ("horizon_days", "Horizon (days)",
             "Evaluation horizon a signal or outcome is expressed over. A parameter of the "
             "label, not a property of the market."),
            ("importance", "Feature importance", "Model feature importance for a run."),
            ("rank_position", "Importance rank", "Rank of a feature within its model run."),
            ("eff_dates", "Effective dates",
             "Independent-observation count used by the factor grader: the guard that stops "
             "overlapping forward windows from inflating a reading."),
        ]),
        (_g("operational", "integer", "context", "platform"), [
            ("run_count", "Run count", "Successful job runs recorded."),
            ("fail_count", "Failure count", "Failed job runs recorded."),
        ]),
        (_g("operational", "string", "context", "platform"), [
            ("job_name", "Job name",
             "Scheduler job identity (pm2 / BullMQ): the unit of both lineage and failure."),
        ]),


        # ── flags ──────────────────────────────────────────────────────────────
        (_g("flag", "boolean", "coincident", "raw"), [
            ("is_suspect", "Suspect row",
             "Quarantined by a data-quality rule. Filter it OUT of any training panel; never "
             "impute over it silently."),
            ("above_sma200", "Above 200-DMA", "Price above its 200-session average."),
            ("asm_flag", "ASM flag",
             "Exchange surveillance listing — a tradability constraint, not a signal."),
            ("fcf_positive", "Positive free cash flow", "Sign of free cash flow."),
            ("ai_scored", "AI scored",
             "Scored by the NLP model rather than carrying vendor sentiment only."),
            ("sentiment_conflict", "Sentiment conflict",
             "Vendor sentiment and FinBERT tone disagree on the same item."),
            ("high_growth_scope", "High growth scope", "Vendor narrative flag on the profile."),
        ]),

        # ── advised price levels (platform output, not market data) ────────────
        (_g("measure", "decimal", "coincident", "platform", unit="per_share_INR"), [
            ("entry_zone_low", "Entry zone low", "Lower bound of the advised entry zone."),
            ("entry_zone_high", "Entry zone high", "Upper bound of the advised entry zone."),
            ("stop_loss", "Stop loss", "Advised protective stop."),
            ("target_1", "Target 1", "First advised target."),
            ("target_2", "Target 2", "Second advised target."),
            ("target_3", "Target 3", "Third advised target."),
        ]),

        # ── enums, each bound to a controlled vocabulary ───────────────────────
        (_g("enum", "string", "context", "raw", vocabulary="timeframe"), [
            ("timeframe", "Timeframe", "Horizon a signal or recommendation is expressed on."),
        ]),
        (_g("enum", "string", "context", "raw", vocabulary="market_regime"), [
            ("regime", "Market regime", "Macro regime label applied to the row's date."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="conviction"), [
            ("conviction_level", "Conviction level", "Ranked conviction bucket."),
        ]),
        (_g("enum", "string", "context", "platform",
            vocabulary="recommendation_classification"), [
            ("classification", "Classification", "Human-readable action label."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="signal_source"), [
            ("signal_source", "Signal source", "Which producer emitted the signal."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="edge_verdict"), [
            ("verdict", "Edge verdict",
             "Recorded outcome of a factor grading run after the power guards."),
        ]),
        (_g("enum", "string", "context", "raw", vocabulary="adjustment_basis"), [
            ("adjustment_basis", "Adjustment basis",
             "Whether the stored price series is raw, split-adjusted or fully adjusted. Mixing "
             "bases in one series silently corrupts a backtest."),
        ]),
        (_g("enum", "string", "context", "raw", vocabulary="suspect_reason"), [
            ("suspect_reason", "Suspect reason", "Why a bar was quarantined."),
        ]),
        (_g("enum", "string", "context", "raw", vocabulary="oi_buildup"), [
            ("oi_buildup", "OI buildup", "Futures positioning label derived from price and OI."),
        ]),
        (_g("enum", "string", "context", "raw", vocabulary="corporate_action_type"), [
            ("action_type", "Action type", "Kind of corporate event recorded."),
        ]),
        (_g("enum", "string", "context", "raw", vocabulary="trade_type"), [
            ("trade_type", "Trade side", "Buy or sell side of a deal."),
        ]),
        (_g("operational", "string", "context", "platform", vocabulary="job_status"), [
            ("last_status", "Last status", "Terminal status of the job's last run."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="data_quality_status"), [
            ("status", "Check status", "Result of a data-quality check."),
        ]),
        (_g("enum", "string", "context", "vendor", vocabulary="news_impact"), [
            ("impact", "Impact", "Expected market impact bucket of a news item."),
        ]),
        (_g("enum", "string", "context", "vendor", vocabulary="news_sentiment"), [
            ("sentiment", "Vendor sentiment", "Vendor's directional sentiment class."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="news_tone_label"), [
            ("tone_label", "FinBERT tone", "Tone class from the FinBERT ensemble."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="rrg_quadrant"), [
            ("quadrant", "Rotation quadrant", "Relative-rotation quadrant for the sector."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="screener_sentiment"), [
            ("inferred_sentiment", "Inferred sentiment", "Inferred directional bias of a "
                                                         "screener."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="screener_category"), [
            ("inferred_category", "Inferred category", "Inferred family of a screener."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="intraday_regime"), [
            ("intraday_regime", "Intraday regime", "Within-session risk state."),
        ]),
        (_g("enum", "string", "context", "platform", vocabulary="screener_tier"), [
            ("tier", "Screener tier", "Reliability tier assigned by the screener scorer."),
        ]),

        # ── semantic control-plane and canonical identity fields ───────────────
        (_g("identifier", "string", "context", "raw"), [
            ("contract_key", "Contract key", "Stable key for one versioned dataset contract."),
            ("feature_key", "Feature key", "Stable key for one versioned semantic feature definition."),
            ("partition_key", "Partition key", "Dataset partition represented by a completeness watermark."),
            ("mapping_key", "Mapping key", "Stable key for one provider-qualified identifier mapping."),
            ("node_key", "Node key", "Stable key for an instance-graph node."),
            ("assertion_key", "Assertion key", "Stable idempotency key for a graph assertion."),
            ("evidence_key", "Evidence key", "Stable key for source evidence or a decision evidence item."),
            ("claim_key", "Claim key", "Stable key for an explicit market claim."),
            ("decision_key", "Decision key", "Stable key for a served decision event."),
            ("source_ref", "Source reference", "Provider or source-row reference for a semantic assertion."),
            ("source_version", "Source version", "Version of the producer that emitted a watermark."),
            ("run_ref", "Run reference", "Run identifier associated with a watermark or decision."),
            ("extraction_version", "Extraction version", "Version of the extractor that produced evidence."),
            ("content_hash", "Content hash", "Hash of source evidence content for replay and deduplication."),
            ("property_name", "Semantic property name", "Authored ontology property represented by a feature definition."),
            ("ontology_version", "Ontology version", "Ontology release that authored a contract or definition."),
            ("contract_version", "Contract version", "Version of a dataset contract."),
            ("ranker_policy_version", "Ranker policy version", "Version of the deterministic decision policy."),
            ("feature_set_version", "Feature-set version", "Version of the feature snapshot used by a decision."),
            ("superseded_by", "Superseded by", "Key of a later claim that replaces this claim."),
        ]),
        (_g("dimension", "string", "context", "raw"), [
            ("dataset", "Dataset", "Logical dataset covered by a contract or watermark."),
            ("grain", "Grain", "Row identity and aggregation grain of a dataset."),
            ("cadence", "Cadence", "Expected refresh cadence of a dataset or contract."),
            ("time_semantics", "Time semantics", "Meaning of the dataset's timestamps in point-in-time use."),
            ("source_kind", "Source kind", "Whether a contract is authored, vendor, or platform-derived."),
            ("training_use", "Training use", "Whether and how a table may be used in model training."),
            ("semantic_type", "Semantic type", "Ontology semantic type of a property."),
            ("datatype", "Datatype", "Physical or logical datatype of a semantic property."),
            ("timing", "Timing", "Point-in-time timing class of a semantic property."),
            ("derivation", "Derivation", "How a semantic property came to exist."),
            ("leakage_risk", "Leakage risk", "Point-in-time leakage classification."),
            ("instrument_type", "Instrument type", "Kind of instrument represented by the canonical identity row."),
            ("market_segment", "Market segment", "Exchange segment such as equity."),
            ("listing_status", "Listing status", "Current or historical state of a listing."),
            ("node_type", "Node type", "Type of an instance-graph node."),
            ("predicate", "Predicate", "Typed relationship label in the instance graph."),
            ("source_type", "Evidence source type", "Kind of source that supplied evidence."),
            ("extraction_method", "Extraction method", "Method used to extract a claim or evidence item."),
            ("claim_status", "Claim status", "Observed, inferred, measured, contradicted, or rejected state."),
            ("decision_status", "Decision status", "Advisory, shadow, publishable, blocked, or expired state."),
            ("evidence_type", "Evidence type", "Kind of evidence attached to a decision."),
            ("confidence_kind", "Confidence kind", "Explicit semantics of a confidence value; never an assumed probability."),
            ("outcome_status", "Outcome status", "Pending, resolved, or invalid outcome state."),
            ("completeness_status", "Completeness status", "Whether an expected input partition is complete."),
            ("relation", "Evidence relation", "Supports, opposes, context, or veto relationship."),
            ("stance", "Claim stance", "Directional interpretation of a claim, if any."),
            ("quality_status", "Evidence quality status", "Unverified, candidate, verified, or rejected evidence state."),
            ("source_table", "Source table", "Physical table that supplied a decision or graph item."),
            ("metric", "Decision metric", "Named metric represented by decision evidence."),
            ("horizon", "Claim horizon", "Time horizon attached to a claim."),
        ]),
        (_g("text", "string", "context", "raw"), [
            ("legal_name", "Legal name", "Canonical issuer legal name."),
            ("pit_notes", "Point-in-time note", "Usage rule for a semantic property at an as-of boundary."),
            ("reason", "Reason", "Reason a mapping is ambiguous, unresolved, or rejected."),
            ("note", "Note", "Human-readable semantic or decision note; never evidence by itself."),
        ]),
        (_g("ratio", "decimal", "context", "platform", unit="probability"), [
            ("confidence", "Identity or evidence confidence", "Explicit confidence assigned to identity or evidence metadata."),
        ]),
        (_g("count", "integer", "context", "platform", unit="count"), [
            ("expected_rows", "Expected rows", "Expected row count for a completeness watermark."),
            ("accepted_rows", "Accepted rows", "Rows accepted for a completeness watermark."),
            ("rejected_rows", "Rejected rows", "Rows rejected or quarantined for a completeness watermark."),
            ("attempts", "Attempts", "Number of observed mapping attempts."),
        ]),
        (_g("flag", "boolean", "context", "platform"), [
            ("active", "Active contract", "Whether a versioned semantic contract is active."),
            ("usable_as_feature", "Usable as feature", "Whether the semantic property is permitted as a model input."),
            ("is_label", "Is label", "Whether the semantic property is an outcome target."),
        ]),
        (_g("timestamp", "timestamp", "context", "raw"), [
            ("valid_from", "Valid from", "Start of the interval in which an assertion is valid."),
            ("valid_to", "Valid to", "End of the interval in which an assertion is valid."),
            ("available_at", "Available at", "Earliest time the platform could know the assertion."),
            ("recorded_at", "Recorded at", "Time the platform recorded the assertion."),
            ("created_at", "Created at", "Time the semantic row was created."),
            ("updated_at", "Updated at", "Time the semantic row was last refreshed."),
            ("observed_at", "Observed at", "Time the source observation was made."),
            ("resolved_at", "Resolved at", "Time an outcome became final."),
            ("first_seen", "First seen", "First time a mapping gap was observed."),
            ("last_seen", "Last seen", "Most recent time a mapping gap was observed."),
        ]),
        (_g("json", "json", "context", "platform"), [
            ("attributes", "Semantic attributes", "Structured attributes attached to a canonical identity or graph node."),
            ("contract", "Data contract", "Machine-readable dataset contract payload."),
            ("physical_bindings", "Physical bindings", "Physical table/column bindings for a semantic feature."),
            ("candidate_instrument_ids", "Candidate instrument ids", "Candidate identities for an ambiguous mapping."),
            ("content", "Evidence content", "Source evidence content retained with provenance."),
            ("object_value", "Object value", "Typed object value carried by a graph assertion or claim."),
            ("model_versions", "Model versions", "Model artifacts used by a decision."),
            ("quality_snapshot", "Quality snapshot", "Data-quality state captured with a decision."),
            ("data_watermarks", "Data watermarks", "Completeness watermarks captured with a decision."),
            ("veto_reasons", "Veto reasons", "Structured reasons a decision was blocked or constrained."),
            ("guardrails", "Guardrails", "Decision guardrails applied at generation time."),
            ("value_json", "Decision evidence value", "Structured value attached to decision evidence."),
        ]),

        (_g("identifier", "string", "context", "raw"), [
            ("revision", "Revision", "Version or revision label attached to a graph node or source assertion."),
            ("source_uri", "Source URI", "Canonical URI for a retained evidence item."),
            ("source_key", "Source key", "Stable source-row key carried by a decision event."),
        ]),
        (_g("dimension", "string", "context", "raw"), [
            ("version", "Version", "Version label for a semantic definition or contract."),
            ("unit", "Unit", "Declared unit or measurement scale, when known."),
            ("knowledge_cutoff_kind", "Knowledge-cutoff kind", "How the decision cutoff was derived."),
        ]),
        (_g("ratio", "decimal", "context", "platform", unit="ratio"), [
            ("contribution", "Evidence contribution", "Optional signed contribution of evidence to a claim or decision."),
        ]),
        (_g("timestamp", "timestamp", "context", "raw"), [
            ("generated_at", "Generated at", "Time a decision or derived artifact was generated."),
            ("knowledge_cutoff", "Knowledge cutoff", "Upper bound on information knowable to a decision."),
            ("as_of", "As of", "Point-in-time boundary for a watermark or snapshot."),
            ("input_watermark", "Input watermark", "Upstream completeness boundary consumed by a producer."),
            ("output_watermark", "Output watermark", "Downstream boundary emitted by a producer."),
        ]),
        (_g("unit", "string", "context", "raw"), []),

        (_g("label", "string", "target", "label", leakage_risk="target", vocabulary="outcome"), [
            ("outcome", "Outcome",
             "Resolved result of a signal under its recorded labelling rule — the platform's "
             "primary supervised target."),
        ]),
        (_g("label", "string", "target", "label", leakage_risk="target",
            vocabulary="exit_reason"), [
            ("exit_reason", "Exit reason",
             "Why a tracked position closed. `NO_ENTRY_PRICE` and `SUSPECT_DATA` are integrity "
             "exits, not labels, and must be dropped before grading."),
        ]),
        (_g("label", "string", "target", "label", leakage_risk="target",
            vocabulary="label_definition"), [
            ("label_definition", "Label definition",
             "Which rule produced the label. Labels are NOT comparable across definitions — "
             "always filter on this column before aggregating accuracy."),
        ]),
        (_g("label", "decimal", "target", "label", leakage_risk="target", unit="percent"), [
            ("return_pct", "Realised return",
             "Terminal return over the horizon. Outcome-side: using it as a feature is a "
             "look-ahead bug."),
            ("mfe_pct", "Max favourable excursion",
             "Best unrealised gain inside the window. Outcome-side."),
            ("mae_pct", "Max adverse excursion",
             "Worst unrealised drawdown inside the window. Outcome-side."),
            ("max_return_pct", "Max return in window", "Peak return recorded for the signal."),
        ]),

        # ── text ───────────────────────────────────────────────────────────────
        (_g("text", "string", "context", "raw"), [
            ("title", "Title", "Headline text."),
            ("summary", "Summary", "Article or announcement summary."),
            ("description", "Description", "Free-form narrative field."),
            ("ai_insight", "AI insight", "Generated commentary attached to a signal."),
            ("trade_reasoning", "Trade reasoning",
             "Why the platform served this trade. Generated text — an explanation, not "
             "evidence."),
            ("last_error", "Last error", "Error string from the job's last failed run."),
            ("detail", "Detail", "Detail string from a data-quality check result."),
            ("url", "URL", "Source URL of the item."),
            ("target_url", "Target URL", "The concrete endpoint a registry row resolves to."),
            ("use_case", "Use case",
             "What a discovered endpoint is good for, in the registry's own words."),
            ("name", "Name", "Display name of the entity (screener name, index name, ...)."),
            ("client_name", "Client name", "Counterparty as reported on a deal."),
        ]),

        # ── JSON payloads (never fed raw to a model) ───────────────────────────
        (_g("json", "json", "context", "platform"), [
            ("signals_json", "Signals payload", "Serialized signal bundle for the row."),
            ("screener_names_json", "Screener names", "JSON array of contributing screeners."),
            ("screener_ids_json", "Screener ids", "JSON array of screener ids."),
            ("screener_weights_json", "Screener weights",
             "JSON map of screener id to the weight it carried at scoring time."),
            ("symbols_json", "Mentioned symbols",
             "JSON array of symbols a news item mentions. A mention is not a foreign key."),
            ("top_features_json", "Top features", "JSON list of a model's leading features."),
            ("features_json", "Regime features", "JSON payload of the regime model's inputs."),
            ("viterbi_path_json", "Viterbi path", "Decoded HMM state path."),
            ("payload_json", "Raw payload", "Raw vendor response body retained for replay."),
        ]),
        (_g("json", "json", "context", "platform", vocabulary="event_trigger_class"), [
            ("triggers", "Trigger classes",
             "Comma-joined trigger classes with inline thresholds (e.g. `CROWDED_NEWS p90`). "
             "Parse the class token, not the whole string."),
        ]),

        # ── sentiment measures ─────────────────────────────────────────────────
        (_g("ratio", "decimal", "leading", "platform", unit="score_minus1_1"), [
            ("sentiment_score", "Vendor sentiment score", "Vendor's numeric sentiment."),
            ("tone_score", "FinBERT tone score", "Ensemble tone score from the NLP model."),
        ]),

        # ── evidence-ledger measures ───────────────────────────────────────────
        (_g("ratio", "decimal", "context", "platform", unit="information_coefficient"), [
            ("rank_ic", "Rank IC",
             "Rank correlation between a factor and forward returns, computed per date then "
             "aggregated. Read alongside `eff_dates`, never on its own."),
            ("hit_auc", "Hit AUC", "Discrimination of the factor's sign for hit versus miss."),
        ]),
        (_g("score", "decimal", "coincident", "platform", unit="probability"), [
            ("ml_breakout_probability", "ML breakout probability",
             "Model probability of a breakout. A model output — not a feature."),
            ("ml_trend_probability", "ML trend probability",
             "Model probability of trend continuation. A model output — not a feature."),
        ]),

        # ── remaining vendor measures (units set in OVERRIDES) ─────────────────
        (_g("measure", "decimal", "coincident", "vendor"), [
            ("oi_change", "OI change", "Session-over-session open-interest change."),
            ("eps_actual", "EPS actual", "Reported EPS for the quarter."),
            ("eps_estimate", "EPS estimate", "Consensus EPS estimate for the quarter."),
            ("eps_surprise", "EPS surprise", "Actual minus estimate for EPS."),
            ("np_surprise", "Net-profit surprise", "Actual minus estimate for net profit."),
            ("target_mean", "Mean target price", "Consensus mean analyst target."),
            ("value_inr", "Value (INR)", "Transaction value in rupees, as a bare number."),
            ("value_cr", "Value (crore)",
             "Transaction value in CRORES, as a bare number. The multiplier is not declared "
             "anywhere in the schema — see alignment.py."),
            ("pcr", "Put-call ratio", "Index put-call ratio."),
            ("pcr_oi", "PCR (open interest)", "Put-call ratio measured on open interest."),
            ("iv_rank", "IV rank",
             "Where current implied volatility sits inside its own history."),
            ("current_price", "Current price", "Snapshot price at write time."),
            ("current_volume", "Current volume", "Snapshot volume at write time."),
        ]),

        # ── endpoint-catalog dimensions ────────────────────────────────────────
        (_g("dimension", "string", "context", "vendor"), [
            ("method", "HTTP method", "Request method a registry endpoint requires."),
            ("auth_type", "Auth type", "Credential class an endpoint needs, if any."),
            ("update_frequency", "Update frequency", "Declared cadence of an endpoint's data."),
            ("data_domain", "Data domain", "Registry's coarse domain classification."),
            ("category", "Category", "Registry's category classification."),
            ("scope", "Scope", "Whether an endpoint is per-symbol or whole-market."),
            ("url_template", "URL template", "Parameterized endpoint URL."),
            ("output_fields", "Output fields", "Fields an endpoint is known to return."),
        ]),

        # ── derivative leg values (CE/PE rows and futures rows) ────────────────
        (_g("measure", "decimal", "coincident", "vendor", unit="per_share_INR"), [
            ("option_premium", "Option premium", "Premium of an option leg (call or put)."),
            ("option_volume", "Option volume", "Contracts traded on that leg."),
            ("option_oi", "Option open interest", "Open interest on that leg."),
            ("option_iv", "Option implied volatility", "Implied volatility of that leg."),
            ("option_oi_chg_pct", "Option OI change percent",
             "Session-over-session OI change for that leg."),
            ("futures_price", "Futures price", "Price of the futures leg."),
            ("spot_price", "Spot price",
             "Underlying spot price captured at the same instant as the derivative."),
        ]),
        (_g("enum", "string", "context", "vendor", vocabulary="option_buildup"), [
            ("option_buildup", "Option buildup", "Leg-level positioning label."),
        ]),
    )


# Per-property exceptions to the group defaults. Anything surprising lives here rather than
# being buried in a group: merged unit/timing/leakage corrections and the point-in-time notes
# that make a column usable in a replay.
OVERRIDES: Dict[str, Dict] = {
    # A question asks for the "forward return"; the stored target is return_pct.
    "return_pct": {"synonyms": ("forward_return_pct", "fwd_return")},
    # units that a group default cannot know
    "open": {"unit": "per_share_INR"},
    "high": {"unit": "per_share_INR"},
    "low": {"unit": "per_share_INR"},
    "close": {"unit": "per_share_INR"},
    "vwap": {"unit": "per_share_INR"},
    "cmp": {"unit": "per_share_INR", "synonyms": ("ltp", "last price")},
    "current_price": {"unit": "per_share_INR", "synonyms": ("ltp",)},
    "entry_price": {"unit": "per_share_INR", "leakage_risk": "low"},
    "sma50": {"unit": "per_share_INR"},
    "sma200": {"unit": "per_share_INR"},
    "atr": {"unit": "per_share_INR"},
    "macd": {"unit": "per_share_INR"},
    "adx": {"unit": "index_points"},
    "rsi": {"unit": "index_points"},
    "strike": {"unit": "per_share_INR"},
    "max_pain": {"unit": "index_points"},
    "basis": {"unit": "per_share_INR"},
    "cost_of_carry_ann": {"unit": "percent"},
    "iv_rank": {"unit": "percent"},
    "target_mean": {"unit": "per_share_INR"},
    "eps_actual": {"unit": "per_share_INR"},
    "eps_estimate": {"unit": "per_share_INR"},
    "eps_surprise": {"unit": "per_share_INR"},
    "np_surprise": {"unit": "crore_INR"},
    "open_interest": {"unit": "contracts"},
    "oi_change": {"unit": "contracts"},
    "pcr": {"unit": "ratio"},
    "pcr_oi": {"unit": "ratio"},
    "market_cap": {
        "unit": "INR_or_crore_UNDECLARED",
        "timing": "lagging",
        "synonyms": ("mcap", "market capitalization"),
        "pit_notes": "The stored unit is declared nowhere in the schema. Do not aggregate "
                     "this column across tables without establishing the scale first.",
    },
    "value_inr": {
        "timing": "coincident",
        "synonyms": ("transaction_value",),
        "pit_notes": "Rupees as a bare number; no currency term is attached to the column.",
    },
    "value_cr": {
        "timing": "coincident",
        "pit_notes": "CRORES as a bare number. Multiplying by 1e7 gives rupees, but nothing "
                     "in the schema says so — the assumption must be stated by any consumer.",
    },

    # timing corrections: these are knowable only after the fact
    "delivery_pct": {
        "timing": "lagging",
        "synonyms": ("delivery_percentage", "deliv_pct"),
        "pit_notes": "NSE publishes delivery data after the session closes, so it is T+1 at "
                     "best. A signal dated the same session cannot have used it.",
    },
    "delivery_qty": {"timing": "lagging", "pit_notes": "Same T+1 publication lag as `delivery_pct`."},
    "fii_3d_net": {"timing": "lagging"},
    "dii_3d_net": {"timing": "lagging"},
    "pledge_pct": {"timing": "lagging"},

    # leakage corrections
    "exit_price": {
        "unit": "per_share_INR",
        "leakage_risk": "high",
        "synonyms": ("exit",),
        "pit_notes": "Outcome-side column: it exists only because the horizon has elapsed.",
    },
    "check_date": {
        "leakage_risk": "high",
        "pit_notes": "Reveals that the horizon elapsed, which is itself information.",
    },
    "regime_prob": {"timing": "context"},

    # point-in-time notes
    "signal_date": {
        "pit_notes": "Entry is taken at the NEXT session's open. A feature dated on "
                     "`signal_date` must have been knowable before that open.",
    },
    "as_of_date": {
        "pit_notes": "The snapshot date, not the period it describes. Vendor fundamentals "
                     "describe a quarter that ended weeks earlier.",
    },
    "ex_date": {
        "pit_notes": "Prices before the ex-date are on the pre-action basis; the adjustment "
                     "factor must be applied before comparing across it.",
    },
    "published_at": {
        "timing": "leading",
        "pit_notes": "An item is knowable only from this instant — never from the event it "
                     "reports.",
    },
    "computed_at": {
        "pit_notes": "TEXT in `unified_recommendations`, native TIMESTAMPTZ in "
                     "`confluence_signals`. Cast explicitly before comparing across the two.",
    },
    "horizon_days": {
        "pit_notes": "A property of the evaluation setup, not of the market. Including it as "
                     "a feature lets a model learn the label definition.",
    },
}


def properties() -> Tuple[PropertyDef, ...]:
    """Flatten `_groups()` + `OVERRIDES` into validated `PropertyDef` instances."""
    out: list = []
    for defaults, rows in _groups():
        for name, label, description in rows:
            kw = dict(defaults)
            kw.update(OVERRIDES.get(name, {}))
            pit = kw.pop("pit_notes", "")
            synonyms = kw.pop("synonyms", ())
            out.append(P(
                name, label, kw.pop("semantic_type"), description,
                datatype=kw.pop("datatype"),
                unit=kw.pop("unit"),
                timing=kw.pop("timing"),
                derivation=kw.pop("derivation"),
                leakage_risk=kw.pop("leakage_risk"),
                vocabulary=kw.pop("vocabulary"),
                pit_notes=pit,
                synonyms=synonyms,
            ))
            if kw:
                raise ValueError(
                    f"property {name}: unrecognised override keys {sorted(kw)}")
    return tuple(out)
