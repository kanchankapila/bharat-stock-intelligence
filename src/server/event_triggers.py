"""Per-symbol event triggers: things that happened TO a stock which move price.

WHY (2026-08-10)
----------------
Everything the ranker blends is a SCORE -- a standing opinion recomputed daily. None of it is
an EVENT. Three events were measured this session and none of them was being acted on:

  1. SCREENER EXIT. `screener_appearances.exited_date` is populated on 641,129 of 719,630 rows
     (89%, uniform across all four providers) and every single reader in the codebase uses it
     ONLY as an `exited_date IS NULL OR >= ?` freshness filter. Nothing closes a position,
     alerts, or downgrades when a stock drops out of the bullish screen that got it
     recommended. Measured: a symbol that exited a bullish screener in the last 5 days
     underperforms by -0.621% over the next 21 days (t=-2.33).

  2. SCREENER TENURE. How long a symbol has PERSISTED in its bullish screeners. The platform
     counts membership but not duration, so a 1-day-old appearance and a 60-day-old one score
     identically. Measured IC +0.0315 at 21d (t=+6.14) -- stronger than unified_score itself
     (+0.0084, t=+1.10) -- and it is NOT a momentum proxy: on the same window 21d momentum is
     IC -0.0291 and 63d is -0.0440 (opposite sign), and residualised cross-sectionally on both
     tenure still gives IC +0.0214 (t=+2.95).

  3. NEWS VOLUME. Article count over a trailing 5 days, i.e. attention. Measured IC -0.1032 at
     21d (t=-4.97), the strongest single number found; residualised on size (ADT), momentum and
     volatility it holds at -0.0902 (t=-4.86), so it is not a size artifact. Direction matches
     the documented media-attention / no-media-premium result (Fang & Peress 2009): heavily
     covered names underperform. The effect sits in the extremes rather than being monotone --
     lowest-news quintile +0.445% vs highest -0.204% per-date-demeaned over 21d.

WHAT THIS DELIBERATELY DOES NOT DO
----------------------------------
It does NOT feed unified_score or touch REGIME_WEIGHTS. All three are measured over only
22-36 OVERLAPPING 21-day windows (screener_appearances starts 2026-05-30 and 99.6% of
news_sentiment_items is 2026), so |t| is inflated and none has been seen across more than one
regime. This repo's own history is a list of things that were wired into the blend on thin
evidence and had to be unwound. So: persist them, surface them as explicit flags, let the
history accumulate, and validate before giving anything a weight. `factor_edge.py` is the
tool that should eventually rule on them.

Tenure is also capped by the data window -- with membership history starting 2026-05-30 a
"long" tenure is ~70 days, not years. Re-measure before extrapolating.

USAGE
    python event_triggers.py --date 2026-08-10        # compute + persist for one session
    python event_triggers.py --dry-run                # print, write nothing
"""
from __future__ import annotations

import argparse
import datetime as _dt

import pandas as pd

from as_of import logical_trading_date
from db_compat import connect, read_df, safe_alter, use_postgres

# Windows. 5 days matches the horizon each signal was measured at; changing one means
# re-running the measurement, not just editing the constant.
EXIT_LOOKBACK_DAYS = 5
NEWS_LOOKBACK_DAYS = 5
# Attention flag fires in the top quintile, which is where the measured underperformance sits
# (the relationship is NOT monotone across the middle quintiles -- see module docstring).
NEWS_CROWDED_PCTILE = 0.80
# Top decile of the exit-ratio distribution. Only used for a UI tag -- the ranked ratio is
# what carries the signal; see build_triggers for why no binary threshold is defensible.
EXIT_RATIO_TOP_DECILE = 0.90

TABLE = 'stock_event_triggers'


