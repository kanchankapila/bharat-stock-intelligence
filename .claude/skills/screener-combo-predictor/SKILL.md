---
name: screener-combo-predictor
description: Find which COMBINATIONS of screeners (decomposed from their names into concept tags) predict a same-day mover, emit a ranked pick list by 9:30 AM IST from pre-open + opening-range data, then grade those picks against what actually happened and reverse-engineer why the real movers moved. Use when asked to predict today's high-return stocks, build/tune a daily intraday pick list, find the best screener combination, or run the daily predict→grade→learn loop.
---

# Screener-combination same-day predictor

Three loops that feed each other. **A** discovers which screener-concept combinations have a
same-session edge, **B** emits today's picks before 9:30 AM IST, **C** grades yesterday's
picks and reverse-engineers the real movers to feed A. Run B daily, C daily after close,
A weekly or when C reports drift.

Read `.claude/rules/measurement.md` and `.claude/rules/recurring-bugs.md` in full before
touching any of it. This skill is *inside* the scope of `verify-gate.mjs`'s backtest
requirement — a change to combination selection is a scoring change.

---

## The priors you are not allowed to ignore

Every one of these is a measured result in `measurement.md`, not an opinion. They exist
because this exact problem has been attacked before and most of the obvious answers are
already dead. **Do not spend a session rediscovering them.**

| Prior | Consequence for this skill |
|---|---|
| All 1,563 screeners tested individually: **0 survive FDR or Bonferroni** | Never rank single screeners. The unit of search is the **concept tag combination**. |
| Screener sentiment labels are **inverted** (bullish−bearish = −0.11pp, t=−4.61) and bullish consensus is significantly negative (t=−2.36) | `screener_catalog.signal_bias` and `polarity_hint()` are **variables to test**, never directions to trade. Derive polarity from realized returns. |
| `gap_up` AND `gap_down` are both significantly negative net of costs (t≈−3.5) — ~90% one-way turnover | A single price-shape flag is a turnover trap. Only narrow AND'd conditions have survived. |
| 14 of 23 `feature_store` columns are significantly **negative**; every clean-trend/overbought/high-volume reading is inverted | This panel mean-reverts at short horizons. A "strong momentum" combo is a prior-contradicting claim and needs more evidence, not less. |
| **The one surviving combination**: capitulation triple (`gap_down` AND `open_eq_low` AND `top_loser`), next-session open→close, +0.53%/day net of 15bps, t=+3.61, 6/6 years positive | This is the incumbent. A new combo must be argued **against this**, and it is already live in `live_capitulation_screener.py`. |
| `unified_recommendations` has too few pre-market dates to grade (clock started 2026-08-12) | Do not use the canonical ranker's accuracy as evidence for or against anything here yet. |

**The shape of every edge found on this data so far is short-horizon mean reversion off a
panic, not momentum continuation.** Weight your search accordingly.

---

## Loop A — Discovery: which combination of screeners?

### A1. Decompose names into concept tags

`src/server/screener_name_concepts.py` (pure, no DB, 22 tests in
`src/server/tests/test_screener_name_concepts.py`).

```bash
python src/server/screener_name_concepts.py --coverage          # catalog-wide audit
python src/server/screener_name_concepts.py --name "30 min Supertrend Buys"
```

**Why name decomposition is the right move, not a shortcut.** 1,534 screener names across
Trendlyne/ETnow/MoneyControl collapse onto 47 orthogonal tags across 8 facets (timeframe,
mechanism, participation, fundamental, event, descriptive). A single screener contributes a
handful of (symbol, date) rows — far too few to clear a 1,563-way correction even if its
edge were real. A tag like `mech_oversold` pools every screener expressing that concept
across all three providers, which is what gives the day-level t-test enough observations to
say anything. **The tag is the testable unit; the individual screener is not.**

Measured coverage, both naming systems that feed the search:

| Corpus | Names | ≥1 signal tag | Same-day relevant |
|---|---|---|---|
| EOD catalog (`screener_names.csv`, prose) | 1,534 | **82.1%** | 50.9% |
| Tier-2 live filters (`LIVE_SCREENER_FILTERS`, camelCase keys) | 45 | **100%** | 53.3% |

Re-run `--coverage` after any catalog growth. If a tag stops firing on the *full* catalog it
is dead vocabulary that still looks like coverage — fix or drop it. (Running `--coverage` on
a narrow subset like the 45 live filters will legitimately report most tags as never firing;
that warning only means something against the whole corpus.)

To audit the tier-2 filter keys, emit them from `liveScreenerCollector.ts`'s
`LIVE_SCREENER_FILTERS` as a `source,screener_id,screener_name` CSV and pass `--csv`. The
decomposer detects an identifier by the absence of whitespace and splits it on camelCase and
letter/digit boundaries instead of applying the prose de-glue.

