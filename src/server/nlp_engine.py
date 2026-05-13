import re
from typing import Dict, Any, List

class NLPScreenerInference:
    """
    Infers sentiment and category from screener names and descriptions
    using regex and keyword mapping.
    """
    
    BULLISH_KEYWORDS = [
        r'breakout', r'bullish', r'oversold', r'undervalued', r'\bgrowth\b', 
        r'accumulation', r'52\s?week\s?high', r'golden\s?cross', r'upper\s?circuit', r'volume\s?shocker',
        r'bargain', r'attractive', r'quality', r'high\s?roe', r'low\s?pe', r'uptrend',
        r'recovery', r'buy', r'long\s?build', r'short\s?cover', r'upgrade', r'positive',
        r'profit\b', r'improving', r'expanding', r'outperform'
    ]
    
    BEARISH_KEYWORDS = [
        r'bearish', r'overbought', r'overvalued', r'weak', r'distribution', r'debt',
        r'52\s?week\s?low', r'death\s?cross', r'lower\s?circuit', r'losses', r'sell',
        r'underperform', r'downtrend', r'short\s?build', r'long\s?unwind', r'expensive',
        r'downgrade', r'negative', r'declining', r'drop', r'fall', r'target\s?cut',
        r'profit\s?fall', r'margin\s?hit', r'decreasing', r'contraction', r'deteriorating',
        r'negative\s?\w*\s?growth', r'declining\s?\w*\s?profit', r'low\s?growth', r'lowest', r'sell\s?zone',
        r'broker\s?downgrades', r'negative\s?surprise'
    ]
    
    TIMEFRAME_MAPPING = {
        'intraday': [r'intraday', r'today', r'15\s?min', r'hourly', r'day', r'opening', r'closing', r'shocker', r'fast', r'minute', r'live'],
        'long_term': [r'long\s?term', r'annual', r'yearly', r'multi\s?year', r'quarterly', r'fundamental', r'roe', r'valuation', r'investing', r'durability', r'quality']
    }
    
    CATEGORY_MAPPING = {
        'fundamental': [r'roe', r'pe', r'valuation', r'debt', r'margin', r'eps', r'fundamental', r'bargain', r'quality', r'profit', r'revenue', r'earnings'],
        'technical': [r'rsi', r'macd', r'sma', r'ema', r'dma', r'indicator', r'cross', r'pattern', r'support', r'resistance', r'bollinger', r'stochastic', r'ichimoku'],
        'momentum': [r'breakout', r'trend', r'momentum', r'strength', r'high', r'low', r'circuit', r'fast', r'rally', r'spike'],
        'delivery': [r'delivery', r'accumulation', r'distribution', r'volume', r'bulk', r'block'],
    }

    def infer(self, name: str, description: str = "") -> Dict[str, Any]:
        name_str = str(name) if name is not None else ""
        desc_str = str(description) if description is not None else ""
        text = (name_str + " " + desc_str).lower()
        
        # 1. Sentiment Inference
        sentiment = "neutral"
        bullish_hits = [k for k in self.BULLISH_KEYWORDS if re.search(k, text)]
        bearish_hits = [k for k in self.BEARISH_KEYWORDS if re.search(k, text)]
        
        # SPECIAL CASE: Negative words override positive ones if they are clearly modifying them
        # If we have 'negative' or 'declining' or 'weak', it usually negates 'growth' or 'profit'
        is_negated = any(re.search(k, text) for k in [r'negative', r'declining', r'weak', r'falling', r'low', r'downgrade', r'cut'])
        
        bullish_score = len(bullish_hits)
        bearish_score = len(bearish_hits)
        
        if len(bearish_hits) > 0:
            # If any bearish hit is found, it's very likely bearish
            sentiment = "bearish"
        elif is_negated and (r'\bgrowth\b' in bullish_hits or r'profit\b' in bullish_hits):
            # Explicitly catch 'negative growth' etc. even if not in BEARISH_KEYWORDS
            sentiment = "bearish"
        elif bullish_score > bearish_score:
            sentiment = "bullish"
        elif bearish_score > bullish_score:
            sentiment = "bearish"
            
        # Debug
        if sentiment != "neutral":
            # print(f"DEBUG [{sentiment}]: '{text[:50]}...' -> Bullish: {bullish_hits}, Bearish: {bearish_hits}")
            pass
            
        # 2. Category Inference
        inferred_category = "other"
        max_cat_score = 0
        for cat, keywords in self.CATEGORY_MAPPING.items():
            cat_score = sum(1 for k in keywords if re.search(k, text))
            if cat_score > max_cat_score:
                max_cat_score = cat_score
                inferred_category = cat
                
        # 3. Timeframe Inference
        inferred_timeframe = "long_term" # Default
        max_tf_score = 0
        for tf, keywords in self.TIMEFRAME_MAPPING.items():
            tf_score = sum(1 for k in keywords if re.search(k, text))
            if tf_score > max_tf_score:
                max_tf_score = tf_score
                inferred_timeframe = tf
        
        # If it's fundamental, it's almost always long term
        if inferred_category == 'fundamental':
            inferred_timeframe = 'long_term'

        # 4. Confidence Score (0.0 to 1.0)
        confidence = min(1.0, (bullish_score + bearish_score + max_cat_score + max_tf_score) / 6.0)
        if confidence == 0: confidence = 0.5 # Default fallback
        
        return {
            "sentiment": sentiment,
            "category": inferred_category,
            "timeframe": inferred_timeframe,
            "confidence": confidence,
            "bullish_hits": bullish_score,
            "bearish_hits": bearish_score
        }

if __name__ == "__main__":
    # Test cases
    nlp = NLPScreenerInference()
    print(nlp.infer("Strong Breakout Stocks", "Bullish breakout with strong momentum"))
    print(nlp.infer("Undervalued High ROE Stocks", "Strong fundamentals and attractive valuation"))
    print(nlp.infer("Overbought RSI with Bearish Engulfing"))
