"""
Implied-Volatility Feature Engine
==================================
Turns the raw ATM-IV snapshots captured by pcr_fetcher.py (stock_options_oi.atm_iv,
.iv_skew) into the two leak-free, forward-looking features the ensemble consumes:

  iv_rank  — where today's ATM IV sits in its own trailing 252-day [min,max] range (0-1).
             Low rank on a breakout = cheap optionality / coiled move; high rank = the move
             is already priced into options (fade risk). Orthogonal to every price feature.
  iv_skew  — put_iv − call_iv at ~25-delta, passed through from the snapshot. Positive =
             downside hedging bid (crash fear) even when spot looks calm.

Both are written back onto technical_signals(symbol, date) so ml_ensemble.load_*() pick
them up via the existing join. Historical rows are filled at their own as-of date — the
rank at date T only ever uses IV observed on/before T, so there is no look-ahead.

Run:  python iv_features.py            # backfill iv_rank/iv_skew for all dates
      python iv_features.py --date today
"""

import argparse
import datetime

import numpy as np
import pandas as pd

from db_compat import read_df, executemany, connect, safe_alter

IV_RANK_WINDOW = 252   # trading days (~1y) — standard IV-rank lookback
IV_RANK_MIN_OBS = 20   # need at least this many prior obs before a rank is meaningful


def compute_options_walls(conn, symbol: str, spot: float, as_of_date: str, rows=None) -> dict:
    """Compute call wall, put wall distance, and near-expiry gamma flag from option OI."""
    result = {'call_wall_dist_pct': 0.0, 'put_wall_dist_pct': 0.0, 'near_expiry_gamma': 0.0}
    if not spot or spot <= 0:
        return result
    try:
        import datetime as _dt
        today = _dt.date.fromisoformat(as_of_date[:10])
        if rows is None:
            rows = conn.execute("""
                SELECT strike, ce_oi AS calls_oi, pe_oi AS puts_oi, expiry
                FROM so_option_chain
                WHERE symbol = ? AND date = ?
                ORDER BY expiry ASC, strike ASC
            """, (symbol, as_of_date)).fetchall()
        if not rows:
            return result

        def _get(r, i, key):
            return r[key] if hasattr(r, 'keys') else r[i]

        expiries = sorted(set(str(_get(r, 3, 'expiry'))[:10] for r in rows))
        nearest = expiries[0]
        days_to_exp = (_dt.date.fromisoformat(nearest) - today).days

        filtered = [r for r in rows if str(_get(r, 3, 'expiry'))[:10] == nearest]
        strikes = [float(_get(r, 0, 'strike')) for r in filtered]
        oi_c = [float(_get(r, 1, 'calls_oi') or 0) for r in filtered]
        oi_p = [float(_get(r, 2, 'puts_oi') or 0) for r in filtered]

        if max(oi_c, default=0) > 0:
            cw = strikes[oi_c.index(max(oi_c))]
            result['call_wall_dist_pct'] = (cw - spot) / spot * 100
        if max(oi_p, default=0) > 0:
            pw = strikes[oi_p.index(max(oi_p))]
            result['put_wall_dist_pct'] = (spot - pw) / spot * 100
        result['near_expiry_gamma'] = 1.0 if days_to_exp <= 7 else 0.0
    except Exception:
        pass
    return result


def compute_iv_rank(iv: pd.Series, window: int = IV_RANK_WINDOW,
                    min_periods: int = IV_RANK_MIN_OBS) -> pd.Series:
    """Trailing IV-rank in [0,1] for each row of `iv` (must be ordered oldest→newest).

    rank_t = (iv_t − min(window_t)) / (max(window_t) − min(window_t)), where window_t is the
    trailing `window` observations ending at t (inclusive). A flat window (max==min) or too
    few observations yields 0.5 (neutral) so the feature never injects a spurious extreme.
    Uses only past+current values, so it is leak-free for as-of joins."""
    iv = pd.to_numeric(iv, errors="coerce")
    roll_min = iv.rolling(window, min_periods=min_periods).min()
    roll_max = iv.rolling(window, min_periods=min_periods).max()
    span = roll_max - roll_min
    rank = (iv - roll_min) / span
    rank = rank.where(span > 0, 0.5)        # flat window → neutral
    return rank.fillna(0.5).clip(0, 1)


def _latest_iv_per_day(df: pd.DataFrame) -> pd.DataFrame:
    """One ATM-IV row per (symbol, date) — the nearest-expiry snapshot is captured per day,
    but if multiple expiries were stored, keep the row with the highest total OI proxy
    (atm_iv is already nearest-expiry; collapse defensively on max fetched_at order)."""
    df = df.dropna(subset=["atm_iv"])
    df = df.sort_values(["symbol", "date"])
    return df.groupby(["symbol", "date"], as_index=False).last()


def build_iv_features(options_df: pd.DataFrame) -> pd.DataFrame:
    """Given stock_options_oi rows (symbol, date, atm_iv, iv_skew), return a frame of
    (symbol, date, iv_rank, iv_skew) ready to upsert onto technical_signals."""
    if options_df.empty:
        return pd.DataFrame(columns=["symbol", "date", "iv_rank", "iv_skew"])

    daily = _latest_iv_per_day(options_df)
    out = []
    for symbol, g in daily.groupby("symbol"):
        g = g.sort_values("date")
        rank = compute_iv_rank(g["atm_iv"])
        out.append(pd.DataFrame({
            "symbol":  symbol,
            "date":    g["date"].values,
            "iv_rank": rank.values,
            "iv_skew": pd.to_numeric(g.get("iv_skew"), errors="coerce").fillna(0.0).values,
        }))
    return pd.concat(out, ignore_index=True)


