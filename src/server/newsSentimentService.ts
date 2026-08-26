/**
 * News Sentiment Service
 *
 * Fetches financial news from multiple Indian + global RSS sources every 15 minutes.
 * Scores each article for: sentiment (BULLISH/BEARISH/NEUTRAL), impact (HIGH/MEDIUM/LOW),
 * and category (EARNINGS/ORDER_WIN/BUYBACK/POLICY/IPO/GLOBAL/SECTOR/GENERAL).
 * Aggregates into a market sentiment snapshot and Nifty range prediction.
 *
 * Sources (Indian): Economic Times, LiveMint, CNBC TV18, Zee Business, The Hindu BusinessLine, Tradebrains
 * Sources (Global): Financial Times, CNBC TV18 World, MarketWatch, Yahoo Finance (via globalMarketService)
 *
 * MoneyControl's own rss.moneycontrol.com/* feeds (latestnews/buzzingstocks/brokeragerecos/
 * economy/marketreports/internationalmarkets) are NOT used here as of 2026-08-05 -- all 6 were
 * live-verified to return HTTP 200 with content frozen since Feb-Aug 2024 (confirmed via
 * Last-Modified headers, cross-checked against a genuinely live feed on the same code path
 * to rule out a caching artifact). Akamai's edge serves the stale snapshot indefinitely with
 * a misleading `Cache-Control: max-age=30`. See the "Dead as of Aug 2026" note below before
 * re-adding any moneycontrol.com/rss/* URL -- verify Last-Modified first, don't trust 200 OK.
 */

