import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402
import insider_transactions_fetcher as itf


class TestParseDate:
    """Regression test for the fix: NSE dates sometimes carry a time or sequence
    suffix ('13-Feb-2026 16:56', '13-Feb-2026 1') that previously failed to parse."""

    def test_strips_time_suffix(self):
        assert itf._parse_date("13-Feb-2026 16:56") == "2026-02-13"

    def test_strips_sequence_suffix(self):
        assert itf._parse_date("13-Feb-2026 1") == "2026-02-13"

    def test_iso_format(self):
        assert itf._parse_date("2026-02-13") == "2026-02-13"

    def test_slash_format(self):
        assert itf._parse_date("13/02/2026") == "2026-02-13"

    def test_dash_numeric_format(self):
        assert itf._parse_date("13-02-2026") == "2026-02-13"

    def test_empty_or_none_returns_none(self):
        assert itf._parse_date("") is None
        assert itf._parse_date(None) is None

    def test_unparseable_returns_none(self):
        assert itf._parse_date("not-a-date") is None


def _base_row(**overrides):
    row = {
        "personName": "", "acqName": "John Doe", "personCategory": "Promoter",
        "acqMode": "Market Purchase", "secAcq": "1000", "secVal": "500000",
        # befAcqSharesPer/afterAcqSharesPer: NSE's own real field names (live-verified
        # 2026-08-07 against RELIANCE/TCS/INFY/SUZLON/YESBANK -- see the fix's comment in
        # insider_transactions_fetcher.py). No totSharesNo field exists in NSE's real
        # response at all -- deliberately absent from this fixture.
        "befAcqSharesNo": "10000", "afterAcqSharesNo": "11000",
        "befAcqSharesPer": "1.0", "afterAcqSharesPer": "1.1",
        "date": "13-Feb-2026",
    }
    row.update(overrides)
    return row


class TestParseRecordAcqNameFallback:
    """Regression test for the fix: NSE's corporates-pit response uses 'acqName' for
    some record shapes instead of 'personName' -- without the fallback, those rows
    were stored with a blank/None person_name."""

    def test_falls_back_to_acq_name_when_person_name_blank(self):
        rec = itf._parse_record("RELIANCE", _base_row())
        assert rec["person_name"] == "John Doe"

    def test_prefers_person_name_when_present(self):
        rec = itf._parse_record("RELIANCE", _base_row(personName="Jane Roe"))
        assert rec["person_name"] == "Jane Roe"

    def test_value_converted_to_crores(self):
        rec = itf._parse_record("RELIANCE", _base_row(secVal="10000000"))
        assert rec["value_cr"] == 1.0

    def test_before_after_pct_read_directly_from_nse_pct_fields(self):
        """Regression test for the 2026-08-07 fix: before_pct/after_pct used to be derived as
        befAcqSharesNo/totSharesNo -- but NSE's real response has no totSharesNo field at all
        (live-verified), so that division was always by zero -> always None (confirmed live,
        23,596/23,596 rows). NSE already supplies the percentage directly."""
        rec = itf._parse_record("RELIANCE", _base_row())
        assert rec["before_pct"] == 1.0
        assert rec["after_pct"] == 1.1

    def test_before_after_pct_none_when_nse_omits_the_pct_fields(self):
        """Some real filings (live-verified: YESBANK, 0/20 records) have no pct data from NSE
        at all -- must degrade to None, not raise or default to 0 as if it were a real value."""
        rec = itf._parse_record("RELIANCE", _base_row(befAcqSharesPer=None, afterAcqSharesPer=None))
        assert rec["before_pct"] is None
        assert rec["after_pct"] is None

    def test_row_with_unparseable_date_is_dropped(self):
        rec = itf._parse_record("RELIANCE", _base_row(date="garbage"))
        assert rec is None

    def test_malformed_numeric_fields_degrade_to_none_not_raise(self):
        rec = itf._parse_record("RELIANCE", _base_row(secVal="NA", befAcqSharesPer="NA"))
        assert rec is not None
        assert rec["value_cr"] is None
        assert rec["before_pct"] is None


# ── Regression: dead NSE session no longer silently truncates the run (2026-07-31) ──
#
# Observed live 2026-07-30: the run walks the universe alphabetically; NSE expired the cookies
# from the single startup warm-up partway through, and EVERY symbol from "E" onward then failed
# with a read timeout (96 E + 37 F + 27 G in one run, zero successes after) until the 30-minute
# job timeout killed it. H-Z was never fetched on any run. Two defects made that invisible:
# fetch_nse_insider returned [] for BOTH "no filings" and "request failed", and the summary line
# printed only an aggregate row count. Now: None means failure, and the session is rebuilt.

