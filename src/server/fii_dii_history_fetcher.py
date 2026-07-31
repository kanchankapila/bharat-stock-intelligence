#!/usr/bin/env python3
"""
FII/DII deep-history fetcher -- 10.6 years of daily institutional flow in ONE call.

WHY THIS EXISTS
---------------
`fii_dii_flow` held 682 rows starting 2023-11-01 (the `tradebrains` backfill plus the daily
NSE top-up in fii_dii_fetcher.py). The 2026-07-30 data/bias audit's binding constraint was
that only 55 distinct dates exist in the ML feature matrix, so nothing built on macro flow
could be validated across more than one regime. This endpoint returns 2,584 daily rows back
to 2016-01-01 in a single 738 KB request -- ~4x the existing depth, no symbol resolution, no
pagination. The 2026-07-31 endpoint-corpus audit ranked it the single highest value-per-effort
item in a 919-URL corpus.

  https://investsights.in/api/v2/fundamentals/market/fiidii?days=9999

THE TRAP -- READ BEFORE CHANGING THE MAPPING
--------------------------------------------
The endpoint reuses the SAME column name for TWO different quantities depending on era, and
the audit's own recommendation ("fii_net/dii_net are ~97% non-null -- use the _net fields")
would have written the wrong number into a column the whole platform reads as cash equity.
Verified live 2026-07-31 against 2,584 rows and cross-checked against the 589 overlapping
`tradebrains` rows already in the DB:

  * RECENT era (87 rows, `fii_buy`/`fii_sell` populated):
        fii_net == fii_buy - fii_sell            (82/87 exact)
    This is CASH EQUITY net -- the platform's existing `fii_dii_flow.fii_net` semantics.

  * HISTORICAL era (2,497 rows, `fii_buy`/`fii_sell` NULL):
        fii_net == fii_equity + fii_debt + fii_derivatives   (2472/2497 exact)
    This is an ALL-SEGMENT net dominated by derivatives notional. On 2024-09-26 it reads
    132,159 Cr against a true cash-equity figure of 8,538 Cr -- a 15x overstatement.
    The cash-equity number in this era is `fii_equity`, and it matches the existing
    tradebrains rows EXACTLY: 506 of 506 comparable overlap rows agree within 1 Cr
    (median absolute difference 0.03 Cr, i.e. pure rounding).

So `fii_net` here is mapped era-aware: buy-minus-sell when available, else `fii_equity`.
The all-segment figure is preserved separately in `fii_net_all_segments` -- it is real
information, just not the same series.

  * DII is NOT the same population. The endpoint's `dii_net` equals `mf_total`
    (2484/2497 exact) -- SEBI mutual-fund flows only. NSE's "DII" aggregate additionally
    includes banks, insurers and other domestic institutions. Measured against the
    overlapping tradebrains rows the two disagree by a median of 3,786 Cr (mf_total) and
    743 Cr (mf_equity); 0 and 1 rows respectively agree within 1 Cr. Writing MF into
    `dii_net` would be silently wrong, so historical rows leave `dii_net` NULL and the MF
    series lands in its own `mf_*` columns.

By default this fetcher NEVER overwrites an existing non-NULL value -- it fills gaps and adds
the new segment columns. Pass --overwrite only if you have re-verified the source.

Run:
  python fii_dii_history_fetcher.py                 # fetch + fill gaps (safe, idempotent)
  python fii_dii_history_fetcher.py --dry-run       # report what would change, write nothing
  python fii_dii_history_fetcher.py --overwrite     # let this source win on conflicts
"""
import argparse
import datetime
import sys

import requests

from db_compat import connect, ConnWrapper
from fetch_utils import retry_get

API_URL = "https://investsights.in/api/v2/fundamentals/market/fiidii?days=9999"
SOURCE = "investsights"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://investsights.in/",
}

# Columns this fetcher adds to fii_dii_flow. The base table (date, fii_buy, fii_sell,
# fii_net, dii_buy, dii_sell, dii_net, source, fetched_at) predates it.
SEGMENT_COLS = [
    "fii_equity", "fii_debt", "fii_derivatives", "fii_net_all_segments",
    "mf_equity", "mf_debt", "mf_derivatives", "mf_total",
]


def _log(m):
    print(f"[FiiDiiHistory] {m}", flush=True)


