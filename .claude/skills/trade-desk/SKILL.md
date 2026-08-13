---
name: trade-desk
description: Run the daily Indian-market trading loop against this platform's own data — pre-market candidate generation from the one setup with a measured edge, position sizing, entry/exit rules, and a graded trade journal. Use when asked "what should I trade/buy today", "give me a trade plan", "how much should I size this", "is this a good entry", "should I buy X", "grade my trades", or anything about actually putting money into NSE/BSE names based on this system.
---

# Trade desk — the daily loop

This skill turns the platform into a trading process. It exists because the platform emits
a lot of Buy/Sell calls and almost none of them have a measured edge — so the hard part of
trading here is not finding candidates, it is refusing the ones that will lose money.

**Read `.claude/rules/measurement.md` before doing anything in this file.** Every number
below is sourced from it. If you are about to say a setup works, that file is where the
claim has to come from, and `references/edge-inventory.md` next to this file is the
one-page distillation of what is tradeable and what is already dead.

## The honest prior — state this to the user once per session, then stop repeating it

- **One setup on this platform has survived a real measurement review**: the tier-1
  capitulation triple (`screener_combo_finder.py --tier1`). +0.53%/day excess, net of
  15bps, t=+3.61, p=0.0003, 425 dates, 6/6 years positive, robust to winsorizing and to
  dropping the 3 most extreme days.
- **Nothing else here does.** `unified_score` 5d rank IC ≈ 0.0001 (t=0.02). Zero of 26
  backtested factors are positive and significant. 14 of 23 `feature_store` columns are
  significantly *negative*. Screener bullish consensus is significantly negative and its
  sentiment labels are inverted. The canonical ranker has ~2 gradeable pre-market dates and
  is not yet gradeable at all.
- **So: the app's own Buy/Sell/Strong Sell labels are not trade instructions.** Treat them
  as context, never as a reason to enter. Refusing to trade them is the single highest-value
  thing this skill does.

Do not promise, project, or imply large or guaranteed profits. If the user asks for that
directly, give them the measured expectancy and its confidence interval (below) instead —
that is the real answer, and it is a good one.

## Phase 1 — Gate on data freshness (do this first, every time)

A stale DB produces a confident, wrong candidate list. Check before generating anything:

```bash
cd src/server
python -c "
from db_compat import read_df
print(read_df('SELECT MAX(date) AS last_bar, COUNT(*) AS rows FROM stock_ohlcv WHERE date = (SELECT MAX(date) FROM stock_ohlcv)'))
print(read_df('SELECT MAX(datetime) AS last_intraday FROM intraday_ohlcv'))
"
```

- `stock_ohlcv`'s max date must be the **last completed trading session**. Use
  `as_of.logical_trading_date()` / `as_of.trading_days_back()` to reason about this —
  never hand-roll "yesterday", and never `date.today()` (Monday reads Friday as 3 days
  stale; both are documented recurring bugs).
- If the last bar is older than one trading day: **no candidates today.** Say so and stop.
  Do not generate a list off stale data and caveat it — the caveat gets dropped, the list
  gets traded.

## Phase 2 — Generate candidates from the measured setup

The setup fires on session **D** and is traded on session **D+1**. Getting this backwards
is the easiest way to destroy the edge, so be explicit about which date each candidate
belongs to.

**Signal condition, all three required together** (any one alone is noise or negative —
`gap_down` alone is t=−3.54 net of costs):

| Flag | Meaning |
|---|---|
| `gap_down` | opened ≤ −2% vs prior close |
| `open_eq_low` | opened within 0.1% of the day's low, and the day had ≥0.5% real range |
| `top_loser` | in the bottom 5% of the universe by that day's return |

Plus the tradeability floors: ADTV ≥ ₹5cr, price ≥ ₹20, `is_suspect = 0`.

**To get last session's signals (today's trade list):**

```bash
cd src/server && python live_capitulation_screener.py --dry-run
```

That scans *today's running session* — its matches are candidates for **tomorrow**. For
names to trade **today**, you want yesterday's completed bars; derive them with
`screener_combo_finder.compute_tier1_precursors(ohlcv)` filtered to the last completed
date, reusing that function rather than re-deriving the flags (the thresholds live in one
place on purpose, so a retune moves the live scan and the backtest that validated it
together).

Expect **~1.5 names on a signal day, and signals on roughly 1 day in 3**. A list of 20
"capitulation" names means the filter is wrong — check it before trading it.

## Phase 3 — Size it

The edge is +0.53%/day excess. That is smaller than a single sloppy fill, which drives
everything about sizing.

