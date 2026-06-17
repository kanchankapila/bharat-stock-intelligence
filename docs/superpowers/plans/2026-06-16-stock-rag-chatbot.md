# Stock RAG Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a LangGraph-powered RAG chatbot to the existing React app that answers any Indian stock market question using SQLite DB data, live prices, news sentiment, screener lookups, and web search.

**Architecture:** Python FastAPI server (`src/server/chatbot/app.py`, port 8001) hosts a LangGraph agent with 3 nodes — intent classifier → tool executor → answer synthesizer. The existing React app gets a new "Chat" tab that calls this service directly via SSE streaming. The existing Node/tRPC server is unchanged.

**Tech Stack:** Python 3.11, LangChain 0.3, LangGraph 0.2, ChromaDB 0.5, FastAPI (already in backend-python/venv), sentence-transformers (all-MiniLM-L6-v2), duckduckgo-search, Ollama (primary LLM) → Gemini fallback, React 19 + react-markdown

---

## File Map

**New files:**
```
src/server/chatbot/__init__.py
src/server/chatbot/llm.py              ← Ollama/Gemini selector
src/server/chatbot/agent.py            ← LangGraph graph (3 nodes)
src/server/chatbot/ingest.py           ← ChromaDB population script
src/server/chatbot/app.py              ← FastAPI server (port 8001)
src/server/chatbot/tools/__init__.py
src/server/chatbot/tools/sql_tool.py   ← SQLite retrieval (5 functions)
src/server/chatbot/tools/price_tool.py ← yfinance live price + earnings calendar
src/server/chatbot/tools/news_tool.py  ← news_articles table lookup
src/server/chatbot/tools/web_tool.py   ← DuckDuckGo web search
src/server/chatbot/tools/screener_tool.py ← ChromaDB screener semantic search
tests/chatbot/__init__.py
tests/chatbot/test_sql_tool.py
tests/chatbot/test_price_tool.py
tests/chatbot/test_news_tool.py
tests/chatbot/test_web_tool.py
tests/chatbot/test_screener_tool.py
tests/chatbot/test_agent.py
src/components/StockChatbot.tsx        ← React chat UI component
```

**Modified files:**
```
backend-python/requirements.txt        ← add LangChain/ChromaDB/etc.
package.json                           ← add "chatbot" npm script
src/App.tsx                            ← add "chat" tab + import StockChatbot
```

**Gitignored:**
```
src/server/chatbot/chroma_store/       ← ChromaDB persistence (add to .gitignore)
```

---

## Task 1: Install Python dependencies and create project skeleton

**Files:**
- Modify: `backend-python/requirements.txt`
- Create: `src/server/chatbot/__init__.py`
- Create: `src/server/chatbot/tools/__init__.py`
- Create: `tests/chatbot/__init__.py`
- Modify: `package.json` (add chatbot script)
- Modify: `.gitignore`

- [ ] **Step 1: Add new Python packages to backend-python/requirements.txt**

Append these lines to `backend-python/requirements.txt`:
```
langchain>=0.3.0
langgraph>=0.2.0
langchain-community>=0.3.0
langchain-ollama>=0.2.0
langchain-google-genai>=2.0.0
chromadb>=0.5.0
sentence-transformers>=3.0.0
duckduckgo-search>=6.0.0
pytest>=8.0.0
pytest-asyncio>=0.23.0
```

- [ ] **Step 2: Install the new packages into backend-python/venv**

```bash
# From project root
backend-python/venv/Scripts/pip install langchain>=0.3.0 langgraph>=0.2.0 langchain-community>=0.3.0 langchain-ollama>=0.2.0 langchain-google-genai>=2.0.0 "chromadb>=0.5.0" "sentence-transformers>=3.0.0" "duckduckgo-search>=6.0.0" pytest pytest-asyncio
```

On Windows PowerShell:
```powershell
& "backend-python\venv\Scripts\pip.exe" install langchain langgraph langchain-community langchain-ollama langchain-google-genai chromadb sentence-transformers duckduckgo-search pytest pytest-asyncio
```

Expected: `Successfully installed langchain-...` (no errors)

- [ ] **Step 3: Create directory skeleton with empty __init__.py files**

```bash
mkdir -p src/server/chatbot/tools tests/chatbot
touch src/server/chatbot/__init__.py
touch src/server/chatbot/tools/__init__.py
touch tests/chatbot/__init__.py
```

On Windows PowerShell:
```powershell
New-Item -ItemType Directory -Force "src\server\chatbot\tools"
New-Item -ItemType Directory -Force "tests\chatbot"
New-Item -ItemType File -Force "src\server\chatbot\__init__.py"
New-Item -ItemType File -Force "src\server\chatbot\tools\__init__.py"
New-Item -ItemType File -Force "tests\chatbot\__init__.py"
```

- [ ] **Step 4: Add chatbot npm script to package.json**

In `package.json`, add `"chatbot"` to the `"scripts"` section after `"ml-api"`:
```json
"chatbot": "node -e \"const{spawnSync:s}=require('child_process');const py=process.platform==='win32'?'backend-python/venv/Scripts/python.exe':'backend-python/venv/bin/python';const r=s(py,['-u','src/server/chatbot/app.py'],{stdio:'inherit',env:{...process.env,PYTHONUNBUFFERED:'1'}});if(r.error)process.stderr.write('[chatbot] spawn error: '+r.error.message+'\\n');process.exit(r.status??1);\""
```

Also update the `"start"` script to include `"npm run chatbot"`:
```json
"start": "concurrently \"npm run dev\" \"npm run api\" \"npm run ml-api\" \"npm run chatbot\""
```

- [ ] **Step 5: Add chroma_store to .gitignore**

Open `.gitignore` and append:
```
src/server/chatbot/chroma_store/
```

- [ ] **Step 6: Commit the skeleton**

```bash
git add backend-python/requirements.txt package.json src/server/chatbot/ tests/chatbot/ .gitignore
git commit -m "feat(chatbot): add project skeleton, deps, and npm script"
```

---

## Task 2: SQL Retrieval Tool

**Files:**
- Create: `src/server/chatbot/tools/sql_tool.py`
- Create: `tests/chatbot/test_sql_tool.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/chatbot/test_sql_tool.py`:
```python
import sqlite3
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from tools.sql_tool import (
    get_stock_fundamentals,
    filter_stocks_by_fundamentals,
    get_buy_signals,
    get_screener_membership,
    get_quant_scores,
)


@pytest.fixture
def test_db(tmp_path):
    db_path = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE nse_stocks (
            symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT
        );
        CREATE TABLE stock_fundamentals (
            symbol TEXT PRIMARY KEY,
            trailing_pe REAL, price_to_book REAL, return_on_equity REAL,
            revenue_growth REAL, earnings_growth REAL, debt_to_equity REAL,
            market_cap REAL, piotroski_f_score INTEGER, dividend_yield REAL
        );
        CREATE TABLE stock_scores (
            symbol TEXT, timeframe TEXT, score REAL, confidence REAL,
            classification TEXT, top_domain TEXT,
            PRIMARY KEY (symbol, timeframe)
        );
        CREATE TABLE stock_factor_breakdown (
            symbol TEXT, timeframe TEXT,
            technical REAL, fundamental REAL, momentum REAL, valuation REAL,
            PRIMARY KEY (symbol, timeframe)
        );
        CREATE TABLE signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, type TEXT, entry REAL, target REAL, stopLoss REAL,
            confidence REAL, reasoning TEXT, status TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE screener_master (
            scan_id TEXT PRIMARY KEY, name TEXT, source TEXT,
            inferred_sentiment TEXT, inferred_category TEXT
        );
        CREATE TABLE trendlyne_screener_stocks (
            screener_id TEXT, symbol TEXT, PRIMARY KEY (screener_id, symbol)
        );
        CREATE TABLE moneycontrol_screener_stocks (
            scan_id TEXT, mcsymbol TEXT, symbol TEXT, stock_name TEXT,
            PRIMARY KEY (scan_id, mcsymbol)
        );
        CREATE TABLE quant_scores (
            symbol TEXT PRIMARY KEY,
            return_1w REAL, return_1m REAL, return_3m REAL, return_6m REAL,
            above_sma200 INTEGER, momentum_score REAL
        );
    """)
    conn.executemany("INSERT INTO nse_stocks VALUES (?,?,?,?)", [
        ("INFY", "Infosys Ltd", "IT", "Software"),
        ("HDFCBANK", "HDFC Bank", "Banking", "Private Bank"),
    ])
    conn.executemany("INSERT INTO stock_fundamentals VALUES (?,?,?,?,?,?,?,?,?,?)", [
        ("INFY", 22.5, 4.2, 35.0, 12.0, 15.0, 0.1, 750000000000, 8, 2.5),
        ("HDFCBANK", 18.0, 3.1, 16.5, 8.0, 10.0, 0.5, 1200000000000, 7, 1.2),
    ])
    conn.executemany("INSERT INTO stock_scores VALUES (?,?,?,?,?,?)", [
        ("INFY", "long_term", 82.0, 0.85, "Strong Buy", "Fundamental"),
        ("HDFCBANK", "long_term", 74.0, 0.78, "Buy", "Technical"),
    ])
    conn.executemany("INSERT INTO stock_factor_breakdown VALUES (?,?,?,?,?,?)", [
        ("INFY", "long_term", 75.0, 88.0, 70.0, 80.0),
        ("HDFCBANK", "long_term", 80.0, 72.0, 65.0, 68.0),
    ])
    conn.execute("INSERT INTO signals VALUES (?,?,?,?,?,?,?,?,?,?)",
                 (None, "INFY", "BUY", 1450.0, 1600.0, 1380.0, 0.88, "Strong momentum", "ACTIVE", "2026-06-15 10:00:00"))
    conn.execute("INSERT INTO screener_master VALUES (?,?,?,?,?)",
                 ("TL_001", "Low PE High ROE", "trendlyne", "bullish", "fundamental"))
    conn.execute("INSERT INTO trendlyne_screener_stocks VALUES (?,?)", ("TL_001", "INFY"))
    conn.executemany("INSERT INTO quant_scores VALUES (?,?,?,?,?,?,?)", [
        ("INFY", 2.1, 8.5, 18.0, 22.0, 1, 78.5),
        ("HDFCBANK", 1.5, 5.0, 12.0, 18.0, 1, 65.0),
    ])
    conn.commit()
    conn.close()
    return db_path


def test_get_stock_fundamentals_returns_full_profile(test_db):
    result = get_stock_fundamentals("INFY", db_path=test_db)
    assert result["symbol"] == "INFY"
    assert result["name"] == "Infosys Ltd"
    assert result["trailing_pe"] == 22.5
    assert result["return_on_equity"] == 35.0
    assert result["score"] == 82.0
    assert result["classification"] == "Strong Buy"
    assert result["technical_score"] == 75.0


def test_get_stock_fundamentals_unknown_symbol_returns_none(test_db):
    result = get_stock_fundamentals("UNKNOWN", db_path=test_db)
    assert result is None


def test_filter_stocks_by_fundamentals_pe_filter(test_db):
    results = filter_stocks_by_fundamentals(pe_lt=20.0, db_path=test_db)
    symbols = [r["symbol"] for r in results]
    assert "HDFCBANK" in symbols
    assert "INFY" not in symbols


def test_filter_stocks_by_fundamentals_roe_filter(test_db):
    results = filter_stocks_by_fundamentals(roe_gt=20.0, db_path=test_db)
    symbols = [r["symbol"] for r in results]
    assert "INFY" in symbols
    assert "HDFCBANK" not in symbols


def test_filter_stocks_combined_criteria(test_db):
    results = filter_stocks_by_fundamentals(pe_lt=25.0, roe_gt=10.0, min_score=70.0, db_path=test_db)
    assert len(results) >= 1
    for r in results:
        assert r["trailing_pe"] < 25.0
        assert r["return_on_equity"] > 10.0
        assert r["score"] >= 70.0


def test_get_buy_signals_all(test_db):
    results = get_buy_signals(db_path=test_db)
    assert len(results) == 1
    assert results[0]["symbol"] == "INFY"
    assert results[0]["type"] == "BUY"


def test_get_buy_signals_by_symbol(test_db):
    results = get_buy_signals(symbol="INFY", db_path=test_db)
    assert len(results) == 1
    results_other = get_buy_signals(symbol="HDFCBANK", db_path=test_db)
    assert len(results_other) == 0


def test_get_screener_membership(test_db):
    results = get_screener_membership("INFY", db_path=test_db)
    assert len(results) >= 1
    names = [r["screener_name"] for r in results]
    assert "Low PE High ROE" in names


def test_get_quant_scores_sorted_by_momentum(test_db):
    results = get_quant_scores(sort_by="momentum_score", limit=5, db_path=test_db)
    assert results[0]["symbol"] == "INFY"
    assert results[0]["momentum_score"] == 78.5
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_sql_tool.py -v 2>&1 | Select-Object -First 20
```

