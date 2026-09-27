"""
Controlled vocabularies (SKOS) and ontology namespaces.

Every term set below was **read out of the live database**, not invented: the `source`
field names the exact `table.column` the values came from, so any term can be re-verified
with one query. Term sets whose underlying column is written by an open-ended producer
(screener names, model versions, trigger classes) are flagged `open=True` — the enumerated
terms are the ones observed at capture time, not a closed enumeration, and a reader must
not treat absence from the list as impossibility.

Verified 2026-09-21 against `bharat_intel` @ 127.0.0.1:5433.
"""
from dataclasses import dataclass
from typing import Optional, Tuple

# ── Namespaces ────────────────────────────────────────────────────────────────

BASE_URI = "https://bharat-stock-intelligence.dev/ontology/"
ONTOLOGY_VERSION = "1.1.0"

NAMESPACES = {
    "bsi": BASE_URI + "market#",       # entity classes (T-Box)
    "bsip": BASE_URI + "property#",    # datatype properties
    "bsir": BASE_URI + "relation#",    # object properties (graph edges)
    "bsim": BASE_URI + "metric#",      # semantic measures with SQL realizations
    "bsiv": BASE_URI + "vocab#",       # SKOS concept schemes
    "bsis": BASE_URI + "source#",      # data sources / tables
    # Per-TABLE row class. A row materialized from `unified_recommendations` is typed
    # `bsit:unified_recommendations` (rdfs:subClassOf bsi:Recommendation), which is what lets a
    # SHACL closed shape express "exactly these columns" per table even when several tables
    # realize the same domain class. Without it, a multi-table class has no way to say which
    # physical contract a given node is being held to.
    "bsit": BASE_URI + "table#",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "owl": "http://www.w3.org/2002/07/owl#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "prov": "http://www.w3.org/ns/prov#",
    "schema": "https://schema.org/",
}


def expand(curie: str) -> str:
    """`"bsi:Equity"` -> the full IRI. Unknown prefixes are returned unchanged."""
    if ":" not in curie:
        return curie
    prefix, local = curie.split(":", 1)
    ns = NAMESPACES.get(prefix)
    return ns + local if ns else curie


# ── Meta-vocabularies (the axes the ontology itself classifies along) ─────────

#: Which stratum of the pipeline a class belongs to. Drives documentation order and the
#: default "can I train on this?" answer.
LAYERS = (
    "identity",     # who/what something is (Instrument, Sector, Index)
    "observation",  # measured at a point in time, no platform opinion (Bar, BlockDeal)
    "context",      # market state that conditions everything else (Regime, Breadth)
    "derived",      # platform-computed (FeatureVector, EngineScore, Recommendation)
    "candidate",    # vendor opinions used to surface candidates (Screener, Appearance)
    "outcome",      # realized results / labels (SignalOutcome, Excursion)
    "governance",   # provenance, freshness, quality, registry (JobRun, Endpoint)
    "meta",         # the ontology describing itself (DataCard, Metric)
)

LAYER_LABELS = {
    "identity": "Identity & reference",
    "observation": "Observations (point-in-time facts)",
    "context": "Market context & regime",
    "derived": "Derived intelligence (platform-computed)",
    "candidate": "Candidate generation (vendor opinions)",
    "outcome": "Outcomes & labels (ground truth)",
    "governance": "Provenance, quality & governance",
    "meta": "Self-description",
}

#: What a property *is*, semantically. The single most important axis for a model
#: consumer: it separates what may go into X from what is being predicted.
SEMANTIC_TYPES = (
    "identifier",   # join key / entity reference (symbol, isin, scid)
    "dimension",    # categorical grouping (sector, category, source)
    "measure",      # a quantity (close, volume, oi_change) — features live here
    "ratio",        # a bounded/decimal quantity (delivery_pct, debt_to_equity)
    "probability",  # [0,1] model output (win_probability) — never a feature
    "score",        # composite platform score (unified_score, confluence_score)
    "count",        # integer cardinality (n_analysts, bullish_screener_count)
    "timestamp",    # a time coordinate
    "flag",         # boolean / 0-1 indicator (is_suspect, asm_flag)
    "label",        # ground-truth target (outcome, return_pct) — NEVER a feature
    "text",         # free text (ai_insight, trade_reasoning)
    "json",         # structured payload that must not be fed raw to a model
    "enum",         # member of a controlled vocabulary
    "unit",         # unit/metadata carrier (lot_size, series)
    "operational",  # ops/provenance telemetry (job_name, run_count, last_status):
                    # describes the PIPELINE, never the market — never a feature
)

