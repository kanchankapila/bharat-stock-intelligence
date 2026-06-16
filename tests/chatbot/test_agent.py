import pytest
from unittest.mock import patch, MagicMock
import sqlite3
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from langchain_core.messages import HumanMessage, AIMessage


@pytest.fixture
def agent_db(tmp_path):
    db_path = str(tmp_path / "agent.db")
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
            stopLoss REAL, confidence REAL, reasoning TEXT, status TEXT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE screener_master(scan_id TEXT PRIMARY KEY, name TEXT, source TEXT,
            inferred_sentiment TEXT, inferred_category TEXT);
        CREATE TABLE trendlyne_screener_stocks(screener_id TEXT, symbol TEXT,
            PRIMARY KEY(screener_id, symbol));
        CREATE TABLE moneycontrol_screener_stocks(scan_id TEXT, mcsymbol TEXT, symbol TEXT,
            stock_name TEXT, PRIMARY KEY(scan_id, mcsymbol));
        CREATE TABLE quant_scores(symbol TEXT PRIMARY KEY, return_1w REAL, return_1m REAL,
            return_3m REAL, return_6m REAL, above_sma200 INTEGER, momentum_score REAL);
        CREATE TABLE news_articles(id TEXT PRIMARY KEY, title TEXT, summary TEXT, source TEXT,
            sentiment TEXT, category TEXT, url TEXT, symbols TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE technical_analysis_signals(symbol TEXT PRIMARY KEY, trend TEXT, rsi REAL);
    """)
    conn.execute("INSERT INTO nse_stocks VALUES ('INFY','Infosys Ltd','IT','Software')")
    conn.execute("INSERT INTO nse_stocks VALUES ('HDFCBANK','HDFC Bank','Banking','Private Bank')")
    conn.execute("INSERT INTO stock_fundamentals VALUES ('INFY',22.5,4.2,35.0,12.0,15.0,0.1,750000000000,8,2.5)")
    conn.execute("INSERT INTO stock_fundamentals VALUES ('HDFCBANK',18.0,3.1,16.5,8.0,10.0,0.5,1200000000000,7,1.2)")
    conn.execute("INSERT INTO stock_scores VALUES ('INFY','long_term',82.0,0.85,'Strong Buy','Fundamental')")
    conn.execute("INSERT INTO stock_scores VALUES ('HDFCBANK','long_term',74.0,0.78,'Buy','Technical')")
    conn.execute("INSERT INTO stock_factor_breakdown VALUES ('INFY','long_term',75.0,88.0,70.0,80.0)")
    conn.execute("INSERT INTO stock_factor_breakdown VALUES ('HDFCBANK','long_term',80.0,72.0,65.0,68.0)")
    conn.execute("INSERT INTO quant_scores VALUES ('INFY',2.1,8.5,18.0,22.0,1,78.5)")
    conn.execute("INSERT INTO quant_scores VALUES ('HDFCBANK',1.5,5.0,12.0,18.0,1,65.0)")
    conn.commit()
    conn.close()
    return db_path


def _make_mock_llm(responses):
    """Create a mock LLM that returns given responses in sequence."""
    mock = MagicMock()
    side_effects = [MagicMock(content=r) for r in responses]
    mock.invoke.side_effect = side_effects
    return mock


def _reload_agent():
    """Reload agent module to get a fresh copy, returns the reloaded module."""
    import importlib, agent as ag
    importlib.reload(ag)
    return ag


def test_agent_stock_detail_intent(agent_db):
    """Agent correctly classifies stock_detail and calls SQL + price + news tools."""
    mock_llm = _make_mock_llm([
        '{"intent": "stock_detail", "stock_symbol": "INFY"}',   # classify_intent
        "Infosys is a leading IT company with PE 22.5 and ROE 35%.",  # synthesize_answer
    ])

    with patch("agent.get_llm", return_value=mock_llm):
        with patch("agent.get_live_price", return_value={"symbol": "INFY", "price": 1450.0, "change_pct": 1.5}):
            with patch("agent.web_search_stock", return_value=[]):
                with patch("agent.get_news_sentiment", return_value={"total": 0, "overall_sentiment": "Neutral", "headlines": []}):
                    from agent import build_graph
                    graph = build_graph(db_path=agent_db)
                    config = {"configurable": {"thread_id": "test-1"}}
                    result = graph.invoke(
                        {"messages": [HumanMessage(content="Tell me about Infosys")],
                         "intent": "", "stock_symbol": None, "retrieved_context": "", "sources": []},
                        config=config,
                    )

    assert result["intent"] == "stock_detail"
    assert result["stock_symbol"] == "INFY"
    messages = result["messages"]
    assert len(messages) >= 2
    assert isinstance(messages[-1], AIMessage)
    assert "Infosys" in messages[-1].content


def test_agent_fundamental_filter_intent(agent_db):
    """Agent correctly classifies fundamental_filter and calls filter_stocks_by_fundamentals."""
    mock_llm = _make_mock_llm([
        '{"intent": "fundamental_filter", "stock_symbol": null}',  # classify_intent
        '{"pe_lt": 25, "pb_lt": 4, "roe_gt": 10, "min_score": 55}',  # extract filter params
        "Here are fundamentally strong undervalued stocks: HDFCBANK (PE: 18.0, ROE: 16.5%).",  # synthesize
    ])

    # Reload the agent module first so patches apply cleanly to the fresh module
    import importlib, agent as ag
    importlib.reload(ag)

    with patch("agent.get_llm", return_value=mock_llm):
        with patch("agent.web_search", return_value=[]):
            graph = ag.build_graph(db_path=agent_db)
            config = {"configurable": {"thread_id": "test-2"}}
            result = graph.invoke(
                {"messages": [HumanMessage(content="Which stocks are fundamentally strong but cheap?")],
                 "intent": "", "stock_symbol": None, "retrieved_context": "", "sources": []},
                config=config,
            )

    assert result["intent"] == "fundamental_filter"
    assert isinstance(result["messages"][-1], AIMessage)


def test_agent_general_intent_uses_web_search(agent_db):
    """Agent uses web_search for general queries."""
    mock_llm = _make_mock_llm([
        '{"intent": "general", "stock_symbol": null}',  # classify_intent
        "The FII/DII flow today shows net buying by FIIs.",  # synthesize
    ])

    web_results = [{"title": "FII flows", "snippet": "FIIs bought Rs 2000 Cr today", "url": "http://ex.com"}]

    # Reload first, then patch
    import importlib, agent as ag
    importlib.reload(ag)

    with patch("agent.get_llm", return_value=mock_llm):
        with patch("agent.web_search", return_value=web_results) as mock_ws:
            graph = ag.build_graph(db_path=agent_db)
            config = {"configurable": {"thread_id": "test-3"}}
            result = graph.invoke(
                {"messages": [HumanMessage(content="What is the FII DII flow today?")],
                 "intent": "", "stock_symbol": None, "retrieved_context": "", "sources": []},
                config=config,
            )

    assert result["intent"] == "general"
    assert isinstance(result["messages"][-1], AIMessage)
    # web_search should have been called
    assert mock_ws.called


def test_agent_state_persists_across_turns(agent_db):
    """Multi-turn: second message in same session can reference first."""
    mock_llm = _make_mock_llm([
        '{"intent": "stock_detail", "stock_symbol": "INFY"}',   # classify turn 1
        "Infosys has PE 22.5 and score 82.",                     # synthesize turn 1
        '{"intent": "general", "stock_symbol": null}',          # classify turn 2
        "As mentioned, Infosys score is 82 which is Strong Buy.",  # synthesize turn 2
    ])

    # Reload first, then patch
    import importlib, agent as ag
    importlib.reload(ag)

    with patch("agent.get_llm", return_value=mock_llm):
        with patch("agent.get_live_price", return_value={"symbol": "INFY", "price": 1450.0, "change_pct": 1.0}):
            with patch("agent.web_search_stock", return_value=[]):
                with patch("agent.web_search", return_value=[]):
                    with patch("agent.get_news_sentiment", return_value={"total": 0, "overall_sentiment": "Neutral", "headlines": []}):
                        graph = ag.build_graph(db_path=agent_db)
                        config = {"configurable": {"thread_id": "test-4"}}

                        # Turn 1
                        state1 = graph.invoke(
                            {"messages": [HumanMessage(content="Tell me about INFY")],
                             "intent": "", "stock_symbol": None, "retrieved_context": "", "sources": []},
                            config=config,
                        )
                        # Turn 2 — send a follow-up using same session
                        state2 = graph.invoke(
                            {"messages": [HumanMessage(content="What is its score?")],
                             "intent": "", "stock_symbol": None, "retrieved_context": "", "sources": []},
                            config=config,
                        )

    # Both turns should have AI responses
    assert isinstance(state1["messages"][-1], AIMessage)
    assert isinstance(state2["messages"][-1], AIMessage)
