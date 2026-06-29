"""
MF Sector Flow Fetcher
======================
Fetches monthly mutual fund equity AUM allocations by sector from AMFI portfolio
disclosures, aggregates sector-level AUM %, computes month-over-month inflow/outflow,
writes results to `mf_sector_allocation`, and updates `technical_signals.mf_sector_flow_pct`
and `macro_asset_prices` for the top 10 sectors.

DII (mutual fund) sector allocation shifts are leading indicators: sector inflows tend
to predict sector outperformance in the next 30–60 days.

Run:
    python mf_sector_flow_fetcher.py
    python mf_sector_flow_fetcher.py --month 2026-05
"""

import argparse
import calendar
import datetime
import io
import re
import time

import pandas as pd

try:
    from curl_cffi import requests as cffi_requests
    _USE_CFFI = True
except ImportError:
    import requests as cffi_requests
    _USE_CFFI = False

from db_compat import connect, translate, executemany, read_df

# ---------------------------------------------------------------------------
# AMFI portfolio disclosure URL — returns a large pipe-/comma-delimited CSV
# that contains every equity holding across all schemes for the given month.
# ---------------------------------------------------------------------------
AMFI_PORTFOLIO_URL = (
    "https://portal.amfiindia.com/DownloadSchemeData_Po.aspx"
    "?mf=0&tp=1&fD={month_start}&tD={month_end}"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":          "text/html,application/xhtml+xml,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://www.amfiindia.com/",
}

# Top sectors we emit as macro features (must match nse_stocks.sector values)
TOP_SECTORS = [
    "Financial Services",
    "Information Technology",
    "Automobile",
    "Pharmaceuticals",
    "FMCG",
    "Energy",
    "Metals & Mining",
    "Capital Goods",
    "Healthcare",
    "Consumer Durables",
]

# Map sector name → macro_asset_prices label suffix
SECTOR_LABEL = {
    "Financial Services":  "BANKS",
    "Information Technology": "IT",
    "Automobile":          "AUTO",
    "Pharmaceuticals":     "PHARMA",
    "FMCG":                "FMCG",
    "Energy":              "ENERGY",
    "Metals & Mining":     "METALS",
    "Capital Goods":       "CAPGOODS",
    "Healthcare":          "HEALTH",
    "Consumer Durables":   "CONSDUR",
}

# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------

def ensure_schema() -> None:
    """Create mf_sector_allocation and add mf_sector_flow_pct to technical_signals."""
    conn = connect()
    conn.execute(translate("""
        CREATE TABLE IF NOT EXISTS mf_sector_allocation (
            month    TEXT NOT NULL,
            sector   TEXT NOT NULL,
            aum_cr   REAL,
            aum_pct  REAL,
            PRIMARY KEY (month, sector)
        )
    """))
    conn.commit()
    conn.close()

    for col in ("mf_sector_flow_pct",):
        try:
            c = connect()
            c.execute(translate(
                f"ALTER TABLE technical_signals ADD COLUMN {col} REAL"
            ))
            c.commit()
            c.close()
            print(f"[MFSectorFlow] Added column technical_signals.{col}")
        except Exception:
            try:
                c.rollback()
                c.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# AMFI data download + parse
# ---------------------------------------------------------------------------

def _month_bounds(month_str: str):
    """'YYYY-MM' → ('DD-Mon-YYYY', 'DD-Mon-YYYY') for first and last day."""
    year, mon = int(month_str[:4]), int(month_str[5:7])
    last_day = calendar.monthrange(year, mon)[1]
    fmt = "%d-%b-%Y"
    start = datetime.date(year, mon, 1).strftime(fmt)
    end   = datetime.date(year, mon, last_day).strftime(fmt)
    return start, end


def _fetch_raw(month_str: str) -> str:
    """Download AMFI portfolio disclosure text for *month_str* ('YYYY-MM').
    Returns raw text; raises on failure."""
    start, end = _month_bounds(month_str)
    url = AMFI_PORTFOLIO_URL.format(month_start=start, month_end=end)
    print(f"[MFSectorFlow] Downloading AMFI portfolio for {month_str} …")

    if _USE_CFFI:
        resp = cffi_requests.get(url, headers=HEADERS, impersonate="chrome110", timeout=120)
    else:
        import requests as _req
        resp = _req.get(url, headers=HEADERS, timeout=120)

    resp.raise_for_status()
    return resp.text


