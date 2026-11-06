"""Provider outages must not look like a healthy analyst-snapshot job."""
import sys
from types import SimpleNamespace

import pytest
import requests

import analyst_estimates_snapshot as snapshot


def test_moneycontrol_204_is_valid_no_content(monkeypatch, capsys):
    class NoContent:
        status_code = 204
        def json(self):
            raise AssertionError('A 204 response must not be decoded as JSON')

    monkeypatch.setattr(snapshot, 'retry_get', lambda *args, **kwargs: NoContent())
    health = snapshot.SourceHealth()
    assert snapshot._mc_get('https://example.test', object(), health) is None
    assert health.mc_no_content == 1
    assert health.mc_errors == 0
    assert not health.degraded()
    assert capsys.readouterr().err == ''


def test_moneycontrol_204_is_quiet_without_a_tracker(monkeypatch, capsys):
    class NoContent:
        status_code = 204
        def json(self):
            raise AssertionError('A 204 response must not be decoded as JSON')
    monkeypatch.setattr(snapshot, 'retry_get', lambda *args, **kwargs: NoContent())
    assert snapshot._mc_get('https://example.test', object()) is None
    assert capsys.readouterr().err == ''


def test_no_content_endpoint_does_not_prevent_other_endpoints(monkeypatch):
    calls = []
    class Response:
        def __init__(self, status): self.status_code = status
        def json(self): return {'success': 1, 'data': {'mean': '123.0'}}
    def get(session, url, **kwargs):
        calls.append(url)
        return Response(200 if 'price-forecast' in url else 204)
    monkeypatch.setattr(snapshot, 'retry_get', get)
    health = snapshot.SourceHealth()
    result = snapshot._fetch_symbol('ABC', object(), health)
    assert result['target_mean'] == 123.0
    assert len(calls) == 3 and health.mc_no_content == 2 and health.mc_errors == 0


def test_malformed_200_is_still_an_error(monkeypatch):
    class BadJson:
        status_code = 200
        def json(self):
            raise ValueError('invalid JSON')

    monkeypatch.setattr(snapshot, 'retry_get', lambda *args, **kwargs: BadJson())
    health = snapshot.SourceHealth()
    assert snapshot._mc_get('https://example.test', object(), health) is None
    assert health.mc_errors == 1 and health.mc_no_content == 0


def test_moneycontrol_429_stops_new_requests(monkeypatch):
    calls = []
    response = requests.Response()
    response.status_code = 429
    def limited(*args, **kwargs):
        calls.append(kwargs['stop_statuses'])
        raise requests.HTTPError('429', response=response)
    monkeypatch.setattr(snapshot, 'retry_get', limited)
    health = snapshot.SourceHealth()
    snapshot._mc_get('https://example.test', object(), health)
    snapshot._mc_get('https://example.test', object(), health)
    assert calls == [{429}]
    assert health.degraded() and health.mc_limited


def test_yahoo_rate_limit_opens_breaker_but_moneycontrol_fallback_remains(monkeypatch):
    calls = []
    class Ticker:
        def __init__(self, symbol):
            calls.append(symbol)
        @property
        def info(self):
            raise RuntimeError('Too Many Requests. Rate limited. Try after a while.')
    monkeypatch.setitem(sys.modules, 'yfinance', SimpleNamespace(Ticker=Ticker))
    monkeypatch.setattr(snapshot, '_fetch_symbol', lambda code, session, health: {'target_mean': 123.0})
    health = snapshot.SourceHealth()
    assert snapshot._fetch_symbol_hybrid('AAA', 'AA', object(), health)['target_mean'] == 123.0
    assert snapshot._fetch_symbol_hybrid('BBB', 'BB', object(), health)['target_mean'] == 123.0
    assert calls == ['AAA.NS']
    assert health.degraded() and health.yahoo_limited


def _fake_yahoo(monkeypatch, info):
    calls = []
    class Ticker:
        def __init__(self, symbol):
            calls.append(symbol)
            self.info = info
    monkeypatch.setitem(sys.modules, 'yfinance', SimpleNamespace(Ticker=Ticker))
    monkeypatch.setattr(snapshot, '_YAHOO_MIN_INTERVAL_S', 0.0)
    return calls


def test_yahoo_only_fills_fields_moneycontrol_left_empty(monkeypatch):
    # 2026-11-07: Yahoo was asked for all ~2,300 symbols from 12 threads before MoneyControl and
    # rate-limited the run every night after ~7 calls, failing the job and losing ~200 EPS values
    # Yahoo does have. Yahoo is now a gap filler: it never overrides a MoneyControl value.
    calls = _fake_yahoo(monkeypatch, {'targetMeanPrice': 999.0, 'forwardEps': 12.5,
                                      'numberOfAnalystOpinions': 30})
    monkeypatch.setattr(snapshot, '_fetch_symbol', lambda code, session, health:
                        {'target_mean': 123.0, 'n_analysts': 9, 'buy_count': 5})
    result = snapshot._fetch_symbol_hybrid('AAA', 'AA', object(), snapshot.SourceHealth())
    assert calls == ['AAA.NS']
    assert result['target_mean'] == 123.0 and result['n_analysts'] == 9
    assert result['eps_est_next'] == 12.5


