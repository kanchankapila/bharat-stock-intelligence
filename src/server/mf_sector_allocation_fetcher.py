"""
MF Sector Allocation Fetcher (Economic Times / mcxlivefeeds)
============================================================

Replaces the dead AMFI DownloadSchemeData_Po.aspx portfolio-disclosure feed
(that endpoint now returns the scheme MASTER list unconditionally -- probed
2026-08-26, every parameter variant identical). Same semantic target: monthly
mutual-fund sector allocation and month-over-month flow, written to
`mf_sector_allocation` (+ per-scheme raw rows), then propagated to
`macro_asset_prices` and `technical_signals.mf_sector_flow_pct` exactly like
the old fetcher did.

Source chain (all verified live 2026-08-27):
  1. AMC universe: the ET marketstats mutual-fund-AUM widget embeds
     `{slug}-mutual-fund/mutual_funds_search/amcid-{N}.cms` links for the major
     fund houses (12 captured on first pass -- most of industry AUM).
  2. Scheme IDs: each AMC's `mutual_funds_search/amcid-N.cms` page statically
     embeds `/mf/<scheme-seo>/mffactsheet/schemeid-M.cms` links (axis alone had
     404). Debt/index schemes return an EMPTY sector list upstream, so the
     universe self-filters to equity without us having to classify.
  3. Per scheme: `mcxlivefeeds.indiatimes.com/mf/topsectorforportfolio.htm?
     schemeid=M&callback=...` -> JSONP array of top sectors, each carrying
     `holdingDate`, `sectorName`, `sectorInvestmentPercent`,
     `sectorInvestmentValue` (Rs crore), and `monthOnMonthChange` (pp change
     vs prior month = the flow itself, so no two-month fetch is needed).

KNOWN LIMITATION -- read before citing `aum_pct` as an allocation.
`topsectorforportfolio` is a TOP-N endpoint, not a full portfolio breakdown:
`totalrecord` equals the number of rows returned (measured 5, 1, 1 on three
schemes). A sector therefore only appears for a fund when it is already among
that fund's largest holdings, so `aum_pct = mean(invest_pct)` is conditional on
having made the cut -- a biased LEVEL estimate, not "MF sector allocation".
`flow_pct` (`monthOnMonthChange`, the value that actually propagates downstream)
is less exposed but still selection-conditioned. No full-allocation endpoint
exists in the probe set; this is stated, not fixed.

Caveat recorded deliberately: direct/regular plans of the same fund share a
portfolio, so cross-sectional means weight funds by their plan-variant count.
Accepted for v1; dedupe by seo-name stem is the obvious future refinement.

Run:
    python mf_sector_allocation_fetcher.py                 # full universe
    python mf_sector_allocation_fetcher.py --refresh-amcs  # re-discover AMCs
    python mf_sector_allocation_fetcher.py --max-per-amc 40
"""

import argparse
import datetime
import json
import re
import sys
import time

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    import requests as cffi_requests

from db_compat import connect, translate, executemany, read_df
from mf_sector_flow_fetcher import (
    ensure_schema as _legacy_ensure_schema,
    _update_macro_asset_prices,
    _update_technical_signals,
)

MARKETSTATS_URL = (
    "https://economictimes.indiatimes.com/marketstats/"
    "pageno-1,pid-134,quarter-Q4,sortby-aum.cms"
)
TOP_SECTOR_URL = (
    "https://mcxlivefeeds.indiatimes.com/mf/topsectorforportfolio.htm"
    "?schemeid={schemeid}&callback=objMutualFund.prepareSectorAllocationChart"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Referer": "https://economictimes.indiatimes.com/",
    "Accept": "*/*",
}

