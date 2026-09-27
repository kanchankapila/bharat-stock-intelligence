# Market semantic layer: operator runbook

## What is implemented

The repository now has a PostgreSQL-first semantic control plane:

- `src/server/ontology/` is the authored T-box ontology and physical data-card layer.
- `market_data_contract` and `semantic_feature_definition` are executable, versioned contracts.
- `market_issuer`, `market_instrument`, `market_listing`, `market_identifier`, and
  `market_identifier_gap` provide conservative issuer/instrument/listing identity.
- `market_graph_node` and `market_graph_edge` provide a small bitemporal instance graph.
- `market_evidence`, `market_claim`, and `market_claim_evidence` separate source material from
  claims and claim support.
- `market_decision_event`, `market_decision_evidence`, and `market_decision_outcome` record the
  decision contract and realized outcomes.
- `market_data_watermark` records producer-published completeness, not just freshness.
- `unified_ranker.py` emits an evidence bundle additively after the canonical ranking write.
- `/mcp/decision-tools` is a read-only decision-agent surface; operational fetcher, backtest, and
  agent-execution tools remain on the operations surface.
- The chatbot receives ontology context and abstains when verified data is insufficient.

The layer does **not** treat `unified_score`, a vector similarity, vendor sentiment, or generated
`trade_reasoning` as a calibrated probability or independent proof. PostgreSQL remains the system
of record; the graph is a typed projection.

## Deployment order

1. Apply the additive migration with the repository's normal migration runner:

   ```powershell
   $env:POSTGRES_URL = '<production-or-target-postgres-url>'
   npm run migrate:up
   ```

2. Validate the authored ontology before materializing it:

   ```powershell
   Set-Location d:\Github\bharat-stock-intelligence\src\server
   $env:PYTHONDONTWRITEBYTECODE = '1'
   ..\..\backend-python\venv\Scripts\python.exe -m ontology verify
   ```

3. Materialize the ontology, executable contracts, and canonical identity graph:

   ```powershell
   ..\..\backend-python\venv\Scripts\python.exe -m ontology build `
     --out d:\Github\bharat-stock-intelligence\docs\ontology `
     --coverage
   ```

   `build` is ordered: verify → export → `kg_*` store → contracts → identity sync. If the target
   database does not have the semantic migration, contracts and identity report `unavailable`
   rather than silently pretending to be materialized.

4. For a dry run against the authored definitions without writing PostgreSQL:

   ```powershell
   ..\..\backend-python\venv\Scripts\python.exe -m ontology store --dry-run
   ```

## Read-only decision surface

The safe MCP endpoint/tool family is:

- `get_ontology_context`
- `get_decision_evidence`
- `get_entity_graph`
- `resolve_instrument`
- `get_top_conviction_picks`
- `analyze_stock_risk`
- `inspect_ingestion_health`
- `get_fetcher_status`
- `query_market_rag`

Example:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8005/mcp/decision-tools `
  -ContentType 'application/json' `
  -Body '{"tool_name":"get_decision_evidence","arguments":{"symbol":"RELIANCE"}}'
```

The endpoint rejects operational tools. Do not expose `/mcp/tools`, fetcher subprocesses, DLQ
requeue operations, backtests, or autonomous agent execution to a decision agent.

## Data-readiness rules

A decision is not considered fully reconstructed unless its event records:

- logical session and generation time;
- an explicit knowledge-cutoff bound and cutoff kind;
- ranker policy and feature-set versions;
- active model versions available at generation time;
- critical data-quality state;
- upstream completeness watermarks;
- structured support, contradiction, context, and veto evidence;
- guardrails explaining score/probability and vendor-opinion boundaries;
- outcome rows with an explicit `label_definition` and horizon.

A fresh latest row is not proof that a partition is complete. The watermark table is the source for
that distinction.

## Safe operating boundaries

- The LLM explains and summarizes the evidence; it does not create facts, probabilities, or trade
  actions.
- `market_evidence` records source material. An extracted item starts as `candidate` until a
  verification policy marks it otherwise.
- `market_claim` is not automatically true. `claim_status`, method, stance, and evidence links are
  part of the meaning.
- Vendor screener membership is candidate/context evidence, never ground truth.
- Outcomes from different `label_definition` values must never be aggregated together.
- A `provisional_symbol` identity is intentionally not merged by company name.

## Current follow-up work

- Run the migration and `ontology build` in the target environment; this session validated both
  DDL and the full schema snapshot only in isolated PostgreSQL schemas.
- Backfill the existing identity and decision evidence from historical runs as a separate,
  measured operation. The current ranker integration covers new runs.
- Add scheduled producer watermarks for each decision-critical upstream job; the table is ready,
  but producer-by-producer coverage is not yet complete.
- Add measured claim extraction/verification for unstructured filings and transcripts before
  allowing those claims to influence a publishable decision.
- Consider a read-only graph projection to Neo4j only after measured traversal workloads justify
  it; PostgreSQL remains authoritative for now.

## Verification

The implementation is verified by the repository's normal gate:

```powershell
npx tsc --noEmit
npx vitest run
python -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/ -q
```

Focused semantic verification additionally covers migration application, identity synchronization,
decision evidence, graph facts/claims, ontology contracts, RAG metadata, MCP dispatch, worker
read-only routing, and chatbot abstention.