#: Information timing relative to the move being explained.
TIMING_CLASSES = ("leading", "coincident", "lagging", "context", "target")

#: How the value came to exist. Decides what "trust" means for it.
DERIVATIONS = ("raw", "vendor", "platform", "derived", "label")

#: Point-in-time leakage exposure. `high` means: using this as a feature without an as-of
#: guard reproduces a look-ahead bug this repo has already shipped at least once.
LEAKAGE_RISKS = ("none", "low", "medium", "high", "target")

#: How much measured evidence backs an edge/relationship (mirrors `factor_edge_history`).
GRADED_STATUS = (
    "live",               # running in production, verified this session
    "measured",           # has a recorded rank-IC / AUC reading in factor_edge_history
    "research-candidate", # plausible, ungraded, named as an experiment in the master report
    "low-data",           # panel too short to grade (e.g. the 14-date futures panel)
    "retracted",          # a previously claimed edge that failed the power check
    "ungraded",
    "dead",               # no writer; confirmed zero/absent rows
)

#: XSD datatypes used for literal properties.
DATATYPES = ("string", "integer", "decimal", "boolean", "date", "timestamp", "json")

#: Relationship cardinalities between ontology classes.
CARDINALITIES = ("1:1", "1:N", "N:1", "N:M")

#: How a class is physically realized in this database — `ClassDef.realization`.
#:   "table"     one or more data cards realize it
#:   "reference" a dimension that exists only as a column value (Exchange, Sector, Index) —
#:               nothing owns a single table for it, so "must be backed by a card" is wrong
#:   "abstract"  a grouping parent with no direct realization
REALIZATIONS = ("table", "reference", "abstract")

#: Whether a table may be used to train a model, and how carefully.
TRAINING_USE = (
    "allowed",    # safe as features once grain/as-of discipline is respected
    "caution",    # usable but carries a documented trap (see card caveats)
    "labels",     # it IS the target — never an input
    "context",    # join for conditioning only
    "forbidden",  # do not train on this (leakage, vendor duplication, or dead)
)

# ── Concept schemes ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ControlledTerm:
    """One SKOS Concept inside a scheme."""

    notation: str          # the literal value stored in the column (case as stored)
    label: str             # human-readable
    definition: str
    broader: Optional[str] = None  # notation of a parent concept, if any


@dataclass(frozen=True)
class Vocabulary:
    """A SKOS ConceptScheme bound to the column(s) that realize it in this database."""

    name: str
    description: str
    source: str                        # "table.column", or "authored" when derived
    terms: Tuple[ControlledTerm, ...]
    open: bool = False                 # True = observed subset of an open-ended producer

    @property
    def uri(self) -> str:
        return f"bsiv:{self.name}"

    def notations(self) -> Tuple[str, ...]:
        return tuple(t.notation for t in self.terms)

    def term(self, notation: str) -> Optional[ControlledTerm]:
        for t in self.terms:
            if t.notation == notation:
                return t
        return None


def _t(notation: str, label: str, definition: str = "",
       broader: Optional[str] = None) -> ControlledTerm:
    """One term.

    `definition` may be omitted where the label *is* the definition — an index name
    (`SENSEX`), a model name (`online_sgd`), a tier (`S`), an interval (`5m`). Writing
    boilerplate there would pad the artifact without teaching a consumer anything, and an
    omitted `skos:definition` is honest where a tautology is not. Terms whose stored value
    does **not** explain itself (outcome states, suspect reasons, provenance quality, screener
    categories) all carry a real definition.
    """
    return ControlledTerm(notation, label, definition, broader)


