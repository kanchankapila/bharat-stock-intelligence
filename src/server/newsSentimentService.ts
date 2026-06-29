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

import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';
import { rowGroups, bulkUpsert } from './dbBulk';
import crypto from 'crypto';
import { fetchGlobalMarketData } from './globalMarketService';
import {
  buildAliasIndex, extractSymbolsByName, companyAliases, NEWS_ALIAS_OVERRIDES, type AliasEntry,
} from './newsEntityTagger';

function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19);
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
  // Indian sources — verified working June 2026
  { name: 'ET Viewandrecofeed', url: 'https://economictimes.indiatimes.com/viewandrecofeed.cms', type: 'INDIAN' },
  { name: 'LiveMint Markets', url: 'https://www.livemint.com/rss/markets', type: 'INDIAN' },
  { name: 'LiveMint Companies', url: 'https://www.livemint.com/rss/companies', type: 'INDIAN' },
  { name: 'MoneyControl Latest', url: 'https://www.moneycontrol.com/rss/latestnews.xml', type: 'INDIAN' },
  { name: 'MoneyControl Markets', url: 'https://www.moneycontrol.com/rss/marketreports.xml', type: 'INDIAN' },
  { name: 'MoneyControl Business', url: 'https://www.moneycontrol.com/rss/business.xml', type: 'INDIAN' },
  { name: 'MoneyControl Economy', url: 'https://www.moneycontrol.com/rss/economy.xml', type: 'INDIAN' },
  { name: 'MoneyControl Mutual Funds', url: 'https://www.moneycontrol.com/rss/mfnews.xml', type: 'INDIAN' },
  { name: 'Hindu BusinessLine', url: 'https://www.thehindubusinessline.com/markets/?service=rss', type: 'INDIAN' },
  { name: 'Zee Business Markets', url: 'https://www.zeebiz.com/market-news/rss.xml', type: 'INDIAN' },
  { name: 'CNBC TV18 Markets', url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', type: 'INDIAN' },
  { name: 'Tradebrains', url: 'https://tradebrains.in/feed/', type: 'INDIAN' },
  { name: 'Google News India Markets', url: 'https://news.google.com/rss/search?q=Indian+stock+market+NSE+BSE&hl=en-IN&gl=IN&ceid=IN:en', type: 'INDIAN' },
  { name: 'Google News NIFTY', url: 'https://news.google.com/rss/search?q=NIFTY+SENSEX+trading&hl=en-IN&gl=IN&ceid=IN:en', type: 'INDIAN' },
  // Global sources — verified working June 2026
  { name: 'Financial Times', url: 'https://www.ft.com/rss/home/uk', type: 'GLOBAL', timeout: 8000 },
  // Dead as of June 2026 — removed:
  // Economic Times markets/economy RSS (return HTML not XML)
  // Business Standard RSS (403 Forbidden)
  // NDTV Profit feedburner (403 Forbidden)
  // Financial Express markets feed (returns HTML)
  // Yahoo Finance India RSS (500 Internal Server Error)
  // Reuters RSS feeds.reuters.com (domain connection error)
  // MoneyControl Broker Research (503)
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
  // Match company NAMES (+ curated short forms), not tickers — prose says "Infosys",
  // never "INFY". See newsEntityTagger.
  return extractSymbolsByName(text, _aliasIndex ?? []);
}

