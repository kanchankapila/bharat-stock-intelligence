# Screener semantic-repair replay, rerun on valid membership: pre-registration (AF-20261106-01, AF-20261106-04)

Written and committed before the rerun produced any number. It changes one thing about the 2026-11-06 replay.

## What stays fixed

The frozen manifest `research/out/screener-bias-review-20261106-v3.json` (5,223 decisions) and the frozen label
policy `src/server/config/screenerSemantics.json`: the policy's SHA-256 still equals the manifest's
(`1447de3f...`, checked 2026-11-21), and the script refuses to run otherwise. The comparison, the scoring function
(`unified_ranker.compute_screener_stock_scores`, neutral weight 0.3 before and 0.0 after, candidate
membership de-duplicated), the universe filters (20-day traded value >= Rs 1 crore, |return| <= 40, valid entry
bar, at least 50 names per date), the return (next session open to close), the metrics (per-date Spearman IC,
top-50 net excess after 0.32 percentage points) and the paired statistics are those of
`scripts/measure_screener_semantic_repair.py`, which is not modified.

## What changes

That replay read `screener_membership_runs`, which kept only episodes that appeared in the last 3 days
(AF-20261106-04), so it was INVALID. The rerun builds each date's membership from `screener_appearances`
episodes with `scripts/screener_membership_replay.py`'s `new` arm (every open episode on the date whose provider
still confirms it, last_seen within 3 days) and drops the 20 screener ids shared by two providers (an exit by
one could close the other's episode before AF-20261120-06). Dates: every session 2026-09-01..2026-11-19 with a
next session, instead of the 14 captured dates. The instrument was validated against production on 2026-11-21
(see `2026-11-21-screener-membership-preregistration.md`).

## Decision rule

Primary: the paired difference `IC(after) - IC(before)`. Ship rule of AF-20261026-71: **harmful** if t <= -2 in
either half of the dates; fewer than 20 dates is LOW-DATA. Template names and categories are the current ones,
so history carries hindsight; the replay is a check of the policy, not evidence of an edge.

## What it can authorise

Nothing that changes production. Bulk application still requires the exact policy and manifest hashes plus
adequate promotion evidence, the existing AF-20260829-11/12 gates stand, and no risk veto is removed
(AF-20261105-03 stays decided on its own measurement). A not-harmful result is not a reason to relabel.
