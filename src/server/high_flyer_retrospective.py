#!/usr/bin/env python3
"""
High-Flyer Retrospective — daily winner attribution + precursor learning
========================================================================
Every evening, look at the stocks that actually flew today (big up-move on real
volume, or a fresh 52-week high) and ask two questions the rest of the stack
never asks:

1. RECALL — did any of our systems (unified ranker, trade signals, early-hours
   spotter, yesterday's own candidate list) have this name flagged in advance?
2. ATTRIBUTION — which observable precursors were present the day BEFORE the
   move, across the whole universe? Rolling lift per precursor tells us which
   setups actually precede big moves here, not in a textbook.
3. WRONG-DIRECTION — the sharper failure than a plain miss: a flyer that was
   classified Sell/Strong Sell the day before (rallied against our own call),
   or a diver (big down-move / fresh 52w low) that was classified Buy/Strong
   Buy (crashed after our own call). Plain recall only asks "did anything
   flag this"; it never catches the opposite-signed call. See the 2026-08-06
   CELLO incident (Sell called, then +15.69%) for why this matters.

The learned lifts then score TODAY's universe to produce tomorrow's
high_flyer_candidates watchlist — which tomorrow's run grades, closing the loop.

Tables (self-created, like early_hours_predictions):
  high_flyer_retrospective  one row per (flyer, day): return, how it was missed/caught
  high_flyer_daily_stats    one row per day: recall by source + precursor counts
  high_flyer_candidates     one row per (as-of day, symbol): tomorrow's watchlist

Run:  python high_flyer_retrospective.py            # latest completed session
      python high_flyer_retrospective.py --date 2026-07-08
"""

import argparse
import json
import math

import pandas as pd

from db_compat import connect, read_df, translate, safe_alter