def test_yahoo_not_called_when_moneycontrol_is_complete_or_has_no_coverage(monkeypatch):
    calls = _fake_yahoo(monkeypatch, {'targetMeanPrice': 999.0})
    full = {'target_mean': 1.0, 'target_high': 2.0, 'target_low': 0.5, 'n_analysts': 3,
            'final_rating': 'BUY', 'eps_est_next': 4.0, 'buy_count': 2}
    monkeypatch.setattr(snapshot, '_fetch_symbol', lambda code, session, health: dict(full))
    snapshot._fetch_symbol_hybrid('FULL', 'FU', object(), snapshot.SourceHealth())
    monkeypatch.setattr(snapshot, '_fetch_symbol', lambda code, session, health: {})
    assert all(v is None for v in
               snapshot._fetch_symbol_hybrid('NONE', 'NO', object(), snapshot.SourceHealth()).values())
    assert calls == []


def test_yahoo_calls_are_spaced_across_threads(monkeypatch):
    clock = {'t': 100.0}
    sleeps = []
    monkeypatch.setattr(snapshot.time, 'monotonic', lambda: clock['t'])
    monkeypatch.setattr(snapshot.time, 'sleep', lambda s: (sleeps.append(s), clock.__setitem__('t', clock['t'] + s)))
    monkeypatch.setattr(snapshot, '_yahoo_last_call', [0.0])
    snapshot._yahoo_pace()
    snapshot._yahoo_pace()
    assert sleeps and abs(sleeps[0] - snapshot._YAHOO_MIN_INTERVAL_S) < 1e-9


def test_degraded_run_raises_after_retaining_successful_rows(monkeypatch):
    monkeypatch.setattr(snapshot, '_today_ist', lambda: '2026-10-30')
    monkeypatch.setattr(snapshot, 'query_all', lambda *args: [{'symbol': 'AAA', 'mcsymbol': 'AA'}])
    writes = []
    monkeypatch.setattr(snapshot, 'execute', lambda sql, params: writes.append((sql, params)))
    def fetch(symbol, code, session, health):
        health.record('yahoo', 'limited', '429')
        return {'target_mean': 123.0}
    monkeypatch.setattr(snapshot, '_fetch_symbol_hybrid', fetch)
    with pytest.raises(RuntimeError, match='source degraded; partial snapshots retained'):
        snapshot.run(as_of='2026-10-30')
    assert len(writes) == 1 and 'ON CONFLICT' in writes[0][0]


def test_health_flags_systemic_errors_but_not_a_few_isolated_failures():
    health = snapshot.SourceHealth()
    for _ in range(100): health.record('mc', 'attempt')
    for _ in range(19): health.record('mc', 'error', 'bad JSON')
    assert not health.degraded()
    health.record('mc', 'error', 'bad JSON')
    assert health.degraded()


def test_live_fetch_refuses_to_backdate_or_future_date_current_data(monkeypatch):
    monkeypatch.setattr(snapshot, '_today_ist', lambda: '2026-10-30', raising=False)
    def no_query(*args):
        raise AssertionError('date validation must occur before database or network access')
    monkeypatch.setattr(snapshot, 'query_all', no_query)
    for day in ('2026-10-29', '2026-10-31', 'invalid'):
        with pytest.raises(ValueError, match='current IST date'):
            snapshot.run(as_of=day)


def test_live_fetch_fails_for_empty_mapped_universe(monkeypatch):
    monkeypatch.setattr(snapshot, '_today_ist', lambda: '2026-10-30')
    monkeypatch.setattr(snapshot, 'query_all', lambda *args: [])
    with pytest.raises(RuntimeError, match='No active MoneyControl-mapped symbols'):
        snapshot.run(as_of='2026-10-30')


def test_no_content_resets_consecutive_errors_without_opening_circuit():
    health = snapshot.SourceHealth()
    for _ in range(19):
        health.record('mc', 'attempt')
        health.record('mc', 'error', 'temporary')
    health.record('mc', 'empty')
    health.record('mc', 'attempt')
    health.record('mc', 'error', 'temporary')
    assert not health.blocked('mc')
    for _ in range(19):
        health.record('mc', 'attempt')
        health.record('mc', 'error', 'temporary')
    assert health.blocked('mc') and health.degraded()
