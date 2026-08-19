"""
mmi_fetcher.py
==============
Fetches the Tickertape Market Mood Index (MMI) — a 0-100 India fear/greed gauge
blending FII flow, price momentum, volatility (VIX), demand-for-gold, skew and
market breadth (TRIN). Unlocked endpoint, no auth.

  <30  Extreme Fear   | 30-50 Fear | 50-70 Greed | >70 Extreme Greed

Source: https://api.tickertape.in/mmi/now  (data.indicator = headline 0-100 value)

Stores into macro_asset_prices as symbol='INDIA_MMI' (close = indicator), the same
market-level table the ML ensemble's macro_snap pivots into features and the HMM
regime detector reads. The endpoint also returns lastDay/Week/Month/Year snapshots,
which we backfill as free historical anchor points.

Run:  python mmi_fetcher.py
"""

import requests

from db_compat import execute
import sys

MMI_URL = "https://api.tickertape.in/mmi/now"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def _f(v):
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _upsert(date: str, value: float | None) -> bool:
    if value is None or not date:
        return False
    execute("""
        INSERT INTO macro_asset_prices (symbol, date, close, fetched_at)
        VALUES ('INDIA_MMI', ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (symbol, date) DO UPDATE SET
            close = excluded.close, fetched_at = excluded.fetched_at
    """, (date, value))
    return True


def fetch_mmi() -> dict | None:
    try:
        r = requests.get(MMI_URL, headers=HEADERS, timeout=15)
        d = r.json()
        if not d.get("success"):
            print(f"[MMI] API error: {d.get('error')}")
            return None
        return d.get("data")
    except Exception as e:
        print(f"[MMI] fetch error: {e}", file=sys.stderr)
        return None


def main() -> None:
    data = fetch_mmi()
    if not data:
        return

    # Today's headline value + the free historical anchors the endpoint returns.
    points = [(str(data.get("date", ""))[:10], _f(data.get("indicator")))]
    for k in ("lastDay", "lastWeek", "lastMonth", "lastYear"):
        snap = data.get(k) or {}
        points.append((str(snap.get("date", ""))[:10], _f(snap.get("indicator"))))

    n = sum(_upsert(d, v) for d, v in points)
    latest = _f(data.get("indicator"))
    zone = (
        "Extreme Greed" if latest and latest > 70 else
        "Greed" if latest and latest > 50 else
        "Fear" if latest and latest > 30 else "Extreme Fear"
    ) if latest is not None else "n/a"
    print(f"[MMI] INDIA_MMI={latest} ({zone}); upserted {n} macro_asset_prices rows.")


if __name__ == "__main__":
    main()