Expected: `ImportError` or `ModuleNotFoundError` on `tools.sql_tool`

- [ ] **Step 3: Implement sql_tool.py**

Create `src/server/chatbot/tools/sql_tool.py`:
```python
import sqlite3
import os

DB_PATH = os.getenv("DB_PATH", "database.sqlite")


def _connect(db_path: str):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def get_stock_fundamentals(symbol: str, db_path: str = DB_PATH) -> dict | None:
    """Full profile for a single stock: fundamentals + AI score + factor breakdown."""
    conn = _connect(db_path)
    row = conn.execute("""
        SELECT ns.symbol, ns.name, ns.sector, ns.industry,
               sf.trailing_pe, sf.price_to_book, sf.return_on_equity,
               sf.revenue_growth, sf.earnings_growth, sf.debt_to_equity,
               sf.market_cap, sf.piotroski_f_score, sf.dividend_yield,
               ss.score, ss.confidence, ss.classification, ss.top_domain,
               fb.technical AS technical_score, fb.fundamental AS fundamental_score,
               fb.momentum AS momentum_score, fb.valuation AS valuation_score
        FROM nse_stocks ns
        LEFT JOIN stock_fundamentals sf ON ns.symbol = sf.symbol
        LEFT JOIN stock_scores ss ON ns.symbol = ss.symbol AND ss.timeframe = 'long_term'
        LEFT JOIN stock_factor_breakdown fb ON ns.symbol = fb.symbol AND fb.timeframe = 'long_term'
        WHERE ns.symbol = ?
    """, (symbol.upper(),)).fetchone()
    conn.close()
    return dict(row) if row else None


def filter_stocks_by_fundamentals(
    pe_lt: float | None = None,
    pb_lt: float | None = None,
    roe_gt: float | None = None,
    revenue_growth_gt: float | None = None,
    min_score: float = 50.0,
    limit: int = 15,
    db_path: str = DB_PATH,
) -> list[dict]:
    """Filter stocks by fundamental criteria and AI score."""
    conditions = ["ss.score >= ?", "ss.timeframe = 'long_term'"]
    params: list = [min_score]

    if pe_lt is not None:
        conditions.append("sf.trailing_pe < ? AND sf.trailing_pe > 0")
        params.append(pe_lt)
    if pb_lt is not None:
        conditions.append("sf.price_to_book < ? AND sf.price_to_book > 0")
        params.append(pb_lt)
    if roe_gt is not None:
        conditions.append("sf.return_on_equity > ?")
        params.append(roe_gt)
    if revenue_growth_gt is not None:
        conditions.append("sf.revenue_growth > ?")
        params.append(revenue_growth_gt)

    query = f"""
        SELECT ns.symbol, ns.name, ns.sector,
               sf.trailing_pe, sf.price_to_book, sf.return_on_equity,
               sf.revenue_growth, sf.market_cap, sf.piotroski_f_score,
               sf.debt_to_equity, sf.dividend_yield,
               ss.score, ss.classification
        FROM stock_fundamentals sf
        JOIN stock_scores ss ON sf.symbol = ss.symbol
        JOIN nse_stocks ns ON sf.symbol = ns.symbol
        WHERE {' AND '.join(conditions)}
        ORDER BY ss.score DESC
        LIMIT ?
    """
    params.append(limit)

    conn = _connect(db_path)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_buy_signals(
    symbol: str | None = None,
    min_confidence: float = 0.70,
    limit: int = 20,
    db_path: str = DB_PATH,
) -> list[dict]:
    """Active BUY signals, optionally filtered by symbol."""
    conditions = ["type = 'BUY'", "status = 'ACTIVE'", "confidence >= ?"]
    params: list = [min_confidence]

    if symbol:
        conditions.append("symbol = ?")
        params.append(symbol.upper())

    query = f"""
        SELECT symbol, type, entry, target, stopLoss, confidence, reasoning, createdAt
        FROM signals
        WHERE {' AND '.join(conditions)}
        ORDER BY confidence DESC, createdAt DESC
        LIMIT ?
    """
    params.append(limit)

    conn = _connect(db_path)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_screener_membership(symbol: str, db_path: str = DB_PATH) -> list[dict]:
    """Which screeners does this stock appear in?"""
    sym = symbol.upper()
    conn = _connect(db_path)

    rows = conn.execute("""
        SELECT sm.name AS screener_name, sm.source, sm.inferred_sentiment, sm.inferred_category
        FROM trendlyne_screener_stocks tss
        JOIN screener_master sm ON tss.screener_id = sm.scan_id
        WHERE tss.symbol = ?
        UNION
        SELECT sm.name AS screener_name, sm.source, sm.inferred_sentiment, sm.inferred_category
        FROM moneycontrol_screener_stocks mss
        JOIN screener_master sm ON mss.scan_id = sm.scan_id
        WHERE mss.symbol = ?
    """, (sym, sym)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_quant_scores(
    symbol: str | None = None,
    sort_by: str = "momentum_score",
    above_sma200_only: bool = False,
    limit: int = 20,
    db_path: str = DB_PATH,
) -> list[dict]:
    """Quant momentum/return scores, optionally for a single symbol."""
    allowed_sort = {"momentum_score", "return_1m", "return_3m", "return_6m", "return_12m"}
    if sort_by not in allowed_sort:
        sort_by = "momentum_score"

    conditions = []
    params: list = []

    if symbol:
        conditions.append("qs.symbol = ?")
        params.append(symbol.upper())
    if above_sma200_only:
        conditions.append("qs.above_sma200 = 1")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    query = f"""
        SELECT qs.symbol, ns.name, ns.sector,
               qs.return_1w, qs.return_1m, qs.return_3m, qs.return_6m,
               qs.above_sma200, qs.momentum_score,
               ss.score, ss.classification
        FROM quant_scores qs
        JOIN nse_stocks ns ON qs.symbol = ns.symbol
        LEFT JOIN stock_scores ss ON qs.symbol = ss.symbol AND ss.timeframe = 'long_term'
        {where}
        ORDER BY qs.{sort_by} DESC NULLS LAST
        LIMIT ?
    """
    params.append(limit)

    conn = _connect(db_path)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_sql_tool.py -v
```

Expected: all 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/chatbot/tools/sql_tool.py tests/chatbot/test_sql_tool.py
git commit -m "feat(chatbot): add SQL retrieval tool with tests"
```

---

## Task 3: Live Price and Earnings Calendar Tool

**Files:**
- Create: `src/server/chatbot/tools/price_tool.py`
- Create: `tests/chatbot/test_price_tool.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/chatbot/test_price_tool.py`:
```python
import pytest
from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from tools.price_tool import get_live_price, get_earnings_calendar


def _mock_ticker(price=1450.0, prev_close=1420.0, day_high=1470.0, day_low=1435.0,
                 week52_high=1800.0, week52_low=1100.0, volume=2500000):
    m = MagicMock()
    m.fast_info.last_price = price
    m.fast_info.previous_close = prev_close
    m.fast_info.day_high = day_high
    m.fast_info.day_low = day_low
    m.fast_info.fifty_two_week_high = week52_high
    m.fast_info.fifty_two_week_low = week52_low
    m.fast_info.last_volume = volume
    return m


