"""AF-20261120-07: mc_ohlcv_backfill asked MoneyControl for bars up to a hard-coded
timestamp (~2026-07-13), so every backfill after that date silently stopped in July
(ICICILIFE's 2026-11-20 run returned 1,369 rows ending 2026-07-13)."""
import time

import mc_ohlcv_backfill as m


class _Resp:
    status_code = 200

    def json(self):
        return {"s": "no_data"}


class _Session:
    def __init__(self):
        self.params = None

    def get(self, url, params=None, timeout=None):
        self.params = params
        return _Resp()


def test_request_window_reaches_today():
    s = _Session()
    m.fetch_one("RELIANCE", s, 2021)
    assert s.params["to"] >= int(time.time()) - 60
