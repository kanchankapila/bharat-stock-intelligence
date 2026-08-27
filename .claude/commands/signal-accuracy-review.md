---
description: Reverse-engineer real market movers against what the system predicted, and report what it missed
---

# Signal Accuracy Review

Grade the system against what the market actually did. **Not** against its own reported metrics — this codebase's entire incident history is proxies that looked fine while the real outcome was wrong.

Read `.claude/rules/measurement.md` first. It carries the panel spec and the list of factors already tested, so you don't spend a day re-deriving that `insider_net` is null.

## 1. Ground truth first

Pull what actually moved, from `stock_ohlcv` (never from a screener's own claim about itself):

- top gainers / losers over 1d, 5d, 21d
- fresh 52-week highs and lows
- gap-ups and gap-downs vs prior close
- volume shockers (vs the symbol's own 20d average, not an absolute threshold)

Filter `is_suspect = 1` and apply the ≥₹1cr ADT liquidity floor. A +127,900% bar is in this table and has produced a phantom edge before.

## 2. What did we say beforehand?

For each mover, pull the system's **pre-move** call — the snapshot dated strictly *before* the move:

- `unified_recommendations` (classification, conviction, `generated_at`)
- `unified_signals`, `intraday_recommendations`
- `high_flyer_candidates` (yesterday's watchlist)

**`unified_recommendations.computed_at` is a bare TEXT date.** A same-day manual re-run silently overwrites the 07:30 cron row, so grading a session against its own date's row can be look-ahead. Filter `generated_at < computed_at 03:45 UTC` (NSE opens 09:15 IST). Rows predating that column are NULL and cannot be trusted as pre-market.

## 3. Classify every miss

Three buckets, and the distinction matters more than the hit rate:

| Bucket | Meaning |
|---|---|
| **Not flagged** | absent from every list — check whether it was *excluded* (RL gate, universe filter, quality gate) rather than merely unranked |
| **Wrong direction** | rated Sell and rallied, or rated Buy and fell — the sharpest failure, and the one plain recall hides |
| **Correctly flagged** | it worked; note which engine caught it |

For anything in the first bucket, trace *where* the symbol dropped out by walking the actual pipeline. A plausible-sounding cause from reading code is a hypothesis, not a finding, until traced end to end. Both times this was skipped, the first-pass explanation turned out to be wrong.

## 4. Report

Report per-date, then average. **Never pooled** — pooling has flipped or inflated a conclusion three separate times in this repo.

State plainly, as an explicit percentage breakdown across all three buckets from step 3 (not just a
single "hit rate"), per date and then averaged:
- **% matched** — correctly flagged, direction agreed with what the market did
- **% opposite** — wrong-direction (rated Sell and rallied, or Buy and fell)
- **% not flagged** — absent from every list
- the raw counts and date count behind each percentage — a percentage with n<20 is decoration, say so
- whether the sample is large enough to mean anything (over ~39 ranker dates, mostly it isn't)
- named examples with their traced cause, especially every "opposite" one — that bucket is the one plain recall hides

## 5. The thing to expect

Every one of these reviews so far has found **plumbing defects, not missing factors** — NaN-scored rows carrying real Buy labels, a gate excluding 54% of the universe on noise, a day-level/run-level train-serve skew, a saturated model. Not once has the conclusion been "we should have weighted earnings higher."

So look for bugs first. If you find yourself concluding "we need another data source," check that against the tested-and-failed table in `.claude/rules/measurement.md` before proposing it.

Anything durable goes into `.claude/rules/recurring-bugs.md`, not just the session log.
