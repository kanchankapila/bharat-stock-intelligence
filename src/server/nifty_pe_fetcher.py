"""
Index PE/PB/EPS Fetcher
========================
Fetches index valuation data (PE, PB, EPS) from two sources:

  1. MoneyControl fundamentals API — PE/PB graph (1Y history per call)
     https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/graph/pe?indId=9&duration=1Y
     https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/graph/pb?indId=9&duration=1Y
     Also overview: https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/overview?indId=9

  2. Trendlyne chart data — PE_TTM, PBV, EPS_TTM (full history)
     https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/PE_TTM_SHARE_NOW/
     https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/PBV_A_SHARE_NOW/
     https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/EPS_TTM/

Trendlyne tlid for major indices:
  1887 = NIFTY 50, 1888 = NIFTY BANK, 1892 = NIFTY IT, 1893 = NIFTY PHARMA

Writes to `index_valuation` table.
Run:  python nifty_pe_fetcher.py              # last 30 days from MC
      python nifty_pe_fetcher.py --full       # full history from Trendlyne
      python nifty_pe_fetcher.py --days 365   # last 365 days from MC
"""

from pydantic import BaseModel

import argparse
import datetime
import time

import requests

from db_compat import execute, executemany, load_index_map, load_index_map_inv
import sys

MC_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.moneycontrol.com/",
    "Origin": "https://www.moneycontrol.com",
}

TL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://trendlyne.com/",
}

MC_FUND_BASE = "https://api.moneycontrol.com/mcapi/v1/indices/fundamentals"
TL_CHART_BASE = "https://trendlyne.com/mapp/v1/stock/chart-data"

def _build_index_map() -> dict[int, tuple[str, int | None]]:
    """Load MC PE index map from DB, combining mc_pe + trendlyne provider IDs.
    Returns {mc_indId (int): (index_name, tl_id or None)}.
    """
    from db_compat import load_index_map
    mc_map  = load_index_map("mc_pe")       # {mc_id_str: index_name}
    tl_map  = load_index_map_inv("trendlyne")  # {index_name: tl_id_str}
    result: dict[int, tuple[str, int | None]] = {}
    for mc_id_str, index_name in mc_map.items():
        try:
            mc_id = int(mc_id_str)
        except ValueError:
            continue
        tl_id = tl_map.get(index_name)
        result[mc_id] = (index_name, int(tl_id) if tl_id else None)
    if not result:
        # Fallback if table missing
        result = {
            9: ("NIFTY50", 1887), 23: ("NIFTYBANK", 1888),
            19: ("NIFTYIT", 1892), 41: ("NIFTYPHARMA", 1893),
            52: ("NIFTYAUTO", None), 39: ("NIFTYFMCG", None),
            51: ("NIFTYMETAL", None), 27: ("NIFTYMIDCAP", None),
            53: ("NIFTYSMALLCAP", None), 4: ("SENSEX", None),
        }
    return result

# MoneyControl duration values for PE/PB graph
MC_DURATIONS = {"30": "1M", "90": "3M", "180": "6M", "365": "1Y", "730": "3Y", "1825": "5Y"}


def _ensure_table():
    execute("""
        CREATE TABLE IF NOT EXISTS index_valuation (
            index_name  TEXT NOT NULL,
            date        TEXT NOT NULL,
            pe          REAL,
            pb          REAL,
            div_yield   REAL,
            eps         REAL,
            fetched_at  TEXT NOT NULL,
            PRIMARY KEY (index_name, date)
        )
    """)
    # Add eps column if upgrading from older schema.
    # IF NOT EXISTS makes "already present" a no-op success, so a raised exception here is a
    # REAL failure (permissions, missing table). It used to be swallowed by a bare `pass`,
    # which is how a missing index_valuation.eps stayed invisible while downstream reads of
    # `pe`/`pb`/`eps` still reported success with the column absent.
    try:
        execute("ALTER TABLE index_valuation ADD COLUMN IF NOT EXISTS eps REAL")
    except Exception as exc:
        print(f"[NiftyPE] could not add index_valuation.eps: {exc}", file=sys.stderr)


def _parse_mc_graph(resp_json: dict) -> list[tuple[str, float]]:
    """Extract [(date_str, value), ...] from MC fundamentals graph response."""
    data = resp_json.get("data") or {}
    points = data.get("graphData") or data.get("graph") or []
    result = []
    for pt in points:
        try:
            # MC fundamentals graph: {"date": "2025-06-30", "data": 22.97, "niftydata": 25517.05}
            # or list format: [date_str, value]
            if isinstance(pt, (list, tuple)):
                date_raw, val = pt[0], pt[1]
            else:
                date_raw = pt.get("date") or pt.get("x") or ""
                val = pt.get("data") or pt.get("y") or pt.get("value")
            if val is None or val in ("", "-"):
                continue
            # Parse "YYYY-MM-DD" or "DD Mon YYYY"
            date_str = str(date_raw).strip()
            try:
                d = datetime.datetime.strptime(date_str[:10], "%Y-%m-%d").date()
            except ValueError:
                d = datetime.datetime.strptime(date_str, "%d %b %Y").date()
            result.append((d.isoformat(), float(val)))
        except Exception:
            continue
    return result


