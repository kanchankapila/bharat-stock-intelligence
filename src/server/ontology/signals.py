"""Versioned signal catalog: the signal-level contract the ontology's column cards do not carry.

The ontology answers "what is this column"; this answers "what is this *signal*": its exact
formula, unit, lookback, the earliest moment it was knowable, where it lives, how many NSE
symbols it covers, what measured verdict stands behind it, and which other signals it needs.

Rules:
* Definitions are copied from the WRITER (file named in each definition), never from a vendor
  page. A formula you cannot point at in code does not belong here.
* No count lives in this file. Coverage is generated from Postgres by `python -m ontology
  signals coverage` and stamped with an as-of date, because a hand-written count is stale on
  the next run.
* Published versions are immutable: `docs/ontology/signal_catalog/v<VERSION>.json` must equal
  `catalog()`; change a definition and the test fails until VERSION is bumped and a new file is
  written (`python -m ontology signals export`). MAJOR = a signal's meaning changed, MINOR = a
  signal or relation added, PATCH = wording that does not change meaning.
* `measured` states what measurement.md / the ledger recorded, or says none was. Nothing here is
  evidence of edge; the ranker has no demonstrated forward-return edge.
* Scope of 1.0.0: equity, index, future, option; ETF is declared but NOT collected.
"""
import os
from dataclasses import asdict, dataclass
from typing import Dict, List, Optional, Tuple

SIGNAL_CATALOG_VERSION = "1.1.0"
ONTOLOGY_COMPAT = "1.1.0"
CATALOG_DIR = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "docs", "ontology", "signal_catalog"))

INSTRUMENTS: Tuple[Tuple[str, str], ...] = (
    ("equity", "Listed share, identified by NSE symbol (the only canonical identifier)."),
    ("index", "Calculated benchmark; not tradable. Keyed by index name, not NSE symbol."),
    ("future", "Standardized contract on an underlying with an expiry (stock and index futures)."),
    ("option", "Contract with underlying, expiry, strike and call/put side (stock and index options)."),
    ("etf", "Exchange-traded fund. DECLARED ONLY: no ETF table exists and nse_stocks name-matches at most one."),
)

CONCEPTS: Tuple[Tuple[str, str], ...] = (
    ("ohlcv", "Open, high, low, close and traded volume for an instrument and interval."),
    ("volume", "Quantity traded in an interval, in instrument-specific units (shares for equity)."),
    ("delivery", "Share of cash-market traded quantity that settled by delivery; not investor buying."),
    ("open_interest", "Outstanding derivative contracts at an observation; not traded volume."),
    ("implied_volatility", "Volatility parameter implied by an option price under a stated model."),
    ("corporate_actions", "Issuer events that change price comparability or entitlements."),
    ("earnings", "Reported financial performance for an accounting period."),
    ("insider_trades", "Disclosed trades by persons covered by insider-disclosure rules."),
    ("breadth", "Cross-sectional participation across a defined universe; market-wide, one value per day."),
    ("momentum", "Persistence of a past return over a stated horizon."),
    ("mean_reversion", "Deviation of price from a reference, expected to close."),
    ("volatility", "Magnitude of price fluctuation over a stated window."),
    ("flows", "Net institutional purchases, market-wide."),
    ("ownership", "Distribution of securities among reported holder categories."),
    ("regime", "Market state used to re-weight engines; a gate, not alpha."),
    ("ranking", "The platform's canonical stock ordering."),
)


@dataclass(frozen=True)
class SignalDef:
    name: str
    label: str
    definition: str
    unit: str
    lookback: str
    availability: str
    instruments: Tuple[str, ...]
    concepts: Tuple[str, ...]
    sources: Tuple[str, ...]            # "table.column"
    symbol_column: Optional[str]        # None = market-wide or index-keyed
    date_column: str
    measured: str
    requires: Tuple[str, ...] = ()      # signals that must exist for this one to be computable
    derived_from: Tuple[str, ...] = ()  # signals or instrument ids this is computed from
    caveats: Tuple[str, ...] = ()


S = SignalDef