let _aliasIndex: AliasEntry[] | null = null;
async function ensureNSESymbols(): Promise<void> {
  if (_aliasIndex) return;
  try {
    const rows = await dbAll(
      'SELECT symbol, name FROM nse_stocks WHERE status = ? AND name IS NOT NULL LIMIT 2500',
      ['ACTIVE'],
    ) as { symbol: string; name: string }[];
    _aliasIndex = buildAliasIndex(rows, NEWS_ALIAS_OVERRIDES);
  } catch {
    _aliasIndex = [];
  }
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

/** Score one raw article and stage its sentiment + legacy rows (deduped by id).
 *  `forceSymbol` (company-targeted feeds) is unioned with name-tagged co-mentions. */
function processNewsItem(
  raw: RawNewsItem, srcName: string, srcType: string,
  sentRows: Map<string, unknown[]>, legacyRows: Map<string, unknown[]>,
  forceSymbol?: string,
): void {
  const text = `${raw.title} ${raw.description}`;
  const { sentiment, score } = scoreSentiment(text);
  const category = classifyCategory(text);
  const impact   = detectImpact(text, score);
  const sector   = detectSector(text);
  const symbols  = forceSymbol
    ? Array.from(new Set([forceSymbol, ...extractSymbols(text)])).slice(0, 5)
    : extractSymbols(text);

  const id = crypto.createHash('sha1').update(`${srcName}:${raw.link || raw.title}`).digest('hex');

  let pubAt: string | null = null;
  try { pubAt = raw.pubDate ? new Date(raw.pubDate).toISOString() : null; } catch { /* skip */ }

  sentRows.set(id, [
    id, raw.title.slice(0, 500), raw.description.slice(0, 1000),
    srcName, srcType, raw.link?.slice(0, 500) ?? null, pubAt,
    sentiment, score, impact, category, JSON.stringify(symbols), sector ?? null,
  ]);

  const legacySentiment =
    sentiment === 'BULLISH' ? 'Positive' : sentiment === 'BEARISH' ? 'Negative' : 'Neutral';
  legacyRows.set(id, [
    id, raw.title.slice(0, 500), raw.description.slice(0, 500),
    srcName, legacySentiment, category, raw.link?.slice(0, 500) ?? null,
    symbols.join(','), pubAt ?? new Date().toISOString(),
  ]);
}

/** Bulk-upsert staged sentiment + legacy rows in one transaction. */
async function persistNewsRows(
  sentRows: Map<string, unknown[]>, legacyRows: Map<string, unknown[]>,
): Promise<void> {
  await dbTransaction(async (tx) => {
    await bulkUpsert(tx, [...sentRows.values()], 13,
      n => `INSERT INTO news_sentiment_items
        (id, title, summary, source, source_type, url, published_at,
         sentiment, sentiment_score, impact, category, symbols_json, sector)
        VALUES ${rowGroups(n, 13)}
        ON CONFLICT(id) DO UPDATE SET
          sentiment=excluded.sentiment, sentiment_score=excluded.sentiment_score,
          impact=excluded.impact, category=excluded.category,
          symbols_json=excluded.symbols_json, sector=excluded.sector`);

    await bulkUpsert(tx, [...legacyRows.values()], 9,
      n => `INSERT INTO news_articles
        (id, title, summary, source, sentiment, category, url, symbols, timestamp)
        VALUES ${rowGroups(n, 9)}
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, summary=excluded.summary, source=excluded.source,
          sentiment=excluded.sentiment, category=excluded.category, url=excluded.url,
          symbols=excluded.symbols, timestamp=excluded.timestamp`);
  });
}

// ─── Per-Company News (Google News RSS — free, no key, inherently per-stock) ───

/** Google News RSS search scoped to one company (India edition, last ~7 days). */
function googleNewsUrl(companyName: string): string {
  const q = encodeURIComponent(`"${companyName}" when:7d`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
}

/**
 * Fetch per-company news for the most liquid names — the universe that actually
 * generates signals — giving dense, correctly-attributed per-stock coverage that
 * market-wide RSS cannot. Each article is force-tagged to its query symbol.
 * Slow cadence (schedule ~6-hourly); concurrency-limited to be polite to Google.
 */
export async function runCompanyNewsCycle(limit = 150): Promise<{ companies: number; inserted: number }> {
  const universe = await dbAll(
    `SELECT ns.symbol, ns.name FROM nse_stocks ns
     JOIN stock_fundamentals sf ON sf.symbol = ns.symbol
     WHERE ns.status = 'ACTIVE' AND ns.name IS NOT NULL AND sf.market_cap IS NOT NULL
     ORDER BY sf.market_cap DESC LIMIT ?`, [limit],
  ) as { symbol: string; name: string }[];
  if (universe.length === 0) return { companies: 0, inserted: 0 };

  await ensureNSESymbols();
  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();

  const BATCH = 4;
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ symbol, name }) => {
      const cleaned = companyAliases(name)[0] ?? name;
      const items = await fetchSource({ name: `GoogleNews:${symbol}`, url: googleNewsUrl(cleaned), type: 'INDIAN' });
      for (const raw of items.slice(0, 8)) {
        processNewsItem(raw, 'Google News', 'INDIAN', sentRows, legacyRows, symbol);
      }
    }));
    await new Promise(r => setTimeout(r, 250)); // gentle pacing
  }

  if (sentRows.size > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] Company-news cycle: ${universe.length} companies → ${sentRows.size} articles`);
  return { companies: universe.length, inserted: sentRows.size };
}

// ─── BSE Corporate Announcements (free, per-stock, structured, historical) ────

interface BseAnnouncement {
  NEWSID: string; SLONGNAME: string; HEADLINE: string; NEWSSUB: string;
  CATEGORYNAME: string; SUBCATNAME: string; CRITICALNEWS: number;
  NEWS_DT: string; NSURL: string; ATTACHMENTNAME: string;
}

// BSE returns results only when strPrevDate == strToDate (single-day query).
async function fetchBseDay(ymd: string, maxPages = 5): Promise<BseAnnouncement[]> {
  const out: BseAnnouncement[] = [];
  for (let pg = 1; pg <= maxPages; pg++) {
    const url = `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=${pg}`
      + `&strCat=-1&strPrevDate=${ymd}&strScrip=&strSearch=P&strToDate=${ymd}&strType=C`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://www.bseindia.com/', 'Accept': 'application/json',
        },
      });
      clearTimeout(timer);
      if (!res.ok) break;
      const j = await res.json() as { Table?: BseAnnouncement[] };
      const t = j.Table ?? [];
      out.push(...t);
      if (t.length === 0) break;
    } catch { break; }
    await new Promise(r => setTimeout(r, 200));
  }
  return out;
}

/**
 * Ingest BSE corporate announcements (board meetings, results, orders, pledges,
 * ratings) for the last 2 days. Inherently per-stock and high-signal; mapped to
 * NSE symbols by company name. Schedule hourly.
 */
export async function runBseAnnouncementsCycle(): Promise<{ fetched: number; inserted: number }> {
  await ensureNSESymbols();
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const now = new Date();
  // Query today + yesterday separately (BSE only accepts single-day windows).
  const anns = [
    ...await fetchBseDay(ymd(now)),
    ...await fetchBseDay(ymd(new Date(now.getTime() - 864e5))),
  ];
  if (anns.length === 0) return { fetched: 0, inserted: 0 };

  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();
  for (const a of anns) {
    const company = (a.SLONGNAME ?? '').trim();
    const syms = extractSymbols(company);              // map company name → NSE symbol
    if (syms.length === 0) continue;                   // BSE-only / unmapped name — skip
    const cat = `${a.CATEGORYNAME ?? ''} ${a.SUBCATNAME ?? ''}`.trim();
    const raw: RawNewsItem = {
      title: `${company}: ${cat}`.slice(0, 300),
      description: (a.HEADLINE || a.NEWSSUB || cat).slice(0, 1000),
      link: a.NSURL || `https://www.bseindia.com/corporates/ann.html?newsid=${a.NEWSID}`,
      pubDate: a.NEWS_DT,
    };
    processNewsItem(raw, 'BSE Announcements', 'INDIAN', sentRows, legacyRows, syms[0]);
  }

  if (sentRows.size > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] BSE announcements: ${anns.length} fetched → ${sentRows.size} mapped to NSE symbols`);
  return { fetched: anns.length, inserted: sentRows.size };
}

// ─── Main Fetch + Score Cycle ─────────────────────────────────────────────────

export async function runNewsSentimentCycle(): Promise<{
  fetched: number; inserted: number; updated: number;
}> {
  console.log('[SENTIMENT] Starting news fetch cycle...');
  await ensureNSESymbols();

  // Collect+dedupe by id, then bulk-upsert. Dedupe is required because the same
  // article (same link) can appear across sources — a multi-row ON CONFLICT that
  // touched a key twice would error on Postgres ("cannot affect row a second time").
  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();
  let fetched = 0;

  // Fetch all sources in parallel (max 4 concurrent)
  const batchSize = 4;
  for (let i = 0; i < NEWS_SOURCES.length; i += batchSize) {
    const batch = NEWS_SOURCES.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(src =>
      fetchSource(src).then(items => ({ src, items }))
    ));

    for (const { src, items } of results) {
      fetched += items.length;
      for (const raw of items.slice(0, 30)) {
        processNewsItem(raw, src.name, src.type, sentRows, legacyRows);
      }
    }
  }

  const inserted = sentRows.size;

  await persistNewsRows(sentRows, legacyRows);

  // AI enrichment for HIGH-impact items not yet AI-scored
  const highImpact = await dbAll(`
    SELECT id, title, summary, category FROM news_sentiment_items
    WHERE impact = 'HIGH' AND ai_scored = 0
    ORDER BY fetched_at DESC LIMIT 10
  `) as { id: string; title: string; summary: string; category: string }[];

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

  const markDoneSql = `UPDATE news_sentiment_items SET ai_scored=1, sentiment=?, sentiment_score=?, impact=? WHERE id=?`;

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
      await dbRun(markDoneSql, [
        parsed.sentiment ?? 'NEUTRAL',
        parsed.score     ?? 0,
        parsed.impact    ?? 'MEDIUM',
        item.id,
      ]);
      await new Promise(r => setTimeout(r, 200));
    } catch { /* skip on error */ }
  }
}

// ─── Market Sentiment Snapshot ────────────────────────────────────────────────

async function buildMarketSentimentSnapshot(): Promise<void> {
  // Last 4 hours of news
  const cutoff = toSqliteDateTime(new Date(Date.now() - 4 * 60 * 60 * 1000));
  const recent = await dbAll(`
    SELECT sentiment, sentiment_score, impact, category, sector, title
    FROM news_sentiment_items
    WHERE fetched_at >= ? ORDER BY fetched_at DESC LIMIT 200
  `, [cutoff]) as { sentiment: string; sentiment_score: number; impact: string; category: string; sector: string | null; title: string }[];

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

  await dbRun(`
    INSERT INTO market_sentiment_snapshots
      (overall_score, overall_label, bullish_count, bearish_count, neutral_count,
       high_impact_count, nifty_bias, nifty_support, nifty_resistance, nifty_last_close,
       global_cue, global_score, key_themes_json, source_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    Math.round(overallScore * 10) / 10,
    label,
    bullish, bearish, neutral,
    highImpact,
    niftyBias,
    niftySupport, niftyResistance,
    niftyClose,
    globalCue, Math.round(globalScore * 100) / 100,
    JSON.stringify(topThemes),
    recent.length,
  ]);

  // Purge snapshots older than 7 days
  await dbRun(`
    DELETE FROM market_sentiment_snapshots
    WHERE snapshot_at < datetime('now', '-7 days')
  `);
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

