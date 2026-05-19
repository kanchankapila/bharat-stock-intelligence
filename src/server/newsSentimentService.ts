/**
 * News Sentiment Service
 *
 * Fetches financial news from multiple Indian + global RSS sources every 15 minutes.
 * Scores each article for: sentiment (BULLISH/BEARISH/NEUTRAL), impact (HIGH/MEDIUM/LOW),
 * and category (EARNINGS/ORDER_WIN/BUYBACK/POLICY/IPO/GLOBAL/SECTOR/GENERAL).
 * Aggregates into a market sentiment snapshot and Nifty range prediction.
 *
 * Sources (Indian): Economic Times, Business Standard, LiveMint, MoneyControl, The Hindu BusinessLine
 * Sources (Global): Reuters, Yahoo Finance (via globalMarketService)
 */

import db from './db';
import crypto from 'crypto';
import { fetchGlobalMarketData } from './globalMarketService';

function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type NewsSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type NewsImpact    = 'HIGH' | 'MEDIUM' | 'LOW';
export type NewsCategory  =
  | 'EARNINGS' | 'ORDER_WIN' | 'BUYBACK' | 'POLICY' | 'IPO'
  | 'GLOBAL' | 'SECTOR' | 'GENERAL';

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  source_type: 'INDIAN' | 'GLOBAL';
  url: string;
  published_at: string;
  fetched_at: string;
  sentiment: NewsSentiment;
  sentiment_score: number;
  impact: NewsImpact;
  category: NewsCategory;
  symbols_json: string;
  sector: string | null;
}

export interface MarketSentimentSnapshot {
  id: number;
  snapshot_at: string;
  overall_score: number;
  overall_label: string;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  high_impact_count: number;
  nifty_bias: string;
  nifty_support: number | null;
  nifty_resistance: number | null;
  nifty_last_close: number | null;
  global_cue: string;
  global_score: number;
  key_themes_json: string;
  source_count: number;
}

// ─── News Sources ─────────────────────────────────────────────────────────────

interface NewsSource {
  name: string;
  url: string;
  type: 'INDIAN' | 'GLOBAL';
  timeout?: number;
}