def test_get_live_price_returns_expected_fields():
    with patch("tools.price_tool.yf.Ticker", return_value=_mock_ticker()):
        result = get_live_price("INFY")
    assert result["symbol"] == "INFY"
    assert result["price"] == 1450.0
    assert result["change_pct"] == pytest.approx((1450.0 - 1420.0) / 1420.0 * 100, rel=1e-3)
    assert result["day_high"] == 1470.0
    assert result["week52_high"] == 1800.0


def test_get_live_price_appends_ns_suffix():
    with patch("tools.price_tool.yf.Ticker") as mock_cls:
        mock_cls.return_value = _mock_ticker()
        get_live_price("INFY")
        mock_cls.assert_called_once_with("INFY.NS")


def test_get_live_price_returns_none_on_error():
    with patch("tools.price_tool.yf.Ticker", side_effect=Exception("network error")):
        result = get_live_price("INFY")
    assert result is None


def test_get_earnings_calendar_enriches_with_signals(tmp_path):
    import sqlite3
    db_path = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT);
        CREATE TABLE technical_analysis_signals (
            symbol TEXT PRIMARY KEY, trend TEXT, rsi REAL
        );
        CREATE TABLE stock_scores (
            symbol TEXT, timeframe TEXT, score REAL, classification TEXT,
            confidence REAL, top_domain TEXT, PRIMARY KEY (symbol, timeframe)
        );
    """)
    conn.execute("INSERT INTO nse_stocks VALUES ('INFY','Infosys Ltd','IT','Software')")
    conn.execute("INSERT INTO technical_analysis_signals VALUES ('INFY','Bullish',62.0)")
    conn.execute("INSERT INTO stock_scores VALUES ('INFY','long_term',80.0,'Buy',0.82,'Technical')")
    conn.commit()
    conn.close()

    mock_web = [{"title": "Infosys Q1 results", "snippet": "Infosys to declare Q1 results on July 17", "url": "http://example.com"}]
    with patch("tools.price_tool.web_search", return_value=mock_web):
        results = get_earnings_calendar(days_ahead=30, db_path=db_path)

    # Should return the web context even if yfinance calendar is empty
    assert isinstance(results, dict)
    assert "web_results" in results
    assert "bullish_stocks" in results
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_price_tool.py -v 2>&1 | Select-Object -First 10
```

Expected: `ImportError` on `tools.price_tool`

- [ ] **Step 3: Implement price_tool.py**

Create `src/server/chatbot/tools/price_tool.py`:
```python
import os
import sqlite3
from datetime import datetime

import yfinance as yf

DB_PATH = os.getenv("DB_PATH", "database.sqlite")


def get_live_price(symbol: str) -> dict | None:
    """Fetch real-time quote for an NSE symbol."""
    try:
        ticker = yf.Ticker(symbol.upper() + ".NS")
        fi = ticker.fast_info
        price = fi.last_price
        prev = fi.previous_close or price
        return {
            "symbol": symbol.upper(),
            "price": price,
            "change_pct": round((price - prev) / prev * 100, 2) if prev else 0.0,
            "day_high": fi.day_high,
            "day_low": fi.day_low,
            "week52_high": fi.fifty_two_week_high,
            "week52_low": fi.fifty_two_week_low,
            "volume": fi.last_volume,
        }
    except Exception:
        return None


def get_earnings_calendar(days_ahead: int = 14, db_path: str = DB_PATH) -> dict:
    """
    Fetch upcoming results calendar via web search, then cross-reference
    with DB for bullish-trending stocks.
    """
    from tools.web_tool import web_search

    month_year = datetime.now().strftime("%B %Y")
    query = f"NSE BSE quarterly results announcement upcoming {month_year} earnings calendar"
    web_results = web_search(query, max_results=5)

    # Get bullish stocks from DB to cross-reference
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    bullish = conn.execute("""
        SELECT tas.symbol, ns.name, ns.sector, tas.trend, tas.rsi,
               ss.score, ss.classification
        FROM technical_analysis_signals tas
        JOIN nse_stocks ns ON tas.symbol = ns.symbol
        LEFT JOIN stock_scores ss ON tas.symbol = ss.symbol AND ss.timeframe = 'long_term'
        WHERE tas.trend = 'Bullish'
          AND (ss.classification IN ('Buy','Strong Buy') OR ss.classification IS NULL)
        ORDER BY ss.score DESC NULLS LAST
        LIMIT 20
    """).fetchall()
    conn.close()

    return {
        "web_results": web_results,
        "bullish_stocks": [dict(r) for r in bullish],
        "note": f"Web search for upcoming results in {month_year}. Bullish stocks from DB for cross-reference.",
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_price_tool.py -v
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/chatbot/tools/price_tool.py tests/chatbot/test_price_tool.py
git commit -m "feat(chatbot): add live price and earnings calendar tool"
```

---

## Task 4: News Sentiment Tool

**Files:**
- Create: `src/server/chatbot/tools/news_tool.py`
- Create: `tests/chatbot/test_news_tool.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/chatbot/test_news_tool.py`:
```python
import sqlite3
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from tools.news_tool import get_news_sentiment


@pytest.fixture
def news_db(tmp_path):
    db_path = str(tmp_path / "news.db")
    conn = sqlite3.connect(db_path)
    conn.execute("""CREATE TABLE news_articles (
        id TEXT PRIMARY KEY, title TEXT, summary TEXT, source TEXT,
        sentiment TEXT, category TEXT, url TEXT, symbols TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.executemany("INSERT INTO news_articles VALUES (?,?,?,?,?,?,?,?,?)", [
        ("n1", "Infosys beats Q4 estimates", "Revenue grew 15% YoY", "ET", "Positive", "earnings", "http://a.com", "INFY", "2026-06-15 10:00:00"),
        ("n2", "Infosys wins $500M deal", "Large deal signed with US client", "MC", "Positive", "deal", "http://b.com", "INFY,TCS", "2026-06-14 09:00:00"),
        ("n3", "IT sector sees margin pressure", "Currency headwinds hit margins", "BS", "Negative", "sector", "http://c.com", "INFY,WIPRO", "2026-06-13 08:00:00"),
        ("n4", "Old news", "Old article", "ET", "Neutral", "general", "http://d.com", "INFY", "2026-01-01 00:00:00"),
    ])
    conn.commit()
    conn.close()
    return db_path


def test_get_news_sentiment_returns_articles_for_symbol(news_db):
    result = get_news_sentiment("INFY", days=30, db_path=news_db)
    assert result["symbol"] == "INFY"
    assert result["total"] >= 3
    assert result["positive"] >= 2
    assert result["negative"] >= 1


def test_get_news_sentiment_excludes_old_articles(news_db):
    result = get_news_sentiment("INFY", days=7, db_path=news_db)
    # The Jan 1 article should be excluded
    assert result["total"] <= 3


def test_get_news_sentiment_top_headlines_present(news_db):
    result = get_news_sentiment("INFY", days=30, db_path=news_db)
    assert "headlines" in result
    assert len(result["headlines"]) >= 1
    assert "title" in result["headlines"][0]


def test_get_news_sentiment_no_symbol_returns_general(news_db):
    result = get_news_sentiment(symbol=None, days=7, db_path=news_db)
    assert "total" in result
    assert "headlines" in result


def test_get_news_sentiment_overall_sentiment_label(news_db):
    result = get_news_sentiment("INFY", days=30, db_path=news_db)
    assert result["overall_sentiment"] in ("Positive", "Negative", "Neutral", "Mixed")
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_news_tool.py -v 2>&1 | Select-Object -First 5
```

- [ ] **Step 3: Implement news_tool.py**

Create `src/server/chatbot/tools/news_tool.py`:
```python
import os
import sqlite3
from datetime import datetime, timedelta

DB_PATH = os.getenv("DB_PATH", "database.sqlite")


def get_news_sentiment(
    symbol: str | None,
    days: int = 7,
    limit: int = 10,
    db_path: str = DB_PATH,
) -> dict:
    """Query recent news articles for a symbol (or general market news)."""
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    if symbol:
        sym = symbol.upper()
        rows = conn.execute("""
            SELECT id, title, summary, source, sentiment, url, timestamp
            FROM news_articles
            WHERE (symbols LIKE ? OR symbols LIKE ? OR symbols LIKE ? OR symbols = ?)
              AND timestamp >= ?
            ORDER BY timestamp DESC
            LIMIT ?
        """, (
            f"%,{sym},%", f"{sym},%", f"%,{sym}", sym,
            cutoff, limit,
        )).fetchall()
    else:
        rows = conn.execute("""
            SELECT id, title, summary, source, sentiment, url, timestamp
            FROM news_articles
            WHERE timestamp >= ?
            ORDER BY timestamp DESC
            LIMIT ?
        """, (cutoff, limit)).fetchall()

    conn.close()

    articles = [dict(r) for r in rows]
    total = len(articles)
    positive = sum(1 for a in articles if a["sentiment"] == "Positive")
    negative = sum(1 for a in articles if a["sentiment"] == "Negative")
    neutral = total - positive - negative

    if positive > negative and positive > neutral:
        overall = "Positive"
    elif negative > positive and negative > neutral:
        overall = "Negative"
    elif positive == 0 and negative == 0:
        overall = "Neutral"
    else:
        overall = "Mixed"

    return {
        "symbol": symbol,
        "total": total,
        "positive": positive,
        "negative": negative,
        "neutral": neutral,
        "overall_sentiment": overall,
        "headlines": [
            {"title": a["title"], "source": a["source"],
             "sentiment": a["sentiment"], "url": a["url"], "date": a["timestamp"]}
            for a in articles[:5]
        ],
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_news_tool.py -v
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/chatbot/tools/news_tool.py tests/chatbot/test_news_tool.py
git commit -m "feat(chatbot): add news sentiment tool"
```

---

## Task 5: Web Search Tool

**Files:**
- Create: `src/server/chatbot/tools/web_tool.py`
- Create: `tests/chatbot/test_web_tool.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/chatbot/test_web_tool.py`:
```python
import pytest
from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from tools.web_tool import web_search, web_search_stock

FAKE_RESULTS = [
    {"title": "Infosys Q4 results beat estimates", "body": "Infosys reported 15% revenue growth", "href": "http://example.com/1"},
    {"title": "Analyst upgrades Infosys", "body": "Price target raised to 1800", "href": "http://example.com/2"},
]


def test_web_search_returns_list_of_dicts():
    with patch("tools.web_tool.DDGS") as mock_ddgs_cls:
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = lambda s: s
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx.text.return_value = iter(FAKE_RESULTS)
        mock_ddgs_cls.return_value = mock_ctx

        results = web_search("Infosys results")

    assert isinstance(results, list)
    assert len(results) == 2
    assert results[0]["title"] == "Infosys Q4 results beat estimates"
    assert results[0]["snippet"] == "Infosys reported 15% revenue growth"
    assert results[0]["url"] == "http://example.com/1"


def test_web_search_respects_max_results():
    with patch("tools.web_tool.DDGS") as mock_ddgs_cls:
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = lambda s: s
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx.text.return_value = iter(FAKE_RESULTS)
        mock_ddgs_cls.return_value = mock_ctx

        web_search("query", max_results=3)
        mock_ctx.text.assert_called_once_with("query", max_results=3)


def test_web_search_returns_empty_on_exception():
    with patch("tools.web_tool.DDGS", side_effect=Exception("network error")):
        results = web_search("query")
    assert results == []


def test_web_search_stock_constructs_targeted_query():
    with patch("tools.web_tool.web_search") as mock_ws:
        mock_ws.return_value = []
        web_search_stock("INFY", "Infosys Ltd", "analyst rating 2026")
        call_args = mock_ws.call_args[0][0]
        assert "INFY" in call_args
        assert "Infosys Ltd" in call_args
        assert "analyst rating 2026" in call_args
        assert "NSE" in call_args
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_web_tool.py -v 2>&1 | Select-Object -First 5
```

- [ ] **Step 3: Implement web_tool.py**

Create `src/server/chatbot/tools/web_tool.py`:
```python
from duckduckgo_search import DDGS


def web_search(query: str, max_results: int = 5) -> list[dict]:
    """Search the web using DuckDuckGo. Returns list of {title, snippet, url}."""
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=max_results))
        return [
            {"title": r.get("title", ""), "snippet": r.get("body", ""), "url": r.get("href", "")}
            for r in raw
        ]
    except Exception:
        return []


