"""Investsights FII/DII Daily Flows Fetcher.

Fetches daily FII/DII net cash market flows from Investsights API.
Provides institutional flow data for smart-money tracking signals.

API Endpoint: https://investsights.in/api/v2/market/fiidii?days={days}

Usage:
    from investsights_fii_dii_fetcher import fetch_fii_dii_flows
    df = fetch_fii_dii_flows(days=30)
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

INVESTSIGHTS_FIIDII_URL = "https://investsights.in/api/v2/market/fiidii"

# ---------------------------------------------------------------------------------------
# STATUS: UNWIRED. This module has no `__main__` and no caller anywhere in .py/.ts outside
# `audit_new_modules.py`, which only introspects fetch_fii_dii_flows' signature and makes no
# API call -- so nothing schedules it and `runPython` cannot invoke it. That is why it has no
# `live_datasource` test: a gated test over a fetcher nothing runs is the "test that rots"
# case CLAUDE.md warns about, not coverage. Tracked as AF-20260917-15.
#
# `store_fii_dii_flows`' default table was `fii_dii_flows` (plural) -- a table that has never
# existed; only `fii_dii_flow` (singular) does. Corrected 2026-09-17 so the latent landmine is
# gone, but note what wiring this up would mean: `fii_dii_flow` is ALREADY fresh (2,624 rows,
# current to 2026-09-16) and written by `fii_dii_fetcher.py` and `fii_dii_history_fetcher.py`,
# both of which run clean. Scheduling this one makes it a THIRD writer upserting on the same
# `(date)` key -- the cross-writer collision class in data-sources.md, where whichever job runs
# last silently wins. Decide that before wiring it, and per the vendor-onboarding freeze, state
# the hypothesis this vendor tests that the two existing NSE-sourced writers do not.
# ---------------------------------------------------------------------------------------


def fetch_fii_dii_flows(
    days: int = 30,
    session=None,
) -> pd.DataFrame:
    """Fetch FII/DII daily cash market flows from Investsights.

    Args:
        days: Number of trading days to fetch
        session: Optional requests session (creates one if None)

    Returns:
        DataFrame with columns: date, fii_net, dii_net, fii_buy, fii_sell, dii_buy, dii_sell
    """
    import requests

    if session is None:
        session = requests.Session()
        session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        })

    url = f"{INVESTSIGHTS_FIIDII_URL}?days={days}"

    try:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.error(f"Failed to fetch FII/DII flows: {e}")
        return pd.DataFrame()

    # Parse response
    records = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict) and "data" in data:
        items = data["data"]
    else:
        items = [data] if isinstance(data, dict) else []

    for item in items:
        try:
            record = {
                "date": pd.to_datetime(item.get("date") or item.get("tradeDate")),
                "fii_net": float(item.get("fiiNet", 0) or item.get("fii_net", 0) or 0),
                "dii_net": float(item.get("diiNet", 0) or item.get("dii_net", 0) or 0),
                "fii_buy": float(item.get("fiiBuy", 0) or item.get("fii_buy", 0) or 0),
                "fii_sell": float(item.get("fiiSell", 0) or item.get("fii_sell", 0) or 0),
                "dii_buy": float(item.get("diiBuy", 0) or item.get("dii_buy", 0) or 0),
                "dii_sell": float(item.get("diiSell", 0) or item.get("dii_sell", 0) or 0),
            }
            records.append(record)
        except (ValueError, TypeError) as e:
            logger.warning(f"Skipping malformed FII/DII record: {e}")
            continue

    if not records:
        return pd.DataFrame()

    df = pd.DataFrame(records)
    df = df.sort_values("date").reset_index(drop=True)

    # Compute derived features
    df["fii_cumulative_5d"] = df["fii_net"].rolling(5, min_periods=1).sum()
    df["dii_cumulative_5d"] = df["dii_net"].rolling(5, min_periods=1).sum()
    df["fii_cumulative_20d"] = df["fii_net"].rolling(20, min_periods=1).sum()
    df["dii_cumulative_20d"] = df["dii_net"].rolling(20, min_periods=1).sum()

    # Z-scores (20-day rolling)
    df["fii_net_20z"] = (
        (df["fii_net"] - df["fii_net"].rolling(20, min_periods=5).mean())
        / df["fii_net"].rolling(20, min_periods=5).std().replace(0, float("nan"))
    )
    df["dii_net_20z"] = (
        (df["dii_net"] - df["dii_net"].rolling(20, min_periods=5).mean())
        / df["dii_net"].rolling(20, min_periods=5).std().replace(0, float("nan"))
    )

    # Combined institutional flow
    df["inst_net"] = df["fii_net"] + df["dii_net"]
    df["inst_net_20z"] = (
        (df["inst_net"] - df["inst_net"].rolling(20, min_periods=5).mean())
        / df["inst_net"].rolling(20, min_periods=5).std().replace(0, float("nan"))
    )

    return df.fillna(0.0)


def store_fii_dii_flows(
    df: pd.DataFrame,
    db_conn=None,
    table: str = "fii_dii_flow",
) -> int:
    """Store FII/DII flows to database.

    Args:
        df: DataFrame from fetch_fii_dii_flows
        db_conn: Database connection (uses default if None)
        table: Target table name

    Returns:
        Number of rows inserted
    """
    if df.empty:
        return 0

    try:
        from db_compat import get_db
        db = db_conn or get_db()
    except ImportError:
        logger.warning("db_compat not available, skipping DB store")
        return 0

    rows = 0
    for _, row in df.iterrows():
        try:
            db.execute(f"""
                INSERT INTO {table} (date, fii_net, dii_net, fii_buy, fii_sell, dii_buy, dii_sell)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (date) DO UPDATE SET
                    fii_net = excluded.fii_net,
                    dii_net = excluded.dii_net,
                    fii_buy = excluded.fii_buy,
                    fii_sell = excluded.fii_sell,
                    dii_buy = excluded.dii_buy,
                    dii_sell = excluded.dii_sell
            """, [
                row["date"].strftime("%Y-%m-%d") if hasattr(row["date"], "strftime") else str(row["date"]),
                row.get("fii_net", 0),
                row.get("dii_net", 0),
                row.get("fii_buy", 0),
                row.get("fii_sell", 0),
                row.get("dii_buy", 0),
                row.get("dii_sell", 0),
            ])
            rows += 1
        except Exception as e:
            logger.warning(f"Failed to insert FII/DII row: {e}")

    try:
        db.commit()
    except Exception as e:
        # A swallowed commit discards EVERY row this loop just appeared to insert: the
        # function still returns `rows` (the count it built) and the job exits 0, so the
        # FII/DII table silently keeps yesterday's values. `rows` is a count of attempts,
        # not of committed rows -- log so those two can be told apart.
        logger.error(f"FII/DII commit failed, {rows} parsed rows were NOT persisted: {e}")

    return rows
