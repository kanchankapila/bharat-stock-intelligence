# Trendlyne Checklist Restoration — Design

**Date:** 2026-07-05
**Status:** Approved by user, pending spec review

## Problem

`fetchTrendlyneChecklist()` (`src/server/trendlyneService.ts:102-105`) is a permanent stub:

```ts
export async function fetchTrendlyneChecklist(symbol: string) {
  console.warn(`[TRENDLYNE] Checklist has no JSON API on Trendlyne (only HTML widget scraping); returning null for ${symbol}`);
  return null;
}
```

It was downgraded from a working HTML-widget scraper to this null stub in commit `0f18cd7`
(2026-07-04) because the old widget endpoint had broken, and `syncProprietaryScores.ts`'s
`syncTrendlyneScores()` treated the resulting permanent-null as a rate-limit failure signal,
aborting its daily sync run. The fix at the time was to make checklist a harmless no-op
probe rather than restore scraping.

The user has since found a working replacement endpoint —
`https://kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/{tlid}` — and wants
checklist data restored, but collected as a slow, randomized background sweep across the
full NSE stock universe rather than fetched on demand or in one daily burst (mirroring the
rate-limit incident already hit today with ETNow — see `etnow_rate_limit_double_trigger`
memory).

Confirmed as *not* in scope: MoneyControl SWOT (`fetchMcSwot`, `mcApiService.ts:384-399`,
`getMcSwot` router) is already live at the exact URL the user referenced
(`api.moneycontrol.com/mcapi/v1/swot/details?scId=...&type=all`) — no changes needed there.

## Current state (found during investigation)

- **Endpoint shape**: `checklist-bypk/{tlid}` returns server-rendered HTML (not JSON, despite
  the `clientapi` path segment) — confirmed live against `tlid=175` (Bharat Electronics /
  BEL). Structure: repeating category blocks (`Financials`, `Ownership`, `Peer Comparison`,
  `Value And Momentum` for BEL — categories vary per stock), each with a positive/negative
  question count header and a list of question rows, each showing the question text and an
  explicit `YES`/`NO` verdict. For BEL: 23 questions total, 17 YES / 6 NO across 4 categories.
- **`tlid` resolution already solved for the full universe**: `nse_stocks.tlid`
  (`db/schema.postgres.sql:1172`) is populated for ~3,022 stocks today via
  `trendlyne_screener_stocks.stock_id` as a fallback (`scripts/syncAllStockMappings.ts:52-59`,
  `src/server/trendlyne_overview_fetcher.py:458-469`) — not limited to the 180-stock curated
  `stocklist.ts`. This pool grows automatically as more screeners get scraped; no new
  resolution mechanism is needed. (An orphaned `tlid_mapping.csv`, 5,699 rows, sits unused at
  repo root — out of scope here, not required.)
- **Target output shape is dictated by dormant frontend code**, not by us:
  `TrendlyneChecklistCard` in `src/components/MCStockInfoPanel.tsx:117-182` already expects
  exactly:
  ```ts
  {
    score: number,      // pass-rate percentage, 0-100 (rendered as `${score.toFixed(1)}%`)
    total: number,
    yesCount: number,
    insight?: string,   // optional; renders only if present
    checklistData: { [sectionName: string]: Array<{ question: string; answer: boolean }> }
  }
  ```
  This has been sitting dead since the stub landed; restoring real data with this exact shape
  requires zero frontend changes.
- **Two existing consumers of `fetchTrendlyneChecklist`**:
  1. `getTrendlyneChecklist` tRPC procedure (`src/server/routers/trendlyne.router.ts:22-24`)
     — feeds the UI panel above, called per-stock-view.
  2. `syncTrendlyneScores()` (`src/server/syncProprietaryScores.ts:88-124`) — daily batch over
     `getAllStocks()`, called once/day from `processQuantEodSync` (`queues.ts:873`, cron
     `30 12 * * 1-5`). Also computes DVM (`getTrendlyneDVMFromDb`, a local DB read, no network
     call, no rate concern). Comment at lines 97-98 explicitly calls checklist "a probe so
     this self-heals if it's ever restored" — confirms this call site was left deliberately
     inert, not accidentally broken.
  - Existing test `src/server/__tests__/syncTrendlyneScores.test.ts` mocks
    `fetchTrendlyneChecklist` to always return `null` and only asserts DVM-related writes
    (durability/valuation/momentum) — no assertion depends on checklist behavior, so removing
    checklist from this function's loop is a safe, test-compatible change.
