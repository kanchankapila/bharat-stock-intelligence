"""
Analyst Estimates Snapshotter
==============================
Fetches analyst consensus, price targets, and EPS estimates from MoneyControl
for all NSE stocks that have an mcsymbol in the nse_stocks table. Writes
date-keyed snapshots into analyst_estimates_history(symbol, as_of_date, ...).
Same-day updates replace the prior row, so this table alone cannot reconstruct an
earlier intraday observation or establish availability before a decision cutoff.

Run:  python analyst_estimates_snapshot.py
      python analyst_estimates_snapshot.py --as-of YYYY-MM-DD  # current IST date only
      python analyst_estimates_snapshot.py --symbols RELIANCE,TCS
"""

import argparse
import datetime
import threading
from typing import Callable, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from db_compat import execute, query_all
from fetch_utils import retry_get

import sys

# ── MoneyControl API endpoints (same ones mcApiService.ts wraps) ──────────────

_MC_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.moneycontrol.com/",
}

_URL_ANALYST  = "https://api.moneycontrol.com/mcapi/v1/stock/estimates/analyst-rating?deviceType=W&scId={scId}&ex=N"
_URL_PRICE    = "https://api.moneycontrol.com/mcapi/v1/stock/estimates/price-forecast?scId={scId}&ex=N&deviceType=W"
_URL_EARNINGS = "https://api.moneycontrol.com/mcapi/v1/stock/estimates/earning-forecast?scId={scId}&ex=N&deviceType=W&frequency=12&financialType=C"


# ── Pure parsing functions (no I/O, fully testable) ───────────────────────────

def parse_analyst_rating(data: Optional[dict]) -> dict:
    """Extract counts from McAnalystRating response payload.
    Returns dict with all keys set to None on missing/malformed input."""
    empty = {"n_analysts": None, "final_rating": None,
             "buy_count": None, "hold_count": None, "sell_count": None}
    if not data:
        return empty

    n_analysts: Optional[int] = None
    try:
        v = int(data.get("analystCount") or 0)
        n_analysts = v if v > 0 else None
    except (TypeError, ValueError):
        pass

    final_rating = data.get("finalRating") or None

    buy_count = hold_count = sell_count = None
    for r in (data.get("ratings") or []):
        name = (r.get("name") or "").upper()
        try:
            cnt = int(r.get("value") or 0)
        except (TypeError, ValueError):
            cnt = 0
        if "BUY" in name or "OUTPERFORM" in name:
            buy_count = (buy_count or 0) + cnt
        elif "HOLD" in name or "NEUTRAL" in name:
            hold_count = (hold_count or 0) + cnt
        elif "SELL" in name or "UNDERPERFORM" in name:
            sell_count = (sell_count or 0) + cnt

    return {
        "n_analysts":   n_analysts,
        "final_rating": final_rating,
        "buy_count":    buy_count,
        "hold_count":   hold_count,
        "sell_count":   sell_count,
    }


def parse_price_forecast(data: Optional[dict]) -> dict:
    """Extract target high/mean/low from McPriceForecast response payload."""
    empty = {"target_high": None, "target_mean": None, "target_low": None}
    if not data:
        return empty

    def _f(key: str) -> Optional[float]:
        try:
            v = float(data.get(key) or 0)
            return v if v != 0.0 else None
        except (TypeError, ValueError):
            return None

    return {"target_high": _f("high"), "target_mean": _f("mean"), "target_low": _f("low")}


def parse_earnings_forecast(data: Optional[dict]) -> dict:
    """Extract next-period EPS and revenue estimate from McEarningsForecast response payload.
    'Next period' = the first entry in the array where actual is empty or null (future estimate)."""
    empty = {"eps_est_next": None, "revenue_est_next": None}
    if not data:
        return empty

    def _next_avg(series) -> Optional[float]:
        for entry in (series or []):
            if not entry.get("actual"):
                try:
                    v = float(entry.get("avg") or 0)
                    return v if v != 0.0 else None
                except (TypeError, ValueError):
                    return None
        return None

    return {
        "eps_est_next":     _next_avg(data.get("eps")),
        "revenue_est_next": _next_avg(data.get("revenue")),
    }


