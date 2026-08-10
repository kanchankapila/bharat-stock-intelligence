"""Reconcile screener sentiment across screener_master and screener_catalog.

WHY (2026-08-10)
----------------
Two independently-built taxonomies label the same screeners and disagree on 391 of the 1,669
they share -- including 103 outright SIGN FLIPS. Measured on the live tables:

    screener_master.inferred_sentiment  667 neutral / 577 bullish / 425 bearish
    screener_catalog.signal_bias        560 neutral / 1,297 bullish / 679 bearish

Both are wrong in different, systematic ways, and neither is authoritative:

  * screener_catalog got "Crossed Below SMA-20", "MACD Crossed below Signal", "Hourly Losers"
    and "Below SMA-50" as BULLISH -- its enricher matched no bearish keyword and then fell
    through to a catch-all `else: bias = 'bullish'` (fixed at source in
    screener_catalog_enricher.py, same session).
  * screener_master got "High Leverage" as neutral, "Increasing Promoter Pledge" as bullish
    and "Low Price to Book" as neutral -- the generic keyword lists read high/low/increasing
    literally, and those words invert meaning depending on what they qualify.

This script does NOT rebuild either table from scratch. It applies
NLPScreenerInference.domain_override() -- a pure function covering exactly the families
established to be mislabelled -- and writes only where that function has an opinion AND the
stored value differs. Everything it has no opinion about is left untouched, so a hand
correction someone made for a good reason survives.

Four of those families were settled by MEASUREMENT rather than by reading the screener's
name (see domain_override's own comment for the 5-year backtest numbers): oversold, near
52-week low and below-lower-Bollinger are all reliably BEARISH (t=-3.8 to -4.7, negative in
6 of 6 years), while overbought carries no signal at all. Two more (bare dividend yield,
scheduled-event screeners) are set to neutral on reasoning, NOT measurement, because the data
to test them does not exist here -- that distinction is deliberate and is repeated in the
report this prints.

USAGE
    python reclassify_screener_sentiment.py --dry-run     # report only, writes nothing
    python reclassify_screener_sentiment.py --apply
"""
from __future__ import annotations

import argparse
from collections import Counter

from db_compat import connect
from nlp_engine import NLPScreenerInference as NLP

TABLES = (
    # (table, id_col, name_col, sentiment_col)
    ('screener_master', 'scan_id', 'name', 'inferred_sentiment'),
    ('screener_catalog', 'screener_id', 'screener_name', 'signal_bias'),
)


def plan_changes(rows, name_col, sent_col):
    """Pure: given rows, return [(id, source, name, old, new)] for rows needing a change."""
    out = []
    for r in rows:
        name = r[name_col]
        if not name:
            continue
        new = NLP.domain_override(str(name).lower())
        if new is None:
            continue                      # no opinion -> leave whatever is there alone
        old = r[sent_col]
        if old == new:
            continue
        out.append((r['_id'], r['_source'], name, old, new))
    return out


def run(apply: bool) -> dict:
    con = connect()
    summary = {}
    for table, id_col, name_col, sent_col in TABLES:
        try:
            raw = con.execute(
                f"SELECT {id_col} AS _id, source AS _source, {name_col}, {sent_col} FROM {table}"
            ).fetchall()
        except Exception as e:                                   # noqa: BLE001
            print(f"[Reclassify] {table} unavailable ({str(e)[:80]}); skipped.")
            continue

        changes = plan_changes(raw, name_col, sent_col)
        moves = Counter(f"{old or 'NULL'} -> {new}" for _, _, _, old, new in changes)
        summary[table] = {'rows': len(raw), 'changes': len(changes), 'moves': dict(moves)}

        print(f"\n[{table}] {len(raw):,} rows | {len(changes):,} would change")
        for move, n in moves.most_common():
            print(f"    {n:6,d}  {move}")
        for _, src, name, old, new in changes[:8]:
            print(f"      e.g. [{src}] {str(name)[:60]:62s} {old} -> {new}")

        if apply and changes:
            for _id, src, _name, _old, new in changes:
                con.execute(
                    f"UPDATE {table} SET {sent_col} = ? "
                    f"WHERE {id_col} = ? AND LOWER(source) = LOWER(?)",
                    (new, _id, src),
                )
            con.commit()
            print(f"    APPLIED {len(changes):,} updates to {table}")

    if not apply:
        print("\nDRY RUN -- nothing written. Re-run with --apply.")
    return summary


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--dry-run', action='store_true')
    g.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    run(apply=a.apply)
