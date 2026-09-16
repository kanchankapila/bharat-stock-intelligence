#!/usr/bin/env python3
"""
One-off deep-history backfill for macro_asset_prices / macro_indicators via
global_macro_fetcher's own yfinance pipeline (free source), with ONE deliberate
deviation: OHLCV_WRITE_LABELS is emptied for the duration so the NIFTY50
stock_ohlcv mirror is NEVER touched. fetch_macro() writes that mirror with
yfinance auto_adjust=True closes via ON CONFLICT DO UPDATE -- over a multi-year
window it would silently replace official NSE index bars with vendor-adjusted
ones (the sentinel/overwrite class AF-20260910-19 documents). The
macro_asset_prices / macro_indicators upserts this backfill exists for are
keyed on (date, symbol) / (indicator_name, date) and are safe to re-run.

Why: feature_store's us_10y_yield / dxy / crude_ret_5d / gold_ret_5d /
sp500_ret_5d / nifty_vix were NULL for every row before 2021-11-12 (the day
macro_asset_prices' rolling 30-day fetches started accumulating) -- 444K of
2.67M feature rows. yfinance serves the full window; the daily 08:00 IST
dl-macro-fetch only ever looks back ~40 days.

Run:
  python backfill_macro_history.py --days 2100   # ~5.7 years of history
"""
import argparse

import global_macro_fetcher as gmf


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=2100,
                        help="Calendar days of history to backfill (default 2100 ~ 5.7y)")
    args = parser.parse_args()

    saved = set(gmf.OHLCV_WRITE_LABELS)
    gmf.OHLCV_WRITE_LABELS = set()
    try:
        gmf.fetch_macro(days=args.days)
    finally:
        gmf.OHLCV_WRITE_LABELS = saved


if __name__ == "__main__":
    main()
