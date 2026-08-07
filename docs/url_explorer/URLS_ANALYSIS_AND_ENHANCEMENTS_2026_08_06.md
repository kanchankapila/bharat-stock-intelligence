# urls.txt: Data Analysis & Codebase Enhancements (2026-08-06)

## Context — this is round 4, not round 1

`urls.txt` (1,983 captured third-party request URLs) has now been analyzed four times:

| Round | What happened |
|---|---|
| 2026-07-31 | `scripts/verify_live_urls.py`/`probe_endpoint_payloads.py` — a 919-URL corpus, status-code + payload-shape review. `docs/audit-2026-07-31/ENDPOINT_DATA_REVIEW_AND_QUANT_VALUE.md`. |
| 2026-08-03 | `src/server/url_explorer/` built (normalize → fetch → store → profile → correlate → report), run against the full 1,983-URL file → 250 endpoint templates, every one live-fetched and field-profiled. `docs/url_explorer/field_report.md` + `DATA_CATEGORIZATION_AND_USAGE.md`. Top 5 recommendations **shipped same day**: `tickertape_mmi`, `mc_deals_insight_top_investor`, `investsights_investors_list`, `investsights_concall_recent`, `investsights_sector_rrg`, `investsights_sector_correlation` added to `endpoint_registry.py` (archived raw), plus a full standalone fetcher for superstar-investor per-stock activity. |
| 2026-08-05 | `urls.txt` normalized (32 lines fixed, mostly doubled/malformed `https:////` slashes) → `urls.normalized.txt` + a section-coverage review (screener/fundamentals/news/F&O balance). |
| **2026-08-06 (this session)** | Closed the loop the prior three rounds opened but didn't finish: verified normalization's actual payoff, and — the literal ask — took the data that was still sitting as unparsed JSON text and made it real, queryable, tested, monitored tables feeding the app. |

**What this means for you:** most of the "should we integrate X" analysis was already done. This document focuses on (1) what normalization actually fixed, verified rather than assumed, (2) what was still a raw JSON blob and is not anymore, with real numbers from production, and (3) what remains — ranked, with a reason for every item still not done.

---

## 1. Closing the normalization loop

2026-08-05 fixed 32 malformed URLs (mostly doubled `https:////` slashes) and produced `urls.normalized.txt`, but never re-fetched the endpoints that fix unlocked. Diffing endpoint templates before/after:

- **250 → 248 templates** (net -2; several malformed duplicates collapsed into their correct canonical form)
- **4 templates recovered** that previously failed to parse into a fetchable URL at all: MoneyControl `get-stock-price`, `swot/swotCount` widget, `mcfinancials/getFinancialData` widget, and one collapsed generic `mc/widget/{path}` template.

**Live-fetched all 4 to find out what normalization actually bought us — and the answer is: not much.**

| Recovered endpoint | Real shape | Verdict |
|---|---|---|
| `mc/widget/swot/swotCount` | **Raw HTML fragment**, not JSON | Worthless for structured ingestion — and MC's `www.moneycontrol.com/mc/widget/*` family in general returns server-rendered HTML meant for direct embedding, not an API. Building a fetcher on it means HTML-table scraping, the exact pattern that caused the 2026-07-23 URL-as-symbol corruption (2.1M rows). **Do not build on this family.** |
| `mc/widget/mcfinancials/getFinancialData` | **Raw HTML table** (income/balance-sheet/cash-flow/ratios) | Same verdict — HTML, not JSON. This platform already has a JSON-based financials pipeline (`ET_Stats/mobile`, `financial_ratios_fetcher.py`); no reason to fall back to HTML scraping for equivalent data. |
| `api.moneycontrol.com/mcapi/v1/stock/get-stock-price` | Clean, small JSON (`companyName`, `lastPrice`, `perChange`, `marketCap`, `scTtm`, `perform1yr`, `priceBook` for a peer set) | Real JSON, but the fields duplicate data this platform already gets from `mc_pricefeed_fetcher.py`/`liveStockData.ts`. **Low marginal value — not built.** |

**Conclusion: fixing the malformed URLs was correct hygiene, but recovered zero genuinely new, structurally-sound data.** The value in this round came from the endpoints that were already correctly formed and simply sitting unparsed (Section 2), not from the ones normalization unlocked.

---

## 2. From raw JSON to structured tables — what changed this session

