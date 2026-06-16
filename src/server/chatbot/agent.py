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
from tools.market_tool import (
    get_market_pulse, get_top_confluence_stocks, get_stock_signals,
    get_fii_dii_sentiment, get_sector_momentum, get_signal_accuracy,
    get_live_news_sentiment, get_daily_briefing,
)

DB_PATH = os.getenv("DB_PATH", "database.sqlite")
logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are Bharat Stock AI, an expert Indian stock market analyst with access to real-time platform data.

Available data (all from local DB unless noted):
- Live signals: unified_signals (today), confluence_signals (30-min updates), technical_signals (RSI/MACD/SMA, daily)
- Fundamentals: PE, P/B, ROE, revenue growth, debt/equity, Piotroski F-score
- AI composite scores (0–100): Strong Buy / Buy / Hold / Sell / Strong Sell
- Quant scores: 1W/1M/3M/6M returns, momentum rank, Sharpe ratio, max drawdown
- Market regime: HMM-based (BULLISH/BEARISH/SIDEWAYS), sentiment score, macro asset moves
- FII/DII net flows (last available data — may lag a few days)
- Screener memberships: Trendlyne, MoneyControl, ETnow; confluence score across screeners
- News: FinBERT-scored items with impact level (HIGH/MEDIUM/LOW) and category
- Live prices from Yahoo Finance
- Signal accuracy: win rates by signal type, regime, sector from historical outcomes
- Web search: only when DB data is stale or query is explicitly about breaking news

Response guidelines:
- Quote actual numbers from the data — never make up figures
- Use markdown tables for stock comparisons and lists
- For stock detail: structure as Overview → Fundamentals → Technical → Signals → News → Verdict
- Mention data freshness when relevant (e.g., "FII data as of 2026-05-26")
- Never give absolute buy/sell orders; provide analysis only
- If a table has 0 rows returned, say so explicitly rather than hallucinating
"""

INTENT_PROMPT = """Classify this Indian stock market query into exactly one intent.

Intents:
- stock_detail: a specific stock's profile, price, fundamentals, technicals, signals, news
- fundamental_filter: screen/find stocks by fundamental criteria (PE, ROE, undervalued, quality, etc.)
- screener_lookup: stocks in a named screener, strategy or theme
- news_sentiment: news, events, sentiment about a stock, sector, or the market
- earnings_upcoming: upcoming results/earnings announcements, quarterly results calendar
- market_overview: market mood, regime, sentiment, FII/DII flows, macro moves, indices, overall market direction
- daily_briefing: today's top stock picks, morning brief, daily report, what to buy today, platform's top picks, pre-market brief, post-close report
- sector_analysis: sector performance, sector rotation, which sector is outperforming/underperforming
- signal_performance: signal accuracy, win rates, how good are the signals, platform performance metrics
- general: comparisons, open-ended analysis, anything else

Query: {query}

Also extract: the NSE stock symbol if explicitly mentioned (e.g., INFY, HDFCBANK, RELIANCE). Null if none.
Also extract: the sector name if explicitly mentioned (e.g., IT, Banking, Pharma). Null if none.

