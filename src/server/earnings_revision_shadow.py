"""Point-in-time consensus research from immutable observations; never writes trading scores."""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
import math

KEY = 'earnings_revision_shadow'


def _number(value):
    try:
        value = float(value)
    except (ValueError, TypeError):
        return None
    return value if math.isfinite(value) else None


def _time(value):
    value = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('observed_at must include its timezone')
    return value.astimezone(timezone.utc)


def build_shadow(rows, as_of: datetime, lookback_days: int = 30) -> dict:
    as_of = _time(as_of)
    if lookback_days < 1:
        raise ValueError('lookback_days must be positive')
    cutoff = as_of - timedelta(days=lookback_days)
    groups = defaultdict(list)
    for row in rows:
        observed = _time(row['observed_at'])
        if observed > as_of:
            continue
        payload = row['values_json']
        period, metric = payload.get('date'), payload.get('metric_type')
        if not period or metric not in ('eps', 'netProfit', 'revenue'):
            continue
        groups[(row['symbol'], period, metric)].append((observed, payload))

    revisions, surprises, missing = [], [], 0
    for (symbol, period, metric), events in sorted(groups.items()):
        events.sort(key=lambda event: event[0])
        actual_events = [(t, p) for t, p in events if _number(p.get('actual')) is not None]
        identity = {'symbol': symbol, 'period': period, 'metric': metric}
        if actual_events:
            actual_time, actual_payload = actual_events[0]
            forecasts = [(t, p) for t, p in events
                         if t < actual_time and p.get('actual') is None and _number(p.get('avg')) is not None]
            if not forecasts or not (estimate := _number(forecasts[-1][1].get('avg'))):
                missing += 1
                continue
            actual = _number(actual_payload['actual'])
            surprises.append({**identity, 'estimate': estimate, 'actual': actual,
                              'surprise_pct': 100 * (actual - estimate) / abs(estimate),
                              'estimate_observed_at': forecasts[-1][0].isoformat(),
                              'actual_first_observed_at': actual_time.isoformat()})
            continue

        forecasts = [(t, p) for t, p in events if _number(p.get('avg')) is not None]
        prior = [(t, p) for t, p in forecasts if t <= cutoff]
        if not prior or not forecasts:
            continue
        latest_time, latest = forecasts[-1]
        previous_time, previous = prior[-1]
        old, new = _number(previous.get('avg')), _number(latest.get('avg'))
        if not old or latest_time <= cutoff or latest_time <= previous_time:
            continue
        high, low = _number(latest.get('high')), _number(latest.get('low'))
        revisions.append({**identity, 'revision_pct': 100 * (new - old) / abs(old),
                          'range_dispersion_pct': 100 * (high - low) / abs(new)
                          if new and high is not None and low is not None and high >= low else None,
                          'prior_observed_at': previous_time.isoformat(),
                          'latest_observed_at': latest_time.isoformat()})
    return {'state': 'RESEARCH_ONLY', 'generated_at': as_of.isoformat(), 'lookback_days': lookback_days,
            'covered_symbol_period_metrics': len(groups), 'revisions': revisions, 'surprises': surprises,
            'missing_preannouncement_estimate': missing,
            'evidence': 'Observed revisions and surprises only; no forward-return or profitability verdict',
            'dispersion_definition': 'High-minus-low consensus range divided by absolute mean; not a standard deviation'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--persist', action='store_true')
    parser.add_argument('--lookback-days', type=int, default=30)
    args = parser.parse_args()
    from db_compat import connect
    conn = connect()
    try:
        conn.execute("SET LOCAL statement_timeout = '60s'")
        as_of = datetime.now(timezone.utc)
        rows = conn.execute(
            "SELECT symbol, observed_at, values_json FROM fundamental_observations "
            "WHERE source_table = 'mc_earnings_forecast' AND observed_at <= ? "
            "ORDER BY observed_at, observation_id", (as_of.isoformat(),),
        ).fetchall()
        report = build_shadow(rows, as_of, args.lookback_days)
        if args.persist:
            conn.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                         'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                         (KEY, json.dumps(report, allow_nan=False)))
            conn.commit()
        print(json.dumps(report, allow_nan=False))
    finally:
        conn.close()


if __name__ == '__main__':
    main()