def _mc_duration(days: int) -> str:
    """MC's graph accepts exactly [1M, 3M, 6M, 1Y, 5Y, Max] (its own 422 lists them; '3Y' was
    sent here for 366-1095 days and always failed). Resolution drops with length: 1Y is daily,
    5Y weekly (from ~5 years back), Max monthly (from 2015)."""
    for limit, code in ((30, "1M"), (90, "3M"), (180, "6M"), (365, "1Y"), (1825, "5Y")):
        if days <= limit:
            return code
    return "Max"


# A point more than this far from the median of its neighbouring sessions is a vendor glitch, not
# a market move: an index P/E moves a few percent a day even in a crash.
_MAX_NEIGHBOUR_DEVIATION = 0.25
_NEIGHBOURS = 5


def _drop_implausible(combined: dict[str, dict]) -> dict[str, dict]:
    """Remove impossible pe/pb points MC's graph returns and this table stored verbatim
    (AF-20260913-08): pe == pb (NIFTY50 2025-12-29 read 26.0/26.0 against pb ~3.55), isolated
    spikes (2025-09-08 pe=1.1 among ~21.7), and weekend dates -- the graph's in-progress point
    for the run's own calendar day, stored rounded (NIFTY50 pb=2.0 against ~2.9 on every one).
    Negative values are NOT dropped: BSETELECOM's pb is genuinely negative. Other fields kept."""
    out = {d: dict(v) for d, v in combined.items()
           if datetime.date.fromisoformat(d[:10]).weekday() < 5}
    for v in out.values():
        pe, pb = v.get("pe"), v.get("pb")
        if pe is not None and pb is not None and pe == pb:
            v.pop("pe"); v.pop("pb")
    dates = sorted(out)
    for k in ("pe", "pb"):
        valid = [(d, out[d][k]) for d in dates if out[d].get(k) is not None]
        bad = []
        for i, (d, val) in enumerate(valid):
            nb = [x for _, x in valid[max(0, i - _NEIGHBOURS):i] + valid[i + 1:i + 1 + _NEIGHBOURS]]
            if len(nb) < 3:
                continue
            med = sorted(nb)[len(nb) // 2]
            if med > 0 and abs(val / med - 1) > _MAX_NEIGHBOUR_DEVIATION:
                bad.append(d)
        for d in bad:
            out[d].pop(k, None)
    return out


def fetch_mc_pe_pb(ind_id: int, days: int = 365) -> dict[str, dict]:
    """Fetch PE and PB history from MoneyControl. Returns {date: {pe, pb}}."""
    duration = _mc_duration(days)
    combined: dict[str, dict] = {}

    for metric, key in [("pe", "pe"), ("pb", "pb")]:
        url = f"{MC_FUND_BASE}/graph/{metric}?indId={ind_id}&duration={duration}"
        try:
            r = requests.get(url, headers=MC_HEADERS, timeout=15)
            r.raise_for_status()
            for date_str, val in _parse_mc_graph(r.json()):
                combined.setdefault(date_str, {})[key] = val
        except Exception as e:
            print(f"[PE] MC {metric} fetch error for indId={ind_id}: {e}", file=sys.stderr)
        time.sleep(0.4)

    # Also fetch overview for latest EPS / div yield
    try:
        r = requests.get(f"{MC_FUND_BASE}/overview?indId={ind_id}", headers=MC_HEADERS, timeout=15)
        r.raise_for_status()
        ov = r.json().get("data") or {}
        today = datetime.date.today().isoformat()
        entry = combined.setdefault(today, {})
        # BUG FOUND 2026-08-07 (dead-column sweep): both keys were guessed wrong against MC's
        # real overview response (live-verified for indId=9/NIFTY50: {"div_yield":"1.27",
        # "ttmEps":"1,177.32", ...} -- no "divYield" or "eps" key exists at all). div_yield was
        # 100% NULL (0/7,384 rows); eps silently degraded to whatever a different code path
        # happened to populate it with (26.7% coverage, well below pe/pb's ~90% from the
        # separate graph endpoints this overview call doesn't feed). ttmEps values are
        # comma-formatted ("1,177.32") -- strip commas before float().
        if ov.get("div_yield"):
            entry["div_yield"] = float(ov["div_yield"])
        if ov.get("ttmEps"):
            entry["eps"] = float(str(ov["ttmEps"]).replace(",", ""))
    except Exception as exc:
        # The sibling graph loop just above already prints its failures; this overview call
        # feeds div_yield + eps and used to fail in total silence. Those two columns are
        # already the weakest-covered ones here (see the note above), so an unnoticed failure
        # is indistinguishable from the coverage gap it was meant to close.
        print(f"[PE] MC overview fetch error for indId={ind_id}: {exc}", file=sys.stderr)

    return combined


def fetch_trendlyne(tlid: int, metric: str) -> list[tuple[str, float]]:
    """Fetch chart data from Trendlyne. metric = PE_TTM_SHARE_NOW / PBV_A_SHARE_NOW / EPS_TTM"""
    url = f"{TL_CHART_BASE}/{tlid}/{metric}/?format=json"
    try:
        r = requests.get(url, headers=TL_HEADERS, timeout=20)
        r.raise_for_status()
        data = r.json()
        if data.get("head", {}).get("status") != "0":
            return []
        # Actual Trendlyne chart-data shape: {"head": {...}, "body": {"eodData": [[ts_ms, value], ...]}}
        points = data.get("body", {}).get("eodData") or []
        result = []
        for pt in points:
            try:
                raw_x, val = pt[0], pt[1]
                if val is None:
                    continue
                # timestamp in ms or date string
                if isinstance(raw_x, (int, float)) and raw_x > 1e10:
                    d = datetime.datetime.utcfromtimestamp(raw_x / 1000).date()
                else:
                    d = datetime.datetime.strptime(str(raw_x)[:10], "%Y-%m-%d").date()
                result.append((d.isoformat(), float(val)))
            except Exception:
                continue
        return result
    except Exception as e:
        print(f"[PE] Trendlyne {metric} fetch error for tlid={tlid}: {e}", file=sys.stderr)
        return []


def run(days: int = 30, full: bool = False):
    _ensure_table()
    now = datetime.datetime.now().isoformat()
    total = 0

    for ind_id, (index_name, tlid) in _build_index_map().items():
        combined: dict[str, dict] = {}

        if full and tlid:
            # Full history from Trendlyne
            for tl_metric, col in [
                ("PE_TTM_SHARE_NOW", "pe"),
                ("PBV_A_SHARE_NOW", "pb"),
                ("EPS_TTM", "eps"),
            ]:
                for date_str, val in fetch_trendlyne(tlid, tl_metric):
                    combined.setdefault(date_str, {})[col] = val
                time.sleep(0.5)
            print(f"[PE] {index_name}: Trendlyne {len(combined)} dates")
        else:
            # Recent history from MoneyControl
            combined = fetch_mc_pe_pb(ind_id, days=days)

            # MC's graph endpoint returns corrupted single-point junk (pe=0, wrong index
            # level) for some sector sub-indices (confirmed for NIFTYIT/NIFTYPHARMA) instead
            # of a real time series — a healthy response has many more than 1 date. Fall back
            # to Trendlyne's chart-data (which has full multi-year history) for just the
            # requested window in that case.
            mc_looks_corrupted = len(combined) <= 1 or all(
                not d.get("pe") for d in combined.values()
            )
            if mc_looks_corrupted and tlid:
                print(f"[PE] {index_name}: MC data missing/corrupted, falling back to Trendlyne")
                combined = {}
                cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
                for tl_metric, col in [
                    ("PE_TTM_SHARE_NOW", "pe"),
                    ("PBV_A_SHARE_NOW", "pb"),
                    ("EPS_TTM", "eps"),
                ]:
                    for date_str, val in fetch_trendlyne(tlid, tl_metric):
                        if date_str >= cutoff:
                            combined.setdefault(date_str, {})[col] = val
                    time.sleep(0.5)
                print(f"[PE] {index_name}: Trendlyne {len(combined)} dates")
            else:
                print(f"[PE] {index_name}: MC {len(combined)} dates")

        combined = _drop_implausible(combined)
        if not combined:
            continue

        records = [
            (index_name, date_str,
             d.get("pe"), d.get("pb"), d.get("div_yield"), d.get("eps"), now)
            for date_str, d in combined.items()
        ]
        executemany(
            """INSERT INTO index_valuation (index_name, date, pe, pb, div_yield, eps, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (index_name, date) DO UPDATE SET
                 pe=COALESCE(excluded.pe, index_valuation.pe),
                 pb=COALESCE(excluded.pb, index_valuation.pb),
                 div_yield=COALESCE(excluded.div_yield, index_valuation.div_yield),
                 eps=COALESCE(excluded.eps, index_valuation.eps),
                 fetched_at=excluded.fetched_at""",
            records,
        )
        total += len(records)
        time.sleep(0.8)

    print(f"[PE] Done — {total} total rows written to index_valuation.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Nifty index PE/PB/EPS fetcher (MC + Trendlyne)")
    parser.add_argument("--days", type=int, default=30, help="Days of MC history (default 30)")
    parser.add_argument("--full", action="store_true", help="Full history from Trendlyne")
    args = parser.parse_args()
    run(days=args.days, full=args.full)
