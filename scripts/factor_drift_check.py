#!/usr/bin/env python
"""Re-run the canonical factor panel and diff its verdicts against the last accepted baseline.

Exists because `measurement.md`'s verdict table goes stale silently. `insider_net` was recorded
at t=+2.05 ("the one significant survivor"), then re-ran at t=1.73 months later and nobody
noticed until a manual audit -- the panel grows as more history arrives, so a number that was
true when written can be false now without any code changing. This runs the same command
measurement.md quotes and shouts when a factor crosses a significance boundary in either
direction.

    python scripts/factor_drift_check.py                    # run + diff, exit 1 if a verdict moved
    python scripts/factor_drift_check.py --update-baseline  # accept current as the new baseline
    python scripts/factor_drift_check.py --self-check       # assert the diff logic

Run it with backend-python/venv's interpreter -- it shells out to sys.executable, so the wrong
python here means the wrong python for the backtest too.
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import pathlib
import statistics
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SERVER = ROOT / 'src' / 'server'
OUT_DIR = ROOT / 'docs' / 'factor-drift'
BASELINE = OUT_DIR / 'baseline.json'

# The exact config measurement.md's verdict table is quoted at. Changing any of these makes the
# diff meaningless -- a t-stat is only comparable to another t-stat from the same harness config.
CANONICAL = ['--factor', 'all', '--rebalance', '21', '--top-k', '50', '--cost-bps', '25']

T_SIGNIFICANT = 2.0
# Material move worth reporting even when the verdict label is unchanged (1.9 -> 2.6 is a
# verdict change; 4.1 -> 5.8 is not, but is still the panel telling you something moved).
T_DRIFT = 1.0
# Share of position-slots that must be clamped / unexitable before the run is suspect. The clean
# 2026-08-12 panel peaks at 3.00% clamps (momentum_21d) and 0.68% missing exits (low_idio_vol),
# so this warns on a genuine step change rather than on the ordinary rate.
MAX_DEFECT_SHARE = 0.08


def bonferroni_t(n_factors: int) -> float:
    """Two-sided alpha=0.05 corrected for n simultaneous tests, normal approximation."""
    if n_factors < 1:
        return T_SIGNIFICANT
    return statistics.NormalDist().inv_cdf(1 - 0.025 / n_factors)


def verdict(t: float, bonf: float) -> str:
    # A NaN t-stat means the factor produced too few periods to compute one (screener_breadth
    # at --rebalance 21 yields a single period). Every comparison below is False against NaN,
    # so without this branch a degenerate factor silently reads as NOT_SIGNIFICANT -- the same
    # "coerce a NaN into the most innocuous value" shape recurring-bugs.md warns about.
    if not math.isfinite(t):
        return 'NO_VERDICT'
    if t >= bonf:
        return 'BONFERRONI_POS'
    if t <= -bonf:
        return 'BONFERRONI_NEG'
    if t >= T_SIGNIFICANT:
        return 'SIGNIFICANT_POS'
    if t <= -T_SIGNIFICANT:
        return 'SIGNIFICANT_NEG'
    return 'NOT_SIGNIFICANT'


def parse_panel_stdout(raw: str) -> tuple[list[dict], list[str]]:
    """-> (results, per-factor FAILED lines).

    factor_backtest.py interleaves its loader logs and its per-factor 'FAILED' lines with the
    --json payload on the SAME stream, so a bare json.loads(stdout) never parses. The payload is
    json.dumps(list, indent=2), whose first line is exactly '['; no log line ever is.
    """
    lines = raw.splitlines()
    failed = [ln for ln in lines if 'FAILED --' in ln]
    start = next((i for i, ln in enumerate(lines) if ln.rstrip() == '['), None)
    if start is None:
        raise SystemExit(f"no JSON payload in factor_backtest.py stdout:\n{raw[-4000:]}")
    return json.loads('\n'.join(lines[start:])), failed


def run_panel() -> tuple[list[dict], list[str]]:
    proc = subprocess.run([sys.executable, 'factor_backtest.py', *CANONICAL, '--json'],
                          cwd=SERVER, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"factor_backtest.py exited {proc.returncode}\n{proc.stderr[-4000:]}")
    return parse_panel_stdout(proc.stdout)


def diff(base: list[dict], cur: list[dict]) -> tuple[list[str], list[str], list[str]]:
    """-> (verdict changes, drift warnings, integrity warnings). First list is the alert."""
    bonf = bonferroni_t(len(cur))
    b = {r['factor']: r for r in base}
    c = {r['factor']: r for r in cur}

    changes, drifts, integrity = [], [], []

    for f in sorted(set(b) | set(c)):
        if f not in c:
            changes.append(f"{f}: DROPPED from the panel (was t={b[f]['excess_t_stat']:+.2f})")
            continue
        if f not in b:
            changes.append(f"{f}: NEW factor, t={c[f]['excess_t_stat']:+.2f} "
                           f"[{verdict(c[f]['excess_t_stat'], bonf)}]")
            continue
        tb, tc = b[f]['excess_t_stat'], c[f]['excess_t_stat']
        vb, vc = verdict(tb, bonf), verdict(tc, bonf)
        if vb != vc:
            changes.append(f"{f}: {vb} -> {vc}  (t {tb:+.2f} -> {tc:+.2f}, "
                           f"net excess {b[f]['net_excess_vs_universe_pct']:+.3f} -> "
                           f"{c[f]['net_excess_vs_universe_pct']:+.3f} %/period)")
        elif abs(tc - tb) >= T_DRIFT:
            drifts.append(f"{f}: t {tb:+.2f} -> {tc:+.2f} (verdict unchanged: {vc})")

    # A run whose own benchmark is insane, or that clamped a lot of bars, is not evidence --
    # the harness has had two benchmark bugs already, both of which read as real results.
    for r in cur:
        if not math.isfinite(r['excess_t_stat']):
            integrity.append(f"{r['factor']}: t-stat is {r['excess_t_stat']} over "
                             f"{r.get('periods')} period(s) -- no verdict is computable")
        if not r.get('benchmark_sane', True):
            integrity.append(f"{r['factor']}: benchmark_sane=False -- do not quote this run")
        # Clamps and missing exits are normal in small numbers -- a healthy run clamps ~1-3% of
        # position-slots. Firing on a bare count > 0 flags all 56 factors on a clean run, and a
        # check that cries wolf on correct data stops being read. Compare the SHARE against a
        # floor sized to a real defect instead.
        slots = (r.get('periods') or 0) * (r.get('top_k') or 0)
        if slots:
            for key, label in (('clamped_returns', 'clamped bars'),
                               ('missing_exits', 'missing exits')):
                share = (r.get(key) or 0) / slots
                if share >= MAX_DEFECT_SHARE:
                    integrity.append(f"{r['factor']}: {r[key]} {label} = {share:.1%} of "
                                     f"{slots} position-slots")
    return changes, drifts, integrity


def report(base: list[dict], cur: list[dict], failed: list[str] = ()) -> int:
    changes, drifts, integrity = diff(base, cur)
    integrity = [*(f"did not run: {ln.strip()}" for ln in failed), *integrity]
    bonf = bonferroni_t(len(cur))
    print(f"=== factor drift vs baseline ===")
    print(f"factors: {len(cur)}  |  config: {' '.join(CANONICAL)}  |  "
          f"Bonferroni |t| >= {bonf:.2f}")

    if integrity:
        print(f"\n-- RUN INTEGRITY ({len(integrity)}) --")
        for line in integrity:
            print(f"  ! {line}")

    print(f"\n-- VERDICT CHANGES ({len(changes)}) --")
    for line in changes or ['  (none)']:
        print(f"  * {line}" if changes else line)

    if drifts:
        print(f"\n-- DRIFT WATCH, |dt| >= {T_DRIFT} ({len(drifts)}) --")
        for line in drifts:
            print(f"  - {line}")

    survivors = [r for r in cur if verdict(r['excess_t_stat'], bonf) == 'BONFERRONI_POS']
    print(f"\n-- POSITIVE AND BONFERRONI-SIGNIFICANT: {len(survivors)} --")
    for r in sorted(survivors, key=lambda r: -r['excess_t_stat']):
        print(f"  + {r['factor']}: t={r['excess_t_stat']:+.2f}, "
              f"{r['net_excess_vs_universe_pct']:+.3f}%/period")

    if changes:
        print("\nA verdict moved. Update .claude/rules/measurement.md's table (and re-read it "
              "before acting), then re-run with --update-baseline to accept.")
    return 1 if changes else 0


def self_check() -> None:
    bonf = bonferroni_t(26)
    assert 3.0 < bonf < 3.2, bonf
    assert verdict(3.5, bonf) == 'BONFERRONI_POS'
    assert verdict(-3.5, bonf) == 'BONFERRONI_NEG'
    assert verdict(2.5, bonf) == 'SIGNIFICANT_POS'
    assert verdict(-2.5, bonf) == 'SIGNIFICANT_NEG'
    assert verdict(1.7, bonf) == 'NOT_SIGNIFICANT'

    def row(f, t, **kw):
        return {'factor': f, 'excess_t_stat': t, 'net_excess_vs_universe_pct': 0.1, **kw}

    # Pad to a realistic panel: the Bonferroni bar is a function of how many factors are
    # tested, so a 1-factor test panel would silently measure the uncorrected 1.96 instead.
    def panel(*rows):
        return [*rows, *(row(f'filler_{i}', 0.0) for i in range(26 - len(rows)))]

    # the insider_net case this script exists for: 2.05 -> 1.73 must be a verdict change
    ch, dr, _ = diff(panel(row('insider_net', 2.05)), panel(row('insider_net', 1.73)))
    assert len(ch) == 1 and 'SIGNIFICANT_POS -> NOT_SIGNIFICANT' in ch[0], ch
    assert not dr

    # a big move inside one verdict band is a drift warning, not an alert
    ch, dr, _ = diff(panel(row('high_vol', -6.09)), panel(row('high_vol', -4.50)))
    assert not ch and len(dr) == 1, (ch, dr)

    # added / removed factors surface
    ch, _, _ = diff(panel(row('gone', 1.0)), panel(row('added', 1.0)))
    assert len(ch) == 2, ch

    # an insane benchmark is flagged even when nothing moved
    _, _, ig = diff(panel(row('x', 1.0)), panel(row('x', 1.0, benchmark_sane=False)))
    assert len(ig) == 1 and 'do not quote' in ig[0], ig

    # a NaN t-stat must not silently read as NOT_SIGNIFICANT (screener_breadth @ rebalance 21)
    nan = float('nan')
    assert verdict(nan, bonf) == 'NO_VERDICT'
    ch, dr, ig = diff(panel(row('screener_breadth', nan)),
                      panel(row('screener_breadth', nan, periods=1)))
    assert not ch and not dr, (ch, dr)
    assert len(ig) == 1 and 'no verdict is computable' in ig[0], ig
    # and a factor going NaN when it used to have a verdict IS an alert
    ch, _, _ = diff(panel(row('screener_breadth', -0.45)), panel(row('screener_breadth', nan)))
    assert len(ch) == 1 and '-> NO_VERDICT' in ch[0], ch

    # the real shape of factor_backtest.py's stdout: loader logs, a FAILED line, then the
    # payload -- all on one stream. A bare json.loads() on this raises, which is what the
    # first version of this script did.
    stdout = ('[Backtester] bhavcopy fallback: 971 symbols\n'
              '[FactorBacktest] price panel: 3418 symbols\n'
              '[FactorBacktest] fs_rev_growth: FAILED -- no completed rebalance periods\n'
              '[\n  {\n    "factor": "momentum_12_1",\n    "excess_t_stat": 1.1\n  }\n]\n')
    parsed, fails = parse_panel_stdout(stdout)
    assert parsed == [{'factor': 'momentum_12_1', 'excess_t_stat': 1.1}], parsed
    assert len(fails) == 1 and 'fs_rev_growth' in fails[0], fails
    print('self-check OK')


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--update-baseline', action='store_true',
                   help='accept the current run as the baseline future runs diff against')
    p.add_argument('--results', help='diff a saved --json run instead of executing a new one')
    p.add_argument('--self-check', action='store_true')
    a = p.parse_args()

    if a.self_check:
        self_check()
        return 0

    if a.results:
        cur, failed = parse_panel_stdout(pathlib.Path(a.results).read_text())
    else:
        cur, failed = run_panel()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.date.today().isoformat()   # provenance filename, never a query predicate
    (OUT_DIR / f'run-{stamp}.json').write_text(json.dumps(cur, indent=2))

    if not BASELINE.exists() or a.update_baseline:
        BASELINE.write_text(json.dumps(cur, indent=2))
        print(f"baseline written: {BASELINE} ({len(cur)} factors, {stamp})")
        for ln in failed:
            print(f"  ! did not run: {ln.strip()}")
        return 0

    return report(json.loads(BASELINE.read_text()), cur, failed)


if __name__ == '__main__':
    raise SystemExit(main())
