"""
Regression test for moneycontrol_fetcher.py's insider_trades.date_iso gap (2026-08-01).

Context: insider_features.py reads insider_trades via `WHERE date_iso >= ? AND date_iso <= ?`
(fixed 2026-07-30/31 because `date` is TEXT holding NSE's display format on most legacy rows).
But moneycontrol_fetcher.py -- the DOMINANT, currently-scheduled writer of insider_trades
(not insider_transactions_fetcher.py, which writes a DIFFERENT table, insider_transactions) --
never populated date_iso on insert at all. Every row it wrote after the one-time backfill
migration was invisible to insider_features.py's filter: live-checked 2026-08-01, only 4 of
2,187 technical_signals rows had insider_buy_pct_90d populated for 2026-07-31 -- the exact
pre-fix symptom, despite the read-side fix already being live.
"""
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import moneycontrol_fetcher as mcf


INSIDER_HTML = """
<div class="bd_bx">
    <div class="br_date">19-May-26</div>
    <div class="brstk_name"><h3>John Promoter</h3></div>
    <div class="desinper">Promoter</div>
    <button class="btndeal">Buy</button>
    <table>
        <tr><td>Qty <strong>1,000</strong></td></tr>
        <tr><td>Price <strong>250.50</strong></td></tr>
    </table>
</div>
"""

# A date string the strptime("%d-%b-%y") branch cannot parse, forcing the raw-fallback path.
INSIDER_HTML_UNPARSEABLE_DATE = INSIDER_HTML.replace("19-May-26", "31 Oct, 2025")


def _make_fetcher():
    with patch.object(mcf, 'get_engine', return_value=MagicMock()), \
         patch.object(mcf, 'ensure_tables_exist'):
        return mcf.MoneyControlFetcher(target_symbols=['RELIANCE'])


def _captured_insert_rows(fetcher, html):
    """Run _parse_insider and return the dict passed to each INSERT execute() call."""
    conn = MagicMock()
    fetcher.engine.begin.return_value.__enter__.return_value = conn
    fetcher._parse_insider('RELIANCE', html)
    return [call.args[1] for call in conn.execute.call_args_list]


class TestInsiderDateIsoPopulated:
    def test_date_iso_present_on_insert_when_date_parses_cleanly(self):
        fetcher = _make_fetcher()
        rows = _captured_insert_rows(fetcher, INSIDER_HTML)
        assert rows, "expected at least one insider row parsed"
        r = rows[0]
        assert r['date'] == '2026-05-19'
        assert r['dateIso'] == '2026-05-19'

    def test_date_iso_still_populated_when_strptime_fallback_fires(self):
        """The `%d-%b-%y` strptime can fail on an unexpected MC date format, in which case
        `date_str` falls back to the raw string -- date_iso must still resolve via the
        same robust parser data_integrity_repair.py's one-time backfill used."""
        fetcher = _make_fetcher()
        rows = _captured_insert_rows(fetcher, INSIDER_HTML_UNPARSEABLE_DATE)
        assert rows, "expected at least one insider row parsed"
        r = rows[0]
        assert r['date'] == '31 Oct, 2025'  # raw fallback, unchanged behavior
        assert r['dateIso'] == '2025-10-31'  # but date_iso is still a real ISO date

    def test_insert_statement_includes_date_iso_column(self):
        fetcher = _make_fetcher()
        conn = MagicMock()
        fetcher.engine.begin.return_value.__enter__.return_value = conn
        fetcher._parse_insider('RELIANCE', INSIDER_HTML)
        sql_text = str(conn.execute.call_args_list[0].args[0])
        assert 'date_iso' in sql_text