def _num(v):
    """Coerce to float, or None. Never returns NaN -- a NaN in a numeric column reads as a
    real value to every coverage check in this repo but poisons every mean downstream."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def fetch(session: requests.Session | None = None) -> list[dict]:
    """Hit the real endpoint and return its raw `data` list. This is the ONLY fetch path --
    tests must call it rather than reimplementing, or a test can pass while this is broken."""
    s = session or requests.Session()
    s.headers.update(HEADERS)
    resp = retry_get(s, API_URL, timeout=45)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        raise ValueError(f"unexpected payload envelope: {str(payload)[:200]}")
    data = payload.get("data") or []
    if not isinstance(data, list):
        raise ValueError(f"`data` is not a list: {type(data)}")
    return data


def parse_row(raw: dict) -> dict | None:
    """Map ONE API row onto fii_dii_flow's semantics, era-aware.

    See the module docstring: `fii_net` means cash-equity net in the recent era and
    all-segment net in the historical era, and the endpoint gives no explicit era flag --
    the presence of fii_buy/fii_sell is the discriminator. Returns None for a row with no
    usable date or no usable number at all.
    """
    date = (raw.get("trade_date") or "").strip()
    # Guard the shape rather than trusting it: a silently-reformatted date would otherwise
    # insert a garbage primary key that every `date >=` comparison then mis-sorts.
    try:
        datetime.date.fromisoformat(date)
    except ValueError:
        return None

    fii_buy = _num(raw.get("fii_buy"))
    fii_sell = _num(raw.get("fii_sell"))
    fii_equity = _num(raw.get("fii_equity"))
    fii_debt = _num(raw.get("fii_debt"))
    fii_deriv = _num(raw.get("fii_derivatives"))
    raw_fii_net = _num(raw.get("fii_net"))

    recent_era = fii_buy is not None and fii_sell is not None

    if recent_era:
        # Cash equity, straight from the source's own buy/sell pair.
        fii_net = raw_fii_net if raw_fii_net is not None else fii_buy - fii_sell
        # 21 "transitional" rows (verified live 2026-07-31, e.g. 2026-03-20..2026-03-25) carry
        # BOTH the buy/sell pair and the segment breakdown. There raw_fii_net is cash equity
        # (2026-03-25: -1508.89 == buy-sell, against equity+debt+deriv = 4242.8), so the
        # all-segment figure has to be summed rather than read off fii_net. Returning None
        # here would silently drop real derivatives data that the row actually contains.
        parts = [v for v in (fii_equity, fii_debt, fii_deriv) if v is not None]
        fii_net_all = sum(parts) if parts else None
    else:
        # Historical era: raw_fii_net is the all-segment figure; cash equity is fii_equity.
        fii_net = fii_equity
        fii_net_all = raw_fii_net
        if fii_net_all is None:
            parts = [v for v in (fii_equity, fii_debt, fii_deriv) if v is not None]
            fii_net_all = sum(parts) if parts else None

    dii_buy = _num(raw.get("dii_buy"))
    dii_sell = _num(raw.get("dii_sell"))
    raw_dii_net = _num(raw.get("dii_net"))
    mf_total = _num(raw.get("mf_total"))

    # Only accept dii_net when it is genuinely the DII aggregate (recent era, backed by a
    # buy/sell pair). In the historical era the endpoint's dii_net IS mf_total -- a
    # mutual-fund-only series -- and writing it into a DII column would be silently wrong.
    if dii_buy is not None and dii_sell is not None:
        dii_net = raw_dii_net if raw_dii_net is not None else dii_buy - dii_sell
    else:
        dii_net = None

    row = {
        "date": date,
        "fii_buy": fii_buy,
        "fii_sell": fii_sell,
        "fii_net": fii_net,
        "dii_buy": dii_buy,
        "dii_sell": dii_sell,
        "dii_net": dii_net,
        "fii_equity": fii_equity,
        "fii_debt": fii_debt,
        "fii_derivatives": fii_deriv,
        "fii_net_all_segments": fii_net_all,
        "mf_equity": _num(raw.get("mf_equity")),
        "mf_debt": _num(raw.get("mf_debt")),
        "mf_derivatives": _num(raw.get("mf_derivatives")),
        "mf_total": mf_total,
    }
    if all(row[k] is None for k in row if k != "date"):
        return None
    return row


def parse_all(data: list[dict]) -> list[dict]:
    return [r for r in (parse_row(x) for x in data) if r is not None]


# ── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(conn: ConnWrapper) -> None:
    """Add the segment columns if absent. node-pg-migrate owns the production migration;
    this keeps a throwaway/SQLite test DB and a fresh dev box working without one."""
    for col in SEGMENT_COLS:
        try:
            conn.execute(f"ALTER TABLE fii_dii_flow ADD COLUMN {col} REAL")
            conn.commit()
        except Exception:
            # Column already exists. Postgres poisons the transaction on a failed statement,
            # so every later query in it would die with InFailedSqlTransaction -- roll back.
            try:
                conn.rollback()
            except Exception:
                pass


BASE_COLS = ["fii_buy", "fii_sell", "fii_net", "dii_buy", "dii_sell", "dii_net"]
ALL_VALUE_COLS = BASE_COLS + SEGMENT_COLS


def store(conn: ConnWrapper, rows: list[dict], overwrite: bool = False,
          dry_run: bool = False) -> dict:
    """Upsert rows. Default is gap-fill: an existing non-NULL value is never clobbered, so
    running this alongside the NSE/tradebrains sources is safe and order-independent.

    `source` is only stamped on rows this fetcher actually originates, so an existing row's
    provenance is not rewritten by a fill that only added segment columns.
    """
    stats = {"inserted": 0, "filled": 0, "unchanged": 0, "cells_filled": 0}
    if not rows:
        return stats

    now = datetime.datetime.now().isoformat()
    cur = conn.execute(f"SELECT date, {', '.join(ALL_VALUE_COLS)} FROM fii_dii_flow")
    existing = {}
    for r in cur.fetchall():
        vals = list(r)
        existing[vals[0]] = dict(zip(ALL_VALUE_COLS, vals[1:]))

    for row in rows:
        d = row["date"]
        if d not in existing:
            if not dry_run:
                cols = ["date"] + ALL_VALUE_COLS + ["source", "fetched_at"]
                ph = ",".join(["?"] * len(cols))
                conn.execute(
                    f"INSERT INTO fii_dii_flow ({', '.join(cols)}) VALUES ({ph})",
                    tuple([d] + [row.get(c) for c in ALL_VALUE_COLS] + [SOURCE, now]),
                )
            stats["inserted"] += 1
            continue

        cur_vals = existing[d]
        updates = {}
        for c in ALL_VALUE_COLS:
            new = row.get(c)
            if new is None:
                continue
            old = cur_vals.get(c)
            if old is None or (overwrite and old != new):
                updates[c] = new
        if not updates:
            stats["unchanged"] += 1
            continue
        if not dry_run:
            sets = ", ".join(f"{c}=?" for c in updates)
            conn.execute(
                f"UPDATE fii_dii_flow SET {sets}, fetched_at=? WHERE date=?",
                tuple(list(updates.values()) + [now, d]),
            )
        stats["filled"] += 1
        stats["cells_filled"] += len(updates)

    if not dry_run:
        conn.commit()
    return stats


def run(overwrite: bool = False, dry_run: bool = False) -> int:
    data = fetch()
    _log(f"fetched {len(data)} raw rows from investsights")
    rows = parse_all(data)
    if not rows:
        _log("ERROR: 0 rows survived parsing -- refusing to treat this as success")
        return 1

    dates = [r["date"] for r in rows]
    _log(f"parsed {len(rows)} rows, {min(dates)} -> {max(dates)}")

    conn = connect()
    try:
        ensure_schema(conn)
        stats = store(conn, rows, overwrite=overwrite, dry_run=dry_run)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    prefix = "[DRY RUN] would have" if dry_run else ""
    _log(f"{prefix} inserted={stats['inserted']} filled={stats['filled']} "
         f"(cells={stats['cells_filled']}) unchanged={stats['unchanged']}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="FII/DII deep-history fetcher (investsights)")
    ap.add_argument("--overwrite", action="store_true",
                    help="let this source win on conflicts (default: fill NULLs only)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing")
    args = ap.parse_args()
    sys.exit(run(overwrite=args.overwrite, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