class _StubResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class TestFetchDistinguishesFailureFromEmpty:
    def test_returns_empty_list_when_nse_says_no_filings(self, monkeypatch):
        monkeypatch.setattr(itf, "retry_get", lambda *a, **k: _StubResp({"data": []}))
        assert itf.fetch_nse_insider(None, "INFY", "01-01-2026", "31-01-2026") == []

    def test_returns_none_when_request_fails(self, monkeypatch):
        def _boom(*a, **k):
            raise RuntimeError("Read timed out. (read timeout=12)")
        monkeypatch.setattr(itf, "retry_get", _boom)
        # None, NOT [] — conflating them is what made a throttled run look like a
        # universe with no insider activity.
        assert itf.fetch_nse_insider(None, "INFY", "01-01-2026", "31-01-2026") is None

    def test_returns_data_array_on_success(self, monkeypatch):
        monkeypatch.setattr(itf, "retry_get",
                            lambda *a, **k: _StubResp({"data": [{"symbol": "INFY"}]}))
        assert itf.fetch_nse_insider(None, "INFY", "01-01-2026", "31-01-2026") == [{"symbol": "INFY"}]


class TestSessionRebuildGuards:
    def test_rebuild_thresholds_are_sane(self):
        assert 1 <= itf.CONSECUTIVE_FAIL_LIMIT <= 20
        assert itf.MAX_SESSION_REBUILDS >= 1

    def test_rebuild_returns_none_instead_of_raising(self, monkeypatch):
        """A failed warm-up must not abort the run — the loop needs to keep its old
        session and decide for itself when to give up."""
        monkeypatch.setattr(itf.time, "sleep", lambda *_: None)
        def _boom():
            raise RuntimeError("NSE refused warm-up")
        monkeypatch.setattr(itf, "_nse_session", _boom)
        assert itf._rebuild_session(1) is None

    def test_rebuild_returns_new_session_on_success(self, monkeypatch):
        monkeypatch.setattr(itf.time, "sleep", lambda *_: None)
        sentinel = object()
        monkeypatch.setattr(itf, "_nse_session", lambda: sentinel)
        assert itf._rebuild_session(1) is sentinel


# ── Regression: compute_and_write_features() write-target date (2026-08-01) ──────────────
#
# compute_and_write_features()'s `UPDATE ... WHERE symbol = ? AND date = ?` already had a
# date = ? guard (2026-07-19) to avoid overwriting a stale historical row, but anchored it to
# a raw date.today() -- which silently writes into a calendar day with no technical_signals
# grid row whenever ml-daily-ops's step chain crosses midnight IST. Must use
# as_of.logical_trading_date() instead (same fix as insider_features.py/bse_event_classifier.py).

class _FakeCursor:
    def __init__(self, select_result=(10.0, 2.0)):
        self._select_result = select_result
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self._select_result


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()
        self.committed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True


class TestComputeAndWriteFeaturesUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date_not_raw_today(self, monkeypatch):
        monkeypatch.setattr(itf, "logical_trading_date", lambda: "2026-07-31")
        monkeypatch.setattr(itf, "use_postgres", lambda: False)
        conn = _FakeConn()

        itf.compute_and_write_features(conn, "INFY", days=90)

        updates = [c for c in conn.cur.executed if "UPDATE technical_signals" in c[0]]
        assert len(updates) == 1
        _, params = updates[0]
        assert params[-2] == "INFY"
        assert params[-1] == "2026-07-31", (
            "compute_and_write_features() must write against logical_trading_date()'s "
            "value, not date.today()"
        )
        assert conn.committed

    def test_wrong_calendar_date_would_match_nothing_silently(self, monkeypatch):
        """Negative control: documents the original failure mode without the fix."""
        monkeypatch.setattr(itf, "logical_trading_date", lambda: "2026-08-01")
        monkeypatch.setattr(itf, "use_postgres", lambda: False)
        conn = _FakeConn()

        itf.compute_and_write_features(conn, "INFY", days=90)

        updates = [c for c in conn.cur.executed if "UPDATE technical_signals" in c[0]]
        _, params = updates[0]
        assert params[-1] == "2026-08-01"  # would NOT match a grid row dated 2026-07-31


# ── Regression: compute_and_write_features() now reads insider_trades, not
# insider_transactions (2026-08-07) ──────────────────────────────────────────────────
#
# insider_transactions_fetcher.py's own NSE per-symbol endpoint (corporates-pit?symbol=X&
# from=Y&to=Z) does not honor its own from/to params -- live-probed directly: RELIANCE's
# response mixed dates from 2021 through 2026 regardless of the requested 90-day window --
# so insider_transactions had zero rows newer than 2026-05-02 across all 1,823 symbols ever
# fetched, for 90+ days, despite the fetcher running nightly and genuinely touching fetched_at
# every time. Every existing health signal (job success, non-empty upsert, fresh fetched_at)
# looked fine; only checking the actual transaction_date values exposed it. Switched the
# feature computation onto insider_trades (fed by moneycontrol_fetcher.py +
# tickertape_deals_fetcher.py --insider, genuinely fresh, already used by insider_features.py
# for the sibling insider_buy_pct_90d ratio). These tests use a real SQLite DB (not the fake
# cursor above) so the actual SQL -- category ILIKE/LOWE-LIKE filter, BUY_TYPES/SELL_TYPES
# IN-list, valueInr -> Cr conversion -- is genuinely exercised, not just its call shape.

import datetime
import sqlite3