const NEWS_SOURCES: NewsSource[] = [
  // Indian sources
  { name: 'Economic Times Markets', url: 'https://economictimes.indiatimes.com/markets/stocks/rss.cms', type: 'INDIAN' },
  { name: 'Economic Times Economy', url: 'https://economictimes.indiatimes.com/news/economy/rss.cms', type: 'INDIAN' },
  { name: 'Business Standard Markets', url: 'https://www.business-standard.com/rss/markets-106.rss', type: 'INDIAN' },
  { name: 'Business Standard Companies', url: 'https://www.business-standard.com/rss/companies-101.rss', type: 'INDIAN' },
  { name: 'LiveMint Markets', url: 'https://www.livemint.com/rss/markets', type: 'INDIAN' },
  { name: 'LiveMint Companies', url: 'https://www.livemint.com/rss/companies', type: 'INDIAN' },
  { name: 'MoneyControl Latest', url: 'https://www.moneycontrol.com/rss/latestnews.xml', type: 'INDIAN' },
  { name: 'MoneyControl Markets', url: 'https://www.moneycontrol.com/rss/marketreports.xml', type: 'INDIAN' },
  { name: 'Hindu BusinessLine', url: 'https://www.thehindubusinessline.com/markets/?service=rss', type: 'INDIAN' },
  { name: 'NDTV Profit', url: 'https://feeds.feedburner.com/ndtvnews-business', type: 'INDIAN' },
  // Global sources
  { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews', type: 'GLOBAL' },
  { name: 'Reuters India', url: 'https://feeds.reuters.com/reuters/INbusinessNews', type: 'GLOBAL' },
  { name: 'Financial Times', url: 'https://www.ft.com/rss/home/uk', type: 'GLOBAL', timeout: 8000 },
];

// ─── Keyword Classifiers ──────────────────────────────────────────────────────

const BULLISH_KEYWORDS = [
  'surge', 'rally', 'gain', 'gains', 'profit', 'profits', 'beat', 'beats', 'record', 'records',
  'growth', 'rise', 'rises', 'jump', 'jumps', 'soar', 'soars', 'strong', 'positive', 'upgrade',
  'upgraded', 'outperform', 'bullish', 'breakout', 'order win', 'order wins', 'contract', 'contracts',
  'deal', 'deals', 'acquisition', 'buyback', 'buy back', 'dividend', 'dividends', 'expansion',
  'turnaround', 'recovery', 'rebound', 'higher', 'upside', 'target raised', 'q4 profit',
  'net profit up', 'revenue up', 'ebitda up', 'margin expansion', 'bottomed', 'all-time high',
  '52-week high', 'listing gains', 'ipo subscribed', 'ipo listing', 'stake sale',
];

const BEARISH_KEYWORDS = [
  'fall', 'falls', 'drop', 'drops', 'decline', 'declines', 'loss', 'losses', 'miss', 'misses',
  'weak', 'weaker', 'negative', 'sell', 'downgrade', 'downgraded', 'bearish', 'breakdown',
  'debt', 'fraud', 'penalty', 'penalties', 'recession', 'inflation', 'rate hike',
  'miss estimates', 'below estimate', 'lower guidance', 'concern', 'concerns', 'risk', 'risks',
  'defaults', 'npa', 'write-off', 'impairment', 'layoffs', 'job cuts', 'downfall',
  'margin compression', 'net loss', 'revenue down', 'profit falls', 'pat down',
  'disappoints', 'disappointing', 'warning', 'lower outlook', 'sell-off', 'crash',
];

const CATEGORY_KEYWORDS: Record<NewsCategory, string[]> = {
  EARNINGS: ['q1', 'q2', 'q3', 'q4', 'quarterly', 'pat', 'net profit', 'revenue', 'results', 'earnings', 'fy26', 'fy25', 'ebitda', 'margin', 'annual results', 'half-yearly'],
  ORDER_WIN: ['order win', 'order wins', 'contract awarded', 'contract win', 'wins order', 'secures order', 'bagged order', 'wins project', 'secures contract', 'letter of intent', 'loi', 'work order', 'export order'],
  BUYBACK: ['buyback', 'buy back', 'share repurchase', 'tender offer', 'open offer', 'promoter buying'],
  POLICY:  ['rbi', 'sebi', 'government', 'policy', 'repo rate', 'monetary policy', 'budget', 'gst', 'finance ministry', 'regulation', 'tax', 'msme', 'pli scheme', 'import duty'],
  IPO:     ['ipo', 'initial public offering', 'listing', 'listing day', 'gmp', 'grey market', 'allotment', 'subscription'],
  GLOBAL:  ['us market', 'fed', 'federal reserve', 'china', 'europe', 'crude oil', 'brent', 'wti', 'dollar index', 'dxy', 'treasury', 'global market', 'dow jones', 'nasdaq', 's&p 500', 'nikkei', 'hang seng', 'ftse'],
  SECTOR:  ['sector', 'industry', 'banking', 'pharma', 'it sector', 'fmcg', 'auto sector', 'metal', 'realty', 'telecom', 'energy', 'infrastructure', 'chemical'],
  GENERAL: [],
};

const HIGH_IMPACT_KEYWORDS = [
  'rbi policy', 'repo rate', 'budget', 'sebi', 'upper circuit', '52-week high', 'all-time high',
  'result season', 'q4 results', 'nifty', 'sensex', 'fed rate', 'crude oil', 'rupee',
];

// ─── Sector keyword → sector name mapping ─────────────────────────────────────

const SECTOR_KEYWORDS: Record<string, string> = {
  'banking': 'Banking', 'bank': 'Banking', 'nbfc': 'Banking',
  'pharma': 'Pharmaceuticals', 'drug': 'Pharmaceuticals',
  'it ': 'IT', 'software': 'IT', 'tech': 'IT',
  'auto': 'Automobiles', 'ev': 'Automobiles', 'electric vehicle': 'Automobiles',
  'fmcg': 'FMCG', 'consumer': 'FMCG',
  'metal': 'Metals', 'steel': 'Metals', 'aluminium': 'Metals',
  'realty': 'Real Estate', 'real estate': 'Real Estate', 'housing': 'Real Estate',
  'chemical': 'Chemicals', 'speciality chemical': 'Chemicals',
  'telecom': 'Telecom',
  'oil': 'Oil & Gas', 'gas': 'Oil & Gas', 'refinery': 'Oil & Gas',
  'cement': 'Cement',
  'infra': 'Infrastructure', 'construction': 'Infrastructure', 'highway': 'Infrastructure',
  'power': 'Power', 'energy': 'Power', 'solar': 'Power', 'renewable': 'Power',
  'media': 'Media', 'entertainment': 'Media',
};

// ─── RSS XML Parser ───────────────────────────────────────────────────────────

interface RawNewsItem { title: string; link: string; pubDate: string; description: string }

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractCdata(block: string, tag: string): string {
  const cdataRe = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plainRe  = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = cdataRe.exec(block) || plainRe.exec(block);
  return m ? stripHtml(m[1].trim()) : '';
}

function parseRSS(xml: string): RawNewsItem[] {
  const items: RawNewsItem[] = [];
  const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of matches) {
    const block = m[1];
    const title       = extractCdata(block, 'title');
    const link        = extractCdata(block, 'link') || extractCdata(block, 'guid');
    const pubDate     = extractCdata(block, 'pubDate') || extractCdata(block, 'dc:date');
    const description = extractCdata(block, 'description') || extractCdata(block, 'content:encoded');
    if (title) items.push({ title, link, pubDate, description });
  }
  return items;
}