RET_THRESHOLD = 0.04        # +4% day move
VOL_RATIO_THRESHOLD = 1.5   # on >=1.5x 20d avg volume
MIN_PRICE = 20.0            # skip penny noise
MIN_BARS = 60               # need history for vol avg / 52w high
LIFT_WINDOW_DAYS = 60       # rolling window (trading days) for precursor lift
MIN_SUPPORT = 30            # flyer-occurrences of a precursor before its lift is trusted
MIN_LIFT = 1.15             # precursor must beat base rate by 15% to score candidates
MAX_CANDIDATES = 30
FRESHNESS_SESSIONS = 5      # a candidate needs a trusted precursor newly active vs 5 sessions ago


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS high_flyer_retrospective (
            symbol       TEXT NOT NULL,
            date         TEXT NOT NULL,
            return_pct   REAL NOT NULL,
            volume_ratio REAL,
            new_52w_high INTEGER DEFAULT 0,
            predicted_by TEXT,
            precursors   TEXT,
            computed_at  TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """))
    # direction/wrong_call added after the table's initial ship — safe_alter is a no-op
    # once applied, so this stays correct on every run against an already-migrated DB.
    safe_alter(cur, "ALTER TABLE high_flyer_retrospective ADD COLUMN direction TEXT DEFAULT 'up'")
    safe_alter(cur, "ALTER TABLE high_flyer_retrospective ADD COLUMN wrong_call INTEGER DEFAULT 0")
    safe_alter(cur, "ALTER TABLE high_flyer_retrospective ADD COLUMN prior_classification TEXT")
    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS high_flyer_daily_stats (
            date                  TEXT PRIMARY KEY,
            universe_n            INTEGER,
            flyer_n               INTEGER,
            recall_json           TEXT,
            precursor_counts_json TEXT,
            computed_at           TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """))
    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS high_flyer_candidates (
            date        TEXT NOT NULL,
            symbol      TEXT NOT NULL,
            score       REAL NOT NULL,
            precursors  TEXT,
            computed_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (date, symbol)
        )
    """))
    con.commit()


# ── pure core ────────────────────────────────────────────────────────────────

def detect_flyers(close: pd.DataFrame, volume: pd.DataFrame, day) -> pd.DataFrame:
    """close/volume: dates x symbols frames covering >= MIN_BARS sessions up to `day`
    (inclusive). Returns DataFrame(symbol, return_pct, volume_ratio, new_52w_high)."""
    if day not in close.index:
        return pd.DataFrame(columns=["symbol", "return_pct", "volume_ratio", "new_52w_high"])
    hist = close.loc[:day]
    vhist = volume.loc[:day]
    enough = hist.notna().sum() >= MIN_BARS
    ret = hist.iloc[-1] / hist.iloc[:-1].ffill().iloc[-1] - 1.0
    vol_avg20 = vhist.iloc[:-1].tail(20).mean()
    vol_ratio = vhist.iloc[-1] / vol_avg20.where(vol_avg20 > 0)
    high_252 = hist.iloc[:-1].tail(252).max()
    new_high = (hist.iloc[-1] > high_252) & (ret > 0)
    is_flyer = enough & (hist.iloc[-1] >= MIN_PRICE) & (
        ((ret >= RET_THRESHOLD) & (vol_ratio >= VOL_RATIO_THRESHOLD)) | new_high
    )
    out = pd.DataFrame({
        "symbol": close.columns,
        "return_pct": (ret * 100).round(2),
        "volume_ratio": vol_ratio.round(2),
        "new_52w_high": new_high.astype(int),
    })
    return out[is_flyer.reindex(close.columns).fillna(False).values].reset_index(drop=True)


def detect_divers(close: pd.DataFrame, volume: pd.DataFrame, day) -> pd.DataFrame:
    """Mirror of detect_flyers for big DOWN moves / fresh 52w lows. Same shape output
    (return_pct is negative, new_52w_high is repurposed as new_52w_low)."""
    if day not in close.index:
        return pd.DataFrame(columns=["symbol", "return_pct", "volume_ratio", "new_52w_high"])
    hist = close.loc[:day]
    vhist = volume.loc[:day]
    enough = hist.notna().sum() >= MIN_BARS
    ret = hist.iloc[-1] / hist.iloc[:-1].ffill().iloc[-1] - 1.0
    vol_avg20 = vhist.iloc[:-1].tail(20).mean()
    vol_ratio = vhist.iloc[-1] / vol_avg20.where(vol_avg20 > 0)
    low_252 = hist.iloc[:-1].tail(252).min()
    new_low = (hist.iloc[-1] < low_252) & (ret < 0)
    is_diver = enough & (hist.iloc[-1] >= MIN_PRICE) & (
        ((ret <= -RET_THRESHOLD) & (vol_ratio >= VOL_RATIO_THRESHOLD)) | new_low
    )
    out = pd.DataFrame({
        "symbol": close.columns,
        "return_pct": (ret * 100).round(2),
        "volume_ratio": vol_ratio.round(2),
        "new_52w_high": new_low.astype(int),   # column name kept for schema reuse; means "new low" here
    })
    return out[is_diver.reindex(close.columns).fillna(False).values].reset_index(drop=True)


def ohlcv_precursor_flags(close: pd.DataFrame, volume: pd.DataFrame, asof) -> pd.DataFrame:
    """Price/volume-derived precursor flags as of `asof` (exclusive of any later data).
    Returns bool DataFrame indexed by symbol."""
    hist = close.loc[:asof]
    vhist = volume.loc[:asof]
    last = hist.ffill().iloc[-1]
    high_252 = hist.tail(252).max()
    sma200 = hist.tail(200).mean()
    ret21 = last / hist.iloc[:-21].ffill().iloc[-1] - 1.0 if len(hist) > 21 else last * float("nan")
    vol5 = vhist.tail(5).mean()
    vol20 = vhist.tail(20).mean()
    rng10 = (hist.tail(10).max() - hist.tail(10).min()) / last
    flags = pd.DataFrame({
        "near_52w_high": last >= 0.95 * high_252,
        "above_sma200": last > sma200,
        "up_21d": ret21 > 0.05,
        "vol_buildup_5v20": vol5 >= 1.3 * vol20.where(vol20 > 0),
        "tight_range_10d": rng10 <= 0.06,
    })
    return flags.fillna(False).astype(bool)


def ts_precursor_flags(ts: pd.DataFrame) -> pd.DataFrame:
    """Feature-store precursor flags from the latest technical_signals row per symbol.
    ts columns: symbol + feature cols. Returns bool DataFrame indexed by symbol."""
    if ts.empty:
        return pd.DataFrame()
    ts = ts.set_index("symbol")
    num = lambda c: pd.to_numeric(ts.get(c), errors="coerce")
    flags = pd.DataFrame({
        "rs_rank_63d_top": num("rs_rank_63d") >= 0.8,
        "rs_rank_21d_top": num("rs_rank_21d") >= 0.8,
        "adx_trending": num("adx") >= 25,
        "high_delivery": num("delivery_pct") >= 60,
        "calib_winprob_55": num("calibrated_win_probability") >= 0.55,
        "screener_bull_3plus": num("screener_bull_count") >= 3,
        "eps_beat_last_q": num("eps_beat_last_q") >= 1,
        "insider_buying": num("insider_buy_flag") >= 1,
    }, index=ts.index)
    return flags.fillna(False).astype(bool)


def compute_lifts(daily_stats: list[dict]) -> dict:
    """daily_stats: rows of {'flyer_n', 'universe_n', 'precursor_counts': {p: {'universe': n, 'flyers': m}}}.
    Returns {precursor: {'lift': x, 'support': m_total}} where
    lift = P(precursor | flyer) / P(precursor | universe)."""
    tot_fly = sum(r["flyer_n"] for r in daily_stats)
    tot_uni = sum(r["universe_n"] for r in daily_stats)
    if not tot_fly or not tot_uni:
        return {}
    out = {}
    names = {p for r in daily_stats for p in r["precursor_counts"]}
    for p in names:
        fly_p = sum(r["precursor_counts"].get(p, {}).get("flyers", 0) for r in daily_stats)
        uni_p = sum(r["precursor_counts"].get(p, {}).get("universe", 0) for r in daily_stats)
        if uni_p == 0:
            continue
        p_given_fly = fly_p / tot_fly
        p_given_uni = uni_p / tot_uni
        if p_given_uni > 0:
            out[p] = {"lift": round(p_given_fly / p_given_uni, 3), "support": fly_p}
    return out


def score_candidates(flags: pd.DataFrame, lifts: dict,
                     prev_flags: pd.DataFrame | None = None) -> pd.DataFrame:
    """Score every symbol by the sum of log-lifts of its active, trusted precursors.

    When `prev_flags` (same shape, ~5 sessions earlier) is given, only symbols with at
    least one NEWLY-activated trusted precursor qualify — walk-forward validation showed
    the unconditioned top-N degenerates into a static extended-momentum basket with zero
    next-day alpha; breakouts follow fresh setups, not chronic strength.
    Returns DataFrame(symbol, score, precursors) sorted desc, top MAX_CANDIDATES."""
    trusted = {p: v["lift"] for p, v in lifts.items()
               if v["lift"] >= MIN_LIFT and v["support"] >= MIN_SUPPORT and p in flags.columns}
    if not trusted or flags.empty:
        return pd.DataFrame(columns=["symbol", "score", "precursors"])
    weights = {p: math.log(l) for p, l in trusted.items()}
    score = sum(flags[p].astype(float) * w for p, w in weights.items())
    active = flags[list(trusted)].apply(lambda r: ",".join(r.index[r]), axis=1)
    out = pd.DataFrame({"symbol": flags.index, "score": score.round(4), "precursors": active})
    if prev_flags is not None and not prev_flags.empty:
        prev = prev_flags.reindex(index=flags.index, columns=list(trusted)).fillna(False)
        fresh = (flags[list(trusted)] & ~prev.astype(bool)).any(axis=1)
        out = out[fresh.values]
    out = out[out["score"] > 0].sort_values("score", ascending=False).head(MAX_CANDIDATES)
    return out.reset_index(drop=True)


# ── I/O + orchestration ──────────────────────────────────────────────────────

def _load_predicted_sets(con, day: str, prev_day: str) -> dict:
    """Symbols each source had flagged BEFORE the session of `day`."""
    sets = {}
    df = read_df(
        "SELECT symbol FROM unified_recommendations WHERE computed_at = "
        "(SELECT MAX(computed_at) FROM unified_recommendations WHERE computed_at < ?) "
        "AND classification LIKE '%Buy%'", (day,))
    sets["unified"] = set(df["symbol"]) if not df.empty else set()
    df = read_df(
        "SELECT DISTINCT symbol FROM unified_signals "
        "WHERE signal_date >= ? AND signal_date < ?",
        ((pd.Timestamp(day) - pd.Timedelta(days=5)).strftime("%Y-%m-%d"), day))
    sets["signals"] = set(df["symbol"]) if not df.empty else set()
    df = read_df("SELECT symbol FROM early_hours_predictions WHERE date = ?", (day,))
    sets["early_hours"] = set(df["symbol"]) if not df.empty else set()
    df = read_df("SELECT symbol FROM high_flyer_candidates WHERE date = ?", (prev_day,))
    sets["candidates"] = set(df["symbol"]) if not df.empty else set()
    return sets


def _load_prior_classification(con, day: str) -> dict:
    """symbol -> unified_recommendations.classification as of the run immediately before
    `day`'s session (same MAX(computed_at) < day convention as _load_predicted_sets)."""
    df = read_df(
        "SELECT symbol, classification FROM unified_recommendations WHERE computed_at = "
        "(SELECT MAX(computed_at) FROM unified_recommendations WHERE computed_at < ?)", (day,))
    return dict(zip(df["symbol"], df["classification"])) if not df.empty else {}


