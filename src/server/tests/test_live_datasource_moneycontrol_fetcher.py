"""Live-datasource test for moneycontrol_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule).

This is the single broadest scraper in the platform -- ~10 MoneyControl endpoints (technicals,
essentials, insights, analyst-rating, price-forecast, earnings-forecast, hits-misses, plus 3
HTML widgets: insider/vitals/scans) feeding 8 different tables in one `fetch_stock_data()` call
-- and, per the 2026-07-30 fifth full-stack-audit pass, one of the highest-priority fetchers
still missing a `live_datasource` test (the mandatory control adopted specifically because of
the 2026-07-23 trendlyne_screener_discovery.py URL-as-symbol corruption incident).

Unlike most fetchers in this codebase, `MoneyControlFetcher` is a class whose `__init__` calls
`get_engine()` (env-driven, points at real infra) and does several DB reads to build a fetch
batch. To keep this test hermetic per the mandatory pattern (throwaway DB, no dependency on
live app state), the class is instantiated via `__new__()` (bypassing `__init__`) and `.engine`/
`.date_today` are set directly against a throwaway in-memory SQLite engine.
"""
import os
import sys
from datetime import date

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import moneycontrol_fetcher as mcf
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

# RELIANCE's MoneyControl scid (see src/data/stocklist.ts's StockMapping) -- one of the
# 180 liquid stocks with a stable, well-known provider mapping, guaranteed to have data
# across every endpoint this fetcher hits.
REAL_SYMBOL = "RELIANCE"
REAL_MCSYMBOL = "RI"
REAL_NAME = "Reliance Industries"


def _make_test_engine():
    engine = create_engine("sqlite:///:memory:")
    mcf.ensure_tables_exist(engine)
    # proprietary_scores_history is created by db.ts's base schema in production, not by
    # this fetcher's own ensure_tables_exist() -- create it here to match the real schema
    # (see db.ts's CREATE TABLE proprietary_scores_history) since _parse_general_insights()
    # writes into it when the insights payload carries a top-level "score"/"stock_score" key.
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS proprietary_scores_history (
                symbol TEXT NOT NULL,
                date TEXT NOT NULL,
                source TEXT NOT NULL,
                score_type TEXT NOT NULL,
                score_value REAL,
                score_label TEXT,
                PRIMARY KEY (symbol, date, source, score_type)
            )
        """))
    return engine


def _make_fetcher(engine):
    f = mcf.MoneyControlFetcher.__new__(mcf.MoneyControlFetcher)
    f.engine = engine
    f.target_symbols = None
    f.batch_size = 1
    f.date_today = date.today().strftime("%Y-%m-%d")
    return f


@pytest.mark.live_datasource
class TestMoneyControlFetcherLiveDataSource:
    def test_real_fetch_stores_ml_usable_rows_across_endpoints(self):
        """Hits every real MoneyControl endpoint this fetcher covers for one real stock via
        its own fetch_stock_data() (the fetcher's own orchestration + parsing, not a
        hand-rolled reimplementation), writes through its own DB-write helpers into a
        throwaway in-memory DB, then validates the stored rows are ML-usable."""
        engine = _make_test_engine()
        fetcher = _make_fetcher(engine)

        stock = {"symbol": REAL_SYMBOL, "mcsymbol": REAL_MCSYMBOL, "name": REAL_NAME}
        fetcher.fetch_stock_data(stock)

        with engine.connect() as conn:
            general_rows = conn.execute(
                text("SELECT symbol, source_api, metric_group, metric_name, "
                     "metric_value_num, metric_value_text FROM mc_general_metrics "
                     "WHERE symbol = :s"),
                {"s": REAL_SYMBOL},
            ).fetchall()

        assert general_rows, (
            "no rows landed in mc_general_metrics after fetch_stock_data() for a real, "
            "well-known, liquid stock -- either every endpoint failed/rate-limited, or "
            "the response shape has drifted from what the parsers expect"
        )

        for row in general_rows:
            symbol, source_api, metric_group, metric_name, val_num, val_text = row
            assert_looks_like_ticker(symbol, context="mc_general_metrics.symbol")
            assert source_api and "://" not in source_api, \
                f"mc_general_metrics.source_api looks malformed: {source_api!r}"
            assert metric_group, "mc_general_metrics.metric_group is empty"
            assert metric_name, "mc_general_metrics.metric_name is empty"
            # Every row carries either a numeric or a text value (never both None) --
            # the parsers always set exactly one of val_num/val_text per source line.
            assert val_num is not None or val_text is not None, (
                f"row ({source_api}/{metric_group}/{metric_name}) has neither a numeric "
                "nor a text value -- a parser wrote a fully empty row"
            )
            if val_num is not None:
                assert_numeric_and_finite(val_num, context=f"mc_general_metrics.{metric_name}")

        # At least the "technicals" and "essentials" endpoints must have produced real rows
        # for a large, well-covered stock like RELIANCE -- confirms the two general-purpose
        # parsers (_parse_general_technicals/_parse_general_essentials) are still matching
        # the live response shape, not just that *some* endpoint out of ~10 happened to work.
        seen_sources = {r[1] for r in general_rows}
        assert "technicals" in seen_sources, (
            "no 'technicals' rows written -- _parse_general_technicals() may be silently "
            "mismatched against the live api.moneycontrol.com/mcapi/technicals/v2 response shape"
        )
        assert "mc-essentials" in seen_sources, (
            "no 'mc-essentials' rows written -- _parse_general_essentials() may be silently "
            "mismatched against the live mc-essentials response shape"
        )

    def test_real_fetch_populates_analyst_rating_and_price_forecast(self):
        """A separate, narrower check on two single-row-per-symbol tables
        (mc_analyst_ratings/mc_price_forecast) that fetch_stock_data() also writes, since a
        parser regression isolated to just these two endpoints wouldn't necessarily show up
        in the mc_general_metrics-focused assertions above."""
        engine = _make_test_engine()
        fetcher = _make_fetcher(engine)
        stock = {"symbol": REAL_SYMBOL, "mcsymbol": REAL_MCSYMBOL, "name": REAL_NAME}
        fetcher.fetch_stock_data(stock)

        with engine.connect() as conn:
            rating_row = conn.execute(
                text("SELECT symbol, final_rating, analyst_count FROM mc_analyst_ratings "
                     "WHERE symbol = :s"),
                {"s": REAL_SYMBOL},
            ).fetchone()
            forecast_row = conn.execute(
                text("SELECT symbol, high, mean, low FROM mc_price_forecast WHERE symbol = :s"),
                {"s": REAL_SYMBOL},
            ).fetchone()

        # RELIANCE is one of the most heavily-covered stocks on MoneyControl -- both tables
        # should be populated for it. A live upstream shape change or auth wall would show up
        # here as both being None simultaneously.
        assert rating_row is not None or forecast_row is not None, (
            "neither mc_analyst_ratings nor mc_price_forecast got a row for RELIANCE -- "
            "the analyst-rating/price-forecast endpoints may have changed shape or gone dark"
        )
        if rating_row is not None:
            assert_looks_like_ticker(rating_row[0], context="mc_analyst_ratings.symbol")
            if rating_row[2] is not None:
                assert_numeric_and_finite(rating_row[2], context="mc_analyst_ratings.analyst_count")
        if forecast_row is not None:
            assert_looks_like_ticker(forecast_row[0], context="mc_price_forecast.symbol")
            for label, val in (("high", forecast_row[1]), ("mean", forecast_row[2]), ("low", forecast_row[3])):
                if val is not None:
                    assert_numeric_and_finite(val, context=f"mc_price_forecast.{label}")
