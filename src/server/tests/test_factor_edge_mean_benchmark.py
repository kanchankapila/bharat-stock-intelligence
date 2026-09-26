"""`_mean_benchmark` must catch the median-beater trap (2026-09-26).

`rank_IC` is a rank correlation (invariant to per-date centring) and `hit_AUC` asks "beats the
per-date MEDIAN". `factor_backtest.py` asks "does a top-50 book beat the equal-weight universe
MEAN". On right-skewed cross-sectional returns mean >> median, so a factor that avoids the right
tail posts a real positive rank IC and still loses money -- measured live 2026-09-26 on a
low-volatility composite (TEST rank IC +0.049@5d, cost-aware arms -0.53 to -0.94%/period).

These tests pin the DISCRIMINATION, not just that the function runs: it must go negative on a
right-skewed median-beater AND stay positive on a genuine mean-beater. A diagnostic that fired on
both would be the "monitor that fires on every run carries no information" class.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import factor_edge as fe  # noqa: E402

N_NAMES = 100
DATES = pd.to_datetime(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"])


def _panel(fwd_of_rank, horizon=5):
    """One row per (date, name); `score` == rank, `fwd_N` from a rank -> return function.

    Each date carries a small multiplicative jitter. Without it every date's top-50-minus-universe
    figure is IDENTICAL, the across-date std is 0, and t_eff is (correctly) nan -- which made the
    first draft of two tests here assert on nan and pass vacuously. A real panel varies by date, so
    the fixture must too.
    """
    rows = []
    for k, d in enumerate(DATES):
        scale = 1.0 + 0.25 * k
        for i in range(1, N_NAMES + 1):
            rows.append({"symbol": f"S{i:03d}", "date": d, "score": float(i),
                         f"fwd_{horizon}": float(fwd_of_rank(i)) * scale})
    return pd.DataFrame(rows)


def test_flags_a_right_skewed_median_beater():
    """Bulk monotone in score (positive rank IC) but the right TAIL sits on the LOWEST scores,
    so the equal-weight mean is dragged above anything the top-50 earns."""
    def fwd(i):
        return 5.0 if i <= 5 else i * 0.001          # 5 huge winners at the bottom of the score
    d = _panel(fwd)
    ic = fe._metrics(d.assign(**{"xs_5": d["fwd_5"] - d["fwd_5"].median()}),
                     "score", 5, 10, 100)[0]
    exc, t_eff, n_dates = fe._mean_benchmark(d, "score", 5, min_per_date=10)
    assert ic > 0, f"precondition: rank IC must be positive, got {ic}"
    assert exc < 0, f"top-50 must LOSE to the universe mean, got {exc:+.4f}"
    assert n_dates == len(DATES)
    # This combination is exactly what run() flags.
    assert ic > 0 and exc < 0


def test_does_not_flag_a_genuine_mean_beater():
    """Monotone with no skew: the top-50 really is the better book and must read positive."""
    d = _panel(lambda i: i * 0.001)
    exc, t_eff, _ = fe._mean_benchmark(d, "score", 5, min_per_date=10)
    assert exc > 0, f"a monotone factor must beat the universe mean, got {exc:+.4f}"
    assert t_eff > 0


def test_inverted_factor_is_symmetric():
    d = _panel(lambda i: i * 0.001)
    d["score_inv"] = -d["score"]
    up, _, _ = fe._mean_benchmark(d, "score", 5, min_per_date=10)
    dn, _, _ = fe._mean_benchmark(d, "score_inv", 5, min_per_date=10)
    assert up > 0 > dn
    assert np.isclose(up, -dn, atol=1e-12)


def test_t_eff_is_deflated_by_the_overlap_correction():
    """t must divide by sqrt(eff_dates), not sqrt(dates) -- the same overlapping-window
    correction `_effective_dates` applies to the reliability bar (AF-20260912-15)."""
    d = _panel(lambda i: i * 0.001 + (i % 7) * 0.0005, horizon=21)
    _, t_eff, n_dates = fe._mean_benchmark(d, "score", 21, min_per_date=10)
    per_date = []
    for _, g in d.groupby("date"):
        top = g.nlargest(50, "score")
        per_date.append(top["fwd_21"].mean() - g["fwd_21"].mean())
    arr = np.asarray(per_date)
    naive_t = arr.mean() / (arr.std(ddof=1) / np.sqrt(len(arr)))
    assert abs(t_eff) < abs(naive_t), (
        f"t_eff {t_eff} must be smaller than the uncorrected {naive_t} at horizon 21")


def test_too_few_usable_dates_returns_nan_not_a_number():
    """Fewer than 2 gradeable dates must be n/a -- never a fabricated 0.0 (sentinel class)."""
    d = _panel(lambda i: i * 0.001).head(N_NAMES)      # single date
    exc, t_eff, n_dates = fe._mean_benchmark(d, "score", 5, min_per_date=10)
    assert np.isnan(exc) and np.isnan(t_eff) and n_dates == 0


def test_thin_cross_section_is_skipped_not_padded():
    """A date with fewer names than top_k cannot fill the book and must be dropped, not scored
    on whatever happens to be there."""
    d = _panel(lambda i: i * 0.001)
    thin = d[d.date == DATES[0]].head(20)              # 20 names < top_k=50
    fat = d[d.date != DATES[0]]
    exc, _, n_dates = fe._mean_benchmark(pd.concat([thin, fat]), "score", 5, min_per_date=10)
    assert n_dates == len(DATES) - 1
    assert not np.isnan(exc)
