"""
End-to-end lifecycle check for N stocks (default: 10 top movers)
================================================================

Traces real symbols through every stage that feeds the canonical Buy/Sell/Hold call, by
CALLING unified_ranker.py's own getters rather than reimplementing their SQL (a test that
reimplements the logic under test passes against the unfixed source -- recurring-bugs.md).

WARNING: this is a PLUMBING check, not an edge check. A green run says every stage produced
values for these names. It says nothing about whether those values predict anything -- see
.claude/rules/measurement.md, where unified_score's 5d rank IC is ~0.0001.

WARNING: "it printed Buy/Sell/Hold" is NOT the pass condition, deliberately. On 2026-08-17 one
missing advisory table made run() classify the ENTIRE universe as Hold and exit 0. Hold is a
valid label. The verdict here is per-stage, on three axes, because each catches a failure the
others read as healthy:

  alive     -- map non-empty universe-wide, and _degraded_count did not rise (a getter that
               swallowed an exception returns {} and "succeeds")
  fresh     -- the newest row is within a tolerance. bool(COUNT(*)) only asks "did this table
               EVER have a row"; a pipeline dead for a month passes that and still prints
               Buy/Sell/Hold for all 10 names. ("A fresh table is not a delivered feature",
               and a monitor that can never fire reads as health -- recurring-bugs.md.)
  coverage  -- these symbols present in a live stage. A gap here is reported, NOT fatal: a
               stage legitimately has no row for every name.

Read-only by default. --run-ranker re-runs unified_ranker.py first, which is a PRODUCTION
WRITE (it appends a snapshot to unified_recommendations_history); no engine takes --symbols,
so that step is universe-wide or nothing.

Run:  backend-python/venv/Scripts/python.exe src/server/e2e_lifecycle_check.py
      ... --n 10 --symbols RELIANCE,INFY --run-ranker --json out.json
"""
import polars as pl
import argparse
import json
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

from db_compat import connect
import as_of
from unified_ranker import UnifiedRanker

# A stage can keep its row count and still have collapsed (2,201 -> 40) -- bool(map) cannot see
# that. Crude absolute floor rather than a per-stage ratio: legitimate universes here run
# 490-4,998, so this only ever fires on a real collapse.
MIN_UNIVERSE = 100


def _age_days(value):
    """Days between `value` (a date/timestamp, or its text form) and today. None if unparseable.
    Negative when the value is ahead of today -- logical_session_date() legitimately rolls a
    weekend run forward to the next session, so unified_recommendations can be dated ahead."""
    if value is None:
        return None
    if isinstance(value, datetime):
        d = value.date()
    elif isinstance(value, date):
        d = value
    else:
        try:
            d = datetime.fromisoformat(str(value).replace('Z', '+00:00').replace(' ', 'T')).date()
        except ValueError:
            try:
                d = date.fromisoformat(str(value)[:10])
            except ValueError:
                return None
    return (date.today() - d).days


def stage_verdict(n_rows, degraded=False, age_days=None, max_age_days=None,
                  min_universe=MIN_UNIVERSE):
    """The whole pass/fail decision for one stage, in one place so it is testable without a DB.

    Returns (alive, note). `degraded` is the one that matters most: a ranker getter that
    swallowed an exception can still return a populated map (only one of its sub-queries
    failed), so row count alone reads that as healthy. age_days may be NEGATIVE -- a weekend
    run legitimately reads the next session's rows via logical_session_date()."""
    if not n_rows:
        return False, 'EMPTY'
    if degraded:
        return False, 'DEGRADED (a swallowed error inside the getter)'
    if min_universe and n_rows < min_universe:
        return False, 'COLLAPSED (<%d)' % min_universe
    if max_age_days is not None and (age_days is None or age_days > max_age_days):
        return False, 'STALE (age=%s d, max=%s)' % (age_days, max_age_days)
    return True, None


