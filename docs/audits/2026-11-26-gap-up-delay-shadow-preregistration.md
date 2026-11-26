# Gap-up delay: forward shadow arm, pre-registration (AF-20261126-15)

Written 2026-11-26 22:56 IST, before the first forward session (2026-11-27) opened. No return from 2026-11-27 or later existed.
Origin: follow-up O2 in `2026-11-26-rerun-and-opportunities-preregistration.md`. In sample (51 graded days) the
difference was +0.325% (t 1.37, both halves positive), below that file's bar of 2.47. That was a lead, not a result.
Nothing in sample counts towards the verdict here.

## Rule under test
A Buy or Strong Buy name that opens with a pre-open gap of +1.0% or more is bought at the close of the 15:00 15-minute
bar (about 15:15 IST) instead of at the session open. Saving per name = (open - that price) / open, clipped to +-20%.

## Population (same as O2)
- Calls: `unified_recommendations_history`, latest call per symbol per session as `forward_test_report` assigns it.
  Entry day = the NIFTY50 session after the call's session. Classification Buy or Strong Buy.
- Mean of close x volume over the 20 sessions before the entry day (at least 15) of Rs 10 cr or more.
- Not under surveillance (`nse_stocks.is_asm` / `gsm_stage`), read on the night the day is graded.
- No split, bonus or rights date within one session of the entry day.
- A pre-open row stamped 09:05:00-09:14:59 IST on the entry day with a gap value.
- A 15:00 bar, within 3% of that day's daily close, and a daily open above zero.
- A name locked at a circuit in the 15:00 bar is KEPT and counted. Dropping it would remove the cases where waiting
  cost the most, which flatters the rule. A real order might not fill; the count says how often.

## Measurement
Per entry day with at least 1 gap-up and 3 other names: D = mean saving of gap-up names - mean saving of the other
Buy names. The other names control for what the whole list did that day.

## Verdict
One look, on the first **150 graded days**. PASS needs all three:
1. mean D > 0 with one-sided t >= 1.65 (days as units);
2. mean D positive in both chronological halves;
3. mean saving of the gap-up names themselves > 0, because that is the money the rule changes.

Otherwise FAIL. Before 150 graded days the report reads LOW-DATA and its running numbers are not a result: no early
pass and no early kill. Later days are reported but do not change the verdict. Expected around October 2027 (about 71%
of the replayed sessions with calls gave a result); the trigger is the 150th graded day, not a date.

Why these numbers: the bar is 1.65 because this is one test, direction fixed in advance, on data not used to find it
(2.47 corrected for three in-sample tests). At the in-sample mean and spread, 150 days gives roughly three chances in
four of passing a real effect; if the true effect is half that size, roughly one in three. The last condition (3) is
stricter than O2 and was added after today's capitulation correction, where a positive spread hid a poor absolute
return.

## Freezing and missing days
- A day is graded once and never recomputed, so later flag changes, price adjustments or data pruning
  (`intraday_ohlcv` keeps 365 days) cannot revise it.
- A day is graded only after a later NIFTY50 session exists and at least 2,000 symbols have the 09:15 bar, the 15:00
  bar and a daily bar. Otherwise it stays pending.
- A graded day that yields no D is stored with its reason (no pre-open rows, no Buy names, fewer than 1 gap-up or 3
  other names), so a missing day cannot look like a quiet one.
- Late grading (a missed nightly run) uses surveillance flags from the later date.

## Amendments before the first forward session
2026-11-26 23:12 IST. No forward session had opened and no forward data existed. These edits were made after the in-sample
replication below had been read:
- added the daily-bar completeness gate to the text (the code already had it);
- added the note on what the protocol hash covers, and the code check on in-sample data;
- moved the expected verdict date from August-September to October 2027.
The rule, population, thresholds and verdict conditions are as first written.

## Not covered
Slippage and spread differ between the opening auction and 15:15 and are not modelled; brokerage and taxes are the same
either way. A PASS does not change any entry time: adopting the rule is an owner decision.

Code: `src/server/gap_up_delay_shadow.py`. The protocol hash is frozen in `app_settings` on the first persisted run. It
covers the parameters in `PROTOCOL`, not the code that applies them; a change to that logic needs a new version number.

Code check, not evidence: run over the in-sample window, the arm's own grading code gives 50 days and D +0.318%. With
the newest session added (the arm waits for a later one) it gives 51 days, 470 gap-up names and D +0.325%, which is
O2's result (`research/out/rerun-20261126/gap_delay_replication.txt`).
