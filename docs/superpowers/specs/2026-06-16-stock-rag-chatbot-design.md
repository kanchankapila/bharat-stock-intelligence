# Stock RAG Chatbot — Design Spec
**Date:** 2026-06-16  
**Status:** Approved  
**Author:** Amit (via Claude Code brainstorming)

---

## 1. Goal

Add a conversational AI assistant to the Bharat Stock Intelligence platform that can:
- Answer natural-language questions about Indian stocks
- Share detailed stock profiles (fundamentals, technicals, scores, news)
- Run analysis queries: "which stocks are fundamentally strong but undervalued?", "stocks with upcoming results showing positive signals"
- Look up stocks by screener name semantically ("what's in the momentum screener?")

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│              React App (existing, port 3000)        │
│  ┌────────────────────────────────────────────────┐ │
│  │  New "Chat" tab  →  StockChatbot.tsx           │ │
│  │  · message history, input, quick-query chips   │ │
│  │  · HTTP POST/SSE to FastAPI /chat (port 8001)  │ │
│  └────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (direct, not via tRPC)
┌──────────────────────▼──────────────────────────────┐
│         Python FastAPI  (src/server/chatbot/)       │
│                                                     │
│  LangGraph Agent:                                   │
│  [classify_intent] → [route_tools]                  │
│         ↓                    ↓                      │
│  [rag_search]         [sql_lookup | live_price |    │
│  (ChromaDB)            news_sentiment |             │
│                         earnings_calendar |         │
│                         screener_lookup]            │
│         └──────────────────┬────────────────────    │
│                    [synthesize_answer]              │
│                  (Ollama → Gemini fallback)         │
└─────────────────────────────────────────────────────┘
         │              │           │
    ┌────▼───┐   ┌──────▼──┐  ┌────▼──────┐
    │SQLite  │   │ChromaDB │  │yfinance / │
    │stocks.db│  │(local)  │  │earnings   │
    └────────┘   └─────────┘  └───────────┘
```

**Approach chosen:** Python FastAPI as a separate chatbot microservice (port 8001), called directly from the React frontend. The existing tRPC/Node server is unchanged.

---

## 3. LangGraph Agent

### 3.1 Agent State
```python
class AgentState(TypedDict):
    messages: list[BaseMessage]   # full conversation history (multi-turn)
    intent: str                   # classified intent for current query
    retrieved_context: str        # concatenated tool results
    stock_symbol: str | None      # extracted symbol if present in query
    sources: list[str]            # which tools were called (for UI display)
```

### 3.2 Graph Nodes

| Node | Responsibility |
|---|---|
| `classify_intent` | LLM call classifies query into one of 6 intents (see §3.3) |
| `route_tools` | Conditional edge — dispatches to correct tool node(s) |
| `sql_lookup` | SQLite queries: fundamentals, scores, signals, screener memberships |
| `live_price` | yfinance real-time quote for named symbol |
| `news_sentiment` | Query `news_articles` table; optionally re-score via FinBERT |
| `earnings_calendar` | Fetch upcoming result/earnings dates via yfinance `.calendar` |
| `screener_lookup` | ChromaDB semantic search on screener names → return constituent stocks |
| `rag_search` | ChromaDB similarity search over stock profiles (general/unstructured queries) |
| `web_search` | DuckDuckGo web search for live/recent data not in the local DB |
| `synthesize_answer` | Final LLM call combining all retrieved context into natural language response |

### 3.3 Intent Taxonomy (6 classes)

| Intent | Example queries | Tools invoked |
|---|---|---|
| `stock_detail` | "Tell me about INFY", "What is the score of Reliance?" | `sql_lookup` + `live_price` + `news_sentiment` |
| `fundamental_filter` | "Fundamentally strong but cheap stocks", "Low PE high ROE stocks" | `sql_lookup` (filtered SQL) |
| `screener_lookup` | "What stocks are in the momentum screener?", "Trendlyne bullish picks" | `screener_lookup` (ChromaDB + SQL) |
| `news_sentiment` | "What's the market saying about HDFC?", "Any news on TATA Motors?" | `news_sentiment` + `web_search` |
| `earnings_upcoming` | "Stocks with results next week with positive signals" | `earnings_calendar` + `sql_lookup` |
| `general` | Everything else — open-ended analysis, comparisons, sector views, macro questions | `rag_search` + `sql_lookup` + `web_search` |

### 3.4 LLM Configuration
- **Primary:** Ollama (local), model configurable via env `OLLAMA_MODEL` (default: `llama3.2`)
- **Fallback:** Gemini API (`gemini-2.0-flash`) — used when Ollama returns error or is unavailable
- Ollama endpoint: `http://localhost:11434` (same as existing app)