# ET sector names -> the LIVE `nse_stocks.sector` vocabulary, which is GICS-style
# (Financials / Materials / Industrials / Consumer Discretionary / ...). Both
# sides of this map are measured, not assumed: the ET keys are the 17 distinct
# sectorName values seen across a 100-scheme sample (2026-08-27), and the values
# were settled by querying which sector real bellwethers actually carry --
# MARUTI/M&M/BAJAJ-AUTO are `Consumer Discretionary`, BHARTIARTL/IDEA/TATACOMM
# are `Telecommunications` (NOT `Communication Services`, which also exists),
# SBILIFE/HDFCLIFE are `Financials`, TATASTEEL/HINDALCO/UPL/PIDILITIND are
# `Materials`, LT/SIEMENS/ABB are `Industrials`.
#
# Judgment call worth naming: ET's `Automobile` (the 2nd-largest bucket in the
# sample) and ET's own smaller `Consumer Discretionary` both land on
# `Consumer Discretionary` and are averaged together. That follows the live
# column, but it does mean one aggregate spans two ET concepts.
#
# Unmapped names (`Services`, `Others`, `Unclassified`) are stored VERBATIM in
# mf_scheme_sector_allocation and simply never propagate -- they have no
# counterpart in nse_stocks.sector, so there is nothing honest to map them onto.
# ET sector names -> our nse_stocks.sector GICS vocabulary (confirmed via
# _load_sector_map(): Financials, Industrials, Consumer Discretionary, Consumer
# Staples, Healthcare, Materials, Information Technology, Energy, Telecommunications).
SECTOR_NAME_MAP = {
    "financial": "Financials",
    "financial services": "Financials",
    "financials": "Financials",
    "banks": "Financials",
    "banking": "Financials",
    "services": "Industrials",
    "information technology": "Information Technology",
    "it": "Information Technology",
    "technology": "Information Technology",
    "automobile": "Consumer Discretionary",
    "auto": "Consumer Discretionary",
    "automobile and auto components": "Consumer Discretionary",
    "pharmaceuticals": "Healthcare",
    "pharma": "Healthcare",
    "healthcare": "Healthcare",
    "fmcg": "Consumer Staples",
    "consumer durables": "Consumer Discretionary",
    "energy": "Energy",
    "oil gas & consumable fuels": "Energy",
    "metals & mining": "Materials",
    "metals": "Materials",
    "materials": "Materials",
    "capital goods": "Industrials",
    "industrials": "Industrials",
    "construction materials": "Materials",
    "chemicals": "Materials",
    "textiles": "Consumer Discretionary",
    "telecommunication": "Telecommunications",
    "telecom": "Telecommunications",
    "media entertainment & publication": "Media & Entertainment",
}
SECTOR_NAME_MAP = {
    "financial": "Financials",
    "financials": "Financials",
    "financial services": "Financials",
    "banking": "Financials",
    "insurance": "Financials",
    "automobile": "Consumer Discretionary",
    "auto": "Consumer Discretionary",
    "consumer discretionary": "Consumer Discretionary",
    "consumer durables": "Consumer Discretionary",
    "consumer staples": "Consumer Staples",
    "fmcg": "Consumer Staples",
    "technology": "Information Technology",
    "information technology": "Information Technology",
    "it": "Information Technology",
    "healthcare": "Healthcare",
    "pharmaceuticals": "Healthcare",
    "pharma": "Healthcare",
    "energy": "Energy",
    "oil gas & consumable fuels": "Energy",
    "capital goods": "Industrials",
    "construction": "Industrials",
    "industrials": "Industrials",
    "metals & mining": "Materials",
    "metals": "Materials",
    "chemicals": "Materials",
    "materials": "Materials",
    "construction materials": "Materials",
    "communication": "Telecommunications",
    "telecom": "Telecommunications",
    "telecommunication": "Telecommunications",
    "utilities": "Utilities",
    "real estate": "Real Estate",
    "media entertainment & publication": "Media & Entertainment",
}


class UpstreamError(RuntimeError):
    """Transport/HTTP/parse failure -- deliberately NOT the same thing as a
    scheme that legitimately reports no sectors. Conflating the two is what
    makes a WAF block read as '400 debt schemes, all fine'."""


def _get(url: str, timeout: int = 45) -> str:
    try:
        resp = cffi_requests.get(url, headers=HEADERS, impersonate="chrome110",
                                 timeout=timeout)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        raise UpstreamError(f"{type(e).__name__}: {str(e)[:160]}") from e


