# Feature: scheduler (BullMQ + runPython)

`queues.ts` (3,327 ln) registers ~50 repeatable jobs (all UTC via addJobWithCatchup
`tz:'Etc/UTC'`, registerJob.ts:44-46) across morning / market-hours (every 15 min) / evening
/ night+Saturday lanes. `ml-daily-ops` (18:50 IST, 3.5h budget, 4h lock) = ~95 Python
invocations, 18 via StepTracker `T.run`, ~60 bare `.catch(console.warn)`, fan-outs 3/19/5
(queues.ts:707,821,1018). Catch-up guard matches active same-name runs (registerJob.ts:109-162).

```mermaid
flowchart TD
  MORN["07:10 closed-day-early / 08:30 research-premarket / 09:10 preopen"] --> P
  MKT["every 15min: technical-signals :1797 / intraday-fetcher :2307 / regime :2555 /<br/>live-screener :2471 / trendlyne-intraday :2162"] -.pool.-> POOL
  EOD["18:00-18:40 screeners → P[ml-daily-ops 18:50<br/>queues.ts:2234,2245]"]
  P --> C1["grid-ensure+alt-data :562-651"] --> C2["T.run fii-dii :660"] --> C3["batch1+_bhavcopy :707-730"]
  C3 --> C4["feature writers + allSettled 19-wide :733-902"] --> C5["outcomes 5d/15d :1018-1065"]
  C5 --> C6["densify :1095"] --> C7["ensemble incr+score+drift :1119-1151"] --> C8["breakout/movement :1181-1187"] --> C9["T.finish :1225"]
  T2["quant-eod-sync 22:00 5.5h :2808"] --> U["unified-ranker 22:30 :2932"] --> D["digests 22:40-23:00"]
  SAT["Sat: ml-weekly-retrain 10:30 6h-lock :2277 / dl-retrain 11:30 24h-lock :230"] --> TC["trendlyne-catchup every 20min 24/7<br/>trendlyneWeekly.jobs.ts:267"]
  POOL["MAX_PYTHON_CONCURRENT=5, 3min slot wait<br/>pythonRunner.ts:19,34"]
```

Key findings: [RISK] 19-wide runPython fan-out vs 5 slots + 3-min waiter → "slot likely leaked"
failures (queues.ts:821-902, pythonRunner.ts:19,34); [RISK] ml-weekly-retrain step budgets sum
>8h under a 6h lock (queues.ts:1320-1425 vs :2284); [RISK] trendlyne-catchup unguarded through
market hours while sibling midweek has the guard (trendlyneWeekly.jobs.ts:267 vs :80-83);
[DEBT] stock-refresh holiday-skip stamps success (:238-241/:1694-1697); dead duplicate
CATCHUP_STAGGER_MS (:1622-1623); stale header comment (:2210 vs :2234).