The 2026-08-03 round added 6 market-wide endpoints to `endpoint_registry.py` and archived their responses into `extra_endpoint_responses` — literally `(symbol, endpoint_name, response_json TEXT, updated_at)`, one text blob per fetch, not queryable, not joinable, not feature-usable. Live-checking `extra_features_parser.py` confirmed only the *per-stock* endpoints from that batch (FII/DII, Trading80, MarketsMojo, InvestSights overall score) had ever been parsed into real `ext_*` ML columns — the 6 *market-wide* ones (MMI, deals-insight, investors-list, concall, sector-rrg, sector-correlation) structurally can't go through that per-symbol parser, and none had a dedicated one. One (`tickertape_mmi`) had separately been given its own fetcher writing into `macro_asset_prices` (already a real ML feature, feeding `ml_ensemble.py`'s macro features and the HMM regime detector) — but had **zero frontend visibility**, confirmed via grep.

This session closed both gaps for the highest-value remaining endpoints, live-verified against production for every table below (2026-08-06 row counts):

| New table | Fetcher | Source endpoint | Rows (first run) | What it captures |
|---|---|---|---|---|
| `sector_rrg_history` | `investsights_sector_intel_fetcher.py` | `investsights.in/.../sector-rrg` | 228 | A real Relative Rotation Graph — `rs_ratio`/`rs_momentum`/`quadrant` (Leading/Weakening/Lagging/Improving) per sector per week. No equivalent chart exists anywhere in this app. |
| `sector_correlation_pairs` | same | `investsights.in/.../sector-correlation` | 190 (upper-triangle only, tagged `diversifier`/`redundant`/untagged) | The actual sector×sector correlation matrix `unified_ranker.py`'s `MAX_SECTOR_EXPOSURE` cap (2026-07-30) was explicitly built as a first-order stand-in for. |
| `sector_correlation_stats` + `sector_correlation_summary` | same | same | 20 + 1 | Per-sector return/volatility over the correlation window, plus a market-wide breadth summary + a third-party AI takeaway string (stored as text, never scored — see below). |
| `institutional_deal_signals` | `institutional_deals_fetcher.py` | `api.moneycontrol.com/.../deals/insight` (`topInvestor`, both `buy` and `sell`) | 54 | Ranked, counterparty-named institutional deal activity — e.g. a real ₹10,014cr Adani Green block trade between Adani Infra and Ardour Investment on 2026-08-03, ₹2,665cr SAIF Mauritius exit from Paytm. **This is a weekly-aggregate feed, not a per-transaction one** — `deal_value_cr_1w` ≠ `quantity × deal_price`; verified live and pinned in a regression test so this doesn't get "fixed" into a wrong derivation later. |
| `concall_takeaways` | `investsights_concall_fetcher.py` | `investsights.in/.../concall/recent` | 20 | AI-generated earnings-call tone + key takeaway, per company per quarter, properly timestamped (`announcement_date` = real disclosure date, kept separate from `generated_at` for as-of-join safety). This is the exact "unstructured-text LLM edge" opportunity the 2026-07-30/31 quant-strategy audit named — already built by a third party. Stored as **text**, deliberately not scored into a number (see below). |

All four are:
- **Scheduled** in `queues.ts` (daily, inside the existing evening market-metadata batch alongside `mmi_fetcher.py`/`nt_dashboard_fetcher.py`) — not one-off scripts.
- **Monitored** — 4 new entries in `dataQualityChecks.ts`'s `TABLE_FRESHNESS_CHECKS`, per the mandatory rule in CLAUDE.md.
- **Tested** — 6 new test files (3 offline unit-test files with fixtures captured from real 2026-08-06 payloads, 3 `live_datasource` files per the mandatory "Adding a New Data Source" rule), 50 tests, all passing against the real endpoints.
- **Surfaced via tRPC** — `getSectorRotationIntel`, `getInstitutionalDealHistory`, `getConcallTakeaways`, `getMarketMoodIndex` (new procedures in `misc.router.ts`, all cached).
- **`getMarketMoodIndex` is now on the Dashboard** — a small gauge widget (`MarketMoodGauge.tsx`) makes MMI visible for the first time; it was computing a real ML feature since a prior session but nobody could see it.

### Why the text stays text — a deliberate non-decision

Two of the new tables carry AI-generated prose (`sector_correlation_summary.takeaway`, `concall_takeaways.tone_assessment`/`key_takeaway`). Neither is turned into a numeric sentiment score in this pass. Scoring prose by keyword ("confident" → +1) is a guess with no validated rule behind it — exactly what this codebase's own standing practice (`CLAUDE.md`'s reverse-engineering-first rule, and `factor_edge.py`'s whole reason for existing) treats as untrustworthy until tested against real outcomes. The text is fully structured and queryable now (a real improvement over a JSON blob); turning it into a feature is future work that needs its own validation pass, not a default assumption bolted on here.

### Why `unified_ranker.py`'s live weights were not touched

`sector_correlation_pairs` is exactly the "fuller fix" the 2026-07-30 audit flagged for `MAX_SECTOR_EXPOSURE`'s covariance-free position-sizing cap. Wiring it into the ranker's live sizing math is a real algorithm change to a system with five prior audit passes' worth of accumulated caution about exactly this kind of change — it deserves its own dedicated, backtested pass, not a side effect of adding a data source. The data now exists in a form that pass can consume directly.