def _jsonp(url: str):
    """Strip the JSONP wrapper and parse.

    Raises UpstreamError on transport failure or an unparseable body; returns
    the decoded payload otherwise (which may legitimately be sector-empty).
    """
    body = _get(url).strip()
    m = re.search(r"^[\w\.]+\((.*)\);?\s*$", body, re.S)
    if not m:
        raise UpstreamError(f"non-JSONP body ({len(body)}b): {body[:80]!r}")
    try:
        return json.loads(m.group(1))
    except ValueError as e:
        raise UpstreamError(f"bad JSON: {e}") from e


def ensure_schema() -> None:
    # mf_sector_allocation and technical_signals.mf_sector_flow_pct are created
    # by the legacy fetcher's own ensure_schema -- this module WRITES both but
    # does not own their DDL, so call it rather than duplicating it (or silently
    # depending on the old fetcher having run on this box first).
    _legacy_ensure_schema()

    conn = connect()
    conn.execute(translate("""
        CREATE TABLE IF NOT EXISTS mf_scheme_sector_allocation (
            schemeid       TEXT NOT NULL,
            holding_date   TEXT NOT NULL,
            sector         TEXT NOT NULL,
            et_sector_name TEXT,
            invest_pct     REAL,
            invest_value_cr REAL,
            mom_change_pct REAL,
            fetched_at     TIMESTAMPTZ DEFAULT now(),
            PRIMARY KEY (schemeid, holding_date, sector)
        )
    """))
    conn.execute(translate("""
        CREATE TABLE IF NOT EXISTS et_mf_universe (
            schemeid   TEXT PRIMARY KEY,
            amcid      TEXT,
            amc_slug   TEXT,
            first_seen DATE DEFAULT CURRENT_DATE,
            last_seen  DATE DEFAULT CURRENT_DATE
        )
    """))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Universe discovery
# ---------------------------------------------------------------------------

def discover_amcs() -> list:
    """[(amc_slug, amcid)] from the marketstats AUM widget."""
    html = _get(MARKETSTATS_URL, timeout=60)
    return sorted(set(
        re.findall(r"/([\w\-]+-mutual-fund)/mutual_funds_search/amcid-(\d+)\.cms", html)
    ))


def discover_schemes(amc_slug: str, amcid: str) -> set:
    html = _get(
        f"https://economictimes.indiatimes.com/{amc_slug}"
        f"/mutual_funds_search/amcid-{amcid}.cms",
        timeout=90,
    )
    return set(re.findall(r"/mffactsheet/schemeid-(\d+)\.cms", html))


def refresh_universe(max_per_amc=None) -> int:
    """Re-discover AMCs + schemes; upsert the universe table. Returns size."""
    amcs = discover_amcs()
    if not amcs:
        print("[MFSectorAlloc] FATAL: zero AMC links found on marketstats page.")
        sys.exit(1)
    print(f"[MFSectorAlloc] {len(amcs)} AMCs discovered.")

    for slug, amcid in amcs:
        try:
            schemes = discover_schemes(slug, amcid)
        except UpstreamError as e:
            print(f"[MFSectorAlloc] WARN: {slug} ({amcid}) failed: {e}")
            continue
        if max_per_amc:
            schemes = set(sorted(schemes)[:max_per_amc])
        params = [(sid, amcid, slug) for sid in schemes]
        executemany(
            "INSERT INTO et_mf_universe (schemeid, amcid, amc_slug) VALUES (?, ?, ?) "
            "ON CONFLICT (schemeid) DO UPDATE SET last_seen = CURRENT_DATE, "
            "amcid = EXCLUDED.amcid, amc_slug = EXCLUDED.amc_slug",
            params,
        )
        print(f"[MFSectorAlloc]   {slug[:40]:42s} {len(schemes):4d} schemes")

    conn = connect()
    n = conn.execute(translate("SELECT COUNT(*) FROM et_mf_universe")).fetchone()[0]
    conn.close()
    return int(n)


