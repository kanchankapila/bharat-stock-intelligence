# Feature: api-gateway (:3000)

Entry `server.ts` → Express middleware (`50mb` JSON :289, security headers :296) → raw routes
(`/mcapi/*` :317 gated, `/api/internal/notify` :532 loopback-only, `/api/health` :519) → tRPC
`/api/trpc` (:409, context = `{req,res}`, context.ts:3) → 28 domain routers merged in
`router.ts` (pure merge point, 64 lines). WSS attached :575 with **no `path` option**
(websocketService.ts:104 — accepts upgrades on any path, unauthenticated, read-only alerts).

Procedure census (verified): **278 publicProcedure / 55 admin / 34 protected / 9 expensive**
(20/min/IP in-memory limiter, trpc.ts:56-66). AI: gemini/bedrock via `aiService.ts:13-43`.
WebSocket sources: AI path queues.ts:369, canonical picks after ranker queues.ts:2909-2911,
technical scans technicalSignalsService.ts:1628, 2% movers websocketService.ts:264-278.

```mermaid
flowchart TD
  C[Browser] --> MW1["express.json 50mb<br/>server.ts:289"] --> MW2["security headers<br/>server.ts:296"] --> R{route}
  R -->|"/mcapi/*"| MC["MC relay RL+auth<br/>server.ts:317"]
  R -->|"/api/internal/notify"| NT["loopback broadcast<br/>server.ts:532"]
  R -->|"/api/trpc"| T["tRPC adapter<br/>server.ts:409"] --> CTX["context {req,res}<br/>context.ts:3"] --> K{kind}
  K --> PUB["publicProcedure<br/>trpc.ts:12"]
  K --> PROT["protectedProcedure Firebase<br/>trpc.ts:18"]
  K --> ADM["adminProcedure ADMIN_UIDS<br/>trpc.ts:34"]
  K --> EXP["expensiveProcedure 20/min/IP<br/>trpc.ts:58"]
  K --> H["routers/ 28 files"] --> DB[("Postgres :5433<br/>dbAsync→pgClient")]
  H --> PY["runPython subprocess<br/>commandCenter.router.ts:332"]
  H --> AQ["alphaquant HTTP :8002<br/>technicals.router.ts:272 (public, uncached)"]
  H --> Q["BullMQ enqueue"] --> AIQ["ai-signals + LLM<br/>queues.ts:369"] --> WS["broadcast<br/>websocketService.ts:170"]
```

Key findings: [RISK] `saveBacktestStrategy` public unauth INSERT (ml.router.ts:501-517);
[RISK] `enqueueSignals` ≤200 LLM jobs/req, spend before write-gate (signals.router.ts:59-64,
queues.ts:340-384); [RISK] `getTvTa`/`getTvScreener` uncached unthrottled public proxy
(technicals.router.ts:272-289); [DEBT] WSS all-path upgrades; 50mb global body limit;
[DUP] monitor.router queue registry duplicated in-file (:631-667 vs :826-862).
