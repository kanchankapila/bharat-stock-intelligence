import db from './db';

export type ScreenerCategory =
  | 'momentum' | 'institutional' | 'fundamental' | 'volume'
  | 'trend' | 'reversal' | 'quality' | 'growth'
  | 'sector' | 'valuation' | 'delivery' | 'other';

interface ClassifyResult {
  category: ScreenerCategory;
  subcategory: string | null;
  confidence: number;
  classified_by: 'keyword' | 'ollama';
}

// ── Keyword rule tables ──────────────────────────────────────────────────────

const RULES: Array<{
  category: ScreenerCategory;
  subcategory: string;
  keywords: string[];
  confidence: number;
}> = [
  // Momentum
  { category: 'momentum', subcategory: '52W High',          keywords: ['52 week high', '52w high', '52-week high', '52wk high', 'year high', '52 high', 'all time high', 'ath', '52high', '52week'], confidence: 0.95 },
  { category: 'momentum', subcategory: '52W Low',           keywords: ['52 week low', '52w low', '52-week low', 'year low', '52 low'], confidence: 0.95 },
  { category: 'momentum', subcategory: 'Breakout',          keywords: ['breakout', 'break out', 'breaking out', 'resistance breakout', 'price breakout', 'brkout'], confidence: 0.90 },
  { category: 'momentum', subcategory: 'Relative Strength', keywords: ['relative strength', 'rs rating', 'momentum score', 'trendlyne momentum', 'price momentum', 'rs screener'], confidence: 0.90 },
  { category: 'momentum', subcategory: 'Multibagger',       keywords: ['multibagger', 'multi-bagger', 'multi bagger', 'wealth creator', 'potential multibagger'], confidence: 0.90 },
  { category: 'momentum', subcategory: 'Price Surge',       keywords: ['price surge', 'surge', 'rally', 'gainer', 'top gainer', 'price rise', 'smart breakout', 'smart breakdown'], confidence: 0.85 },

  // Institutional
  { category: 'institutional', subcategory: 'FII Buying',    keywords: ['fii buy', 'fii buying', 'fii purchased', 'foreign buy', 'foreign institutional buy', 'fpi buy', 'fii increasing', 'fii/dii increasing'], confidence: 0.95 },
  { category: 'institutional', subcategory: 'DII Buying',    keywords: ['dii buy', 'dii buying', 'domestic institutional', 'mutual fund buy', 'mf buy', 'dii increasing'], confidence: 0.95 },
  { category: 'institutional', subcategory: 'Bulk Deal',     keywords: ['bulk deal', 'bulk purchase', 'bulk transaction', 'bulk buy'], confidence: 0.95 },
  { category: 'institutional', subcategory: 'Block Deal',    keywords: ['block deal', 'block trade', 'block transaction'], confidence: 0.95 },
  { category: 'institutional', subcategory: 'Promoter Buy',  keywords: ['promoter buy', 'promoter purchase', 'promoter increas', 'insider buy', 'promoter buying'], confidence: 0.90 },
  { category: 'institutional', subcategory: 'FII/DII',       keywords: ['fii', 'dii', 'fpi', 'institutional buying', 'institutional activity', 'mfs and fii', 'superstar investor', 'superstar portfolio'], confidence: 0.80 },

  // Fundamental
  { category: 'fundamental', subcategory: 'Low PE',          keywords: ['low pe', 'undervalued pe', 'pe below', 'cheap pe', 'low p/e', 'attractive pe', 'pe less than'], confidence: 0.90 },
  { category: 'fundamental', subcategory: 'PEG Undervalued', keywords: ['peg', 'peg ratio', 'peg undervalued', 'low peg'], confidence: 0.90 },
  { category: 'fundamental', subcategory: 'Earnings Growth', keywords: ['earnings growth', 'eps growth', 'profit growth qoq', 'qoq profit', 'net profit increas', 'earning', 'quarter profit'], confidence: 0.85 },
  { category: 'fundamental', subcategory: 'ROCE Strong',     keywords: ['roce', 'return on capital', 'high roce', 'strong roce', 'good roce'], confidence: 0.90 },
  { category: 'fundamental', subcategory: 'Debt-Free',       keywords: ['debt free', 'zero debt', 'debt-free', 'no debt', 'debt to equity < 0.1', 'debt to equity less', 'low debt'], confidence: 0.92 },
  { category: 'fundamental', subcategory: 'Strong Financials', keywords: ['strong financials', 'piotroski', 'financial health', 'financial strength', 'good fundamentals'], confidence: 0.80 },
  { category: 'fundamental', subcategory: 'Cash Flow',       keywords: ['cash flow', 'free cash', 'operating cash', 'fcf'], confidence: 0.85 },

  // Volume
  { category: 'volume', subcategory: 'Volume Shock',         keywords: ['volume shock', 'vol shock', 'unusual volume', 'volume spike', 'abnormal volume', 'extraordinary volume'], confidence: 0.95 },
  { category: 'volume', subcategory: 'High Vol Breakout',    keywords: ['high volume breakout', 'volume breakout', 'volume expansion', 'vol breakout', 'volume surge', 'high volume'], confidence: 0.90 },
  { category: 'volume', subcategory: 'Delivery Spike',       keywords: ['delivery volume', 'delivery percentage', 'delivery spike', 'high delivery', 'delivery ratio', 'rising delivery', 'delivery pct'], confidence: 0.90 },
  { category: 'volume', subcategory: 'OI Buildup',           keywords: ['oi buildup', 'open interest', 'oi increase', 'put call', 'pcr', 'oi build'], confidence: 0.85 },

  // Trend
  { category: 'trend', subcategory: 'Golden Cross',          keywords: ['golden cross', 'sma50 above sma200', '50 200 crossover', '50/200 cross'], confidence: 0.95 },
  { category: 'trend', subcategory: 'Death Cross',           keywords: ['death cross', 'sma50 below sma200'], confidence: 0.95 },
  { category: 'trend', subcategory: 'EMA Crossover',         keywords: ['ema crossover', 'ema cross', 'ema bullish', 'ema bearish', 'ema stack', 'bull stack', 'ema alignment', 'ema8', 'ema21'], confidence: 0.90 },
  { category: 'trend', subcategory: 'MA Breakout',           keywords: ['ma breakout', 'moving average breakout', 'crossed above sma', 'price above ma', 'above 200 dma', 'above 200ma', 'crossed above ema', 'above bollinger'], confidence: 0.88 },
  { category: 'trend', subcategory: 'Supertrend',            keywords: ['supertrend', 'super trend', 'supertrend buy', 'supertrend signal'], confidence: 0.95 },
  { category: 'trend', subcategory: 'ADX Strong',            keywords: ['adx', 'average directional', 'strong trend', 'trend strength', 'adx above'], confidence: 0.85 },
  { category: 'trend', subcategory: 'Uptrend',               keywords: ['uptrend', 'up trend', 'trending up', 'price uptrend', 'bullish trend'], confidence: 0.82 },
  { category: 'trend', subcategory: 'Downtrend',             keywords: ['downtrend', 'down trend', 'bearish trend', 'trending down'], confidence: 0.82 },

  // Reversal
  { category: 'reversal', subcategory: 'RSI Oversold',       keywords: ['rsi oversold', 'rsi below 30', 'oversold rsi', 'rsi reversal', 'rsi bounce', 'rsi power breakout'], confidence: 0.92 },
  { category: 'reversal', subcategory: 'RSI Overbought',     keywords: ['rsi overbought', 'rsi above 70', 'overbought rsi'], confidence: 0.92 },
  { category: 'reversal', subcategory: 'MACD Cross',         keywords: ['macd crossover', 'macd cross', 'macd bullish', 'macd bearish', 'macd signal', 'macd divergence'], confidence: 0.90 },
  { category: 'reversal', subcategory: 'Support Bounce',     keywords: ['support bounce', 'bounce from support', 'support level', 'demand zone bounce', 'near support'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'BB Squeeze',         keywords: ['bollinger band', 'bb squeeze', 'bollinger squeeze', 'bb breakout', 'bandwidth', 'bollinger compression'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'Hammer/Doji',        keywords: ['hammer', 'doji', 'engulfing', 'candlestick pattern', 'morning star', 'evening star', 'harami', 'bullish candle', 'bearish candle'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'CCI Oversold',       keywords: ['cci oversold', 'cci below', 'commodity channel'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'MFI Oversold',       keywords: ['mfi oversold', 'money flow index', 'mfi below', 'oversold by month money flow'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'Stochastic',         keywords: ['stochastic oversold', 'stochastic cross', 'stoch', 'slow stochastic'], confidence: 0.85 },

  // Quality
  { category: 'quality', subcategory: 'Consistent Compounder', keywords: ['consistent compounder', 'compounder', 'consistent performer', 'consistent growth', 'consistent earnings'], confidence: 0.92 },
  { category: 'quality', subcategory: 'High ROE',            keywords: ['high roe', 'roe above', 'return on equity', 'strong roe', 'good roe'], confidence: 0.90 },
  { category: 'quality', subcategory: 'High ROCE',           keywords: ['high roce', 'roce above', 'return on capital employed', 'strong roce', 'good roce'], confidence: 0.90 },
  { category: 'quality', subcategory: 'Dividend',            keywords: ['dividend yield', 'high dividend', 'dividend paying', 'regular dividend', 'dividend growth', 'dividend income'], confidence: 0.90 },
  { category: 'quality', subcategory: 'Zero Debt',           keywords: ['zero debt', 'debt free', 'no debt', 'debt-free', 'debt to equity 0'], confidence: 0.92 },
  { category: 'quality', subcategory: 'Cash Rich',           keywords: ['cash rich', 'cash cow', 'high cash', 'cash generation', 'cash and cash equivalent'], confidence: 0.88 },

  // Growth
  { category: 'growth', subcategory: 'Sales Growth',         keywords: ['sales growth', 'revenue growth', 'topline growth', 'top line growth', 'net sales growth', 'revenue increase'], confidence: 0.90 },
  { category: 'growth', subcategory: 'Profit Growth',        keywords: ['profit growth', 'pat growth', 'net profit growth', 'earnings growth yoy', 'profit increas', 'profit acceleration'], confidence: 0.90 },
  { category: 'growth', subcategory: 'Earnings Surprise',    keywords: ['earnings surprise', 'beat estimate', 'positive surprise', 'above estimate', 'beat expectation'], confidence: 0.90 },
  { category: 'growth', subcategory: 'Margin Expansion',     keywords: ['margin expansion', 'margin improvement', 'operating margin', 'ebitda margin', 'ebitda growth'], confidence: 0.88 },

  // Valuation
  { category: 'valuation', subcategory: 'DVM',               keywords: ['dvm', 'dvm score', 'dvm rating', 'high dvm', 'low dvm', 'dvm screener'], confidence: 0.95 },
  { category: 'valuation', subcategory: 'Low PB',            keywords: ['price to book', 'p/b below', 'low pb', 'book value', 'below book'], confidence: 0.88 },
  { category: 'valuation', subcategory: 'Margin of Safety',  keywords: ['margin of safety', 'intrinsic value', 'graham', 'undervalued stock'], confidence: 0.85 },

  // Delivery
  { category: 'delivery', subcategory: 'Delivery Spike',     keywords: ['delivery spike', 'high delivery', 'delivery percentage increase', 'rising delivery percentage', 'delivery pct rise'], confidence: 0.92 },
  { category: 'delivery', subcategory: 'Promoter Activity',  keywords: ['promoter holding', 'promoter pledge', 'promoter stake', 'promoter shareholding'], confidence: 0.88 },

  // Sector
  { category: 'sector', subcategory: 'Banking/NBFC',         keywords: ['banking', 'bank stocks', 'nbfc', 'financial sector', 'fintech', 'bank and finance'], confidence: 0.88 },
  { category: 'sector', subcategory: 'IT/Tech',              keywords: ['it sector', 'technology stocks', 'software stocks', 'it companies', 'tech sector'], confidence: 0.88 },
  { category: 'sector', subcategory: 'Pharma',               keywords: ['pharma', 'pharmaceutical', 'healthcare', 'hospital', 'medical'], confidence: 0.88 },
  { category: 'sector', subcategory: 'Infra/Defence',        keywords: ['infrastructure', 'defence', 'defense', 'railway', 'roads', 'infra', 'capital goods'], confidence: 0.88 },
  { category: 'sector', subcategory: 'PSU',                  keywords: ['psu', 'public sector', 'government company', 'psu gems', 'government owned', 'psu stocks'], confidence: 0.92 },
  { category: 'sector', subcategory: 'Auto',                 keywords: ['auto sector', 'automobile', 'automotive', 'vehicle', 'ev stocks', 'electric vehicle'], confidence: 0.88 },
  { category: 'sector', subcategory: 'FMCG',                 keywords: ['fmcg', 'consumer goods', 'food and beverage', 'consumer staples', 'fast moving'], confidence: 0.88 },
  { category: 'sector', subcategory: 'Energy',               keywords: ['energy sector', 'oil gas', 'power sector', 'renewable energy', 'solar', 'wind energy'], confidence: 0.88 },
  { category: 'sector', subcategory: 'Tata Group',           keywords: ['tata', 'tata empire', 'tata group', 'tata universe'], confidence: 0.95 },
  { category: 'sector', subcategory: 'Adani Group',          keywords: ['adani', 'adani group', 'adani universe'], confidence: 0.95 },
];

// ── Keyword classifier ───────────────────────────────────────────────────────

export function classifyByKeyword(name: string, description = ''): ClassifyResult {
  const text = (name + ' ' + description).toLowerCase();

  let best: ClassifyResult = { category: 'other', subcategory: null, confidence: 0, classified_by: 'keyword' };

  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (text.includes(kw)) {
        if (rule.confidence > best.confidence) {
          best = {
            category: rule.category,
            subcategory: rule.subcategory,
            confidence: rule.confidence,
            classified_by: 'keyword',
          };
        }
      }
    }
  }

  return best;
}

// ── Ollama fallback ──────────────────────────────────────────────────────────

async function classifyViaOllama(name: string): Promise<ClassifyResult> {
  const prompt = `You are classifying Indian stock market screeners.
Screener name: "${name}"
Available categories: momentum, institutional, fundamental, volume, trend, reversal, quality, growth, sector, valuation, delivery
Return ONLY valid JSON with no explanation: {"category": "...", "subcategory": "...", "confidence": 0.85}
If unsure use "other" as category.`;

  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', prompt, stream: false }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json() as { response: string };
    const match = data.response.match(/\{[^}]+\}/);
    if (!match) throw new Error('No JSON in response');
    const parsed = JSON.parse(match[0]) as { category?: string; subcategory?: string; confidence?: number };
    const validCategories: ScreenerCategory[] = [
      'momentum', 'institutional', 'fundamental', 'volume', 'trend',
      'reversal', 'quality', 'growth', 'sector', 'valuation', 'delivery', 'other',
    ];
    const cat = validCategories.includes(parsed.category as ScreenerCategory)
      ? (parsed.category as ScreenerCategory)
      : 'other';
    return {
      category: cat,
      subcategory: parsed.subcategory ?? null,
      confidence: parsed.confidence ?? 0.6,
      classified_by: 'ollama',
    };
  } catch {
    return { category: 'other', subcategory: null, confidence: 0, classified_by: 'keyword' };
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function classifyAllScreeners(): Promise<{
  classified: number;
  ollama_used: number;
  remaining_other: number;
}> {
  const rows = db.prepare(`
    SELECT scan_id, name, source
    FROM screener_master
    WHERE subcategory IS NULL
    ORDER BY source, name
  `).all() as Array<{ scan_id: string; name: string; source: string }>;

  if (rows.length === 0) {
    console.log('[Classifier] All screeners already classified.');
    return { classified: 0, ollama_used: 0, remaining_other: 0 };
  }

  console.log(`[Classifier] Classifying ${rows.length} unclassified screeners...`);

  const updateStmt = db.prepare(`
    UPDATE screener_master
    SET subcategory = ?, inferred_category = ?, category_confidence = ?, classified_by = ?
    WHERE scan_id = ?
  `);

  let classified = 0;
  let ollama_used = 0;
  let remaining_other = 0;

  const needOllama: Array<{ scan_id: string; name: string }> = [];

  for (const row of rows) {
    const result = classifyByKeyword(row.name);
    if (result.confidence >= 0.7) {
      updateStmt.run(result.subcategory, result.category, result.confidence, 'keyword', row.scan_id);
      classified++;
    } else {
      needOllama.push({ scan_id: row.scan_id, name: row.name });
    }
  }

  // Ollama batch: 5 at a time with 200ms between batches
  const BATCH_SIZE = 5;
  for (let i = 0; i < needOllama.length; i += BATCH_SIZE) {
    const batch = needOllama.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (item) => {
        const result = await classifyViaOllama(item.name);
        if (result.category !== 'other' && result.confidence >= 0.6) {
          updateStmt.run(result.subcategory, result.category, result.confidence, 'ollama', item.scan_id);
          classified++;
          ollama_used++;
        } else {
          updateStmt.run('Other', 'other', 0.3, 'keyword', item.scan_id);
          remaining_other++;
        }
      }),
    );
    if (i + BATCH_SIZE < needOllama.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[Classifier] Done: ${classified} classified, ${ollama_used} via Ollama, ${remaining_other} remain 'other'`);
  return { classified, ollama_used, remaining_other };
}