# ── HTTP fetch ────────────────────────────────────────────────────────────────

class SourceHealth:
    """Per-run, thread-safe source health; an explicit rate limit opens only that source."""
    def __init__(self):
        self.lock = threading.Lock()
        self.yahoo_limited = False
        self.mc_limited = False
        self.mc_circuit_open = False
        self.mc_consecutive_errors = 0
        self.mc_attempts = 0
        self.mc_errors = 0
        self.mc_no_content = 0
        self.yahoo_errors = 0

    def record(self, source: str, kind: str, detail: str = '') -> None:
        with self.lock:
            if source == 'mc':
                if kind == 'attempt': self.mc_attempts += 1
                elif kind == 'empty':
                    self.mc_no_content += 1
                    self.mc_consecutive_errors = 0
                elif kind == 'success': self.mc_consecutive_errors = 0
                elif kind == 'error':
                    self.mc_errors += 1
                    self.mc_consecutive_errors += 1
                    if self.mc_consecutive_errors >= 20: self.mc_circuit_open = True
                elif kind == 'limited':
                    self.mc_errors += 1
                    self.mc_limited = True
                count = self.mc_errors
            else:
                if kind == 'limited': self.yahoo_limited = True
                self.yahoo_errors += 1
                count = self.yahoo_errors
        # Bound repeated messages; the final summary retains total counts.
        if kind in ('error', 'limited') and count <= 3:
            print(f'[AnalystEstimates] {source} {kind}: {detail}', file=sys.stderr)

    def blocked(self, source: str) -> bool:
        with self.lock:
            return (self.mc_limited or self.mc_circuit_open) if source == 'mc' else self.yahoo_limited

    def degraded(self) -> bool:
        with self.lock:
            return (self.yahoo_limited or self.mc_limited or self.mc_circuit_open or
                    (self.mc_errors >= 20 and self.mc_errors * 5 >= self.mc_attempts))

    def summary(self) -> str:
        with self.lock:
            return (f'mc_attempts={self.mc_attempts} mc_no_content={self.mc_no_content} '
                    f'mc_errors={self.mc_errors} mc_rate_limited={self.mc_limited} '
                    f'mc_circuit_open={self.mc_circuit_open} '
                    f'yahoo_errors={self.yahoo_errors} yahoo_rate_limited={self.yahoo_limited}')


def _is_rate_limit(exc: Exception) -> bool:
    status = getattr(getattr(exc, 'response', None), 'status_code', None)
    msg = str(exc).lower()
    return status == 429 or 'too many requests' in msg or 'rate limit' in msg


def _mc_get(url: str, session: requests.Session, health: Optional[SourceHealth] = None) -> Optional[dict]:
    """Fetch a MoneyControl JSON endpoint; return the .data payload or None."""
    try:
        if health and health.blocked('mc'):
            return None
        if health:
            health.record('mc', 'attempt')
        resp = retry_get(session, url, headers=_MC_HEADERS, timeout=10, stop_statuses={429})
        # HTTP 204 is a valid no-content response for stocks without provider coverage.
        if resp.status_code == 204:
            if health: health.record('mc', 'empty')
            return None
        j = resp.json()
        if not isinstance(j, dict):
            raise ValueError('MoneyControl response is not a JSON object')
        if health:
            health.record('mc', 'success')
        if j.get("success") == 1:
            return j.get("data")
    except Exception as exc:
        # Returns None, which callers read as "MC has no data for this symbol" -- that is also
        # what a 403/timeout/malformed payload looks like. Without this the symbol silently
        # falls back to the Yahoo path (or to NULL columns) with no trace of why.
        if health:
            endpoint = url.split('/')[-1][:120]
            health.record('mc', 'limited' if _is_rate_limit(exc) else 'error', f'{endpoint}: {str(exc)[:160]}')
        else:
            print(f"[AnalystEstimates] MC fetch failed: {exc}", file=sys.stderr)
    return None