Three things the decomposer already handles, all of them logged bug classes:
- `source` is lowercased (`screener_catalog` carries `trendlyne`/`Trendlyne` as distinct PK rows).
- ETnow glues the description onto the title; `YoY`/`QoQ`/`FnO` are protected from the split.
- `signal_tags` excludes `descriptive` facet tags — sector/theme/group membership is **not** a
  signal leg. Scoring exactly that class as bearish evidence is a logged production bug.

### A2. Filter to the same-day-tradeable subset

Drop any screener where `same_day_relevant` is false before searching. A quarterly
shareholding or annual-growth membership qualifies the same stock every day for ~60
sessions — it is a permanently-on column that cannot predict *which* day a stock moves, and
it will manufacture spurious combinations by co-occurring with everything.

### A3. Search combinations with the validated harness

**Do not write a new search.** `src/server/screener_combo_finder.py` already has the
day-level, benchmark-relative, cost-adjusted core that this repo trusts —
`_day_level_backtest()` aggregates to one row per (combo, day) *before* any t-stat, which is
the fix for the per-appearance-row inflation that makes a persistent filter look reliable.

Add concept tags as tier-2 features by joining `screener_appearances` → `screener_catalog`
→ `decompose_catalog()`, then call the existing `search_combinations()`. Keep `max_size=3`.

```bash
python src/server/screener_combo_finder.py --tier1              # incumbent, deep history
python src/server/screener_combo_finder.py --tier2              # concept tags, SHORT history
```

**Report tier-2 as a directional lead, never a finding.** `screener_appearances` spans ~2.5
months. That is fewer periods than `screener_breadth`, which is already flagged low-power.

### A4. Promotion gate

A combination is promotable only if **all** hold:

1. Day-level t-stat clears **Bonferroni across the full search space you actually enumerated**
   (not the shortlist you kept). With ~47 tags at depth ≤3 that bar is high — say so plainly
   rather than quietly comparing against t=2.
2. Positive in **≥4 of 6 calendar years**, or an explicit statement that history is too short.
3. Survives winsorization at 1/2/5% and dropping the 3 most extreme days.
4. Net of ≥15bps round-trip. Report one-way turnover — a >80% turnover combo needs a much
   larger gross edge.
5. Beats the incumbent capitulation triple on the same window, or is genuinely orthogonal to
   it (report the overlap in signal-days).

Fail any one → it is a lead, not a strategy. Say "no proven edge" and stop. **That is a
successful run of this skill, not a failed one** — the base rate of real findings here is
very low, and this repo's costliest incidents came from promoting weak results, not from
missing them.

---

## Loop B — Predict by 9:30 AM IST

### What data actually exists, and when

All cron patterns are UTC (`Etc/UTC`); IST = UTC+5:30. **NSE pre-open is 9:00–9:15 IST, open
is 9:15 IST.**

| IST | UTC | What lands | Usable at 9:30? |
|---|---|---|---|
| 03:00 | 21:30 prev | `unified_ranker.py` pre-market batch | yes (prior-day inputs) |
| 08:30 | 03:00 | `technical-signals` (every 30 min) | yes |
| **09:10** | 03:40 | `preopen_fetcher.py` → `preopen_snapshot`, `preopen_stock_snapshot` (**IEP, order-book imbalance**), then `early_hours_predictor.py` → `early_hours_predictions` | **yes — the highest-value pre-open input** |
| **09:15** | 03:45 | market opens; first `live-screener-collect` + `live_capitulation_screener.py` | yes |
| **09:20** | 03:50 | 5-min opening range complete (`orb5minHigh`/`orb5minLow` filters) | yes |
| **09:30** | 04:00 | second collector cycle | **emit picks here** |
| 15:30 | 10:00 | close; EOD fetchers, `stock_ohlcv` | no — Loop C only |

### The leakage rule

**Every feature must be provably knowable before the entry price you assume.** Entry is the
next available traded price after emission, not the 9:15 open you have already passed.

- Prior-day features: fine, they are settled.
- Today's pre-open IEP/imbalance: fine at 9:10.
- Today's opening-range/gap/top-loser flags: fine at 9:30 **only** if computed from bars
  strictly before 9:30, exactly as `live_capitulation_screener.py` does with running
  high/low rather than the final bar.
- Anything from `stock_ohlcv`: **never** — that is today's close.
- Never pair a same-day flag with a label it partly constitutes (a same-day gap flag against
  a same-day return is circular; `screener_combo_finder.py` takes precursors from the prior
  day for exactly this reason).

### Emitting picks — write them where they get graded for free

**Do not create a new predictions table.** Follow `live_capitulation_screener.py`: write each
pick into the existing `live_screener_appearances` under its own `filter_key` (e.g.
`comboPick_<combo_slug>`), linked to a fresh `live_screener_runs` row.

That single choice buys the entire learning loop with no schema change and no migration:
`live_screener_resolver.py` fills `return_intraday`/`return_1d/3d/5d` automatically, and
`backtest_live_screener.py`, `live_screener_optimizer.py` and `screener_combo_finder.py`'s
tier 2 all pick the new filter up as a first-class input.

Emit for each pick: symbol, the combination that fired, the tags, entry reference price, and
**the prior win rate of that combination** — a pick from a combo with no promoted track
record must be labelled as such.