def _parse_amfi(raw: str) -> pd.DataFrame:
    """Parse the AMFI bulk portfolio text.

    The file has a repeating header block per scheme followed by pipe-delimited
    holding rows.  We only need columns: ISIN/Company Name, Market Value, and
    % to NAV.  We detect the separator dynamically (pipe or comma).

    Returns a DataFrame with columns: [isin, holding_name, mkt_value_lakh, pct_nav].
    """
    lines = raw.splitlines()
    data_rows = []
    current_scheme_aum = None  # total AUM in crores for current scheme

    # Detect delimiter from the first non-blank, non-header line
    separator = "|"

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Scheme header rows contain "Scheme Name:" or "Total AUM"
        if re.search(r"Total\s*AUM", line, re.I):
            # Try to parse the scheme total AUM: e.g. "Total AUM;1234.56"
            m = re.search(r"[\d,]+\.?\d*", line.replace(",", ""))
            if m:
                current_scheme_aum = float(m.group().replace(",", ""))
            continue

        # Detect separator
        if "|" in line:
            separator = "|"
        elif "," in line and separator != "|":
            separator = ","

        parts = [p.strip() for p in line.split(separator)]
        if len(parts) < 5:
            continue

        # Try to identify rows that look like holding records:
        # typical columns: ISIN | Company | Rating | Industry | Value(Lakhs) | % to NAV
        # Some files have 7-8 columns; we heuristically pick the last two numerics.
        try:
            # Last column = % to NAV, second-last = market value
            pct_nav = float(parts[-1].replace(",", ""))
            mkt_val = float(parts[-2].replace(",", ""))
        except ValueError:
            continue

        isin_col = parts[0]
        name_col = parts[1] if len(parts) > 1 else ""
        industry = parts[3] if len(parts) > 3 else ""

        # Sanity: ISIN is 12 chars starting with IN
        if not re.match(r"^IN[A-Z0-9]{10}$", isin_col):
            isin_col = ""

        if pct_nav <= 0 or pct_nav > 100:
            continue

        data_rows.append({
            "isin":     isin_col,
            "name":     name_col,
            "industry": industry,
            "mkt_val":  mkt_val,   # in lakhs as reported
            "pct_nav":  pct_nav,
        })

    if not data_rows:
        return pd.DataFrame()

    return pd.DataFrame(data_rows)


# ---------------------------------------------------------------------------
# Sector mapping — join AMFI holdings to nse_stocks.sector via ISIN
# ---------------------------------------------------------------------------

def _load_sector_map() -> pd.DataFrame:
    """Load (isin, symbol, sector) from nse_stocks."""
    df = read_df("SELECT isin, symbol, sector FROM nse_stocks WHERE isin IS NOT NULL AND sector IS NOT NULL")
    return df.drop_duplicates("isin")


def _aggregate_by_sector(holdings: pd.DataFrame, sector_map: pd.DataFrame) -> pd.DataFrame:
    """Join holdings → sector, aggregate AUM % per sector.

    Returns DataFrame [sector, aum_pct] where aum_pct is the sector's share of
    total reported market value (not NAV %, which is per-fund).
    """
    merged = holdings.merge(sector_map, on="isin", how="left")

    # For rows where ISIN lookup failed, attempt name-based heuristic via industry field
    # (AMFI often provides an 'industry' column in the same row)
    mask_no_sector = merged["sector"].isna() & merged["industry"].notna()
    merged.loc[mask_no_sector, "sector"] = merged.loc[mask_no_sector, "industry"]

    merged = merged.dropna(subset=["sector"])
    if merged.empty:
        return pd.DataFrame(columns=["sector", "aum_pct"])

    total_val = merged["mkt_val"].sum()
    if total_val == 0:
        return pd.DataFrame(columns=["sector", "aum_pct"])

    by_sector = (
        merged.groupby("sector")["mkt_val"]
        .sum()
        .reset_index()
        .rename(columns={"mkt_val": "aum_val"})
    )
    by_sector["aum_pct"] = (by_sector["aum_val"] / total_val * 100).round(4)
    # aum_cr: convert from lakhs to crores (÷100); approximate — AMFI gives lakhs
    by_sector["aum_cr"] = (by_sector["aum_val"] / 100).round(2)
    return by_sector[["sector", "aum_cr", "aum_pct"]]