import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';
import { rowGroups, bulkUpsert } from './dbBulk';
import crypto from 'crypto';
import { fetchGlobalMarketData } from './globalMarketService';
import { runPython } from './pythonRunner';
import {
  buildAliasIndex, extractSymbolsByName, companyAliases, NEWS_ALIAS_OVERRIDES, type AliasEntry,
} from './newsEntityTagger';
import { resolveMoneycontrolSymbol, getStockMapping } from './stockMapping';
import { fetchMcStockNews, fetchMcEarningsNews, fetchMcDealsNews } from './mcApiService';

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
  { name: 'LiveMint Markets', url: 'https://www.livemint.com/rss/markets', type: 'INDIAN' },
  { name: 'LiveMint Companies', url: 'https://www.livemint.com/rss/companies', type: 'INDIAN' },
  { name: 'Hindu BusinessLine', url: 'https://www.thehindubusinessline.com/markets/?service=rss', type: 'INDIAN' },
  { name: 'Zee Business Markets', url: 'https://www.zeebiz.com/market-news/rss.xml', type: 'INDIAN' },
  { name: 'CNBC TV18 Markets', url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', type: 'INDIAN' },
  { name: 'Tradebrains', url: 'https://tradebrains.in/feed/', type: 'INDIAN' },
  { name: 'Google News India Markets', url: 'https://news.google.com/rss/search?q=Indian+stock+market+NSE+BSE&hl=en-IN&gl=IN&ceid=IN:en', type: 'INDIAN' },
  { name: 'Google News NIFTY', url: 'https://news.google.com/rss/search?q=NIFTY+SENSEX+trading&hl=en-IN&gl=IN&ceid=IN:en', type: 'INDIAN' },
  // Added 2026-08-05 — live-verified fresh (real same-day pubDate) as replacements for the dead
  // MoneyControl family below. High-frequency (items land within minutes of fetch), so these
  // fit the flat 15-min NEWS_SOURCES cadence same as the sources they replace.
  { name: 'ET Top Stories', url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', type: 'INDIAN' }, // MoneyControl Latest replacement
  { name: 'ET Stocks in News', url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146843.cms', type: 'INDIAN' }, // MoneyControl Buzzing Stocks replacement
  { name: 'CNBC TV18 Business', url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml', type: 'INDIAN' }, // MoneyControl Markets/Business replacement
  // Global sources — verified working June 2026
  { name: 'Financial Times', url: 'https://www.ft.com/rss/home/uk', type: 'GLOBAL', timeout: 8000 },
  // Added 2026-08-05 — live-verified fresh, MoneyControl Global Markets replacement.
  { name: 'CNBC TV18 World', url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/world.xml', type: 'GLOBAL' },
  { name: 'MarketWatch Top Stories', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', type: 'GLOBAL', timeout: 8000 },
  // Dead as of June 2026 — removed:
  // Economic Times markets/economy RSS (return HTML not XML)
  // Business Standard RSS (403 Forbidden)
  // NDTV Profit feedburner (403 Forbidden)
  // Financial Express markets feed (returns HTML)
  // Yahoo Finance India RSS (500 Internal Server Error)
  // Reuters RSS feeds.reuters.com (domain connection error)
  // MoneyControl Broker Research (503)
  // Dead as of Aug 2026 — removed (live-verified 2026-08-05, not just "used to fail" —
  // all 6 return HTTP 200 with Last-Modified frozen between Feb and Aug 2024, over a year
  // stale, cross-checked against a genuinely live feed on the identical fetch path to rule
  // out a sandbox/proxy caching artifact):
  //   MoneyControl Latest       (rss/latestnews.xml)         Last-Modified 2024-08-26
  //   MoneyControl Markets      (rss/marketreports.xml)      Last-Modified 2024-06-03
  //   MoneyControl Business     (rss/business.xml)           Last-Modified 2024-06-03
  //   MoneyControl Economy      (rss/economy.xml)            Last-Modified 2024-06-03
  //   MoneyControl Mutual Funds (rss/mfnews.xml)              Last-Modified 2024-02-19
  //   MoneyControl Buzzing Stocks / Brokerage Recos / Global Markets — never added; the same
  //   dead RSS family (buzzingstocks.xml/brokeragerecos.xml/internationalmarkets.xml all
  //   Last-Modified 2024-06-03), confirmed at request time before wiring anything in.
  //   ET Viewandrecofeed (viewandrecofeed.cms) — removed 2026-08-05. Not RSS at all: it's
  //   ET's NewsML export (`<NewsML><articlelistroot><sec><stry><stname>...`), structurally
  //   incompatible with parseRSS()'s `<item>...</item>` matcher (0 matches, always) — a
  //   different failure mode from the CDATA-whitespace bug fixed the same day (see
  //   extractCdata's comment above), but the same net effect: zero rows, forever, silently
  //   (no error — parseRSS just returns []). Superseded by 'ET Top Stories'/'ET Stocks in
  //   News' above, which are real RSS and live-verified working.
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
  // \s* around the CDATA markers -- some feeds (ET's RSS family confirmed 2026-08-05) emit
  // `]]> </tag>` with a stray space/newline before the closing tag. A strict `]]></tag>`
  // match then misses, falls through to plainRe, and plainRe's raw (unstripped) capture --
  // literal `<![CDATA[...]]>` markers still in the string -- gets destroyed by stripHtml's
  // `<[^>]*>` below: it spans from the leading `<` of `<![CDATA[` all the way to the `>` in
  // `]]>`, silently wiping the entire title/description to '' with no error anywhere. An
  // empty title then fails parseRSS's `if (title) items.push(...)` check, so the article is
  // just dropped -- this is why `ET Viewandrecofeed` had zero rows in production despite
  // being fetched successfully on every single 15-min cycle since it was added.
  const cdataRe = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
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

// ─── MoneyControl per-stock news (genuinely live — no publish-delay caveat) ───
// Reuses the same fetchMcStockNews()/resolveMoneycontrolSymbol() this codebase already proved
// working for the per-stock news tab (McNewsCard.tsx, 2026-07-31) — MC's own news feed, not the
// market-wide MoneyControl RSS feeds already in NEWS_SOURCES above (those cover MC's homepage/
// section feeds; this is the per-scId `techmvc/mc_apis/mc_pricechart_homepage/news` endpoint,
// force-tagged to its query symbol the same way BSE/Google News already are). Unlike GNews,
// there is no metered daily quota here -- `mcFetchJson`'s own Semaphore already throttles
// concurrency platform-wide, so this can run denser/more often without a separate rate budget.
const MC_NEWS_STOCKS_TRACKED = 100;
const MC_NEWS_BATCH = 8; // matches mcFetchJson's own concurrency ceiling elsewhere in the app

export async function runMcStockNewsCycle(limit = MC_NEWS_STOCKS_TRACKED): Promise<{ companies: number; inserted: number }> {
  const universe = await dbAll(
    `SELECT ns.symbol FROM nse_stocks ns
     JOIN stock_fundamentals sf ON sf.symbol = ns.symbol
     WHERE ns.status = 'ACTIVE' AND sf.market_cap IS NOT NULL
     ORDER BY sf.market_cap DESC LIMIT ?`, [limit],
  ) as { symbol: string }[];
  if (universe.length === 0) return { companies: 0, inserted: 0 };

  await ensureNSESymbols();
  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();

  for (let i = 0; i < universe.length; i += MC_NEWS_BATCH) {
    const batch = universe.slice(i, i + MC_NEWS_BATCH);
    await Promise.all(batch.map(async ({ symbol }) => {
      try {
        const scId = await resolveMoneycontrolSymbol(symbol);
        if (!scId) return;
        const res = await fetchMcStockNews(scId, symbol);
        if (res.status !== 'ok') return; // 'no_news'/'fetch_failed' both legitimately skip
        for (const item of res.news.slice(0, 8)) {
          if (!item.posturl) continue; // no link -> no stable dedup id
          const epoch = Number(item.creation_date_epoch || item.update_date_epoch);
          const pubDate = epoch ? new Date(epoch * 1000).toISOString() : '';
          processNewsItem(
            { title: item.heading, description: item.summary, link: item.posturl, pubDate },
            'MoneyControl Stock News', 'INDIAN', sentRows, legacyRows, symbol,
          );
        }
      } catch { /* one bad stock must not abort the batch */ }
    }));
  }

  if (sentRows.size > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] MC stock-news cycle: ${universe.length} companies → ${sentRows.size} articles`);
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

// Minimum count of stocks reporting results within RESULTS_SEASON_WINDOW_DAYS to consider
// "results season" active -- results-day board-meeting announcements are the most
// price-sensitive BSE filings, and an hourly poll can sit on one for up to 59 minutes.
// Tightened to a 2nd (~30-min effective) cadence only in these weeks; quiet weeks stay hourly.
const RESULTS_SEASON_MIN_STOCKS = 30;
const RESULTS_SEASON_WINDOW_DAYS = 3;

/** True when enough stocks have results due imminently to justify a tighter BSE-announcements
 * poll (days_to_next_results is refreshed daily by mc_earnings_fetcher.py). Best-effort: any
 * query failure (e.g. column not backfilled yet) defaults to "not results season" -- quiet
 * cadence is the safe default, not the tight one. */
export async function isResultsSeasonActive(): Promise<boolean> {
  try {
    const row = await dbGet<{ n: number }>(
      `SELECT COUNT(DISTINCT symbol) as n FROM technical_signals
       WHERE days_to_next_results BETWEEN 0 AND ?
         AND date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = technical_signals.symbol)`,
      [RESULTS_SEASON_WINDOW_DAYS],
    );
    return (row?.n ?? 0) >= RESULTS_SEASON_MIN_STOCKS;
  } catch {
    return false;
  }
}

/**
 * Ingest BSE corporate announcements (board meetings, results, orders, pledges,
 * ratings) for the last 2 days. Inherently per-stock and high-signal; mapped to
 * NSE symbols by company name. Schedule hourly (plus a results-season-gated
 * 2nd pass -- see isResultsSeasonActive()).
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

// ─── GNews (gnews.io — structured JSON, needs GNEWS_API_KEY) ──────────────────
// A 4th source tier, split into 3 independently-scheduled cycles rather than one flat job,
// because "market", "stock", and "global" news genuinely warrant different cadences -- market-
// moving and per-stock news are what actually feeds trading decisions and go stale fast, while
// world business headlines are slower-moving macro context. Each is entity-tagged by the same
// name-based tagger the RSS sources use (GNews doesn't identify the stock any more than an RSS
// feed does). Gated on GNEWS_API_KEY -- no key means a silent no-op on all 3, the same pattern
// this file already uses for ANTHROPIC_API_KEY-gated enrichWithAI below.
//
// Also gated on app_settings.gnews_enabled, DEFAULT OFF -- live-verified 2026-08-04 that GNews's
// own free-tier response carries `information.realTimeArticles: "Real-time news data is only
// available on paid plans. Free plan has a 12-hour delay."`. That is a materially different
// freshness guarantee than every other source in this file (RSS lags ~15-30min, MC stock news
// and BSE announcements are live) and would be misleading to present as "live" market/stock
// news without an explicit opt-in. Flip on with:
//   UPDATE app_settings SET value='true' WHERE key='gnews_enabled' (insert if missing)
// -- same escape-hatch pattern as edge_adjustment_enabled elsewhere in this codebase.
//
// Free tier is also only 100 req/day and (unlike free/uncapped RSS) every call spends metered
// quota, so the 3 cycles' cadences were chosen to add up to a fraction of that budget, not to
// each be "as fresh as possible" independently:
//   market  (business headlines + NSE/BSE/Nifty/Sensex search, 2 calls) every 2h  -> 24 req/day
//   stocks  (1 OR-joined search over a rotating batch of top-cap names) every 1h  -> 24 req/day
//   global  (world business headlines, 1 call)                          every 6h  ->  4 req/day
// Total 52 req/day, leaving ~48/day headroom for manual testing/retries (see queues.ts).

interface GNewsArticle {
  title: string;
  description?: string;
  url: string;
  publishedAt: string;
  source?: { name: string; url?: string };
}

const GNEWS_BASE = 'https://gnews.io/api/v4';
const GNEWS_ENABLED_SETTING = 'gnews_enabled';

async function isGNewsEnabled(): Promise<boolean> {
  try {
    const row = await dbGet<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = ?", [GNEWS_ENABLED_SETTING],
    );
    return !!row && ['1', 'true', 'yes'].includes(String(row.value).toLowerCase());
  } catch {
    return false; // DB error -> fail closed, same posture as every other kill-switch here
  }
}

/** Shared guard for all 3 GNews cycles: needs both a real API key AND the explicit
 *  app_settings opt-in (default off — see the 12-hour-delay note above). Returns the
 *  skip reason so callers can log which gate actually blocked the run. */
async function gnewsGateReason(): Promise<string | null> {
  if (!process.env.GNEWS_API_KEY) return 'GNEWS_API_KEY not set';
  if (!(await isGNewsEnabled())) return "disabled (app_settings.gnews_enabled != 'true' — free tier is 12h-delayed, opt in explicitly)";
  return null;
}

async function fetchGNews(path: 'top-headlines' | 'search', params: Record<string, string>): Promise<GNewsArticle[]> {
  const apiKey = process.env.GNEWS_API_KEY;
  if (!apiKey) return [];
  const qs = new URLSearchParams({ lang: 'en', max: '10', ...params, apikey: apiKey });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${GNEWS_BASE}/${path}?${qs.toString()}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      // Never log the querystring -- it carries the API key.
      console.warn(`[SENTIMENT] GNews ${path} (${params.category ?? params.q}) failed: HTTP ${res.status}`);
      return [];
    }
    const j = await res.json() as { articles?: GNewsArticle[] };
    return j.articles ?? [];
  } catch (e) {
    console.warn(`[SENTIMENT] GNews ${path} fetch error:`, (e as Error).message);
    return [];
  }
}

function gnewsToRaw(a: GNewsArticle): RawNewsItem {
  return { title: a.title ?? '', link: a.url, pubDate: a.publishedAt, description: a.description ?? '' };
}

function gnewsTag(
  arts: GNewsArticle[], srcName: string, srcType: 'INDIAN' | 'GLOBAL',
  sentRows: Map<string, unknown[]>, legacyRows: Map<string, unknown[]>,
  forceSymbol?: (a: GNewsArticle) => string | undefined,
): number {
  let n = 0;
  for (const a of arts) {
    if (!a.url) continue; // no link -> no stable dedup id, skip
    n++;
    processNewsItem(gnewsToRaw(a), srcName, srcType, sentRows, legacyRows, forceSymbol?.(a));
  }
  return n;
}

/** India business headlines + an NSE/BSE/Nifty/Sensex search -- market-moving news, the most
 *  time-sensitive of the 3 cycles. 2 calls, paced (not Promise.all) -- live-verified 2026-08-04:
 *  3 concurrent GNews calls got 2x HTTP 429 on the free tier (a burst/concurrency limit, not
 *  the 100/day quota -- a lone call immediately afterward succeeded fine), so these must be
 *  paced like this codebase's other rate-limited sources (BSE/Google News above use 200-250ms). */
export async function runGNewsMarketCycle(): Promise<{ fetched: number; inserted: number; skipped?: boolean }> {
  const skipReason = await gnewsGateReason();
  if (skipReason) {
    console.log(`[SENTIMENT] GNews market cycle skipped — ${skipReason}`);
    return { fetched: 0, inserted: 0, skipped: true };
  }
  await ensureNSESymbols();

  const indiaBiz = await fetchGNews('top-headlines', { category: 'business', country: 'in' });
  await new Promise(r => setTimeout(r, 1200));
  const indiaMarket = await fetchGNews('search', { q: 'NSE OR BSE OR Nifty OR Sensex OR "Indian stock market"', country: 'in' });

  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();
  const fetched = gnewsTag(indiaBiz, 'GNews India', 'INDIAN', sentRows, legacyRows)
                + gnewsTag(indiaMarket, 'GNews Market', 'INDIAN', sentRows, legacyRows);

  const inserted = sentRows.size;
  if (inserted > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] GNews market cycle: fetched=${fetched}, processed=${inserted}`);
  return { fetched, inserted };
}

/** World business headlines -- slower-moving macro context, not stock/market-specific. 1 call. */
export async function runGNewsGlobalCycle(): Promise<{ fetched: number; inserted: number; skipped?: boolean }> {
  const skipReason = await gnewsGateReason();
  if (skipReason) {
    console.log(`[SENTIMENT] GNews global cycle skipped — ${skipReason}`);
    return { fetched: 0, inserted: 0, skipped: true };
  }
  await ensureNSESymbols();

  const worldBiz = await fetchGNews('top-headlines', { category: 'business', country: 'us' });
  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();
  const fetched = gnewsTag(worldBiz, 'GNews Global', 'GLOBAL', sentRows, legacyRows);

  const inserted = sentRows.size;
  if (inserted > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] GNews global cycle: fetched=${fetched}, processed=${inserted}`);
  return { fetched, inserted };
}

// ─── GNews per-stock coverage (rotating batch — GNews search is metered, unlike Google
// News RSS above, so this cannot cover the same 150-company universe runCompanyNewsCycle does)

const GNEWS_STOCKS_TRACKED = 60;  // top-N by market cap eligible for GNews stock coverage
const GNEWS_STOCKS_BATCH = 5;     // company names OR-joined into one search call per cycle
const GNEWS_STOCKS_OFFSET_KEY = 'gnews_stocks_rotation_offset';

/** Advances a persisted round-robin cursor over the top-N liquid universe (by market cap) and
 *  returns the next batch. At GNEWS_STOCKS_BATCH=5 and an hourly cycle, the full 60-name
 *  universe rotates through every 12 hours. */
async function nextGNewsStockBatch(): Promise<{ symbol: string; name: string }[]> {
  const universe = await dbAll(
    `SELECT ns.symbol, ns.name FROM nse_stocks ns
     JOIN stock_fundamentals sf ON sf.symbol = ns.symbol
     WHERE ns.status = 'ACTIVE' AND ns.name IS NOT NULL AND sf.market_cap IS NOT NULL
     ORDER BY sf.market_cap DESC LIMIT ?`, [GNEWS_STOCKS_TRACKED],
  ) as { symbol: string; name: string }[];
  if (universe.length === 0) return [];

  const row = await dbGet<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?', [GNEWS_STOCKS_OFFSET_KEY],
  );
  const offset = row?.value ? (parseInt(row.value, 10) || 0) % universe.length : 0;
  const batch: { symbol: string; name: string }[] = [];
  for (let i = 0; i < GNEWS_STOCKS_BATCH && i < universe.length; i++) {
    batch.push(universe[(offset + i) % universe.length]);
  }
  const nextOffset = (offset + GNEWS_STOCKS_BATCH) % universe.length;
  await dbRun(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [GNEWS_STOCKS_OFFSET_KEY, String(nextOffset)],
  );
  return batch;
}

/** Per-stock news via one OR-joined GNews search over a rotating batch of top-cap names --
 *  force-tagged to whichever batch symbol's name literally appears in each article (falling
 *  back to the ordinary name-tagger for co-mentions outside the batch), same force-tag +
 *  union-with-co-mentions contract processNewsItem already gives runCompanyNewsCycle/BSE. */
export async function runGNewsStocksCycle(): Promise<{ fetched: number; inserted: number; skipped?: boolean; batch?: string[] }> {
  const skipReason = await gnewsGateReason();
  if (skipReason) {
    console.log(`[SENTIMENT] GNews stocks cycle skipped — ${skipReason}`);
    return { fetched: 0, inserted: 0, skipped: true };
  }
  await ensureNSESymbols();

  const batch = await nextGNewsStockBatch();
  if (batch.length === 0) return { fetched: 0, inserted: 0 };

  const cleanedNames = batch.map(b => companyAliases(b.name)[0] ?? b.name);
  const q = cleanedNames.map(n => `"${n}"`).join(' OR ');
  const articles = await fetchGNews('search', { q, country: 'in' });

  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();
  const forceSymbol = (a: GNewsArticle): string | undefined => {
    const text = `${a.title} ${a.description ?? ''}`.toLowerCase();
    return batch.find(b => text.includes((companyAliases(b.name)[0] ?? b.name).toLowerCase()))?.symbol;
  };
  const fetched = gnewsTag(articles, 'GNews Stocks', 'INDIAN', sentRows, legacyRows, forceSymbol);

  const inserted = sentRows.size;
  if (inserted > 0) await persistNewsRows(sentRows, legacyRows);
  const batchSymbols = batch.map(b => b.symbol);
  console.log(`[SENTIMENT] GNews stocks cycle: batch=[${batchSymbols.join(',')}] fetched=${fetched} processed=${inserted}`);
  return { fetched, inserted, batch: batchSymbols };
}

// ─── Investing.com (slow-refresh RSS — separate cadence from NEWS_SOURCES) ────
//
// investing.com's India edition carries two feeds that don't fit NEWS_SOURCES' flat 15-min
// cadence, added 2026-08-05 while replacing MoneyControl's dead RSS family:
//   "Stock Market Investment Ideas" (news_1065) — analyst/target-price-flavored, the closest
//     live match found for MoneyControl's dead brokeragerecos.xml (no clean 1:1 replacement
//     exists — this is topically adjacent, not identical). Refreshes roughly once/day.
//   "Economy News" (news_14) — genuinely global/US macro despite the in.investing.com host;
//     live-verified 2026-08-05 (Bessent/Iran/Palantir headlines) — do NOT treat this as an
//     India-economy source. Refreshes a few times/day.
// Polling either on the flat 15-min cadence would just re-fetch the same items for hours
// before anything new appears — the same wasted-request rationale this file already
// documents for GNews/BSE above. 3h is a middle ground: tight enough to catch the economy
// feed's multi-times-a-day cadence without hammering the once-a-day ideas feed for nothing.
//
// Caveat: investing.com's pubDate is a bare `YYYY-MM-DD HH:mm:ss` (no weekday, no offset),
// unlike every RFC-822 date elsewhere in NEWS_SOURCES. `new Date(...)` parses it as the
// server's LOCAL time zone (verified — no crash, ISO round-trip succeeds), which is only
// correct if investing.com's raw timestamp is already IST for this India-edition subdomain.
// Not confirmed against the source; `published_at` may be off by a few hours if that
// assumption is wrong. Non-critical — dedup keys off (source name, link), not this field.
const INVESTING_SOURCES: NewsSource[] = [
  { name: 'Investing.com Stock Ideas', url: 'https://in.investing.com/rss/news_1065.rss', type: 'INDIAN' },
  { name: 'Investing.com Global Economy', url: 'https://in.investing.com/rss/news_14.rss', type: 'GLOBAL' },
];

/** Dedicated slow-cadence cycle for INVESTING_SOURCES — see the comment above for why these
 *  two feeds don't live in the flat-15-min NEWS_SOURCES array. */
export async function runInvestingIdeasCycle(): Promise<{ fetched: number; inserted: number }> {
  await ensureNSESymbols();

  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();
  let fetched = 0;

  const results = await Promise.all(INVESTING_SOURCES.map(src =>
    fetchSource(src).then(items => ({ src, items }))
  ));
  for (const { src, items } of results) {
    fetched += items.length;
    for (const raw of items.slice(0, 30)) {
      processNewsItem(raw, src.name, src.type, sentRows, legacyRows);
    }
  }

  const inserted = sentRows.size;
  if (inserted > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] Investing.com cycle: fetched=${fetched}, processed=${inserted}`);
  return { fetched, inserted };
}

// ─── NSE Corporate Announcements (official exchange RSS, free, no key) ───────
// nsearchives.nseindia.com is the static RSS archive path, NOT the dynamic NSE API/website
// this codebase's other notes call Akamai-walled. Live-verified 2026-08-13: Node's own fetch()
// with this file's generic NEWS_SOURCES header gets silently blackholed (abort/timeout, no
// response at all) against this host, but the same request with a browser-shaped
// User-Agent/Referer/Accept succeeds (200, real same-day content) -- a header-level gate, not
// a TLS-fingerprint one. Needs its own fetch, not the shared fetchSource() above.
//
// Item <title> is the company's LEGAL NAME here, not a headline about a subject (unlike every
// other RSS source in this file) -- isolating just the title for extractSymbols() mirrors how
// BSE's SLONGNAME field is isolated below, and is actually cleaner than scanning combined
// title+description prose, where a shorter unrelated alias could false-match.
interface NseRssFeed { key: string; name: string; url: string }
export const NSE_RSS_FEEDS: NseRssFeed[] = [
  { key: 'announcements', name: 'NSE Announcements', url: 'https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml' },
  { key: 'results', name: 'NSE Financial Results', url: 'https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml' },
];

export async function fetchNseRss(url: string, timeoutMs = 15000): Promise<RawNewsItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.nseindia.com/',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    return parseRSS(await res.text());
  } catch {
    return [];
  }
}

async function runNseRssFeed(feed: NseRssFeed): Promise<{ fetched: number; inserted: number }> {
  await ensureNSESymbols();
  const items = await fetchNseRss(feed.url);
  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();
  for (const raw of items) {
    const syms = extractSymbols(raw.title); // title-only, see comment above
    if (syms.length === 0) continue; // name doesn't resolve to a tracked NSE symbol -- skip
    processNewsItem(
      { title: `${raw.title}: ${feed.name}`.slice(0, 300), description: raw.description, link: raw.link, pubDate: raw.pubDate },
      feed.name, 'INDIAN', sentRows, legacyRows, syms[0],
    );
  }
  const inserted = sentRows.size;
  if (inserted > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] ${feed.name}: ${items.length} fetched → ${inserted} mapped to NSE symbols`);
  return { fetched: items.length, inserted };
}

