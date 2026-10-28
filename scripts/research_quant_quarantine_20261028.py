"""Read-only 2026-10-28 same-snapshot impact study, not a profitability backtest.

The baseline is the fixed pre-audit commit f43eed9e. A full Git history containing it is
required; later source-data corrections can change results. Histories truncated before
253 real sessions are excluded from both versions, never silently treated as complete.
"""
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src' / 'server'))
from db_compat import database_url
from institutional_quant_engine import InstitutionalQuantEngine, _without_closed_sessions
from risk_free_rate import get_risk_free_annual
import institutional_quant_engine as current

old_source = subprocess.check_output(
    ['git', 'show', 'f43eed9e:src/server/institutional_quant_engine.py'],
    cwd=ROOT, text=True, encoding='utf-8',
)
old = {'__name__': 'quant_baseline_snapshot', '__file__': str(ROOT / 'src/server/institutional_quant_engine.py')}
exec(compile(old_source, old['__file__'], 'exec'), old)
engine = create_engine(database_url(), poolclass=NullPool, connect_args={
    'options': '-c default_transaction_read_only=on -c statement_timeout=90000',
})
started = time.monotonic()
with engine.connect() as connection:
    rate = get_risk_free_annual(lambda sql: connection.execute(text(sql)).fetchone())
    print('Reading production OHLC snapshot with a read-only transaction...', flush=True)
    panel = pd.read_sql_query(text('''
        SELECT s.symbol, b.date, b.close, b.volume, b.is_suspect, b.suspect_reason
        FROM (SELECT DISTINCT symbol FROM stock_ohlcv) s
        CROSS JOIN LATERAL (
          SELECT date, close, volume, is_suspect, suspect_reason FROM stock_ohlcv
          WHERE symbol = s.symbol ORDER BY date DESC LIMIT 280
        ) b
    '''), connection)
engine.dispose()
old['get_risk_free_annual'] = lambda: rate
current.get_risk_free_annual = lambda: rate
print('Rows:', len(panel), 'symbols:', panel.symbol.nunique(), 'read seconds:', round(time.monotonic()-started, 1), flush=True)

# 280 rows must contain the latest 253 real sessions. Symbols for which the cutoff
# could truncate that window are withheld from BOTH runs and counted separately.
raw_counts = panel.groupby('symbol').size()
real = _without_closed_sessions(panel)
real_counts = real.groupby('symbol').size()
incomplete = raw_counts[(raw_counts == 280) & (real_counts.reindex(raw_counts.index, fill_value=0) < 253)].index
panel = panel[~panel.symbol.isin(incomplete)]
raw_counts = panel.groupby('symbol').size()
old_input = panel[panel.symbol.isin(raw_counts[raw_counts >= 63].index)]
new_input = _without_closed_sessions(panel)
new_counts = new_input.groupby('symbol').size()
new_input = new_input[new_input.symbol.isin(new_counts[new_counts >= 63].index)]
with np.errstate(all='ignore'):
    before = old['InstitutionalQuantEngine'].__new__(old['InstitutionalQuantEngine']).compute_momentum_features(old_input)
    after = InstitutionalQuantEngine.__new__(InstitutionalQuantEngine).compute_momentum_features(new_input)

def ranks(frame):
    result = frame.set_index('symbol').copy()
    pct = lambda values: values.rank(pct=True, na_option='keep') * 100
    result['momentum'] = sum(pct(result[column].fillna(0)) * weight for column, weight in [
        ('return_1m', .25), ('return_3m', .35), ('return_6m', .40)])
    result['quality'] = (result['momentum'].fillna(50) * .40
        + (100 - pct(result['annualized_vol'])).fillna(50) * .30
        + pct(result['sharpe_ratio']).fillna(50) * .30)
    return result

before, after = ranks(before), ranks(after)
joined = before.join(after, how='inner', lsuffix='_old', rsuffix='_new')
print('Both histories:', len(joined), 'old only:', len(before.index.difference(after.index)),
      'new only:', len(after.index.difference(before.index)), 'cutoff-ambiguous:', len(incomplete))
for field in ('momentum', 'quality'):
    delta = (joined[f'{field}_new'] - joined[f'{field}_old']).abs().dropna()
    old_top = set(before.nlargest(50, field).index)
    new_top = set(after.nlargest(50, field).index)
    print(field, 'absolute change median/p95/max:', *(round(float(x), 4) for x in [delta.median(), delta.quantile(.95), delta.max()]),
          'top-50 overlap:', len(old_top & new_top))
print('OBSERVATIONAL SNAPSHOT ONLY: ignores valuation/confluence and does not test returns or costs.')