- **Risk a fixed fraction, not a fixed conviction.** ≤1% of trading capital at risk per
  trade is the standard bar and there is nothing here that justifies more — this is one
  setup, t=3.6, on one platform's data.
- **This is an intraday hold, so your stop is time, not price.** The measured construct
  exits at the close regardless. If you also want a hard stop, put it below the signal
  day's low, and know that you are then trading something slightly different from what
  was measured.
- **Cap single-name exposure.** ~1.5 names/day means concentration is structural; the
  measured result is a basket average, and one name is a much wider distribution than the
  basket t-stat suggests.
- **The 0.53% is an *excess* return, not an absolute one.** Absolute P&L = that day's
  market move + 0.53%. Unhedged, most of your day-to-day variance is uncompensated market
  beta. Say this plainly — it is the most commonly misread number in the whole result.

**Expectancy, stated honestly** (derive it in front of the user, don't assert it):
SE = 0.53/3.61 = 0.147%, so the 95% CI on the per-day excess is **[0.24%, 0.82%]**. At
~77 signal days/year with capital deployed on each, that annualizes to roughly
**[18%, 63%] excess** on deployed capital — *if* the edge holds out of sample, *if* you
get filled near the open, and *before* your own slippage. Give the range, never the point
estimate alone.

## Phase 4 — Execute to the measured convention

| | Rule |
|---|---|
| Entry | **market open on D+1**. The result is an open→close return; entering mid-morning is not the tested trade. |
| Exit | **that same session's close.** No overnight hold. No "letting it run". |
| Direction | **long.** This is a bounce off a panic day, not a short. |
| Overrides | none. Discretionary filtering of a 1.5-name/day list is how a t=3.6 becomes noise. |

If the user cannot trade the open, tell them the setup does not fit their schedule rather
than adapting it — the entry timing *is* the edge here.

## Phase 5 — Log every trade, including the ones that lose

```bash
cd src/server
python trade_journal.py log --symbol PRECWIRE --signal-date 2026-08-12 \
    --trade-date 2026-08-13 --qty 100 --entry 61.40 --exit 62.85
```

Log at entry even if you don't yet know the exit; `grade` fills the rest. Skipping the
losers is the fastest way to build a journal that lies to you.

## Phase 6 — Grade, weekly

```bash
cd src/server
python trade_journal.py grade      # fills benchmark + excess from settled OHLCV
python trade_journal.py report     # per-date stats, execution drag, verdict
```

`report` gives two rows that matter:

- **model** — what the setup earned on paper (OHLCV open→close, benchmark-subtracted).
- **realized** — what your actual fills earned, same benchmark.

**The gap between them is your slippage, and it is the number to watch.** The setup pays
0.53%/date. If your drag is 0.6%, the signal is fine and your execution is the problem —
fix fills or trade more liquid names; do not conclude the setup is dead.

`report` refuses a verdict below ~40 trade dates. Respect that. Five green trades is what
makes people size up, and it is statistically indistinguishable from nothing.

**Kill switch:** if the 95% CI upper bound on realized excess is below zero, stop trading
the setup and diagnose. `report` prints this as `STOP`.

## What to say when asked "should I buy X?"

Answer the question, honestly, in this order:

1. **Does X match the measured setup right now?** If yes, say so with the three flags. If
   no, say it does not — that is the answer, not a prelude to finding another reason.
2. **What does the platform say, and what is that worth?** You can report
   `unified_recommendations` / `quant_scores` as context, but state their measured value:
   ranker IC ≈ 0, not yet gradeable. Do not launder a zero-IC score into a recommendation.
3. **Never substitute a story for a signal.** "Good fundamentals, oversold RSI, positive
   news" is exactly the reasoning this platform has already measured and found negative —
   `stoch_d` t=−9.28, `williams_r` t=−9.02, oversold-family all significantly negative,
   next-day news sentiment −0.03.

If nothing matches, the correct output is **"no trade today."** That is a successful run
of this skill, not a failed one.

## Boundaries

- This is decision support against measured evidence, not personalized investment advice,
  and it carries real risk of loss. Say so once, when the user first asks for a trade plan.
- Never place orders, never touch a broker API, never move money. Produce the plan; the
  user executes it.
- Do not add a new "final" score, signal table, or ranking to support a trade idea — see
  `.claude/rules/scoring-authority.md`. If a new setup looks promising, it goes through
  `factor_backtest.py` / `screener_combo_finder.py` and into `measurement.md` *before* it
  is traded, not after.