export async function runNseAnnouncementsCycle(): Promise<{ fetched: number; inserted: number }> {
  return runNseRssFeed(NSE_RSS_FEEDS[0]);
}
export async function runNseFinancialResultsCycle(): Promise<{ fetched: number; inserted: number }> {
  return runNseRssFeed(NSE_RSS_FEEDS[1]);
}

// ─── MoneyControl per-stock EARNINGS news (results-window-targeted) ──────────
// Distinct from runMcStockNewsCycle above (general per-stock headlines, top-100-by-market-cap
// universe): this hits MC's earnings-category article search and targets whichever symbols are
// actually near a results date, reusing technical_signals.days_to_next_results (mc_earnings_
// fetcher.py, fixed 2026-08-13) instead of a flat top-N cut -- so a small-cap outside the top
// 100 by market cap still gets covered exactly when it matters (a live gap traced this session:
// MARKSANS/TDPOWERSYS/SENCO's real Q1 numbers were only ever captured via reactive market-wide
// RSS, never a dedicated per-stock earnings query). `?` unresolved via getStockMapping (which
// checks mcsymbol among other fields) skips rather than guesses.
const MC_EARNINGS_RESULTS_WINDOW_DAYS = 3; // matches RESULTS_SEASON_WINDOW_DAYS's definition of "imminent"