export async function getLatestSentimentSnapshot(): Promise<MarketSentimentSnapshot | null> {
  return await dbGet(`
    SELECT * FROM market_sentiment_snapshots ORDER BY snapshot_at DESC LIMIT 1
  `) as MarketSentimentSnapshot | null;
}

export async function getSentimentHistory(hours = 24): Promise<MarketSentimentSnapshot[]> {
  const cutoff = toSqliteDateTime(new Date(Date.now() - hours * 60 * 60 * 1000));
  return await dbAll(`
    SELECT * FROM market_sentiment_snapshots
    WHERE snapshot_at >= ?
    ORDER BY snapshot_at ASC
  `, [cutoff]) as MarketSentimentSnapshot[];
}

export async function getNewsItems(opts: {
  limit?: number;
  category?: NewsCategory | 'ALL';
  sentiment?: NewsSentiment | 'ALL';
  sourceType?: 'INDIAN' | 'GLOBAL' | 'ALL';
  hours?: number;
} = {}): Promise<NewsItem[]> {
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

  return await dbAll(query, params) as NewsItem[];
}

export async function getSectorSentiment(): Promise<{ sector: string; bullish: number; bearish: number; neutral: number; netScore: number }[]> {
  const cutoff = toSqliteDateTime(new Date(Date.now() - 8 * 60 * 60 * 1000));
  const rows = await dbAll(`
    SELECT sector, sentiment, COUNT(*) as cnt
    FROM news_sentiment_items
    WHERE fetched_at >= ? AND sector IS NOT NULL AND sector != ''
    GROUP BY sector, sentiment
  `, [cutoff]) as { sector: string; sentiment: string; cnt: number }[];

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

export async function getCorporateEventNews(): Promise<NewsItem[]> {
  const cutoff = toSqliteDateTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
  return await dbAll(`
    SELECT * FROM news_sentiment_items
    WHERE fetched_at >= ?
      AND category IN ('EARNINGS', 'ORDER_WIN', 'BUYBACK', 'IPO')
    ORDER BY
      CASE impact WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
      published_at DESC
    LIMIT 50
  `, [cutoff]) as NewsItem[];
}
