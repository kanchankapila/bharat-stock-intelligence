"""Results-season preview: which upcoming reporters look set up for good results, and was that right?

Research surface only. It never writes a ranking or a component score (scoring-authority.md); it keeps
an append-only log of what it predicted before each result (`earnings_preview_snapshots`) and two
app_settings snapshots the Earnings Preview page reads:

  earnings_preview           upcoming reporters scored as of the last close, plus this season's graded calls
  earnings_preview_backtest  walk-forward event study over every quarterly result since 2023-03

Every feature is rebuilt as it was knowable at the close of the session BEFORE the price could react
(an announcement after 15:30 IST reacts the next session). The protocol below is frozen: a changed
feature list, sign or bar is a new version, never an in-place re-tune (paper_book.py's convention).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

IST = 'Asia/Kolkata'
PROTOCOL = {
    'version': 'ep-v3',
    'frozen_on': '2026-10-27',
    # ep-v1 (same day, frozen before any result) made the 5-session abnormal reaction its primary outcome.
    'supersedes': {'ep-v1': 'equal-weight composite vs abn_5d FAILED: cohort-week IC -0.013 (t -1.04, 84 weeks); '
                            'vs pat_yoy +0.242 (t 13.8). Results strength is forecastable, the reaction is not.',
                   'ep-v2': 'learned weights let a feature with one closed season (analyst revisions, data from '
                            '2026-06) take 9-12% weight; v3 requires min_seasons per feature. Replaced the same day, '
                            'before any v2 forecast was graded.'},
    # Equal-weight control: sign hypothesis + for each. Context features are reported, never blended.
    'composite_features': ['beat_score_4q', 'prior_pat_yoy', 'peer_pat_yoy', 'peer_reaction_1d',
                           'eps_rev_30d', 'target_rev_30d'],
    'context_features': ['prior_rev_yoy', 'runup_20d', 'news_sent_30d', 'buy_share'],
    # The forecast learns non-negative weights walk-forward from closed cohorts only.
    'forecast_features': ['beat_score_4q', 'prior_pat_yoy', 'prior_rev_yoy', 'peer_pat_yoy', 'peer_reaction_1d',
                          'eps_rev_30d', 'target_rev_30d', 'runup_20d'],
    'min_features': 2,
    'adt_floor_cr': 10.0,
    'cost_round_trip': 0.003,
    'primary_outcome': 'pat_yoy',
    'outcomes': ['pat_yoy', 'beat_actual', 'abn_1d', 'abn_5d'],
    'min_cohort': 15,
    'min_peers': 3,
    'first_season': '2023-03-31',
    'learned': {'min_seasons': 3, 'per_feature_min_seasons': True, 'promote_t': 1.65, 'min_oos_seasons': 3},
    'bars': {'primary_ic_t': 2.0, 'trade_t': 1.65},
    # In-sample discovery on 2026-10-27 (t 2.80 vs other reporters at 5 sessions); graded forward only.
    'price_lead': {'feature': 'runup_20d', 'outcome': 'abn_5d', 'benchmark': 'same-week reporters',
                   'forward_from': '2026-10-28', 'min_cohorts': 10, 'bar_t': 1.65},
}
PROTOCOL_HASH = hashlib.sha256(json.dumps(PROTOCOL, sort_keys=True).encode()).hexdigest()[:16]
PROTOCOL_KEY = 'earnings_preview_protocol'
LIVE_KEY = 'earnings_preview'
BACKTEST_KEY = 'earnings_preview_backtest'
CLOSE = pd.Timedelta(hours=15, minutes=30)


# ── pure helpers (unit-tested) ───────────────────────────────────────────────────────────────────

def reaction_session(broadcast_utc, sessions: pd.DatetimeIndex):
    """First session whose price can react: same day if broadcast before the 15:30 IST close."""
    local = pd.Timestamp(broadcast_utc).tz_convert(IST).tz_localize(None)
    day = local.normalize()
    i = sessions.searchsorted(day, side='right' if local - day >= CLOSE else 'left')
    return sessions[i] if i < len(sessions) else None


def _finite(x) -> bool:
    return x is not None and isinstance(x, (int, float, np.floating, np.integer)) and math.isfinite(x)


def yoy(cur, prev, cap: float = 3.0):
    if not (_finite(cur) and _finite(prev)) or prev == 0:
        return None
    return float(np.clip((cur - prev) / abs(prev), -cap, cap))


def beat_score(hist: pd.DataFrame, period_end: pd.Timestamp, last: int = 4):
    """Mean of +1 beat / 0 inline / -1 miss over up to `last` quarters strictly before period_end."""
    prior = hist[hist['period_end'] < period_end].sort_values('period_end').tail(last)
    return float(prior['beat'].mean()) if len(prior) >= 2 else None


def peer_readthrough(peers: pd.DataFrame, symbol: str, cutoff, col: str, min_peers: int = 3):
    """Median `col` over other reporters already public by the cutoff."""
    known = peers[(peers['symbol'] != symbol) & (peers['broadcast_ts'] <= cutoff) & peers[col].notna()]
    return float(known[col].median()) if len(known) >= min_peers else None


def robust_z(values: np.ndarray, ref: np.ndarray, clip: float = 3.0) -> np.ndarray:
    ref = ref[np.isfinite(ref)]
    values = np.asarray(values, dtype=float)
    if len(ref) < 5:
        return np.full(len(values), np.nan)
    med = np.median(ref)
    mad = 1.4826 * np.median(np.abs(ref - med))
    if not mad:
        mad = np.std(ref) or 1.0
    return np.clip((values - med) / mad, -clip, clip)


def composite(zs: dict, weights: dict, min_features: int = PROTOCOL['min_features']):
    used = [(weights[f], z) for f, z in zs.items() if weights.get(f, 0) > 0 and _finite(z)]
    if len(used) < min_features:
        return None
    total = sum(w for w, _ in used)
    return float(sum(w * z for w, z in used) / total)


def equal_weights(features) -> dict:
    return {f: 1.0 / len(features) for f in features}


def learned_weights(ics: pd.DataFrame, features, as_of: pd.Timestamp,
                    min_seasons: int = PROTOCOL['learned']['min_seasons']):
    """Weights proportional to each feature's positive mean season IC, from cohorts closed before as_of."""
    closed = ics[ics['cohort_end'] < as_of]
    if closed['season'].nunique() < min_seasons:
        return equal_weights(features), False
    by_season = closed.groupby(['feature', 'season'])['ic'].mean().groupby('feature')
    season_ic, seasons = by_season.mean(), by_season.size()
    # A feature with fewer closed seasons than the learner itself needs earns no weight yet.
    raw = {f: max(0.0, float(season_ic.get(f, 0.0))) if seasons.get(f, 0) >= min_seasons else 0.0
           for f in features}
    total = sum(raw.values())
    if total <= 0:
        return equal_weights(features), False
    return {f: v / total for f, v in raw.items()}, True