# ---------------------------------------------------------------------------
# DB persistence
# ---------------------------------------------------------------------------

def _save_sector_allocation(month_str: str, by_sector: pd.DataFrame) -> None:
    rows = [
        (month_str, r.sector, r.aum_cr, r.aum_pct)
        for r in by_sector.itertuples(index=False)
    ]
    executemany(
        "INSERT INTO mf_sector_allocation (month, sector, aum_cr, aum_pct) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(month, sector) DO UPDATE SET aum_cr=excluded.aum_cr, aum_pct=excluded.aum_pct",
        rows,
    )
    print(f"[MFSectorFlow] Saved {len(rows)} sector rows for {month_str}.")


def _load_saved_allocation(month_str: str) -> pd.DataFrame:
    return read_df(
        "SELECT sector, aum_pct FROM mf_sector_allocation WHERE month = ?",
        params=(month_str,),
    )


# ---------------------------------------------------------------------------
# Compute MoM flow and update downstream tables
# ---------------------------------------------------------------------------

def _compute_flow(curr_df: pd.DataFrame, prior_df: pd.DataFrame) -> pd.DataFrame:
    """Return DataFrame [sector, flow_pct] = current aum_pct − prior aum_pct."""
    merged = curr_df.merge(prior_df, on="sector", suffixes=("_curr", "_prior"), how="outer")
    merged["aum_pct_curr"]  = merged["aum_pct_curr"].fillna(0)
    merged["aum_pct_prior"] = merged["aum_pct_prior"].fillna(0)
    merged["flow_pct"] = (merged["aum_pct_curr"] - merged["aum_pct_prior"]).round(4)
    return merged[["sector", "flow_pct"]].sort_values("flow_pct", ascending=False)


def _update_macro_asset_prices(flow: pd.DataFrame, month_str: str) -> None:
    """Write per-sector flow into macro_asset_prices as MF_FLOW_<SECTOR> labels."""
    year, mon = int(month_str[:4]), int(month_str[5:7])
    last_day = calendar.monthrange(year, mon)[1]
    price_date = f"{month_str}-{last_day:02d}"

    flow_map = dict(zip(flow["sector"], flow["flow_pct"]))

    rows = []
    for sector, label_suffix in SECTOR_LABEL.items():
        val = flow_map.get(sector)
        if val is None:
            continue
        label = f"MF_FLOW_{label_suffix}"
        rows.append((price_date, label, float(val)))

    if not rows:
        return

    executemany(
        "INSERT INTO macro_asset_prices (date, label, close) VALUES (?, ?, ?) "
        "ON CONFLICT(date, label) DO UPDATE SET close=excluded.close",
        rows,
    )
    print(f"[MFSectorFlow] Wrote {len(rows)} MF_FLOW macro features for {price_date}.")


def _update_technical_signals(flow: pd.DataFrame) -> int:
    """Set mf_sector_flow_pct on technical_signals rows where stock's sector matches."""
    flow_map = dict(zip(flow["sector"], flow["flow_pct"]))
    if not flow_map:
        return 0

    # Load all distinct (symbol, date) rows from technical_signals + sector from nse_stocks
    ts = read_df(
        "SELECT ts.symbol, ts.date, ns.sector "
        "FROM technical_signals ts "
        "JOIN nse_stocks ns ON ts.symbol = ns.symbol "
        "WHERE ns.sector IS NOT NULL"
    )
    if ts.empty:
        return 0

    ts["mf_sector_flow_pct"] = ts["sector"].map(flow_map)
    ts = ts.dropna(subset=["mf_sector_flow_pct"])
    if ts.empty:
        return 0

    params = [
        (float(r.mf_sector_flow_pct), r.symbol, r.date)
        for r in ts.itertuples(index=False)
    ]
    n = executemany(
        "UPDATE technical_signals SET mf_sector_flow_pct = ? "
        "WHERE symbol = ? AND date = ?",
        params,
    )
    return n


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