def _fetch_symbol(mcsymbol: str, session: requests.Session, health: Optional[SourceHealth] = None) -> dict:
    """Fetch and merge analyst-rating + price-forecast + earnings-forecast for one stock."""
    result: dict = {}
    result.update(parse_analyst_rating(_mc_get(_URL_ANALYST.format(scId=mcsymbol), session, health)))
    result.update(parse_price_forecast(_mc_get(_URL_PRICE.format(scId=mcsymbol), session, health)))
    result.update(parse_earnings_forecast(_mc_get(_URL_EARNINGS.format(scId=mcsymbol), session, health)))
    return result


def _fetch_symbol_hybrid(symbol: str, mcsymbol: str, session: requests.Session,
                         health: Optional[SourceHealth] = None) -> dict:
    """Fast hybrid fetcher: structured direct engine with MoneyControl fallback."""
    result: dict = {
        "n_analysts": None, "final_rating": None, "buy_count": None,
        "hold_count": None, "sell_count": None, "target_high": None,
        "target_mean": None, "target_low": None, "eps_est_next": None,
        "revenue_est_next": None
    }
    try:
        if health and health.blocked('yahoo'):
            raise _SourcePaused()
        import yfinance as yf
        t = yf.Ticker(f"{symbol}.NS")
        info = t.info or {}
        t_mean = info.get("targetMeanPrice")
        t_high = info.get("targetHighPrice")
        t_low = info.get("targetLowPrice")
        n_cov = info.get("numberOfAnalystOpinions")
        rec_key = info.get("recommendationKey")
        fwd_eps = info.get("forwardEps")
        
        if t_mean is not None:
            result["target_mean"] = float(t_mean)
            result["target_high"] = float(t_high) if t_high else None
            result["target_low"] = float(t_low) if t_low else None
            result["n_analysts"] = int(n_cov) if n_cov else None
            result["final_rating"] = rec_key.upper() if rec_key else None
            result["eps_est_next"] = float(fwd_eps) if fwd_eps else None
            # NOTE: deliberately NOT estimating buy/hold/sell splits from
            # recommendationMean — these columns feed ml_ensemble as features, and
            # synthetic distributions (80/15/5 etc. of n_analysts) would poison
            # training. Real counts arrive from the MoneyControl merge below
            # whenever MC has the symbol; if neither source has them they stay
            # NULL (honest unknown), never fabricated.
    except _SourcePaused:
        pass
    except Exception as exc:
        # Yahoo path failed; MC fills the gaps below. Logged rather than swallowed because the
        # result is a HALF-POPULATED estimate row, and "which of the two sources failed" is
        # exactly what an audit needs to tell a vendor outage from a parser regression.
        if health:
            health.record('yahoo', 'limited' if _is_rate_limit(exc) else 'error', str(exc)[:200])
        else:
            print(f"[AnalystEstimates] Yahoo parse failed: {exc}", file=sys.stderr)

    if (result["target_mean"] is None or result["n_analysts"] is None
            or result["eps_est_next"] is None or result["buy_count"] is None) and mcsymbol:
        mc_res = _fetch_symbol(mcsymbol, session, health)
        for k, v in mc_res.items():
            if result.get(k) is None and v is not None:
                result[k] = v

    return result


class _SourcePaused(Exception):
    """Internal control flow for a source that explicitly rate-limited this run."""

# ── SQL ───────────────────────────────────────────────────────────────────────