def vocabularies() -> Tuple[Vocabulary, ...]:
    """Every controlled vocabulary, each pointing at the column it was read from."""
    out = []
    out += [
        Vocabulary(
            "timeframe",
            "Trading horizon an engine or signal is expressed on. Uppercase in the "
            "canonical signal tables; `screener_master.inferred_timeframe` uses a "
            "lowercase subset — normalise before joining the two.",
            "unified_recommendations.timeframe",
            (
                _t("INTRADAY", "Intraday", "Entered and exited within one session."),
                _t("SWING", "Swing", "Sessions to a few weeks. The best-powered graded horizon is 5 days."),
                _t("POSITIONAL", "Positional", "Weeks to a few months."),
                _t("LONG_TERM", "Long term", "A quarter or longer; fundamentals-led."),
            ),
        ),
        Vocabulary(
            "market_regime",
            "Macro regime label from the HMM regime detector, stamped onto every "
            "technical signal. A weight-gate filter and conditioning variable, not alpha.",
            "market_regimes.regime",
            (
                _t("BULL", "Bull", "Uptrend regime; risk appetite expanding."),
                _t("BEAR", "Bear", "Downtrend regime."),
                _t("SIDEWAYS", "Sideways", "Range-bound; mean-reversion favoured."),
                _t("HIGH_VOL", "High volatility", "Realised volatility elevated."),
                _t("CRASH", "Crash", "Acute drawdown; filters should suppress entries."),
            ),
        ),
        Vocabulary(
            "conviction",
            "Ranked conviction bucket on a served recommendation.",
            "unified_recommendations.conviction_level",
            (
                _t("S_ELITE", "S — elite", "Highest conviction bucket."),
                _t("A_HIGH", "A — high", "High conviction."),
                _t("D_MARGINAL", "D — marginal", "Marginal; below the actionable threshold in practice."),
            ),
        ),
    ]
    out += [
        Vocabulary(
            "recommendation_classification",
            "Action label served alongside the numeric score. Mixed case on purpose: these "
            "are stored values, not an enum.",
            "unified_recommendations.classification",
            (
                _t("Strong Buy", "Strong buy", "Top action bucket."),
                _t("Buy", "Buy", "Actionable long."),
                _t("Hold", "Hold", "No action."),
                _t("Sell", "Sell", "Actionable short / exit."),
                _t("Strong Sell", "Strong sell", "Exit now; short candidate."),
            ),
        ),
        Vocabulary(
            "intraday_regime",
            "Within-session risk state used by the intraday ranker.",
            "intraday_recommendations.intraday_regime",
            (
                _t("RISK_ON", "Risk on", "Intraday conditions supportive of longs."),
                _t("NEUTRAL", "Neutral", "No directional intraday tilt."),
            ),
            open=True,
        ),
        Vocabulary(
            "outcome",
            "Realised result of a signal, written by the outcome resolver. The primary "
            "supervised label in the platform.",
            "signal_outcomes.outcome",
            (
                _t("WIN", "Win", "Cleared the win threshold under the recorded label definition."),
                _t("LOSS", "Loss", "Fell below the loss threshold."),
                _t("STOP_LOSS", "Stop loss", "Stop barrier hit before the horizon closed."),
                _t("NEUTRAL", "Neutral", "Closed inside the neutral band; not tradable."),
                _t("PENDING", "Pending", "Horizon has not elapsed — never training data."),
            ),
        ),
        Vocabulary(
            "exit_reason",
            "Why a tracked position closed. Separates rule-driven exits from integrity "
            "exits; `SUSPECT_DATA` / `NO_ENTRY_PRICE` rows are not labels.",
            "unified_signal_outcomes.exit_reason",
            (
                _t("TIME_EXIT", "Time exit", "Horizon elapsed; closed at the horizon bar."),
                _t("TIME_EXIT_PARTIAL", "Time exit (partial)", "Horizon elapsed with a partial exit."),
                _t("STOP_LOSS", "Stop loss", "Stop barrier touched."),
                _t("TRAILING_STOP", "Trailing stop", "Trailing stop triggered before horizon."),
                _t("NO_ENTRY_PRICE", "No entry price", "Entry could not be priced; excluded from accuracy stats."),
                _t("SUSPECT_DATA", "Suspect data", "Quarantined for bad bars; excluded from accuracy stats."),
            ),
        ),
        Vocabulary(
            "signal_source",
            "Which producer emitted a signal. The two tables that carry this column use "
            "different vocabularies — unify before aggregating accuracy across sources.",
            "signal_outcomes.signal_source + unified_signal_outcomes.signal_source",
            (
                _t("technical", "Technical", "Rule-based technical scanner."),
                _t("confluence", "Confluence", "Multi-engine confluence score."),
                _t("screener", "Screener", "Vendor screener surfacing."),
                _t("technical_scan", "Technical scan", "EOD technical scan batch."),
                _t("SCREENER_SURFACING", "Screener surfacing", "Uppercase alias used by the unified tracker."),
                _t("platform", "Platform", "Unified ranker output."),
                _t("AI", "AI", "Agent/LLM-generated pick."),
                _t("intraday", "Intraday", "Intraday ranker output."),
            ),
            open=True,
        ),
        Vocabulary(
            "label_definition",
            "Which labelling rule produced the outcome. Labels are NOT comparable across "
            "definitions; always filter on this column before grading.",
            "signal_outcomes.label_definition",
            (
                _t("path_barrier", "Path barrier", "Triple-barrier style: first touch of a stop or target wins."),
                _t("terminal_pct2", "Terminal return (±2%)", "Terminal return against a fixed percentage band."),
            ),
        ),
    ]
    out += [
        Vocabulary("edge_verdict", "Recorded outcome of a factor grading run.",
                   "factor_edge_history.verdict",
                   (
                       _t("USABLE", "Usable", "Clears the power and independence guards."),
                       _t("no edge", "No edge", "Measured; not distinguishable from noise."),
                       _t("LOW-DATA", "Low data", "Panel below the minimum independent-observation count."),
                       _t("n/a", "Not applicable", "Grader did not apply to this row."),
                   ), open=True),
        Vocabulary("corporate_action_type", "Capital-structure event applied to a symbol's price series.",
                   "corporate_actions.action_type",
                   (
                       _t("DIVIDEND", "Dividend", "Cash payout.", "OTHER"),
                       _t("DIVIDEND_SPECIAL", "Special dividend", "One-off cash payout.", "DIVIDEND"),
                       _t("SPLIT", "Split", "Face-value split; requires price adjustment.", "OTHER"),
                       _t("BONUS", "Bonus", "Bonus issue; requires price adjustment.", "SPLIT"),
                       _t("OTHER", "Other", "Unclassified or immaterial event."),
                       _t("Quarterly Results", "Quarterly results", "Results date recorded in the same table — not a capital action."),
                   ), open=True),
        Vocabulary("data_quality_status", "Result of a data-quality check. Stored lowercase.",
                   "data_quality_results.status",
                   (
                       _t("pass", "Pass", "Check satisfied."),
                       _t("warn", "Warn", "Suspicious but not blocking."),
                       _t("fail", "Fail", "Blocking; downstream writers must not trust the input."),
                   ), open=True),
        Vocabulary("job_status", "Last terminal status of a scheduled job. Stored lowercase.",
                   "job_heartbeat.last_status",
                   (
                       _t("success", "Success", "Completed and committed."),
                       _t("failed", "Failed", "Did not complete; treated as data-not-written."),
                       _t("running", "Running", "In progress."),
                   ), open=True),
        Vocabulary("screener_sentiment", "Vendor screener's implied directional bias (inferred, lowercase).",
                   "screener_master.inferred_sentiment",
                   (
                       _t("bullish", "Bullish", "Screener surfaces upside candidates."),
                       _t("bearish", "Bearish", "Screener surfaces downside candidates."),
                       _t("neutral", "Neutral", "Direction-agnostic screener."),
                   )),
        Vocabulary("screener_category", "Inferred family of a vendor screener.",
                   "screener_master.inferred_category",
                   (
                       _t("technical", "Technical"), _t("technical_momentum", "Technical — momentum"),
                       _t("technical_breakout", "Technical — breakout"), _t("volume_liquidity", "Volume & liquidity"),
                       _t("delivery", "Delivery"), _t("volatility", "Volatility"), _t("intraday", "Intraday"),
                       _t("fundamental", "Fundamental"), _t("fundamental_growth", "Fundamental — growth"),
                       _t("fundamental_quality", "Fundamental — quality"), _t("valuation", "Valuation"),
                       _t("income_dividend", "Income & dividend"), _t("ownership_institutional", "Ownership & institutional"),
                       _t("market_cap_style", "Market-cap style"), _t("sector_theme", "Sector theme"),
                       _t("event_corporate_action", "Event / corporate action"), _t("analyst_sentiment", "Analyst sentiment"),
                       _t("risk_red_flags", "Risk / red flags"), _t("composite_strategy", "Composite strategy"),
                       _t("other", "Other"),
                   ), open=True),
        Vocabulary("screener_tier", "Reliability tier assigned to a screener by the reliability scorer.",
                   "screener_master.tier",
                   (
                       _t("S", "Tier S"), _t("A", "Tier A"), _t("B", "Tier B"),
                       _t("C", "Tier C", "Low reliability."),
                       _t("D", "Tier D", "Lowest reliability."),
                       _t("Unranked", "Unranked", "Not enough outcomes to tier."),
                   ), open=True),
        Vocabulary("news_impact", "Expected market impact bucket on a scored news item.",
                   "news_sentiment_items.impact",
                   (
                       _t("HIGH", "High", "Material; may move the stock."),
                       _t("MEDIUM", "Medium", "Notable."),
                       _t("LOW", "Low", "Routine."),
                   ), open=True),
        Vocabulary("news_sentiment", "Directional sentiment class (uppercase) on stored news.",
                   "news_sentiment_items.sentiment",
                   (
                       _t("BULLISH", "Bullish", "Positive tone."),
                       _t("BEARISH", "Bearish", "Negative tone."),
                       _t("NEUTRAL", "Neutral", "No directional tone."),
                   ), open=True),
    ]
    out += [
        Vocabulary("news_tone_label", "FinBERT tone class (lowercase) — distinct from the "
                   "vendor `sentiment` column; both exist on the same row and can disagree "
                   "(`sentiment_conflict`).", "news_sentiment_items.tone_label",
                   (_t("positive", "Positive"), _t("negative", "Negative"), _t("neutral", "Neutral")), open=True),
        Vocabulary("news_source_type", "Coarse provenance class of a news item.",
                   "news_sentiment_items.source_type",
                   (_t("INDIAN", "Indian", "Domestic market coverage."),
                    _t("GLOBAL", "Global", "International coverage.")), open=True),
        Vocabulary("rrg_quadrant", "Relative-rotation-graph quadrant for a sector.",
                   "sector_rrg_history.quadrant",
                   (_t("Leading", "Leading", "Outperforming and still improving."),
                    _t("Weakening", "Weakening", "Outperforming but decelerating."),
                    _t("Lagging", "Lagging", "Underperforming and deteriorating."),
                    _t("Improving", "Improving", "Underperforming but accelerating."))),
        Vocabulary("oi_buildup", "Futures open-interest buildup label (title case).",
                   "stock_futures_oi_history.oi_buildup",
                   (_t("Long Buildup", "Long buildup", "Price up, OI up."),
                    _t("Short Buildup", "Short buildup", "Price down, OI up."),
                    _t("Long Unwinding", "Long unwinding", "Price down, OI down."),
                    _t("Short Covering", "Short covering", "Price up, OI down.")), open=True),
        Vocabulary("option_buildup", "Option-chain buildup label. NOTE the spelling differs "
                   "from `oi_buildup` ('Build Up' vs 'Buildup') — never compare these strings "
                   "across tables without normalising first.",
                   "so_option_chain.ce_buildup / so_option_chain.pe_buildup",
                   (_t("Long Build Up", "Long build up"), _t("Short Build Up", "Short build up"),
                    _t("Long Unwinding", "Long unwinding"), _t("Short Covering", "Short covering")), open=True),
        Vocabulary("adjustment_basis", "Provenance of the price basis a bar is expressed in. "
                   "Mixing bases inside one series is a silent backtest corruption.",
                   "stock_ohlcv.adjustment_basis",
                   (_t("nse_bhavcopy_raw", "NSE bhavcopy (raw)", "As-traded, unadjusted."),
                    _t("split_only", "Split-adjusted", "Adjusted for splits/bonus only."),
                    _t("split_dividend", "Split + dividend adjusted", "Fully adjusted series.")), open=True),
        Vocabulary("suspect_reason", "Why a bar was quarantined. Suspect bars must be excluded "
                   "from training panels, not imputed silently.", "stock_ohlcv.suspect_reason",
                   (_t("impossible_move", "Impossible move", "Return beyond physical bounds."),
                    _t("nonpositive_price", "Non-positive price", "Zero or negative price."),
                    _t("ohlc_inconsistent", "OHLC inconsistent", "High/low do not contain open/close."),
                    _t("closed session: universe-wide flat zero-volume bar", "Closed session",
                       "Exchange holiday captured as a flat bar.")), open=True),
        Vocabulary("trade_type", "Side of a bulk/block deal. Stored inconsistently in mixed "
                   "case by different fetchers — normalise with UPPER() before aggregating.",
                   "block_deals.trade_type",
                   (_t("BUY", "Buy"), _t("SELL", "Sell"), _t("buy", "buy (lowercase)"),
                    _t("sell", "sell (lowercase)")), open=True),
    ]
    out += [
        Vocabulary("option_side", "Which leg of an option contract a row or column describes.",
                   "authored",
                   (_t("CE", "Call", "Call option leg."), _t("PE", "Put", "Put option leg."))),
        Vocabulary("trading_interval", "Bar interval of the intraday series.",
                   "intraday_ohlcv.interval",
                   (_t("5m", "5 minute"), _t("15m", "15 minute"), _t("60m", "60 minute")), open=True),
        Vocabulary("model_name", "Registered model identity in the model registry.",
                   "model_registry.model_name",
                   (_t("ensemble", "ML ensemble"), _t("cs_ranker", "Cross-sectional ranker"),
                    _t("exit_policy", "Exit policy"), _t("online_sgd", "Online SGD learner"),
                    _t("BiLSTM", "BiLSTM"), _t("confluence_ml", "Confluence ML"),
                    _t("breakout_probability", "Breakout probability"),
                    _t("movement_predictor", "Movement predictor")), open=True),
        Vocabulary("index_name", "Index identifiers used by the derivatives and PCR tables.",
                   "nt_index_pcr_ts.index_name",
                   (_t("NIFTY50", "NIFTY 50"), _t("NIFTYBANK", "BANK NIFTY"),
                    _t("NIFTYFINSRV", "NIFTY Financial Services"), _t("NIFTYMIDSELECT", "NIFTY Midcap Select"),
                    _t("SENSEX", "BSE SENSEX"), _t("BANKEX", "BSE BANKEX"),
                    _t("FOCIT", "F&O IT index"), _t("INDIAVIX", "India VIX"),
                    _t("GIFTNIFTY", "GIFT NIFTY")), open=True),
        Vocabulary("event_trigger_class", "Composite event-trigger classes. Stored as a "
                   "comma-joined string with an inline threshold suffix (`r1.00`, `p90`) — "
                   "parse the class token before the space, never the whole string.",
                   "stock_event_triggers.triggers",
                   (_t("SCREENER_SUPPORT_FADING", "Screener support fading",
                       "Screener-derived support ratio decaying; suffix r<ratio>."),
                    _t("CROWDED_NEWS", "Crowded news",
                       "News attention above a percentile; suffix p<percentile>.")), open=True),
        Vocabulary("provenance_quality", "Whether a row was rebuilt from source or carried "
                   "over from vendor point-in-time data. Rows before the provenance boundary "
                   "(`2026-08-12`, docs/measurement.md) are `inferred`.",
                   "authored (greenfield provenance model)",
                   (_t("observed", "Observed", "Rebuilt from a replayable source (e.g. NSE bhavcopy)."),
                    _t("inferred", "Inferred", "Carried over from vendor PIT data; cannot be re-fetched."))),
    ]
    return tuple(out)


def by_name() -> dict:
    """`{vocabulary_name: Vocabulary}` for O(1) lookup during validation and export."""
    return {v.name: v for v in vocabularies()}