def run(target_date: str | None = None, backfill: int = 0) -> dict:
    con = connect()
    ensure_schema(con)

    ohlcv = read_df(
        "SELECT symbol, date, close, volume FROM stock_ohlcv "
        "WHERE date >= ? AND COALESCE(is_suspect, 0) = 0 ORDER BY date",
        ((pd.Timestamp.today() - pd.Timedelta(days=420)).strftime("%Y-%m-%d"),))
    if ohlcv.empty:
        print("[HFR] No OHLCV data.")
        return {}
    ohlcv["date"] = pd.to_datetime(ohlcv["date"]).dt.strftime("%Y-%m-%d")
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    volume = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()

    day = target_date or close.index[-1]
    if day not in close.index:
        print(f"[HFR] {day} not in OHLCV.")
        return {}
    day_pos = close.index.get_loc(day)
    if day_pos < 1:
        print("[HFR] Not enough history before target day.")
        return {}

    days = close.index[max(1, day_pos - backfill): day_pos + 1]
    result = {}
    for d in days:
        result = _process_day(con, close, volume, d, close.index[close.index.get_loc(d) - 1])
    con.close()
    return result


_SELL_CLASSES = {"Sell", "Strong Sell"}
_BUY_CLASSES = {"Buy", "Strong Buy"}


