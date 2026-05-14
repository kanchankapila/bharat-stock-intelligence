import re
from typing import Dict, Any

# Bump this version whenever keyword rules change.
# scoring_engine checks this and rebuilds screener_master when it changes.
NLP_VERSION = "2.0"


class NLPScreenerInference:
    """
    Infers sentiment, category, and timeframe from screener names/descriptions
    using regex keyword matching.
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
        r'new.?high',
        r'above.{1,20}(?:200|sma|ema|dma)',
        r'\buptrend\b',
        # Fundamental bullish
        r'strong\s+(?:financial|growth|perform|sequential)',
        r'rising\s+(?:profit|revenue|roe|eps|margin)',
        r'high\s+(?:roe|roa|piotroski|quality)',
        r'\bpiotroski\b',
        r'improving',
        r'expanding',
        r'outperform',
        r'\bupgrade\b',
        # Value/bargain
        r'\bbargain\b',
        r'\bundervalued\b',
        r'low\s*p[eb]\b',
        r'pe\s+buy\s+zone',
        r'reasonable\s+price',
        r'attractive\s+valuation',
        r'zero\s*debt',
        r'debt\s*free',
        # Accumulation / institutional interest
        r'\bbuys?\b',
        r'\baccumulation\b',
        r'long\s*build',
        r'short\s*cover',
        r'increasing\s+shareholding',
        r'superstar.*buy',
        r'buy.*superstar',
        # Quality / investment style
        r'\bquality\b',
        r'\belite\b',
        r'cash\s*cow',
        r'multibagger',
        r'straight\s*flush',
        r'buy\s+on\s+dips',
        r'\bgainers?\b',
        r'durability',
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
        # Fundamental bearish
        r'declining\s+(?:profit|revenue|margin|earning)',
        r'deteriorating',
        r'contraction',
        r'\bdowngrade\b',
        r'negative\s+(?:growth|surprise|eps)',
        r'weak\s+(?:financial|fundamental)',
        r'profit\s+fall',
        r'margin\s+(?:hit|compress)',
        # Value / risk
        r'\bexpensive\b',
        r'\bovervalued\b',
        r'pe\s+sell\s+zone',
        r'high\s+debt',
        # Selling / distribution
        r'\bsells?\b',
        r'short\s*build',
        r'long\s*unwind',
        r'\bdistribution\b',
        r'\bunderperform\b',
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
    ]

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

    def infer(self, name: str, description: str = "") -> Dict[str, Any]:
        name_str = str(name) if name is not None else ""
        desc_str = str(description) if description is not None else ""
        text = (name_str + " " + desc_str).lower()

        # 1. Sentiment
        bullish_hits = [k for k in self.BULLISH_KEYWORDS if re.search(k, text)]
        bearish_hits = [k for k in self.BEARISH_KEYWORDS if re.search(k, text)]
        bullish_score = len(bullish_hits)
        bearish_score = len(bearish_hits)

        if bearish_score > bullish_score:
            sentiment = "bearish"
        elif bullish_score > bearish_score:
            sentiment = "bullish"
        elif bullish_score == bearish_score and bullish_score > 0:
            sentiment = "neutral"
        else:
            sentiment = "neutral"

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
        total_signals = bullish_score + bearish_score + max_cat_score + max_tf_score
        confidence = min(1.0, total_signals / 6.0)
        if confidence == 0:
            confidence = 0.2  # low-confidence default for unrecognised screeners

        return {
            "sentiment": sentiment,
            "category": inferred_category,
            "timeframe": inferred_timeframe,
            "confidence": confidence,
            "bullish_hits": bullish_score,
            "bearish_hits": bearish_score,
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