---

## 4. Tools (src/server/chatbot/tools/)

### 4.1 `sql_tool.py`

**`get_stock_fundamentals(symbol: str)`**
- Reads `stock_fundamentals`: trailing_pe, forward_pe, price_to_book, return_on_equity, revenue_growth, earnings_growth, debt_to_equity, market_cap, piotroski_f_score
- Reads `stock_scores`: score, confidence, classification, top_domain
- Reads `stock_factor_breakdown`: technical, fundamental, momentum, valuation
- Returns: dict with all fields + human-readable summary

**`filter_stocks_by_fundamentals(pe_lt, pb_lt, roe_gt, revenue_growth_gt, min_score)`**
- SQL JOIN on `stock_fundamentals` + `stock_scores`
- Used for: "fundamentally strong but undervalued" → `pe_lt=20, pb_lt=3, roe_gt=15, min_score=60`
- Returns: top 15 stocks sorted by composite score

**`get_buy_signals(symbol: str | None)`**
- Reads `signals` table: active BUY signals, confidence, entry/target/SL
- If symbol given: filter by symbol; otherwise returns recent high-confidence signals

**`get_screener_membership(symbol: str)`**
- Queries `trendlyne_screener_stocks` + `moneycontrol_screener_stocks` + `screener_master`
- Returns: list of screener names the stock appears in, with inferred sentiment/category

### 4.2 `price_tool.py`

**`get_live_price(symbol: str)`**
- Fetches `yfinance.Ticker(symbol + ".NS").fast_info`
- Returns: current price, day change %, 52w high/low, volume

**`get_earnings_calendar(days_ahead: int = 14)`**
- Fetches upcoming earnings dates via `yfinance.Ticker(...).calendar` for stocks in `nse_stocks`
- Cross-references with `technical_analysis_signals` (trend = 'Bullish') and `stock_scores` (classification IN ('Buy', 'Strong Buy'))
- Returns: list of `{symbol, name, earnings_date, trend, score, classification}`

### 4.3 `news_tool.py`

**`get_news_sentiment(symbol: str | None, days: int = 7)`**
- Queries `news_articles` WHERE symbols LIKE '%symbol%' OR recent general news
- Groups by sentiment (Positive/Negative/Neutral), returns summary + top headlines
- Optionally re-scores via `finbert_scorer.py` if article is recent

### 4.4 `screener_tool.py`

**`search_screener(query: str)`**
- ChromaDB similarity search on `screener_descriptions` collection
- Returns top-3 matching screeners by semantic similarity
- Then fetches constituent stocks from appropriate screener table
- Returns: `{screener_name, source, inferred_sentiment, stocks: [...]}`

### 4.5 `web_tool.py`

**`web_search(query: str)`**
- Uses `DuckDuckGoSearchRun` (via `langchain-community`) — no API key required
- Augments DB data with live web results: recent news, analyst reports, regulatory filings, event announcements, market commentary
- Used when: DB data is stale or absent for a query (e.g., very recent IPO, breaking news, management commentary, global macro impact on a sector)
- Results capped at top 5 snippets to control context length
- Returns: list of `{title, snippet, url}`

**When web search is triggered:**
- `general` intent queries about topics not in the local DB
- `news_sentiment` when `news_articles` table has < 2 articles for the stock in the last 7 days
- Any query mentioning "latest", "recent", "today", "this week", "just announced"
- `stock_detail` for a symbol not present in `nse_stocks` (e.g., new listing, global ADR)