def pick_movers(rk, n):
    """Top |move| names ON the latest session, restricted to the ranker's own tradeable
    universe. Raw top movers are illiquid microcaps the ranker correctly refuses to rank, so
    selecting that way self-selects names that FAIL for reasons that are the pipeline working
    as designed (measurement.md records 3 of 15 real movers with no ranker row at all).

    Takes the live ranker instance, not a throwaway one: _restrict_to_tradeable_universe
    degrades by returning `symbols` UNFILTERED and bumping _degraded_count, so on a throwaway
    instance the fallback to raw microcaps would be invisible."""
    rows = rk.conn.execute("""
        SELECT symbol, (close - open) / NULLIF(open, 0) * 100 AS pct,
               close * volume / 1e7 AS turnover_cr
        FROM stock_ohlcv
        WHERE date = (SELECT MAX(date) FROM stock_ohlcv)
          AND COALESCE(is_suspect, 0) = 0 AND open > 0 AND close * volume >= 1e7
        ORDER BY ABS((close - open) / NULLIF(open, 0)) DESC
        LIMIT 500
    """).fetchall()
    ranked = [(r['symbol'], float(r['pct']), float(r['turnover_cr'])) for r in rows]
    tradeable = rk._restrict_to_tradeable_universe({s for s, _, _ in ranked})
    return [t for t in ranked if t[0] in tradeable][:n], len(tradeable)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=10)
    ap.add_argument('--symbols', help='comma-separated; overrides top-mover selection')
    ap.add_argument('--run-ranker', action='store_true',
                    help='re-run unified_ranker.py first (PRODUCTION WRITE, universe-wide)')
    ap.add_argument('--json', help='write the full report here')
    args = ap.parse_args()

    conn = connect()
    # Bounded server-side, because a client-side timeout ORPHANS the server query (that once
    # held a lock for 2h15m). Generous, though: _get_confluence_scores alone takes ~15s over
    # confluence_signals' 4.5M rows, and a tight bound turns DB contention into a false FAIL.
    conn.execute("SET statement_timeout = '180s'")
    rk = UnifiedRanker(conn=conn)

    # _degraded() only prints to stderr, so a FAIL's actual reason is lost the moment stderr is
    # not captured. Record it too -- keep calling the original so the stderr hook still fires.
    degrade_log = []
    _degraded_orig = rk._degraded
    def _degraded_capture(msg):
        degrade_log.append(msg)
        _degraded_orig(msg)
    rk._degraded = _degraded_capture
    today = as_of.logical_session_date()
    stages, failures = [], []

    if args.run_ranker:
        print('[e2e] re-running unified_ranker.py (universe-wide, writes)...')
        r = subprocess.run([sys.executable, str(Path(__file__).with_name('unified_ranker.py'))],
                           capture_output=True, text=True)
        print('[e2e] unified_ranker.py exit=%s' % r.returncode)
        if r.returncode != 0:
            print(r.stderr[-2000:], file=sys.stderr)
            # Without this the ranker can die and the check still reads yesterday's rows green.
            failures.append('run:unified_ranker.py exit=%s' % r.returncode)

    before_select = rk._degraded_count
    if args.symbols:
        movers, tradeable_n = [(s.strip().upper(), None, None)
                               for s in args.symbols.split(',') if s.strip()], None
    else:
        movers, tradeable_n = pick_movers(rk, args.n)
    if rk._degraded_count > before_select:
        failures.append('select:tradeable universe degraded (movers are unfiltered)')
    symbols = [s for s, _, _ in movers]
    if not symbols:
        print('FAIL: no candidate symbols (stock_ohlcv empty or fully suspect?)')
        return 1

    def _record(entry):
        stages.append(entry)
        if not entry['alive']:
            failures.append(entry['stage'])

    def engine_stage(name, fn):
        before = rk._degraded_count
        try:
            m = fn()
        except Exception as e:
            conn.rollback()
            _record({'stage': name, 'kind': 'engine', 'alive': False, 'error': str(e)[:200]})
            return
        degraded = rk._degraded_count > before
        alive, note = stage_verdict(len(m), degraded=degraded)
        _record({'stage': name, 'kind': 'engine', 'alive': alive,
                 'universe': len(m), 'degraded': degraded, 'note': note,
                 'error': degrade_log[-1][:200] if degraded and degrade_log else None,
                 'covered': sorted(s for s in symbols if s in m),
                 'missing': sorted(s for s in symbols if s not in m)})

    def sql_stage(name, sql, per_symbol=True, max_age_days=None):
        """per_symbol queries select (symbol, <a date/timestamp>); the rest select (n, last)."""
        try:
            rows = conn.execute(sql).fetchall()
        except Exception as e:
            conn.rollback()
            _record({'stage': name, 'kind': 'sql', 'alive': False, 'error': str(e)[:200]})
            return
        if per_symbol:
            present = {r[0] for r in rows}
            last = max((str(r[1]) for r in rows if r[1] is not None), default=None)
            entry = {'stage': name, 'kind': 'sql', 'universe': len(present), 'last': last,
                     'covered': sorted(s for s in symbols if s in present),
                     'missing': sorted(s for s in symbols if s not in present)}
            entry['alive'], entry['note'] = stage_verdict(len(present))
        else:
            n = rows[0][0] if rows else 0
            last = str(rows[0][1]) if rows and rows[0][1] is not None else None
            entry = {'stage': name, 'kind': 'sql', 'rows': n, 'last': last}
            entry['alive'], entry['note'] = stage_verdict(n, min_universe=0)
        if entry['alive'] and max_age_days is not None:
            entry['alive'], entry['note'] = stage_verdict(
                entry.get('universe', entry.get('rows', 0)),
                age_days=_age_days(entry.get('last')), max_age_days=max_age_days,
                min_universe=0)
        _record(entry)

    regime, regime_prob = rk._get_regime()

    # --- engines the ranker blends (its own getters, its own freshness cutoffs) -------------
    engine_stage('feature:win_probability (ml_ensemble)', rk._get_win_probabilities)
    engine_stage('engine:ml_score',                       rk._get_ml_scores)
    engine_stage('engine:cs_score (cs_ranker)',           rk._get_cs_scores)
    engine_stage('engine:confluence',                     rk._get_confluence_scores)
    engine_stage('engine:technical (signal_score)',       rk._get_technical_scores)
    engine_stage('engine:dl (deep_learning_predictions)', rk._get_dl_scores)
    engine_stage('engine:breakout',                       rk._get_breakout_scores)
    engine_stage('engine:smart_money',                    rk._get_smart_money_scores)
    engine_stage('engine:screener membership',            rk._get_screener_membership)
    # --- ranker inputs that gate/size rather than score ------------------------------------
    engine_stage('input:quant_scores (quality/vol)',      rk._get_quality_metrics)
    engine_stage('input:fundamental_scores',              rk._get_fundamental_scores)
    engine_stage('input:realized_vol',                    rk._get_realized_vol)
    engine_stage('input:multi_factor (crowding)',         rk._get_multi_factor_map)

    # event_triggers is keyed on an exact date, and the ranker asks for the session it is
    # ranking FOR -- which event_triggers.py has usually not written yet at 07:30 IST. Empty
    # for `today` therefore does NOT mean the table is dead, so fall back to its own latest
    # date and report which one answered. Its own staleness is caught by max_age below.
    et_date, et_map = today, rk._get_event_triggers(today)
    if not et_map:
        try:
            row = conn.execute('SELECT MAX(date)::text AS d FROM stock_event_triggers').fetchone()
            if row and row['d']:
                et_date, et_map = row['d'], rk._get_event_triggers(row['d'])
        except Exception:
            conn.rollback()
    et_age = _age_days(et_date)
    _record({'stage': 'input:event_triggers (advisory)', 'kind': 'engine',
             'alive': bool(et_map) and et_age is not None and et_age <= 5,
             'universe': len(et_map),
             'note': 'date=%s%s' % (et_date, '' if et_date == today else ' (NOT %s)' % today),
             'covered': sorted(s for s in symbols if s in et_map),
             'missing': sorted(s for s in symbols if s not in et_map)})

    # --- RL: Q-table state, plus the gate's own per-symbol verdict --------------------------
    # rl_agent runs weekly-ish, so a wider tolerance than the daily tables below.
    sql_stage('rl:q_table', 'SELECT COUNT(*) AS n, MAX(last_updated) AS last FROM rl_q_table',
              per_symbol=False, max_age_days=10)
    sql_stage('rl:episodes', 'SELECT COUNT(*) AS n, MAX(date) AS last FROM rl_episodes',
              per_symbol=False, max_age_days=10)
    before = rk._degraded_count
    try:
        rl_map = rk._get_rl_gate_map()
        _record({'stage': 'rl:gate', 'kind': 'engine',
                 'alive': rk._degraded_count == before and len(rl_map) >= MIN_UNIVERSE,
                 'universe': len(rl_map),
                 'verdicts': {s: bool(rk._passes_rl_gate(s, rl_map)) for s in symbols}})
    except Exception as e:
        conn.rollback()
        _record({'stage': 'rl:gate', 'kind': 'engine', 'alive': False, 'error': str(e)[:200]})

    # --- reward engine / outcome resolution / other scoring authorities ---------------------
    sql_stage('reward:signal_type_weights',
              'SELECT COUNT(*) AS n, MAX(last_updated) AS last FROM signal_type_weights',
              per_symbol=False, max_age_days=10)
    sql_stage('reward:signal_source_weights',
              'SELECT COUNT(*) AS n, MAX(last_updated) AS last FROM signal_source_weights',
              per_symbol=False, max_age_days=10)
    sql_stage('outcomes:signal_outcomes (30d)',
              "SELECT COUNT(*) AS n, MAX(signal_date) AS last FROM signal_outcomes "
              "WHERE signal_date >= (CURRENT_DATE - 30)::text", per_symbol=False, max_age_days=5)
    sql_stage('outcomes:signal_excursions tb_label (30d)',
              "SELECT COUNT(*) AS n, MAX(signal_date) AS last FROM signal_excursions "
              "WHERE tb_label IS NOT NULL AND signal_date >= (CURRENT_DATE - 30)::text",
              per_symbol=False, max_age_days=5)
    # stock_scores.updated_at is 100% NULL (dead column); last_updated is the real stamp.
    sql_stage('scoring_engine:stock_scores',
              "SELECT symbol, last_updated FROM stock_scores WHERE timeframe = 'long_term'",
              max_age_days=5)
    sql_stage('features:feature_store (latest date)',
              'SELECT symbol, date FROM feature_store '
              'WHERE date = (SELECT MAX(date) FROM feature_store)', max_age_days=5)
    sql_stage('composite:engine_composite_scores (latest)',
              'SELECT symbol, date FROM engine_composite_scores '
              'WHERE date = (SELECT MAX(date) FROM engine_composite_scores)', max_age_days=5)
    # signal_date is TIMESTAMPTZ here (signal_outcomes' same-named column is TEXT).
    sql_stage('signals:unified_signals (7d)',
              'SELECT DISTINCT symbol, signal_date FROM unified_signals '
              'WHERE signal_date >= CURRENT_DATE - 7', max_age_days=5)

    # --- the canonical output ---------------------------------------------------------------
    calls, latest = {}, None
    try:
        rows = conn.execute("""
            SELECT symbol, classification, conviction_level, unified_score, computed_at
            FROM unified_recommendations
            WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
        """).fetchall()
        latest = str(rows[0]['computed_at']) if rows else None
        by_sym = {r['symbol']: r for r in rows}
        for s in symbols:
            r = by_sym.get(s)
            calls[s] = None if r is None else {
                'classification': r['classification'], 'conviction': r['conviction_level'],
                'unified_score': float(r['unified_score'] or 0)}
        # Freshness MUST be judged on generated_at (when the run actually happened), NOT on
        # computed_at (the session the run is FOR). computed_at is a forward-looking label:
        # logical_session_date() rolls a run forward, so a stale batch can carry a future
        # computed_at and read as fresher than fresh. Live on 2026-08-22 the newest rows were
        # computed_at=2026-08-24 from a run of 2026-08-21T14:26Z -- an age of -2 days by the
        # label and +1 by the clock. The first version of this check judged the label and
        # passed a ranker that had not run in over a day. Same class as recurring-bugs.md's
        # signal_generated_at incident: a provenance column that does not mean what its name
        # implies hands you a confident wrong answer, not an obviously broken one.
        gen = conn.execute(
            'SELECT MAX(generated_at) AS g FROM unified_recommendations').fetchone()
        generated_at = str(gen['g']) if gen and gen['g'] else None
        alive, note = stage_verdict(len(rows), age_days=_age_days(generated_at),
                                    max_age_days=2, min_universe=0)
        _record({'stage': 'canonical:unified_recommendations', 'kind': 'sql',
                 'alive': alive, 'universe': len(rows), 'last': latest,
                 'note': 'generated_at=%s%s' % (generated_at, '  ' + note if note else ''),
                 'covered': sorted(s for s in symbols if isinstance(calls.get(s), dict)),
                 'missing': sorted(s for s in symbols if not isinstance(calls.get(s), dict))})

        # An engine absent for a symbol is not neutral: _blend renormalizes over whichever
        # engines are PRESENT, so a name scored on 3 sub-universes is not comparable to one
        # scored on 7, and measurement.md's own blend A/B found coverage correlates with score
        # (rho +0.28) with the 3-engine cohort averaging ~28 and 91 Sell / 0 Buy. Report the
        # spread so a coverage collapse is visible here rather than only in a later audit.
        cov_rows = conn.execute("""
            SELECT (ml_score IS NOT NULL)::int + (cs_score IS NOT NULL)::int
                 + (confluence_score IS NOT NULL)::int + (technical_score IS NOT NULL)::int
                 + (dl_score IS NOT NULL)::int + (breakout_score IS NOT NULL)::int
                 + (screener_stock_score IS NOT NULL)::int
                 + (smart_money_score IS NOT NULL)::int AS n_eng
            FROM unified_recommendations
            WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
        """).fetchall()
        n_engines = [int(r['n_eng']) for r in cov_rows]
        avg_eng = sum(n_engines) / len(n_engines) if n_engines else 0
        thin = sum(1 for n in n_engines if n <= 3)
        _record({'stage': 'canonical:engine coverage per symbol', 'kind': 'sql',
                 'alive': avg_eng >= 5.0, 'universe': len(n_engines),
                 'note': 'avg=%.2f/8 engines, %d symbol(s) on <=3 (blend renormalizes over '
                         'those present, so thin rows are NOT comparable)' % (avg_eng, thin)})
    except Exception as e:
        conn.rollback()
        failures.append('canonical:unified_recommendations')
        calls = {'error': str(e)[:200]}

    labelled = [s for s in symbols if isinstance(calls.get(s), dict)]
    if not labelled:
        failures.append('canonical:no Buy/Sell/Hold for any selected symbol')

    report = {'selected': [{'symbol': s, 'pct': p, 'turnover_cr': t} for s, p, t in movers],
              'tradeable_universe': tradeable_n,
              'regime': {'regime': regime, 'prob': regime_prob},
              'unified_recommendations_computed_at': latest,
              'stages': stages, 'calls': calls, 'failures': failures,
              'verdict': 'PASS' if not failures else 'FAIL'}

    # ---- print ------------------------------------------------------------------------------
    print('\n== E2E lifecycle check ==  regime=%s (%.2f)  session=%s  '
          'unified_recommendations computed_at=%s' % (regime, regime_prob, today, latest))
    print('\nSymbols: ' + ', '.join(
        s if p is None else '%s (%+.1f%%)' % (s, p) for s, p, _ in movers))
    print('\n%-46s %-6s %7s  COVERAGE' % ('STAGE', 'ALIVE', 'UNIV'))
    for st in stages:
        cov = ''
        if 'covered' in st:
            cov = '%d/%d' % (len(st['covered']), len(symbols))
            if st['missing']:
                cov += '  missing=' + ','.join(st['missing'])
        elif 'rows' in st:
            cov = 'rows=%s last=%s' % (st['rows'], st.get('last'))
        if st.get('note'):
            cov += '  ' + st['note']
        if 'verdicts' in st:
            blocked = [s for s, ok in st['verdicts'].items() if not ok]
            cov = 'rl-blocked=' + (','.join(blocked) if blocked else 'none')
        print('%-46s %-6s %7s  %s%s' % (
            st['stage'], 'ok' if st['alive'] else 'FAIL', st.get('universe', ''), cov,
            ('  ERR: ' + st['error']) if st.get('error') else ''))

    print('\n%-14s %-14s %-12s SCORE' % ('SYMBOL', 'CALL', 'CONVICTION'))
    for s in symbols:
        c = calls.get(s)
        if not isinstance(c, dict):
            print('%-14s -- no ranker row --' % s)
        else:
            print('%-14s %-14s %-12s %.1f' % (s, c['classification'], c['conviction'],
                                              c['unified_score']))

    if failures:
        print('\nVERDICT: FAIL (%d stage(s)): %s' % (len(failures), failures[0]))
        if len(failures) > 1:
            print('  also: ' + ', '.join(failures[1:]))
            print('  NOTE: many stages failing together is usually ONE cause (an aborted '
                  'transaction or a missing upstream table) -- fix the first and re-run.')
    else:
        print('\nVERDICT: PASS -- every stage alive and fresh, %d/%d symbols carry a '
              'Buy/Sell/Hold. Plumbing only: this says nothing about predictive edge.'
              % (len(labelled), len(symbols)))

    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, default=str))
        print('wrote ' + args.json)
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