Rank by the combination's measured day-level spread. **Do not blend in `unified_score`**
(rank IC ≈ 0.0001, t=0.02) or `stock_scores` (a documented standing downward bias).

Liquidity floor ≥₹1cr ADT and `is_suspect = 0`, always. Without it you are picking microcaps
you cannot trade, and this panel's most dramatic phantom edges all came from unfiltered bars.

**If no combination fires today, emit nothing and say so.** A daily pick list that always
produces picks is a ranking, not a prediction.

---

## Loop C — Grade, reverse-engineer, learn

Run after close. This is the loop that makes the skill improve; skipping it turns B into an
unfalsifiable generator.

### C1. Grade your own picks

Join yesterday's `comboPick_*` appearances to realized `return_intraday`. Report per
combination: n days, n signals, win rate as `WIN/(WIN+LOSS)`, **average realized return, and
the same-day universe return as benchmark**. Per-date, then averaged — never pooled. Pooling
has flipped a conclusion here three separate times.

A win rate without its benchmark is not a result: 66.7% on a down day and 45.8% on an up day
is beta to that day's tape, not skill. That is precisely how the current `Sell` bucket reads.

### C2. Reverse-engineer the real movers (this is where new factors come from)

Invoke `/signal-accuracy-review` — do not hand-roll this. For today's real top gainers and
losers, ask, in order:

1. Did any promoted combination flag it pre-open? If not, **why not** — no membership, a tag
   that did not fire, a liquidity/`is_suspect` filter, or genuinely no pre-open evidence?
2. What *did* it carry at 9:30 — which screener names, which concept tags, which pre-open
   IEP imbalance, which prior-day delivery/volume state?
3. Was the cause knowable at 9:30 at all? News at 11:00, a block deal, an index rebalance,
   or a sector-wide move is **not** a missed signal — labelling it one manufactures a
   spurious factor. Separate "we missed it" from "it was unknowable."
4. Is the miss a *class*? One symbol is an anecdote. The same tag missing across many movers
   over several days is a candidate feature for Loop A.

`live_screener_appearances` is 15-min resolution through the whole session, so you can see
what a stock looked like at 9:30 versus when it actually moved. That intraday record is the
reverse-engineering substrate — use it rather than reasoning backwards from the close.

### C3. Update the track record, honestly

Persist per-combination running stats to `app_settings` via `screener_combo_finder.py`'s
`_persist()` pattern (`{combo, n_days, spread_pct, t_stat, as_of}`).

Demote a combination when its **live** spread turns negative over ≥20 trading days.
`live_screener_ml_ranker.py` is the cautionary precedent sitting right next to this: held-out
AUC 0.66, live AUC **0.3778** over 47,559 resolved rows — anti-predictive, its best picks the
worst performers. Held-out score is not transfer. Gate on live outcomes.

Never retune weights on a day's losses. A single bad day is noise at these sample sizes, and
`measurement.md` is explicit that reweighting is not a fix when no component has a
demonstrated edge.

---

## Failure modes specific to this task

- **A combo that fires every day is a universe filter, not a signal.** Check signal density;
  the incumbent fires ~1.5 signals/day.
- **A t-stat from a shortlist is not corrected.** Bonferroni over everything enumerated.
- **A "success" heartbeat on a day that emitted zero picks** will erase real failures — have
  the no-pick path return `{ skipped: true }`, per the logged skip-path-as-success class that
  recurred 5 times.
- **`date.today()` as a write anchor** breaks post-midnight-IST runs. Use
  `as_of.logical_trading_date()`.
- **A backtest script that never connects to the DB** but prints plausible numbers is worse
  than no measurement. If a verification script's numbers exist before any `.execute()`, it is
  fabricated. Five such scripts were deleted from this repo in one review.
- **`float(x or 0)` on a model output**: NaN is truthy. Skip the row; coercing to 0 fabricates
  the worst possible score.
- **Ordering by a column that does not exist** aborts the whole `SELECT` and nulls every
  sibling column, silently, behind a blanket `except`. Check `information_schema.columns`.

## Definition of done

```bash
python -m pytest src/server/__tests__/ src/server/tests/   # any .py change
npx tsc --noEmit && npx vitest run                          # any .ts change
```

Plus, for any change to combination selection or ranking:

- **Negative-control every new test** — revert the fix, confirm it fails, restore. Two of the
  tests written for the concept decomposer passed against deliberately broken code on the
  first attempt and had to be rewritten; assume yours will too.
- **Run against live production data and query the result back.** A green suite does not tell
  you a pick was written or graded correctly.
- Verify `process.env.USE_POSTGRES` before believing any hand-run script's numbers — without
  `import 'dotenv/config'` a `tsx` script silently reads dev SQLite and prints convincing
  wrong figures.
- Committed ≠ deployed: `.ts` needs `pm2 restart bharat-server`.
- Close the session per `CLAUDE.md`: `docs/session-log.md`, memory, and `.claude/rules/`.
