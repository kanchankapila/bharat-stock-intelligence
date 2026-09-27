"""
Typed edges of the market knowledge graph.

Each relation names its domain, range, cardinality, the physical table(s) that realize it,
the join keys that traverse it, and — the part that matters most on this platform — its
**graded status**: how much measured evidence exists that the edge carries information.

A relation at `graded_status="research-candidate"` is not a claim. It is a named experiment.
That distinction is the whole reason `graded_status` exists here rather than a boolean
`valid` flag.
"""
from typing import Tuple

from ..model import RelationDef

R = RelationDef


def relations() -> Tuple[RelationDef, ...]:
    return (
        # ── instrument-centric observation edges ────────────────────────────────
        R("instrumentHasBar", "has daily bar", "Equity", "Bar", "1:N",
          "Every daily bar for an instrument. The universal time-series edge and the "
          "substrate of every return calculation.",
          realized_by=("stock_ohlcv", "stock_master"), join_keys=("symbol", "date"),
          graded_status="live",
          via="stock_ohlcv.symbol = stock_master.symbol"),

        R("instrumentHasIntradayBar", "has intraday bar", "Equity", "IntradayBar", "1:N",
          "Sub-daily bars for an instrument, at a single interval over recent history.",
          realized_by=("intraday_ohlcv", "stock_master"), join_keys=("symbol", "datetime"),
          graded_status="live"),

        R("instrumentHasDelivery", "has delivery observation", "Equity",
          "DeliveryObservation", "1:N",
          "Exchange delivery data per session: the ownership-behaviour edge, and one of the "
          "links the master report explicitly names as unquantified.",
          realized_by=("stock_delivery_data", "stock_master"), join_keys=("symbol", "date"),
          graded_status="research-candidate",
          evidence="Master report §6 marks delivery-to-swing-returns as an unquantified "
                   "link; ungraded by factor_edge.py to date. The T+1 lag is why it is not "
                   "usable same-session."),

        R("instrumentHasCorporateAction", "has corporate action", "Equity",
          "CorporateAction", "1:N",
          "Capital-structure events with their ex-dates — the edge that governs price "
          "adjustment and event-aware risk filtering.",
          realized_by=("corporate_actions", "stock_master"), join_keys=("symbol", "ex_date"),
          graded_status="live"),

        R("instrumentHasFundamentalSnapshot", "has fundamental snapshot", "Equity",
          "FundamentalSnapshot", "1:N",
          "Dated vendor fundamental snapshots. Lagging information: the edge is only "
          "point-in-time honest when filtered on the as-of date.",
          realized_by=("fundamentals_history", "stock_master"),
          join_keys=("symbol", "as_of_date"), graded_status="measured",
          evidence="Book-to-price measured not significant on this platform; the edge is "
                   "retained for conditioning rather than for a standalone reading."),

        R("instrumentHasAnalystEstimate", "has analyst estimate", "Equity",
          "AnalystEstimate", "1:N",
          "Consensus snapshots per as-of date — the leading edge in the fundamentals family.",
          realized_by=("analyst_estimates_history", "stock_master"),
          join_keys=("symbol", "as_of_date"), graded_status="ungraded",
          evidence="The revision trio from this table is calendar-blocked to ~2026-10."),

        R("instrumentHasEarningsSurprise", "has earnings surprise", "Equity",
          "EarningsSurprise", "1:N",
          "Per-quarter actual-versus-estimate surprise. Join runs through the vendor scid "
          "map as well as the symbol.",
          realized_by=("eps_surprise_history", "mc_scid_map", "stock_master"),
          join_keys=("symbol", "quarter"), graded_status="ungraded"),

        R("instrumentHasInsiderTransaction", "has insider transaction", "Equity",
          "InsiderTransaction", "1:N",
          "Insider filings — graded weak standalone, so this edge feeds confluence rather "
          "than the ranker directly.",
          realized_by=("insider_trades", "stock_master"), join_keys=("symbol", "date"),
          graded_status="measured",
          evidence="Net insider flow measured NOT SIGNIFICANT as a standalone factor; "
                   "retained as a confluence input only."),

        R("instrumentHasBlockDeal", "has block deal", "Equity", "BlockDeal", "1:N",
          "Off-book transactions. Features derived from this edge exist downstream but carry "
          "no standalone reading.",
          realized_by=("block_deals", "stock_master"), join_keys=("symbol", "date"),
          graded_status="measured"),

        R("instrumentHasMFHolding", "has mutual-fund holding", "Equity", "MFHolding", "1:N",
          "Disclosure-grain mutual-fund ownership per instrument.",
          realized_by=("stock_mf_holdings", "stock_master"), join_keys=("symbol", "date"),
          graded_status="ungraded"),

        R("instrumentHasOptionChain", "has option chain", "Equity", "OptionChainRow", "1:N",
          "Per-strike option grid for a stock. A grid, not a series: traversing it multiplies "
          "rows, so any aggregation must be explicit.",
          realized_by=("so_option_chain", "stock_master"),
          join_keys=("symbol", "date", "expiry", "strike"), graded_status="ungraded"),

        R("instrumentHasFuturesPositioning", "has futures positioning", "Equity",
          "FuturesPositioning", "1:N",
          "Stock-futures open interest and rollover state per expiry.",
          realized_by=("stock_futures_oi_history", "fno_rollover", "stock_master"),
          join_keys=("symbol", "date", "expiry"), graded_status="low-data",
          evidence="~14 dates of stock-level panel. Master-report verdict: LOW-DATA. Any "
                   "reading here is a calendar artefact."),

        # ── derived & outcome edges ─────────────────────────────────────────────
        R("instrumentHasFeatureVector", "has feature vector", "Equity", "FeatureVector", "1:N",
          "The rolling feature panel per instrument and date — the training substrate.",
          realized_by=("feature_store", "stock_master"), join_keys=("symbol", "date"),
          graded_status="live"),

        R("instrumentHasTechnicalSignal", "has technical signal", "Equity",
          "TechnicalSignal", "1:N",
          "The wide indicator panel per instrument and date, including the regime stamp.",
          realized_by=("technical_signals", "stock_master"), join_keys=("symbol", "date"),
          graded_status="live"),

        R("instrumentServedRecommendation", "was served a recommendation", "Equity",
          "Recommendation", "1:N",
          "Served trades per instrument, timeframe and computation instant.",
          realized_by=("unified_recommendations", "unified_recommendations_history",
                       "stock_master"),
          join_keys=("symbol", "computed_at", "timeframe"), graded_status="live",
          synonyms=("has_recommendation",)),

        R("signalResolvedToOutcome", "resolved to outcome", "TechnicalSignal",
          "SignalOutcome", "N:1",
          "A signal's resolved result. Traversal must also pin the horizon and the labelling "
          "rule, or outcomes from incompatible definitions get mixed together.",
          realized_by=("signal_outcomes", "technical_signals"),
          join_keys=("symbol", "signal_date", "horizon_days"), graded_status="live"),

        R("outcomeHasExcursion", "has excursion path", "SignalOutcome", "SignalExcursion",
          "1:1",
          "Intra-window path statistics for an outcome — what makes stop-placement studies "
          "possible at all.",
          realized_by=("signal_excursions", "signal_outcomes"),
          join_keys=("symbol", "signal_date", "horizon_days"), graded_status="live"),

        R("newsMentionsInstrument", "mentions instrument", "NewsItem", "Equity", "N:M",
          "Article-to-symbol mentions, traversed through the link table rather than the JSON "
          "array on the news row.",
          realized_by=("news_symbol_link", "news_sentiment_items", "stock_master"),
          join_keys=("news_id", "symbol"), graded_status="measured",
          evidence="News-sentiment conditioning on movers measured a lift of ~0.13 "
                   "(n=114, p=0.037) — a lead, not a result."),

        R("instrumentHasEventTrigger", "has event trigger", "Equity", "EventTrigger", "1:N",
          "Detector output per instrument and date: which composite trigger classes fired.",
          realized_by=("stock_event_triggers", "stock_master"), join_keys=("symbol", "date"),
          graded_status="ungraded"),

        R("instrumentHasMoverSnapshot", "has mover snapshot", "Equity", "MoverSnapshot",
          "1:N",
          "Vendor mover-list appearances per instrument and capture — the within-day event "
          "backbone the mover studies are built on.",
          realized_by=("mover_snapshots", "stock_master"),
          join_keys=("symbol", "trade_date"), graded_status="measured",
          evidence="Mover study re-run 2026-09-19 over ~359k events; relative-strength-"
                   "versus-NIFTY lift measured at 2.05 on breakout movers (n=114)."),

        # ── candidate, context, evidence & lineage edges ────────────────────────
        R("screenerSurfacesInstrument", "surfaces instrument", "Screener", "Equity", "N:M",
          "Live screener surfacing events: the platform's largest pre-labelled candidate "
          "stream.",
          realized_by=("live_screener_appearances", "screener_master", "stock_master"),
          join_keys=("filter_key", "symbol"), graded_status="live"),

        R("appearanceHasOutcome", "appearance has outcome", "ScreenerAppearance",
          "ScreenerOutcome", "1:1",
          "Forward returns pre-computed for a surfacing event at 1, 3 and 5 sessions.",
          realized_by=("live_screener_outcomes", "live_screener_appearances"),
          join_keys=("appearance_id", "symbol"), graded_status="live"),

        R("indexHasDerivativesSnapshot", "has derivatives snapshot", "Index",
          "IndexDerivativesSnapshot", "1:N",
          "Index-level positioning: PCR (intraday and EOD), max pain and aggregate open "
          "interest.",
          realized_by=("index_max_pain", "nt_index_pcr_ts"), join_keys=("index_name", "date"),
          graded_status="ungraded",
          evidence="Deep index panel, but ungraded as a standalone signal — carried as a "
                   "research candidate in the master report."),

        R("regimeConditionsBar", "conditions bar", "RegimeState", "Bar", "1:N",
          "The regime attached to a session's bars. The regime's job here is to gate engine "
          "weights, so this is a conditioning path rather than a signal.",
          realized_by=("market_regimes", "stock_ohlcv"), join_keys=("date",),
          graded_status="live", evidence="REGIME_WEIGHTS is a live gate in the ranker blend."),

        R("regimeModulatesEngineWeight", "modulates engine weight", "RegimeState",
          "EngineScore", "1:N",
          "The regime's effect on the engine blend for that session — the platform's only "
          "live use of regime state.",
          realized_by=("market_regimes", "engine_composite_scores"), join_keys=("date",),
          graded_status="live",
          evidence="The per-regime engine edge table the master report asks for "
                   "(regime_edge_status) is still to be built — so the gate is live but its "
                   "calibration is not tracked."),

        R("sectorRotationInformsInstrument", "informs instrument relative strength",
          "SectorRotationPoint", "Equity", "N:M",
          "Sector rotation quadrant as an input to a stock's relative strength — explicitly "
          "an unquantified link.",
          realized_by=("sector_rrg_history", "technical_signals"),
          join_keys=("sector",), graded_status="research-candidate",
          evidence="Master report §6 lists sector-to-stock relative strength among the "
                   "missing quantified links (Experiment 3)."),

        R("edgeReadingGatesModelInput", "gates model input", "EdgeReading",
          "ModelArtifact", "N:1",
          "A graded factor reading as the evidence behind promoting or dropping a model "
          "input.",
          realized_by=("factor_edge_history", "model_registry"),
          join_keys=("run_at",), graded_status="measured"),

        R("modelProducesImportance", "produces feature importance", "ModelArtifact",
          "FeatureImportance", "1:N",
          "Per-run feature importance for a registered model version.",
          realized_by=("feature_importance_log", "model_registry"), join_keys=("model_name",),
          graded_status="live"),

        R("endpointServesObservation", "serves observation", "Endpoint", "Observation",
          "N:M",
          "Which discovered endpoint can populate which observation class — the sourcing map "
          "consulted when a provider route stops returning data.",
          realized_by=("market_endpoint_registry", "url_endpoints"), join_keys=("uid",),
          graded_status="live",
          evidence="Registry views v_working_market_endpoints / v_stock_screeners / "
                   "v_fno_endpoints are the sanctioned alternate-lookup surface."),

        R("issuerIssuesInstrument", "issues instrument", "Issuer", "Instrument", "1:N",
          "An issuer can issue multiple instruments; the canonical link is ISIN-aware and "
          "provisional identities are never name-merged.",
          realized_by=("market_issuer", "market_instrument"), join_keys=("issuer_id",),
          graded_status="live"),

        R("instrumentHasListing", "has listing", "Instrument", "Listing", "1:N",
          "An instrument can be listed on one or more exchanges/segments; symbol changes "
          "create listing intervals rather than changing instrument identity.",
          realized_by=("market_instrument", "market_listing"), join_keys=("instrument_id",),
          graded_status="live"),

        R("instrumentHasProviderIdentifier", "has provider identifier", "Instrument",
          "ProviderIdentifier", "1:N",
          "Provider and scheme qualify every external identifier; ambiguous mappings remain "
          "explicit gaps.",
          realized_by=("market_instrument", "market_identifier", "market_identifier_gap"),
          join_keys=("instrument_id",), graded_status="live"),

        R("graphNodeConnects", "connects to", "GraphNode", "GraphNode", "1:N",
          "Typed bitemporal assertions in the instance graph, including literal object values.",
          realized_by=("market_graph_node", "market_graph_edge"),
          join_keys=("from_node_id", "to_node_id"), graded_status="live"),

        R("evidenceSupportsClaim", "supports claim", "EvidenceRecord", "MarketClaim", "N:M",
          "Source evidence is linked to a claim with supports, opposes, or context semantics; "
          "the link is not itself a causal proof.",
          realized_by=("market_evidence", "market_claim", "market_claim_evidence"),
          join_keys=("evidence_key", "claim_key"), graded_status="ungraded"),

        R("decisionHasEvidence", "has evidence", "DecisionEvent", "EvidenceRecord", "1:N",
          "Structured support, contradiction, context, and veto evidence attached to an "
          "append-only decision event.",
          realized_by=("market_decision_event", "market_decision_evidence"),
          join_keys=("decision_key", "evidence_key"), graded_status="live"),

        R("decisionHasOutcome", "has outcome", "DecisionEvent", "DecisionOutcome", "1:N",
          "Realized outcomes are attached under an explicit label definition and horizon.",
          realized_by=("market_decision_event", "market_decision_outcome"),
          join_keys=("decision_key", "label_definition", "horizon_days"), graded_status="live"),

        R("contractDescribesFeature", "describes feature", "DataContract", "FeatureDefinition",
          "N:M", "A data contract and materialized feature definition jointly constrain safe use.",
          realized_by=("market_data_contract", "semantic_feature_definition"),
          join_keys=("ontology_version", "version"), graded_status="live"),

        R("watermarkGatesDecision", "gates decision", "DataWatermark", "DecisionEvent", "1:N",
          "Completeness state is captured with a decision; freshness alone is not completeness.",
          realized_by=("market_data_watermark", "market_decision_event"),
          join_keys=("dataset", "partition_key"), graded_status="live"),

        R("jobProducesOutput", "produces output", "JobRun", "PlatformOutput", "1:N",
          "Lineage from a scheduled job to the derived outputs it writes.",
          realized_by=("job_heartbeat",), join_keys=("job_name",), graded_status="live"),
    )