def load_universe(limit=None) -> list:
    sql = "SELECT schemeid FROM et_mf_universe ORDER BY schemeid"
    if limit:
        sql += f" LIMIT {int(limit)}"
    df = read_df(sql)
    return [str(v) for v in df["schemeid"].tolist()]


# ---------------------------------------------------------------------------
# Capture
# ---------------------------------------------------------------------------

def canonical_sector(et_name: str) -> str:
    return SECTOR_NAME_MAP.get((et_name or "").strip().lower(), (et_name or "").strip())


def capture_scheme(schemeid: str):
    """Top-sector rows for one scheme; None if the scheme reports nothing.

    Propagates UpstreamError -- a network failure must not be silently counted
    as a debt/index scheme with no sectors.
    """
    d = _jsonp(TOP_SECTOR_URL.format(schemeid=schemeid))
    if not isinstance(d, dict):
        return None
    rows = d.get("topsectorforportfolio") or []
    out = []
    for r in rows:
        try:
            hd = datetime.datetime.strptime(
                str(r.get("holdingDate", ""))[:10], "%Y-%m-%d"
            ).date().isoformat()
        except ValueError:
            continue
        et_name = str(r.get("sectorName", "")).strip()
        out.append({
            "holding_date": hd,
            "sector": canonical_sector(et_name),
            "et_sector_name": et_name,
            "invest_pct": float(r.get("sectorInvestmentPercent") or 0),
            "invest_value_cr": float(r.get("sectorInvestmentValue") or 0),
            "mom_change_pct": float(r.get("monthOnMonthChange") or 0),
        })
    return out or None


def save_rows(schemeid: str, rows: list) -> None:
    params = [
        (schemeid, r["holding_date"], r["sector"], r["et_sector_name"],
         r["invest_pct"], r["invest_value_cr"], r["mom_change_pct"])
        for r in rows
    ]
    executemany(
        "INSERT INTO mf_scheme_sector_allocation "
        "(schemeid, holding_date, sector, et_sector_name, invest_pct, invest_value_cr, mom_change_pct) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (schemeid, holding_date, sector) DO UPDATE SET "
        "invest_pct = EXCLUDED.invest_pct, invest_value_cr = EXCLUDED.invest_value_cr, "
        "mom_change_pct = EXCLUDED.mom_change_pct",
        params,
    )


# ---------------------------------------------------------------------------
# Aggregate -> legacy-compatible outputs
# ---------------------------------------------------------------------------

def aggregate_and_propagate() -> int:
    """Mean % / summed value per sector for the freshest month, then reuse the
    old fetcher's downstream writers unchanged. Returns sector count."""
    df = read_df(
        "SELECT holding_date, sector, invest_pct, invest_value_cr, mom_change_pct "
        "FROM mf_scheme_sector_allocation"
    )
    if df.empty:
        print("[MFSectorAlloc] No scheme rows captured yet.")
        return 0

    df["month"] = df["holding_date"].str.slice(0, 7)
    latest = str(df["month"].max())
    cur = df[df["month"] == latest]
    if cur.empty:
        return 0

    # Schemes whose newest disclosure predates `latest` contribute nothing.
    # Say so -- silent truncation reads as full coverage.
    dropped = len(df) - len(cur)
    if dropped:
        stale_months = sorted(set(df.loc[df["month"] != latest, "month"]))[:6]
        print(f"[MFSectorAlloc] {dropped} row(s) dropped as off-month "
              f"(latest={latest}; stale months seen: {', '.join(stale_months)}).")

    agg = cur.groupby("sector").agg(
        aum_pct=("invest_pct", "mean"),
        aum_cr=("invest_value_cr", "sum"),
        flow_pct=("mom_change_pct", "mean"),
        n_schemes=("sector", "count"),
    ).reset_index()

    executemany(
        "INSERT INTO mf_sector_allocation (month, sector, aum_cr, aum_pct) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (month, sector) DO UPDATE SET aum_cr = EXCLUDED.aum_cr, aum_pct = EXCLUDED.aum_pct",
        [(latest, r.sector, float(r.aum_cr), float(r.aum_pct))
         for r in agg.itertuples(index=False)],
    )

    flow = agg[["sector", "flow_pct"]].copy()
    _update_macro_asset_prices(flow, latest)
    n_ts = _update_technical_signals(flow)
    print(f"[MFSectorAlloc] Month {latest}: {len(agg)} sectors aggregated; "
          f"{n_ts} technical_signals rows updated.")

    # Both downstream writers return/log a count rather than raising when the
    # sector vocabulary misses, so assert on what actually landed. A vocabulary
    # drift would otherwise exit 0 having written nothing.
    _assert_propagated(latest)
    return len(agg)