// ─── Sentiment & Category Scoring ────────────────────────────────────────────

function scoreSentiment(text: string): { sentiment: NewsSentiment; score: number } {
  const t = text.toLowerCase();
  let bullishHits = 0, bearishHits = 0;

  for (const kw of BULLISH_KEYWORDS) if (t.includes(kw)) bullishHits++;
  for (const kw of BEARISH_KEYWORDS)  if (t.includes(kw)) bearishHits++;

  const total = bullishHits + bearishHits;
  if (total === 0) return { sentiment: 'NEUTRAL', score: 0 };

  const score = (bullishHits - bearishHits) / Math.max(total, 1);
  if (score > 0.15)  return { sentiment: 'BULLISH', score };
  if (score < -0.15) return { sentiment: 'BEARISH', score };
  return { sentiment: 'NEUTRAL', score };
}

function classifyCategory(text: string): NewsCategory {
  const t = text.toLowerCase();
  const categoryScores: Partial<Record<NewsCategory, number>> = {};

  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS) as [NewsCategory, string[]][]) {
    if (keywords.length === 0) continue;
    let hits = 0;
    for (const kw of keywords) if (t.includes(kw)) hits++;
    if (hits > 0) categoryScores[cat] = hits;
  }

  if (Object.keys(categoryScores).length === 0) return 'GENERAL';
  return (Object.entries(categoryScores) as [NewsCategory, number][])
    .sort((a, b) => b[1] - a[1])[0][0];
}

function detectImpact(text: string, sentiment_score: number): NewsImpact {
  const t = text.toLowerCase();
  const isHigh = HIGH_IMPACT_KEYWORDS.some(kw => t.includes(kw)) || Math.abs(sentiment_score) > 0.6;
  if (isHigh) return 'HIGH';
  if (Math.abs(sentiment_score) > 0.3) return 'MEDIUM';
  return 'LOW';
}

function detectSector(text: string): string | null {
  const t = text.toLowerCase();
  for (const [kw, sector] of Object.entries(SECTOR_KEYWORDS)) {
    if (t.includes(kw)) return sector;
  }
  return null;
}

