"""AF-20261127-03: NSE fills the names SmartOptions did not cover. The 2026-09-05 fallback was written but
never called, stored NSE lots as shares, and put the absolute OI change into the percent column."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import fetch_utils
import nse_option_chain_source as nse
import so_option_chain_fetcher as so

TODAY = "2026-11-27"
EXPIRY = "2026-12-29"


def _payload(stamp="27-Nov-2026 15:30:00"):
    leg = {"lastPrice": 10.0, "totalTradedVolume": 50, "openInterest": 100, "changeinOpenInterest": 7,
           "pchangeinOpenInterest": 7.5, "impliedVolatility": 24.0}
    return {"records": {"timestamp": stamp, "underlyingValue": 500, "data": [{"strikePrice": 500, "CE": leg, "PE": leg}]}}


class _Resp:
    def __init__(self, status=200, text="", body=None):
        self.status_code, self.text, self._body, self.ok = status, text, body, status < 400

    def json(self):
        return self._body


def test_ampersand_is_encoded_for_nse():
    seen = []

    class S:
        def get(self, url, **kw):
            seen.append(url)
            return _Resp(404)

    nse.fetch_nse_chain(S(), "M&M", "29-Dec-2026")
    assert "symbol=M%26M&expiry=29-Dec-2026" in seen[0]


def test_ampersand_is_encoded_for_smartoptions(monkeypatch):
    seen = []
    monkeypatch.setattr(so, "VENDOR_BLOCK", fetch_utils.VendorBlockLatch("test"))
    monkeypatch.setattr(so.requests, "get", lambda url, **kw: seen.append(url) or _Resp(404))
    so.fetch_chain("M&M", EXPIRY)
    assert "stockCode=M%26M&expDate=" in seen[0]


def test_universe_is_the_names_with_futures_and_falls_back_to_the_flag(monkeypatch):
    asked = []

    def q(sql, *a, **k):
        asked.append(sql)
        return [] if "stock_futures_eod_history" in sql else [{"symbol": "FLAGGED"}]

    monkeypatch.setattr(so, "query_all", q)
    assert so._get_fno_symbols() == ["FLAGGED"]
    assert "stock_futures_eod_history" in asked[0] and "status = 'ACTIVE'" in asked[0]
    monkeypatch.setattr(so, "query_all", lambda sql, *a, **k: [{"symbol": "ICICILIFE"}])
    assert so._get_fno_symbols() == ["ICICILIFE"]


def _fill(monkeypatch, have=("AAA",), lots=None, payloads=None):
    lots = {"AAA": 10, "BBB": 200, "CCC": 50} if lots is None else lots  # AAA is skipped for coverage, not lots
    asked, saved = [], []

    def q(sql, params=None):
        if "FROM so_option_chain" in sql:
            return [{"symbol": s} for s in have]
        return [{"lot_size": lots[params[0]]}] if params[0] in lots else []

    def fetch(session, symbol, exp, **kw):
        asked.append(symbol)
        return (payloads or {}).get(symbol, _payload())

    monkeypatch.setattr(so, "query_all", q)
    monkeypatch.setattr(so, "_nse_session", lambda: object())
    monkeypatch.setattr(so, "fetch_nse_chain", fetch)
    monkeypatch.setattr(so, "_get_nearest_expiry", lambda s: EXPIRY)
    monkeypatch.setattr(so, "save_chain", lambda rows, summ, overwrite=True: saved.append((rows, summ, overwrite)))
    return asked, saved


def test_only_names_without_a_chain_today_are_filled_and_nothing_is_overwritten(monkeypatch):
    asked, saved = _fill(monkeypatch)
    assert so.fill_gaps_from_nse(["AAA", "BBB", "CCC"], TODAY, delay=0) == 2
    assert asked == ["BBB", "CCC"]
    assert [s[2] for s in saved] == [False, False]
    assert saved[0][0][0][6] == 100 * 200  # lots stored as shares


def test_a_name_with_no_lot_size_is_skipped_not_stored_in_lots(monkeypatch):
    asked, saved = _fill(monkeypatch, lots={"CCC": 50})
    assert so.fill_gaps_from_nse(["BBB", "CCC"], TODAY, delay=0) == 1
    assert [s[0][0][0] for s in saved] == ["CCC"]


def test_a_snapshot_from_an_earlier_session_is_not_stored_as_today(monkeypatch):
    asked, saved = _fill(monkeypatch, payloads={"BBB": _payload("26-Nov-2026 15:30:00")})
    assert so.fill_gaps_from_nse(["BBB", "CCC"], TODAY, delay=0) == 1
    assert [s[0][0][0] for s in saved] == ["CCC"]


def test_nothing_is_filled_when_coverage_cannot_be_read(monkeypatch):
    _, saved = _fill(monkeypatch)

    def boom(sql, params=None):
        raise RuntimeError("db down")

    monkeypatch.setattr(so, "query_all", boom)
    assert so.fill_gaps_from_nse(["BBB"], TODAY, delay=0) == 0
    assert saved == []


def test_run_hands_the_names_smartoptions_left_to_nse_and_succeeds(monkeypatch):
    monkeypatch.setattr(so, "VENDOR_BLOCK", fetch_utils.VendorBlockLatch("test"))
    monkeypatch.setattr(so.requests, "get", lambda url, **kw: _Resp(405))
    monkeypatch.setattr(so, "is_trading_session", lambda d: True)
    monkeypatch.setattr(so, "_get_fno_symbols", lambda: ["AAA", "BBB"])
    monkeypatch.setattr(so, "_coverage_map", lambda syms: {})
    monkeypatch.setattr(so, "_get_nearest_expiry", lambda sym: EXPIRY)
    seen = []
    monkeypatch.setattr(so, "fill_gaps_from_nse", lambda syms, today, expiry=None, delay=0.3: seen.append(syms) or 2)
    so.run(delay=0)  # no SystemExit: NSE wrote chains although SmartOptions refused
    assert seen == [["AAA", "BBB"]]


def test_a_gap_fill_write_never_replaces_an_existing_row(pg_db):
    from db_compat import execute, query_all

    execute("CREATE TABLE IF NOT EXISTS so_option_chain (symbol text, date text, expiry text, strike float8, "
            + ", ".join(f"{leg}_{c} {'text' if c == 'buildup' else 'float8'}" for leg in ("ce", "pe")
                        for c in ("price", "volume", "oi", "oi_chg_pct", "iv", "iv_chg", "delta", "gamma",
                                  "theta", "vega", "rho", "buildup"))
            + ", fetched_at timestamptz DEFAULT now(), PRIMARY KEY (symbol, date, expiry, strike))")

    def row(oi, delta):
        leg = [1.0, 1.0, oi, 0.0, 20.0, None, delta, None, None, None, None, None]
        return ("AAA", TODAY, EXPIRY, 500.0, *leg, *leg)

    so.save_chain([row(111.0, 0.5)], None)
    so.save_chain([row(999.0, None)], None, overwrite=False)
    got = query_all("SELECT ce_oi, ce_delta FROM so_option_chain WHERE symbol = ?", ("AAA",))
    assert (got[0]["ce_oi"], got[0]["ce_delta"]) == (111.0, 0.5)


LOT_FILE = (
    "UNDERLYING          ,SYMBOL    ,DEC-26     ,JAN-27     \n"
    "KOTHARI             ,ACUTAAS   ,150        ,175        \n"
    "Derivatives on Individual Securities,Symbol,DEC-26,JAN-27\n"
    "NOT LISTED YET      ,NEWCO     ,           ,25         \n"
)


def test_lot_file_is_read_from_the_expiry_month_column():
    assert so.parse_lot_sizes(LOT_FILE, "2026-12-29") == {"ACUTAAS": 150.0}
    assert so.parse_lot_sizes(LOT_FILE, "2027-01-26") == {"ACUTAAS": 175.0, "NEWCO": 25.0}
    assert so.parse_lot_sizes(LOT_FILE, "2027-06-29") == {}
    assert so.parse_lot_sizes("", "2026-12-29") == {}


def test_a_lot_size_nt_does_not_carry_comes_from_the_exchange_file(monkeypatch):
    _, saved = _fill(monkeypatch, lots={"CCC": 50})
    fetched = []

    class S:
        def get(self, url, **kw):
            fetched.append(url)
            return _Resp(200, LOT_FILE.replace("ACUTAAS", "BBB    ") .replace("NOT LISTED YET      ,NEWCO", "X,DDD"))

    monkeypatch.setattr(so, "_nse_session", lambda: S())
    assert so.fill_gaps_from_nse(["BBB", "CCC", "ZZZ"], TODAY, delay=0) == 2
    assert saved[0][0][0][6] == 100 * 150  # BBB in shares, from the file
    assert fetched == [so.LOT_FILE_URL]  # one download per run, even with two names missing from NT


def test_universe_drops_names_whose_contracts_have_all_expired(pg_db):
    from db_compat import execute

    for i, sym in enumerate(("LIVE", "GONE")):
        execute("INSERT INTO nse_stocks (id, symbol, name, status, fno_eligible) VALUES (?, ?, ?, 'ACTIVE', 1)",
                (990000 + i, sym, sym))
        execute("INSERT INTO stock_futures_eod_history (symbol, trade_date, expiry, instrument, expiry_rank, is_expiry_day, source) "
                "VALUES (?, current_date - 3, current_date + CAST(? AS int), 'STF', 1, false, 't')", (sym, 30 if sym == "LIVE" else -3))
    assert so._get_fno_symbols() == ["LIVE"]