_SELECT_SYMBOLS = """
    SELECT DISTINCT symbol, mcsymbol
    FROM nse_stocks
    WHERE mcsymbol IS NOT NULL AND mcsymbol != '' AND status = 'ACTIVE'
"""
_SELECT_SYMBOLS_FILTER = """
    SELECT symbol, mcsymbol
    FROM nse_stocks
    WHERE mcsymbol IS NOT NULL AND mcsymbol != ''
      AND symbol IN ({placeholders})
"""
_INSERT = """
    INSERT INTO analyst_estimates_history
        (symbol, as_of_date, n_analysts, final_rating, buy_count, hold_count, sell_count,
         target_high, target_mean, target_low, eps_est_next, revenue_est_next)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (symbol, as_of_date) DO UPDATE SET
        n_analysts = EXCLUDED.n_analysts, final_rating = EXCLUDED.final_rating,
        buy_count = EXCLUDED.buy_count, hold_count = EXCLUDED.hold_count,
        sell_count = EXCLUDED.sell_count, target_high = EXCLUDED.target_high,
        target_mean = EXCLUDED.target_mean, target_low = EXCLUDED.target_low,
        eps_est_next = EXCLUDED.eps_est_next, revenue_est_next = EXCLUDED.revenue_est_next,
        captured_at = now()
"""


# ── Entry point ───────────────────────────────────────────────────────────────

def _today_ist() -> str:
    return (datetime.datetime.now(datetime.timezone.utc) +
            datetime.timedelta(hours=5, minutes=30)).date().isoformat()


def run(
    as_of: Optional[str] = None,
    symbols: Optional[list] = None,
    fetch_fn: Optional[Callable] = None,
) -> int:
    """Snapshot analyst estimates for `symbols` (or all NSE stocks with mcsymbol).
    Idempotent per (symbol, as_of_date): atomically replaces today's row.
    `fetch_fn(mcsymbol) -> dict` is injectable for tests; defaults to live MC fetch.
    Returns count of rows written."""
    use_live = fetch_fn is None
    today = _today_ist()
    as_of = as_of or today
    if use_live and as_of != today:
        raise ValueError('Live analyst estimates can only be captured for the current IST date')

    if symbols:
        placeholders = ",".join(["?"] * len(symbols))
        rows = query_all(
            _SELECT_SYMBOLS_FILTER.format(placeholders=placeholders),
            tuple(symbols),
        )
    else:
        rows = query_all(_SELECT_SYMBOLS)

    if use_live and not rows:
        raise RuntimeError('No active MoneyControl-mapped symbols for analyst estimates')

    session = requests.Session()
    session.headers.update(_MC_HEADERS)

    written = 0
    done = 0
    skipped_no_values = 0
    health = SourceHealth() if use_live else None

    def _process_one(row):
        symbol, mcsymbol = row["symbol"], row["mcsymbol"]
        if fetch_fn:
            fields = fetch_fn(mcsymbol)
        else:
            fields = _fetch_symbol_hybrid(symbol, mcsymbol, session, health)
        return symbol, fields

    workers = 12 if use_live else len(rows) or 1
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_process_one, r): r["symbol"] for r in rows}
        for fut in as_completed(futures):
            symbol, fields = fut.result()
            done += 1
            if all(v is None for v in fields.values()):
                skipped_no_values += 1
                continue

            execute(_INSERT, (
                symbol, as_of,
                fields.get("n_analysts"),
                fields.get("final_rating"),
                fields.get("buy_count"),
                fields.get("hold_count"),
                fields.get("sell_count"),
                fields.get("target_high"),
                fields.get("target_mean"),
                fields.get("target_low"),
                fields.get("eps_est_next"),
                fields.get("revenue_est_next"),
            ))
            written += 1

    print(f"[ANALYST-SNAP] Wrote {written}/{len(rows)} analyst snapshots as_of {as_of}; "
          f"skipped_no_values={skipped_no_values} (no coverage or source failure).")
    if health:
        print(f'[ANALYST-SNAP] source health: {health.summary()}')
        if health.degraded() or (rows and not written):
            raise RuntimeError(f'Analyst estimates source degraded; partial snapshots retained: {health.summary()}')
    return written


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Analyst estimates point-in-time snapshotter")
    parser.add_argument("--as-of",   help="Snapshot date YYYY-MM-DD (default: today)")
    parser.add_argument("--symbols", help="Comma-separated NSE symbols (default: all with mcsymbol)")
    args = parser.parse_args()
    syms = [s.strip() for s in args.symbols.split(",")] if args.symbols else None
    run(as_of=args.as_of, symbols=syms)

