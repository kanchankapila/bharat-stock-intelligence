# Intraday blend arms: pre-registration (AF-20261126-10)

Written 2026-11-26, before any session recorded `reversal_score` in history (first expected 2026-11-27).

## Question
Does the intraday ranking order stocks better without the breakout component?

## Why now
On 19 sessions (2026-10-29..11-26) the two-part live ranking, which is effectively breakout alone because the
screener score is constant, read rank IC -0.040 (t -2.94). That used no reversal component, so it says nothing
about the published blend (`research/out/af-20261025-01/`).

## Cohort
`intraday_recommendations_history`, the first 20 sessions from 2026-11-27 on which `reversal_score` is recorded.
Identical rows for every arm: `reversal_score` not null.

## Arms
Weights in force on 2026-11-26: screener 0.2982, breakout 0.3018, reversal 0.40, renormalised over the components
present, then multiplied by `1 + 0.155 * clamp(news_sentiment, -1, 1)` when there is news (as `run()` does).
The regime tilt is one number per cycle and does not change ranks.

| arm | components |
|---|---|
| A current | screener, breakout, reversal |
| B no breakout | screener, reversal |
| C reversal only | reversal |
| P placebo | A with `breakout_score` shuffled within the cycle, mean of 5 seeds |

If the live weights change during the cohort, the arms keep the weights above.

**Validity gate (checked first):** per cycle, rank correlation of the rebuilt arm A with the stored `intraday_score`,
median at least 0.99. If it fails, stop and report; grade nothing.

## Measurement
Entry = open of the first 15m bar starting after `cycle_at` (naive UTC). Exit = close of the session's last bar.
Rank IC per cycle (at least 50 symbols), averaged within the day; the unit is the day. Top decile with ties broken
by symbol. Costs 15 bps a side.

## Bar (all required, for B or C against A)
- paired daily IC difference at least +0.010;
- t at least 2.43 (two arms, Bonferroni, 19 degrees of freedom);
- positive in both halves of the days;
- top-decile excess over the cycle mean not lower than A's;
- the arm beats P as well as A.

A pass means "better ordering". It is **not** a claim of profit unless the arm's top decile is also positive net of
costs. Fewer than 20 sessions is LOW-DATA and is not graded. No weight changes from this run; a pass is a
recommendation to the owner. No arm, weight or threshold changes after the first cohort session is read.
