"""Read-only, paired diagnostics for a semantic repair on timestamped memberships.

The capture omits long-running memberships (AF-20261106-04). Results are invalid as
policy evidence until that substrate is repaired and independently verified. Template
names also use current metadata, not reconstructed historical vendor queries.
"""
import argparse
from collections import Counter, defaultdict
from datetime import timedelta
import json
import hashlib
from pathlib import Path
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/server'))
from db_compat import connect
from screener_semantics import analyze_screener, deduplicate_membership
import unified_ranker as ranker

POLICY_PATH = Path(__file__).resolve().parents[1] / 'src/server/config/screenerSemantics.json'


def stats(values):
    a = np.array(values, dtype=float)
    a = a[np.isfinite(a)]
    return {'dates': len(a), 'mean': float(a.mean()) if len(a) else None,
            't': float(a.mean() / (a.std(ddof=1) / np.sqrt(len(a)))) if len(a) > 1 and a.std() > 0 else None}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--manifest', required=True, type=Path)
    ap.add_argument('--report', required=True, type=Path)
    args = ap.parse_args()
    if args.report.exists():
        raise RuntimeError('Replay artifacts are immutable; choose a new output path.')
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    if manifest.get('policy_sha256') != hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest():
        raise RuntimeError('Policy differs from the frozen manifest; refusing to grade it.')
    meta = {}
    for row in manifest['decisions']:
        if row['table'] == 'screener_catalog':
            meta[(row['source'].lower(), row['id'])] = row
    con = connect()
    con.execute('SET TRANSACTION READ ONLY')
    con.execute("SET LOCAL lock_timeout = '5s'")
    con.execute("SET LOCAL statement_timeout = '60s'")
    try:
        catalog = {(r['source'].lower(), r['screener_id']): dict(r) for r in con.execute(
            'SELECT screener_id,source,category,subcategory,investment_horizon,confidence FROM screener_catalog').fetchall()}
        runs = con.execute('SELECT DISTINCT ON (as_of_date) as_of_date,captured_at,memberships '
                           'FROM screener_membership_runs ORDER BY as_of_date,captured_at DESC').fetchall()
        start = str(runs[0]['as_of_date']) if runs else '2026-11-05'
        price_rows = con.execute('SELECT symbol,date,open,close,volume FROM stock_ohlcv '
                                 'WHERE date >= ? AND COALESCE(is_suspect,0)=0 AND open>0 AND close>0',
                                 (str(pd.Timestamp(start).date() - timedelta(days=60)),)).fetchall()
        px = pd.DataFrame([dict(r) for r in price_rows]).sort_values(['symbol', 'date'])
        px['date'] = pd.to_datetime(px['date']).dt.date
        px['adt'] = (px['close'] * px['volume']).groupby(px['symbol']).transform(
            lambda x: x.rolling(20, min_periods=20).mean()) / 1e7
        sessions = sorted(px['date'].unique())
        indexed = px.set_index(['symbol', 'date'])
        daily = []
        for run in runs:
            d = pd.Timestamp(run['as_of_date']).date()
            future = [s for s in sessions if pd.Timestamp(s, tz='Asia/Kolkata') + pd.Timedelta(hours=9, minutes=15) > run['captured_at']]
            if not future:
                continue
            entry = future[0]
            old, new = defaultdict(list), defaultdict(list)
            for symbol, source, sid in run['memberships']:
                key = (source.lower(), str(sid))
                if key not in meta or key not in catalog:
                    continue
                template = meta[key]
                record = {**catalog[key], 'source': source, 'screener_id': str(sid), 'screener_name': template['name']}
                old[symbol].append({**record, 'signal_bias': template['bias']})
                new[symbol].append({**record, 'signal_bias': analyze_screener(template['name'], source, str(sid))['semantic_bias']})
            baseline, _, _ = ranker.compute_screener_stock_scores(old, {},
                bias_sign={'bullish': 1.0, 'bearish': -1.0, 'neutral': 0.3})
            candidate, _, _ = ranker.compute_screener_stock_scores(deduplicate_membership(new), {},
                bias_sign={'bullish': 1.0, 'bearish': -1.0, 'neutral': 0.0})
            adt = px[px['date'] <= d].groupby('symbol').last()['adt'].to_dict()
            outcomes = {}
            for symbol in baseline.keys() & candidate.keys():
                if adt.get(symbol, 0) < 1 or (symbol, entry) not in indexed.index:
                    continue
                bar = indexed.loc[(symbol, entry)]
                ret = (bar['close'] / bar['open'] - 1) * 100
                if np.isfinite(ret) and abs(ret) <= 40:
                    outcomes[symbol] = ret
            if len(outcomes) < 50:
                continue
            panel = pd.DataFrame({'return': outcomes, 'before': baseline, 'after': candidate}).dropna()
            benchmark = panel['return'].mean()
            record = {'decision_date': str(d), 'entry_date': str(entry), 'symbols': len(panel),
                      'zero_control': float((panel['return'] - benchmark).mean()),
                      'before_distinct': int(panel['before'].nunique()), 'after_distinct': int(panel['after'].nunique()),
                      'memberships_before': sum(map(len, old.values())),
                      'memberships_after': sum(map(len, deduplicate_membership(new).values()))}
            for label in ('before', 'after'):
                record[label + '_ic'] = float(panel[label].corr(panel['return'], method='spearman'))
                record[label + '_top50_net_excess_pct'] = float(panel.nlargest(50, label)['return'].mean() - benchmark - 0.32)
            daily.append(record)
        report = {'verdict': 'INVALID-CAPTURE (AF-20261106-04); no promotion',
                  'capture_completeness': 'known_incomplete',
                  'manifest_sha256': hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
                  'captured_dates': len(runs), 'graded_dates': len(daily),
                  'caveat': 'The source capture retains only recently entered memberships and omits long-running episodes; current template metadata adds hindsight. Diagnostic subset only, not policy evidence.',
                  'daily': daily,
                  'paired_ic_delta': stats([r['after_ic'] - r['before_ic'] for r in daily]),
                  'paired_net_delta_pct': stats([r['after_top50_net_excess_pct'] - r['before_top50_net_excess_pct'] for r in daily])}
        args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        print(json.dumps(report, indent=2, allow_nan=False))
    finally:
        con.rollback()
        con.close()


if __name__ == '__main__':
    main()