**`web_search_stock(symbol: str, topic: str)`**
- Targeted version: constructs `"{company_name} {symbol} NSE {topic}"` search query
- Used inside `stock_detail` flow to fetch latest news/analyst views not in local DB

---

## 5. ChromaDB Collections

All stored in `src/server/chatbot/chroma_store/` (local disk, gitignored).

| Collection | Documents | Embedding source |
|---|---|---|
| `stock_profiles` | One doc per stock: name + sector + industry + description + AI analysis from `company_profiles` | `all-MiniLM-L6-v2` |
| `screener_descriptions` | One doc per screener: name + description + category + source | `all-MiniLM-L6-v2` |
| `news_articles` | Recent news articles (last 30 days), chunked at 512 tokens | `all-MiniLM-L6-v2` |

**Ingest script:** `src/server/chatbot/ingest.py`
- Run once at startup if `chroma_store/` is empty
- Re-run nightly (POST `/ingest` triggered by BullMQ daily job after `finbert_scorer.py`)
- Incremental: only re-embeds docs that changed (keyed on symbol / screener_id / article_id)

---

## 6. FastAPI Server (`src/server/chatbot/app.py`)

**Endpoints:**

```
POST /chat
Body: { message: str, session_id: str, history: [{role, content}] }
Response: { answer: str, sources: [str] }

GET /chat/stream
Params: message, session_id (history as query param JSON)
Response: SSE stream — data: {"token": "..."}\n\n

POST /ingest
(internal) Re-runs ChromaDB ingest for all collections
Response: { status: "ok", docs_added: int }

GET /health
Response: { status: "ok", ollama: bool, chroma: bool }
```

**CORS:** Allow `http://localhost:3000` (dev). Production: configure via env `ALLOWED_ORIGIN`.

**Session management:** In-memory dict keyed by `session_id` holding LangGraph `RunnableConfig` checkpointer state. Sessions expire after 30 min of inactivity.

---

## 7. React Chat Tab (`src/components/StockChatbot.tsx`)

**Tab:** Added as `chat` in `App.tsx` navigation alongside existing tabs.

**UI structure:**
- Header: "Bharat Stock AI" + connection status pill (Ollama/Gemini)
- Quick-query chips (pre-built analysis queries):
  - "Fundamentally strong but undervalued stocks"
  - "Stocks with upcoming results + positive signals"
  - "Top rated stocks today"
  - "Stocks in bullish screeners"
- Message thread: alternating user/AI bubbles, markdown rendered
- AI bubbles show `Sources: sql:stock_fundamentals, tool:earnings_calendar` footer
- Stock symbol pills in AI responses are clickable → opens existing tab for that stock
- Input bar + Send button
- Streaming: uses `EventSource` for SSE; tokens append progressively to latest AI bubble
- Loading state: animated dots while waiting for first token

**State:**
```typescript
interface Message { role: 'user' | 'assistant'; content: string; sources?: string[] }
const [messages, setMessages] = useState<Message[]>([])
const [sessionId] = useState(() => crypto.randomUUID())
```

**API calls:** Direct `fetch` to `http://localhost:8001/chat` (not through tRPC).

---

## 8. New Files Summary

| Path | Purpose |
|---|---|
| `src/server/chatbot/app.py` | FastAPI server, endpoints, CORS |
| `src/server/chatbot/agent.py` | LangGraph graph: nodes, edges, AgentState |
| `src/server/chatbot/tools/sql_tool.py` | SQLite retrieval tools |
| `src/server/chatbot/tools/price_tool.py` | yfinance live price + earnings calendar |
| `src/server/chatbot/tools/news_tool.py` | News sentiment tool |
| `src/server/chatbot/tools/screener_tool.py` | ChromaDB screener semantic search |
| `src/server/chatbot/tools/web_tool.py` | DuckDuckGo web search for live/recent data |
| `src/server/chatbot/ingest.py` | ChromaDB ingestion script |
| `src/components/StockChatbot.tsx` | React Chat UI component |

