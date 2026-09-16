# Feature: data-layer (Postgres :5433 only + cache)

One TS facade (`dbAsync.ts:38,47,59` → `pgClient.ts`, pool `max = PG_POOL_MAX ?? (VITEST ? 5 : 22)`,
pgClient.ts:77; budget math 22+5+5+3+10=45/60 at :65-76) with 79 importer files. One Python
facade (`db_compat.py:85-92`, SQLAlchemy engine, **no pool_size → default 5+10=15 per process**
× 4 services vs the "Python 10" budget line). 226 tables; 6 hypertables / 5 compressed
(schema.postgres.sql:4362-4377); 53 node-pg-migrate files. Redis optional (cacheService.ts:12)
with in-memory L1.

```mermaid
flowchart TD
  ROUTERS["79 TS files"] --> FACADE["dbAsync dbGet/dbRun/dbTransaction<br/>dbAsync.ts:38,59"] --> POOL["getPool max 22 (5 vitest)<br/>pgClient.ts:77"] --> PG[("Postgres :5433<br/>max_connections=60")]
  ENSURE["pgEnsureColumns ~120 autocommit DDL<br/>pgClient.ts:192-617"] --> POOL
  CACHE["cacheService<br/>cacheService.ts:102,123,135"] --> L1["memCache Map 60s sweep<br/>:74,92"]
  CACHE --> REDIS["ioredis :6379"] --> RDS[("Redis")]
  DBC["db_compat get_engine<br/>db_compat.py:85-92"] --> PG
  TX["transaction() — 2 call sites only<br/>db_compat.py:508"]
  RANKER["unified_ranker upsert-then-purge manual commit<br/>unified_ranker.py:2860,2878"] --> DBC
  BYPASS["3 raw psycopg2 backfills (no db_compat)<br/>backfill_financial_trends_all.py:25 etc."] --> PG
  RETAG["retag_news.ts own Pool, no type parsers<br/>scripts/retag_news.ts:13"] --> PG
```

Key findings: [RISK] Python pool ceiling unbounded per service (db_compat.py:90) — 4×15
theoretical vs budget; [RISK] cache L1/Redis incoherence — `cacheSet` writes Redis only,
`cacheGet` promotes into L1 for 30s → stale-read window; **`cacheDel` has zero production call
sites** (cacheService.ts:135); [DEBT] `trendlyneScreener.ts:776,288` DELETE-then-refill not in
a transaction; no `statement_timeout` in any production pool; stale docstring `max_connections=50`
(pgClient.ts:102); 62 hand-rolled `_Fake*` conn classes across 35+ test files.
