"""Reclassify NEUTRAL screener sentiments from their names.

WRITES TO PRODUCTION -- `--apply` is required, exactly like the sibling
`src/server/reclassify_screener_sentiment.py`. This script previously wrote and committed
unconditionally the moment `apply_reclassification()` was called, with no dry-run and no
flag; `screener_master.inferred_sentiment` is read by `unified_ranker.py`, so that made an
unreviewed import a silent signal-surface change (docs/audit-findings.md AF-20260829-12).

Note before re-running this: `.claude/rules/measurement.md` records that the screener engine
is measured ACTIVELY HARMFUL (four independent confirmations) and that its sentiment labels
are measured INVERTED. Relabelling is a scoring change and needs measurement FIRST -- a
factor_edge.py / factor_backtest.py read on `inferred_sentiment` before vs. after.

Run:  python scripts/reclassify_screener_sentiments_all.py --dry-run   # report only
      python scripts/reclassify_screener_sentiments_all.py --apply     # write
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), 'src', 'server'))
from db_compat import connect

# Canonical implementation lives in src/server/screener_catalog_enricher.py and is
# imported, NOT re-copied here. This file previously carried a hand-duplicated copy of
# the same keyword lists; verified 2026-08-29 that the two agreed on all 1,637 distinct
# live screener names, so this import is behaviour-preserving. Keeping two copies is the
# recurring-bugs.md multi-writer class that produced 67% same-name-different-value
# duplicates in screener_catalog -- whichever writer runs last silently wins.
from screener_catalog_enricher import classify_screener  # noqa: E402

def apply_reclassification(apply: bool = False):
    conn = connect()

    # 1. Update screener_catalog
    cat_rows = conn.execute('''
        SELECT screener_id, source, screener_name, signal_bias 
        FROM screener_catalog 
        WHERE LOWER(signal_bias) = 'neutral'
    ''').fetchall()

    cat_updated = 0
    for r in cat_rows:
        sid, src, name, old_bias = r['screener_id'], r['source'], r['screener_name'], r['signal_bias']
        new_bias = classify_screener(name)
        if new_bias:
            if apply:
                conn.execute(
                    "UPDATE screener_catalog SET signal_bias = ? WHERE screener_id = ? AND LOWER(source) = LOWER(?)",
                    (new_bias, sid, src)
                )
            cat_updated += 1

    # 2. Update screener_master
    master_rows = conn.execute('''
        SELECT scan_id, source, name, inferred_sentiment 
        FROM screener_master 
        WHERE LOWER(inferred_sentiment) = 'neutral' OR inferred_sentiment IS NULL
    ''').fetchall()

    master_updated = 0
    for r in master_rows:
        sid, src, name, old_sent = r['scan_id'], r['source'], r['name'], r['inferred_sentiment']
        new_sent = classify_screener(name)
        if new_sent:
            if apply:
                conn.execute(
                    "UPDATE screener_master SET inferred_sentiment = ? WHERE scan_id = ? AND LOWER(source) = LOWER(?)",
                    (new_sent, sid, src)
                )
            master_updated += 1

    if apply:
        conn.commit()
        print("APPLIED. Reclassified DB screeners:")
    else:
        conn.rollback()
        print("DRY RUN -- nothing written. Re-run with --apply. Would have changed:")
    print(f"   - screener_catalog rows : {cat_updated}")
    print(f"   - screener_master  rows : {master_updated}")
    return {"screener_catalog": cat_updated, "screener_master": master_updated, "applied": apply}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--dry-run', action='store_true')
    g.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    apply_reclassification(apply=a.apply)