def cohort_ic(df: pd.DataFrame, score: str, ret: str, min_n: int = PROTOCOL['min_cohort']) -> pd.DataFrame:
    out = []
    for cohort, g in df[['cohort', score, ret]].dropna().groupby('cohort'):
        if len(g) >= min_n and g[score].nunique() > 1:
            out.append({'cohort': cohort, 'ic': float(g[score].rank().corr(g[ret].rank())), 'n': len(g)})
    return pd.DataFrame(out, columns=['cohort', 'ic', 'n'])


def top_quintile_net(df: pd.DataFrame, score: str, ret: str, cost: float = PROTOCOL['cost_round_trip'],
                     min_n: int = PROTOCOL['min_cohort']) -> pd.DataFrame:
    out = []
    for cohort, g in df[['cohort', score, ret]].dropna().groupby('cohort'):
        if len(g) < min_n:
            continue
        top = g.nlargest(len(g) // 5, score)
        out.append({'cohort': cohort, 'n': len(g), 'top_n': len(top), 'net': float(top[ret].mean() - cost),
                    'excess_vs_reporters': float(top[ret].mean() - g[ret].mean())})
    return pd.DataFrame(out, columns=['cohort', 'n', 'top_n', 'net', 'excess_vs_reporters'])


def tstat(x) -> dict:
    x = np.asarray([v for v in x if _finite(v)], dtype=float)
    if len(x) < 2:
        return {'mean': float(x.mean()) if len(x) else None, 't': None, 'n': len(x), 'pos_share': None}
    sd = x.std(ddof=1)
    return {'mean': float(x.mean()), 't': float(x.mean() / (sd / math.sqrt(len(x)))) if sd else None,
            'n': len(x), 'pos_share': float((x > 0).mean())}


# ── loading ──────────────────────────────────────────────────────────────────────────────────────

def _frame(con, sql, params, columns):
    from db_compat import iter_rows
    return pd.DataFrame(list(iter_rows(con, sql, params)), columns=columns)


def load(con, since: str = '2022-09-01') -> dict:
    from mc_symbol_map import MC_TO_SYMBOL_SQL
    px = _frame(con, "SELECT symbol, date, close, volume FROM stock_ohlcv WHERE date >= ? "
                     "AND (is_suspect IS NULL OR is_suspect = 0) AND close > 0", (since,),
                ['symbol', 'date', 'close', 'volume'])
    px['date'] = pd.to_datetime(px['date'])
    px[['close', 'volume']] = px[['close', 'volume']].apply(pd.to_numeric, errors='coerce')
    counts = px.groupby('date').size()
    sessions = pd.DatetimeIndex(counts[counts >= 300].index.sort_values())
    C = px.pivot_table(index='date', columns='symbol', values='close', aggfunc='last').reindex(sessions)
    DV = (px.assign(dv=px['close'] * px['volume'] / 1e7)
          .pivot_table(index='date', columns='symbol', values='dv', aggfunc='last').reindex(sessions))
    ADT = DV.rolling(20, min_periods=15).mean()

    filings = _frame(con, """
        SELECT symbol, period_end, MIN(broadcast_ts) FROM nse_results_filings
        WHERE period_end >= ? AND relating_to <> 'Annual'
          AND (period_start IS NULL OR period_end - period_start < 100) AND broadcast_ts IS NOT NULL
        GROUP BY symbol, period_end""", (PROTOCOL['first_season'],), ['symbol', 'period_end', 'broadcast_ts'])
    nff = _frame(con, "SELECT symbol, period_end, pat, revenue FROM nse_filing_financials "
                      "WHERE parse_error IS NULL", (), ['symbol', 'period_end', 'pat', 'revenue'])
    dal = _frame(con, """
        SELECT symbol, period_end, net_income, revenue, statement_type FROM dalalos_financial_trends_history
        WHERE period_type = 'quarterly' AND period_end >= ?""", ('2021-12-31',),
                 ['symbol', 'period_end', 'pat', 'revenue', 'statement_type'])
    hits = _frame(con, "SELECT symbol, quarter, type FROM mc_estimates_hits_misses", (), ['symbol', 'quarter', 'type'])
    aeh = _frame(con, "SELECT symbol, as_of_date, eps_est_next, target_mean, n_analysts, buy_count "
                      "FROM analyst_estimates_history", (),
                 ['symbol', 'as_of_date', 'eps', 'target', 'n_analysts', 'buy_count'])
    news = _frame(con, "SELECT symbol, published_at, sentiment_score FROM news_symbol_link "
                       "WHERE published_at >= ? AND sentiment_score IS NOT NULL", (since,),
                  ['symbol', 'published_at', 'sentiment'])
    master = _frame(con, "SELECT symbol, name, sector, industry FROM nse_stocks", (),
                    ['symbol', 'name', 'sector', 'industry'])
    upcoming = _frame(con, f"""
        SELECT ns.symbol, MIN(sed.result_date) FROM (
            SELECT scid, result_date, fetched_at::timestamptz AS seen,
                   MAX(fetched_at::timestamptz) OVER (PARTITION BY scid) AS last_seen
            FROM stock_earnings_dates WHERE result_date >= ?) sed
        JOIN {MC_TO_SYMBOL_SQL} ns ON ns.mcsymbol = sed.scid
        WHERE sed.seen >= sed.last_seen - INTERVAL '1 hour'
        GROUP BY ns.symbol""", (sessions[-1].strftime('%Y-%m-%d'),), ['symbol', 'expected_date'])
    concall = _frame(con, "SELECT symbol, quarter, tone_assessment, key_takeaway, announcement_date "
                          "FROM concall_takeaways", (), ['symbol', 'quarter', 'tone', 'takeaway', 'date'])
    return {'sessions': sessions, 'C': C, 'ADT': ADT, 'filings': filings, 'nff': nff, 'dal': dal,
            'hits': hits, 'aeh': aeh, 'news': news, 'master': master, 'upcoming': upcoming, 'concall': concall}


# ── panel construction ───────────────────────────────────────────────────────────────────────────

def growth_table(nff: pd.DataFrame, dal: pd.DataFrame) -> pd.DataFrame:
    """PAT/revenue YoY per (symbol, quarter); first-reported filings XBRL wins over restated dalalos."""
    def one(df, src):
        df = df.copy()
        df['period_end'] = pd.to_datetime(df['period_end'])
        df[['pat', 'revenue']] = df[['pat', 'revenue']].apply(pd.to_numeric, errors='coerce')
        df = df.drop_duplicates(['symbol', 'period_end'])
        prev = df.assign(period_end=df['period_end'] + pd.DateOffset(years=1))
        m = df.merge(prev, on=['symbol', 'period_end'], suffixes=('', '_ly'))
        m['pat_yoy'] = [yoy(a, b) for a, b in zip(m['pat'], m['pat_ly'])]
        m['rev_yoy'] = [yoy(a, b) for a, b in zip(m['revenue'], m['revenue_ly'])]
        return m[['symbol', 'period_end', 'pat_yoy', 'rev_yoy']].assign(growth_src=src)
    dal = dal.sort_values('statement_type').drop(columns='statement_type')  # 'consolidate' before 'standalone'
    g = pd.concat([one(nff, 'filing_xbrl'), one(dal, 'dalalos_restated')])
    return g.drop_duplicates(['symbol', 'period_end'], keep='first').set_index(['symbol', 'period_end'])


def _hits_table(hits: pd.DataFrame) -> dict:
    h = hits.copy()
    h['period_end'] = pd.to_datetime(h['quarter'], format='%b %Y', errors='coerce') + pd.offsets.MonthEnd(0)
    h['beat'] = h['type'].map({'positive': 1, 'inline': 0, 'negative': -1})
    h = h.dropna(subset=['period_end', 'beat']).drop_duplicates(['symbol', 'period_end'])
    return {s: (g['period_end'].values, g['beat'].values.astype(float))
            for s, g in h.sort_values('period_end').groupby('symbol')}


def _series_by_symbol(df, tcol, cols) -> dict:
    return {s: (g[tcol].values,) + tuple(g[c].to_numpy(dtype=float, na_value=np.nan) for c in cols)
            for s, g in df.sort_values(tcol).groupby('symbol')}


def event_panel(d: dict, events: pd.DataFrame) -> pd.DataFrame:
    """Features (as of the pre-reaction close) and outcomes for each (symbol, period_end, ip) event row.

    `events` needs symbol, period_end, broadcast_ts (may be NaT for not-yet-reported), ip (session index
    of the pre-reaction close)."""
    sessions, C, ADT = d['sessions'], d['C'], d['ADT']
    cols = {s: j for j, s in enumerate(C.columns)}
    Cv, Av = C.to_numpy(dtype=float), ADT.to_numpy(dtype=float)
    floor = PROTOCOL['adt_floor_cr']

    def mkt(h):
        if h > 0:
            R = np.full_like(Cv, np.nan)
            R[:-h] = Cv[h:] / Cv[:-h] - 1
        else:
            R = np.full_like(Cv, np.nan)
            R[-h:] = Cv[-h:] / Cv[:h] - 1
        R = np.clip(R, -0.5, 0.5)
        L = np.where(Av >= floor, R, np.nan)
        with np.errstate(all='ignore'):
            return R, np.nanmean(L, axis=1)
    R1, M1 = mkt(1)
    R5, M5 = mkt(5)
    Rb, Mb = mkt(-20)

    ev = events.copy().reset_index(drop=True)
    j = ev['symbol'].map(cols)
    ok = j.notna() & (ev['ip'] >= 20)
    ev = ev[ok].copy()
    j = j[ok].astype(int).values
    ip = ev['ip'].astype(int).values
    ev['pre_session'] = sessions[ip]
    ev['cutoff'] = (ev['pre_session'] + CLOSE).dt.tz_localize(IST).dt.tz_convert('UTC')
    ev['adt_cr'] = Av[ip, j]
    ev['close_pre'] = Cv[ip, j]
    ev['runup_20d'] = Rb[ip, j] - Mb[ip]
    n = len(sessions)
    ev['abn_1d'] = np.where(ip + 1 < n, R1[ip, j] - M1[ip], np.nan)
    ev['abn_5d'] = np.where(ip + 5 < n, R5[ip, j] - M5[ip], np.nan)
    ev['ret_5d'] = np.where(ip + 5 < n, R5[ip, j], np.nan)

    g = growth_table(d['nff'], d['dal'])
    keys = list(zip(ev['symbol'], ev['period_end']))
    ev['pat_yoy'] = [g['pat_yoy'].get(k) for k in keys]
    ev['rev_yoy'] = [g['rev_yoy'].get(k) for k in keys]
    ev['growth_src'] = [g['growth_src'].get(k) for k in keys]

    # prior quarter's growth counts only if that quarter's own filing was public by the cutoff
    filed = d['filings'].assign(period_end=pd.to_datetime(d['filings']['period_end']),
                                broadcast_ts=pd.to_datetime(d['filings']['broadcast_ts'], utc=True))
    filed_at = filed.set_index(['symbol', 'period_end'])['broadcast_ts']
    prev_pe = ev['period_end'] - pd.offsets.QuarterEnd(1)
    prior_pat, prior_rev = [], []
    for s, pe, cut in zip(ev['symbol'], prev_pe, ev['cutoff']):
        b = filed_at.get((s, pe))
        public = b is not None and pd.notna(b) and b <= cut
        prior_pat.append(g['pat_yoy'].get((s, pe)) if public else None)
        prior_rev.append(g['rev_yoy'].get((s, pe)) if public else None)
    ev['prior_pat_yoy'], ev['prior_rev_yoy'] = prior_pat, prior_rev

    hits = _hits_table(d['hits'])
    bs = []
    for s, pe in zip(ev['symbol'], ev['period_end'].values):
        h = hits.get(s)
        if h is None:
            bs.append(None)
            continue
        prior = h[1][h[0] < pe][-4:]
        bs.append(float(prior.mean()) if len(prior) >= 2 else None)
    ev['beat_score_4q'] = bs
    ev['beat_actual'] = [None if (h := hits.get(s)) is None else
                         next((float(b) for p, b in zip(*h) if p == pe), None)
                         for s, pe in zip(ev['symbol'], ev['period_end'].values)]

    aeh = d['aeh'].assign(as_of_date=pd.to_datetime(d['aeh']['as_of_date']))
    an = _series_by_symbol(aeh, 'as_of_date', ['eps', 'target', 'n_analysts', 'buy_count'])
    eps_rev, tgt_rev, buy_share, tgt_upside = [], [], [], []
    for s, day, px in zip(ev['symbol'], ev['pre_session'].values, ev['close_pre']):
        a = an.get(s)
        vals = [None, None, None, None]
        if a is not None:
            t = a[0]
            i = t.searchsorted(day, side='right') - 1
            k = t.searchsorted(day - np.timedelta64(30, 'D'), side='right') - 1
            if i >= 0:
                if a[3][i] >= 3:
                    vals[2] = float(a[4][i] / a[3][i])
                if _finite(a[2][i]) and px:
                    vals[3] = float(a[2][i] / px - 1)
                if 0 <= k < i and t[k] >= day - np.timedelta64(45, 'D'):
                    for slot, col in ((0, 1), (1, 2)):
                        r = yoy(a[col][i], a[col][k], cap=0.5)
                        vals[slot] = r
        eps_rev.append(vals[0]); tgt_rev.append(vals[1]); buy_share.append(vals[2]); tgt_upside.append(vals[3])
    ev['eps_rev_30d'], ev['target_rev_30d'], ev['buy_share'], ev['target_upside'] = eps_rev, tgt_rev, buy_share, tgt_upside

    news = d['news'].assign(published_at=pd.to_datetime(d['news']['published_at'], utc=True))
    news['sentiment'] = pd.to_numeric(news['sentiment'], errors='coerce')
    nw = {s: (g['published_at'].values, np.r_[0, np.cumsum(g['sentiment'].fillna(0).values)])
          for s, g in news.sort_values('published_at').groupby('symbol')}
    sent = []
    for s, cut in zip(ev['symbol'], ev['cutoff']):
        a = nw.get(s)
        if a is None:
            sent.append(None)
            continue
        c = np.datetime64(cut.tz_convert('UTC').tz_localize(None))
        hi, lo = a[0].searchsorted(c, side='right'), a[0].searchsorted(c - np.timedelta64(30, 'D'), side='right')
        sent.append(float((a[1][hi] - a[1][lo]) / (hi - lo)) if hi - lo >= 3 else None)
    ev['news_sent_30d'] = sent

    num = ['pat_yoy', 'rev_yoy', 'prior_pat_yoy', 'prior_rev_yoy', 'beat_score_4q', 'beat_actual', 'eps_rev_30d',
           'target_rev_30d', 'buy_share', 'target_upside', 'news_sent_30d']
    ev[num] = ev[num].astype(float)
    master = d['master'].drop_duplicates('symbol').set_index('symbol')
    ev['sector'] = ev['symbol'].map(master['sector'])
    ev['industry'] = ev['symbol'].map(master['industry'])
    ev['name'] = ev['symbol'].map(master['name'])
    return ev.reset_index(drop=True)


def add_peer_readthrough(ev: pd.DataFrame, reported: pd.DataFrame) -> pd.DataFrame:
    """Median growth / 1-day reaction of same-industry (else same-sector) peers public by each cutoff."""
    k = PROTOCOL['min_peers']
    by = {}
    for level in ('industry', 'sector'):
        for (pe, grp), g in reported.dropna(subset=[level]).groupby(['period_end', level]):
            by[(level, pe, grp)] = (g['symbol'].values, g['broadcast_ts'].values, g['reaction_known'].values,
                                    g['pat_yoy'].to_numpy(dtype=float, na_value=np.nan),
                                    g['abn_1d'].to_numpy(dtype=float, na_value=np.nan))
    out_g, out_r = [], []
    for s, pe, ind, sec, cut in zip(ev['symbol'], ev['period_end'], ev['industry'], ev['sector'], ev['cutoff']):
        c = np.datetime64(cut.tz_convert('UTC').tz_localize(None))
        vg = vr = None
        for level, grp in (('industry', ind), ('sector', sec)):
            p = by.get((level, pe, grp))
            if p is None:
                continue
            other = p[0] != s
            if vg is None:
                m = other & (p[1] <= c) & np.isfinite(p[3])
                vg = float(np.median(p[3][m])) if m.sum() >= k else None
            if vr is None:
                m = other & (p[2] <= c) & np.isfinite(p[4])
                vr = float(np.median(p[4][m])) if m.sum() >= k else None
        out_g.append(vg)
        out_r.append(vr)
    ev = ev.copy()
    ev['peer_pat_yoy'] = np.array(out_g, dtype=float)
    ev['peer_reaction_1d'] = np.array(out_r, dtype=float)
    return ev


def _reported_view(panel: pd.DataFrame, sessions: pd.DatetimeIndex) -> pd.DataFrame:
    r = panel[['symbol', 'period_end', 'industry', 'sector', 'broadcast_ts', 'pat_yoy', 'abn_1d', 'ip']].copy()
    r['broadcast_ts'] = pd.to_datetime(r['broadcast_ts'], utc=True).dt.tz_localize(None)
    react = sessions[np.minimum(r['ip'].values + 1, len(sessions) - 1)]
    r['reaction_known'] = (pd.DatetimeIndex(react) + CLOSE).tz_localize(IST).tz_convert('UTC').tz_localize(None)
    return r


def build_history(d: dict) -> pd.DataFrame:
    sessions = d['sessions']
    f = d['filings'].copy()
    f['period_end'] = pd.to_datetime(f['period_end'])
    f['broadcast_ts'] = pd.to_datetime(f['broadcast_ts'], utc=True)
    f = f[(f['broadcast_ts'].dt.tz_localize(None) - f['period_end']) <= pd.Timedelta(days=100)]
    t0 = [reaction_session(b, sessions) for b in f['broadcast_ts']]
    f['t0'] = t0
    f = f[f['t0'].notna()].copy()
    f['ip'] = sessions.searchsorted(pd.DatetimeIndex(f['t0'])) - 1
    panel = event_panel(d, f)
    panel = add_peer_readthrough(panel, _reported_view(panel, sessions))
    t0 = pd.DatetimeIndex(sessions[panel['ip'].values + 1])
    iso = t0.isocalendar()
    panel['cohort'] = (panel['period_end'].dt.strftime('%Y-%m-%d') + '|' + iso['year'].astype(str).values
                       + '-W' + iso['week'].astype(str).str.zfill(2).values)
    panel['reaction_session'] = t0
    return panel


def _all_features():
    return list(dict.fromkeys(PROTOCOL['composite_features'] + PROTOCOL['forecast_features']
                              + PROTOCOL['context_features']))


def add_scores(panel: pd.DataFrame, reference: pd.DataFrame | None = None, weights_learned: dict | None = None):
    """Robust z per feature against strictly earlier seasons (the current season itself when none exist)."""
    panel = panel.copy()
    ref = panel if reference is None else reference
    for f in _all_features():
        z = np.full(len(panel), np.nan)
        for pe in panel['period_end'].unique():
            m = (panel['period_end'] == pe).values
            prior = ref.loc[ref['period_end'] < pe, f].to_numpy(dtype=float, na_value=np.nan)
            if np.isfinite(prior).sum() < 200:
                prior = ref.loc[ref['period_end'] == pe, f].to_numpy(dtype=float, na_value=np.nan)
            z[m] = robust_z(panel.loc[m, f].to_numpy(dtype=float, na_value=np.nan), prior)
        panel['z_' + f] = z
    cf, ff = PROTOCOL['composite_features'], PROTOCOL['forecast_features']
    eq = equal_weights(cf)
    zrows = panel[['z_' + f for f in cf]].to_numpy()
    panel['n_features'] = np.isfinite(panel[['z_' + f for f in ff]].to_numpy()).sum(axis=1)
    panel['score_eq'] = np.array([composite(dict(zip(cf, r)), eq) for r in zrows], dtype=float)
    if weights_learned is not None:
        frows = panel[['z_' + f for f in ff]].to_numpy()
        panel['score_learned'] = np.array([composite(dict(zip(ff, r)), weights_learned) for r in frows], dtype=float)
    return panel


# ── backtest ─────────────────────────────────────────────────────────────────────────────────────

def _feature_ics(liq: pd.DataFrame, outcome: str) -> pd.DataFrame:
    rows = []
    cohort_end = liq.groupby('cohort')['reaction_session'].max() + pd.Timedelta(days=8)
    season = liq.groupby('cohort')['period_end'].first()
    for f in _all_features():
        ic = cohort_ic(liq, 'z_' + f, outcome)
        if ic.empty:
            continue
        ic['feature'] = f
        ic['season'] = ic['cohort'].map(season).values
        ic['cohort_end'] = ic['cohort'].map(cohort_end).values
        rows.append(ic)
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(
        columns=['cohort', 'ic', 'n', 'feature', 'season', 'cohort_end'])


def walk_forward_learned(panel: pd.DataFrame, ics: pd.DataFrame) -> tuple[pd.Series, list]:
    """Each season is scored with weights learned only from cohorts closed before its first reaction."""
    ff = PROTOCOL['forecast_features']
    learned = pd.Series(np.nan, index=panel.index)
    history = []
    for pe, g in panel.groupby('period_end'):
        w, is_learned = learned_weights(ics, ff, g['reaction_session'].min())
        history.append({'season': pe.strftime('%Y-%m-%d'), 'learned': is_learned, 'weights': w})
        zrows = g[['z_' + f for f in ff]].to_numpy()
        learned.loc[g.index] = np.array([composite(dict(zip(ff, r)), w) if is_learned else None for r in zrows],
                                        dtype=float)
    return learned, history


def _summ(liq, score, outcome):
    ic = cohort_ic(liq, score, outcome)
    q = liq[[score, outcome, 'cohort']].dropna()
    q = q.assign(quint=q.groupby('cohort')[score].transform(
        lambda s: pd.qcut(s.rank(method='first'), 5, labels=False) if len(s) >= 5 else np.nan))
    quint = q.groupby('quint')[outcome].mean()
    out = {'ic': tstat(ic['ic']), 'cohorts': len(ic), 'events': int(ic['n'].sum()) if len(ic) else 0,
           'quintile_mean': {str(int(k) + 1): float(v) for k, v in quint.items()}}
    if outcome.startswith('abn_'):
        tq = top_quintile_net(liq, score, outcome)
        out.update({'top_quintile_net': tstat(tq['net']), 'top_vs_reporters': tstat(tq['excess_vs_reporters'])})
    return out


def calibration(liq: pd.DataFrame, score: str, bins: int = 10) -> dict:
    """What historically followed each decile of the walk-forward score: the page's per-stock odds."""
    x = liq[liq[score].notna()]
    if len(x) < bins * 30:
        return {'edges': [], 'deciles': []}
    edges = np.quantile(x[score], np.linspace(0, 1, bins + 1)[1:-1])
    dec = np.searchsorted(edges, x[score], side='right')
    rows = []
    for k in range(bins):
        g = x[dec == k]
        covered = g['beat_actual'].dropna()
        grown = g['pat_yoy'].dropna()
        rows.append({'decile': k + 1, 'n': len(g), 'pat_yoy_median': _jsonable(grown.median()),
                     'p_growth_positive': _jsonable((grown > 0).mean()),
                     'p_growth_over_20pct': _jsonable((grown > 0.2).mean()),
                     'p_beat': _jsonable((covered == 1).mean()) if len(covered) >= 20 else None,
                     'p_miss': _jsonable((covered == -1).mean()) if len(covered) >= 20 else None,
                     'beat_n': len(covered),
                     'abn_1d_mean': _jsonable(g['abn_1d'].mean()), 'abn_5d_mean': _jsonable(g['abn_5d'].mean())})
    return {'edges': [float(e) for e in edges], 'deciles': rows}


def price_lead(liq: pd.DataFrame) -> dict:
    p = PROTOCOL['price_lead']
    tq = top_quintile_net(liq, 'z_' + p['feature'], p['outcome'])
    tq['first'] = tq['cohort'].map(liq.groupby('cohort')['reaction_session'].min())
    start = pd.Timestamp(p['forward_from'])
    fwd = tq[tq['first'] >= start]
    f = tstat(fwd['excess_vs_reporters'])
    state = ('LOW-DATA' if f['n'] < p['min_cohorts'] else
             'PASS' if f['t'] is not None and f['t'] >= p['bar_t'] else 'FAIL')
    return {'in_sample': tstat(tq.loc[tq['first'] < start, 'excess_vs_reporters']),
            'forward': f, 'forward_state': state, 'rule': p}


def run_backtest(panel: pd.DataFrame) -> tuple[dict, pd.DataFrame, dict]:
    liq = panel[panel['adt_cr'] >= PROTOCOL['adt_floor_cr']].copy()
    liq = add_scores(liq)
    po = PROTOCOL['primary_outcome']
    ics = _feature_ics(liq, po)
    liq['score_learned'], weight_history = walk_forward_learned(liq, ics)
    feats = {}
    for f in _all_features():
        role = ('forecast+control' if f in PROTOCOL['composite_features'] and f in PROTOCOL['forecast_features']
                else 'forecast' if f in PROTOCOL['forecast_features'] else 'context')
        feats[f] = {'role': role, 'coverage': float(liq[f].notna().mean()),
                    **{o: tstat(cohort_ic(liq, 'z_' + f, o)['ic']) for o in PROTOCOL['outcomes']}}
    composite_eq = {o: _summ(liq, 'score_eq', o) for o in PROTOCOL['outcomes']}
    composite_learned = {o: _summ(liq, 'score_learned', o) for o in PROTOCOL['outcomes']}
    paired = cohort_ic(liq, 'score_learned', po).merge(cohort_ic(liq, 'score_eq', po), on='cohort',
                                                        suffixes=('_l', '_e'))
    paired['season'] = paired['cohort'].str.split('|').str[0]
    diff = tstat(paired['ic_l'] - paired['ic_e'])
    oos_seasons = int(paired['season'].nunique())
    lp = PROTOCOL['learned']
    promote = bool(oos_seasons >= lp['min_oos_seasons'] and diff['t'] is not None and diff['t'] >= lp['promote_t'])
    primary_score = 'score_learned' if promote else 'score_eq'
    by_season = []
    for pe, g in liq.groupby('period_end'):
        by_season.append({'season': pe.strftime('%Y-%m-%d'), 'events': int(len(g)),
                          'scored': int(g[primary_score].notna().sum()),
                          'forecast_ic': tstat(cohort_ic(g, primary_score, po)['ic']),
                          'reaction_5d_ic': tstat(cohort_ic(g, primary_score, 'abn_5d')['ic'])})
    bars = PROTOCOL['bars']
    main = composite_learned if promote else composite_eq
    p5 = main['abn_5d']
    verdict = {
        'forecast_ic_pass': bool(main[po]['ic']['t'] is not None and main[po]['ic']['t'] >= bars['primary_ic_t']),
        'reaction_tradeable_pass': bool(p5['top_quintile_net']['t'] is not None and p5['top_quintile_net']['mean'] > 0
                                        and p5['top_quintile_net']['t'] >= bars['trade_t']),
        'learned_promoted': promote, 'primary_score': primary_score,
        'learned_vs_equal_ic_diff': diff, 'learned_oos_seasons': oos_seasons,
    }
    labels = {1.0: 'beat', 0.0: 'inline', -1.0: 'miss'}
    report = {'protocol': PROTOCOL, 'protocol_hash': PROTOCOL_HASH, 'state': 'RESEARCH_ONLY',
              'events_total': int(len(panel)), 'events_liquid': int(len(liq)),
              'seasons': int(liq['period_end'].nunique()),
              'first_reaction': str(liq['reaction_session'].min().date()),
              'last_reaction': str(liq['reaction_session'].max().date()),
              'features': feats, 'composite_equal': composite_eq, 'composite_learned': composite_learned,
              'by_season': by_season, 'weight_history': weight_history, 'verdict': verdict,
              'calibration': calibration(liq, primary_score), 'price_lead': price_lead(liq),
              'reaction_by_outcome': {
                  'mean': liq.groupby('beat_actual')[['abn_1d', 'abn_5d']].mean().rename(index=labels).to_dict('index'),
                  'n': liq['beat_actual'].value_counts().rename(index=labels).to_dict()},
              'growth_sources': liq['growth_src'].value_counts().to_dict(),
              'evidence': ('Cohort = one results week; t-stats are over cohort-weeks, not events. Growth is PAT YoY '
                           '(first-reported filing XBRL where parsed, else restated dalalos). Reactions are '
                           'close-to-close vs the equal-weight liquid universe; net subtracts a 0.30% round trip.')}
    current_w, current_learned = learned_weights(ics, PROTOCOL['forecast_features'], pd.Timestamp.now())
    return report, liq, {'weights': current_w, 'learned': current_learned, 'primary': 'learned' if promote else 'equal'}


# ── live ─────────────────────────────────────────────────────────────────────────────────────────

def live_snapshot(d: dict, history: pd.DataFrame, liq: pd.DataFrame, model: dict, horizon_days: int = 21) -> dict:
    sessions = d['sessions']
    last = sessions[-1]
    up = d['upcoming'].copy()
    up['expected_date'] = pd.to_datetime(up['expected_date'])
    up = up[(up['expected_date'] > last) & (up['expected_date'] <= last + pd.Timedelta(days=horizon_days))]
    up['period_end'] = up['expected_date'] - pd.offsets.QuarterEnd(1)
    done = set(zip(history['symbol'], history['period_end']))
    up = up[[k not in done for k in zip(up['symbol'], up['period_end'])]].copy()
    up['broadcast_ts'] = pd.NaT
    up['ip'] = len(sessions) - 1
    panel = event_panel(d, up)
    panel = add_peer_readthrough(panel, _reported_view(history, sessions))
    ref = liq[liq['period_end'] < panel['period_end'].min()] if len(panel) else liq
    panel = add_scores(panel, reference=pd.concat([ref, panel]) if len(ref) < 200 else ref,
                       weights_learned=model['weights'] if model['learned'] else None)
    if 'score_learned' not in panel:
        panel['score_learned'] = np.nan
    primary = 'score_learned' if model['primary'] == 'learned' else 'score_eq'
    hist_scores = liq[primary].dropna().to_numpy()
    panel['score'] = panel[primary]
    panel['score_pct'] = [float((hist_scores < s).mean() * 100) if _finite(s) and len(hist_scores) else None
                          for s in panel[primary]]
    calib = model.get('calibration') or {'edges': [], 'deciles': []}
    odds = {r['decile']: r for r in calib['deciles']}
    panel['decile'] = [int(np.searchsorted(calib['edges'], s, side='right')) + 1 if _finite(s) and calib['edges']
                       else None for s in panel[primary]]
    for col in ('p_growth_positive', 'p_growth_over_20pct', 'p_beat', 'pat_yoy_median'):
        panel['hist_' + col] = [odds.get(k, {}).get(col) if k else None for k in panel['decile']]
    concall = d['concall'].sort_values('date').drop_duplicates('symbol', keep='last').set_index('symbol')
    panel['concall_tone'] = panel['symbol'].map(concall['tone'])
    panel['concall_takeaway'] = panel['symbol'].map(concall['takeaway']).str.slice(0, 500)

    season = panel['period_end'].mode().iloc[0] if len(panel) else history['period_end'].max()
    reported = liq[liq['period_end'] == season].copy()
    reported['score'] = reported[primary]
    reported['decile'] = [int(np.searchsorted(calib['edges'], s, side='right')) + 1 if _finite(s) and calib['edges']
                          else None for s in reported['score']]
    return {'as_of_session': str(last.date()), 'season': str(pd.Timestamp(season).date()),
            'primary_model': model['primary'], 'weights': model['weights'], 'weights_learned': model['learned'],
            'upcoming': panel, 'reported': reported}


SNAPSHOT_COLS = ['symbol', 'name', 'sector', 'industry', 'expected_date', 'period_end', 'adt_cr', 'close_pre',
                 'score', 'score_eq', 'score_learned', 'score_pct', 'decile', 'hist_p_growth_positive',
                 'hist_p_growth_over_20pct', 'hist_p_beat', 'hist_pat_yoy_median', 'n_features', 'beat_score_4q',
                 'prior_pat_yoy',
                 'prior_rev_yoy', 'peer_pat_yoy', 'peer_reaction_1d', 'eps_rev_30d', 'target_rev_30d',
                 'buy_share', 'target_upside', 'runup_20d', 'news_sent_30d', 'concall_tone', 'concall_takeaway']
REPORTED_COLS = ['symbol', 'name', 'sector', 'broadcast_ts', 'pre_session', 'reaction_session', 'adt_cr',
                 'score', 'decile', 'score_eq', 'runup_20d',
                 'score_learned', 'n_features', 'beat_score_4q', 'prior_pat_yoy', 'peer_pat_yoy',
                 'peer_reaction_1d', 'eps_rev_30d', 'pat_yoy', 'rev_yoy', 'growth_src', 'beat_actual',
                 'abn_1d', 'abn_5d', 'ret_5d']


def _jsonable(v):
    if isinstance(v, (pd.Timestamp, datetime)):
        return None if pd.isna(v) else v.isoformat()
    if isinstance(v, (np.floating, float)):
        return float(v) if math.isfinite(v) else None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if v is pd.NaT or (not isinstance(v, str) and v is not None and pd.isna(v)):
        return None
    return v


def _records(df: pd.DataFrame, cols) -> list:
    return [{c: _jsonable(r[c]) for c in cols} for r in df[cols].to_dict('records')]


def logged_predictions(con, season: str) -> pd.DataFrame:
    if con.execute("SELECT to_regclass('earnings_preview_snapshots') AS t").fetchone()[0] is None:
        print('[earnings_preview] earnings_preview_snapshots missing: run npm run migrate:up', file=sys.stderr)
        return pd.DataFrame(columns=['symbol', 'as_of_date', 'score', 'score_learned'])
    rows = con.execute("SELECT symbol, as_of_date, score, score_learned FROM earnings_preview_snapshots "
                       "WHERE period_end = ? AND model_version = ?", (season, PROTOCOL['version'])).fetchall()
    df = pd.DataFrame([dict(r) for r in rows])
    if df.empty:
        return pd.DataFrame(columns=['symbol', 'as_of_date', 'score', 'score_learned'])
    df['as_of_date'] = pd.to_datetime(df['as_of_date'])
    return df


def grade_live(reported: pd.DataFrame, logged: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Attach the last prediction logged on or before each reporter's pre-reaction close."""
    r = reported.copy()
    r['logged_score'] = np.nan
    r['logged_as_of'] = None
    if len(logged):
        by = {s: g.sort_values('as_of_date') for s, g in logged.groupby('symbol')}
        for i, (s, pre) in enumerate(zip(r['symbol'], r['pre_session'])):
            g = by.get(s)
            if g is None:
                continue
            g = g[g['as_of_date'] <= pre]
            if len(g):
                r.iat[i, r.columns.get_loc('logged_score')] = g['score'].iloc[-1]
                r.iat[i, r.columns.get_loc('logged_as_of')] = str(g['as_of_date'].iloc[-1].date())
    summary = {}
    for col, label in (('logged_score', 'logged'), ('score', 'reconstructed')):
        for o in ('abn_1d', 'abn_5d', 'pat_yoy'):
            x = r[[col, o]].dropna()
            summary[f'{label}_{o}'] = {'n': len(x), 'rank_ic': float(x[col].rank().corr(x[o].rank()))
                                       if len(x) >= 10 else None}
        top = r[r[col].notna()]
        if len(top) >= 10:
            cut = top[col].quantile(0.8)
            t, rest = top[top[col] >= cut], top[top[col] < cut]
            summary[f'{label}_top_quintile'] = {
                'n': len(t), 'abn_1d': _jsonable(t['abn_1d'].mean()), 'rest_abn_1d': _jsonable(rest['abn_1d'].mean()),
                'abn_5d': _jsonable(t['abn_5d'].mean()), 'rest_abn_5d': _jsonable(rest['abn_5d'].mean()),
                'pat_yoy_median': _jsonable(t['pat_yoy'].median()), 'rest_pat_yoy_median': _jsonable(rest['pat_yoy'].median())}
    return r, summary


def persist_snapshots(con, upcoming: pd.DataFrame, as_of: str) -> int:
    rows = []
    for r in upcoming.to_dict('records'):
        feats = {c: _jsonable(r.get(c)) for c in _all_features() + ['adt_cr', 'close_pre', 'target_upside']}
        rows.append((as_of, r['symbol'], str(pd.Timestamp(r['period_end']).date()), PROTOCOL['version'],
                     str(pd.Timestamp(r['expected_date']).date()), _jsonable(r['score']), _jsonable(r['score_eq']),
                     _jsonable(r.get('score_learned')), _jsonable(r.get('score_pct')), _jsonable(r.get('decile')),
                     int(r['n_features']), json.dumps(feats, allow_nan=False)))
    for row in rows:
        con.execute("INSERT INTO earnings_preview_snapshots (as_of_date, symbol, period_end, model_version, "
                    "expected_date, score, score_eq, score_learned, score_pct, decile, n_features, features) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", row)
    return len(rows)


def _put_setting(con, key, value):
    con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                (key, json.dumps(_jsonable(value), allow_nan=False)))


def protocol_registry(stored: dict | None, version: str = PROTOCOL['version'], digest: str = PROTOCOL_HASH,
                      protocol: dict = PROTOCOL) -> tuple[dict | None, bool]:
    """(registry to write or None, drifted). A known version must keep its hash; a new version is appended."""
    versions = dict((stored or {}).get('versions') or {})
    if stored and 'hash' in stored and 'versions' not in stored:  # single-hash form written by ep-v2
        versions[stored.get('protocol', {}).get('version', 'ep-v2')] = {'hash': stored['hash']}
    if version in versions:
        return None, versions[version]['hash'] != digest
    versions[version] = {'hash': digest, 'frozen_on': protocol.get('frozen_on')}
    return {'versions': versions, 'current': version, 'protocol': protocol}, False


def check_protocol(con) -> None:
    row = con.execute("SELECT value FROM app_settings WHERE key = ?", (PROTOCOL_KEY,)).fetchone()
    registry, drifted = protocol_registry(json.loads(dict(row)['value']) if row else None)
    if drifted:
        print(f'[earnings_preview] protocol drift: {PROTOCOL["version"]} is registered with a different hash than '
              f'code {PROTOCOL_HASH}; bump the version instead of re-tuning in place', file=sys.stderr)
        sys.exit(2)
    if registry is not None:
        _put_setting(con, PROTOCOL_KEY, registry)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--persist', action='store_true')
    args = ap.parse_args()
    from db_compat import connect
    con = connect()
    try:
        con.execute("SET statement_timeout = '300s'")
        if args.persist:
            check_protocol(con)
        d = load(con)
        history = build_history(d)
        report, liq, model = run_backtest(history)
        model['calibration'] = report['calibration']
        live = live_snapshot(d, history, liq, model)
        logged = logged_predictions(con, live['season'])
        graded, live_summary = grade_live(live['reported'], logged)
        payload = {k: v for k, v in live.items() if k not in ('upcoming', 'reported')}
        payload.update({
            'state': 'RESEARCH_ONLY', 'protocol_hash': PROTOCOL_HASH,
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'upcoming': _records(live['upcoming'].sort_values('expected_date'), SNAPSHOT_COLS),
            'reported': _records(graded.sort_values('broadcast_ts', ascending=False),
                                 REPORTED_COLS + ['logged_score', 'logged_as_of']),
            'live_grading': live_summary,
            'backtest_verdict': report['verdict'],
        })
        report['generated_at'] = payload['generated_at']
        if args.persist:
            n = persist_snapshots(con, live['upcoming'], live['as_of_session'])
            _put_setting(con, BACKTEST_KEY, report)
            _put_setting(con, LIVE_KEY, payload)
            con.commit()
            print(f'[earnings_preview] logged {n} upcoming predictions for {live["as_of_session"]}', file=sys.stderr)
        main_summary = report['composite_learned' if model['primary'] == 'learned' else 'composite_equal']
        print(json.dumps(_jsonable({'events_liquid': report['events_liquid'], 'seasons': report['seasons'],
                                    'forecast': main_summary[PROTOCOL['primary_outcome']],
                                    'reaction_5d': main_summary['abn_5d'], 'price_lead': report['price_lead'],
                                    'verdict': report['verdict'],
                                    'upcoming': len(payload['upcoming']), 'reported': len(payload['reported'])}),
                         indent=1))
    finally:
        con.close()


if __name__ == '__main__':
    main()
