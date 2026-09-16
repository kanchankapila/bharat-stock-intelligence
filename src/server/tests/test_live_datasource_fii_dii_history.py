"""Live-datasource test for fii_dii_history_fetcher.py (CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.

This one carries extra weight. The endpoint-corpus audit's §1.3/§4.3 both found endpoints in
this corpus returning a confident 200 with a payload that passes every null/coverage check and
is still wrong, and this fetcher's whole correctness rests on an ERA rule inferred from the
live payload's shape rather than from any documented contract. So this test does not merely
assert "non-empty": it re-verifies the two invariants the mapping depends on, against the real
response, every time it runs. If investsights ever changes the semantics of `fii_net`, this
fails here rather than silently poisoning the platform's macro-flow column.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import fii_dii_history_fetcher as fdh
from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite


def _mem_db():
    con = pg_memory_conn()
    con.execute("""
        CREATE TABLE fii_dii_flow (
            date TEXT PRIMARY KEY, fii_buy REAL, fii_sell REAL, fii_net REAL,
            dii_buy REAL, dii_sell REAL, dii_net REAL, source TEXT, fetched_at TEXT
        )
    """)
    con.commit()
    return con


@pytest.mark.live_datasource
class TestFiiDiiHistoryLiveDataSource:
    def test_real_fetch_returns_deep_history(self):
        """Step 1-3: hit the real endpoint, parse with the fetcher's OWN parser, assert the
        depth that justifies this fetcher's existence is actually there."""
        data = fdh.fetch()
        assert_non_empty_response(data, "fii_dii_history_fetcher.fetch()")

        rows = fdh.parse_all(data)
        assert_non_empty_response(rows, "fii_dii_history_fetcher.parse_all()")

        dates = sorted(r["date"] for r in rows)
        # The value of this source is depth. 682 rows from 2023-11 already existed; if the
        # endpoint quietly starts truncating, this fetcher is pointless and should fail loudly.
        assert len(rows) > 2000, f"expected deep history, got only {len(rows)} rows"
        assert dates[0] < "2017-01-01", f"history starts too late: {dates[0]}"

    def test_era_invariants_still_hold_on_live_data(self):
        """The mapping in parse_row() is inferred from payload shape, not a documented
        contract. Re-verify both eras against the live response so a silent upstream
        semantics change is caught here."""
        rows_raw = fdh.fetch()
        historical = [r for r in rows_raw if r.get("fii_buy") is None and r.get("fii_net") is not None]
        assert historical, "no historical-era rows in the live response"

        def close(a, b, tol=1.0):
            return a is not None and b is not None and abs(a - b) <= tol

        checked = agreed = 0
        for r in historical:
            parts = [r.get(k) for k in ("fii_equity", "fii_debt", "fii_derivatives")]
            if any(p is None for p in parts):
                continue
            checked += 1
            if close(r["fii_net"], sum(parts)):
                agreed += 1
        assert checked > 500, f"too few complete historical rows to verify ({checked})"
        ratio = agreed / checked
        assert ratio > 0.95, (
            f"historical fii_net no longer equals equity+debt+derivatives ({ratio:.1%}) -- "
            "the era rule in parse_row() may be stale; re-measure before trusting this source"
        )

        recent = [r for r in rows_raw
                  if r.get("fii_buy") is not None and r.get("fii_sell") is not None
                  and r.get("fii_net") is not None]
        assert recent, "no recent-era rows in the live response"
        ok = sum(1 for r in recent if close(r["fii_net"], r["fii_buy"] - r["fii_sell"]))
        assert ok / len(recent) > 0.90, (
            f"recent fii_net no longer equals buy-sell ({ok}/{len(recent)})"
        )

    def test_stored_rows_are_ml_usable(self):
        """Step 4-5: write through the fetcher's OWN store() into a throwaway DB, read back,
        and assert the numbers are real finite values -- not None, NaN, or a stringified blob."""
        rows = fdh.parse_all(fdh.fetch())
        con = _mem_db()
        fdh.ensure_schema(con)
        stats = fdh.store(con, rows)
        assert stats["inserted"] > 2000

        # Pick a genuinely HISTORICAL row: segment data present AND no buy/sell pair. The
        # 21 "transitional" rows have both, and there dii_net is legitimately populated --
        # selecting on segments alone would pick one of those and assert the wrong invariant.
        r = con.execute(
            "SELECT fii_net, fii_net_all_segments, fii_derivatives, mf_total, dii_net "
            "FROM fii_dii_flow WHERE fii_derivatives IS NOT NULL AND fii_net IS NOT NULL "
            "AND fii_buy IS NULL AND mf_total IS NOT NULL ORDER BY date DESC LIMIT 1"
        ).fetchone()
        assert r is not None, "no historical row stored"
        fii_net, all_seg, deriv, mf_total, dii_net = r
        assert_numeric_and_finite(fii_net, "fii_net")
        assert_numeric_and_finite(all_seg, "fii_net_all_segments")
        assert_numeric_and_finite(deriv, "fii_derivatives")
        assert dii_net is None, "historical rows must leave the DII aggregate NULL (MF != DII)"
        assert_numeric_and_finite(mf_total, "mf_total")

        # The precise invariant: in the historical era the stored fii_net must be the
        # cash-equity component, so all_seg - fii_net has to equal debt + derivatives. If the
        # mapping ever collapses back to reading raw fii_net, this difference goes to zero
        # while derivatives are non-zero. (Note magnitude is NOT a valid check here --
        # segments routinely have opposite signs, so cash equity can exceed the segment sum.)
        stored_debt = con.execute(
            "SELECT fii_debt FROM fii_dii_flow WHERE fii_net=? AND fii_derivatives=?",
            (fii_net, deriv),
        ).fetchone()[0]
        assert stored_debt is not None
        assert all_seg - fii_net == pytest.approx(stored_debt + deriv, abs=0.5), (
            "stored fii_net is not the cash-equity component of the all-segment figure -- "
            "check parse_row()'s era mapping"
        )

    def test_latest_row_is_reasonably_fresh(self):
        """§1.4 of the endpoint audit: a 200 with stale data is the failure mode a status-code
        check cannot see. The NSE insider endpoint was silently frozen 3 months back."""
        import datetime
        rows = fdh.parse_all(fdh.fetch())
        newest = max(r["date"] for r in rows)
        age = (datetime.date.today() - datetime.date.fromisoformat(newest)).days
        assert age <= 10, f"newest row is {age} days old ({newest}) -- source may be frozen"
