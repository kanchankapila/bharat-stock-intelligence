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