Respond ONLY with valid JSON:
{{"intent": "...", "stock_symbol": "...", "sector": "..."}}"""

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

# Keywords that signal the query needs live/recent web data
_WEB_KEYWORDS = {
    "today", "latest", "recent", "this week", "this month", "just",
    "breaking", "now", "current", "live", "crude", "rupee", "rbi",
    "inflation", "gdp", "budget", "ipo", "listing",
}


def _needs_web(query: str) -> bool:
    q = query.lower()
    return any(kw in q for kw in _WEB_KEYWORDS)


class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], operator.add]
    intent: str
    stock_symbol: str | None
    sector: str | None
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
    parsed = _safe_json(response.content, {"intent": "general", "stock_symbol": None, "sector": None})
    return {
        "intent": parsed.get("intent", "general"),
        "stock_symbol": parsed.get("stock_symbol") or None,
        "sector": parsed.get("sector") or None,
    }


def execute_tools(state: AgentState, db_path: str = DB_PATH) -> dict:
    intent = state.get("intent", "general")
    symbol = state.get("stock_symbol")
    sector = state.get("sector")
    query = state["messages"][-1].content
    llm = get_llm()

    parts: list[str] = []
    sources: list[str] = []

    def add(label: str, data, source: str):
        if data:
            parts.append(f"### {label}\n```json\n{json.dumps(data, indent=2, default=str)}\n```")
            sources.append(source)

    def add_web(results: list[dict]):
        if results:
            text = "\n".join(f"- **{r['title']}**: {r['snippet']} [{r['url']}]" for r in results)
            parts.append(f"### Web Results\n{text}")
            sources.append("tool:web_search")

    # ── stock_detail ──────────────────────────────────────────────────────────
    if intent == "stock_detail" and symbol:
        fund = get_stock_fundamentals(symbol, db_path=db_path)
        add("Fundamentals & AI Score", fund, "sql:stock_fundamentals")

        price = get_live_price(symbol)
        add("Live Price", price, "tool:live_price")

        sig = get_stock_signals(symbol, days=7, db_path=db_path)
        add("Signals (unified + technical + confluence)", sig, "sql:unified_signals+technical_signals")

        screeners = get_screener_membership(symbol, db_path=db_path)
        if screeners:
            add("Screener Memberships", screeners, "sql:screener_master")

        news = get_news_sentiment(symbol, days=14, db_path=db_path)
        add("News Sentiment (14 days)", news, "sql:news_sentiment_items")

        quant = get_quant_scores(symbol=symbol, db_path=db_path)
        if quant:
            add("Quant Scores", quant[0], "sql:quant_scores")

        # Web only if stock missing from DB, news thin, or query is time-sensitive
        news_count = news.get("total", 0) if isinstance(news, dict) else 0
        if not fund or news_count < 2 or _needs_web(query):
            web = web_search_stock(
                symbol, fund["name"] if fund else symbol,
                "latest news analyst view 2026", max_results=4,
            )
            add_web(web)

    # ── fundamental_filter ───────────────────────────────────────────────────
    elif intent == "fundamental_filter":
        resp = llm.invoke(FILTER_PARAMS_PROMPT.format(query=query))
        params = _safe_json(resp.content, {"pe_lt": 25, "pb_lt": 3, "roe_gt": 12, "min_score": 60})
        stocks = filter_stocks_by_fundamentals(
            pe_lt=params.get("pe_lt"), pb_lt=params.get("pb_lt"),
            roe_gt=params.get("roe_gt"), revenue_growth_gt=params.get("revenue_growth_gt"),
            min_score=params.get("min_score", 55), db_path=db_path,
        )
        add("Filtered Stocks (Fundamentals)", stocks, "sql:stock_fundamentals+scores")
        add("Applied Filters", params, "tool:filter_params")

        # Also show confluence conviction for found stocks
        if stocks:
            top_syms = [s["symbol"] for s in stocks[:5]]
            confluence = get_top_confluence_stocks(min_confluence=0, limit=50, db_path=db_path)
            matched = [c for c in confluence if c["symbol"] in top_syms]
            if matched:
                add("Screener Conviction Scores", matched, "sql:confluence_signals")

        # Web only if very few DB results
        if len(stocks) < 3:
            add_web(web_search("fundamentally strong undervalued Indian stocks NSE 2026", max_results=3))

    # ── screener_lookup ──────────────────────────────────────────────────────
    elif intent == "screener_lookup":
        screeners = search_screener(query, top_k=3, db_path=db_path)
        add("Screener Results", screeners, "tool:screener_lookup")

        # Also show top confluence stocks as an alternative view
        top = get_top_confluence_stocks(min_confluence=70, conviction="ELITE", limit=10, db_path=db_path)
        if top:
            add("Top Conviction Stocks (Multi-Screener)", top, "sql:confluence_signals")

        if not screeners:
            add_web(web_search(f"Indian stock screener {query[:80]} NSE", max_results=3))

    # ── news_sentiment ───────────────────────────────────────────────────────
    elif intent == "news_sentiment":
        news = get_live_news_sentiment(symbol=symbol, sector=sector, days=14, db_path=db_path)
        add("News Sentiment (FinBERT, 14 days)", news, "sql:news_sentiment_items")

        # Web if DB has fewer than 3 articles or query is time-sensitive
        news_count = news.get("total", 0) if isinstance(news, dict) else 0
        if news_count < 3 or _needs_web(query):
            web_q = (
                f"{symbol} NSE stock latest news 2026" if symbol
                else f"Indian stock market news today {query[:80]}"
            )
            add_web(web_search(web_q, max_results=5))

    # ── earnings_upcoming ────────────────────────────────────────────────────
    elif intent == "earnings_upcoming":
        calendar = get_earnings_calendar(days_ahead=21, db_path=db_path)
        add("Upcoming Earnings Calendar", calendar, "tool:earnings_calendar")

        signals = get_buy_signals(db_path=db_path, limit=10)
        if signals:
            add("Active BUY Signals (cross-reference)", signals, "sql:unified_signals")

    # ── market_overview ──────────────────────────────────────────────────────
    elif intent == "market_overview":
        pulse = get_market_pulse(db_path=db_path)
        add("Market Pulse (Regime + Sentiment + Macro)", pulse, "sql:market_regimes+sentiment")

        fii = get_fii_dii_sentiment(days=20, db_path=db_path)
        add("FII/DII Flows", fii, "sql:fii_dii_flow")

        top = get_top_confluence_stocks(min_confluence=75, limit=10, db_path=db_path)
        if top:
            add("Top Conviction Stocks Today", top, "sql:confluence_signals")

        # Web for live macro data like crude/rupee/global indices
        if _needs_web(query):
            add_web(web_search(f"Indian stock market NSE today {query[:80]}", max_results=4))

    # ── sector_analysis ──────────────────────────────────────────────────────
    elif intent == "sector_analysis":
        momentum = get_sector_momentum(sector=sector, db_path=db_path)
        add(
            f"{'Sector: ' + sector if sector else 'All Sector'} Momentum",
            momentum,
            "sql:quant_scores+nse_stocks",
        )

        if sector:
            # Top stocks in the sector
            stocks = get_top_confluence_stocks(sector=sector, min_confluence=50, limit=10, db_path=db_path)
            if stocks:
                add(f"Top {sector} Stocks by Screener Conviction", stocks, "sql:confluence_signals")

        news = get_live_news_sentiment(sector=sector, days=7, db_path=db_path)
        if news.get("total", 0) > 0:
            add(f"{'Sector' if not sector else sector} News Sentiment", news, "sql:news_sentiment_items")

    # ── daily_briefing ────────────────────────────────────────────────────────
    elif intent == "daily_briefing":
        briefing = get_daily_briefing(db_path=db_path)
        if briefing and not briefing.get("error"):
            add("Today's Research Briefing (Pre-Market + Post-Close)", briefing, "sql:daily_research_reports")
        else:
            # Fall back to top confluence stocks when no report ready yet
            top = get_top_confluence_stocks(min_confluence=75, limit=15, db_path=db_path)
            if top:
                add("Top Conviction Stocks (no daily report yet — using confluence)", top, "sql:confluence_signals")
            pulse = get_market_pulse(db_path=db_path)
            add("Market Pulse", pulse, "sql:market_regimes+sentiment")

    # ── signal_performance ───────────────────────────────────────────────────
    elif intent == "signal_performance":
        accuracy = get_signal_accuracy(db_path=db_path)
        add("Signal Accuracy & Win Rates", accuracy, "sql:signal_outcomes+strategy_performance")

        pulse = get_market_pulse(db_path=db_path)
        if pulse.get("regime"):
            add("Current Market Regime", pulse["regime"], "sql:market_regimes")

    # ── general ──────────────────────────────────────────────────────────────
    else:
        pulse = get_market_pulse(db_path=db_path)
        add("Market Pulse", pulse, "sql:market_regimes+sentiment")

        top = get_top_confluence_stocks(min_confluence=70, limit=15, db_path=db_path)
        if top:
            add("Top Conviction Stocks", top, "sql:confluence_signals")

        signals = get_buy_signals(db_path=db_path, limit=10)
        if signals:
            add("Active BUY Signals", signals, "sql:unified_signals")

        # Web only for queries about live/macro data not available in DB
        if _needs_web(query) or not top:
            add_web(web_search(f"Indian stock market NSE {query[:120]}", max_results=5))

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
Format numbers clearly (e.g., PE: 22.5x, ROE: 35%, Score: 82/100, Return 1M: +4.2%).
If showing multiple stocks, use a markdown table with the most relevant columns.
If data has a staleness warning, mention the date of the data.
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