def _assert_propagated(month: str) -> None:
    alloc = int(read_df(
        "SELECT COUNT(*) n FROM mf_sector_allocation WHERE month = ?",
        params=(month,),
    )["n"].iloc[0])
    macro = int(read_df(
        "SELECT COUNT(*) n FROM macro_asset_prices WHERE symbol LIKE 'MF_FLOW%'"
    )["n"].iloc[0])
    if alloc == 0:
        print("[MFSectorAlloc] FATAL: mf_sector_allocation has no rows for "
              f"{month} after the write.")
        sys.exit(1)
    if macro == 0:
        print("[MFSectorAlloc] FATAL: zero MF_FLOW_* rows in macro_asset_prices "
              "-- SECTOR_LABEL's keys no longer match any canonical sector name.")
        sys.exit(1)
    print(f"[MFSectorAlloc] Verified: mf_sector_allocation={alloc} rows for "
          f"{month}, MF_FLOW_* macro rows={macro}.")


# ---------------------------------------------------------------------------

def run(refresh: bool = False, max_per_amc=None, limit_schemes=None,
        sleep_s: float = 0.15) -> None:
    ensure_schema()

    if refresh or not load_universe(limit=1):
        if refresh_universe(max_per_amc=max_per_amc) == 0:
            print("[MFSectorAlloc] FATAL: universe refresh found zero schemes.")
            sys.exit(1)

    schemes = load_universe(limit=limit_schemes)
    if not schemes:
        print("[MFSectorAlloc] FATAL: empty universe -- run with --refresh-amcs.")
        sys.exit(1)

    ok = empty = failed = 0
    for i, sid in enumerate(schemes, 1):
        try:
            rows = capture_scheme(sid)
        except UpstreamError:
            failed += 1
        else:
            if rows is None:
                empty += 1      # debt/index/liquid schemes report no sectors
            else:
                save_rows(sid, rows)
                ok += 1
        if i % 100 == 0:
            print(f"[MFSectorAlloc]   {i}/{len(schemes)} probed "
                  f"(ok={ok}, empty={empty}, fail={failed})")
        time.sleep(sleep_s)

    print(f"[MFSectorAlloc] Captured {ok} schemes ({empty} non-equity/empty, {failed} errors).")
    if ok == 0:
        print("[MFSectorAlloc] FATAL: zero schemes reported sector data.")
        sys.exit(1)
    # A mostly-failed run must not quietly overwrite a good month with a thin
    # one. Only reachable now that `failed` counts real upstream failures.
    if failed > ok:
        print(f"[MFSectorAlloc] FATAL: more upstream failures ({failed}) than "
              f"successful captures ({ok}) -- refusing to aggregate.")
        sys.exit(1)

    if aggregate_and_propagate() == 0:
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MF sector allocation fetcher (ET/mcxlivefeeds)")
    parser.add_argument("--refresh-amcs", action="store_true",
                        help="re-discover AMC/scheme universe first")
    parser.add_argument("--max-per-amc", type=int, default=None,
                        help="cap schemes captured per AMC during refresh")
    parser.add_argument("--limit-schemes", type=int, default=None,
                        help="only probe the first N universe schemes")
    parser.add_argument("--sleep", type=float, default=0.15,
                        help="seconds between scheme probes")
    args = parser.parse_args()
    run(refresh=args.refresh_amcs, max_per_amc=args.max_per_amc,
        limit_schemes=args.limit_schemes, sleep_s=args.sleep)
