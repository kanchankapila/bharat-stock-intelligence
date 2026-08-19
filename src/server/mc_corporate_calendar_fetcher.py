"""
mc_corporate_calendar_fetcher.py

Fetches MoneyControl corporate action calendar (dividends, board meetings, AGMs)
and stamps two types of features onto technical_signals:

  1. Event-proximity features (forward-looking):
       days_to_ex_div         — days until next ex-dividend date  (NULL if none in 30d)
       days_to_board_meeting  — days until next board meeting      (NULL if none in 30d)
       upcoming_div_pct       — upcoming dividend / last close * 100

  2. Historical dividend features (backward-looking, refreshed from corporate_actions):
       days_since_dividend    — days since most-recent past ex-dividend
       last_dividend_amt      — most-recent dividend amount (₹)

Endpoints:
  duration=UP  — upcoming events (typically covers ~14 days ahead)
  duration=T   — today only (used to catch same-day events missed in UP)

scId in MC response == mcsymbol in nse_stocks → resolve to symbol.
"""

import os
import sys
import argparse
import logging
from datetime import datetime, date, timedelta
from typing import Optional

try:
    from curl_cffi import requests as cffi_req
    def _get(url: str, **kw):
        headers = {
            "accept": "application/json",
            "origin": "https://www.moneycontrol.com",
            "referer": "https://www.moneycontrol.com/",
            "user-agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        }
        return retry_get(cffi_req, url, headers=headers, timeout=20, **kw)
except ImportError:
    import requests as _req
    def _get(url: str, **kw):
        return retry_get(_req, url, timeout=20, **kw)

# ── path setup ──────────────────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

os.environ.setdefault("USE_POSTGRES", "true")
from db_compat import connect   # noqa: E402
from fetch_utils import retry_get   # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── constants ────────────────────────────────────────────────────────────────
_BASE = "https://api.moneycontrol.com/mcapi/v1/ecalendar/corporate-action"
_PARAMS = "indexId=All&page=1&event=All&apiVersion=161&orderBy=asc&deviceType=W"
_LOOKAHEAD_DAYS = 30          # how far ahead we look for dividends / board meetings
_DATE_FMT = "%d/%m/%Y"       # MC uses DD/MM/YYYY


def _parse_date(s: str) -> Optional[date]:
    if not s or s in ("-", "NA", "N/A", ""):
        return None
    try:
        return datetime.strptime(s.strip(), _DATE_FMT).date()
    except ValueError:
        return None


def _fetch_duration(duration: str) -> dict:
    """Returns {date_str: [event, ...]} or {} on error."""
    url = f"{_BASE}?{_PARAMS}&duration={duration}"
    try:
        resp = _get(url)
        resp.raise_for_status()
        data = resp.json()
        return data.get("data", {}).get("list", {}) or {}
    except Exception as e:
        log.warning("Failed to fetch duration=%s: %s", duration, e)
        return {}


def _build_scid_map(con) -> dict:
    """mcsymbol → symbol mapping from nse_stocks."""
    rows = con.execute(
        "SELECT mcsymbol, symbol FROM nse_stocks WHERE mcsymbol IS NOT NULL AND mcsymbol != ''"
    ).fetchall()
    return {row[0]: row[1] for row in rows}


def _parse_events(listing: dict) -> list[dict]:
    """Flatten dated listing into list of event dicts with resolved dates."""
    events = []
    for _date_str, ev_list in listing.items():
        if not isinstance(ev_list, list):
            continue
        for ev in ev_list:
            sc_id = (ev.get("scId") or "").strip()
            if not sc_id:
                continue
            ex_date_str = (ev.get("exDate") or "").strip()
            # For board meetings the key date is disp_date
            disp_str = (ev.get("disp_date") or _date_str or "").strip()
            ev_type = (ev.get("eventType") or "").strip()
            dividend_str = (ev.get("dividend") or "").strip()
            events.append({
                "sc_id":      sc_id,
                "event_type": ev_type,
                "disp_date":  _parse_date(disp_str),
                "ex_date":    _parse_date(ex_date_str) if ex_date_str else _parse_date(disp_str),
                "dividend":   float(dividend_str) if dividend_str and dividend_str not in ("-", "NA") else None,
                "stock_name": (ev.get("stockName") or "").strip(),
                "raw":        ev,
            })
    return events


def _upsert_corporate_actions(con, events: list[dict], scid_map: dict) -> int:
    """Write dividend ex-dates into corporate_actions table."""
    inserted = 0
    today = date.today()
    for ev in events:
        if "Dividend" not in ev["event_type"]:
            continue
        symbol = scid_map.get(ev["sc_id"])
        if not symbol:
            continue
        ex_dt = ev["ex_date"]
        if ex_dt is None or ex_dt < today:
            continue
        action_type = "DIVIDEND"
        if "Special" in ev["event_type"]:
            action_type = "DIVIDEND_SPECIAL"
        con.execute(
            """
            INSERT INTO corporate_actions (symbol, ex_date, action_type, amount, ratio, source, ingested_at)
            VALUES (?, ?, ?, ?, NULL, 'MC_CALENDAR', NOW())
            ON CONFLICT (symbol, ex_date, action_type)
            DO UPDATE SET amount = EXCLUDED.amount, ingested_at = NOW()
            """,
            (symbol, ex_dt.isoformat(), action_type, ev["dividend"]),
        )
        inserted += 1
    return inserted


def _build_forward_maps(events: list[dict], scid_map: dict) -> tuple[dict, dict, dict]:
    """
    Returns:
      sym_ex_div:   symbol → (min_days_to_ex, div_amount)
      sym_board:    symbol → min_days_to_board_meeting
      sym_div_pct:  symbol → upcoming_div_pct (needs last close; computed later)
    """
    today = date.today()
    cutoff = today + timedelta(days=_LOOKAHEAD_DAYS)

    # symbol → {days, amount}
    ex_div: dict[str, dict] = {}
    board: dict[str, int] = {}

    for ev in events:
        symbol = scid_map.get(ev["sc_id"])
        if not symbol:
            continue
        ev_type = ev["event_type"]

        if "Dividend" in ev_type:
            dt = ev["ex_date"]
            if dt and today <= dt <= cutoff:
                days = (dt - today).days
                if symbol not in ex_div or days < ex_div[symbol]["days"]:
                    ex_div[symbol] = {"days": days, "amount": ev["dividend"]}

        elif "Board Meeting" in ev_type:
            dt = ev["disp_date"] or ev["ex_date"]
            if dt and today <= dt <= cutoff:
                days = (dt - today).days
                if symbol not in board or days < board[symbol]:
                    board[symbol] = days

    return ex_div, board


def _stamp_technical_signals(con, ex_div: dict, board: dict, dry_run: bool) -> int:
    """
    Update most-recent technical_signals row per symbol with:
      days_to_ex_div, days_to_board_meeting, upcoming_div_pct, days_since_dividend, last_dividend_amt
    """
    if dry_run:
        log.info("[DRY] Would stamp %d ex_div + %d board_meeting symbols", len(ex_div), len(board))
        for sym, v in list(ex_div.items())[:5]:
            log.info("  [DRY] ex_div %s: %d days, ₹%s", sym, v["days"], v["amount"])
        for sym, d in list(board.items())[:5]:
            log.info("  [DRY] board  %s: %d days", sym, d)
        return 0

    updated = 0
    today = date.today()

    # Build a set of all symbols we want to touch
    all_syms = set(ex_div.keys()) | set(board.keys())

    # Also pull last close prices so we can compute upcoming_div_pct
    price_rows = con.execute(
        "SELECT symbol, close FROM stock_ohlcv WHERE (symbol, date) IN "
        "(SELECT symbol, MAX(date) FROM stock_ohlcv WHERE symbol = ANY(ARRAY[{}]) GROUP BY symbol)".format(
            ",".join(f"'{s}'" for s in all_syms)
        )
    ).fetchall() if all_syms else []
    last_price: dict[str, float] = {row[0]: float(row[1]) for row in price_rows}

    for sym in all_syms:
        set_parts = []
        params: dict = {"sym": sym}

        if sym in ex_div:
            v = ex_div[sym]
            set_parts.append("days_to_ex_div = :days_ex")
            params["days_ex"] = float(v["days"])
            if v["amount"] is not None:
                close = last_price.get(sym)
                if close and close > 0:
                    div_pct = v["amount"] / close * 100
                    set_parts.append("upcoming_div_pct = :div_pct")
                    params["div_pct"] = round(div_pct, 3)

        if sym in board:
            set_parts.append("days_to_board_meeting = :days_bm")
            params["days_bm"] = float(board[sym])

        if not set_parts:
            continue

        # date = :date guard (2026-07-19) instead of MAX(date) -- see bse_event_classifier.py's
        # run_daily docstring for why matching the latest row isn't the same as matching today.
        params["date"] = today.isoformat()
        sql = (
            f"UPDATE technical_signals SET {', '.join(set_parts)} "
            f"WHERE symbol = :sym AND date = :date"
        )
        con.execute(sql, params)
        updated += 1

    # Refresh historical dividend features from corporate_actions
    n_hist = _refresh_historical_div(con, all_syms, today)
    log.info("Refreshed historical div features for %d symbols", n_hist)
    con.commit()
    return updated


def _refresh_historical_div(con, symbols: set[str], today: date) -> int:
    """Fill days_since_dividend + last_dividend_amt from past corporate_actions."""
    if not symbols:
        return 0
    rows = con.execute(
        """
        SELECT symbol, MAX(ex_date) as last_ex, MAX(amount) FILTER (WHERE ex_date = (
            SELECT MAX(ex_date) FROM corporate_actions ca2
            WHERE ca2.symbol = ca.symbol AND action_type IN ('DIVIDEND','DIVIDEND_SPECIAL') AND ex_date <= to_char(NOW(), 'YYYY-MM-DD')
        )) as last_amt
        FROM corporate_actions ca
        WHERE action_type IN ('DIVIDEND', 'DIVIDEND_SPECIAL')
          AND ex_date <= to_char(NOW(), 'YYYY-MM-DD')
          AND symbol = ANY(ARRAY[{}])
        GROUP BY symbol
        """.format(",".join(f"'{s}'" for s in symbols))
    ).fetchall()
    updated = 0
    for sym, last_ex, last_amt in rows:
        if last_ex is None:
            continue
        if isinstance(last_ex, date):
            last_ex_date = last_ex
        else:
            try:
                last_ex_date = date.fromisoformat(str(last_ex).strip().split()[0])
            except (ValueError, IndexError) as e:
                print(f"[CorpCalendar] Skipping {sym}: unparseable ex_date {last_ex!r} ({e})", file=sys.stderr)
                continue
        days_since = (today - last_ex_date).days
        # date = :date guard (2026-07-19) instead of MAX(date) -- same fix as above.
        con.execute(
            "UPDATE technical_signals SET days_since_dividend = :ds, last_dividend_amt = :la "
            "WHERE symbol = :sym AND date = :date",
            {"ds": float(days_since) if days_since is not None else None,
             "la": float(last_amt) if last_amt is not None else None,
             "sym": sym, "date": today.isoformat()},
        )
        updated += 1
    return updated


def _ensure_columns(con) -> None:
    # SQLite has no ADD COLUMN IF NOT EXISTS, so this has to be try/except-idempotent
    # rather than relying on the (Postgres-only) IF NOT EXISTS clause this previously used.
    for stmt in [
        "ALTER TABLE technical_signals ADD COLUMN days_to_ex_div REAL",
        "ALTER TABLE technical_signals ADD COLUMN days_to_board_meeting REAL",
        "ALTER TABLE technical_signals ADD COLUMN upcoming_div_pct REAL",
    ]:
        try:
            con.execute(stmt)
        except Exception:
            # Postgres aborts the whole transaction on a failed statement (e.g. duplicate
            # column) -- without this rollback every subsequent query on this connection
            # would raise InFailedSqlTransaction.
            con.rollback()
    con.commit()


def run(dry_run: bool = False):
    con = connect()
    _ensure_columns(con)
    today = date.today()
    log.info("Fetching corporate calendar for %s (lookahead: %dd)", today, _LOOKAHEAD_DAYS)

    # Fetch today + this week + next week (covers ~14 days of forward events including dividends)
    # duration=UP paginates slowly; TW/NW are pre-filtered to right date ranges
    combined: dict = {}
    for dur in ("T", "TW", "NW"):
        for bucket, evs in _fetch_duration(dur).items():
            if bucket not in combined:
                combined[bucket] = []
            seen = {e.get("scId") for e in combined[bucket]}
            combined[bucket].extend(e for e in evs if e.get("scId") not in seen)

    events = _parse_events(combined)
    log.info("Parsed %d events across %d date buckets", len(events), len(combined))

    from collections import Counter
    ev_types = Counter(ev["event_type"] for ev in events)
    log.info("Event types: %s", dict(ev_types.most_common()))

    scid_map = _build_scid_map(con)
    log.info("scId→symbol map: %d entries", len(scid_map))

    # Upsert dividends into corporate_actions
    n_ca = _upsert_corporate_actions(con, events, scid_map) if not dry_run else 0
    if n_ca:
        con.commit()
    log.info("Upserted %d dividend records into corporate_actions", n_ca)

    # Build forward-looking maps
    ex_div, board = _build_forward_maps(events, scid_map)
    log.info("Upcoming ex-div: %d symbols | Board meetings: %d symbols", len(ex_div), len(board))
    for sym, v in sorted(ex_div.items(), key=lambda x: x[1]["days"])[:10]:
        amt = f"₹{v['amount']}" if v["amount"] else "?"
        log.info("  ex-div %s: %dd  %s", sym, v["days"], amt)
    for sym, d in sorted(board.items(), key=lambda x: x[1])[:5]:
        log.info("  board  %s: %dd", sym, d)

    # Stamp technical_signals
    n_ts = _stamp_technical_signals(con, ex_div, board, dry_run)
    log.info("Stamped %d symbols in technical_signals", n_ts)

    log.info("Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