**Modified files:**

| Path | Change |
|---|---|
| `src/App.tsx` | Add `chat` tab entry + import `StockChatbot` |
| `requirements.txt` | Add langchain, langgraph, chromadb, fastapi, uvicorn, sentence-transformers |
| `package.json` | Add chatbot uvicorn process to `dev` script via `concurrently` |

---

## 9. Python Dependencies to Add

```
langchain>=0.3
langgraph>=0.2
langchain-community>=0.3
langchain-ollama>=0.2
langchain-google-genai>=2.0
chromadb>=0.5
duckduckgo-search>=6.0
fastapi>=0.111
uvicorn>=0.30
sentence-transformers>=3.0
```

---

## 10. Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.2` | Ollama model to use for LLM calls |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server endpoint |
| `GEMINI_API_KEY` | (existing) | Gemini fallback key |
| `CHATBOT_PORT` | `8001` | FastAPI server port |
| `CHROMA_PERSIST_DIR` | `src/server/chatbot/chroma_store` | ChromaDB persistence path |
| `DB_PATH` | `database.sqlite` | SQLite database path |
| `ALLOWED_ORIGIN` | `http://localhost:3000` | CORS allowed origin |

---

## 11. Query Coverage

The sample queries below are illustrative — the agent is designed to handle **any stock-related question** by combining DB data and web search. The intent classifier's `general` fallback ensures questions outside the named intents are still answered using RAG + web search.

**Representative queries that must work:**

1. **"Which stocks are fundamentally strong but undervalued?"**
   - Intent: `fundamental_filter`
   - SQL: `stock_fundamentals WHERE trailing_pe < 20 AND price_to_book < 2 AND return_on_equity > 15` JOIN `stock_scores WHERE score > 60 AND classification IN ('Buy','Strong Buy')`
   - LLM narrates top 10 results as a formatted table

2. **"Which stocks have results next week and are showing positive signs?"**
   - Intent: `earnings_upcoming`
   - Earnings calendar (yfinance, next 14 days) CROSS `technical_analysis_signals WHERE trend='Bullish'` AND `stock_scores WHERE classification IN ('Buy','Strong Buy')`
   - LLM returns ranked list with date, trend, and score

3. **"Tell me about HDFC Bank"**
   - Intent: `stock_detail`
   - Calls: `get_stock_fundamentals('HDFCBANK')` + `get_live_price('HDFCBANK')` + `get_news_sentiment('HDFCBANK')`
   - LLM narrates a comprehensive stock brief

4. **"What stocks are in the momentum screener?"**
   - Intent: `screener_lookup`
   - ChromaDB search: finds "momentum" screener in `screener_descriptions`
   - Returns constituent stocks with their AI scores

5. **"Compare Infosys and TCS"** → `stock_detail` × 2 + LLM synthesis
6. **"Which IT stocks are outperforming this quarter?"** → `sql_lookup` (sector=IT, quant_scores sorted by return_3m) + `web_search`
7. **"What is the FII/DII flow today?"** → `sql_lookup` (fii_dii table) + `web_search` if stale
8. **"Is Bajaj Finance a good long-term buy?"** → `stock_detail` + `news_sentiment` + `web_search` for analyst views
9. **"Which small-cap stocks have strong momentum?"** → `sql_lookup` (market_cap < threshold, quant_scores momentum_score > 70)
10. **"What happened to Adani stocks today?"** → `web_search` (likely very recent) + `news_sentiment`
11. **"Show me stocks above their 200 DMA with high ROE"** → `sql_lookup` (above_sma200=1, return_on_equity > 18)
12. **"What is the PCR for Nifty today?"** → `web_search` (real-time options data)

---

## 12. Out of Scope

- Authentication/user-specific chat history persistence (sessions are in-memory only)
- Portfolio buy/sell recommendations with exact quantity (regulatory risk)
- Real-time streaming quotes inside chat (handled by existing live stock view)
- Multilingual support (Hindi queries)
