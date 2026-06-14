"""Tests for the asyncio/httpx gap-fill helpers in backfill_ohlcv."""
import asyncio
import sqlite3
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import src.server.backfill_ohlcv as mod


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_yf_response(timestamps, opens, highs, lows, closes, volumes):
    """Build a minimal YF v8 chart JSON payload."""
    return {
        "chart": {
            "result": [
                {
                    "timestamp": timestamps,
                    "indicators": {
                        "quote": [
                            {
                                "open": opens,
                                "high": highs,
                                "low": lows,
                                "close": closes,
                                "volume": volumes,
                            }
                        ]
                    },
                }
            ]
        }
    }


class TestGapFillAsync:
    def test_fetch_ohlcv_async_parses_response(self):
        """_fetch_ohlcv_async returns tuples when YF API response is well-formed."""
        # 2024-01-02 00:00:00 UTC → 1704153600
        fake_ts = 1704153600
        payload = _make_yf_response(
            timestamps=[fake_ts],
            opens=[100.0],
            highs=[105.0],
            lows=[99.0],
            closes=[102.5],
            volumes=[1000000],
        )

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = payload

        async def run():
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            return await mod._fetch_ohlcv_async(
                mock_client, "INFY", "INFY.NS", "2024-01-01", "2024-01-31"
            )

        result = asyncio.run(run())

        assert isinstance(result, list)
        assert len(result) == 1
        rec = result[0]
        # 7-tuple: (symbol, date, open, high, low, close, volume)
        assert len(rec) == 7
        assert rec[0] == "INFY"
        assert rec[1] == "2024-01-02"
        assert rec[2] == pytest.approx(100.0)
        assert rec[3] == pytest.approx(105.0)
        assert rec[4] == pytest.approx(99.0)
        assert rec[5] == pytest.approx(102.5)
        assert rec[6] == 1000000

    def test_fetch_ohlcv_async_handles_404(self):
        """Returns empty list when API returns non-200 status."""
        mock_response = MagicMock()
        mock_response.status_code = 404

        async def run():
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            return await mod._fetch_ohlcv_async(
                mock_client, "INFY", "INFY.NS", "2024-01-01", "2024-01-31"
            )

        result = asyncio.run(run())
        assert result == []

    def test_gap_fill_async_filters_existing(self):
        """_gap_fill_async skips rows that already exist in `existing` dict."""
        fake_ts_jan2 = 1704153600  # 2024-01-02 UTC
        fake_ts_jan3 = 1704240000  # 2024-01-03 UTC
        payload = _make_yf_response(
            timestamps=[fake_ts_jan2, fake_ts_jan3],
            opens=[100.0, 101.0],
            highs=[105.0, 106.0],
            lows=[99.0, 100.0],
            closes=[102.5, 103.5],
            volumes=[1000000, 1100000],
        )

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = payload

        conn = sqlite3.connect(":memory:")
        conn.execute(
            "CREATE TABLE stock_ohlcv "
            "(symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER, "
            "PRIMARY KEY (symbol, date))"
        )
        conn.commit()

        existing = {"INFY": {"2024-01-02"}}  # jan2 already present

        async def run():
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            # Patch httpx.AsyncClient to return our mock_client
            with patch("src.server.backfill_ohlcv.httpx.AsyncClient") as MockClient:
                MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
                MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
                return await mod._gap_fill_async(
                    conn,
                    symbols=["INFY"],
                    tickers=["INFY.NS"],
                    existing=existing,
                    cutoff="2024-01-01",
                    today="2024-01-31",
                )

        inserted = asyncio.run(run())

        # Only 2024-01-03 should be inserted (jan2 was in existing)
        assert inserted == 1
        rows = conn.execute(
            "SELECT date FROM stock_ohlcv WHERE symbol='INFY'"
        ).fetchall()
        dates = {r[0] for r in rows}
        assert "2024-01-02" not in dates
        assert "2024-01-03" in dates

        conn.close()

    def test_semaphore_limit(self):
        """_GAP_FILL_SEM limits concurrency to 20."""
        assert mod._GAP_FILL_SEM._value == 20