function extractSymbols(text: string): string[] {
  const t = text.toUpperCase();
  // Load NSE symbols from DB (cached on first call)
  const symbols = getNSESymbols();
  return symbols.filter(sym => {
    // Match whole-word NSE symbols (e.g. "RELIANCE" not inside "RELIANCEIND")
    const re = new RegExp(`\\b${sym}\\b`);
    return re.test(t);
  }).slice(0, 5);
}

let _nseSymbolCache: string[] | null = null;
function getNSESymbols(): string[] {
  if (_nseSymbolCache) return _nseSymbolCache;
  try {
    const rows = db.prepare('SELECT symbol FROM nse_stocks WHERE status = ? LIMIT 2000').all('ACTIVE') as { symbol: string }[];
    _nseSymbolCache = rows.map(r => r.symbol);
  } catch {
    _nseSymbolCache = [];
  }
  return _nseSymbolCache;
}

// ─── Fetch Single Source ──────────────────────────────────────────────────────

async function fetchSource(source: NewsSource): Promise<RawNewsItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), source.timeout ?? 10000);
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BharatStock/1.0; +https://github.com)' },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSS(xml);
  } catch {
    return [];
  }
}

// ─── Main Fetch + Score Cycle ─────────────────────────────────────────────────

export async function runNewsSentimentCycle(): Promise<{
  fetched: number; inserted: number; updated: number;
}> {
  console.log('[SENTIMENT] Starting news fetch cycle...');

  const upsert = db.prepare(`
    INSERT INTO news_sentiment_items
      (id, title, summary, source, source_type, url, published_at,
       sentiment, sentiment_score, impact, category, symbols_json, sector)
    VALUES
      (@id, @title, @summary, @source, @source_type, @url, @published_at,
       @sentiment, @sentiment_score, @impact, @category, @symbols_json, @sector)
    ON CONFLICT(id) DO UPDATE SET
      sentiment=excluded.sentiment, sentiment_score=excluded.sentiment_score,
      impact=excluded.impact, category=excluded.category,
      symbols_json=excluded.symbols_json, sector=excluded.sector
  `);

  // Also sync to the legacy news_articles table for scoring engine compatibility
  const legacyUpsert = db.prepare(`
    INSERT OR REPLACE INTO news_articles
      (id, title, summary, source, sentiment, category, url, symbols, timestamp)
    VALUES
      (@id, @title, @summary, @source, @sentiment, @category, @url, @symbols, @timestamp)
  `);

  let fetched = 0, inserted = 0;

  // Fetch all sources in parallel (max 4 concurrent)
  const batchSize = 4;
  for (let i = 0; i < NEWS_SOURCES.length; i += batchSize) {
    const batch = NEWS_SOURCES.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(src =>
      fetchSource(src).then(items => ({ src, items }))
    ));

    db.transaction(() => {
      for (const { src, items } of results) {
        fetched += items.length;
        for (const raw of items.slice(0, 30)) {
          const text = `${raw.title} ${raw.description}`;
          const { sentiment, score } = scoreSentiment(text);
          const category = classifyCategory(text);
          const impact   = detectImpact(text, score);
          const sector   = detectSector(text);
          const symbols  = extractSymbols(text);

          const id = crypto
            .createHash('sha1')
            .update(`${src.name}:${raw.link || raw.title}`)
            .digest('hex');

          let pubAt: string | null = null;
          try { pubAt = raw.pubDate ? new Date(raw.pubDate).toISOString() : null; } catch { /* skip */ }

          upsert.run({
            id, title: raw.title.slice(0, 500),
            summary: raw.description.slice(0, 1000),
            source: src.name, source_type: src.type,
            url: raw.link?.slice(0, 500) ?? null,
            published_at: pubAt,
            sentiment, sentiment_score: score,
            impact, category,
            symbols_json: JSON.stringify(symbols),
            sector: sector ?? null,
          });

          // Legacy table (maps sentiment for Python scoring engine)
          const legacySentiment =
            sentiment === 'BULLISH' ? 'Positive' :
            sentiment === 'BEARISH' ? 'Negative' : 'Neutral';

          legacyUpsert.run({
            id, title: raw.title.slice(0, 500),
            summary: raw.description.slice(0, 500),
            source: src.name, sentiment: legacySentiment,
            category, url: raw.link?.slice(0, 500) ?? null,
            symbols: symbols.join(','),
            timestamp: pubAt ?? new Date().toISOString(),
          });

          inserted++;
        }
      }
    })();
  }

  // AI enrichment for HIGH-impact items not yet AI-scored
  const highImpact = db.prepare(`
    SELECT id, title, summary, category FROM news_sentiment_items
    WHERE impact = 'HIGH' AND ai_scored = 0
    ORDER BY fetched_at DESC LIMIT 10
  `).all() as { id: string; title: string; summary: string; category: string }[];

  if (highImpact.length > 0 && process.env.ANTHROPIC_API_KEY) {
    await enrichWithAI(highImpact);
  }

  // Build and store market sentiment snapshot
  await buildMarketSentimentSnapshot();

  console.log(`[SENTIMENT] Cycle done: fetched=${fetched}, processed=${inserted}`);
  return { fetched, inserted, updated: 0 };
}

