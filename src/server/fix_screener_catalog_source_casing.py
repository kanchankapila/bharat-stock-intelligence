"""Harmonize screener_catalog.signal_bias across rows that describe the IDENTICAL screener
under different (screener_id, source) identities.

WHY (2026-08-13)
-----------------
screener_catalog's PK is (screener_id, source). Three independent writers
(screener_catalog_enricher.py, trendlyne_screener_discovery.py, unified_ranker.py's CSV
loader) each derive screener_id and source slightly differently for the SAME real screener --
e.g. 'All Stars: High Scorers Across Metrics' exists as
  ('all-stars-high-scorers-across-metrics', 'trendlyne', ..., bullish)
  ('all-stars:-high-scorers-across-metrics', 'Trendlyne', ..., bearish)
one slugifier strips punctuation, the other keeps it, and the source casing differs too. This
is NOT a simple case-collision merge (checked: 0 screener_ids share >1 source casing -- the
IDs themselves differ), so the two rows never collide on the PK and both survive independently
forever. 212 of 865 screener_names with >1 catalog row (1,707 of 2,539 rows total belong to a
multi-row screener_name) disagree on signal_bias.

Consequence: unified_ranker.py's _get_screener_membership() joins by screener_id, so whichever
of the two IDs a given stock's `trendlyne_screener_stocks` row happens to carry decides which
of the two conflicting labels that stock gets for the SAME real screener -- silently and
non-deterministically, since which producer last wrote that stock's membership row is not
something any consumer can see. Two stocks genuinely flagged by the identical screener can
carry opposite sentiment with no visible reason.

FIX: harmonize signal_bias across every row sharing an exact screener_name (no screener_id
merge, no deletes -- lower-risk, and every membership row keeps resolving to a row that now
agrees with all its siblings regardless of which screener_id it references). Resolution order:
  1. NLPScreenerInference.domain_override(name) -- authoritative, fixed this session -- wins
     outright if it has an opinion.
  2. If exactly one existing variant is non-neutral, keep that one (matches
     screener_catalog_enricher.py's own "could not tell = neutral, not a guess" philosophy).
  3. Otherwise neutral (abstain).

USAGE
    python fix_screener_catalog_source_casing.py --dry-run     # report only, writes nothing
    python fix_screener_catalog_source_casing.py --apply
"""
from __future__ import annotations

import polars as pl
import argparse
from collections import defaultdict

from db_compat import connect
from nlp_engine import NLPScreenerInference as NLP


def _resolve_bias(name: str, biases: set) -> str:
    override = NLP.domain_override((name or '').lower())
    if override is not None:
        return override
    non_neutral = {b for b in biases if b and b != 'neutral'}
    if len(non_neutral) == 1:
        return non_neutral.pop()
    return 'neutral'


def plan(rows):
    """rows: [(screener_id, source, screener_name, signal_bias), ...].
    Returns [(screener_name, resolved_bias, [(screener_id, source, old_bias), ...])] for
    groups whose current biases disagree."""
    by_name = defaultdict(list)
    for sid, src, name, bias in rows:
        by_name[name].append((sid, src, bias))

    out = []
    for name, group in by_name.items():
        biases = {b for _, _, b in group}
        if len(biases) <= 1:
            continue
        resolved = _resolve_bias(name, biases)
        changed = [(sid, src, b) for sid, src, b in group if b != resolved]
        if changed:
            out.append((name, resolved, changed))
    return out


def run(apply: bool) -> dict:
    con = connect()
    rows = con.execute(
        "SELECT screener_id, source, screener_name, signal_bias FROM screener_catalog"
    ).fetchall()
    rows = [(r['screener_id'], r['source'], r['screener_name'], r['signal_bias']) for r in rows]
    print(f"[FixScreenerBias] {len(rows):,} screener_catalog rows loaded")

    groups = plan(rows)
    n_rows_changed = sum(len(changed) for _, _, changed in groups)
    print(f"[FixScreenerBias] {len(groups):,} screener_names with disagreeing bias -> "
          f"{n_rows_changed:,} rows would change")

    for name, resolved, changed in groups[:12]:
        old = sorted({b for _, _, b in changed})
        print(f"    {str(name)[:60]:62s} {old} -> {resolved}  ({len(changed)} row(s))")

    if not apply:
        print("\nDRY RUN -- nothing written. Re-run with --apply.")
        return {'groups': len(groups), 'rows_changed': n_rows_changed}

    for name, resolved, changed in groups:
        for sid, src, _old in changed:
            con.execute(
                "UPDATE screener_catalog SET signal_bias = ? WHERE screener_id = ? AND source = ?",
                (resolved, sid, src),
            )
    con.commit()
    print(f"\nAPPLIED: {n_rows_changed:,} rows updated across {len(groups):,} screener_names")
    return {'groups': len(groups), 'rows_changed': n_rows_changed}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--dry-run', action='store_true')
    g.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    run(apply=a.apply)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