SIGNALS: Tuple[SignalDef, ...] = (
    S("daily_ohlcv", "Daily OHLCV bar",
      "Open, high, low, close in INR/share and volume in shares for one NSE session; one row per "
      "(symbol, date). Price basis is per row in adjustment_basis (nse_bhavcopy_raw, split_only, "
      "split_dividend).",
      "INR/share; shares", "1 session",
      "End of session `date`; the card's expected lag is 5h. Not knowable intraday.",
      ("equity",), ("ohlcv", "volume"),
      ("stock_ohlcv.open", "stock_ohlcv.high", "stock_ohlcv.low", "stock_ohlcv.close", "stock_ohlcv.volume"),
      "symbol", "date",
      "Data, not a signal: no edge claim.",
      caveats=("Mixing adjustment_basis inside one series corrupts a backtest silently.",
               "Filter is_suspect = 0 before building a panel; suspect bars are flagged, not deleted.",
               "History starts 2021-01; names delisted before today may be absent (price paths iterate "
               "the current nse_stocks master).")),
    S("traded_volume", "Traded volume",
      "stock_ohlcv.volume: shares traded in the session.",
      "shares", "1 session", "End of session `date`.",
      ("equity",), ("volume",), ("stock_ohlcv.volume",), "symbol", "date",
      "Data, not a signal.",
      derived_from=("daily_ohlcv",),
      caveats=("Not adjusted by a split unless adjustment_basis says so: a split halves price and doubles shares.",)),
    S("trailing_return", "Trailing close-to-close return",
      "ret_{d}d = close_t / close_(t-d) - 1 for d in 1, 5, 15, 21, 63, 126, 252 trading rows "
      "(feature_engineering.py, pandas pct_change on the symbol's own rows).",
      "fraction (0.05 = 5%)", "d trading rows, d in {1,5,15,21,63,126,252}",
      "End of session t, once stock_ohlcv for t exists; feature_store card lag 5h.",
      ("equity",), ("momentum",),
      ("feature_store.ret_1d", "feature_store.ret_5d", "feature_store.ret_21d", "feature_store.ret_63d",
       "feature_store.ret_252d"),
      "symbol", "date",
      "ret_21d / ret_63d / reversal_21d: negative, t down to -3.96, dead (measurement.md 'Already tested').",
      requires=("daily_ohlcv", "corporate_action_event"),
      caveats=("Counts rows, not calendar days: a missing bar silently lengthens the window.",
               "Crossing an unadjusted split or bonus fabricates a +/-50% return; check adjustment_basis.")),
    S("momentum_12_1", "12-month return excluding the last month",
      "feature_store.ret_12m_ex1m = close.pct_change(252) - close.pct_change(21): a DIFFERENCE of "
      "two simple returns, not the compounded skip-month return (1+r252)/(1+r21)-1.",
      "fraction", "252 trading rows", "End of session t.",
      ("equity",), ("momentum",), ("feature_store.ret_12m_ex1m",), "symbol", "date",
      "Not demonstrated. 2026-10-27 re-run: +0.80%/period vs universe, t 1.67 (25 bps/side, 56 "
      "periods); a later H1 run is VOID on a defective split/bonus adjustment panel (measurement.md).",
      derived_from=("trailing_return",),
      caveats=("Difference form overstates names whose 21d return is large and negative.",)),
    S("dist_sma20_pct", "Distance from 20-day mean",
      "(close - sma20) / sma20, sma20 = close.rolling(20).mean() including today.",
      "fraction despite the _pct suffix (0.05 = 5%)", "20 trading rows", "End of session t.",
      ("equity",), ("mean_reversion",), ("feature_store.dist_sma20_pct",), "symbol", "date",
      "No standalone verdict recorded; see mean_reversion_14.",
      derived_from=("daily_ohlcv",),
      caveats=("Column name says percent, value is a fraction.",)),
    S("mean_reversion_14", "Mean-reversion composite",
      "Research composite in factor_backtest.py: sign-flipped combination of 14 feature_store "
      "factors that measured negative. NOT a stored column; recompute from feature_store.",
      "unitless rank score", "per constituent factor (up to 252 rows)",
      "End of session t; only as available as its slowest input.",
      ("equity",), ("mean_reversion",), ("feature_store.dist_sma20_pct",), "symbol", "date",
      "Standalone long factor significantly NEGATIVE: 67 periods, net excess -0.94%/period, t -3.26, "
      "0/6 years positive (2026-09-26). The veto-on-momentum arm is undecided (measured through a "
      "defective panel).",
      derived_from=("dist_sma20_pct", "trailing_return"),
      caveats=("The constituent list lives in factor_backtest.py; cite its commit with any result.",)),
    S("hist_vol_21d", "21-day realised volatility",
      "std of 21 daily log returns * sqrt(252) (feature_engineering.py).",
      "annualised fraction (0.30 = 30%)", "21 trading rows", "End of session t.",
      ("equity",), ("volatility",), ("feature_store.hist_vol_21d",), "symbol", "date",
      "Risk descriptor; no directional verdict. Strong-looking factors here have been volatility "
      "detectors (reverse audit).",
      derived_from=("daily_ohlcv",)),
    S("atr_pct", "ATR as a share of price",
      "atr_14 / close (feature_engineering.py).",
      "fraction", "14 trading rows", "End of session t.",
      ("equity",), ("volatility",), ("feature_store.atr_pct",), "symbol", "date",
      "Risk descriptor; no directional verdict.",
      derived_from=("daily_ohlcv",)),
    S("volume_ratio_20d", "Relative volume",
      "vol / vol.rolling(20).mean(); the 20-row mean INCLUDES today's volume.",
      "ratio", "20 trading rows", "End of session t.",
      ("equity",), ("volume",), ("feature_store.volume_ratio_20d",), "symbol", "date",
      "No verdict recorded.",
      derived_from=("traded_volume",),
      caveats=("Including today in the denominator compresses spikes; not comparable with a "
               "prior-20-day baseline.",)),
    S("delivery_pct", "Delivery percentage",
      "stock_delivery_data.delivery_pct: delivery_qty / traded_qty * 100 for the session, as "
      "published by NSE.",
      "percent (0-100)", "1 session",
      "T+1: the value for session D is published after D and is knowable only during D+1 (card lag 24h).",
      ("equity",), ("delivery",), ("stock_delivery_data.delivery_pct",), "symbol", "date",
      "Raw level: quintile spread +0.19pp/day, t +7.82, but long-only top-50 net -1.04%/period "
      "(21d, 25 bps) and -0.15%/period (5d, 15 bps): dead as a long-only factor.",
      requires=("traded_volume",),
      caveats=("A same-session join is a look-ahead.",
               "stock_delivery_volume is a sibling table with different column names and coverage.")),
    S("delivery_z_20d", "Delivery z-score",
      "(delivery_pct_t - mean20) / std20 over rolling(20, min_periods=10) INCLUDING day t "
      "(feature_engineering.py). Differs from the ontology metric delivery_surprise_z, whose "
      "baseline is the 20 sessions BEFORE t.",
      "z", "20 sessions (>= 10 observed)", "T+1, same as delivery_pct.",
      ("equity",), ("delivery",), ("feature_store.delivery_z_20d",), "symbol", "date",
      "Closest tested analogues delivery_spike / delivery_trend: t -1.08 / -1.43, dead.",
      derived_from=("delivery_pct",),
      caveats=("Two different 'delivery z' definitions coexist; name which one a result used.",)),
    S("futures_open_interest", "Futures open interest",
      "stock_futures_oi_history.open_interest: outstanding futures for (symbol, expiry) on the "
      "session, as served by Moneycontrol, in SHARES (identical to the exchange file's OPEN_INT for "
      "216 of 216 overlapping symbols on 2026-11-11); divide by lot_size for contracts.",
      "shares (lot_size = shares per contract)", "1 session",
      "After the vendor publishes the session; use fetched_at, not date. No row exists before the "
      "first fetch day, so this cannot be backfilled.",
      ("future",), ("open_interest",),
      ("stock_futures_oi_history.open_interest", "stock_futures_oi_history.oi_change",
       "stock_futures_oi_history.lot_size"),
      "symbol", "date",
      "LOW-DATA: oi_change 5d IC +0.078 / AUC 0.532 on 13 dates; 1d no edge (measurement.md).",
      caveats=("Source column is moneycontrol only; the panel is short, so any reading is a "
               "calendar artefact until a year exists.",
               "OI has a buyer and a seller for every contract: it does not show direction.",
               "Until AF-20261113-02 is applied, rows exist under non-F&O symbols that share an "
               "mcsymbol with an F&O name: verbatim copies of the owner's contract. The fetcher "
               "no longer writes them; the historical rows stay until purged.",
               "futures_eod holds the exchange's own series from 2021; prefer it for history.")),
    S("futures_eod", "Exchange futures end-of-day (history)",
      "stock_futures_eod_history: for each symbol and trade_date, the two nearest expiries on or "
      "after the trade date (expiry_rank 1, 2; rank 1 is the EXPIRING contract on an expiry day, "
      "flagged is_expiry_day) with the exchange's close, settle, contracts_traded, open_interest "
      "and oi_change exactly as the daily F&O bhavcopy states them "
      "(nse_fo_bhav_history_fetcher.py). Stock futures plus NIFTY and BANKNIFTY index futures.",
      "INR/share; contracts; open_interest and oi_change in shares", "1 session",
      "End of trade_date for the exchange file. Loaded retrospectively by a one-shot backfill, so "
      "fetched_at is load time, not publication time: a backtest must use trade_date + 1.",
      ("future",), ("open_interest", "ohlcv"),
      ("stock_futures_eod_history.open_interest", "stock_futures_eod_history.oi_change",
       "stock_futures_eod_history.settle", "stock_futures_eod_history.contracts_traded"),
      "symbol", "trade_date",
      "Data, not a signal: no verdict. Makes oi_buildup gradable on a 2021+ panel instead of waiting "
      "for the Moneycontrol series to age.",
      derived_from=("future",),
      caveats=("Symbols are the file's own: a renamed name has two histories (no rename mapping).",
               "No rows for index futures other than NIFTY and BANKNIFTY.",
               "Not refreshed nightly: a one-shot research backfill, like stock_option_features_history.")),
    S("futures_oi_change", "Futures OI change",
      "stock_futures_oi_history.oi_change (absolute) and oi_pct_change (percent) versus the "
      "previous session for the same expiry, vendor-computed.",
      "contracts; percent", "1 session", "After the vendor publishes the session; use fetched_at, not date. No row exists before the first fetch day.",
      ("future",), ("open_interest",),
      ("stock_futures_oi_history.oi_change", "stock_futures_oi_history.oi_pct_change"),
      "symbol", "date",
      "No edge at 1d; 5d LOW-DATA (see futures_open_interest).",
      requires=("futures_open_interest",),
      caveats=("Expiry roll days mix two series: check expiry before differencing.",)),
    S("oi_buildup", "Futures OI buildup label",
      "stock_futures_oi_history.oi_buildup in {Long Buildup, Short Buildup, Long Unwinding, Short "
      "Covering}: the vendor's classification of the sign of price change against the sign of OI "
      "change (price up + OI up = Long Buildup; price down + OI up = Short Buildup; price down + OI "
      "down = Long Unwinding; price up + OI down = Short Covering). The price reference the vendor "
      "uses is not documented. Option rows carry the same idea per strike in so_option_chain."
      "ce_buildup / pe_buildup.",
      "label", "1 session", "After the vendor publishes the session; use fetched_at, not date. No row exists before the first fetch day.",
      ("future", "option"), ("open_interest",),
      ("stock_futures_oi_history.oi_buildup", "so_option_chain.ce_buildup", "so_option_chain.pe_buildup"),
      "symbol", "date",
      "No verdict recorded for the label; its inputs (oi_change) show no edge and the panel is short.",
      requires=("futures_oi_change", "daily_ohlcv"),
      caveats=("Futures uses 'Buildup'; the option chain uses 'Build Up': never compare the strings across tables.",
               "A label from OI alone is impossible: it needs both futures OI and a price change.",
               "Vendor label, not recomputed here.")),
    S("rollover_pct", "Futures rollover share",
      "next_oi / (near_oi + next_oi) * 100 at the session (fno_rollover_fetcher.py); a second "
      "vendor-served rollover_pct exists in stock_futures_oi_history.",
      "percent (0-100)", "1 session", "After the exchange file for the session is parsed; use fetched_at.",
      ("future",), ("open_interest",), ("fno_rollover.rollover_pct",), "symbol", "date",
      "Negative, LOW-DATA (measurement.md).",
      requires=("futures_open_interest",),
      caveats=("Two columns of the same name from two writers: state which one.",)),
    S("cost_of_carry_ann", "Annualised cost of carry",
      "(near_close - spot) / spot * 100 / days_to_expiry * 365 (fno_rollover_fetcher.py); spot is "
      "the file's underlying price.",
      "percent per annum", "1 session to near expiry", "After the exchange file for the session is parsed; use fetched_at, not date.",
      ("future",), ("open_interest",), ("fno_rollover.cost_of_carry_ann",), "symbol", "date",
      "Tested as futures carry on the 2021-01..2024-07 panel; read that measurement.md entry "
      "before quoting a number.",
      requires=("daily_ohlcv",),
      derived_from=("future",),
      caveats=("Undefined when days_to_expiry <= 0.",)),
    S("option_open_interest", "Option open interest by strike",
      "so_option_chain.ce_oi / pe_oi: outstanding call / put contracts for (symbol, date, expiry, "
      "strike).",
      "contracts as served", "1 session", "After the vendor snapshot; use fetched_at.",
      ("option",), ("open_interest",),
      ("so_option_chain.ce_oi", "so_option_chain.pe_oi"), "symbol", "date",
      "Data, not a signal.",
      caveats=("A grid: one session yields many rows per symbol; a naive join multiplies parent rows.",
               "Stock option-chain history is far shallower than the index panels.")),
    S("pcr_oi", "Put-call ratio by open interest",
      "put_oi / call_oi, each summed over EVERY strike of the nearest option expiry strictly after "
      "the trade date (nse_fo_bhav_history_fetcher.py); in shares. Index form: "
      "index_max_pain.pcr_oi and nt_index_pcr_ts.pcr.",
      "ratio (unitless)", "1 session, near expiry", "End of trade_date for the exchange file; the "
      "table was loaded retrospectively, so fetched_at is load time, not publication time.",
      ("option", "equity", "index"), ("open_interest",),
      ("stock_option_features_history.pcr_oi", "index_max_pain.pcr_oi", "nt_index_pcr_ts.pcr"),
      "symbol", "trade_date",
      "Descriptive only: IC +0.010, its book loses 0.36% net (2026-10-09 pre-registered run).",
      requires=("option_open_interest",),
      derived_from=("option", "option_open_interest"),
      caveats=("Options-derived: it cannot exist without option OI.",
               "nt_index_pcr_ts carries three PCRs (OI, volume, change-in-OI); they are not interchangeable.",
               "stock_option_features_history ends 2024-07-05 at time of writing.")),
    S("atm_iv", "At-the-money implied volatility",
      "Black-76 on the forward F, r = 6.5%, T = calendar days to expiry / 365; OTM-side IVs "
      "(puts <= F, calls >= F) interpolated linearly in strike to F; only contracts that traded "
      "are priced (nse_fo_bhav_history_fetcher.py). F = same-expiry future settle, else "
      "put-call parity on the traded pair with the smallest |C-P|.",
      "annualised fraction (0.23 = 23%)", "1 session, near expiry", "End of trade_date for the exchange file; the table was loaded retrospectively, so fetched_at is load time, not publication time.",
      ("option",), ("implied_volatility",),
      ("stock_option_features_history.atm_iv",), "symbol", "trade_date",
      "No verdict recorded.",
      requires=("option_open_interest",),
      derived_from=("option", "futures_open_interest"),
      caveats=("so_option_chain.ce_iv / pe_iv are vendor values in PERCENT points (35.25), "
               "this column is a fraction: never mix them.",
               "spot_proxy in the same table is derived from the future, so forward/spot_proxy is a "
               "constant (a trap for carry studies).")),
    S("skew_95_105", "Put-call implied-volatility skew",
      "IV(traded OTM put nearest 0.95F) - IV(traded OTM call nearest 1.05F), each within 2.5% "
      "moneyness of target (nse_fo_bhav_history_fetcher.py); positive = downside put bid.",
      "volatility points as a fraction", "1 session, near expiry", "End of trade_date for the exchange file; the table was loaded retrospectively, so fetched_at is load time, not publication time.",
      ("option",), ("implied_volatility",),
      ("stock_option_features_history.skew_95_105",), "symbol", "trade_date",
      "H5 FAIL, wrong sign: IC +0.024 at 5 sessions against a negative prediction, -0.49% net "
      "(measurement.md, 2026-10-09).",
      derived_from=("atm_iv",)),
    S("straddle_pct", "ATM straddle size",
      "(ATM call close + ATM put close) / spot_proxy * 100; NULL unless both legs traded.",
      "percent of spot", "1 session, near expiry", "End of trade_date for the exchange file; the table was loaded retrospectively, so fetched_at is load time, not publication time.",
      ("option",), ("implied_volatility",),
      ("stock_option_features_history.straddle_pct",), "symbol", "trade_date",
      "Descriptive only: IC -0.019.",
      derived_from=("atm_iv",)),
    S("index_max_pain", "Index max pain",
      "Strike minimising total option-writer payout for the expiry (a mechanical calculation, "
      "index_max_pain.max_pain).",
      "index points", "1 session, per expiry", "After the vendor snapshot; use fetched_at.",
      ("index", "option"), ("open_interest",), ("index_max_pain.max_pain",), None, "date",
      "Unvalidated research candidate; a mechanical value, not a prediction.",
      requires=("option_open_interest",),
      derived_from=("option",)),
    S("corporate_action_event", "Corporate action event",
      "One row per (symbol, ex_date, action_type): DIVIDEND, DIVIDEND_SPECIAL, BONUS, SPLIT, OTHER, "
      "with ratio and amount where parsed. Used to adjust prices.",
      "event; amount in INR/share; ratio unitless", "event",
      "Effective on ex_date. The ANNOUNCEMENT date is not stored (ingested_at is load time), so the "
      "table is not point-in-time for when an action became known.",
      ("equity",), ("corporate_actions",),
      ("corporate_actions.ex_date", "corporate_actions.action_type", "corporate_actions.ratio",
       "corporate_actions.amount"),
      "symbol", "ex_date",
      "Infrastructure: no edge claim.",
      caveats=("Carries 'Quarterly Results' rows that are not capital actions: filter action_type.",
               "The NSE-sourced rows never populate ratio; history before the NSE writer comes from yfinance.",
               "Demergers and rights are not share-ratio actions: a mechanical 2:1 reading is wrong.")),
    S("eps_surprise_pct", "EPS surprise",
      "eps_surprise_history.eps_surprise: reported EPS versus the vendor consensus estimate for the "
      "fiscal quarter, as served by Moneycontrol.",
      "percent as served", "1 fiscal quarter", "After the vendor publishes the quarter; use fetched_at. "
      "`quarter` is a fiscal label (Q2FY26), not a date.",
      ("equity",), ("earnings",),
      ("eps_surprise_history.eps_surprise", "eps_surprise_history.eps_actual",
       "eps_surprise_history.eps_estimate"),
      "symbol", "fetched_at",
      "earnings_beat_yoy / qoq underpowered (3-27 periods), calendar-blocked until ~12+ months exist.",
      caveats=("Sequencing the quarter label as a string sorts wrongly across a year boundary.",
               "Estimate vintage is not stored: the consensus may be post-revision.")),
    S("earnings_filing_event", "Results filing event",
      "One row per NSE integrated filing (nse_results_filings) with broadcast_ts, and parsed "
      "financial facts in nse_filing_financials. broadcast_ts is the first moment the result was "
      "public on the exchange.",
      "event", "event", "broadcast_ts (UTC), the earliest knowable time; fetched/first-observed "
      "timestamps can be later.",
      ("equity",), ("earnings",), ("nse_results_filings.broadcast_ts",), "symbol", "broadcast_ts",
      "Results strength is forecastable before filing (learned IC 0.41); the price reaction is not "
      "(IC ~0) (memory: earnings preview, 2026-10-27).",
      caveats=("Original versus revision labelling must be preserved; bank and insurer formats differ.",)),
    S("insider_buy_pct_90d", "Insider buy share, 90 days",
      "buy_qty / (buy_qty + sell_qty) over a 90-calendar-day window of OPEN-MARKET insider trades; "
      "a trade counts from date_iso + 7 calendar days; windows with no trade read 0.5 (neutral), "
      "never 0 (insider_features.py).",
      "fraction (0-1)", "90 calendar days", "Trade date + 7 calendar days (disclosure lag).",
      ("equity",), ("insider_trades",),
      ("insider_trades.quantity", "insider_trades.typeOfTransaction", "insider_trades.date_iso"),
      "symbol", "date_iso",
      "insider_net +0.29%/period, t 1.73: not significant. PIT net buying IC -0.014 (descriptive).",
      caveats=("insider_trades stores the trade date, not the disclosure date.",
               "ESOP, gift, pledge, inter-se and allotment rows are excluded as carrying no price view.")),
    S("block_deal_value", "Block / bulk deal value",
      "block_deals.value_cr: deal value in CRORES; qty in shares; trade_type mixed case.",
      "INR crore", "1 session", "End of session `date`.",
      ("equity",), ("flows",), ("block_deals.value_cr", "block_deals.qty"), "symbol", "date",
      "smart_money composite (insider + block + institutional deals): rank IC -0.000 / AUC 0.502 "
      "(h1), -0.020 / 0.484 (h5) at 2026-08-29: weak.",
      caveats=("Normalise trade_type with UPPER() before netting buys and sells.",
               "Four overlapping deal tables exist (block_deals, bulk_deals, bulk_block_deals, "
               "nse_bulk_block_deals): dedupe before summing.")),
    S("pct_above_200dma", "Share of universe above 200-day mean",
      "above.sum / sma-valid.sum across the platform's own universe, close > rolling(200) mean "
      "(market_breadth.py).",
      "fraction (0-1)", "200 trading rows", "End of session; computed_at is the write time.",
      ("equity",), ("breadth",), ("market_breadth.pct_above_200dma",), None, "date",
      "Market-wide: zero cross-sectional variance, so not a stock-selection factor; context only.",
      derived_from=("daily_ohlcv",),
      caveats=("Universe is this platform's own: not comparable with a vendor breadth series.",)),
    S("adv_decline_ratio", "Advancer share of movers",
      "advancers / (advancers + decliners) versus the prior close (market_breadth.py). Note: this "
      "is a SHARE in [0,1], not the conventional advancers/decliners ratio.",
      "fraction (0-1)", "1 session", "End of session, after stock_ohlcv for that date exists; computed_at is the write time.",
      ("equity",), ("breadth",), ("market_breadth.adv_decline_ratio",), None, "date",
      "Market-wide context only.",
      derived_from=("daily_ohlcv",),
      caveats=("feature_store.advance_decline_ratio comes from a different writer: check before joining.",)),
    S("pct_at_20d_high", "Share of universe at a 20-day high",
      "fraction of universe making a fresh 20-day high (market_breadth.py).",
      "fraction (0-1)", "20 trading rows", "End of session, after stock_ohlcv for that date exists; computed_at is the write time.",
      ("equity",), ("breadth", "momentum"), ("market_breadth.pct_at_20d_high",), None, "date",
      "Market-wide context only.",
      derived_from=("daily_ohlcv",)),
    S("net_highs_lows", "Net 52-week highs minus lows",
      "(new 52-week highs - new 52-week lows) / universe (market_breadth.py).",
      "fraction", "252 trading rows", "End of session, after stock_ohlcv for that date exists; computed_at is the write time.",
      ("equity",), ("breadth",), ("market_breadth.net_highs_lows",), None, "date",
      "Market-wide context only.",
      derived_from=("daily_ohlcv",)),
    S("fii_net_cash", "FII net cash flow",
      "fii_dii_flow.fii_net: FII buy minus sell in the cash segment as published, INR crore "
      "(source's convention; the schema does not declare the unit). feature_store.fii_3d_net / "
      "fii_10d_net are rolling(3) / rolling(10) sums of it.",
      "INR crore (undeclared in schema)", "1 session; 3 and 10 session sums", "After the evening "
      "publication; the first value is provisional.",
      ("equity",), ("flows",), ("fii_dii_flow.fii_net", "fii_dii_flow.dii_net"), None, "date",
      "Market-wide: not a stock-selection factor; context only.",
      caveats=("Provisional exchange figures are revised.",)),
    S("market_regime", "Market regime label",
      "market_regimes.regime with regime_prob from the HMM state; used to re-blend engine weights.",
      "label; probability", "model-dependent", "After the nightly regime job; use computed_at.",
      ("index",), ("regime",), ("market_regimes.regime", "market_regimes.regime_prob"), None, "date",
      "A weight gate, not alpha; treating it as a signal inverts its role.",
      caveats=("History is short relative to price history: report per-regime n.",)),
    S("mf_holding_pct", "Mutual-fund holding",
      "stock_mf_holdings.mf_holding_pct: share of equity held by mutual funds for a disclosure "
      "period, with num_funds and chg_vs_prev.",
      "percent of equity", "1 disclosure period (monthly)", "After disclosure; fetched_at.",
      ("equity",), ("ownership",), ("stock_mf_holdings.mf_holding_pct",), "symbol", "date",
      "No verdict recorded.",
      caveats=("Disclosure-grain, not daily: state the carry-forward rule in any panel.",)),
    S("unified_score", "Canonical ranking score",
      "unified_recommendations.unified_score from unified_ranker.py: the platform's one ranking. "
      "Never write a parallel 'final' score.",
      "score as defined by the ranker", "none (cross-sectional per run)",
      "After the evening unified-ranker run; use the history table's generated_at.",
      ("equity",), ("ranking",), ("unified_recommendations.unified_score",), "symbol", "generated_at",
      "No demonstrated forward-return edge; top quintile worst at 5d (memory 2026-10-25).",
      caveats=("Not a calibrated probability.",)),
)

