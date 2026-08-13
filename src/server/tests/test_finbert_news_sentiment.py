import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from finbert_news_sentiment import score_batch


def _fake_predict(sentiment, score, available=True):
    return {"sentiment": sentiment, "score": score, "available": available}


class TestScoreBatch:
    """2026-08-13: replaces enrichWithAI (Anthropic, silently never ran -- ANTHROPIC_API_KEY
    empty since inception). Mocks FinBERTInference.predict so this runs without loading the
    440MB model -- the real model behavior is exercised separately via the live_datasource-
    style manual check documented in this file's own module docstring, not in CI."""

    def test_bullish_label_gets_positive_signed_score(self):
        with patch("finbert_news_sentiment.FinBERTInference") as MockCls:
            MockCls.return_value.predict.return_value = _fake_predict("bullish", 0.95)
            out = score_batch([{"id": "a", "title": "Profit jumps", "summary": ""}])
        assert out == [{"id": "a", "sentiment": "BULLISH", "score": 0.95}]

    def test_bearish_label_gets_negative_signed_score(self):
        """The sign flip is the one non-obvious piece of logic here -- FinBERT's own `score`
        is an unsigned confidence, not a signed bullish-minus-bearish value like
        scoreSentiment()'s existing convention expects."""
        with patch("finbert_news_sentiment.FinBERTInference") as MockCls:
            MockCls.return_value.predict.return_value = _fake_predict("bearish", 0.87)
            out = score_batch([{"id": "b", "title": "Fraud probe launched", "summary": ""}])
        assert out == [{"id": "b", "sentiment": "BEARISH", "score": -0.87}]

    def test_neutral_label_gets_zero_score(self):
        with patch("finbert_news_sentiment.FinBERTInference") as MockCls:
            MockCls.return_value.predict.return_value = _fake_predict("neutral", 0.0)
            out = score_batch([{"id": "c", "title": "Rate held steady", "summary": ""}])
        assert out == [{"id": "c", "sentiment": "NEUTRAL", "score": 0.0}]

    def test_missing_summary_does_not_crash(self):
        with patch("finbert_news_sentiment.FinBERTInference") as MockCls:
            MockCls.return_value.predict.return_value = _fake_predict("neutral", 0.0)
            out = score_batch([{"id": "d", "title": "Headline only"}])
        assert out[0]["id"] == "d"

    def test_batch_preserves_item_order_and_ids(self):
        predictions = [_fake_predict("bullish", 0.6), _fake_predict("bearish", 0.7)]
        with patch("finbert_news_sentiment.FinBERTInference") as MockCls:
            MockCls.return_value.predict.side_effect = predictions
            out = score_batch([
                {"id": "x", "title": "t1", "summary": "s1"},
                {"id": "y", "title": "t2", "summary": "s2"},
            ])
        assert [r["id"] for r in out] == ["x", "y"]
        assert out[0]["sentiment"] == "BULLISH" and out[1]["sentiment"] == "BEARISH"

    def test_unavailable_prediction_is_dropped_not_faked_as_neutral(self):
        """2026-08-13 regression: predict()'s `available=False` (model never loaded, or the
        call threw) was being appended here identically to a genuine neutral verdict, so
        enrichWithFinBERT() marked the row ai_scored=1 with a confident-looking fake NEUTRAL/0.0
        that permanently overwrote the keyword baseline and never retried. Measured live:
        4,644 of 13,755 ai_scored=1 rows (33.8%) sat at exactly NEUTRAL/0.0 -- a real FinBERT
        call is decisive (96-97% confidence re-run live on two of the worst offenders), not a
        coin-flip landing on exactly 0 a third of the time. The item must be dropped from the
        output so it stays ai_scored=0 and is retried, not silently poisoned."""
        with patch("finbert_news_sentiment.FinBERTInference") as MockCls:
            MockCls.return_value.predict.return_value = _fake_predict("neutral", 0.0, available=False)
            out = score_batch([{"id": "e", "title": "TCS shares tumble 4% after CEO resigns", "summary": ""}])
        assert out == []

    def test_unavailable_item_does_not_block_a_later_available_one_in_the_same_batch(self):
        predictions = [
            _fake_predict("neutral", 0.0, available=False),
            _fake_predict("bearish", 0.96, available=True),
        ]
        with patch("finbert_news_sentiment.FinBERTInference") as MockCls:
            MockCls.return_value.predict.side_effect = predictions
            out = score_batch([
                {"id": "down", "title": "model unavailable for this one"},
                {"id": "up", "title": "Kirloskar Industries Q1 profit falls 69%"},
            ])
        assert [r["id"] for r in out] == ["up"]
        assert out[0]["sentiment"] == "BEARISH"
