# Rank hysteresis (factor_backtest --exit-rank) - pre-registered 2026-11-26 ~16:45 IST, before any hysteresis result was read

Gate 0 (harness unchanged): momentum_12_1 --rebalance 21 --top-k 50 --cost-bps 25 (no --exit-rank) must
reproduce the recorded 2026-10-27/11-10 result: +0.80%/period vs universe, t 1.67, 56 periods.

Arms (same panel, 25 bps/side, top-50):
  A. momentum_12_1, 21d, exit-rank none vs 100
  B. win_probability, 5d, exit-rank none vs 150   (the outstanding cost-aware re-run measurement.md names)

Bar for "hysteresis helps" on an arm: net excess per period higher than the no-hysteresis arm AND lower
one-way turnover. Any EDGE claim additionally needs the harness verdict floor (>=20 periods, >=1 year)
and |t| >= 2 vs universe. A change in turnover alone is not an edge. No weight or live setting changes
on any result of this run.