def _process_day(con, close, volume, day, prev_day) -> dict:
    # 1. RECALL — today's flyers vs what we had flagged in advance
    flyers = detect_flyers(close, volume, day)
    divers = detect_divers(close, volume, day)
    predicted = _load_predicted_sets(con, day, prev_day)
    prior_class = _load_prior_classification(con, day)

    # Precursor flags as of the PREVIOUS session, whole universe
    px_flags = ohlcv_precursor_flags(close, volume, prev_day)
    flags = px_flags.join(ts_precursor_flags(_latest_ts(con, prev_day)), how="left") \
        .fillna(False).astype(bool)

    cur = con.cursor()
    recall_hits = {k: 0 for k in predicted}
    any_hits = 0
    wrong_bearish_miss = 0   # flyer that rallied despite a prior Sell/Strong Sell call
    for r in flyers.itertuples(index=False):
        srcs = [k for k, syms in predicted.items() if r.symbol in syms]
        any_hits += bool(srcs)
        for k in srcs:
            recall_hits[k] += 1
        pc = prior_class.get(r.symbol)
        wrong = bool(pc in _SELL_CLASSES)
        wrong_bearish_miss += wrong
        active = ",".join(flags.columns[flags.loc[r.symbol]]) if r.symbol in flags.index else ""
        cur.execute(translate(
            "INSERT INTO high_flyer_retrospective "
            "(symbol, date, return_pct, volume_ratio, new_52w_high, predicted_by, precursors, "
            "direction, wrong_call, prior_classification) "
            "VALUES (?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT (symbol, date) DO UPDATE SET return_pct = excluded.return_pct, "
            "volume_ratio = excluded.volume_ratio, new_52w_high = excluded.new_52w_high, "
            "predicted_by = excluded.predicted_by, precursors = excluded.precursors, "
            "direction = excluded.direction, wrong_call = excluded.wrong_call, "
            "prior_classification = excluded.prior_classification"),
            (r.symbol, day, float(r.return_pct),
             None if pd.isna(r.volume_ratio) else float(r.volume_ratio),
             int(r.new_52w_high), ",".join(srcs), active, "up", int(wrong), pc))

    # WRONG-DIRECTION (bullish miss): today's divers that were classified Buy/Strong Buy
    # the session before — crashed right after our own bullish call.
    wrong_bullish_miss = 0
    for r in divers.itertuples(index=False):
        pc = prior_class.get(r.symbol)
        wrong = bool(pc in _BUY_CLASSES)
        wrong_bullish_miss += wrong
        active = ",".join(flags.columns[flags.loc[r.symbol]]) if r.symbol in flags.index else ""
        cur.execute(translate(
            "INSERT INTO high_flyer_retrospective "
            "(symbol, date, return_pct, volume_ratio, new_52w_high, predicted_by, precursors, "
            "direction, wrong_call, prior_classification) "
            "VALUES (?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT (symbol, date) DO UPDATE SET return_pct = excluded.return_pct, "
            "volume_ratio = excluded.volume_ratio, new_52w_high = excluded.new_52w_high, "
            "predicted_by = excluded.predicted_by, precursors = excluded.precursors, "
            "direction = excluded.direction, wrong_call = excluded.wrong_call, "
            "prior_classification = excluded.prior_classification"),
            (r.symbol, day, float(r.return_pct),
             None if pd.isna(r.volume_ratio) else float(r.volume_ratio),
             int(r.new_52w_high), "", active, "down", int(wrong), pc))

    n_fly = len(flyers)
    recall = {k: round(v / n_fly, 3) if n_fly else None for k, v in recall_hits.items()}
    recall["any"] = round(any_hits / n_fly, 3) if n_fly else None
    # Precision: of everything a source had flagged, how much actually flew — recall
    # alone rewards firehoses (a source flagging 2000 names "catches" most flyers).
    tradeable = set(close.columns[close.loc[:day].ffill().iloc[-1] >= MIN_PRICE])
    recall["precision"] = {
        k: round(recall_hits[k] / len(syms & tradeable), 3) if syms & tradeable else None
        for k, syms in predicted.items()
    }
    recall["flagged_n"] = {k: len(syms & tradeable) for k, syms in predicted.items()}
    recall["wrong_bearish_miss"] = wrong_bearish_miss   # flyers we had called Sell/Strong Sell on
    recall["wrong_bullish_miss"] = wrong_bullish_miss   # divers we had called Buy/Strong Buy on
    recall["diver_n"] = len(divers)

    # 2. ATTRIBUTION — per-precursor counts for today, then rolling lift
    fly_syms = set(flyers["symbol"])
    fly_flags = flags.loc[flags.index.isin(fly_syms)]
    counts = {p: {"universe": int(flags[p].sum()), "flyers": int(fly_flags[p].sum())}
              for p in flags.columns}
    cur.execute(translate(
        "INSERT INTO high_flyer_daily_stats "
        "(date, universe_n, flyer_n, recall_json, precursor_counts_json) VALUES (?,?,?,?,?) "
        "ON CONFLICT (date) DO UPDATE SET universe_n = excluded.universe_n, "
        "flyer_n = excluded.flyer_n, recall_json = excluded.recall_json, "
        "precursor_counts_json = excluded.precursor_counts_json"),
        (day, int(len(flags)), n_fly, json.dumps(recall), json.dumps(counts)))

    stats = read_df(
        "SELECT flyer_n, universe_n, precursor_counts_json FROM high_flyer_daily_stats "
        "ORDER BY date DESC LIMIT ?", (LIFT_WINDOW_DAYS,))
    lifts = compute_lifts([
        {"flyer_n": int(s.flyer_n), "universe_n": int(s.universe_n),
         "precursor_counts": json.loads(s.precursor_counts_json)}
        for s in stats.itertuples(index=False)])
    cur.execute(translate(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
        ("high_flyer_precursor_lift", json.dumps({"as_of": day, "lifts": lifts})))

    # 3. CANDIDATES — score today's universe with learned lifts → tomorrow's watchlist
    today_flags = ohlcv_precursor_flags(close, volume, day).join(
        ts_precursor_flags(_latest_ts(con, day)), how="left").fillna(False).astype(bool)
    pos = close.index.get_loc(day)
    ref_day = close.index[max(0, pos - FRESHNESS_SESSIONS)]
    ref_flags = ohlcv_precursor_flags(close, volume, ref_day).join(
        ts_precursor_flags(_latest_ts(con, ref_day)), how="left").fillna(False).astype(bool)
    cands = score_candidates(today_flags, lifts, prev_flags=ref_flags)
    cur.execute(translate("DELETE FROM high_flyer_candidates WHERE date = ?"), (day,))
    for r in cands.itertuples(index=False):
        cur.execute(translate(
            "INSERT INTO high_flyer_candidates (date, symbol, score, precursors) "
            "VALUES (?,?,?,?) ON CONFLICT (date, symbol) DO UPDATE SET "
            "score = excluded.score, precursors = excluded.precursors"),
            (day, r.symbol, float(r.score), r.precursors))
    con.commit()

    print(f"[HFR] {day}: {n_fly} flyers, {len(divers)} divers | recall {json.dumps(recall)} | "
          f"wrong-direction: {wrong_bearish_miss} bearish-miss, {wrong_bullish_miss} bullish-miss | "
          f"{len(lifts)} precursor lifts | {len(cands)} candidates for next session")
    if not cands.empty:
        top = ", ".join(f"{r.symbol}({r.score:.2f})" for r in cands.head(10).itertuples(index=False))
        print(f"[HFR] Top candidates: {top}")
    return {"date": day, "flyers": n_fly, "recall": recall, "candidates": len(cands)}


def _pg(con) -> bool:
    from db_compat import use_postgres
    return use_postgres()


def _latest_ts(con, asof: str) -> pd.DataFrame:
    cutoff = (pd.Timestamp(asof) - pd.Timedelta(days=4)).strftime("%Y-%m-%d")
    if _pg(con):
        return read_df(
            "SELECT DISTINCT ON (symbol) symbol, rs_rank_63d, rs_rank_21d, adx, delivery_pct, "
            "calibrated_win_probability, screener_bull_count, eps_beat_last_q, insider_buy_flag "
            "FROM technical_signals WHERE date <= ? AND date >= ? ORDER BY symbol, date DESC",
            (asof, cutoff))
    return _latest_ts_sqlite(asof)


def _latest_ts_sqlite(asof: str) -> pd.DataFrame:
    cutoff = (pd.Timestamp(asof) - pd.Timedelta(days=4)).strftime("%Y-%m-%d")
    return read_df(
        "SELECT t.symbol, t.rs_rank_63d, t.rs_rank_21d, t.adx, t.delivery_pct, "
        "t.calibrated_win_probability, t.screener_bull_count, t.eps_beat_last_q, t.insider_buy_flag "
        "FROM technical_signals t JOIN (SELECT symbol, MAX(date) AS d FROM technical_signals "
        "WHERE date <= ? AND date >= ? GROUP BY symbol) m ON m.symbol = t.symbol AND m.d = t.date",
        (asof, cutoff, ))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="High-flyer retrospective + precursor learning")
    parser.add_argument("--date", help="Target session date YYYY-MM-DD (default: latest in OHLCV)")
    parser.add_argument("--backfill", type=int, default=0,
                        help="Also process the N sessions before the target day (bootstraps lift stats)")
    args = parser.parse_args()
    run(target_date=args.date, backfill=args.backfill)
