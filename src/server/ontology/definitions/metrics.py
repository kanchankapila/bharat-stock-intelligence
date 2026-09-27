"""
Semantic metrics — a question-to-query bridge with the caveats attached.

This is the part a model or an agent actually consumes. Each metric carries:

* a **name and synonyms** an LLM can match against a question,
* **runnable SQL** using only the binds `:symbol` and `:as_of`, so it can be validated with
  EXPLAIN (which checks every table and column reference without scanning a row),
* the **unit**, grain and cadence,
* the **graded status** — whether a measured reading stands behind it or it is a candidate,
* and the **caveats** that would otherwise turn a correct query into a wrong answer.

Rules this module enforces (`model.validate_metric_sql`, run by the test suite):

* SQL must be a single read-only SELECT/WITH.
* No `%` character anywhere: `sql_translate` does not escape literal percent signs, and a
  `%` reaching psycopg2 through a bind path is parsed as a parameter marker. Percentages are
  written as `* 100.0`.
* Every declared source table must actually appear in the SQL.
* Only the two supported binds may appear.

`cheap=False` marks a metric safe to EXPLAIN but not to execute casually.
"""
from typing import Tuple

from ..model import MetricDef

M = MetricDef


def metrics() -> Tuple[MetricDef, ...]:
    return (
        M(name="delivery_surprise_z",
          label="Delivery surprise z-score",
          description="Today's NSE delivery percentage as a z-score against the symbol's "
                      "own trailing 20-session history: unusual ownership behaviour on a "
                      "session, the T+1-lag edge the master report names.",
          sql="""WITH hist AS (
    SELECT date AS d, delivery_pct AS dp
    FROM stock_delivery_data
    WHERE symbol = :symbol AND delivery_pct IS NOT NULL
), stats AS (
    SELECT d, dp,
           avg(dp) OVER (ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS mu,
           stddev_samp(dp) OVER (ORDER BY d ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS sd
    FROM hist
)
SELECT d AS as_of, dp AS delivery_pct,
       CASE WHEN sd > 0 THEN (dp - mu) / sd ELSE 0.0 END AS delivery_surprise_z
FROM stats
WHERE d <= :as_of
ORDER BY d DESC
LIMIT 1""",
          entity="Equity",
          source_tables=("stock_delivery_data",),
          unit="z", grain="one row per symbol per as-of session",
          cadence="daily", timing="leading", derivation="derived",
          leakage_risk="none", graded_status="research-candidate",
          caveats=("Delivery data lands T+1: the z-score for session D is knowable only "
                   "during session D+1, so any same-session use is a look-ahead.",
                   "Self-referenced (vs the symbol's own history), not cross-sectional."),
          synonyms=("delivery surprise z", "delivery surprise"),
          params=("symbol", "as_of"), cheap=True),

        M(name="close_price",
          label="Closing price (basis-tagged)",
          description="The most recent clean closing price on or before an as-of date, "
                      "excluding quarantined bars.",
          sql="""SELECT o.close AS close_price, o.date AS as_of, o.adjustment_basis
FROM stock_ohlcv o
WHERE o.symbol = :symbol AND o.date <= :as_of AND o.is_suspect = 0
ORDER BY o.date DESC
LIMIT 1""",
          entity="Bar", source_tables=("stock_ohlcv",), unit="per_share_INR",
          grain="(symbol, date)", cadence="per_session", timing="coincident",
          derivation="raw", leakage_risk="none", graded_status="live",
          synonyms=("close", "closing price", "last close", "price"),
          caveats=("The price is in whatever basis `adjustment_basis` names: mixing bases "
                   "across a series is a silent backtest corruption.",
                   "`is_suspect = 0` is applied — a quarantined bar is excluded, not "
                   "corrected.")),

        M(name="delivery_pct_latest",
          label="Latest delivery percentage",
          description="Delivered shares as a share of traded shares on the most recent "
                      "session at or before the as-of date.",
          sql="""SELECT d.delivery_pct AS delivery_pct, d.date AS as_of
FROM stock_delivery_data d
WHERE d.symbol = :symbol AND d.date <= :as_of
ORDER BY d.date DESC
LIMIT 1""",
          entity="DeliveryObservation", source_tables=("stock_delivery_data",),
          unit="percent", grain="(symbol, date)", cadence="daily_t_plus_1",
          timing="lagging", derivation="raw", graded_status="research-candidate",
          graded_evidence="Delivery-to-swing-returns is an unquantified link (master report "
                          "§6, Experiment 4) — not yet graded by factor_edge.py.",
          synonyms=("delivery", "delivery percent", "delivery percentage", "deliv"),
          caveats=("T+1 by construction: this value was NOT knowable on the session it "
                   "describes, so it cannot explain that session's move.",
                   "A sibling table (`stock_delivery_volume`) reports the same concept per "
                   "NSE series with different column names.")),

        M(name="delivery_pct_30d_average",
          label="Delivery percentage, 30-session average",
          description="Mean delivery percentage over the trailing window ending at the "
                      "as-of date — the baseline a delivery surprise is measured against.",
          sql="""SELECT avg(d.delivery_pct) AS delivery_avg, count(*) AS sessions
FROM stock_delivery_data d
WHERE d.symbol = :symbol AND d.date <= :as_of
  AND d.date > ((:as_of)::date - 30)""",
          entity="DeliveryObservation", source_tables=("stock_delivery_data",),
          unit="percent", grain="(symbol, trailing 30 sessions)", cadence="daily_t_plus_1",
          timing="lagging", derivation="platform", graded_status="research-candidate",
          synonyms=("average delivery", "delivery baseline", "delivery trend"),
          caveats=("Session count, not calendar days: the window spans trading sessions.",
                   "Returns NULL when the symbol has no delivery rows in the window — a "
                   "coverage gap, not a zero.")),

        M(name="rsi_14_latest",
          label="RSI (14), latest",
          description="Wilder RSI from the technical panel on the most recent date at or "
                      "before the as-of date.",
          sql="""SELECT t.rsi AS rsi_14, t.date AS as_of
FROM technical_signals t
WHERE t.symbol = :symbol AND t.date <= :as_of
ORDER BY t.date DESC
LIMIT 1""",
          entity="TechnicalSignal", source_tables=("technical_signals",),
          unit="index_points", grain="(symbol, date)", cadence="daily",
          timing="coincident", derivation="platform", graded_status="measured",
          graded_evidence="rsi_14 measured NEGATIVE rank-IC at 5 days: on this platform it "
                          "is a mean-reversion input, not a momentum confirmation.",
          synonyms=("rsi", "relative strength index", "overbought", "oversold"),
          caveats=("Graded as a mean-reversion input — a high RSI is not a buy signal here.",
                   "RSI re-expresses price, so on its own it adds no information beyond the "
                   "shape of the recent move.")),

        M(name="signal_win_rate_5d",
          label="Signal win rate, 5-day horizon",
          description="Share of resolved 5-day signals that ended in a win under a single "
                      "labelling rule, with its sample size.",
          sql="""SELECT avg(CASE WHEN s.outcome = 'WIN' THEN 1.0 ELSE 0.0 END) AS win_rate,
       count(*) AS n
FROM signal_outcomes s
WHERE s.horizon_days = 5
  AND s.label_definition = 'path_barrier'
  AND s.outcome IN ('WIN', 'LOSS')
  AND s.signal_date <= :as_of""",
          entity="SignalOutcome", source_tables=("signal_outcomes",),
          unit="probability", grain="market-wide, 5-day horizon", cadence="daily",
          timing="target", derivation="platform", leakage_risk="high",
          graded_status="live", params=("as_of",),
          synonyms=("win rate", "hit rate", "accuracy", "success rate"),
          caveats=("LABEL-SHAPED. This measures the platform's own track record and is never "
                   "a feature.",
                   "`label_definition` is pinned to `path_barrier` deliberately: mixing it "
                   "with `terminal_pct2` makes the rate meaningless.",
                   "`PENDING` and `NEUTRAL` rows are excluded — the honest denominator, and "
                   "it must be stated alongside any rate.",
                   "No `signal_source` filter, so this blends technical and confluence "
                   "signals.")),

        M(name="usable_factor_readings_5d",
          label="Usable factor readings at 5 days",
          description="How many graded factor readings at a 5-day horizon currently clear "
                      "the power and independence guards.",
          sql="""SELECT count(*) AS usable_readings, max(f.eff_dates) AS max_eff_dates
FROM factor_edge_history f
WHERE f.horizon_days = 5 AND f.verdict = 'USABLE' AND f.run_at <= :as_of""",
          entity="EdgeReading", source_tables=("factor_edge_history",),
          unit="count", grain="per grading run, 5-day horizon", cadence="on_grading",
          timing="context", derivation="platform", graded_status="live", params=("as_of",),
          synonyms=("usable factors", "factor edge", "graded factors", "rank ic count"),
          caveats=("A reading is only readable alongside its `eff_dates`: overlapping "
                   "forward windows inflate a correlation by roughly the horizon factor.",
                   "`verdict` is matched exactly — the ledger stores `no edge` with a space "
                   "and `n/a` alongside `USABLE` and `LOW-DATA`.")),

        M(name="unified_score_latest",
          label="Unified score, latest served",
          description="The highest composite score served for a symbol at or before the "
                      "as-of date, with its conviction bucket and timeframe.",
          sql="""SELECT u.unified_score, u.conviction_level, u.classification, u.timeframe
FROM unified_recommendations u
WHERE u.symbol = :symbol AND u.computed_at <= :as_of
ORDER BY u.unified_score DESC
LIMIT 1""",
          entity="Recommendation", source_tables=("unified_recommendations",),
          unit="score_0_100", grain="(symbol, computed_at, timeframe)", cadence="daily",
          timing="coincident", derivation="platform", graded_status="live",
          synonyms=("unified score", "composite score", "conviction", "top pick", "ranking"),
          caveats=("`computed_at` is TEXT in this table — comparing it against a DATE "
                   "elsewhere needs an explicit cast.",
                   "The ranker's load-bearing input is the confluence engine, so a high "
                   "unified score with a low engine-coverage count is weak evidence.",
                   "Ordering by score across timeframes returns the best of INTRADAY / SWING "
                   "/ POSITIONAL / LONG_TERM rather than a comparable series — filter "
                   "`timeframe` first when the horizon matters.")),

        M(name="confluence_score_latest",
          label="Confluence score, latest",
          description="The most recent multi-engine agreement score with the number of "
                      "screeners holding the name and the model probabilities behind it.",
          sql="""SELECT c.confluence_score, c.active_screener_count, c.conviction_level,
       c.ml_breakout_probability, c.computed_at
FROM confluence_signals c
WHERE c.symbol = :symbol AND c.computed_at <= :as_of
ORDER BY c.computed_at DESC
LIMIT 1""",
          entity="EngineScore", source_tables=("confluence_signals",),
          unit="score_0_100", grain="(symbol, computed_at)", cadence="every_15m",
          timing="coincident", derivation="platform", graded_status="measured",
          graded_evidence="The only engine score on this platform with a growing positive "
                          "graded reading, which is why it carries the ranker.",
          synonyms=("confluence", "confluence score", "engine agreement"),
          caveats=("`computed_at` is native TIMESTAMPTZ here but TEXT on "
                   "`unified_recommendations` — cast across that join.",
                   "`ml_breakout_probability` is a model output and must not be used as a "
                   "feature elsewhere.")),

        M(name="index_pcr_latest",
          label="Index put-call ratio, latest",
          description="The most recent index PCR reading with the index close at the same "
                      "instant.",
          sql="""SELECT n.pcr, n.index_close, n.ts
FROM nt_index_pcr_ts n
WHERE n.index_name = 'NIFTY50' AND n.ts <= :as_of
ORDER BY n.ts DESC
LIMIT 1""",
          entity="IndexDerivativesSnapshot", source_tables=("nt_index_pcr_ts",),
          unit="ratio", grain="(index, timestamp, expiry)", cadence="intraday",
          timing="leading", derivation="vendor", graded_status="research-candidate",
          graded_evidence="Index positioning is classed as genuinely leading in the master "
                          "report's taxonomy, but remains ungraded here (Experiment 6).",
          params=("as_of",), cheap=False,
          synonyms=("pcr", "put call ratio", "index pcr", "options positioning",
                    "derivatives sentiment"),
          caveats=("Pinned to NIFTY50 deliberately: the index name is a dimension this "
                   "metric does not parameterise.",
                   "Three PCR variants exist in the source table (OI, volume, OI change) and "
                   "they measure different things.",
                   "Leading is not the same as profitable — this is ungraded.")),

        M(name="rollover_pct_latest",
          label="Futures rollover, latest",
          description="The latest rollover percentage and annualised cost of carry for a "
                      "stock's futures, with its total open interest.",
          sql="""SELECT r.rollover_pct, r.cost_of_carry_ann, r.total_oi, r.date
FROM fno_rollover r
WHERE r.symbol = :symbol AND r.date <= :as_of
ORDER BY r.date DESC
LIMIT 1""",
          entity="FuturesPositioning", source_tables=("fno_rollover",),
          unit="percent", grain="(symbol, date)", cadence="daily",
          timing="leading", derivation="vendor", graded_status="low-data",
          graded_evidence="The stock-futures panel spans ~14 dates; the master report's "
                          "verdict is LOW-DATA, so a reading from it is a calendar artefact.",
          synonyms=("rollover", "rollover percent", "futures rollover", "cost of carry",
                    "open interest"),
          caveats=("LOW-DATA panel: never treat a correlation computed on it as an edge.",
                   "Rollover is only meaningful in the days before an expiry; outside that "
                   "window the number is mostly noise.")),

        M(name="market_breadth_latest",
          label="Market breadth, latest",
          description="Share of the universe above its 200-day average and the "
                      "advance/decline ratio for the most recent session.",
          sql="""SELECT b.pct_above_200dma, b.adv_decline_ratio, b.date
FROM market_breadth b
WHERE b.date <= :as_of
ORDER BY b.date DESC
LIMIT 1""",
          entity="BreadthObservation", source_tables=("market_breadth",),
          unit="percent", grain="per session", cadence="daily",
          timing="context", derivation="platform", graded_status="ungraded", params=("as_of",),
          synonyms=("breadth", "advance decline", "participation", "market internals"),
          caveats=("Computed over this platform's own universe definition, so it is not "
                   "comparable to a vendor's breadth series without re-basing.",
                   "Classed as a FILTER on this platform, not as alpha.")),

        M(name="current_regime",
          label="Current market regime",
          description="The regime label and its posterior probability for the most recent "
                      "session at or before the as-of date.",
          sql="""SELECT m.regime, m.regime_prob, m.date
FROM market_regimes m
WHERE m.date <= :as_of
ORDER BY m.date DESC
LIMIT 1""",
          entity="RegimeState", source_tables=("market_regimes",),
          unit=None, grain="per session", cadence="daily",
          timing="context", derivation="platform", graded_status="live", params=("as_of",),
          synonyms=("regime", "market regime", "bull", "bear", "sideways", "volatility state"),
          caveats=("The regime is a WEIGHT GATE here, not a directional call: it re-blends "
                   "engine weights, so reading it as a trade is a category error.",
                   "`regime_prob` is an HMM posterior, not a calibrated probability of a "
                   "market outcome.")),

        M(name="asm_flag_latest",
          label="Surveillance flag, latest",
          description="Whether the symbol is under exchange surveillance measures as of the "
                      "most recent signal date.",
          sql="""SELECT t.asm_flag, t.date AS as_of
FROM technical_signals t
WHERE t.symbol = :symbol AND t.date <= :as_of
ORDER BY t.date DESC
LIMIT 1""",
          entity="TechnicalSignal", source_tables=("technical_signals",),
          unit=None, grain="(symbol, date)", cadence="daily",
          timing="coincident", derivation="vendor", graded_status="live",
          synonyms=("asm", "gsm", "surveillance", "tradability", "ban"),
          caveats=("This is a TRADABILITY CONSTRAINT, not a signal: a name under surveillance "
                   "can be untradeable in size regardless of how good the setup looks.",
                   "It is stamped from a fetched list, so it lags the exchange's own "
                   "announcement by however long the fetcher took.")),

        M(name="analyst_consensus_latest",
          label="Analyst consensus, latest",
          description="Mean analyst target, contributor count and consensus rating from the "
                      "most recent snapshot at or before the as-of date.",
          sql="""SELECT a.target_mean, a.n_analysts, a.final_rating, a.as_of_date
FROM analyst_estimates_history a
WHERE a.symbol = :symbol AND a.as_of_date <= :as_of
ORDER BY a.as_of_date DESC
LIMIT 1""",
          entity="AnalystEstimate", source_tables=("analyst_estimates_history",),
          unit="per_share_INR", grain="(symbol, as_of_date)", cadence="vendor_periodic",
          timing="leading", derivation="vendor", graded_status="ungraded",
          graded_evidence="Genuinely leading in the taxonomy, but the revision trio derived "
                          "from it is calendar-blocked to ~2026-10.",
          synonyms=("analyst", "consensus", "target price", "price target", "analyst rating",
                    "estimates"),
          caveats=("`target_mean` is a per-share price in INR, not a return — it must be "
                   "divided by a price to become an upside percentage.",
                   "Snapshots are as-of-stamped: re-fetching later can return a different "
                   "history than the one that was knowable.")),

        M(name="screener_5d_forward_return",
          label="Screener 5-day forward return",
          description="Average 5-session forward return across the times this symbol was "
                      "surfaced by a live screener, with the sample size.",
          sql="""SELECT avg(l.return_5d) AS avg_forward_5d, count(*) AS n
FROM live_screener_outcomes l
WHERE l.symbol = :symbol AND l.appeared_at <= :as_of AND l.return_5d IS NOT NULL""",
          entity="ScreenerOutcome", source_tables=("live_screener_outcomes",),
          unit="percent", grain="(symbol, appearance)", cadence="every_15m",
          timing="target", derivation="platform", leakage_risk="high",
          graded_status="live",
          synonyms=("screener performance", "screener forward return", "screener edge",
                    "surfacing outcome"),
          caveats=("This is a LABEL aggregate, not a feature: it measures how the screener "
                   "family performed historically for this symbol.",
                   "NULL `return_5d` rows are excluded, so recent appearances do not drag the "
                   "average toward zero — but they do make `n` smaller than the appearance "
                   "count.",
                   "Attribution belongs to whichever screeners surfaced the name; averaging "
                   "across all of them mixes unrelated strategies.")),

        M(name="news_sentiment_5d",
          label="News sentiment, trailing 5 sessions",
          description="Mean scored sentiment across news items mentioning the symbol in the "
                      "five sessions up to the as-of date, with the mention count.",
          sql="""SELECT avg(n.sentiment_score) AS avg_sentiment, count(*) AS mentions
FROM news_symbol_link n
WHERE n.symbol = :symbol AND n.published_at <= :as_of
  AND n.published_at > ((:as_of)::date - 5)""",
          entity="NewsItem", source_tables=("news_symbol_link",),
          unit="score_minus1_1", grain="(symbol, trailing 5 sessions)", cadence="intraday",
          timing="leading", derivation="platform", graded_status="measured",
          graded_evidence="News sentiment conditioning on movers measured a lift of ~0.13 "
                          "(n=114, p=0.037) — a lead, not a result.",
          synonyms=("news sentiment", "sentiment", "headline sentiment", "news flow",
                    "news count"),
          caveats=("Counts MENTIONS, not articles: one widely covered item produces many "
                   "rows and will dominate the average.",
                   "`published_at` is the only knowable timestamp — filtering on the event "
                   "date instead is a look-ahead bug.",
                   "A mention is not a foreign key: this join must go through the link table, "
                   "never through the JSON array on the news row.",
                   "Scored sentiment comes from either the vendor or FinBERT depending on "
                   "`ai_scored`; the two are not the same measurement.")),

        M(name="excursion_path_5d",
          label="Excursion path, 5-day horizon",
          description="Average maximum favourable and adverse excursion for resolved 5-day "
                      "signals on a symbol, with the sample size.",
          sql="""SELECT avg(e.mfe_pct) AS avg_mfe, avg(e.mae_pct) AS avg_mae,
       count(*) AS n
FROM signal_excursions e
WHERE e.symbol = :symbol AND e.horizon_days = 5 AND e.signal_date <= :as_of""",
          entity="SignalExcursion", source_tables=("signal_excursions",),
          unit="percent", grain="(symbol, signal_date, horizon)", cadence="daily",
          timing="target", derivation="platform", leakage_risk="high",
          graded_status="live",
          synonyms=("mfe", "mae", "excursion", "drawdown", "stop loss study",
                    "favourable excursion"),
          caveats=("LABEL-SHAPED. MFE/MAE describe what already happened; they are never "
                   "inputs.",
                   "The horizon is pinned to 5 sessions — a 1-day and a 20-day path are "
                   "different distributions and must not be averaged together.",
                   "Path statistics make stop placement answerable: the terminal return alone "
                   "cannot say whether the trade was ever viable.")),
    )