- **No HTML parsing library currently installed** (`cheerio`, `node-html-parser`, `jsdom` all
  absent from `package.json`). The pre-removal scraper used regex against a single flat
  `data-checklist-data` attribute — this endpoint's real nested category→question HTML is a
  poor fit for regex.

## Decisions made during design discussion

1. **Scope: full NSE universe, not just the 180-stock `stocklist.ts`.** Uses `nse_stocks`
   rows with `tlid IS NOT NULL` (~3,022 stocks today).
2. **Cadence: a 7-day active cycle covering the whole universe, then a 30-day dormant pause,
   then repeat** — not a single-day sweep, not fetch-on-demand.
3. **Persisted cache table, not pure on-demand fetch.** A 7-day background sweep only makes
   sense with a place to record progress and serve reads from — see Architecture.
4. **On-demand path never triggers a live fetch.** The UI's `getTrendlyneChecklist` call is a
   pure read of whatever's cached; a stock not yet reached in the current cycle just shows no
   checklist data. This keeps 100% of Trendlyne traffic to this endpoint funneled through the
   one controlled, paced background job — explicitly requested by the user ("don't rely much
   on demand") to avoid reintroducing an uncontrolled traffic source.
5. **`syncTrendlyneScores()` keeps DVM, drops checklist** — checklist gets its own dedicated
   pipeline; leaving it in the daily batch would still create an uncontrolled 3,000-request
   burst once a day, defeating the whole point of pacing it.

## Architecture

### New table: `trendlyne_checklist`

```sql
CREATE TABLE IF NOT EXISTS trendlyne_checklist (
  symbol          TEXT PRIMARY KEY,
  score           DOUBLE PRECISION,
  total           INTEGER,
  yes_count       INTEGER,
  insight         TEXT,
  checklist_data  TEXT,          -- JSON: { [section]: [{question, answer}] }
  fetched_at      TIMESTAMPTZ
);
```

Added to `db.ts` (SQLite dev schema + self-heal) and `db/schema.postgres.sql`, **and**
`pgClient.ts`'s `pgEnsureColumns()` `creates` array — per today's earlier fix, any new table
meant for live Postgres must be added to all three, not just the first two, or it silently
doesn't exist on already-provisioned databases.

### `fetchTrendlyneChecklist(tlid)` rewrite (`trendlyneService.ts`)

Real implementation: `GET checklist-bypk/{tlid}` with the same `HEADERS`/`Referer` convention
used elsewhere in the Trendlyne fetchers, parse the HTML with `cheerio` (new dependency) into
the `{score, total, yesCount, insight?, checklistData}` shape above:
- Each category block → one `checklistData` key, its question rows → `{question, answer}`
  array, `answer` = `true` when the row's verdict text is `YES`.
- `total` = sum of all questions across categories; `yesCount` = sum of YES verdicts;
  `score` = `yesCount / total * 100`.
- `insight` — not observed in the sample response; leave `undefined` if absent (frontend
  already handles this).
- Returns `null` on any fetch/parse failure (network error, unexpected markup, non-200) —
  preserves the existing "no data" contract both callers already rely on.

This function is called **only** by the new bulk cycle job below — no other call site invokes
it directly against the network.

### Bulk cycle job (new BullMQ queue `trendlyne-checklist-cycle`, `queues.ts`)

Self-rescheduling one-off job (BullMQ `repeat` only supports fixed cadence; true random
intervals need one-off delayed jobs that each schedule their own successor):

```
on each run:
  cycleStartedAt   = app_settings['trendlyne_checklist_cycle_started_at']   (create if absent, = now)
  cycleCompletedAt = app_settings['trendlyne_checklist_cycle_completed_at'] (null if in progress)

  if cycleCompletedAt is set AND now < cycleCompletedAt + 30 days:
    # dormant period — nothing to do, check back less often
    reschedule self in ~24h
    return

  if cycleCompletedAt is set AND now >= cycleCompletedAt + 30 days:
    # pause elapsed — start a fresh cycle
    cycleStartedAt = now; cycleCompletedAt = null (persist both)

  pending = SELECT symbol, tlid FROM nse_stocks
            WHERE tlid IS NOT NULL
              AND symbol NOT IN (SELECT symbol FROM trendlyne_checklist WHERE fetched_at >= cycleStartedAt)

  if pending is empty:
    cycleCompletedAt = now (persist)
    reschedule self in ~24h   # will hit the dormant branch above next run
    return

  batch = random_sample(pending, size = randint(10, 15))
  for (symbol, tlid) in batch:
    result = fetchTrendlyneChecklist(tlid)
    if result: upsert trendlyne_checklist (symbol, ...result, fetched_at = now)
    sleep(jittered ~1-2s)   # pacing within a batch, not just between batches

  reschedule self at random delay, uniform(15, 45) minutes    # true random interval
```

Wrapped in try/finally so a failure mid-batch still reschedules the next run — one bad batch
doesn't kill the chain. At server startup, only enqueue the initial kickoff if no job is
already waiting/delayed on this queue (checked via `queue.getDelayedCount()` or similar) —
otherwise every `tsx watch` dev restart spawns a duplicate chain.

**Pacing math**: ~3,022 stocks over 7 days ÷ ~32 runs/day (avg 30 min spacing) ≈ 13-14
stocks/run, matching the batch size range above. Naturally self-balancing — the "not yet
done this cycle" pool shrinks as the week progresses, so even with random per-run variance
the whole universe is covered comfortably inside 7 days without a hard schedule.

### On-demand path (`getTrendlyneChecklist` router, `trendlyne.router.ts`)

Changes from "call `fetchTrendlyneChecklist(symbol)` live" to "read
`SELECT * FROM trendlyne_checklist WHERE symbol = ?`, return `null` if no row." No network
call from this path, ever.

### `syncTrendlyneScores()` (`syncProprietaryScores.ts`)

Remove the `fetchTrendlyneChecklist` call and the `checklist` branch of `stockUpserts`
entirely (lines ~97-101, 116-118) — keep DVM only. Update the stale "kept as a probe" comment
to instead point at the new bulk cycle job as checklist's real home.

## Error handling

- Individual stock fetch/parse failure → `null`, skip that stock this run (it stays "pending"
  and gets picked up in a later run within the same cycle — no special retry logic needed,
  the shrinking-pool mechanism already retries).
- Whole-batch or whole-run exception → caught by the outer try/finally, next run is still
  scheduled. No alerting/heartbeat wired for v1 (kept deliberately small in scope); can be
  added later following the existing `MONITOR_SCRIPTS`/`job_heartbeat` conventions if this
  job needs visibility in the daily digest.

## Testing

- Unit test for the HTML→`checklistData` parser against a saved sample response (the BEL
  fixture already captured during design) — verify category grouping, YES/NO→boolean
  mapping, and `total`/`yesCount`/`score` aggregation.
- Unit test for the cycle-state transitions (fresh cycle start, mid-cycle batch selection,
  cycle completion, dormant-period skip, pause-elapsed restart) using a fake clock — no real
  BullMQ/network needed, this logic should be a plain function the queue processor calls.
- Update/verify `syncTrendlyneScores.test.ts` still passes unchanged after the checklist
  removal (it should, per the investigation above).

## Out of scope

- MoneyControl SWOT — already working, confirmed, no changes.
- Resolving `tlid` for the ~1,000-ish NSE stocks not yet covered by `nse_stocks.tlid` (the
  unused `tlid_mapping.csv` could close some of this gap later; not needed for this feature).
- Alerting/heartbeat visibility for the new cycle job.
- Historical checklist data / trend-over-time — this table only ever holds the latest fetch
  per symbol, overwritten each cycle.