def web_search_stock(
    symbol: str,
    company_name: str,
    topic: str,
    max_results: int = 5,
) -> list[dict]:
    """Targeted web search for a specific stock and topic."""
    query = f"{company_name} {symbol} NSE {topic}"
    return web_search(query, max_results=max_results)
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_web_tool.py -v
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/chatbot/tools/web_tool.py tests/chatbot/test_web_tool.py
git commit -m "feat(chatbot): add DuckDuckGo web search tool"
```

---

## Task 6: ChromaDB Ingest Script

**Files:**
- Create: `src/server/chatbot/ingest.py`

- [ ] **Step 1: Write ingest.py**

Create `src/server/chatbot/ingest.py`:
```python
"""
Populates ChromaDB with stock profiles, screener descriptions, and recent news.
Run once at startup if chroma_store is empty; re-run nightly for incremental updates.

Usage:
    python src/server/chatbot/ingest.py
"""
import os
import sqlite3
import logging

import chromadb
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction

DB_PATH = os.getenv("DB_PATH", "database.sqlite")
CHROMA_DIR = os.getenv("CHROMA_PERSIST_DIR", "src/server/chatbot/chroma_store")

logging.basicConfig(level=logging.INFO, format="[ingest] %(message)s")
logger = logging.getLogger(__name__)


def get_chroma_client() -> chromadb.ClientAPI:
    return chromadb.PersistentClient(path=CHROMA_DIR)


def get_embedding_fn():
    return SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")


