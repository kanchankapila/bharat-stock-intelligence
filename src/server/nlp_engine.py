import re
import os
from typing import Dict, Any, List
try:
    from transformers import pipeline
except ImportError:
    pipeline = None

# Bump this version whenever keyword rules or model change.
# scoring_engine checks this and rebuilds screener_master when it changes.
NLP_VERSION = "3.7"


class FinBERTInference:
    """
    High-fidelity financial sentiment analysis using ProsusAI/finbert BERT model.
    """
    def __init__(self):
        self.enabled = os.environ.get("USE_FINBERT", "true").lower() == "true"
        self.classifier = None
        if self.enabled and pipeline:
            try:
                # model="ProsusAI/finbert" is ~440MB. It will be cached locally.
                self.classifier = pipeline("sentiment-analysis", model="ProsusAI/finbert")
                print("FinBERT model loaded successfully.")
            except Exception as e:
                print(f"Warning: Failed to load FinBERT model: {e}. Falling back to regex.")
        else:
            if not pipeline:
                print("Warning: transformers not installed. Falling back to regex.")
            else:
                print("FinBERT is disabled via USE_FINBERT env var.")

    def predict(self, text: str) -> Dict[str, Any]:
        if not self.classifier:
            return {"sentiment": "neutral", "score": 0.0}
        
        try:
            # Truncate text to BERT's max length (512 tokens, approx 300-400 words)
            result = self.classifier(text[:1500])[0]
            # Map labels: positive -> bullish, negative -> bearish
            label_map = {
                "positive": "bullish",
                "negative": "bearish",
                "neutral": "neutral"
            }
            return {
                "sentiment": label_map.get(result["label"], "neutral"),
                "score": result["score"]
            }
        except Exception as e:
            print(f"Error during FinBERT inference: {e}")
            return {"sentiment": "neutral", "score": 0.0}


