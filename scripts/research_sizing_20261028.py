"""Exploratory read-only comparison of stored position sizes against equal weights.

Uses the published calls and clean production prices with exact market-session entry and
exit opens. It does not replay the breakout leg or attribute a causal sizing benefit.
The date ranges are fixed for the 2026-10-28 audit; the source database is not frozen,
so later data corrections or newly available exits can change a rerun. This is research,
not a promotion gate. Missing entry or exit opens are excluded and may bias results.
The connection enforces read-only transactions.
"""
import sys
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'server'))
from db_compat import ConnWrapper, database_url
import forward_test_report as F

url = database_url()
target = urlsplit(url)
print(f'read-only target: {target.hostname}:{target.port}/{target.path.lstrip("/")}')
engine = create_engine(url, poolclass=NullPool,
                       connect_args={'options': '-c default_transaction_read_only=on -c statement_timeout=90000'})
conn = ConnWrapper(engine.connect())
try:
    sessions = F.load_sessions(conn)
    rows = conn.execute(
        "SELECT symbol, generated_at, unified_score, classification, position_size_pct AS size, breakout_score AS breakout "
        "FROM unified_recommendations_history WHERE generated_at >= ? AND unified_score IS NOT NULL",
        ('2026-08-03',),
    ).fetchall()
    calls = pd.DataFrame(rows, columns=['symbol', 'generated_at', 'unified_score', 'classification', 'size', 'breakout'])
    calls['generated_at'] = pd.to_datetime(calls['generated_at'], utc=True).dt.tz_convert('Asia/Kolkata')
    for c in ('unified_score', 'size', 'breakout'):
        calls[c] = pd.to_numeric(calls[c], errors='coerce')
    calls = F.apply_protocol_start(F.latest_call_per_session(calls, sessions), '2026-08-10')
    print('calls', len(calls), 'sessions', calls.session.nunique(), 'sized buys',
          int((calls.classification.isin(['Buy', 'Strong Buy']) & (calls['size'] > 0)).sum()))
    rows = conn.execute(
        "SELECT symbol, date, open, close, volume FROM stock_ohlcv WHERE date >= ? "
        "AND (is_suspect IS NULL OR is_suspect = 0) AND open > 0 AND close > 0",
        ('2026-06-01',),
    ).fetchall()
    prices = pd.DataFrame(rows, columns=['symbol', 'date', 'open', 'close', 'volume'])
    prices['date'] = pd.to_datetime(prices['date'])
    for c in ('open', 'close', 'volume'):
        prices[c] = pd.to_numeric(prices[c], errors='coerce')
    idx = sessions[sessions >= prices['date'].min()]
    opens = prices.pivot_table(index='date', columns='symbol', values='open', aggfunc='last').reindex(idx)
    traded = prices.assign(value=prices.close * prices.volume).pivot_table(
        index='date', columns='symbol', values='value', aggfunc='last').reindex(idx)
    # Use the prior completed session even for calls generated before today's close.
    adt = traded.rolling(20, min_periods=15).mean().shift(1)
    opens.index.name = adt.index.name = 'session'
    opens.columns.name = adt.columns.name = 'symbol'
    # Exact next-session and fifth-session opens; missing opens stay missing.
    fwd = (opens.shift(-6) / opens.shift(-1) - 1).stack().rename('fwd')
    vol = adt.stack().rename('adt')
    available = pd.concat([fwd, vol], axis=1).reset_index()
    print('price rows', len(prices), 'available rows', len(available), 'opening dates', len(opens),
          'forward nonnull', int(available.fwd.notna().sum()), 'ADT nonnull', int(available.adt.notna().sum()))
    panel = calls.merge(available, on=['session', 'symbol'], how='inner')
    print('matched rows before liquidity', len(panel))
    panel = panel[(panel.adt >= 10_000_000) & np.isfinite(panel.fwd)]
    print('eligible rows', len(panel), 'sized buys',
          int((panel.classification.isin(['Buy', 'Strong Buy']) & (panel['size'] > 0)).sum()))
    panel['fwd'] = panel.groupby('session')['fwd'].transform(F._winsorise)
    records = []
    for d, g in panel.groupby('session'):
        s = g[g.classification.isin(['Buy', 'Strong Buy']) & (g['size'] > 0)].copy()
        if len(s) < 3:
            continue
        weights = s['size'].to_numpy(dtype=float, copy=True)
        weights /= weights.sum()
        weighted = float(np.dot(weights, s.fwd))
        equal = float(s.fwd.mean())
        records.append((d, len(s), weighted, equal, float(g.fwd.mean())))
    out = pd.DataFrame(records, columns=['session', 'names', 'weighted', 'equal', 'universe'])
    for label, start, end in [('historical before breakout-weight change', '2026-08-10', '2026-10-25'),
                              ('post change', '2026-10-26', '2026-10-28')]:
        v = out[(out.session >= start) & (out.session <= end)].sort_values('session') if not out.empty else out
        chosen, last_i = [], -999
        for _, row in v.iterrows():
            i = sessions.searchsorted(row.session)
            if i - last_i >= 5:
                chosen.append(row)
                last_i = i
        nonoverlap = pd.DataFrame(chosen)
        print(label, 'dates=', len(v), 'nonoverlap=', len(nonoverlap))
        if len(v):
            print('mean names=', round(v.names.mean(), 2),
                  'weighted minus same-name equal pp=', round(100 * (v.weighted - v.equal).mean(), 4),
                  'weighted minus universe after 32bps pp=', round(100 * (v.weighted - v.universe - .0032).mean(), 4),
                  'equal minus universe after 32bps pp=', round(100 * (v.equal - v.universe - .0032).mean(), 4))
        if len(nonoverlap):
            delta = nonoverlap.weighted - nonoverlap.equal
            print('nonoverlap weighted minus equal pp=', round(100 * delta.mean(), 4),
                  'first half pp=', round(100 * delta.iloc[:max(1, len(delta)//2)].mean(), 4),
                  'second half pp=', round(100 * delta.iloc[max(1, len(delta)//2):].mean(), 4) if len(delta) > 1 else None)
    print('LOW-DATA / exploratory: missing opens excluded, repeated 5-session resets, fixed cost, no fills or actual turnover; '
          'not a causal breakout or cost-penalty ablation.')
finally:
    conn.rollback()
    conn.close()
    engine.dispose()
