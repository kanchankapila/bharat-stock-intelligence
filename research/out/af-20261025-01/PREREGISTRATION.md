# AF-20261025-01 screener shadow arm - grading rules, written 2026-11-26 before any return was read

Panel: intraday_recommendations_history 2026-10-29..2026-11-26, rows where screener_score_shadow is not null
(identical rows for every arm). cycle_at is naive UTC.
Return: entry = open of the first 15m bar starting strictly after cycle_at, exit = close of that session's last
15m bar. Rows with no later bar are dropped.
IC: Spearman per cycle (>=50 symbols), averaged within the day; the independent unit is the DAY.

Arms (stored components only; reversal_score was not recorded, so the published score is NOT reconstructed):
  live    = blend(breakout_score, screener_score)          weights 0.503 / 0.497, renormalised over present
  shadow  = blend(breakout_score, screener_score_shadow)   same weights
  alone   = screener_score_shadow by itself
  sensitivity: live and shadow again at the code constants 0.20 / 0.40

Primary: paired per-day IC difference shadow - live at 0.503/0.497.
Ship bar (ALL required): difference >= +0.010; t >= 2 on days; positive in both halves of the days;
top-decile mean excess (over the cycle's mean) not lower than live.
Fewer than 20 days is LOW-DATA and is stated as such. Costs: 15 bps per side. No weight or mapping changes
as a result of running this; a pass would be a recommendation for the owner.