---

## 3. Remaining roadmap, ranked

| Priority | Item | Why it's not done yet |
|---|---|---|
| 1 | Wire `sector_correlation_pairs` into `unified_ranker.py`'s position-sizing cap as an actual covariance-aware constraint | Real algorithm change to live scoring — needs its own tested pass with backtested position-sizing comparison, not bundled with a data-source addition. |
| 2 | `investsights_investors_list` (aggregate superstar-investor directory — total_stocks_held, entries/exits counts) | Lower value than it first looks: the *actionable* per-stock signal (which superstar entered/exited *this* stock) is already built and live (`superstar_investor_activity`, feeding `fundamentals.router.ts` + the v5 `StockIntelligenceDeskPage`). This is just the supporting leaderboard metadata for a "Superstar Investors" directory UI — real but purely presentational, not a new signal. |
| 3 | Validate whether `concall_takeaways`' AI tone assessment has real forward-return edge, the same test `factor_edge.py` already runs on other third-party scores (which found Trendlyne's `m_score` has **no** edge) | Needs several weeks of accumulated `concall_takeaways` history to have a real sample to test against — not enough data yet on day one. |
| 4 | MC's 220-scanner screener surface, MC's historical Ohlson/Dupont/Altman/Graham score trends | **Explicitly not recommended without further work** (carried forward from the 2026-08-03 analysis): this platform's own 2026-07-30/31 audits found the *existing* screener weighting is already miscalibrated against measured forward returns (`screener_performance.py` was direction-blind until 2026-08-05) — adding a 5th screener source compounds a risk that was only just fixed, and MC's own historical-scores endpoint duplicates this codebase's already-computed Altman Z/Piotroski. |
| 5 | Re-verify `www.ndtvprofit.com` properly (a real `live_datasource`-style test, several symbols, spread over a few hours) | 2026-08-03's fetch contradicted a 2026-07-30 "confirmed dead" finding using TLS-fingerprint impersonation (`curl_cffi`) rather than a plain request — genuinely useful independent futures-basis/PCR data if real, but only ever tested once, anecdotally. Not re-tested this session; still open. |
| 6 | `mfapps.indiatimes.com` per-scheme MF holding breakdown | Lower priority than the items above; would need its own resolver work (this endpoint uses ET's internal scheme codes, not a format already mapped in this codebase). |

---

## 4. How this maps to "enhance features, increase accuracy, add insights"

- **Features (ML-usable)**: `sector_correlation_pairs`/`sector_correlation_stats` are ready inputs for a real covariance-aware position-sizing pass (item 1 above) — the single most concrete accuracy lever in this batch, deliberately not pulled yet. `institutional_deal_signals` gives a ranked, counterparty-named, weekly-aggregate institutional-conviction signal that didn't exist in any queryable form before today.
- **Insights (human-facing)**: the Market Mood Index gauge is now visible for the first time despite computing a real feature since a prior session — a genuine "why did nobody see this" gap closed. The RRG data (`sector_rrg_history`) is queryable and ready for a frontend chart — a well-known professional framework (quadrant rotation) with literally no equivalent visualization anywhere in this app today; not built this session (chart work needs live-browser verification this sandbox doesn't have), but the backend is done and tRPC-exposed.
- **Decision-making**: `concall_takeaways` gives structured, dated, per-company AI-generated earnings-call read — directly consumable by a "Latest Earnings Call Takeaways" panel (not built this session — frontend-only follow-up) and, once validated, a bounded ranker input.
- **Honesty about what didn't change**: the biggest single accuracy lever surfaced by this whole four-round analysis (sector correlation feeding real position-sizing) is *available* now, not *applied* — closing that gap safely is the next highest-value step, and it's explicitly not a data-integration task.

---

## 5. Verification

Every claim above was checked against live production, not assumed from a prior session's notes:
- Endpoint-template diff computed directly (`url_explorer.explore --normalize-only` on both `urls.txt` and `urls.normalized.txt`).
- All 4 recovered templates live-fetched and their real response bodies inspected (HTML vs JSON).
- All 6 previously-archive-only endpoints live-fetched fresh on 2026-08-06 and their exact response shapes used to design the new schemas (not guessed from the 2026-08-03 field-analysis notes).
- All 3 new fetchers run end-to-end against the real production Postgres DB; row counts above are real, not projected.
- 50 new tests (unit + `live_datasource`) written and passing against real endpoints.
- Full suites re-run clean after all changes: Python 1,120 passed / 173 deselected (`live_datasource`, separately run and passing) / 0 failed; TypeScript 3,783 tests / 425 files passed / 0 failed; `tsc --noEmit` clean.