// ─── AI Enrichment for High-Impact News ──────────────────────────────────────

async function enrichWithAI(items: { id: string; title: string; summary: string; category: string }[]) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  const markDone = db.prepare(`UPDATE news_sentiment_items SET ai_scored=1, sentiment=@sentiment, sentiment_score=@score, impact=@impact WHERE id=@id`);

  for (const item of items) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          messages: [{
            role: 'user',
            content: `Rate this Indian stock market news. Reply ONLY with JSON: {"sentiment":"BULLISH|BEARISH|NEUTRAL","score":-1.0_to_1.0,"impact":"HIGH|MEDIUM|LOW"}\n\nTitle: ${item.title}\nSummary: ${item.summary?.slice(0, 300) ?? ''}`,
          }],
        }),
      });
      const data = await resp.json() as { content?: { text?: string }[] };
      const text = data?.content?.[0]?.text?.trim() ?? '';
      const parsed = JSON.parse(text);
      markDone.run({
        id: item.id,
        sentiment: parsed.sentiment ?? 'NEUTRAL',
        score:     parsed.score     ?? 0,
        impact:    parsed.impact    ?? 'MEDIUM',
      });
      await new Promise(r => setTimeout(r, 200));
    } catch { /* skip on error */ }
  }
}

// ─── Market Sentiment Snapshot ────────────────────────────────────────────────