class NLPScreenerInference:
    """
    Infers sentiment, category, and timeframe from screener names/descriptions.
    Uses FinBERT for sentiment and regex for category/timeframe.
    """

    BULLISH_KEYWORDS = [
        # Technical bullish
        r'golden\s*cross',
        r'\bbullish\b',
        r'\bbreakout\b',
        r'\boversold\b',
        r'upper\s*circuit',
        r'52.?week.?high',
        r'\d+.?year.?high',
        r'all.?time.?high',
        r'\buptrend\b',
        r'rising',
        r'positive',
        r'increasing',
        r'\bgain\b',
        r'\babove\b',
        r'crossed\s+above',
        r'greater\s+than',
        r'highest',
        r'gap\s+up',
        r'checklist',
        # Fundamental bullish
        r'strong\s+(?:financial|growth|perform|sequential|fundamental)',
        r'rising\s+(?:profit|revenue|roe|eps|margin|ebitda)',
        r'high\s+(?:roe|roa|piotroski|quality|checklist|efficiency|return|dividend|yield|delivery)',
        r'\bpiotroski\b',
        r'improving',
        r'expanding',
        r'outperform',
        r'upgrade',
        r'consistent',
        r'performing',
        r'growth',
        # Value/bargain
        r'\bbargain\b',
        r'\bundervalued\b',
        r'low\s*p[eb]\b',
        r'pe\s+buy\s+zone',
        r'reasonable\s+price',
        r'attractive\s+valuation',
        r'zero\s*debt',
        r'debt\s*free',
        r'value\s+buy',
        # Accumulation / institutional interest
        r'\bbuys?\b',
        r'\baccumulation\b',
        r'long\s*build',
        r'short\s*cover',
        r'increasing\s+shareholding',
        r'superstar.*buy',
        r'buy.*superstar',
        r'institutional\s+interest',
        # Quality / investment style
        r'\bquality\b',
        r'\belite\b',
        r'cash\s*cow',
        r'multibagger',
        r'straight\s*flush',
        r'buy\s+on\s+dips',
        r'\bgainers?\b',
        r'durability',
        r'magic\s*formula',
        r'all.?star',
        r'momentum',
        r'potential',
        r'turnaround',
        r'upside',
        r'benefit',
        r'profitable',
        r'compounder',
        r'monopoly',
        r'\bgems?\b',
        r'solvent\b',
        r'ready\s+to\s+take\s+off',
        r'powerhouse',
        r'rapid',
        r'favorite',
        r'stable',
        r'margin\s+of\s+safety',
    ]

    BEARISH_KEYWORDS = [
        # Technical bearish
        r'death\s*cross',
        r'\bbearish\b',
        r'\bbreakdown\b',
        r'\boverbought\b',
        r'lower\s*circuit',
        r'52.?week.?low',
        r'\d+.?year.?low',
        r'all.?time.?low',
        r'new.?low',
        r'below.{1,20}(?:200|sma|ema|dma)',
        r'\bdowntrend\b',
        r'falling',
        r'negative',
        r'decreasing',
        r'loss',
        r'\bbelow\b',
        r'insolvent',
        r'crossed\s+below',
        r'less\s+than',
        r'lowest',
        r'gap\s+down',
        r'downgrade',
        # Fundamental bearish
        r'declining\s+(?:profit|revenue|margin|earning|fundamental|financial)',
        r'deteriorating',
        r'contraction',
        r'negative\s+(?:growth|surprise|eps)',
        r'weak\s+(?:financial|fundamental)',
        r'profit\s+fall',
        r'margin\s+(?:hit|compress)',
        r'slowing',
        # Value / risk
        r'\bexpensive\b',
        r'\bovervalued\b',
        r'pe\s+sell\s+zone',
        r'high\s+debt',
        r'debt\s+rising',
        # Selling / distribution
        r'\bsells?\b',
        r'short\s*build',
        r'long\s*unwind',
        r'\bdistribution\b',
        r'\bunderperform\b',
        r'exit',
        r'sell\s+off',
        # Negative screener labels
        r'\blosers?\b',
        r'\bcaution\b',
        r'\btrap\b',
        r'risky\s+value',
        r'slowing\s+down',
        r'wealth\s+destroy',
        r'low\s+dvm',
        r'exercise\s+caution',
        r'red\s+flag',
        r'\bweaker?\b',
        r'negative\s+return',
        r'avoid',
        # Compound negative patterns
        r'momentum\s+trap',
        r'value\s+trap',
        r'wealth\s+destroy',
        r'dvm\s+low',
        r'low\s+dvm',
    ]

    SIGNAL_TYPE_PATTERNS: Dict[str, List[str]] = {
        'RSI':          [r'\brsi\b', r'relative\s+strength', r'oversold', r'overbought'],
        'MACD':         [r'\bmacd\b', r'moving\s+average\s+conv'],
        'VOLUME':       [r'\bvolume\b', r'delivery', r'accumulation', r'distribution', r'turnover'],
        'PRICE_ACTION': [r'breakout', r'breakdown', r'\bsupport\b', r'\bresistance\b', r'candlestick',
                         r'pattern', r'chart', r'circuit', r'52.?week', r'all.?time.?high', r'gap\s+up',
                         r'momentum', r'\bema\b', r'\bsma\b', r'moving\s+average', r'golden\s+cross',
                         r'death\s+cross', r'supertrend', r'near\s+high', r'near\s+low'],
        'FUNDAMENTAL':  [r'\bpe\b', r'\bpb\b', r'\beps\b', r'\broe\b', r'\broa\b', r'piotroski',
                         r'\bdebt\b', r'earnings', r'revenue', r'profit', r'\bmargin\b', r'dividend',
                         r'checklist', r'quality', r'cash\s+cow', r'zero\s*debt', r'debt\s*free',
                         r'strong\s+fundamental', r'balance\s+sheet'],
        'VALUATION':    [r'valuation', r'undervalued', r'bargain', r'low\s+pe', r'low\s+pb',
                         r'pe\s+buy\s+zone', r'attractive\s+price'],
        'SECTOR':       [r'sector', r'industry', r'thematic', r'conglomerate', r'empire',
                         r'universe', r'gems', r'monopoly', r'\bpsu\b', r'infra', r'defence'],
    }

    TIMEFRAME_MAPPING = {
        'intraday': [
            r'\bintraday\b',
            r'\btoday\b',
            r'of\s+the\s+day\b',
            r'15\s?min',
            r'15m\b',
            r'\bhourly\b',
            r'\bminute\b',
            r'fast\s+mover',
        ],
        'long_term': [
            r'long.?term',
            r'\bannual\b',
            r'\byearly\b',
            r'multi.?year',
            r'5\s+year',
            r'3\s+year',
            r'10\s+year',
            r'\bfundamental\b',
            r'\bpiotroski\b',
            r'\broe\b',
            r'\broa\b',
            r'\bdurability\b',
            r'sustainable\s+growth',
            r'\binvesting\b',
            r'quarterly\s+(?:result|growth|profit)',
        ],
    }

    CATEGORY_MAPPING = {
        'fundamental': [
            r'\bpiotroski\b',
            r'\broe\b',
            r'\broa\b',
            r'\beps\b',
            r'\bearnings\b',
            r'\bprofit\b',
            r'\brevenue\b',
            r'\bebitda\b',
            r'cash\s+flow',
            r'\bcfo\b',
            r'net\s+profit',
            r'\bmargin\b',
            r'debt\s+to\s+equity',
            r'interest\s+coverage',
            r'\bdurability\b',
            r'sustainable\s+growth',
            r'straight\s+flush',
            r'cash\s+cow',
            r'zero\s+debt',
            r'\belite\b',
            r'multibagger',
            r'forecaster',
            r'\banalyst\b',
            r'buy\s+on\s+dips',
            r'superstar\s+investor',
            r'peg\s+ratio',
            r'\bqoq\b',
            r'\byoy\b',
            r'quarterly\s+(?:result|growth)',
            r'pitroski',
            r'z\s+score',
            r'altman',
        ],
        'technical': [
            r'\brsi\b',
            r'\bmacd\b',
            r'\bsma\b',
            r'\bema\b',
            r'\bdma\b',
            r'\bstochastic\b',
            r'bollinger',
            r'ichimoku',
            r'supertrend',
            r'\batr\b',
            r'\badx\b',
            r'\bobv\b',
            r'candlestick',
            r'pattern',
            r'\btriangle\b',
            r'\bflag\b',
            r'\bchannel\b',
            r'golden\s+cross',
            r'death\s+cross',
            r'\bsupport\b',
            r'\bresistance\b',
            r'technical\s+(?:indicator|signal|trend|score)',
            r'price\s+action',
            r'\bdarvas\b',
            r'above.{1,20}200',
            r'below.{1,20}200',
            r'\bsqueeze\b',
            r'momentum\s+score',
            r'52.?week',
            r'\d+.?year.?(?:high|low)',
            r'\bdivergence\b',
            r'\bcci\b',
            r'\bvwap\b',
            r'\bfibonacci\b',
            r'\bpivot\b',
        ],
        'valuation': [
            r'\bpe\b',
            r'\bpb\b',
            r'p/e',
            r'p/b',
            r'price.?to.?(?:earnings|book)',
            r'valuation',
            r'\bpeg\b',
            r'buy\s+zone',
            r'sell\s+zone',
            r'fair\s+value',
            r'intrinsic',
            r'ev/ebitda',
            r'\bovervalued\b',
            r'\bundervalued\b',
            r'\bexpensive\b',
            r'\bbargain\b',
            r'reasonable\s+price',
            r'low\s*p[eb]\b',
        ],
        'momentum': [
            r'\bmomentum\b',
            r'\bbreakout\b',
            r'upper\s*circuit',
            r'lower\s*circuit',
            r'\brally\b',
            r'\bspike\b',
            r'top\s+gainers?',
            r'top\s+losers?',
            r'of\s+the\s+day\b',
            r'relative\s+(?:strength|outperformance)',
            r'price\s+performance',
            r'trend\s+(?:follow|score)',
            r'52.?week.?(?:high|low)',
        ],
        'sector': [
            r'\btata\b',
            r'\badani\b',
            r'\bpsu\b',
            r'public\s+sector',
            r'monopoly',
            r'defence',
            r'defense',
            r'\binfra\b',
            r'infrastructure',
            r'pli\s+scheme',
            r'government\s+(?:scheme|sector)',
        ],
        'delivery': [
            r'\bdelivery\b',
            r'\baccumulation\b',
            r'\bdistribution\b',
            r'\bvolume\b',
            r'bulk\s+deal',
            r'block\s+deal',
            r'\bfii\b',
            r'\bdii\b',
            r'institutional',
            r'shareholding',
            r'mutual\s+fund',
            r'promoter',
        ],
    }

    def __init__(self):
        self.finbert = FinBERTInference()

    def infer(self, name: str, description: str = "") -> Dict[str, Any]:
        name_str = str(name) if name is not None else ""
        desc_str = str(description) if description is not None else ""
        text = (name_str + " " + desc_str).lower()

        # 1. Sentiment (Hybrid approach: FinBERT + Regex fallback/boost)
        finbert_res = self.finbert.predict(text)
        
        # We still use regex hits for "boosting" or fallback
        bullish_hits = [k for k in self.BULLISH_KEYWORDS if re.search(k, text)]
        bearish_hits = [k for k in self.BEARISH_KEYWORDS if re.search(k, text)]
        bullish_score = len(bullish_hits)
        bearish_score = len(bearish_hits)

        # Decide final sentiment
        if finbert_res["sentiment"] != "neutral":
            sentiment = finbert_res["sentiment"]
            sentiment_score = finbert_res["score"]
        else:
            # Fallback to regex if FinBERT is neutral or failed
            if bearish_score > bullish_score:
                sentiment = "bearish"
                sentiment_score = 0.5 + (min(bearish_score, 5) / 10.0)
            elif bullish_score > bearish_score:
                sentiment = "bullish"
                sentiment_score = 0.5 + (min(bullish_score, 5) / 10.0)
            else:
                # Extra heuristics for financial terms that are naturally directional
                # but might be missed by simple count comparison
                # Compound bearish patterns take priority over generic "momentum" = bullish
                if re.search(r'momentum\s+trap|value\s+trap|bear\s+trap|wealth\s+destro|low\s+dvm|dvm\s+low', text):
                    sentiment = "bearish"
                    sentiment_score = 0.7
                elif "momentum" in text or "breakout" in text or "performing" in text or "upgrade" in text:
                    sentiment = "bullish"
                    sentiment_score = 0.6
                elif "falling" in text or "breakdown" in text or "deteriorating" in text or "downgrade" in text:
                    sentiment = "bearish"
                    sentiment_score = 0.6
                elif "less than" in text:
                    # PE/PB less than is usually good, others usually bad
                    if "pe" in text or "pb" in text or "debt" in text or "p/e" in text:
                        sentiment = "bullish"
                    else:
                        sentiment = "bearish"
                    sentiment_score = 0.6
                elif "greater than" in text:
                    # PE/PB greater than is usually bad, others usually good
                    if "pe" in text or "pb" in text or "debt" in text or "p/e" in text:
                        sentiment = "bearish"
                    else:
                        sentiment = "bullish"
                    sentiment_score = 0.6
                else:
                    sentiment = "neutral"
                    sentiment_score = 0.0

        # 2. Category — pick the one with the most keyword hits
        inferred_category = "other"
        max_cat_score = 0
        for cat, keywords in self.CATEGORY_MAPPING.items():
            cat_score = sum(1 for k in keywords if re.search(k, text))
            if cat_score > max_cat_score:
                max_cat_score = cat_score
                inferred_category = cat

        # Fundamental always overrides valuation on a tie (fundamental is more specific)
        if inferred_category == 'valuation':
            fund_score = sum(1 for k in self.CATEGORY_MAPPING['fundamental'] if re.search(k, text))
            if fund_score >= max_cat_score:
                inferred_category = 'fundamental'

        # 3. Timeframe — default long_term
        inferred_timeframe = "long_term"
        max_tf_score = 0
        for tf, keywords in self.TIMEFRAME_MAPPING.items():
            tf_score = sum(1 for k in keywords if re.search(k, text))
            if tf_score > max_tf_score:
                max_tf_score = tf_score
                inferred_timeframe = tf

        # Fundamental/valuation are always long-term regardless
        if inferred_category in ('fundamental', 'valuation'):
            inferred_timeframe = 'long_term'

        # 4. Confidence (0.0–1.0)
        # Boost confidence if FinBERT and Regex agree
        finbert_agreement = 1.2 if (
            (sentiment == "bullish" and bullish_score > 0) or 
            (sentiment == "bearish" and bearish_score > 0)
        ) else 1.0

        total_signals = bullish_score + bearish_score + max_cat_score + max_tf_score
        confidence = min(1.0, (total_signals / 6.0) * finbert_agreement)
        
        if finbert_res["sentiment"] != "neutral":
            # If FinBERT is very sure, use its score as a base
            confidence = max(confidence, finbert_res["score"])

        if confidence == 0:
            confidence = 0.2  # low-confidence default for unrecognised screeners

        # 5. Signal type tag for dedup
        signal_type_tag = 'OTHER'
        max_sig_score = 0
        for sig_type, patterns in self.SIGNAL_TYPE_PATTERNS.items():
            sig_score = sum(1 for p in patterns if re.search(p, text))
            if sig_score > max_sig_score:
                max_sig_score = sig_score
                signal_type_tag = sig_type

        return {
            "sentiment": sentiment,
            "category": inferred_category,
            "timeframe": inferred_timeframe,
            "confidence": confidence,
            "bullish_hits": bullish_score,
            "bearish_hits": bearish_score,
            "signal_type_tag": signal_type_tag,
        }