def _make_insider_trades_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE insider_trades (
            symbol TEXT, "typeOfTransaction" TEXT, "valueInr" REAL,
            category TEXT, date_iso TEXT
        );
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT,
            promoter_buy_90d_cr REAL, promoter_sell_90d_cr REAL, promoter_net_90d REAL,
            insider_buy_flag INTEGER, insider_sell_flag INTEGER,
            PRIMARY KEY (symbol, date)
        );
    """)
    return conn


def _seed_trade(conn, symbol, txn_type, value_inr, category, days_ago):
    d = (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()
    conn.execute(
        'INSERT INTO insider_trades (symbol, "typeOfTransaction", "valueInr", category, date_iso) '
        "VALUES (?, ?, ?, ?, ?)",
        (symbol, txn_type, value_inr, category, d),
    )
    conn.commit()


class TestComputeAndWriteFeaturesReadsInsiderTrades:
    def _run(self, monkeypatch, conn, symbol="TESTSYM", today="2026-08-06"):
        monkeypatch.setattr(itf, "use_postgres", lambda: False)
        monkeypatch.setattr(itf, "logical_trading_date", lambda: today)
        conn.execute(
            "INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (symbol, today)
        )
        conn.commit()
        itf.compute_and_write_features(conn, symbol, days=90)
        row = conn.execute(
            "SELECT promoter_buy_90d_cr, promoter_sell_90d_cr, promoter_net_90d, "
            "insider_buy_flag, insider_sell_flag FROM technical_signals "
            "WHERE symbol = ? AND date = ?", (symbol, today),
        ).fetchone()
        return row

    def test_promoter_buy_and_sell_aggregate_into_crores(self, monkeypatch):
        conn = _make_insider_trades_db()
        _seed_trade(conn, "TESTSYM", "BUY", 20_000_000, "Promoter", 5)   # 2 Cr
        _seed_trade(conn, "TESTSYM", "SELL", 10_000_000, "Promoter", 10)  # 1 Cr
        row = self._run(monkeypatch, conn)
        assert row["promoter_buy_90d_cr"] == 2.0
        assert row["promoter_sell_90d_cr"] == 1.0
        assert row["promoter_net_90d"] == 1.0

    def test_non_promoter_category_excluded(self, monkeypatch):
        conn = _make_insider_trades_db()
        _seed_trade(conn, "TESTSYM", "BUY", 50_000_000, "Insider - Connected Person", 5)
        row = self._run(monkeypatch, conn)
        assert row["promoter_buy_90d_cr"] == 0.0, (
            "a non-promoter category must not count toward the promoter-only feature"
        )

    def test_promoter_group_variant_is_matched_case_insensitively(self, monkeypatch):
        conn = _make_insider_trades_db()
        _seed_trade(conn, "TESTSYM", "buy", 15_000_000, "Insider - Promoter Group", 5)
        row = self._run(monkeypatch, conn)
        assert row["promoter_buy_90d_cr"] == 1.5, (
            "'Insider - Promoter Group' contains 'promoter' and must match; "
            "lowercase 'buy' must still classify via UPPER(TRIM(...))"
        )

    def test_esop_and_pledge_types_are_not_buy_or_sell(self, monkeypatch):
        """ESOP/Pledge/Bonus/Gift aren't open-market activity -- the file's own docstring is
        specifically about open-market conviction, not every SEBI PIT disclosure type."""
        conn = _make_insider_trades_db()
        _seed_trade(conn, "TESTSYM", "ESOP", 30_000_000, "Promoter", 5)
        _seed_trade(conn, "TESTSYM", "Pledge -  Pledge Creation", 30_000_000, "Promoter", 5)
        row = self._run(monkeypatch, conn)
        assert row["promoter_buy_90d_cr"] == 0.0
        assert row["promoter_sell_90d_cr"] == 0.0

    def test_trades_outside_the_90d_window_are_excluded(self, monkeypatch):
        conn = _make_insider_trades_db()
        _seed_trade(conn, "TESTSYM", "BUY", 20_000_000, "Promoter", 120)  # 120 days ago
        row = self._run(monkeypatch, conn)
        assert row["promoter_buy_90d_cr"] == 0.0

    def test_flags_set_only_past_their_respective_thresholds(self, monkeypatch):
        conn = _make_insider_trades_db()
        _seed_trade(conn, "TESTSYM", "BUY", 5_000_000, "Promoter", 5)    # 0.5 Cr, below 1.0 threshold
        _seed_trade(conn, "TESTSYM", "SELL", 60_000_000, "Promoter", 5)  # 6.0 Cr, above 5.0 threshold
        row = self._run(monkeypatch, conn)
        assert row["insider_buy_flag"] == 0
        assert row["insider_sell_flag"] == 1

    def test_a_different_symbols_activity_does_not_leak_in(self, monkeypatch):
        conn = _make_insider_trades_db()
        _seed_trade(conn, "OTHERSYM", "BUY", 100_000_000, "Promoter", 5)
        row = self._run(monkeypatch, conn)
        assert row["promoter_buy_90d_cr"] == 0.0