def ensure_schema(con) -> None:
    pk = ('date TEXT NOT NULL, symbol TEXT NOT NULL, PRIMARY KEY (date, symbol)')
    con.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            {pk},
            bullish_exits_5d      INTEGER,
            bullish_exit_ratio_5d REAL,
            bearish_exits_5d      INTEGER,
            bullish_tenure_days   REAL,
            active_bullish        INTEGER,
            news_count_5d         INTEGER,
            news_sent_5d          REAL,
            news_attention_pctile REAL,
            triggers              TEXT,
            computed_at           TEXT
        )
    """)
    # CREATE TABLE IF NOT EXISTS is a NO-OP once the table exists, so any column added after
    # the first run needs an explicit ALTER or every insert dies on UndefinedColumn. Hit
    # exactly that while building this. safe_alter swallows the already-exists case per
    # dialect, which is why it exists.
    for ddl in (f"ALTER TABLE {TABLE} ADD COLUMN bullish_exit_ratio_5d REAL",):
        safe_alter(con, ddl)
    con.commit()


def _screener_frame(as_of: str) -> pd.DataFrame:
    """Membership with a resolved bias, preferring screener_catalog and falling back to
    screener_master -- the same precedence unified_ranker._get_screener_membership uses, and
    the same reason: 56% of screeners are absent from the catalogue."""
    return read_df(
        """
        SELECT a.symbol,
               a.appeared_date::date AS appeared,
               a.exited_date::date   AS exited,
               COALESCE(sc.signal_bias, sm.inferred_sentiment) AS bias
        FROM screener_appearances a
        LEFT JOIN screener_catalog sc
               ON sc.screener_id = a.screener_id AND LOWER(sc.source) = LOWER(a.source)
        LEFT JOIN screener_master sm
               ON sm.scan_id     = a.screener_id AND LOWER(sm.source) = LOWER(a.source)
        WHERE a.appeared_date <= ?
        """ if use_postgres() else
        """
        SELECT a.symbol, a.appeared_date AS appeared, a.exited_date AS exited,
               COALESCE(sc.signal_bias, sm.inferred_sentiment) AS bias
        FROM screener_appearances a
        LEFT JOIN screener_catalog sc
               ON sc.screener_id = a.screener_id AND LOWER(sc.source) = LOWER(a.source)
        LEFT JOIN screener_master sm
               ON sm.scan_id     = a.screener_id AND LOWER(sm.source) = LOWER(a.source)
        WHERE a.appeared_date <= ?
        """,
        (as_of,),
    )


def compute_screener_events(sc: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    """Pure. Exits in the trailing window, plus tenure/count of what is still active.

    Tenure is the MEAN age of a symbol's currently-active bullish memberships, which is what
    was measured. A symbol whose bullish screens are all fresh scores low even if it has many.
    """
    if sc.empty:
        return pd.DataFrame(columns=['symbol', 'bullish_exits_5d', 'bearish_exits_5d',
                                     'bullish_tenure_days', 'active_bullish'])
    sc = sc.copy()
    sc['appeared'] = pd.to_datetime(sc['appeared'], errors='coerce')
    sc['exited'] = pd.to_datetime(sc['exited'], errors='coerce')
    for col in ('appeared', 'exited'):
        if getattr(sc[col].dtype, 'tz', None) is not None:
            sc[col] = sc[col].dt.tz_localize(None)
    sc = sc[sc['appeared'].notna()]

    win = as_of - pd.Timedelta(days=EXIT_LOOKBACK_DAYS)
    exited = sc[sc['exited'].notna() & (sc['exited'] <= as_of) & (sc['exited'] > win)]
    bull_x = exited[exited['bias'] == 'bullish'].groupby('symbol').size().rename('bullish_exits_5d')
    bear_x = exited[exited['bias'] == 'bearish'].groupby('symbol').size().rename('bearish_exits_5d')

    active = sc[(sc['appeared'] <= as_of) & (sc['exited'].isna() | (sc['exited'] > as_of))]
    ab = active[active['bias'] == 'bullish']
    tenure = ((as_of - ab['appeared']).dt.days
              .groupby(ab['symbol']).mean().rename('bullish_tenure_days'))
    cnt = ab.groupby('symbol').size().rename('active_bullish')

    out = pd.concat([bull_x, bear_x, tenure, cnt], axis=1).reset_index()
    out = out.rename(columns={out.columns[0]: 'symbol'})
    for c in ('bullish_exits_5d', 'bearish_exits_5d', 'active_bullish'):
        out[c] = out[c].fillna(0).astype(int)
    # THE signal: exits as a share of the symbol's own recent bullish membership. NaN (not 0)
    # when a symbol had no bullish membership at all -- "no support to lose" is not the same
    # statement as "kept all its support", and ranking the two together is what made the raw
    # count weak.
    denom = out['bullish_exits_5d'] + out['active_bullish']
    out['bullish_exit_ratio_5d'] = (out['bullish_exits_5d'] / denom).where(denom > 0)
    return out


def compute_news_events(news: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    """Pure. Trailing-window article count + mean sentiment, with a cross-sectional
    attention percentile (the measured signal is cross-sectional, not a per-symbol level).

    Filters on BOTH published_at and fetched_at (2026-08-10). Publication date alone is not
    point-in-time here: 30.3% of linked articles are fetched more than a day after they were
    published, and MoneyControl's per-stock endpoint in particular returns a backlog whose
    average lag is 315 hours (~13 days). Counting an article at a historical date D when it
    only entered the database weeks later is a look-ahead. Measured both ways -- the signal
    is not a backfill artifact and is in fact STRONGER once corrected: 21d rank IC -0.1032
    (t=-4.97) on published_at alone vs -0.1356 (t=-5.00) point-in-time, because stale
    backfilled articles were diluting a genuine attention effect.
    """
    cols = ['symbol', 'news_count_5d', 'news_sent_5d', 'news_attention_pctile']
    if news.empty:
        return pd.DataFrame(columns=cols)
    n = news.copy()
    n['pub'] = pd.to_datetime(n['published_at'], utc=True, errors='coerce')
    n = n[n['pub'].notna()]
    # IST calendar day: news printed on day D is knowable before the D+1 open, which is
    # where any resulting trade would actually be entered.
    n['date'] = n['pub'].dt.tz_convert('Asia/Kolkata').dt.normalize().dt.tz_localize(None)
    if 'fetched_at' in n.columns:
        fetched = pd.to_datetime(n['fetched_at'], utc=True, errors='coerce')
        n['fdate'] = (fetched.dt.tz_convert('Asia/Kolkata').dt.normalize()
                             .dt.tz_localize(None).fillna(n['date']))
        n = n[n['fdate'] <= as_of]
    win = as_of - pd.Timedelta(days=NEWS_LOOKBACK_DAYS)
    n = n[(n['date'] <= as_of) & (n['date'] > win)]
    if n.empty:
        return pd.DataFrame(columns=cols)
    out = (n.groupby('symbol')
             .agg(news_count_5d=('sentiment_score', 'size'),
                  news_sent_5d=('sentiment_score', 'mean'))
             .reset_index())
    out['news_attention_pctile'] = out['news_count_5d'].rank(pct=True)
    return out


def build_triggers(row) -> str:
    """Human-readable tags for the UI. Deliberately NOT a binary exit flag.

    The first version of this emitted BULL_SCREENER_EXIT whenever any bullish screener was
    lost. Measured on live data that fires on 87% of symbols -- screener membership churns
    every day, so losing one of twenty screens is not an event, it is the base rate. Worse,
    NO threshold on it works: >0.00 fires on 74% (t=-2.33), >0.25 on 52% (t=-1.69), >0.50 on
    17% (t=-0.41) and >0.75 actually flips POSITIVE (+0.485%). The signal lives entirely in
    the CONTINUOUS ratio -- exits as a share of the symbol's own bullish membership, rank IC
    -0.0336 at 21d (t=-5.37) and -0.0193 at 5d (t=-3.76), roughly double the raw count's.

    So the ratio is persisted as a rankable number and only the top DECILE gets a tag, and
    that tag says "ranked", not "event". Same reasoning as delivery_pct earlier this session:
    a level is a characteristic, a change is a signal, and a badly-cut binary is neither.
    """
    t = []
    if (row.get('bullish_exit_ratio_5d') or 0) >= EXIT_RATIO_TOP_DECILE:
        t.append(f"SCREENER_SUPPORT_FADING r{row['bullish_exit_ratio_5d']:.2f}")
    if (row.get('news_attention_pctile') or 0) >= NEWS_CROWDED_PCTILE:
        t.append(f"CROWDED_NEWS p{int(row['news_attention_pctile'] * 100)}")
    return ','.join(t)


def run(as_of: str | None = None, dry_run: bool = False) -> dict:
    as_of = as_of or logical_trading_date()
    ts = pd.Timestamp(as_of)
    con = connect()
    ensure_schema(con)

    sc = _screener_frame(as_of)
    news = read_df(
        "SELECT l.symbol, l.published_at, l.sentiment_score, n.fetched_at "
        "FROM news_symbol_link l LEFT JOIN news_sentiment_items n ON n.id = l.news_id "
        "WHERE l.published_at >= ?",
        ((ts - pd.Timedelta(days=NEWS_LOOKBACK_DAYS + 2)).strftime('%Y-%m-%d'),),
    )

    s_ev = compute_screener_events(sc, ts)
    n_ev = compute_news_events(news, ts)
    df = s_ev.merge(n_ev, on='symbol', how='outer') if not s_ev.empty else n_ev
    if df.empty:
        print('[EventTriggers] no events for', as_of)
        return {'rows': 0}
    df['triggers'] = df.apply(build_triggers, axis=1)

    # Restrict to the tradeable master, mirroring unified_ranker._restrict_to_tradeable_universe.
    # Measured before this filter: 1,884 of 4,181 rows (45%) were symbols absent from
    # nse_stocks, including the raw numeric id 13510368 that this repo has purged from
    # unified_recommendations twice already. A trigger on an untradeable symbol is noise at
    # best and propagates a known corruption artifact at worst. Degrades to unfiltered with a
    # loud warning if nse_stocks is unavailable -- same posture as the ranker.
    try:
        master = read_df('SELECT symbol FROM nse_stocks')
        if not master.empty:
            keep = set(master['symbol'].astype(str))
            before = len(df)
            df = df[df['symbol'].astype(str).isin(keep)]
            if before != len(df):
                print(f"[EventTriggers] universe filter dropped {before - len(df):,} "
                      f"of {before:,} symbols not in nse_stocks")
    except Exception as e:                                      # noqa: BLE001
        print(f"[EventTriggers] universe restriction unavailable ({str(e)[:60]}); unfiltered")
    if df.empty:
        print('[EventTriggers] nothing left after the universe filter for', as_of)
        return {'rows': 0}

    n_exit = int((df.get('bullish_exits_5d', pd.Series(dtype=int)).fillna(0) > 0).sum())
    n_crowd = int((df.get('news_attention_pctile', pd.Series(dtype=float)).fillna(0)
                   >= NEWS_CROWDED_PCTILE).sum())
    print(f"[EventTriggers] {as_of}: {len(df):,} symbols | "
          f"{n_exit:,} exited a bullish screener in {EXIT_LOOKBACK_DAYS}d | "
          f"{n_crowd:,} in the crowded-news top quintile")

    if dry_run:
        print(df.head(12).to_string())
        return {'rows': len(df), 'dry_run': True}

    now = _dt.datetime.now().isoformat(timespec='seconds')
    for r in df.to_dict('records'):
        con.execute(
            f"""INSERT INTO {TABLE}
                (date, symbol, bullish_exits_5d, bullish_exit_ratio_5d, bearish_exits_5d,
                 bullish_tenure_days, active_bullish, news_count_5d, news_sent_5d,
                 news_attention_pctile, triggers, computed_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT (date, symbol) DO UPDATE SET
                  bullish_exits_5d=excluded.bullish_exits_5d,
                  bullish_exit_ratio_5d=excluded.bullish_exit_ratio_5d,
                  bearish_exits_5d=excluded.bearish_exits_5d,
                  bullish_tenure_days=excluded.bullish_tenure_days,
                  active_bullish=excluded.active_bullish,
                  news_count_5d=excluded.news_count_5d,
                  news_sent_5d=excluded.news_sent_5d,
                  news_attention_pctile=excluded.news_attention_pctile,
                  triggers=excluded.triggers,
                  computed_at=excluded.computed_at""",
            (as_of, r['symbol'],
             _i(r.get('bullish_exits_5d')), _f(r.get('bullish_exit_ratio_5d')),
             _i(r.get('bearish_exits_5d')),
             _f(r.get('bullish_tenure_days')), _i(r.get('active_bullish')),
             _i(r.get('news_count_5d')), _f(r.get('news_sent_5d')),
             _f(r.get('news_attention_pctile')), r['triggers'] or None, now),
        )
    # Purge rows this run did NOT produce for this date. An upsert only touches what it
    # writes, so a symbol dropped by the universe filter (or by any future gate) keeps its
    # stale row and stays visible to every consumer forever. Same defect already fixed twice
    # in this repo -- unified_recommendations and intraday_outcome_resolver.
    produced = set(df['symbol'].astype(str))
    stale = [r['symbol'] for r in con.execute(
        f"SELECT symbol FROM {TABLE} WHERE date = ?", (as_of,)).fetchall()
        if str(r['symbol']) not in produced]
    for sym in stale:
        con.execute(f"DELETE FROM {TABLE} WHERE date = ? AND symbol = ?", (as_of, sym))
    if stale:
        print(f"[EventTriggers] purged {len(stale):,} stale rows this run did not produce")
    con.commit()
    return {'rows': len(df), 'bullish_exits': n_exit, 'crowded_news': n_crowd,
            'purged': len(stale)}


def _i(v):
    """int() with a real NaN guard. `int(x or 0)` does NOT work: NaN is TRUTHY, so `NaN or 0`
    evaluates to NaN and int(NaN) raises. Same idiom that caused the 2026-07-31 NaN-score
    incident (`float(x or 0)` silently passing NaN into the ranker)."""
    f = _f(v)
    return 0 if f is None else int(f)


def _f(v):
    try:
        f = float(v)
        return None if pd.isna(f) else f
    except (TypeError, ValueError):
        return None


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--date', default=None)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    print(run(as_of=a.date, dry_run=a.dry_run))