_SIGNAL = {s.name: s for s in SIGNALS}

# (symbol column, date column) per table where one signal's own keys do not describe the table
# (a signal can span several tables, e.g. pcr_oi). None = index-keyed or market-wide.
TABLE_KEYS: Dict[str, Tuple[Optional[str], str]] = {
    "index_max_pain": (None, "date"),
    "nt_index_pcr_ts": (None, "ts"),
    "stock_option_features_history": ("symbol", "trade_date"),
}


def catalog() -> Dict:
    """The publishable catalog. Relations are derived from `requires` / `derived_from` so a
    dependency can never be stated in prose only."""
    relations: List[Dict[str, str]] = []
    for s in SIGNALS:
        for r in s.requires:
            relations.append({"subject": s.name, "predicate": "requires", "object": r})
        for r in s.derived_from:
            relations.append({"subject": s.name, "predicate": "derived_from", "object": r})
    return {
        "signal_catalog_version": SIGNAL_CATALOG_VERSION,
        "ontology_compat": ONTOLOGY_COMPAT,
        "instruments": [{"id": i, "definition": d} for i, d in INSTRUMENTS],
        "concepts": [{"id": i, "definition": d} for i, d in CONCEPTS],
        "signals": [asdict(s) for s in SIGNALS],
        "relations": relations,
    }


