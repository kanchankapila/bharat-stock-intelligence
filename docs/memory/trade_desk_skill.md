# trade_desk_skill

> **Staged for the memory store.** This file lives in the repo because it was written from a
> cloud container with no access to
> `C:\Users\amitk\.claude\projects\d--Github-bharat-stock-intelligence\memory\`. Copy it there
> and add this line to `MEMORY.md`'s index, then this copy can be deleted:
>
> `- [[trade_desk_skill]] — the /trade-desk skill, the one setup with a measured edge, and why the journal grades fills against the model`

## What it is

`.claude/skills/trade-desk/` (added 2026-08-13). The daily trading loop: freshness gate →
candidate generation → sizing → execution → journal → weekly grading. Invoked for "what
should I trade today", "should I buy X", "how much should I size", "grade my trades".

Companion file `references/edge-inventory.md` is the one-page tradeable-vs-dead lookup
distilled from `measurement.md` — check a trade idea against it *before* sizing.

## The load-bearing fact

**Exactly one setup on this platform has survived a real measurement review**, and the skill
is built around it and nothing else: `screener_combo_finder.py --tier1`'s capitulation triple
— `gap_down` AND `open_eq_low` AND `top_loser` on session D, long at D+1 **open**, exit D+1
**close**. +0.53%/day excess net of 15bps, t=+3.61, p=0.0003, 425 dates, 6/6 years positive.

Things that are easy to get wrong about it:

- **Signal fires on D, trade happens on D+1.** `live_capitulation_screener.py --dry-run` scans
  *today's running session*, so its matches are **tomorrow's** candidates.
- **Any single leg is negative.** `gap_down` alone is t=−3.54, `gap_up` t=−3.55 — both turnover
  traps. Loosening any leg lands you in those rows. The narrowness is the edge.
- **0.53% is an *excess* return, not absolute.** Absolute P&L = the day's market move + 0.53%.
  Unhedged, most day-to-day variance is uncompensated beta. This is the most commonly misread
  number in the result.
- **Entry timing IS the edge.** It's an open→close return. If the user can't trade the open,
  the setup doesn't fit their schedule — don't adapt it.
- ~1.5 names on a signal day, signals on roughly 1 day in 3. A list of 20 "capitulation" names
  means the filter is wrong.
- Expectancy stated honestly: SE = 0.53/3.61 = 0.147%, 95% CI **[0.24%, 0.82%]**/day, ≈
  **[18%, 63%]/yr excess** on deployed capital. Always give the range, never the point estimate.

## The design principle worth reusing

**`trade_journal.py` grades the user's fills against the model's fills, and reports the gap.**
The edge is 0.53%/day — smaller than one sloppy entry — so `model_excess` (stock_ohlcv
open→close, benchmark-subtracted) and `real_excess` (actual fills, same subtraction) are both
computed, and their difference is execution drag. Verified live: a fill 0.5% above the open
produced +0.82%/date of drag against a 0.53% edge.

The point is the *attribution*: when drag exceeds what the setup pays, the verdict says the
fills are the problem rather than letting the user conclude the signal is dead. Any future
"is my strategy working" tooling should split these two the same way — a single blended
realized number cannot tell a dead signal from bad execution.

`report` refuses a verdict below 40 trade dates (the backtest had 425) and prints `STOP` when
the realized 95% CI upper bound goes negative.

## Why the skill refuses to promise profits

The user asked for a skill to "make huge profits." Declined that premise, built the skill.
`measurement.md`: zero of 26 backtested factors positive-and-significant; canonical ranker IC
≈ 0.0001 (t=0.02); 14 of 23 `feature_store` columns significantly *negative*; screener bullish
consensus significantly negative with inverted labels. **So the platform's own Buy/Sell/Strong
Sell labels are not trade instructions** — refusing them is the highest-value thing the skill
does. A profit-promising skill would have been `recurring-bugs.md`'s "evidence-shaped output"
class in skill form (five fabricated backtest scripts were deleted for it on 2026-08-12).

## Gotcha found in this session — see also recurring-bugs.md

Quantile winsorization with pandas' **default linear interpolation does not clip a lone extreme
value.** One corrupt bar in n=100 → cutoff lands ~1% of the way toward the outlier → the
"winsorized" mean came out +26% against a true +1%. Use
`quantile(pct, interpolation="higher")` / `quantile(1-pct, interpolation="lower")`.
Repo-wide check: no other instance — `dl_engine.py`, `unified_ranker.py`, `factor_backtest.py`
all use fixed absolute bounds, which are immune. Matters because the panel spec mandates
winsorizing, so the next implementation will likely reach for quantiles.

Found only because a test was written for exactly the corrupt-bar case. The code read as
correct. This is the negative-control rule paying for itself.

## Running python from a bare cloud container (cost me real time)

The web/cloud container has **no venv and no `.env`** — a fresh clone only. Concretely:

- `pip install pytest pandas scipy numpy sqlalchemy psycopg2-binary` gets `trade_journal.py`
  and its tests running. Adding `curl_cffi pydantic yfinance scikit-learn beautifulsoup4
  hmmlearn` takes the suite from 35 collection errors down to 9.
- **`ta`, `nse`, `torch`, `lightgbm` will not build there.** The 9 remaining uncollectable
  modules and ~5 failures are all these — pre-existing, not a regression. Establish that before
  chasing a red suite.
- **`db_compat` defaults to Postgres and will try :5433 and refuse the connection.** To
  exercise a DB path against a throwaway SQLite fixture you need **both**
  `USE_POSTGRES=false` *and* `DATABASE_URL=sqlite:///<path>` — setting only `DATABASE_URL`
  silently still goes to Postgres. Same family as the documented "`tsx` script without
  `dotenv/config` talks to SQLite" trap, in the opposite direction.
