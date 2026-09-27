"""
Entity classes — what exists in this market dataset.

The abstraction tree is shallow on purpose. Each concrete class maps to a physical table
(or a small set of sibling tables), because that is what a consumer needs to look up: they
have a column and want to know what kind of thing it describes. FIBO-style conceptual
decomposition (the Equity / Share / Listing split) is recorded in `alignment.py` instead of
being imposed on a schema that cannot support it.
"""
from typing import Tuple

from ..model import ClassDef

C = ClassDef


def classes() -> Tuple[ClassDef, ...]:
    out: list = []

    # ── identity ──────────────────────────────────────────────────────────────
    out += [
        C("Instrument", "Instrument", "identity",
          "Anything that is quoted and traded. The canonical instrument identity is table-backed "
          "in `market_instrument`; legacy observation tables still key on the exchange ticker.",
          key_properties=("instrument_key",), grain="instrument_key", realization="table"),

        C("Issuer", "Issuer", "identity",
          "The legal issuer behind one or more instruments. ISIN issuer-prefix keys are "
          "authoritative when a checksum-valid ISIN is available; symbol-only rows remain "
          "explicitly provisional.",
          key_properties=("issuer_key",), grain="issuer_key", realization="table"),

        C("Listing", "Listing", "identity",
          "One tradable exchange/segment/symbol representation of an instrument.",
          parents=("Instrument",), key_properties=("listing_key",),
          grain="listing_key", realization="table"),

        C("ProviderIdentifier", "Provider identifier", "identity",
          "A provider-qualified identifier for an instrument. Provider and scheme are part of "
          "the identity; collisions are recorded rather than resolved by row order.",
          key_properties=("provider", "scheme", "identifier_value"),
          grain="(provider, scheme, identifier_value)", realization="table"),

        C("Equity", "Equity", "identity",
          "A listed equity, one row per exchange ticker. This is the platform's universal "
          "join key and the subject of every other class.",
          parents=("Instrument",), key_properties=("symbol", "isin"),
          grain="one row per exchange ticker in `stock_master`",
          caveats=(
              "Keyed on ticker, not ISIN: a company listed on both NSE and BSE is two rows "
              "here and one instrument in any ISIN-first model (see alignment.py).",
              "`stock_master.sector` was EMPTY for every row as of 2026-09-21; sector is "
              "populated downstream (technical_signals.sector, unified_recommendations.sector).",
          )),

        C("Index", "Index", "identity",
          "A market index used as a benchmark or as a derivatives underlying (NIFTY 50, "
          "BANK NIFTY, SENSEX, INDIA VIX, GIFT NIFTY, ...).",
          key_properties=("index_name",), grain="one row per index", realization="reference",
          caveats=("A *reference* class: the index exists only as a column value on "
                   "`nt_index_pcr_ts`, `index_ohlcv`, `nt_fno_expiry` and the option tables. "
                   "`stock_master` carries no index master, so an index is whatever a "
                   "fetcher wrote — normalise case before joining across tables.",)),

        C("Sector", "Sector", "identity",
          "An industry grouping used for relative-strength and rotation analysis. Stored as "
          "free text across several tables rather than resolved to a scheme.",
    # Realization is declared explicitly on the classes that lack a dedicated table
    # (Exchange, Sector, Index, Regime, ...). See ClassDef.realization.

          key_properties=("sector",), grain="one row per label, no canonical table",
          realization="reference",
          caveats=("A *reference* class with no master table: the label comes from whichever "
                   "fetcher wrote the row (`technical_signals.sector`, "
                   "`unified_recommendations.sector`), so cross-table sector joins can "
                   "silently lose or double-count names. Resolve to a spelling before "
                   "aggregating.",)),

        C("Exchange", "Exchange", "identity",
          "The venue an instrument is admitted to. A two-value dimension (NSE / BSE): usually "
          "encoded inside `symbol`, but carried as its own column in seven tables "
          "(nse_stocks, market_holidays, nt_fno_expiry, stock_earnings_dates, "
          "institutional_deal_signals, mc_advance_decline, mc_chart_patterns).",
          key_properties=("exchange",), grain="dimension", realization="reference",
          caveats=("A *reference* class: it has no card because no single table is the "
                   "exchange. `nse_stocks.exchange` is the canonical column and the other six "
                   "are pass-through copies written by different fetchers.",)),

        C("ScripCodeMapping", "Vendor scrip-code mapping", "identity",
          "The vendor's private scid mapped onto the platform symbol and issuer name — the "
          "only sanctioned route from one to the other.",
          key_properties=("scid", "symbol"), grain="(scid, symbol)",
          caveats=("Not enforced as unique: after a vendor scrip merge, one symbol can appear "
                   "under more than one scid, so a symbol->scid join can fan out.",)),

        C("CompanyProfile", "CompanyProfile", "identity",
          "Narrative and high-level attributes about the issuer behind a ticker.",
          parents=("Instrument",), key_properties=("symbol",), grain="one row per symbol",
          caveats=("Description text is vendor-authored and free-form; `growth_score` and "
                   "`ai_analysis` are derived, not observed.",)),
    ]

    # ── observations ──────────────────────────────────────────────────────────
    out += [
        C("Observation", "Observation", "observation",
          "Abstract parent for anything measured at a point in time without the platform "
          "adding an opinion to it. Raw or vendor-supplied; never a label.",
          key_properties=("symbol",), realization="abstract"),

        C("Bar", "Daily bar", "observation",
          "One daily OHLCV bar per symbol per trading session — the platform's only "
          "self-owned source of truth.",
          parents=("Observation",), key_properties=("symbol", "date"),
          grain="(symbol, date)",
          caveats=(
              "Price basis is recorded per row in `adjustment_basis` "
              "(nse_bhavcopy_raw | split_only | split_dividend). Mixing bases inside one "
              "series corrupts any backtest silently — this is a documented recurring bug "
              "class in this repo.",
              "Quarantined bars are flagged, not deleted: filter `is_suspect = 0` before "
              "building a training panel. `suspect_reason` names the cause.",
          )),

        C("IntradayBar", "Intraday bar", "observation",
          "Sub-daily OHLCV with VWAP. Currently a single interval (15m) of recent history.",
          parents=("Observation",), key_properties=("symbol", "datetime", "series"),
          grain="(symbol, datetime, series)",
          caveats=("Shallow history relative to the daily panel; not a substitute for "
                   "`stock_ohlcv` in any long-horizon study.",
                   "The key's `series` property is the bar interval (`15m`), NOT an NSE series "
                   "symbol — the same `series` property is overloaded across the schema "
                   "(see its bindings), so a join must qualify the table too.",
                   "3.88M rows are stored in a single `datetime` column that mixes the "
                   "exchange date and the clock time; it is a TIMESTAMP, not a trading-date "
                   "column, so it does not join to `stock_ohlcv.date` without a cast.",)),

        C("DeliveryObservation", "Delivery observation", "observation",
          "The deliverable-to-traded quantity ratio — the highest-frequency "
          "ownership-behaviour proxy the platform owns, and a T+1 lag by construction.",
          parents=("Observation",), key_properties=("symbol", "date"),
          grain="(symbol, date)",
          caveats=("Two writers exist (`stock_delivery_data`, `stock_delivery_volume`) with "
                   "different column names and different series coverage — check which one a "
                   "study used.",)),
    ]
    # ── events, fundamentals & flow ───────────────────────────────────────────
    out += [
        C("CorporateAction", "Corporate action", "observation",
          "A capital-structure event with a price consequence (dividend, split, bonus, "
          "rights) plus the record/ex dates that make it usable point-in-time.",
          parents=("Observation",), key_properties=("symbol", "ex_date", "action_type"),
          grain="(symbol, ex_date, action_type)",
          caveats=("The same table also carries `Quarterly Results` rows, which are not "
                   "capital actions at all — filter `action_type` before computing an "
                   "adjustment factor.",)),

        C("FundamentalSnapshot", "Fundamental snapshot", "observation",
          "Vendor-supplied accounting ratios and market-cap for a symbol, captured with an "
          "as-of date. Lagging information: the publication delay is the point-in-time risk.",
          parents=("Observation",), key_properties=("symbol", "as_of_date"),
          grain="(symbol, as_of_date)",
          caveats=("Vendor restatements make re-fetched history differ from what was known "
                   "at the time; only the as-of-captured row is point-in-time honest.",)),

        C("AnalystEstimate", "Analyst estimate", "observation",
          "Consensus ratings, target prices and next-period estimates captured as a dated "
          "snapshot. Genuinely leading information; short panel relative to the news table.",
          parents=("Observation",), key_properties=("symbol", "as_of_date"),
          grain="(symbol, as_of_date)",
          caveats=("The revision trio (eps/target revision, analyst-count change) is carried "
                   "downstream into `technical_signals` and is not yet graded.",)),

        C("EarningsSurprise", "Earnings surprise", "observation",
          "Actual versus estimated net profit and revenue for a quarter, with the surprise "
          "computed per line. Coincident for the print, leading for the drift after it.",
          parents=("Observation",), key_properties=("symbol", "series"),
          grain="(symbol, quarter)",
          caveats=("Keyed by vendor `scid` in the source table while every other table keys "
                   "on `symbol` — the join runs through `mc_scid_map`.",
                   "The `quarter` column is MISNAMED: it holds a result DATE rendered as free "
                   "text (`'May 30, 2026'`), not a fiscal-quarter label, so it will not sort "
                   "lexicographically and will not parse as an ISO date. Cast at read time.",
                   "`scid` is stored as TEXT, so the symbol join is a string match, not a "
                   "numeric one.",)),

        C("InsiderTransaction", "Insider transaction", "observation",
          "A promoter/insider buy or sell filing. Leading in principle; graded weak as a "
          "standalone signal on this platform and kept as a confluence input.",
          parents=("Observation",), key_properties=("symbol", "date", "company_name",
                                                     "trade_type"),
          grain="(symbol, date, acquirer, transaction)",
          caveats=("Filed with a lag; treat the filing date as the earliest knowable time, "
                   "not the trade date.",
                   "`acquirerName` is vendor free text, NOT a foreign key to `stock_master` — "
                   "it cannot be joined to a symbol and must be matched by name at best.",
                   "`valueInr` is rupees as a bare number with no currency or unit column, "
                   "unlike `block_deals.value_cr` which is crores. Same semantic field, two "
                   "different multipliers; do not union them without normalising.",)),

        C("BlockDeal", "Block / bulk deal", "observation",
          "An off-book or bulk transaction with quantity, price and value. Value is stored "
          "in CRORES as a bare number, with no currency or unit term attached.",
          parents=("Observation",), key_properties=("symbol", "date", "id"),
          grain="(symbol, date, deal)",
          caveats=("`trade_type` is stored in mixed case by different fetchers — normalise "
                   "with UPPER() before aggregating buys and sells.",)),

        C("MFHolding", "Mutual-fund holding", "observation",
          "Aggregate mutual-fund ownership of a symbol: holding percentage, fund count and "
          "the change versus the previous disclosure.",
          parents=("Observation",), key_properties=("symbol", "date"),
          grain="(symbol, disclosure date)"),

        C("NewsItem", "News item", "observation",
          "A news article or exchange announcement with vendor sentiment, a FinBERT tone "
          "ensemble, an impact bucket and the symbols it mentions. 15 years deep — the only "
          "panel here that supports a real event study.",
          parents=("Observation",), key_properties=("id",),
          grain="one row per article/announcement",
          caveats=("Two sentiment sources coexist (`sentiment` from the vendor, `tone_*` from "
                   "FinBERT) and can disagree; `sentiment_conflict` flags it. Whichever one a "
                   "study used must be stated.",
                   "`symbols_json` is a JSON array — a mention is NOT a foreign key. Join "
                   "through `news_symbol_link` or the JSON expansion, never by string match.",)),
    ]

    # ── derivatives ──────────────────────────────────────────────────────────
    out += [
        C("OptionChainRow", "Option chain row", "observation",
          "One strike, one expiry, one session: call and put leg premium, volume, open "
          "interest, IV and greeks. A grid, not a time series.",
          parents=("Observation",),
          key_properties=("symbol", "date", "expiry", "strike"),
          grain="(symbol, date, expiry, strike)",
          caveats=("Index panels are deep; STOCK option panels are shallow. Any stock-level "
                   "derivatives study inherits that shallow panel.",)),

        C("FuturesPositioning", "Futures positioning", "observation",
          "Stock-futures open interest, buildup label, rollover percentage, basis and "
          "cost of carry for one expiry and session.",
          parents=("Observation",), key_properties=("symbol", "date", "expiry"),
          grain="(symbol, date, expiry)",
          caveats=("LOW-DATA: the stock-futures panel covers roughly two weeks of dates. Any "
                   "'measured' claim built on it is a calendar artefact, not an edge — this "
                   "is the specific finding the master report's LOW-DATA verdict records.",)),

        C("IndexDerivativesSnapshot", "Index derivatives snapshot", "observation",
          "Index-level positioning: PCR (single-strike time series and EOD), max pain, and "
          "aggregate call/put open interest.",
          parents=("Observation",), key_properties=("index_name", "date", "expiry"),
          grain="(index_name, date, expiry)",
          caveats=("The index panel is far deeper than the stock panel but remains ungraded "
                   "as a standalone signal — treated here as a research candidate.",)),

        C("MoverSnapshot", "Mover snapshot", "observation",
          "A ranked intraday mover list entry from a vendor feed: the platform's within-day "
          "event backbone alongside the event triggers.",
          parents=("Observation",),
          key_properties=("source", "date", "symbol", "rank_position"),
          grain="(source, trade_date, symbol, rank)",
          caveats=("Rank is per source per capture, so a rank is only comparable within one "
                   "source and one instant.",)),
    ]

    # ── market context ───────────────────────────────────────────────────────
    out += [
        C("RegimeState", "Regime state", "context",
          "The macro regime for a session, with its posterior probability and the decoded "
          "HMM path. Also covers the intraday regime panel.",
          key_properties=("date",), grain="one row per date",
          caveats=("This is a weight GATE on this platform — it re-blends engine weights — "
                   "not a directional signal. Treating a regime label as alpha inverts its "
                   "role.",)),

        C("BreadthObservation", "Breadth observation", "context",
          "Market-wide participation statistics: share of the universe above its 200-day "
          "average, advance/decline ratio, net highs minus lows.",
          key_properties=("date",), grain="one row per date",
          caveats=("Computed over this platform's own universe definition, so the numbers "
                   "are not comparable to a vendor's breadth series without re-basing.",)),

        C("SectorRotationPoint", "Sector rotation point", "context",
          "Weekly relative-rotation coordinates and quadrant per sector — the intended input "
          "to sector-plus-stock relative strength.",
          key_properties=("sector", "week_date"), grain="(sector, week_date)",
          caveats=("The sector-to-stock relative-strength link is a RESEARCH CANDIDATE: the "
                   "master report names it as an experiment, not an established edge.",)),
    ]

    # ── derived intelligence ─────────────────────────────────────────────────
    out += [
        C("PlatformOutput", "Platform output", "derived",
          "Abstract parent for anything this platform computes and serves. Every subclass is "
          "an OPINION of this system, not an observation of the market.",
          key_properties=("symbol",), realization="abstract"),

        C("FeatureVector", "Feature vector", "derived",
          "The rolling per-symbol, per-date feature panel the models train on. Features, not "
          "information: they re-express price, flow and vendor data.",
          parents=("PlatformOutput",), key_properties=("symbol", "date", "timeframe"),
          grain="(symbol, date, timeframe)",
          caveats=("A feature's meaning is defined by `feature_engineering.py` at a specific "
                   "commit, not by this ontology. Cite the feature version when a result "
                   "depends on it.",
                   "Pre-rebuild rows are not comparable with post-rebuild rows.",)),

        C("TechnicalSignal", "Technical signal", "derived",
          "The wide per-symbol, per-date technical panel: indicators, regime stamp, flow and "
          "fundamental context columns, plus the model's probability outputs.",
          parents=("PlatformOutput",), key_properties=("symbol", "date"),
          grain="(symbol, date)",
          caveats=("Over 300 columns of mixed provenance: raw indicators, vendor opinions "
                   "(ext_* / mc_* / tl_* prefixes) and model outputs sit side by side. The "
                   "binding table marks which is which.",
                   "`win_probability` and `calibrated_win_probability` are model OUTPUTS and "
                   "must not be fed back in as features.",)),

        C("EngineScore", "Engine score", "derived",
          "A single engine's, or the multi-engine composite's, score for a symbol and date "
          "with its engine-coverage count.",
          parents=("PlatformOutput",), key_properties=("symbol", "date"),
          grain="(symbol, date)",
          caveats=("Engine contributions are measured here, not assumed: only the confluence "
                   "engine carries a growing positive reading, the ML ensemble adds roughly "
                   "+0.02, and the DL / cross-sectional / smart-money engines measured 0.0 "
                   "across all regimes.",)),

        C("Recommendation", "Recommendation", "derived",
          "The served trade: composite score, conviction bucket, action label, entry zone, "
          "stop, targets, risk/reward and position size for one symbol, date and timeframe.",
          parents=("PlatformOutput",),
          key_properties=("symbol", "computed_at", "timeframe"),
          grain="(symbol, computed_at, timeframe)",
          caveats=("`computed_at` is TEXT here and native TIMESTAMPTZ in "
                   "`confluence_signals` — cast before joining the two.",
                   "`trade_reasoning` is generated text: an explanation, never evidence.",
                   "The history table carries the raw meta-label behind "
                   "`position_size_pct`, which the serving table does not.",)),
    ]

    # ── evidence ledger & outcomes ───────────────────────────────────────────
    out += [
        C("ModelArtifact", "Model artifact", "derived",
          "A registered trained model: type, version, evaluation metrics, feature count, "
          "horizon and active flag.",
          parents=("PlatformOutput",), key_properties=("id",), grain="one row per version",
          caveats=("Promotion is gated on holdout error plus a margin; a row existing does "
                   "not mean the model is serving.",)),

        C("FeatureImportance", "Feature importance", "derived",
          "Per-model, per-run feature importance with rank — the audit trail behind which "
          "inputs a model actually used.",
          parents=("PlatformOutput",), key_properties=("id",),
          grain="(model, run, feature)"),

        C("OutcomeRecord", "Outcome record", "outcome",
          "Abstract parent for resolved results. Labels live here and nowhere else: nothing "
          "in this branch may ever appear on the input side of a model.",
          key_properties=("symbol", "signal_date"), realization="abstract"),

        C("EdgeReading", "Edge reading", "outcome",
          "One factor-grading result: rank-IC and hit-AUC for a table/column, per regime and "
          "horizon, with the effective-date count and a verdict.",
          parents=("OutcomeRecord",),
          key_properties=("source", "name", "horizon_days", "verdict"),
          grain="(run_at, table_name, score_col, horizon_days, regime)",
          caveats=("Read `eff_dates` BEFORE the reading. Overlapping forward windows inflate "
                   "a correlation by roughly the horizon factor, and the effective-date count "
                   "is the guard that exposes it — too few effective dates makes a reading a "
                   "calendar artefact rather than an edge.",)),

        C("SignalOutcome", "Signal outcome", "outcome",
          "The resolved result of a signal: entry, exit, horizon, return and the outcome "
          "label, under one of two possibly-different labelling rules.",
          parents=("OutcomeRecord",),
          key_properties=("symbol", "signal_date", "horizon_days"),
          grain="(symbol, signal_date, horizon_days, signal_source)",
          caveats=("Labels are NOT comparable across `label_definition` "
                   "(`path_barrier` vs `terminal_pct2`). Always filter on it before "
                   "aggregating accuracy.",
                   "`PENDING` rows have not elapsed — they are not negative examples.",
                   "`NO_ENTRY_PRICE` / `SUSPECT_DATA` are integrity exits, not labels.",)),

        C("SignalExcursion", "Signal excursion", "outcome",
          "Path statistics inside the evaluation window: maximum favourable and adverse "
          "excursion, days to each, and whether MFE preceded MAE.",
          parents=("OutcomeRecord",),
          key_properties=("symbol", "signal_date", "horizon_days"),
          grain="(symbol, signal_date, horizon_days)",
          caveats=("This is what makes a stop-loss study possible: the terminal return alone "
                   "cannot tell you whether the trade was ever viable.",)),
    ]

    # ── candidate generation ─────────────────────────────────────────────────
    out += [
        C("CandidateRecord", "Candidate record", "candidate",
          "Abstract parent for vendor-opinion streams. These SURFACE candidates; they are "
          "never ground truth.",
          key_properties=("symbol",), realization="abstract"),

        C("Screener", "Screener", "candidate",
          "A vendor screener definition with its inferred sentiment, category, reliability "
          "tier and classification confidence.",
          key_properties=("id",), grain="one row per screener",
          caveats=("Sentiment, category and tier are INFERRED by this platform, not supplied "
                   "by the vendor: they are model output about a vendor product.",
                   "A screener is a candidate generator, never evidence — its aggregate "
                   "momentum score no longer clears the USABLE bar.",)),

        C("ScreenerAppearance", "Screener appearance", "candidate",
          "A single surfacing event: this screener listed this symbol at this instant, with "
          "the price, change and volume at that moment.",
          parents=("CandidateRecord",), key_properties=("id",),
          grain="(run_id, symbol, filter_key)",
          caveats=("12.25M rows and growing: always bound a query by run_id or symbol.",
                   "Surfacing time is the only knowable time; the screener's internal logic "
                   "is not visible.",)),

        C("ScreenerOutcome", "Screener outcome", "outcome",
          "Forward returns pre-tracked and attached to an appearance at surfacing time.",
          parents=("OutcomeRecord",), key_properties=("id", "symbol"),
          grain="(appearance_id, symbol)",
          caveats=("The platform's largest pre-labelled dataset (9.2M outcomes) and the "
                   "reason screener research is worth doing — but the labels are forward "
                   "returns from the surfacing price, so any attribution belongs to the "
                   "SCREENER, not to an engine that happened to agree with it.",)),

        C("EventTrigger", "Event trigger", "candidate",
          "Detector output: which composite trigger classes fired for a symbol on a date, "
          "with news counts and bullish-tenure state.",
          parents=("CandidateRecord",), key_properties=("symbol", "date"),
          grain="(symbol, date)",
          caveats=("`triggers` is a comma-joined string carrying inline thresholds "
                   "(`CROWDED_NEWS p90`) — parse the class token, never the whole value.",)),
    ]

    # ── governance & provenance ──────────────────────────────────────────────
    out += [
        C("GovernanceRecord", "Governance record", "governance",
          "Abstract parent for operational metadata. These answer 'when was this true and "
          "who wrote it', which on this platform is the difference between a usable value "
          "and a guess.",
          key_properties=("id",), realization="abstract"),

        C("Endpoint", "Data endpoint", "governance",
          "A discovered, verified market-data endpoint: provider, domain, scope, update "
          "frequency and the template to call it. The platform's data-sourcing registry.",
          parents=("GovernanceRecord",), key_properties=("id",),
          grain="one row per endpoint",
          caveats=("This registry is the mandatory first stop when a source stops returning "
                   "data — 3,408 verified endpoints exist here and a 'dead vendor' conclusion "
                   "is not admissible until they have been checked.",)),

        C("JobRun", "Job run", "governance",
          "Per-job heartbeat: last status, last success, last error and run/failure counts.",
          parents=("GovernanceRecord",), key_properties=("job_name",),
          grain="one row per job",
          caveats=("`last_run_at` is the last ATTEMPT; `last_success_at` is what freshness "
                   "should be judged against. A job that runs and fails updates the former "
                   "only.",
                   "A step exiting 0 is not evidence that data was written; this repo treats "
                   "'data not successfully written' as an error regardless of log level.",)),

        C("DataQualityCheck", "Data-quality check", "governance",
          "The result of one named validation check: category, criticality, status and a "
          "detail string.",
          parents=("GovernanceRecord",), key_properties=("check_id",),
          grain="(check_id, checked_at)",
          caveats=("Status is stored lowercase (`pass` / `warn`), so a case-sensitive "
                   "comparison against 'PASS' matches nothing.",)),

        C("DataContract", "Data contract", "governance",
          "A versioned machine-readable contract describing one dataset's grain, timing, source, "
          "training use, and physical lineage.", parents=("GovernanceRecord",),
          key_properties=("contract_key",), grain="contract_key"),
        C("FeatureDefinition", "Semantic feature definition", "governance",
          "A versioned authored definition of a model-facing property, including leakage and "
          "feature-use constraints.", parents=("GovernanceRecord",),
          key_properties=("feature_key",), grain="feature_key"),
        C("DataWatermark", "Data completeness watermark", "governance",
          "Producer-published completeness and input/output boundary for a dataset partition.",
          parents=("GovernanceRecord",), key_properties=("dataset", "partition_key"),
          grain="(dataset, partition_key)"),
        C("GraphNode", "Instance graph node", "governance",
          "A canonical entity projected into the bitemporal market graph.",
          parents=("GovernanceRecord",), key_properties=("node_key",), grain="node_key"),
        C("GraphEdge", "Instance graph edge", "governance",
          "A typed, bitemporal assertion between graph nodes or a literal object value.",
          parents=("GovernanceRecord",), key_properties=("assertion_key",), grain="assertion_key"),
        C("EvidenceRecord", "Evidence record", "governance",
          "Source material retained separately from the claim extracted or inferred from it.",
          parents=("GovernanceRecord",), key_properties=("evidence_key",), grain="evidence_key"),
        C("MarketClaim", "Market claim", "derived",
          "An explicit, status-bearing assertion about a market entity, separate from raw evidence.",
          key_properties=("claim_key",), grain="claim_key"),
        C("DecisionEvent", "Decision event", "derived",
          "An append-only, reconstructable decision record with cutoff, versions, quality, and "
          "structured supporting or contradictory evidence.", key_properties=("decision_key",),
          grain="decision_key"),
        C("DecisionOutcome", "Decision outcome", "outcome",
          "A realized outcome attached to a decision under an explicit label definition and horizon.",
          key_properties=("decision_key", "label_definition", "horizon_days"),
          grain="(decision_key, label_definition, horizon_days)"),

    ]

    return tuple(out)