def validate() -> List[str]:
    """Static integrity: every reference resolves and every required field is filled. No database
    needed. Whether each source column exists is checked against the live schema by coverage()
    (the ontology binds only some feature_store columns, so it cannot be the oracle)."""
    issues: List[str] = []
    inst = {i for i, _ in INSTRUMENTS}
    conc = {i for i, _ in CONCEPTS}
    names = [s.name for s in SIGNALS]
    if len(names) != len(set(names)):
        issues.append("duplicate signal name")
    refs = set(names) | inst
    for s in SIGNALS:
        for f in ("definition", "unit", "lookback", "availability", "measured", "date_column"):
            if not getattr(s, f).strip():
                issues.append(f"{s.name}: empty {f}")
        if not s.sources:
            issues.append(f"{s.name}: no source")
        for x in s.instruments:
            if x not in inst:
                issues.append(f"{s.name}: unknown instrument {x!r}")
        for x in s.concepts:
            if x not in conc:
                issues.append(f"{s.name}: unknown concept {x!r}")
        for x in s.requires:
            if x not in _SIGNAL:
                issues.append(f"{s.name}: requires unknown signal {x!r}")
        for x in s.derived_from:
            if x not in refs:
                issues.append(f"{s.name}: derived_from unknown {x!r}")
        for src in s.sources:
            if src.count(".") != 1:
                issues.append(f"{s.name}: source {src!r} is not table.column")
    # a signal whose only meaning is derivation from options/futures must say so via an instrument
    for s in SIGNALS:
        if s.name in ("pcr_oi", "atm_iv", "skew_95_105", "straddle_pct") and "option" not in s.instruments:
            issues.append(f"{s.name}: options-derived signal must list the option instrument")
    return issues