async function stocksNearResults(windowDays = MC_EARNINGS_RESULTS_WINDOW_DAYS): Promise<string[]> {
  try {
    const rows = await dbAll(
      `SELECT DISTINCT symbol FROM technical_signals
       WHERE days_to_next_results BETWEEN ? AND ?
         AND date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = technical_signals.symbol)`,
      [-windowDays, windowDays],
    ) as { symbol: string }[];
    return rows.map(r => r.symbol);
  } catch {
    return [];
  }
}

export async function runMcEarningsNewsCycle(): Promise<{ symbols: number; inserted: number }> {
  const symbols = await stocksNearResults();
  if (symbols.length === 0) return { symbols: 0, inserted: 0 };

  await ensureNSESymbols();
  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();

  const BATCH = 8; // matches mcFetchJson's own concurrency ceiling elsewhere in the app
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    await Promise.all(batch.map(async (symbol) => {
      try {
        const scId = getStockMapping(symbol)?.mcsymbol;
        if (!scId) return;
        const res = await fetchMcEarningsNews(scId, symbol);
        if (res.status !== 'ok') return;
        for (const item of res.news) {
          if (!item.posturl) continue; // no link -> no stable dedup id
          const epoch = Number(item.creation_date_epoch || item.update_date_epoch);
          const pubDate = epoch ? new Date(epoch * 1000).toISOString() : '';
          processNewsItem(
            { title: item.headline, description: item.intro, link: item.posturl, pubDate },
            'MoneyControl Earnings', 'INDIAN', sentRows, legacyRows, symbol,
          );
        }
      } catch { /* one bad stock must not abort the batch */ }
    }));
  }

  const inserted = sentRows.size;
  if (inserted > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] MC earnings-news cycle: ${symbols.length} near-results symbols → ${inserted} articles`);
  return { symbols: symbols.length, inserted };
}

// ─── MoneyControl market-wide stock-move blurbs (deals/get-stock-news) ───────
// One call, no per-stock loop -- each item already carries its own `scid`, resolved via
// getStockMapping (checks mcsymbol directly, no new resolver needed). Reaches whatever stock
// MC itself chose to write a move-blurb for, including names outside every other MC cycle's
// tracked universe -- live-verified 2026-08-13 this includes loser-side/smaller names the
// existing top-100-by-market-cap per-stock cycles under-cover.
export async function runMcDealsNewsCycle(): Promise<{ fetched: number; inserted: number }> {
  await ensureNSESymbols();
  const items = await fetchMcDealsNews();
  if (items.length === 0) return { fetched: 0, inserted: 0 };

  const sentRows = new Map<string, unknown[]>();
  const legacyRows = new Map<string, unknown[]>();
  for (const item of items) {
    if (!item.posturl) continue;
    const symbol = getStockMapping(item.scid)?.symbol;
    if (!symbol) continue; // scid outside our 2,005-stock mapping table -- skip, don't guess
    const epoch = Number(item.updateDateEpoch);
    const pubDate = epoch ? new Date(epoch * 1000).toISOString() : '';
    processNewsItem(
      { title: item.heading, description: `CMP ${item.cmp} (${item.changePct}%)`, link: item.posturl, pubDate },
      'MoneyControl Deals', 'INDIAN', sentRows, legacyRows, symbol,
    );
  }
  const inserted = sentRows.size;
  if (inserted > 0) await persistNewsRows(sentRows, legacyRows);
  console.log(`[SENTIMENT] MC deals-news cycle: ${items.length} fetched → ${inserted} mapped to NSE symbols`);
  return { fetched: items.length, inserted };
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

  // AI enrichment for HIGH-impact items not yet AI-scored. 10 -> 25 (2026-08-13): at 10/cycle
  // (15-min cadence -> 960/day) the 12,137-item backlog left after resetting the
  // available=False fallback-poisoning bug (see finbert_news_sentiment.py) would take ~12.6
  // days to clear even with zero new HIGH-impact arrivals. 25/cycle -> ~2,400/day, ~5 days --
  // still conservative against the 180s runPython timeout (model load dominates cost, not
  // per-item inference; this is a batch-size tuning knob, not a guaranteed-safe ceiling).
  const highImpact = await dbAll(`
    SELECT id, title, summary, category FROM news_sentiment_items
    WHERE impact = 'HIGH' AND ai_scored = 0
    ORDER BY fetched_at DESC LIMIT 25
  `) as { id: string; title: string; summary: string; category: string }[];

  if (highImpact.length > 0) {
    await enrichWithFinBERT(highImpact);
  }

  // Build and store market sentiment snapshot
  await buildMarketSentimentSnapshot();

  console.log(`[SENTIMENT] Cycle done: fetched=${fetched}, processed=${inserted}`);
  return { fetched, inserted, updated: 0 };
}

// ─── FinBERT Enrichment for High-Impact News ──────────────────────────────────
// REPLACED 2026-08-13 (was enrichWithAI, Anthropic): ANTHROPIC_API_KEY has been empty since
// inception, so that path silently never ran -- 11,384 HIGH-impact items stuck at
// ai_scored=0 and growing, found via a fetcher-accuracy-review sweep. Uses
// finbert_news_sentiment.py (ProsusAI/finbert, ~440MB, already used elsewhere in this
// codebase for screener sentiment) instead of a paid key or a local LLM too large for this
// box's free RAM. impact is NOT re-derived here -- FinBERT is a sentiment classifier with no
// basis for judging news impact, and every item arrives already filtered to impact='HIGH' by
// the keyword baseline (scoreSentiment above), so it's passed through unchanged.

export async function enrichWithFinBERT(items: { id: string; title: string; summary: string; category: string }[]) {
  const markDoneSql = `UPDATE news_sentiment_items SET ai_scored=1, sentiment=?, sentiment_score=? WHERE id=?`;
  const payload = items.map(i => ({ id: i.id, title: i.title, summary: i.summary?.slice(0, 300) ?? '' }));
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');

  try {
    // 60s -> 180s (2026-08-25): the 60s timeout fired repeatedly in pm2-err.log ("Timed out
    // after 60000ms (killed by timeout)") because model load dominates cost and competes for
    // RAM/CPU on a box that also runs the server, training and four other Python services.
    // The comment below already said "model load dominates cost, not per-item inference" --
    // 60s assumed a warm OS file cache that a memory-pressured host does not guarantee. A
    // failed enrichment is caught + logged (rows stay ai_scored=0 for the next cycle), so the
    // cost of a too-short timeout is silent backlog growth, not data corruption.
    const { stdout } = await runPython('finbert_news_sentiment.py', [b64], 180_000);
    const jsonLine = stdout.trim().split('\n').pop() ?? '[]'; // model-load progress noise precedes it on some runs
    const results = JSON.parse(jsonLine) as { id: string; sentiment: string; score: number }[];
    for (const r of results) {
      await dbRun(markDoneSql, [r.sentiment, r.score, r.id]);
    }
  } catch (e) {
    console.error('[SENTIMENT] FinBERT enrichment failed:', (e as Error).message);
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
    // BUG FOUND 2026-08-07 (dead-column sweep): this used to search fetchGlobalMarketData()'s
    // result for a 'nifty'/'india' entry -- but that endpoint (NiftyTrader's usstock/global-
    // market) is a global-EX-INDIA indices feed by design (live-verified: SHANGHAI/HANG SENG/
    // NIKKEI/CAC 40/DAX/FTSE 100/DOW JONES/NASDAQ FUTURES/S&P 500 FUTURES -- zero India/Nifty
    // entries, ever), so the .find() could never match and market_sentiment_snapshots.
    // nifty_last_close/nifty_support/nifty_resistance were 100% NULL (confirmed live,
    // 669/669 rows) despite this whole block looking fully wired. Reads NIFTY50's own real
    // close from stock_ohlcv (this platform's canonical, already-collected source) instead.
    const niftyRow = await dbGet<{ close: number }>(
      "SELECT close FROM stock_ohlcv WHERE symbol = 'NIFTY50' ORDER BY date DESC LIMIT 1"
    ).catch(() => null);
    if (niftyRow?.close) {
      niftyClose = niftyRow.close;
    }

    const globalData = await fetchGlobalMarketData();

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
