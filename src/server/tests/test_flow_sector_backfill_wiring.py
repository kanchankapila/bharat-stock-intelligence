"""Regression tests for the 2026-08-25 data-pipeline wiring fixes.

1. backfill_technical_features._flow_nets — the market-wide flow columns
   (fii_3d_net / fii_10d_net / dii_3d_net) lost their only bulk producer when
   densify_feature_matrix's NEVER_FILL absorbed them (5a97df3) while the grid-ensurer
   still inserted explicit NULLs. Measured live 2026-08-24: fii_3d_net went from ~1,642
   rows/day to 309; sector_ret_5d/21d to 0.

2. delivery_volume_fetcher.backfill_technical_signals must heal BOTH the sourced session
   and the prior one: NSE publishes the MTO file late, so a 15:30 scan can write that
   day's grid rows before any delivery data exists (deliveryFetcher.ts returns an empty
   map silently). Measured live 2026-08-24: delivery_pct was 0/2,198 rows on Monday's
   grid although Friday's MTO had been fetched successfully the previous evening.

3. mc_index_oi_fetcher must not upsert a STALE MC block onto its own date key: MC serves
   T-1 OI through much of day T, and backdating those rows overwrote the row
   nt_oi_snapshot_fetcher had already written for the same PK while the current session
   got nothing. Measured live: index_option_oi froze at 2026-08-21 across three
   "successful" runs.
"""
import os
import re
import sys

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

from backfill_technical_features import _flow_nets  # noqa: E402

MCOI_SRC = open(os.path.join(SERVER_DIR, "mc_index_oi_fetcher.py"), encoding="utf-8").read()
DELIV_SRC = open(os.path.join(SERVER_DIR, "delivery_volume_fetcher.py"), encoding="utf-8").read()


# ── 1. _flow_nets semantics ──────────────────────────────────────────────────

def test_flow_nets_excludes_the_grid_date_itself():
    """A value stamped on date T must be built from sessions < T only. Including T would
    stamp T's own (post-close) figure onto T's row -- the same look-ahead the trainer's
    FII_LAG_DAYS=1 exists to prevent."""
    days = {f"2026-08-{d:02d}": (float(d), float(-d)) for d in range(10, 21)}
    f3, _, _ = _flow_nets(days, "2026-08-20")
    assert f3 == 17.0 + 18.0 + 19.0


def test_flow_nets_windows_and_null_sessions():
    """NULL sessions are skipped, not treated as zero; 3d/10d windows end at T-1."""
    days = {f"2026-07-{d:02d}": (1.0, 2.0) for d in range(1, 29)}
    days["2026-07-20"] = (None, None)  # a holiday with no published figures
    f3, f10, d3 = _flow_nets(days, "2026-07-25")
    assert f3 == 3.0                      # 22,23,24
    assert f10 == 9.0                     # 15..19 + 21..24 minus the NULL day = 9 sessions
    assert d3 == 6.0


def test_flow_nets_none_below_three_published_sessions():
    assert _flow_nets({"2026-08-01": (5.0, 5.0), "2026-08-04": (5.0, 5.0)}, "2026-08-05") \
        == (None, None, None)


# ── 2. delivery heal covers the prior session too ────────────────────────────

def test_delivery_backfill_updates_more_than_one_session_and_only_null_rows():
    assert "LIMIT 2" in DELIV_SRC, (
        "backfill_technical_signals must consider more than just today's session")
    assert "IS NULL" in DELIV_SRC, (
        "the heal must fill missing values only -- it must never overwrite the richer "
        "value an earlier intraday write already placed on the row")


# ── 3. stale MC block is skipped, not backdated ─────────────────────────────

def test_mc_index_oi_rejects_stale_block_before_writing():
    m = re.search(r"oi_date = max\(mc_results\.keys\(\), default=date\).*?return 0",
                  MCOI_SRC, re.S)
    assert m, "the stale-block guard after the oi_date derivation is gone"
    block = m.group(0)
    # The skip must come BEFORE any INSERT into index_option_oi in this function.
    insert_at = MCOI_SRC.find("INSERT INTO index_option_oi")
    guard_at = MCOI_SRC.find("if oi_date < date:")
    assert 0 < guard_at < insert_at, "stale-block guard must run before the index_option_oi upsert"
    assert "skipping" in block or "skip" in block
