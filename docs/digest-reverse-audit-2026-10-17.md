# Daily recommendation reverse audit — 2026-10-17

## Scope and method

This is an audit of messages actually recorded as successfully sent in `telegram_report_log`,
for NSE sessions 2026-10-05 through 2026-10-16. The first `POSITIONAL / SWING` section of each
message supplied five published names. Duplicate evening/morning sends for the same session
were counted once. An adverse same-day low means `low / open - 1 <= -3%`; a contrary Sell high
means `high / open - 1 >= +3%`. These are path excursions, **not** a completed swing verdict.
Five-session return is entry-session open to the open five observed sessions later; it is available
only for calls dated 2026-10-05 through 2026-10-09. Suspect bars were excluded. No return is
imputed for an unobserved window. All prices and membership came from the local production DB;
no exchange execution or fill is claimed. The `unified_recommendations_history` snapshot was
chosen by `computed_at` and its latest `generated_at` before 09:15 IST on the call session.

The stock digest publishes **Buy/Strong Buy only**. Its Sell/Strong Sell audit below evaluates
the canonical ranking snapshot that the same digest was built from; it does not claim those
Sell names were sent in Telegram.

## Published Buy calls

There were 50 distinct multi-day calls over 10 sessions. All 50 have a clean same-day bar:
14 reached an adverse low of at least 3% from the open, and 26 closed below the open. The
five-session window has matured for 25 calls: 19 lost money, with mean gross return -2.365%.
Across the five start dates, four daily baskets lagged NIFTY; the five daily excess returns
were -3.76%, +1.40%, -3.83%, -4.65%, and -3.99%. These five overlapping holding windows
are **not five independent trials** and do not establish a new calibrated threshold.

Every published call that reached an adverse low of at least 3% from the session open is below.
Day return is the same session's open-to-close move; a pending week means five subsequent sessions
had not yet elapsed. The component scores are the latest stored canonical snapshot available
before 09:15 IST on the call session, including prior-evening snapshots; **every row was labelled
Strong Buy and had three contributing engines**. `Tech / confl. / ML` are score inputs, not
estimated probabilities of a profitable trade.

| Session | Published symbol | Low from open | Day close | 5-session open return | Unified | Tech / confl. / ML |
|---|---|---:|---:|---:|---:|---:|
| 2026-10-05 | SHILPAMED | -4.57% | -3.54% | -2.25% | 97.0 | 95.1 / 98.7 / 50.3 |
| 2026-10-08 | MENONBE | -5.31% | -3.82% | -4.87% | 98.9 | 98.8 / 99.6 / 50.0 |
| 2026-10-08 | GLOBAL | -4.15% | -3.04% | -0.58% | 97.7 | 98.8 / 99.2 / 49.9 |
| 2026-10-08 | FINCABLES | -6.73% | -6.35% | -3.76% | 96.7 | 97.3 / 99.2 / 49.8 |
| 2026-10-08 | SHILPAMED | -5.71% | -4.84% | -10.17% | 96.0 | 97.3 / 97.2 / 49.8 |
| 2026-10-09 | STYL | -3.98% | -2.93% | -6.05% | 96.8 | 98.6 / 99.5 / 50.1 |
| 2026-10-12 | MENONBE | -3.14% | -0.96% | pending | 97.7 | 100.0 / 97.2 / 49.9 |
| 2026-10-13 | AETHER | -4.36% | -4.04% | pending | 96.5 | 99.5 / 96.6 / 49.7 |
| 2026-10-13 | RPTECH | -5.65% | -2.15% | pending | 96.2 | 96.1 / 96.8 / 49.8 |
| 2026-10-15 | GAEL | -4.14% | -2.80% | pending | 96.9 | 96.5 / 99.3 / 50.1 |
| 2026-10-15 | DIACABS | -4.62% | -1.06% | pending | 96.7 | 97.9 / 99.3 / 49.6 |
| 2026-10-15 | RPTECH | -6.65% | -5.00% | pending | 96.6 | 98.9 / 96.5 / 49.6 |
| 2026-10-16 | HITECHCORP | -3.35% | -0.05% | pending | 97.8 | 99.6 / 96.7 / 49.5 |
| 2026-10-16 | MENONBE | -3.41% | -2.64% | pending | 96.1 | 97.4 / 96.9 / 49.7 |

The full five-session losing set includes SHILPAMED, BOSCH-HCIL, RPTECH, FOSECOIND and MARKSANS on
2026-10-05; SHILPAMED, PRECWIRE and INNOVACAP on 2026-10-06; SHILPAMED, RPTECH, TATVA and
FINCABLES on 2026-10-07; all five published names on 2026-10-08; and FINCABLES and STYL on
2026-10-09. These names were identified from the actual messages, not reconstructed top-score
lists; the latter omit the historical timeframe filter and differ on some dates.