def ingest_stock_profiles(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """One document per stock: name + sector + description."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("stock_profiles", embedding_function=ef)

    conn = sqlite3.connect(db_path)
    rows = conn.execute("""
        SELECT ns.symbol, ns.name, ns.sector, ns.industry,
               cp.description, cp.ai_analysis
        FROM nse_stocks ns
        LEFT JOIN company_profiles cp ON ns.symbol = cp.symbol
        WHERE ns.status = 'ACTIVE' OR ns.status IS NULL
        LIMIT 3000
    """).fetchall()
    conn.close()

    docs, ids, metas = [], [], []
    for symbol, name, sector, industry, desc, ai in rows:
        text = f"{name} ({symbol}). Sector: {sector or 'N/A'}. Industry: {industry or 'N/A'}."
        if desc:
            text += f" {desc}"
        if ai:
            text += f" AI Analysis: {ai}"
        docs.append(text)
        ids.append(f"stock_{symbol}")
        metas.append({"symbol": symbol, "name": name or "", "sector": sector or "", "type": "stock"})

    if docs:
        col.upsert(documents=docs, ids=ids, metadatas=metas)
        logger.info(f"Upserted {len(docs)} stock profiles")
    return len(docs)


def ingest_screener_descriptions(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """One document per screener with name + description + category."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("screener_descriptions", embedding_function=ef)

    conn = sqlite3.connect(db_path)
    rows = conn.execute("""
        SELECT scan_id, name, source, inferred_sentiment, inferred_category
        FROM screener_master
        WHERE name IS NOT NULL
    """).fetchall()
    conn.close()

    docs, ids, metas = [], [], []
    for scan_id, name, source, sentiment, category in rows:
        text = f"{name}. Source: {source or 'unknown'}. Category: {category or 'general'}. Sentiment: {sentiment or 'neutral'}."
        docs.append(text)
        ids.append(f"screener_{scan_id}")
        metas.append({"scan_id": scan_id, "name": name, "source": source or "", "type": "screener"})

    if docs:
        col.upsert(documents=docs, ids=ids, metadatas=metas)
        logger.info(f"Upserted {len(docs)} screener descriptions")
    return len(docs)


def ingest_news_articles(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """Recent news articles (last 30 days), chunked at 500 chars."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("news_articles", embedding_function=ef)

    conn = sqlite3.connect(db_path)
    rows = conn.execute("""
        SELECT id, title, summary, source, sentiment, symbols
        FROM news_articles
        WHERE timestamp >= datetime('now', '-30 days')
        ORDER BY timestamp DESC
        LIMIT 1000
    """).fetchall()
    conn.close()

    docs, ids, metas = [], [], []
    for art_id, title, summary, source, sentiment, symbols in rows:
        text = f"{title}. {summary or ''}".strip()
        if not text:
            continue
        docs.append(text[:500])
        ids.append(f"news_{art_id}")
        metas.append({
            "source": source or "",
            "sentiment": sentiment or "Neutral",
            "symbols": symbols or "",
            "type": "news",
        })

    if docs:
        col.upsert(documents=docs, ids=ids, metadatas=metas)
        logger.info(f"Upserted {len(docs)} news articles")
    return len(docs)


def run_full_ingest(db_path: str = DB_PATH) -> dict:
    client = get_chroma_client()
    stocks = ingest_stock_profiles(client, db_path)
    screeners = ingest_screener_descriptions(client, db_path)
    news = ingest_news_articles(client, db_path)
    return {"stocks": stocks, "screeners": screeners, "news": news}


if __name__ == "__main__":
    result = run_full_ingest()
    logger.info(f"Ingest complete: {result}")
```

- [ ] **Step 2: Run ingest to verify it works against the real DB**

```powershell
& "backend-python\venv\Scripts\python.exe" src/server/chatbot/ingest.py
```

Expected output (counts will vary based on your DB):
```
[ingest] Upserted N stock profiles
[ingest] Upserted N screener descriptions
[ingest] Upserted N news articles
[ingest] Ingest complete: {'stocks': N, 'screeners': N, 'news': N}
```

If you see `0` for all — the DB may be empty. That's fine; ingest will populate on first run with real data.

- [ ] **Step 3: Commit**

```bash
git add src/server/chatbot/ingest.py
git commit -m "feat(chatbot): add ChromaDB ingest script for stock profiles, screeners, news"
```

---

## Task 7: Screener Tool (ChromaDB semantic search)

**Files:**
- Create: `src/server/chatbot/tools/screener_tool.py`
- Create: `tests/chatbot/test_screener_tool.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/chatbot/test_screener_tool.py`:
```python
import pytest
from unittest.mock import patch, MagicMock
import sqlite3
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from tools.screener_tool import search_screener, get_screener_stocks


@pytest.fixture
def screener_db(tmp_path):
    db_path = str(tmp_path / "s.db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE screener_master (
            scan_id TEXT PRIMARY KEY, name TEXT, source TEXT,
            inferred_sentiment TEXT, inferred_category TEXT
        );
        CREATE TABLE trendlyne_screener_stocks (
            screener_id TEXT, symbol TEXT, PRIMARY KEY(screener_id, symbol)
        );
        CREATE TABLE moneycontrol_screener_stocks (
            scan_id TEXT, mcsymbol TEXT, symbol TEXT, stock_name TEXT,
            PRIMARY KEY(scan_id, mcsymbol)
        );
        CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT);
        CREATE TABLE stock_scores (
            symbol TEXT, timeframe TEXT, score REAL, classification TEXT,
            confidence REAL, top_domain TEXT, PRIMARY KEY(symbol, timeframe)
        );
    """)
    conn.execute("INSERT INTO screener_master VALUES ('TL_001','Low PE High ROE','trendlyne','bullish','fundamental')")
    conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('TL_001','INFY')")
    conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('TL_001','TCS')")
    conn.execute("INSERT INTO nse_stocks VALUES ('INFY','Infosys','IT','Software')")
    conn.execute("INSERT INTO nse_stocks VALUES ('TCS','TCS','IT','Software')")
    conn.execute("INSERT INTO stock_scores VALUES ('INFY','long_term',82.0,'Strong Buy',0.85,'Fundamental')")
    conn.execute("INSERT INTO stock_scores VALUES ('TCS','long_term',78.0,'Buy',0.80,'Technical')")
    conn.commit()
    conn.close()
    return db_path


def test_get_screener_stocks_by_id(screener_db):
    results = get_screener_stocks("TL_001", db_path=screener_db)
    symbols = [r["symbol"] for r in results]
    assert "INFY" in symbols
    assert "TCS" in symbols


def test_get_screener_stocks_enriched_with_scores(screener_db):
    results = get_screener_stocks("TL_001", db_path=screener_db)
    infy = next(r for r in results if r["symbol"] == "INFY")
    assert infy["score"] == 82.0
    assert infy["classification"] == "Strong Buy"


def test_search_screener_uses_chroma(screener_db):
    mock_collection = MagicMock()
    mock_collection.query.return_value = {
        "ids": [["screener_TL_001"]],
        "documents": [["Low PE High ROE. Source: trendlyne. Category: fundamental. Sentiment: bullish."]],
        "metadatas": [[{"scan_id": "TL_001", "name": "Low PE High ROE", "source": "trendlyne", "type": "screener"}]],
        "distances": [[0.12]],
    }
    mock_client = MagicMock()
    mock_client.get_or_create_collection.return_value = mock_collection

    with patch("tools.screener_tool.get_chroma_client", return_value=mock_client):
        with patch("tools.screener_tool.get_embedding_fn", return_value=MagicMock()):
            results = search_screener("low valuation high return stocks", db_path=screener_db)

    assert len(results) >= 1
    assert results[0]["screener_name"] == "Low PE High ROE"
    assert len(results[0]["stocks"]) >= 1
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_screener_tool.py -v 2>&1 | Select-Object -First 5
```

- [ ] **Step 3: Implement screener_tool.py**

Create `src/server/chatbot/tools/screener_tool.py`:
```python
import os
import sqlite3

DB_PATH = os.getenv("DB_PATH", "database.sqlite")
CHROMA_DIR = os.getenv("CHROMA_PERSIST_DIR", "src/server/chatbot/chroma_store")


def get_chroma_client():
    import chromadb
    return chromadb.PersistentClient(path=CHROMA_DIR)


def get_embedding_fn():
    from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
    return SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")


def get_screener_stocks(scan_id: str, db_path: str = DB_PATH) -> list[dict]:
    """Fetch constituent stocks for a screener id, enriched with AI scores."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT tss.symbol, ns.name, ns.sector,
               ss.score, ss.classification
        FROM trendlyne_screener_stocks tss
        JOIN nse_stocks ns ON tss.symbol = ns.symbol
        LEFT JOIN stock_scores ss ON tss.symbol = ss.symbol AND ss.timeframe = 'long_term'
        WHERE tss.screener_id = ?
        UNION
        SELECT mss.symbol, ns.name, ns.sector,
               ss.score, ss.classification
        FROM moneycontrol_screener_stocks mss
        JOIN nse_stocks ns ON mss.symbol = ns.symbol
        LEFT JOIN stock_scores ss ON mss.symbol = ss.symbol AND ss.timeframe = 'long_term'
        WHERE mss.scan_id = ?
        ORDER BY score DESC NULLS LAST
        LIMIT 30
    """, (scan_id, scan_id)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_screener(query: str, top_k: int = 3, db_path: str = DB_PATH) -> list[dict]:
    """
    Semantic search over screener names/descriptions using ChromaDB,
    then return each matched screener's constituent stocks.
    """
    client = get_chroma_client()
    ef = get_embedding_fn()
    col = client.get_or_create_collection("screener_descriptions", embedding_function=ef)

    if col.count() == 0:
        # Fallback: text search on screener_master if ChromaDB not populated
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        term = f"%{query}%"
        screeners = conn.execute(
            "SELECT scan_id, name, source, inferred_sentiment FROM screener_master WHERE name LIKE ? LIMIT ?",
            (term, top_k),
        ).fetchall()
        conn.close()
        return [
            {
                "screener_name": r["name"],
                "source": r["source"],
                "sentiment": r["inferred_sentiment"],
                "stocks": get_screener_stocks(r["scan_id"], db_path),
            }
            for r in screeners
        ]

    result = col.query(query_texts=[query], n_results=top_k)
    metadatas = result["metadatas"][0] if result["metadatas"] else []

    return [
        {
            "screener_name": meta.get("name", ""),
            "source": meta.get("source", ""),
            "scan_id": meta.get("scan_id", ""),
            "stocks": get_screener_stocks(meta["scan_id"], db_path) if meta.get("scan_id") else [],
        }
        for meta in metadatas
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_screener_tool.py -v
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/chatbot/tools/screener_tool.py tests/chatbot/test_screener_tool.py
git commit -m "feat(chatbot): add screener semantic search tool with ChromaDB"
```

---

## Task 8: LLM Configuration Module

**Files:**
- Create: `src/server/chatbot/llm.py`

- [ ] **Step 1: Implement llm.py**

Create `src/server/chatbot/llm.py`:
```python
import os
import logging

logger = logging.getLogger(__name__)

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

_cached_llm = None


def get_llm():
    """Return Ollama if reachable, else Gemini. Cached after first call."""
    global _cached_llm
    if _cached_llm is not None:
        return _cached_llm

    try:
        import httpx
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3.0)
        resp.raise_for_status()
        from langchain_ollama import ChatOllama
        _cached_llm = ChatOllama(model=OLLAMA_MODEL, base_url=OLLAMA_BASE_URL)
        logger.info(f"Using Ollama ({OLLAMA_MODEL})")
    except Exception as e:
        logger.warning(f"Ollama unavailable ({e}), falling back to Gemini")
        from langchain_google_genai import ChatGoogleGenerativeAI
        _cached_llm = ChatGoogleGenerativeAI(
            model="gemini-2.0-flash",
            google_api_key=GEMINI_API_KEY,
        )
        logger.info("Using Gemini fallback")

    return _cached_llm


def reset_llm_cache():
    """Force re-detection of LLM on next call (useful in tests)."""
    global _cached_llm
    _cached_llm = None
```

- [ ] **Step 2: Verify Ollama detection works**

```powershell
& "backend-python\venv\Scripts\python.exe" -c "
import sys; sys.path.insert(0, 'src/server/chatbot')
from llm import get_llm
llm = get_llm()
print(type(llm).__name__)
"
```

Expected: prints either `ChatOllama` or `ChatGoogleGenerativeAI`

- [ ] **Step 3: Commit**

```bash
git add src/server/chatbot/llm.py
git commit -m "feat(chatbot): add Ollama/Gemini LLM selector with health-check fallback"
```

---

## Task 9: LangGraph Agent

**Files:**
- Create: `src/server/chatbot/agent.py`
- Create: `tests/chatbot/test_agent.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/chatbot/test_agent.py`:
```python
import pytest
from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from langchain_core.messages import HumanMessage, AIMessage


def _make_mock_llm(json_response: str = None, text_response: str = "Here is the analysis."):
    mock = MagicMock()
    if json_response:
        mock.invoke.return_value = MagicMock(content=json_response)
    else:
        mock.invoke.return_value = MagicMock(content=text_response)
    return mock


def test_agent_classify_intent_stock_detail(tmp_path):
    import sqlite3
    db_path = str(tmp_path / "t.db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE nse_stocks(symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT);
        CREATE TABLE stock_fundamentals(symbol TEXT PRIMARY KEY, trailing_pe REAL, price_to_book REAL,
            return_on_equity REAL, revenue_growth REAL, earnings_growth REAL, debt_to_equity REAL,
            market_cap REAL, piotroski_f_score INTEGER, dividend_yield REAL);
        CREATE TABLE stock_scores(symbol TEXT, timeframe TEXT, score REAL, confidence REAL,
            classification TEXT, top_domain TEXT, PRIMARY KEY(symbol, timeframe));
        CREATE TABLE stock_factor_breakdown(symbol TEXT, timeframe TEXT, technical REAL,
            fundamental REAL, momentum REAL, valuation REAL, PRIMARY KEY(symbol, timeframe));
        CREATE TABLE signals(id INTEGER PRIMARY KEY, symbol TEXT, type TEXT, entry REAL, target REAL,
            stopLoss REAL, confidence REAL, reasoning TEXT, status TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE screener_master(scan_id TEXT PRIMARY KEY, name TEXT, source TEXT,
            inferred_sentiment TEXT, inferred_category TEXT);
        CREATE TABLE trendlyne_screener_stocks(screener_id TEXT, symbol TEXT, PRIMARY KEY(screener_id,symbol));
        CREATE TABLE moneycontrol_screener_stocks(scan_id TEXT, mcsymbol TEXT, symbol TEXT,
            stock_name TEXT, PRIMARY KEY(scan_id,mcsymbol));
        CREATE TABLE quant_scores(symbol TEXT PRIMARY KEY, return_1w REAL, return_1m REAL,
            return_3m REAL, return_6m REAL, above_sma200 INTEGER, momentum_score REAL);
        CREATE TABLE news_articles(id TEXT PRIMARY KEY, title TEXT, summary TEXT, source TEXT,
            sentiment TEXT, category TEXT, url TEXT, symbols TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE technical_analysis_signals(symbol TEXT PRIMARY KEY, trend TEXT, rsi REAL);
    """)
    conn.execute("INSERT INTO nse_stocks VALUES ('INFY','Infosys Ltd','IT','Software')")
    conn.execute("INSERT INTO stock_fundamentals VALUES ('INFY',22.5,4.2,35.0,12.0,15.0,0.1,750000000000,8,2.5)")
    conn.execute("INSERT INTO stock_scores VALUES ('INFY','long_term',82.0,0.85,'Strong Buy','Fundamental')")
    conn.execute("INSERT INTO stock_factor_breakdown VALUES ('INFY','long_term',75.0,88.0,70.0,80.0)")
    conn.commit()
    conn.close()

    intent_json = '{"intent": "stock_detail", "stock_symbol": "INFY"}'
    answer_text = "Infosys is a leading IT company with strong fundamentals."

    mock_llm = MagicMock()
    mock_llm.invoke.side_effect = [
        MagicMock(content=intent_json),   # classify_intent call
        MagicMock(content=answer_text),   # synthesize_answer call
    ]

    with patch("agent.get_llm", return_value=mock_llm):
        with patch("agent.get_live_price", return_value={"symbol": "INFY", "price": 1450.0, "change_pct": 1.5}):
            with patch("agent.web_search_stock", return_value=[]):
                with patch("agent.get_news_sentiment", return_value={"total": 0, "headlines": []}):
                    from agent import build_graph
                    graph = build_graph(db_path=db_path)

                    config = {"configurable": {"thread_id": "test-session-1"}}
                    result = graph.invoke(
                        {"messages": [HumanMessage(content="Tell me about Infosys")],
                         "intent": "", "stock_symbol": None, "retrieved_context": "", "sources": []},
                        config=config,
                    )

    assert result["intent"] == "stock_detail"
    assert result["stock_symbol"] == "INFY"
    assert len(result["messages"]) >= 2
    ai_msg = result["messages"][-1]
    assert isinstance(ai_msg, AIMessage)
    assert "Infosys" in ai_msg.content


def test_agent_classify_intent_fundamental_filter(tmp_path):
    import sqlite3
    db_path = str(tmp_path / "t2.db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE nse_stocks(symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT);
        CREATE TABLE stock_fundamentals(symbol TEXT PRIMARY KEY, trailing_pe REAL, price_to_book REAL,
            return_on_equity REAL, revenue_growth REAL, earnings_growth REAL, debt_to_equity REAL,
            market_cap REAL, piotroski_f_score INTEGER, dividend_yield REAL);
        CREATE TABLE stock_scores(symbol TEXT, timeframe TEXT, score REAL, confidence REAL,
            classification TEXT, top_domain TEXT, PRIMARY KEY(symbol, timeframe));
        CREATE TABLE stock_factor_breakdown(symbol TEXT, timeframe TEXT, technical REAL,
            fundamental REAL, momentum REAL, valuation REAL, PRIMARY KEY(symbol, timeframe));
        CREATE TABLE signals(id INTEGER PRIMARY KEY, symbol TEXT, type TEXT, entry REAL, target REAL,
            stopLoss REAL, confidence REAL, reasoning TEXT, status TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE screener_master(scan_id TEXT PRIMARY KEY, name TEXT, source TEXT,
            inferred_sentiment TEXT, inferred_category TEXT);
        CREATE TABLE trendlyne_screener_stocks(screener_id TEXT, symbol TEXT, PRIMARY KEY(screener_id,symbol));
        CREATE TABLE moneycontrol_screener_stocks(scan_id TEXT, mcsymbol TEXT, symbol TEXT,
            stock_name TEXT, PRIMARY KEY(scan_id,mcsymbol));
        CREATE TABLE quant_scores(symbol TEXT PRIMARY KEY, return_1w REAL, return_1m REAL,
            return_3m REAL, return_6m REAL, above_sma200 INTEGER, momentum_score REAL);
        CREATE TABLE news_articles(id TEXT PRIMARY KEY, title TEXT, summary TEXT, source TEXT,
            sentiment TEXT, category TEXT, url TEXT, symbols TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE technical_analysis_signals(symbol TEXT PRIMARY KEY, trend TEXT, rsi REAL);
    """)
    conn.execute("INSERT INTO nse_stocks VALUES ('HDFCBANK','HDFC Bank','Banking','Private Bank')")
    conn.execute("INSERT INTO stock_fundamentals VALUES ('HDFCBANK',18.0,3.1,16.5,8.0,10.0,0.5,1200000000000,7,1.2)")
    conn.execute("INSERT INTO stock_scores VALUES ('HDFCBANK','long_term',74.0,0.78,'Buy','Technical')")
    conn.execute("INSERT INTO stock_factor_breakdown VALUES ('HDFCBANK','long_term',80.0,72.0,65.0,68.0)")
    conn.commit()
    conn.close()

    intent_json = '{"intent": "fundamental_filter", "stock_symbol": null}'
    filter_params_json = '{"pe_lt": 25, "pb_lt": 4, "roe_gt": 10}'
    answer_text = "Here are fundamentally strong undervalued stocks."

    mock_llm = MagicMock()
    mock_llm.invoke.side_effect = [
        MagicMock(content=intent_json),
        MagicMock(content=filter_params_json),
        MagicMock(content=answer_text),
    ]

    with patch("agent.get_llm", return_value=mock_llm):
        with patch("agent.web_search", return_value=[]):
            from agent import build_graph
            graph = build_graph(db_path=db_path)
            config = {"configurable": {"thread_id": "test-session-2"}}
            result = graph.invoke(
                {"messages": [HumanMessage(content="Which stocks are fundamentally strong but cheap?")],
                 "intent": "", "stock_symbol": None, "retrieved_context": "", "sources": []},
                config=config,
            )

    assert result["intent"] == "fundamental_filter"
    assert len(result["messages"]) >= 2
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_agent.py -v 2>&1 | Select-Object -First 10
```

- [ ] **Step 3: Implement agent.py**

Create `src/server/chatbot/agent.py`:
```python
import json
import logging
import os
from typing import Annotated, TypedDict
import operator

from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver

from llm import get_llm
from tools.sql_tool import (
    get_stock_fundamentals, filter_stocks_by_fundamentals,
    get_buy_signals, get_screener_membership, get_quant_scores,
)
from tools.price_tool import get_live_price, get_earnings_calendar
from tools.news_tool import get_news_sentiment
from tools.web_tool import web_search, web_search_stock
from tools.screener_tool import search_screener

DB_PATH = os.getenv("DB_PATH", "database.sqlite")
logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are Bharat Stock AI, an expert Indian stock market analyst with access to real-time platform data.

Available data:
- Fundamental metrics: PE, P/B, ROE, revenue growth, debt/equity, Piotroski F-score
- AI composite scores (0–100): Strong Buy / Buy / Hold / Sell / Strong Sell
- Factor breakdowns: technical, fundamental, momentum, valuation scores
- Active BUY signals with confidence, entry/target/stop-loss
- Screener memberships (Trendlyne, MoneyControl)
- Quant momentum scores: 1W/1M/3M/6M returns, SMA200 position
- Recent news sentiment (FinBERT scored)
- Live prices from Yahoo Finance
- Web search results for recent/breaking data

Response guidelines:
- Be specific and data-driven — quote actual numbers from the retrieved data
- Use markdown formatting: tables for comparisons, bold for key metrics
- For filtered stock lists: show a markdown table with Symbol, Name, PE, ROE, Score, Classification
- Distinguish between intraday and long-term signals when relevant
- If data is stale or absent, say so explicitly
- Never give absolute buy/sell orders; provide analysis and insights
- For "tell me about X" queries: structure as Overview → Fundamentals → Technicals → News → Verdict
"""

INTENT_PROMPT = """Classify this Indian stock market query into exactly one intent.

Intents:
- stock_detail: specific stock's profile, price, fundamentals, performance, recommendation
- fundamental_filter: find/screen stocks by fundamental criteria (PE, PB, ROE, valuation, etc.)
- screener_lookup: stocks in a named screener/category/strategy
- news_sentiment: news, events, sentiment about a stock or sector
- earnings_upcoming: upcoming results, earnings announcements, quarterly results calendar
- general: comparisons, sector analysis, macro, FII/DII flows, PCR, index analysis, anything else

Query: {query}

Also extract: the NSE stock symbol if explicitly mentioned (e.g., INFY, HDFCBANK, RELIANCE). Null if none.

Respond ONLY with valid JSON: {{"intent": "...", "stock_symbol": "..."}}"""

FILTER_PARAMS_PROMPT = """Extract numerical filter criteria from this stock screening query.

Query: {query}

Return JSON with these optional fields (null if not specified):
- pe_lt: maximum PE ratio (e.g., 20 for "PE below 20")
- pb_lt: maximum Price-to-Book ratio
- roe_gt: minimum Return on Equity in % (e.g., 15 for "ROE above 15%")
- revenue_growth_gt: minimum revenue growth in %
- min_score: minimum AI score (0-100), default 55

For vague queries like "fundamentally strong but cheap" or "undervalued quality stocks", use:
pe_lt: 25, pb_lt: 3, roe_gt: 12, min_score: 60

Respond ONLY with valid JSON."""


class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], operator.add]
    intent: str
    stock_symbol: str | None
    retrieved_context: str
    sources: list[str]


def _safe_json(text: str, fallback: dict) -> dict:
    try:
        start = text.find("{")
        end = text.rfind("}") + 1
        return json.loads(text[start:end]) if start >= 0 else fallback
    except Exception:
        return fallback


def classify_intent(state: AgentState) -> dict:
    query = state["messages"][-1].content
    llm = get_llm()
    response = llm.invoke(INTENT_PROMPT.format(query=query))
    parsed = _safe_json(response.content, {"intent": "general", "stock_symbol": None})
    return {
        "intent": parsed.get("intent", "general"),
        "stock_symbol": parsed.get("stock_symbol"),
    }


def execute_tools(state: AgentState, db_path: str = DB_PATH) -> dict:
    intent = state.get("intent", "general")
    symbol = state.get("stock_symbol")
    query = state["messages"][-1].content
    llm = get_llm()

    parts: list[str] = []
    sources: list[str] = []

    def add(label: str, data, source: str):
        if data:
            parts.append(f"### {label}\n```json\n{json.dumps(data, indent=2, default=str)}\n```")
            sources.append(source)

    if intent == "stock_detail" and symbol:
        fund = get_stock_fundamentals(symbol, db_path=db_path)
        add("Stock Profile & Fundamentals", fund, "sql:stock_fundamentals")

        price = get_live_price(symbol)
        add("Live Price", price, "tool:live_price")

        screeners = get_screener_membership(symbol, db_path=db_path)
        if screeners:
            add("Screener Memberships", screeners, "sql:screener_master")

        news = get_news_sentiment(symbol, days=14, db_path=db_path)
        add("News Sentiment (14 days)", news, "sql:news_articles")

        signals = get_buy_signals(symbol=symbol, db_path=db_path)
        if signals:
            add("Active BUY Signals", signals, "sql:signals")

        web = web_search_stock(symbol, fund["name"] if fund else symbol, "latest news analyst view 2026", max_results=4)
        if web:
            web_text = "\n".join(f"- **{r['title']}**: {r['snippet']} [{r['url']}]" for r in web)
            parts.append(f"### Web Results\n{web_text}")
            sources.append("tool:web_search")

    elif intent == "fundamental_filter":
        resp = llm.invoke(FILTER_PARAMS_PROMPT.format(query=query))
        params = _safe_json(resp.content, {"pe_lt": 25, "pb_lt": 3, "roe_gt": 12, "min_score": 60})
        stocks = filter_stocks_by_fundamentals(
            pe_lt=params.get("pe_lt"), pb_lt=params.get("pb_lt"),
            roe_gt=params.get("roe_gt"), revenue_growth_gt=params.get("revenue_growth_gt"),
            min_score=params.get("min_score", 55), db_path=db_path,
        )
        add("Filtered Stocks", stocks, "sql:stock_fundamentals+scores")
        add("Applied Filters", params, "tool:filter_params")

        web = web_search(f"fundamentally strong undervalued Indian stocks NSE 2026 {query[:80]}", max_results=3)
        if web:
            web_text = "\n".join(f"- **{r['title']}**: {r['snippet']}" for r in web)
            parts.append(f"### Web Context\n{web_text}")
            sources.append("tool:web_search")

    elif intent == "screener_lookup":
        screeners = search_screener(query, top_k=3, db_path=db_path)
        add("Screener Results", screeners, "tool:screener_lookup")

    elif intent == "news_sentiment":
        news = get_news_sentiment(symbol, days=14, db_path=db_path)
        add("News Sentiment (14 days)", news, "sql:news_articles")

        web_q = f"{symbol} NSE stock news sentiment analyst 2026" if symbol else f"Indian stock market news {query[:80]}"
        web = web_search(web_q, max_results=5)
        if web:
            web_text = "\n".join(f"- **{r['title']}**: {r['snippet']}" for r in web)
            parts.append(f"### Live Web News\n{web_text}")
            sources.append("tool:web_search")

    elif intent == "earnings_upcoming":
        calendar = get_earnings_calendar(days_ahead=21, db_path=db_path)
        add("Upcoming Earnings Calendar", calendar, "tool:earnings_calendar")

        signals = get_buy_signals(db_path=db_path)
        if signals:
            add("Active BUY Signals (for cross-reference)", signals[:10], "sql:signals")

    else:  # general
        # Quant momentum leaders
        quant = get_quant_scores(sort_by="momentum_score", limit=10, db_path=db_path)
        if quant:
            add("Top Momentum Stocks", quant, "sql:quant_scores")

        # Active signals
        signals = get_buy_signals(db_path=db_path, limit=10)
        if signals:
            add("Active BUY Signals", signals, "sql:signals")

        # Web search for the query
        web = web_search(f"Indian stock market NSE {query[:120]}", max_results=5)
        if web:
            web_text = "\n".join(f"- **{r['title']}**: {r['snippet']} [{r['url']}]" for r in web)
            parts.append(f"### Web Results\n{web_text}")
            sources.append("tool:web_search")

    return {
        "retrieved_context": "\n\n---\n\n".join(parts),
        "sources": sources,
    }


def synthesize_answer(state: AgentState) -> dict:
    query = state["messages"][-1].content
    context = state.get("retrieved_context", "")
    intent = state.get("intent", "general")

    full_prompt = f"""{SYSTEM_PROMPT}

## User Query
{query}

## Intent Detected
{intent}

## Retrieved Data
{context if context else "No specific data retrieved. Use your general knowledge about Indian markets."}

## Instructions
Based on the retrieved data above, provide a comprehensive, well-structured answer.
Format numbers clearly (e.g., PE: 22.5x, ROE: 35%, Score: 82/100).
If showing multiple stocks, use a markdown table.
"""

    llm = get_llm()
    response = llm.invoke(full_prompt)
    return {"messages": [AIMessage(content=response.content)]}


def build_graph(db_path: str = DB_PATH):
    """Build and compile the LangGraph agent."""

    def _execute_tools(state: AgentState) -> dict:
        return execute_tools(state, db_path=db_path)

    graph = StateGraph(AgentState)
    graph.add_node("classify_intent", classify_intent)
    graph.add_node("execute_tools", _execute_tools)
    graph.add_node("synthesize_answer", synthesize_answer)

    graph.set_entry_point("classify_intent")
    graph.add_edge("classify_intent", "execute_tools")
    graph.add_edge("execute_tools", "synthesize_answer")
    graph.add_edge("synthesize_answer", END)

    memory = MemorySaver()
    return graph.compile(checkpointer=memory)
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
& "backend-python\venv\Scripts\pytest.exe" tests/chatbot/test_agent.py -v
```

Expected: both tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/chatbot/agent.py tests/chatbot/test_agent.py
git commit -m "feat(chatbot): add LangGraph agent with intent classification and tool execution"
```

---

## Task 10: FastAPI Application

**Files:**
- Create: `src/server/chatbot/app.py`

- [ ] **Step 1: Implement app.py**

Create `src/server/chatbot/app.py`:
```python
"""
Chatbot FastAPI server. Run via:
    backend-python/venv/Scripts/python.exe src/server/chatbot/app.py
"""
import json
import logging
import os
import sys
import asyncio
from contextlib import asynccontextmanager

# Make src/server/chatbot importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from langchain_core.messages import HumanMessage

logging.basicConfig(level=logging.INFO, format="[chatbot] %(message)s")
logger = logging.getLogger(__name__)

DB_PATH = os.getenv("DB_PATH", "database.sqlite")
CHATBOT_PORT = int(os.getenv("CHATBOT_PORT", "8001"))
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "http://localhost:3000")

# Build graph at startup
_graph = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _graph
    logger.info("Starting up: building LangGraph agent...")
    try:
        from agent import build_graph
        _graph = build_graph(db_path=DB_PATH)
        logger.info("LangGraph agent ready")
    except Exception as e:
        logger.error(f"Failed to build agent: {e}")

    # Run ingest if chroma_store is empty
    try:
        from ingest import run_full_ingest
        chroma_dir = os.getenv("CHROMA_PERSIST_DIR", "src/server/chatbot/chroma_store")
        if not os.path.exists(chroma_dir) or not os.listdir(chroma_dir):
            logger.info("ChromaDB empty — running initial ingest...")
            result = await asyncio.to_thread(run_full_ingest, DB_PATH)
            logger.info(f"Ingest complete: {result}")
    except Exception as e:
        logger.warning(f"Ingest skipped: {e}")

    yield


app = FastAPI(title="Bharat Stock AI Chatbot", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    session_id: str
    history: list[dict] = []


class ChatResponse(BaseModel):
    answer: str
    sources: list[str] = []


@app.get("/health")
async def health():
    from llm import get_llm
    try:
        llm = get_llm()
        llm_type = type(llm).__name__
    except Exception:
        llm_type = "unavailable"
    return {"status": "ok", "llm": llm_type, "graph_ready": _graph is not None}


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if _graph is None:
        raise HTTPException(status_code=503, detail="Agent not ready")

    config = {"configurable": {"thread_id": req.session_id}}
    try:
        result = await asyncio.to_thread(
            _graph.invoke,
            {
                "messages": [HumanMessage(content=req.message)],
                "intent": "",
                "stock_symbol": None,
                "retrieved_context": "",
                "sources": [],
            },
            config,
        )
        ai_msg = result["messages"][-1]
        return ChatResponse(answer=ai_msg.content, sources=result.get("sources", []))
    except Exception as e:
        logger.error(f"Chat error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """SSE streaming endpoint — tokens are sent as 'data: {"token": "..."}\n\n'."""
    if _graph is None:
        raise HTTPException(status_code=503, detail="Agent not ready")

    config = {"configurable": {"thread_id": req.session_id}}

    async def token_generator():
        try:
            async for event in _graph.astream_events(
                {
                    "messages": [HumanMessage(content=req.message)],
                    "intent": "",
                    "stock_symbol": None,
                    "retrieved_context": "",
                    "sources": [],
                },
                config=config,
                version="v2",
            ):
                kind = event.get("event", "")
                if kind == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node == "synthesize_answer":
                        chunk = event["data"].get("chunk")
                        if chunk and hasattr(chunk, "content") and chunk.content:
                            payload = json.dumps({"token": chunk.content})
                            yield f"data: {payload}\n\n"
        except Exception as e:
            logger.error(f"Stream error: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(token_generator(), media_type="text/event-stream")


@app.post("/ingest")
async def trigger_ingest():
    """Re-run ChromaDB ingest (called by daily BullMQ job)."""
    try:
        from ingest import run_full_ingest
        result = await asyncio.to_thread(run_full_ingest, DB_PATH)
        return {"status": "ok", **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=CHATBOT_PORT, reload=False)
```

- [ ] **Step 2: Run the chatbot server manually to verify it starts**

```powershell
& "backend-python\venv\Scripts\python.exe" src/server/chatbot/app.py
```

Expected output (after ~5s for model load):
```
[chatbot] Starting up: building LangGraph agent...
[chatbot] Using Ollama (llama3.2)       ← or "Using Gemini fallback"
[chatbot] LangGraph agent ready
INFO:     Uvicorn running on http://0.0.0.0:8001
```

- [ ] **Step 3: Verify /health endpoint responds**

Open `http://localhost:8001/health` in a browser, or:
```powershell
Invoke-WebRequest -Uri "http://localhost:8001/health" -Method GET | Select-Object -ExpandProperty Content
```

Expected: `{"status":"ok","llm":"ChatOllama","graph_ready":true}`

Stop the server with Ctrl+C after verifying.

- [ ] **Step 4: Commit**

```bash
git add src/server/chatbot/app.py
git commit -m "feat(chatbot): add FastAPI server with /chat, /chat/stream, /health, /ingest endpoints"
```

---

## Task 11: React StockChatbot Component

**Files:**
- Create: `src/components/StockChatbot.tsx`
- Modify: `package.json` (add react-markdown)

- [ ] **Step 1: Add react-markdown to package.json and install**

In `package.json`, add to `"dependencies"`:
```json
"react-markdown": "^9.0.1"
```

Then install:
```powershell
npm install react-markdown
```

- [ ] **Step 2: Create StockChatbot.tsx**

Create `src/components/StockChatbot.tsx`:
```tsx
import React, { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { Send, Bot, User, Loader2, Wifi, WifiOff } from 'lucide-react'

const CHATBOT_URL = import.meta.env.VITE_CHATBOT_URL || 'http://localhost:8001'

interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: string[]
}

const QUICK_QUERIES = [
  'Fundamentally strong but undervalued stocks',
  'Stocks with upcoming results + bullish signals',
  'Top rated stocks today by AI score',
  'Which IT stocks have strong momentum?',
  'Stocks showing strong buy signals with high confidence',
  'Low PE high ROE stocks in banking sector',
]

function SourceBadge({ source }: { source: string }) {
  const label = source.replace('sql:', 'DB: ').replace('tool:', '')
  return (
    <span className="inline-block text-xs bg-slate-700 text-slate-300 rounded px-1.5 py-0.5 mr-1 mt-1">
      {label}
    </span>
  )
}

export default function StockChatbot() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        'Hello! I\'m **Bharat Stock AI** — your intelligent Indian market analyst. I can answer any question about NSE/BSE stocks using real-time data, fundamentals, screeners, news sentiment, and web search.\n\nTry one of the quick queries below, or ask me anything!',
    },
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isConnected, setIsConnected] = useState<boolean | null>(null)
  const [sessionId] = useState(() => crypto.randomUUID())
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Health check on mount
  useEffect(() => {
    fetch(`${CHATBOT_URL}/health`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setIsConnected(d?.status === 'ok'))
      .catch(() => setIsConnected(false))
  }, [])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return

    const userMsg: Message = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setIsLoading(true)

    // Add empty assistant bubble to stream into
    setMessages((prev) => [...prev, { role: 'assistant', content: '', sources: [] }])

    try {
      const response = await fetch(`${CHATBOT_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          session_id: sessionId,
          history: messages
            .slice(-10)
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      })

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const raw = decoder.decode(value, { stream: true })
        const lines = raw.split('\n').filter((l) => l.startsWith('data: '))

        for (const line of lines) {
          const data = line.slice(6)
          if (data === '[DONE]') break
          try {
            const parsed = JSON.parse(data)
            if (parsed.token) {
              setMessages((prev) => {
                const updated = [...prev]
                const last = updated[updated.length - 1]
                updated[updated.length - 1] = {
                  ...last,
                  content: last.content + parsed.token,
                }
                return updated
              })
            }
            if (parsed.error) {
              setMessages((prev) => {
                const updated = [...prev]
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: `⚠️ Error: ${parsed.error}`,
                }
                return updated
              })
            }
          } catch {
            // partial JSON chunk — ignore
          }
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev]
        updated[updated.length - 1] = {
          role: 'assistant',
          content: `⚠️ Could not connect to the chatbot server. Make sure \`npm run chatbot\` is running (port 8001).\n\nError: ${err instanceof Error ? err.message : String(err)}`,
        }
        return updated
      })
    } finally {
      setIsLoading(false)
      inputRef.current?.focus()
    }
  }, [isLoading, messages, sessionId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-blue-400" />
          <span className="font-semibold text-white">Bharat Stock AI</span>
          <span className="text-xs text-slate-400">powered by LangGraph + RAG</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {isConnected === null ? (
            <span className="text-slate-400">Connecting…</span>
          ) : isConnected ? (
            <>
              <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Online</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3.5 h-3.5 text-red-400" />
              <span className="text-red-400">Offline — run npm run chatbot</span>
            </>
          )}
        </div>
      </div>

      {/* Quick query chips */}
      <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-slate-700 bg-slate-850">
        {QUICK_QUERIES.map((q) => (
          <button
            key={q}
            onClick={() => sendMessage(q)}
            disabled={isLoading}
            className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-full px-3 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Message thread */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mt-1">
                <Bot className="w-4 h-4 text-white" />
              </div>
            )}
            <div className={`max-w-[80%] ${msg.role === 'user' ? 'order-first' : ''}`}>
              <div
                className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white ml-auto'
                    : 'bg-slate-800 text-slate-100'
                }`}
              >
                {msg.role === 'assistant' && !msg.content && isLoading && idx === messages.length - 1 ? (
                  <span className="flex gap-1 items-center text-slate-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Analyzing…</span>
                  </span>
                ) : (
                  <ReactMarkdown
                    components={{
                      table: (props) => (
                        <div className="overflow-x-auto my-2">
                          <table className="text-xs border-collapse w-full" {...props} />
                        </div>
                      ),
                      th: (props) => (
                        <th className="border border-slate-600 px-2 py-1 bg-slate-700 text-left" {...props} />
                      ),
                      td: (props) => (
                        <td className="border border-slate-600 px-2 py-1" {...props} />
                      ),
                      code: ({ children, ...props }) => (
                        <code className="bg-slate-700 rounded px-1 text-xs font-mono" {...props}>{children}</code>
                      ),
                      pre: (props) => (
                        <pre className="bg-slate-900 rounded p-2 text-xs overflow-x-auto my-2" {...props} />
                      ),
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                )}
              </div>
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-1 px-1">
                  <span className="text-xs text-slate-500">Sources: </span>
                  {msg.sources.map((s) => <SourceBadge key={s} source={s} />)}
                </div>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-slate-600 flex items-center justify-center flex-shrink-0 mt-1">
                <User className="w-4 h-4 text-white" />
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-slate-700 px-4 py-3 bg-slate-800">
        <div className="flex gap-2 items-center">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about any Indian stock, sector, screener, or market trend…"
            disabled={isLoading}
            className="flex-1 bg-slate-700 text-white rounded-lg px-4 py-2.5 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={isLoading || !input.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2.5 transition-colors flex items-center gap-2"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <p className="text-xs text-slate-500 mt-1.5 text-center">
          Data from NSE DB · Live prices · Web search · Powered by Ollama / Gemini
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/StockChatbot.tsx package.json package-lock.json
git commit -m "feat(chatbot): add React StockChatbot component with streaming SSE and markdown"
```

---

## Task 12: Wire up App.tsx Chat Tab + Final Startup Wiring

**Files:**
- Modify: `src/App.tsx`
- Modify: `package.json` (start script already updated in Task 1)

- [ ] **Step 1: Add the chat tab to App.tsx**

Open `src/App.tsx`. Find where the tab navigation is defined. Look for the array of tabs or the tab-rendering logic (it will look like a list of tab IDs/labels such as `dashboard`, `trade-cockpit`, etc.).

**Add the import** near the top of the file with other component imports:
```tsx
import StockChatbot from './components/StockChatbot'
```

**Add the tab entry** to the navigation tab list. Find the pattern that defines tab labels/IDs (e.g., an array of objects or a list of `<button>` elements with tab IDs). Add:
```tsx
{ id: 'chat', label: '🤖 AI Chat' }
```
or whatever object shape the existing tabs use. Place it at the end of the tab list.

**Add the tab content** in the section where tabs render their content panels. Find the `activeTab === 'signals'` or similar pattern and add alongside it:
```tsx
{activeTab === 'chat' && (
  <div className="h-[calc(100vh-4rem)]">
    <StockChatbot />
  </div>
)}
```

- [ ] **Step 2: Verify the Chat tab appears in the UI**

```powershell
npm run dev
```

Open `http://localhost:3000` in a browser. Scroll/look for the "🤖 AI Chat" tab in the navigation. Click it — you should see the chatbot UI with quick-query chips and the input bar.

- [ ] **Step 3: Start the chatbot server in a second terminal and test end-to-end**

In a second terminal:
```powershell
npm run chatbot
```

Wait for `LangGraph agent ready` in the output.

Back in the browser on the Chat tab:
1. Click "Top rated stocks today by AI score"
2. Verify a response streams in token-by-token
3. Try "Tell me about INFY"
4. Verify the response includes fundamentals and score data

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(chatbot): add Chat tab to App.tsx, wire up StockChatbot component"
```

---

## Self-Review

**Spec coverage check:**

| Spec Section | Task(s) covering it |
|---|---|
| FastAPI on port 8001 | Task 10 (app.py) |
| LangGraph 3-node graph | Task 9 (agent.py) |
| 6 intent classes | Task 9 (agent.py, INTENT_PROMPT + execute_tools) |
| SQL tool (5 functions) | Task 2 |
| Live price tool | Task 3 |
| Earnings calendar | Task 3 |
| News sentiment tool | Task 4 |
| Web search tool (DuckDuckGo) | Task 5 |
| ChromaDB ingest | Task 6 |
| Screener semantic search | Task 7 |
| Ollama/Gemini LLM fallback | Task 8 |
| SSE streaming endpoint | Task 10 |
| React Chat tab | Task 11 + 12 |
| Quick-query chips | Task 11 |
| Markdown rendering in chat | Task 11 |
| react-markdown | Task 11 |
| package.json chatbot script | Task 1 |
| backend-python/requirements.txt | Task 1 |
| .gitignore chroma_store | Task 1 |
| Golden path: fundamental_filter | Task 9 (execute_tools, fundamental_filter branch) |
| Golden path: earnings_upcoming | Task 9 (execute_tools, earnings_upcoming branch) |
| Golden path: stock_detail | Task 9 (execute_tools, stock_detail branch) |
| Golden path: screener_lookup | Task 9 (execute_tools, screener_lookup branch) |
| General queries (open-ended) | Task 9 (execute_tools, general branch) |
| Web search for recent data | Tasks 5 + 9 |

All spec requirements have corresponding tasks. No gaps found.
