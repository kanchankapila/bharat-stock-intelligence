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
- pe_lt: maximum PE ratio
- pb_lt: maximum Price-to-Book ratio
- roe_gt: minimum Return on Equity in %
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
        quant = get_quant_scores(sort_by="momentum_score", limit=10, db_path=db_path)
        if quant:
            add("Top Momentum Stocks", quant, "sql:quant_scores")

        signals = get_buy_signals(db_path=db_path, limit=10)
        if signals:
            add("Active BUY Signals", signals, "sql:signals")

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