## Opposite Sell calls in the canonical grid

The 10 snapshots contained 4,004 Sell/Strong Sell stock-days with a clean bar. Of these, 854
reached a high at least 3% above the open, but many later faded; 299 **closed** at least 3%
above the open. In the same ranked universe, 8.38% of all names closed up at least 3%; the
rates were 8.43% for Sell and 6.76% for Strong Sell. This is weak directional separation,
not proof that the Sell book is uniformly inverted. There were 486 Sell/Strong Sell names
closing at least 3% below the open, versus 299 closing at least 3% above.

Of the 854 adverse highs, 370 had prior 20-session average traded value below ₹1 crore/day,
and 598 below ₹10 crore/day. Thin liquidity explains a material part of the extreme high
excursions, but not all. Liquid contrary closes are below with the stored pre-call scores;
all seven had three contributing engines. A high confluence score alongside a Sell label is
a component conflict to investigate, not proof that confluence predicted the rally.

| Session | Symbol | Call | Close from open | Prior ADT | Unified | Tech / confl. / ML |
|---|---|---|---:|---:|---:|---:|
| 2026-10-06 | MOBIKWIK | Strong Sell | +19.26% | ₹59.1cr | 18.7 | 47.3 / 6.0 / 48.8 |
| 2026-10-06 | BALAMINES | Sell | +16.66% | ₹46.8cr | 27.7 | 47.3 / 93.7 / 49.8 |
| 2026-10-05 | SMCGLOBAL | Sell | +14.50% | ₹55.9cr | 23.3 | 46.2 / 93.1 / 50.2 |
| 2026-10-14 | WSTCSTPAPR | Sell | +13.31% | ₹42.0cr | 28.8 | 48.4 / 98.5 / 49.8 |
| 2026-10-12 | GOODLUCK | Sell | +13.21% | ₹25.4cr | 29.2 | 48.0 / 74.2 / 51.1 |
| 2026-10-14 | V2RETAIL | Sell | +12.37% | ₹40.5cr | 29.0 | 0.1 / 68.0 / 50.7 |
| 2026-10-15 | GALLANTT | Strong Sell | +10.99% | ₹91.3cr | 11.9 | 48.0 / 3.3 / 50.7 |

## Traced causes and decisions

1. **A real research leak was fixed.** `reverse_engineering_study.py` compared pre-open gap
   against a prior-close-to-close return containing the gap already visible at 09:10. On the
   corrected event open-to-close target, the eligible-universe pre-open gap mean rank IC over
   20 dates was **-0.2073**, versus the previous mechanically positive **+0.1384** on 21 dates.
   The populations/windows differ by one date, so the two numbers are diagnostic rather than a
   paired effect estimate. Pre-open imbalance was +0.0468 on the corrected target. This is an
   exploratory signal: opening-auction price, execution, costs and out-of-sample reliability
   still need a preregistered test before any production promotion.
2. **The mover study's comparison denominator was inconsistent.** Factor rows previously
   included symbols outside the mover event's clean, historically listed, liquid equity set.
   The study now computes one eligible frame and reports mover-only and full-universe IC as
   different populations. Historical EQ membership is used to avoid a current-master
   survivorship filter; known ETFs are vetoed by instrument identity.
3. **High score does not mean proven Buy probability.** Published top fives repeatedly held
   names with technical and confluence component readings near 100 while ML readings were near
   50 and only three weighted engines contributed. The score is a cross-sectional blend,
   yet `Strong Buy` is an absolute score label. This is consistent with the existing
   AF-20261007-05 finding that the Buy side and conviction ladder have no verified tradeable
   edge. These 10 sessions add fresh adverse evidence; they cannot alone justify changing
   weights or thresholds. The frozen forward test remains the decision gate.
4. **Execution is missing from the digest verdict.** HITECHCORP traded at one price for the
   entire 2026-10-14 and 2026-10-15 sessions while appearing as a published Strong Buy.
   An OHLCV bar cannot establish that a reader could buy at the shown entry; single-price
   circuit sessions need a fillability flag before reported returns are called executable.
5. **A scheduled delivery defect was fixed.** The 2026-10-14 “pre-open” brief was actually
   sent at 12:32 IST following restart/catch-up. `processMorningBrief` now refuses to send
   after 09:15 IST, including forced catch-ups, with a regression test that first failed on
   the unfixed implementation. Other days had only the evening digest; missing morning sends
   are an operational issue, not evidence that an unsent morning list was acted on.

This audit does not claim a particular news event, corporate action, or factor caused each
contrary stock move. The stored pre-call signals show what the system knew; causal attribution
would require event timestamps and independent controls. Rewriting the ranker from the losing
names alone would fit hindsight rather than improve expected future returns.