def coverage(conn, timeout_s: int = 90) -> Dict:
    """Per source table: rows, distinct symbols, how many of them are in nse_stocks, date range.
    Read-only, stamped. A timeout is recorded as such, never as zero."""
    import datetime as _dt
    tables: Dict[str, Tuple[Optional[str], str]] = {}
    for s in SIGNALS:
        for src in s.sources:
            tables.setdefault(src.split(".")[0], TABLE_KEYS.get(src.split(".")[0], (s.symbol_column, s.date_column)))
    cur = conn.cursor()
    cur.execute("SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema()")
    live: Dict[str, set] = {}
    for tn, cn in cur.fetchall():
        live.setdefault(tn, set()).add(cn)
    cur.execute("SELECT count(*) FROM nse_stocks")
    universe = cur.fetchone()[0]
    out = {"as_of_utc": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
           "universe": "nse_stocks", "universe_symbols": universe, "tables": {}}
    for t, (sym, dcol) in sorted(tables.items()):
        have = live.get(t, set())
        missing = sorted({src.split(".")[1] for s in SIGNALS for src in s.sources
                          if src.split(".")[0] == t} - have)
        row = {"missing_columns": missing}
        if not have:
            row["status"] = "table_missing"
        elif dcol not in have or (sym and sym not in have):
            row["status"] = "key_column_missing"
        else:
            for basis in ("all_rows", "latest_date"):
                where = "" if basis == "all_rows" else f' WHERE "{dcol}" = (SELECT max("{dcol}") FROM "{t}")'
                # group first, then test the ~2.5k distinct symbols against the universe: a per-row
                # FILTER over a multi-million-row hypertable timed out on stock_ohlcv
                sql = (f'WITH d AS (SELECT "{sym}" AS s, count(*) AS n, min("{dcol}") AS lo, max("{dcol}") AS hi '
                       f'FROM "{t}"{where} GROUP BY 1) SELECT sum(n), count(*), '
                       f'count(*) FILTER (WHERE s IN (SELECT symbol FROM nse_stocks)), min(lo)::text, max(hi)::text FROM d'
                       if sym else
                       f'SELECT count(*), NULL, NULL, min("{dcol}")::text, max("{dcol}")::text FROM "{t}"{where}')
                try:
                    cur.execute(f"SET LOCAL statement_timeout = {int(timeout_s) * 1000}")
                    cur.execute(sql)
                    n, d, inu, mn, mx = cur.fetchone()
                    if basis == "latest_date":  # full scan timed out: bound the symbols, still report the span
                        cur.execute(f'SELECT min("{dcol}")::text FROM "{t}"')
                        mn = cur.fetchone()[0]
                    row.pop("error", None)
                    row.update(status="observed", symbols_basis=basis, rows=int(n), distinct_symbols=d,
                               symbols_in_nse_stocks=inu, earliest=mn, latest=mx,
                               pct_of_universe=round(100.0 * inu / universe, 1) if inu is not None and universe else None)
                    break
                except Exception as e:  # noqa: BLE001 - a timeout is data
                    conn.rollback()
                    row.update(status="timeout_or_error", error=str(e).splitlines()[0][:120])
        out["tables"][t] = row
    return out
