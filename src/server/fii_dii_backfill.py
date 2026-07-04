"""One-time historical FII/DII backfill from the TradeBrains portal into fii_dii_flow.
FII endpoint field equity_net_investment -> fii_net; DII net_value -> dii_net. Published EOD
data (point-in-time). Run once: python fii_dii_backfill.py"""
import time
import requests
from db_compat import connect

_FII_URL = "https://portal.tradebrains.in/api/prices/investments/fii-investments/"
_DII_URL = "https://portal.tradebrains.in/api/prices/investments/dii-investments/"
_HEADERS = {"User-Agent": "Mozilla/5.0"}


def _to_iso(d: str) -> str:
    dd, mm, yyyy = d.split("-")
    return f"{yyyy}-{mm}-{dd}"


def parse_tradebrains_rows(fii_results: list[dict], dii_results: list[dict]) -> list[dict]:
    by_date: dict[str, dict] = {}
    for r in fii_results:
        iso = _to_iso(r["date"])
        row = by_date.setdefault(iso, {"date": iso, "fii_buy": None, "fii_sell": None, "fii_net": None,
                                       "dii_buy": None, "dii_sell": None, "dii_net": None})
        row["fii_buy"], row["fii_sell"], row["fii_net"] = (
            r.get("equity_gross_purchase"), r.get("equity_gross_sales"), r.get("equity_net_investment"))
    for r in dii_results:
        iso = _to_iso(r["date"])
        row = by_date.setdefault(iso, {"date": iso, "fii_buy": None, "fii_sell": None, "fii_net": None,
                                       "dii_buy": None, "dii_sell": None, "dii_net": None})
        row["dii_buy"], row["dii_sell"], row["dii_net"] = (
            r.get("buy_value"), r.get("sell_value"), r.get("net_value"))
    return list(by_date.values())


def _fetch_all(url: str, max_retries: int = 3) -> list[dict]:
    out, page = [], 1
    while True:
        resp = None
        for attempt in range(1, max_retries + 1):
            resp = requests.get(url, params={"page": page, "per_page": 100}, headers=_HEADERS, timeout=30)
            if resp.status_code < 500:
                break
            print(f"[FII-DII-BACKFILL] {url} page {page}: HTTP {resp.status_code} (attempt {attempt}/{max_retries})")
            time.sleep(2 * attempt)
        if resp.status_code >= 400:
            print(f"[FII-DII-BACKFILL] Giving up on {url} page {page} after {max_retries} attempts (HTTP {resp.status_code})")
            break
        data = resp.json()
        out.extend(data.get("results", []))
        if not data.get("next"):
            break
        page += 1
        time.sleep(0.3)
    return out


def run() -> int:
    fii_rows = _fetch_all(_FII_URL)
    dii_rows = _fetch_all(_DII_URL)
    if not fii_rows and not dii_rows:
        print("[FII-DII-BACKFILL] No data fetched from either endpoint — TradeBrains API may be down.")
        return 0
    rows = parse_tradebrains_rows(fii_rows, dii_rows)
    con = connect()
    try:
        n = 0
        for r in rows:
            con.execute(
                """INSERT INTO fii_dii_flow (date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source)
                   VALUES (?,?,?,?,?,?,?, 'tradebrains')
                   ON CONFLICT(date) DO UPDATE SET
                     fii_buy=excluded.fii_buy, fii_sell=excluded.fii_sell, fii_net=excluded.fii_net,
                     dii_buy=excluded.dii_buy, dii_sell=excluded.dii_sell, dii_net=excluded.dii_net,
                     source='tradebrains'""",
                (r["date"], r["fii_buy"], r["fii_sell"], r["fii_net"],
                 r["dii_buy"], r["dii_sell"], r["dii_net"]))
            n += 1
        con.commit()
        print(f"[FII-DII-BACKFILL] upserted {n} dates")
        return n
    finally:
        con.close()


if __name__ == "__main__":
    run()