def _prior_month(month_str: str) -> str:
    year, mon = int(month_str[:4]), int(month_str[5:7])
    mon -= 1
    if mon == 0:
        mon, year = 12, year - 1
    return f"{year:04d}-{mon:02d}"


def run(month_str: str | None = None) -> None:
    ensure_schema()

    if month_str is None:
        today = datetime.date.today()
        # AMFI publishes disclosures ~10 days after month-end; default to last complete month
        if today.day < 12:
            year, mon = today.year, today.month - 1
            if mon == 0:
                mon, year = 12, year - 1
        else:
            year, mon = today.year, today.month - 1
            if mon == 0:
                mon, year = 12, year - 1
        month_str = f"{year:04d}-{mon:02d}"

    prior_str = _prior_month(month_str)
    print(f"[MFSectorFlow] Target month: {month_str}, prior month: {prior_str}")

    sector_map = _load_sector_map()
    if sector_map.empty:
        print("[MFSectorFlow] WARNING: nse_stocks has no ISIN/sector data — sector join will use AMFI industry field only.")

    # ---- Process current month ----
    curr_saved = _load_saved_allocation(month_str)
    if curr_saved.empty:
        raw = _fetch_raw(month_str)
        time.sleep(1)
        holdings = _parse_amfi(raw)
        total_holdings = len(holdings)
        print(f"[MFSectorFlow] Parsed {total_holdings} holding rows for {month_str}.")

        if holdings.empty:
            print("[MFSectorFlow] No holdings parsed — AMFI format may have changed.")
            return

        curr_alloc = _aggregate_by_sector(holdings, sector_map)
        _save_sector_allocation(month_str, curr_alloc)
    else:
        curr_alloc = curr_saved
        total_holdings = 0
        print(f"[MFSectorFlow] Using cached allocation for {month_str} ({len(curr_alloc)} sectors).")

    # ---- Process prior month ----
    prior_saved = _load_saved_allocation(prior_str)
    if prior_saved.empty:
        try:
            raw_prior = _fetch_raw(prior_str)
            time.sleep(1)
            holdings_prior = _parse_amfi(raw_prior)
            print(f"[MFSectorFlow] Parsed {len(holdings_prior)} holding rows for {prior_str}.")
            prior_alloc = _aggregate_by_sector(holdings_prior, sector_map)
            _save_sector_allocation(prior_str, prior_alloc)
        except Exception as e:
            print(f"[MFSectorFlow] Could not fetch prior month ({prior_str}): {e}")
            prior_alloc = pd.DataFrame(columns=["sector", "aum_pct"])
    else:
        prior_alloc = prior_saved
        print(f"[MFSectorFlow] Using cached allocation for {prior_str} ({len(prior_alloc)} sectors).")

    # ---- Compute flow ----
    flow = _compute_flow(curr_alloc[["sector", "aum_pct"]], prior_alloc[["sector", "aum_pct"]])

    top_in  = flow[flow["flow_pct"] > 0].head(5)
    top_out = flow[flow["flow_pct"] < 0].tail(5)

    inflow_str  = ", ".join(f"{r.sector} +{r.flow_pct:.2f}%" for r in top_in.itertuples(index=False))
    outflow_str = ", ".join(f"{r.sector} {r.flow_pct:.2f}%" for r in top_out.itertuples(index=False))

    # ---- Persist downstream ----
    _update_macro_asset_prices(flow, month_str)
    n_ts = _update_technical_signals(flow)

    print(
        f"[MFSectorFlow] Processed {total_holdings} holdings. "
        f"Top inflows: {inflow_str or 'none'}. "
        f"Top outflows: {outflow_str or 'none'}. "
        f"{n_ts} stocks updated."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MF sector flow fetcher (AMFI)")
    parser.add_argument(
        "--month",
        help="Month to fetch in YYYY-MM format (default: last complete month)",
    )
    args = parser.parse_args()
    run(month_str=args.month)
