# Bharat Stock Intelligence — Claude Instructions

## Memory

At the start of every session, read the memory index before doing any work:

**`C:\Users\amit_\.claude\projects\c--Github-bharat-stock-intelligence\memory\MEMORY.md`**

Then load any memory files that are relevant to the current task. This prevents re-exploring the codebase from scratch and reduces token consumption.

Key memory files:
- `project_architecture.md` — full system overview, tech stack, API strategies, file layout, DB schema, tRPC procedures. Read this before touching any backend or frontend code.
- `nse_stocks_implementation.md` — NSE stock database, search, and sector/industry filtering.

## Project Summary (quick reference)

Real-time Indian stock market intelligence platform. Backend: Express + tRPC (`src/server/router.ts` has all 100+ endpoints). Frontend: React 19 + Vite. DB: SQLite (`src/server/db.ts`). Cache: Redis → in-memory fallback (`src/server/cacheService.ts`). Background jobs: BullMQ (`src/server/queues.ts`). AI: Ollama primary, Gemini fallback.

## General Rules

- Read memory before exploring files — it already maps the codebase.
- All backend endpoints are in `src/server/router.ts`. Check there before searching elsewhere.
- Symbol mappings live in `src/data/stocklist.ts` (180 stocks) and `src/data/nseStocks.ts` (2000+ stocks).
- Do not add comments unless the WHY is non-obvious.
- Do not add error handling for impossible scenarios.
- Do not refactor beyond what the task requires.