if __name__ == "__main__":
    nlp = NLPScreenerInference()
    tests = [
        ("High Piotroski Score - Companies with strong financials", ""),
        ("Golden Cross 50 day over 200 day", ""),
        ("Low PE stocks with PE TTM lower than 3 year, 5 year and 10 year average PE", ""),
        ("Wealth Destroyers In The Past six Months", ""),
        ("Momentum Trap (DVM)", ""),
        ("Low DVM Stocks - Stocks to Exercise Caution On", ""),
        ("MFs and FII/DIIs increasing their shareholding QoQ", ""),
        ("NSE Stocks that Hit Upper Circuit Today", ""),
        ("Top Gainers of the Day", ""),
        ("Top Losers of the Day", ""),
        ("Cash Cows", ""),
        ("Elite Bluechips", ""),
        ("Zero Debt Quality", ""),
        ("The Tata Empire", ""),
        ("PSU Gems", ""),
        ("RSI Oversold", ""),
        ("Straight Flush", ""),
        ("Range Breakout", ""),
        ("Stocks in PE Buy Zone with Reasonable Durability Score", ""),
        ("Buys by Superstar Investors", ""),
        ("Sells by Superstar Investors", ""),
    ]
    for name, desc in tests:
        r = nlp.infer(name, desc)
        print(f"[{r['sentiment']:8s}] [{r['category']:12s}] [{r['timeframe']:10s}] conf={r['confidence']:.2f}  | {name}")