async function buildMarketSentimentSnapshot(): Promise<void> {
  // Last 4 hours of news
  const cutoff = toSqliteDateTime(new Date(Date.now() - 4 * 60 * 60 * 1000));
  const recent = db.prepare(`
    SELECT sentiment, sentiment_score, impact, category, sector, title
    FROM news_sentiment_items
    WHERE fetched_at >= ? ORDER BY fetched_at DESC LIMIT 200
  `).all(cutoff) as { sentiment: string; sentiment_score: number; impact: string; category: string; sector: string | null; title: string }[];

  if (recent.length === 0) return;

  let bullish = 0, bearish = 0, neutral = 0, highImpact = 0;
  let weightedScore = 0, totalWeight = 0;
  const themeMap: Record<string, number> = {};
  const sectorMap: Record<string, { bull: number; bear: number }> = {};

  for (const r of recent) {
    const w = r.impact === 'HIGH' ? 3 : r.impact === 'MEDIUM' ? 2 : 1;
    if (r.sentiment === 'BULLISH') { bullish++; weightedScore += w * Math.abs(r.sentiment_score); }
    else if (r.sentiment === 'BEARISH') { bearish++; weightedScore -= w * Math.abs(r.sentiment_score); }
    else neutral++;
    if (r.impact === 'HIGH') highImpact++;
    totalWeight += w;

    if (r.category && r.category !== 'GENERAL') {
      themeMap[r.category] = (themeMap[r.category] ?? 0) + 1;
    }
    if (r.sector) {
      if (!sectorMap[r.sector]) sectorMap[r.sector] = { bull: 0, bear: 0 };
      if (r.sentiment === 'BULLISH') sectorMap[r.sector].bull++;
      else if (r.sentiment === 'BEARISH') sectorMap[r.sector].bear++;
    }
  }

  const rawScore = totalWeight > 0 ? (weightedScore / totalWeight) * 100 : 0;
  const overallScore = Math.max(-100, Math.min(100, rawScore));

  const label =
    overallScore >= 50  ? 'Extreme Greed' :
    overallScore >= 20  ? 'Greed' :
    overallScore <= -50 ? 'Extreme Fear' :
    overallScore <= -20 ? 'Fear' : 'Neutral';

  // Nifty range from global market data
  let niftyClose: number | null = null;
  let niftySupport: number | null = null;
  let niftyResistance: number | null = null;
  let niftyBias = 'Neutral';
  let globalCue = 'Mixed';
  let globalScore = 0;

  try {
    const globalData = await fetchGlobalMarketData();
    const nifty = globalData.find(d =>
      d.symbol?.toLowerCase().includes('nifty') || d.country?.toLowerCase().includes('india')
    );
    if (nifty) {
      niftyClose = parseFloat(nifty.current_price?.replace(/,/g, '') ?? '0') || null;
    }

    // Global cue: average change% of US, Japan, HK, Europe indices
    const globalIndices = globalData.filter(d =>
      ['US', 'Japan', 'Hong Kong', 'Germany', 'UK', 'Singapore'].includes(d.country ?? '')
    );
    if (globalIndices.length > 0) {
      const changes = globalIndices
        .map(d => parseFloat(d.change_per?.replace('%', '') ?? '0'))
        .filter(v => !isNaN(v));
      globalScore = changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
      globalCue = globalScore > 0.3 ? 'Positive' : globalScore < -0.3 ? 'Negative' : 'Mixed';
    }
  } catch { /* non-critical */ }

  if (niftyClose && niftyClose > 0) {
    const combinedBias = overallScore * 0.4 + globalScore * 15;
    const atrEst = niftyClose * 0.008; // ~0.8% typical daily ATR
    niftySupport    = Math.round(niftyClose - atrEst * 1.2);
    niftyResistance = Math.round(niftyClose + atrEst * 1.2);
    niftyBias = combinedBias > 5 ? 'Bullish' : combinedBias < -5 ? 'Bearish' : 'Neutral';
  }

  const topThemes = Object.entries(themeMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  db.prepare(`
    INSERT INTO market_sentiment_snapshots
      (overall_score, overall_label, bullish_count, bearish_count, neutral_count,
       high_impact_count, nifty_bias, nifty_support, nifty_resistance, nifty_last_close,
       global_cue, global_score, key_themes_json, source_count)
    VALUES
      (@overall_score, @overall_label, @bullish_count, @bearish_count, @neutral_count,
       @high_impact_count, @nifty_bias, @nifty_support, @nifty_resistance, @nifty_last_close,
       @global_cue, @global_score, @key_themes_json, @source_count)
  `).run({
    overall_score: Math.round(overallScore * 10) / 10,
    overall_label: label,
    bullish_count: bullish, bearish_count: bearish, neutral_count: neutral,
    high_impact_count: highImpact,
    nifty_bias: niftyBias,
    nifty_support: niftySupport, nifty_resistance: niftyResistance,
    nifty_last_close: niftyClose,
    global_cue: globalCue, global_score: Math.round(globalScore * 100) / 100,
    key_themes_json: JSON.stringify(topThemes),
    source_count: recent.length,
  });

  // Purge snapshots older than 7 days
  db.prepare(`
    DELETE FROM market_sentiment_snapshots
    WHERE snapshot_at < datetime('now', '-7 days')
  `).run();
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

export function getLatestSentimentSnapshot(): MarketSentimentSnapshot | null {
  const row = db.prepare(`
    SELECT * FROM market_sentiment_snapshots ORDER BY snapshot_at DESC LIMIT 1
  `).get() as MarketSentimentSnapshot | null;
  if (row && row.snapshot_at) {
    row.snapshot_at = row.snapshot_at.replace(' ', 'T') + 'Z';
  }
  return row;
}

export function getSentimentHistory(hours = 24): MarketSentimentSnapshot[] {
  const cutoff = toSqliteDateTime(new Date(Date.now() - hours * 60 * 60 * 1000));
  const rows = db.prepare(`
    SELECT * FROM market_sentiment_snapshots
    WHERE snapshot_at >= ?
    ORDER BY snapshot_at ASC
  `).all(cutoff) as MarketSentimentSnapshot[];
  
  for (const r of rows) {
    if (r.snapshot_at) {
      r.snapshot_at = r.snapshot_at.replace(' ', 'T') + 'Z';
    }
  }
  return rows;
}

export function getNewsItems(opts: {
  limit?: number;
  category?: NewsCategory | 'ALL';
  sentiment?: NewsSentiment | 'ALL';
  sourceType?: 'INDIAN' | 'GLOBAL' | 'ALL';
  hours?: number;
} = {}): NewsItem[] {
  const { limit = 60, category = 'ALL', sentiment = 'ALL', sourceType = 'ALL', hours = 8 } = opts;
  const cutoff = toSqliteDateTime(new Date(Date.now() - hours * 60 * 60 * 1000));

  let query = `
    SELECT * FROM news_sentiment_items
    WHERE fetched_at >= ?
  `;
  const params: (string | number)[] = [cutoff];

  if (category !== 'ALL') { query += ` AND category = ?`; params.push(category); }
  if (sentiment !== 'ALL') { query += ` AND sentiment = ?`; params.push(sentiment); }
  if (sourceType !== 'ALL') { query += ` AND source_type = ?`; params.push(sourceType); }

  query += ` ORDER BY
    CASE impact WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
    published_at DESC
    LIMIT ?`;
  params.push(limit);

  return db.prepare(query).all(...params) as NewsItem[];
}

export function getSectorSentiment(): { sector: string; bullish: number; bearish: number; neutral: number; netScore: number }[] {
  const cutoff = toSqliteDateTime(new Date(Date.now() - 8 * 60 * 60 * 1000));
  const rows = db.prepare(`
    SELECT sector, sentiment, COUNT(*) as cnt
    FROM news_sentiment_items
    WHERE fetched_at >= ? AND sector IS NOT NULL AND sector != ''
    GROUP BY sector, sentiment
  `).all(cutoff) as { sector: string; sentiment: string; cnt: number }[];

  const bySection = new Map<string, { bullish: number; bearish: number; neutral: number }>();
  for (const r of rows) {
    if (!bySection.has(r.sector)) bySection.set(r.sector, { bullish: 0, bearish: 0, neutral: 0 });
    const s = bySection.get(r.sector)!;
    if (r.sentiment === 'BULLISH') s.bullish += r.cnt;
    else if (r.sentiment === 'BEARISH') s.bearish += r.cnt;
    else s.neutral += r.cnt;
  }

  return [...bySection.entries()]
    .map(([sector, counts]) => ({
      sector,
      ...counts,
      netScore: counts.bullish - counts.bearish,
    }))
    .sort((a, b) => Math.abs(b.netScore) - Math.abs(a.netScore));
}

export function getCorporateEventNews(): NewsItem[] {
  const cutoff = toSqliteDateTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
  return db.prepare(`
    SELECT * FROM news_sentiment_items
    WHERE fetched_at >= ?
      AND category IN ('EARNINGS', 'ORDER_WIN', 'BUYBACK', 'IPO')
    ORDER BY
      CASE impact WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
      published_at DESC
    LIMIT 50
  `).all(cutoff) as NewsItem[];
}