def run(only_date: str | None = None) -> int:
    """Compute IV features from stock_options_oi and write them onto technical_signals.
    Returns the number of (symbol, date) rows updated."""
    options = read_df(
        "SELECT symbol, date, atm_iv, iv_skew FROM stock_options_oi "
        "WHERE atm_iv IS NOT NULL ORDER BY symbol, date"
    )
    feats = build_iv_features(options)
    if only_date:
        target = datetime.date.today().isoformat() if only_date == "today" else only_date
        feats = feats[feats["date"] == target]
    if feats.empty:
        print("[IV] No IV features to write.")
        return 0

    conn = connect()
    # Ensure new columns exist on technical_signals. safe_alter commits the DDL in its own
    # transaction (ADD COLUMN IF NOT EXISTS on PG) — a bare conn.execute here is never committed
    # and rolls back on conn.close() below, so the executemany then hit UndefinedColumn on Postgres.
    for col, typ in [
        ("call_wall_dist_pct", "REAL DEFAULT 0"),
        ("put_wall_dist_pct",  "REAL DEFAULT 0"),
        ("near_expiry_gamma",  "REAL DEFAULT 0"),
    ]:
        safe_alter(None, f"ALTER TABLE technical_signals ADD COLUMN {col} {typ}")

    # Read spot prices needed for wall computation from stock_option_features
    spot_rows = conn.execute(
        "SELECT symbol, date, spot FROM stock_option_features ORDER BY symbol, date"
    ).fetchall()
    spot_map: dict = {}
    for r in spot_rows:
        sym = r[0] if isinstance(r, (list, tuple)) else r['symbol']
        dt  = str(r[1] if isinstance(r, (list, tuple)) else r['date'])[:10]
        sp  = float(r[2] if isinstance(r, (list, tuple)) else r['spot'] or 0)
        spot_map[(sym, dt)] = sp

    # Pre-fetch option chain rows for the target symbols and dates in bulk
    chain_map = {}
    if not feats.empty:
        target_dates = list(set(str(d)[:10] for d in feats['date']))
        target_symbols = list(set(feats['symbol']))
        date_placeholders = ",".join(["?"] * len(target_dates))
        sym_placeholders = ",".join(["?"] * len(target_symbols))
        
        q = f"""
            SELECT symbol, date, strike, ce_oi AS calls_oi, pe_oi AS puts_oi, expiry
            FROM so_option_chain
            WHERE date IN ({date_placeholders}) AND symbol IN ({sym_placeholders})
        """
        chain_rows = conn.execute(q, target_dates + target_symbols).fetchall()
        for r in chain_rows:
            sym = r[0] if isinstance(r, (list, tuple)) else r['symbol']
            dt  = str(r[1] if isinstance(r, (list, tuple)) else r['date'])[:10]
            strike = r[2] if isinstance(r, (list, tuple)) else r['strike']
            calls_oi = r[3] if isinstance(r, (list, tuple)) else r['calls_oi']
            puts_oi = r[4] if isinstance(r, (list, tuple)) else r['puts_oi']
            expiry = r[5] if isinstance(r, (list, tuple)) else r['expiry']
            
            key = (sym, dt)
            if key not in chain_map:
                chain_map[key] = []
            chain_map[key].append((strike, calls_oi, puts_oi, expiry))

    # Update the technical_signals row nearest each IV snapshot's OWN date (scanner rows lag
    # by days, so an exact date match misses some). Previously this always targeted
    # MAX(date) globally, so every historical (symbol, date) row in feats overwrote the
    # SAME single latest technical_signals row -- only the last-processed date's IV values
    # survived, and they landed on a row that could postdate the snapshot they came from.
    params = []
    for row in feats.itertuples(index=False):
        date_str = str(row.date)[:10]
        spot = spot_map.get((row.symbol, date_str), 0.0)
        c_rows = chain_map.get((row.symbol, date_str))
        walls = compute_options_walls(conn, row.symbol, spot, date_str, rows=c_rows)
        params.append((
            float(row.iv_rank), float(row.iv_skew),
            walls['call_wall_dist_pct'], walls['put_wall_dist_pct'], walls['near_expiry_gamma'],
            row.symbol, row.symbol, date_str,
        ))

    conn.close()

    n = executemany(
        "UPDATE technical_signals "
        "SET iv_rank = ?, iv_skew = ?, call_wall_dist_pct = ?, put_wall_dist_pct = ?, near_expiry_gamma = ? "
        "WHERE symbol = ? AND date = (SELECT t2.date FROM technical_signals t2 "
        "WHERE t2.symbol = ? AND t2.date <= ? ORDER BY t2.date DESC LIMIT 1)",
        params,
    )
    print(f"[IV] Updated iv_rank/iv_skew/walls on {n} technical_signals rows "
          f"({len(feats)} symbol-dates computed).")
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Implied-volatility feature engine")
    parser.add_argument("--date", help="If 'today', only update today's rows")
    args = parser.parse_args()
    run(only_date=args.date)
