import pytest
import sys, os
from datetime import datetime, timedelta
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))
sys.path.insert(0, os.path.dirname(__file__))  # package dir; makes the sibling conftest importable

from _pg_support import pg_available, patch_tool_connect
from tools import news_tool
from tools.news_tool import get_news_sentiment

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")


def _ago(days: int) -> str:
    """Dates must be RELATIVE to now, never literals.

    The original fixture hardcoded June 2026 timestamps and the tests asked for `days=30`.
    That silently stopped testing anything the moment those articles aged past the window --
    by 2026-08-16 every row was ~2 months old, so a correct `get_news_sentiment` returned
    nothing and the assertions failed for a reason that had nothing to do with the code.
    """
    return (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


@pytest.fixture
def news_db(pg_conn, monkeypatch):
    conn = pg_conn
    # Shadow the PRIMARY table with an empty one. get_news_sentiment reads news_sentiment_items
    # first and only falls back to news_articles; without this, a developer run resolves that
    # first query against PRODUCTION's public.news_sentiment_items and passes on real rows,
    # never touching the fixture data seeded below -- green for the wrong reason, and it failed
    # the moment it ran against an empty database.
    conn.execute("""CREATE TABLE news_sentiment_items (
        title TEXT, summary TEXT, source TEXT, published_at TIMESTAMP, sentiment TEXT,
        sentiment_score DOUBLE PRECISION, impact TEXT, category TEXT, sector TEXT,
        url TEXT, symbol TEXT, symbols TEXT
    )""")
    conn.execute("""CREATE TABLE news_articles (
        id TEXT PRIMARY KEY, title TEXT, summary TEXT, source TEXT,
        sentiment TEXT, category TEXT, url TEXT, symbols TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    conn.executemany("INSERT INTO news_articles VALUES (?,?,?,?,?,?,?,?,?)", [
        ("n1", "Infosys beats Q4 estimates", "Revenue grew 15% YoY", "ET", "Positive", "earnings", "http://a.com", "INFY", _ago(1)),
        ("n2", "Infosys wins $500M deal", "Large deal signed with US client", "MC", "Positive", "deal", "http://b.com", "INFY,TCS", _ago(2)),
        ("n3", "IT sector sees margin pressure", "Currency headwinds hit margins", "BS", "Negative", "sector", "http://c.com", "INFY,WIPRO", _ago(3)),
        ("n4", "Old news", "Old article", "ET", "Neutral", "general", "http://d.com", "INFY", _ago(200)),
    ])
    conn.commit()
    return patch_tool_connect(monkeypatch, news_tool, conn)


def test_get_news_sentiment_returns_articles_for_symbol(news_db):
    result = get_news_sentiment("INFY", days=30, db_path=news_db)
    assert result["symbol"] == "INFY"
    assert result["total"] >= 3
    # Keys are bullish/bearish, not positive/negative -- the test was written against an older
    # get_news_sentiment signature and had been asserting on keys the tool never returns.
    assert result["bullish"] >= 2
    assert result["bearish"] >= 1


def test_get_news_sentiment_excludes_old_articles(news_db):
    result = get_news_sentiment("INFY", days=7, db_path=news_db)
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
