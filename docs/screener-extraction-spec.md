# Screener Stock Extraction — Complete Specification
> Extracted from bharat-stock-intelligence. Use this to rebuild the screener pipeline in any codebase.

---

## Overview

Three providers are scraped and stored in SQLite. All stocks are normalised to NSE symbol (e.g. `HDFCBANK`).

| Provider | Screeners | Mechanism | Rate limit strategy |
|----------|-----------|-----------|---------------------|
| **Trendlyne** | ~200+ (discovered dynamically) | GET JSON API | 500ms base + 15% jitter per request |
| **MoneyControl** | 178 pro + 42 tech = 220 hardcoded | GET JSON API | 500ms delay between screeners, semaphore(10) |
| **ETnow** | 438 (from `et_screeners.json`) or 13 fallback | POST JSON API | 800ms delay between screeners |

---

## Database Schema

```sql
-- Trendlyne
CREATE TABLE IF NOT EXISTS trendlyne_screeners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  screener_id TEXT UNIQUE NOT NULL,          -- kebab-case slug of name
  screener_name TEXT NOT NULL,
  screenpk    TEXT NOT NULL,                 -- Trendlyne stock_id used as screener key
  description TEXT,
  sentiment   TEXT DEFAULT 'neutral',        -- 'bullish' | 'bearish' | 'neutral'
  category    TEXT DEFAULT 'technical',      -- 'technical' | 'fundamental' | 'valuation' | 'delivery' | 'momentum' | 'sector'
  timeframe   TEXT DEFAULT 'long_term',      -- 'intraday' | 'long_term'
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trendlyne_screener_stocks (
  screener_id TEXT NOT NULL,
  stock_id    TEXT NOT NULL,                 -- Trendlyne numeric ID
  symbol      TEXT,                          -- NSE symbol (resolved via stockMapping)
  PRIMARY KEY (screener_id, stock_id),
  FOREIGN KEY (screener_id) REFERENCES trendlyne_screeners(screener_id)
);
CREATE INDEX IF NOT EXISTS idx_tss_symbol ON trendlyne_screener_stocks(symbol);

-- MoneyControl
CREATE TABLE IF NOT EXISTS moneycontrol_screeners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id     TEXT UNIQUE NOT NULL,          -- MC scanId (numeric or string like 'OHLC_D_P_BPBULL')
  cat_id      TEXT NOT NULL,                 -- MC catId
  screener_name TEXT NOT NULL,
  type        TEXT NOT NULL,                 -- 'proscanner' | 'techscanner' | 'technical-trends'
  is_positive INTEGER DEFAULT 1,            -- 1 = bullish signal, 0 = bearish
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS moneycontrol_screener_stocks (
  scan_id     TEXT NOT NULL,
  mcsymbol    TEXT NOT NULL,                 -- MC internal stock ID (e.g. 'HDF01')
  stock_name  TEXT,
  symbol      TEXT,                          -- NSE symbol (resolved via getSymbolFromMcsymbol)
  PRIMARY KEY (scan_id, mcsymbol),
  FOREIGN KEY (scan_id) REFERENCES moneycontrol_screeners(scan_id)
);
CREATE INDEX IF NOT EXISTS idx_mss_symbol ON moneycontrol_screener_stocks(symbol);

-- ETnow
CREATE TABLE IF NOT EXISTS etnow_screeners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  screener_id TEXT UNIQUE NOT NULL,          -- numeric string e.g. '73'
  screener_name TEXT NOT NULL,
  query_condition TEXT,                      -- double-encoded JSON from et_screeners.json
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS etnow_screener_stocks (
  screener_id TEXT NOT NULL,
  symbol      TEXT NOT NULL,                 -- NSE symbol (stripped of -NSE/EQ/BE suffix)
  stock_name  TEXT,
  PRIMARY KEY (screener_id, symbol),
  FOREIGN KEY (screener_id) REFERENCES etnow_screeners(screener_id)
);

-- Unified metadata (NLP-inferred, all three providers)
CREATE TABLE IF NOT EXISTS screener_master (
  scan_id           TEXT PRIMARY KEY,        -- matches screener_id/scan_id from source tables
  name              TEXT NOT NULL,
  source            TEXT NOT NULL,           -- 'trendlyne' | 'moneycontrol' | 'etnow'
  inferred_sentiment TEXT,                   -- 'bullish' | 'bearish' | 'neutral'
  inferred_category  TEXT,
  inferred_timeframe TEXT DEFAULT 'long_term',
  confidence        REAL,
  weight_override   REAL,
  last_updated      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 1. Trendlyne

### API Endpoint

```
GET https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/
```

### Query Parameters

```
perPageCount = '1000'
pageNumber   = '0'          (0-indexed)
screenpk     = '<stock_id>' (Trendlyne numeric stock ID used as screener key)
groupType    = 'all'
groupName    = '<screener_name>'  (empty string for discovery; screener name for filtered fetch)
```

### Request Headers

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
Accept:     application/json
Referer:    https://kayal.trendlyne.com/
```

### Response Shape

```json
{
  "head": { "status": "0" },
  "body": {
    "screenObj": {
      "title": "Screener Name",
      "description": "..."
    },
    "tableHeaders": [
      { "unique_name": "stock_id",        "display_name": "Stock" },
      { "unique_name": "get_full_name",   "display_name": "Company" },
      { "unique_name": "currentPrice",    "display_name": "LTP" },
      { "unique_name": "pPriceChange",    "display_name": "Change" },
      { "unique_name": "pPercentChange",  "display_name": "Chg%" },
      { "unique_name": "pReturn1W",       "display_name": "1W Ret" },
      { "unique_name": "pReturn1M",       "display_name": "1M Ret" }
    ],
    "tableData": [
      [12345, "HDFC Bank Ltd", 1650.5, 12.3, 0.75, 2.1, 5.4],
      ...
    ]
  }
}
```

`head.status === '0'` means success. Data is column-indexed — match values to headers by array position.

### Parsing Logic

```typescript
const stockIdIndex   = tableHeaders.findIndex(h => h.unique_name === 'stock_id');
const nameIndex      = tableHeaders.findIndex(h => h.unique_name === 'get_full_name');
const priceIndex     = tableHeaders.findIndex(h => h.unique_name === 'currentPrice');
const changeIndex    = tableHeaders.findIndex(h => h.unique_name === 'pPriceChange' || h.unique_name === 'priceChange');
const changePctIndex = tableHeaders.findIndex(h => h.unique_name === 'pPercentChange' || h.unique_name === 'percentChange');
const return1wIndex  = tableHeaders.findIndex(h => h.unique_name === 'pReturn1W' || h.unique_name === 'return1W' || h.unique_name === 'pReturn5D');
const return1mIndex  = tableHeaders.findIndex(h => h.unique_name === 'pReturn1M' || h.unique_name === 'return1M' || h.unique_name === 'pReturn21D');

tableData.forEach((row) => {
  const tlId    = String(row[stockIdIndex] || '');
  const name    = String(row[nameIndex] || '');
  const symbol  = resolveNSESymbolFromTLId(tlId) ?? resolveNSESymbolFromName(name);
  const ltp     = parseFloat(row[priceIndex] || 0);
  const change  = parseFloat(row[changeIndex] || 0);
  const changePct = parseFloat(row[changePctIndex] || 0);
  const ret1w   = parseFloat(row[return1wIndex] || 0);
  const ret1m   = parseFloat(row[return1mIndex] || 0);
});
```

### Screener Discovery (one-time)

Trendlyne has no screener list API. Discovery works by iterating every NSE stock ID (2000+) and calling the endpoint with that stock's ID as `screenpk`. Each response's `body.screenObj.title` reveals which screener that stock belongs to. This maps screener names → one representative `screenpk`.

```typescript
// For each stockId in STOCK_IDS array:
const params = new URLSearchParams({
  perPageCount: '1000', pageNumber: '0',
  screenpk: stockId, groupType: 'all', groupName: ''
});
// If response.head.status === '0' && response.body.screenObj.title exists:
//   screenerName → screenpk mapping is stored in trendlyne_screeners
```

**Duration:** 10–15 minutes for full discovery. Run once, cache in DB.
**Slug format:** `screener_name.toLowerCase().replace(/\s+/g, '-')` → `screener_id` in DB.

### Rate Limiting

```typescript
const TRENDLYNE_CONFIG = {
  FETCH_INTERVAL_MS:         300000,  // 5 min cache TTL
  SCREENER_NAMES_INTERVAL_MS: 86400000, // 24 hr discovery TTL
  BASE_DELAY_MS:              500,    // base delay before each request
  JITTER_PERCENT:             15,     // ±15% random jitter
  REQUEST_TIMEOUT_MS:         30000   // 30s abort
};

// Jitter formula:
const jitterDelay = BASE_DELAY_MS + (Math.random() * BASE_DELAY_MS * 2 * JITTER_PERCENT/100)
                    - (BASE_DELAY_MS * JITTER_PERCENT/100);
// Clamped to minimum 50ms
```

### DB Write (sync all screeners)

```typescript
// For each screener in trendlyne_screeners:
// 1. Fetch stocks via fetchTrendlyneScreenerData(screenpk, screenerName)
// 2. Write:
db.prepare(`DELETE FROM trendlyne_screener_stocks WHERE screener_id = ?`).run(screenerId);
for (const stock of stocks) {
  db.prepare(`INSERT OR IGNORE INTO trendlyne_screener_stocks (screener_id, stock_id, symbol) VALUES (?,?,?)`)
    .run(screenerId, stock.stockId, stock.symbol);
}
```

### NLP Categorisation

Applied to screener name + description at save time. Sets `sentiment`, `category`, `timeframe`:

```typescript
// Sentiment
bearish if: 'bearish'|'sell'|'breakdown'|'falling'|'death cross'|'downtrend'|'overbought'|'caution'|
            'avoid'|'momentum trap'|'value trap'|'wealth destroy'|'exercise caution'|'red flag'
bullish if: 'bullish'|'buy'|'breakout'|'rising'|'golden cross'|'uptrend'|'oversold'|'top gainer'

// Timeframe → intraday if name contains:
'intraday'|'15m'|'5m'|'15-min'|'5-min'|'hour'|'hourly'|'1h'|'day trade'|
'min'|'circuit'|'btst'|'stbt'|'breakout'|'breakdown'|'momentum'|
'squeeze'|'rsi power'|'smart breakout'|'smart breakdown'

// Category
momentum   if: 'momentum'|'relative strength'|'gainer'|'rally'
sector     if: 'tata'|'adani'|'psu'|'sector'|'defense'|'infra'
fundamental if: 'fundamental'|'roe'|'debt'
valuation  if: 'pe'|'pb'|'valuation'|'cheap'|'undervalued'
delivery   if: 'delivery'|'bulk deal'|'block deal'
else: 'technical'
```

---

## 2. MoneyControl

### API Endpoints

**Proscanner (fundamental):**
```
GET https://api.moneycontrol.com/mcapi/v1/proscanner/scanner-detail?catId={catId}&scanId={scanId}
```

**Techscanner (technical patterns):**
```
GET https://api.moneycontrol.com/mcapi/v1/techscanner/scanner-detail?catId={catId}&scanId={scanId}
```

**Technical Trends:**
```
GET https://api.moneycontrol.com/mcapi/v1/technical-trends/{trendType}?ex=N&index={indexId}&page=1&order=desc&deviceType=W&sort=performance&appVersion=142
```

### Request Headers

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
Accept:     application/json, text/plain, */*
Referer:    https://www.moneycontrol.com/
```

No cookies or auth tokens required.

### Response Shape (proscanner / techscanner)

```json
{
  "success": 1,
  "data": {
    "list": {
      "scannerName": "Strong Performers",
      "scannerDescription": "...",
      "catName": "Fundamental",
      "scannerDetails": [
        {
          "stkname": "HDFC Bank",
          "ltp": "1650.50",
          "perChg": "0.75",
          "stkId": "HDF01",
          "scUrl": "/stocks/hdfc-bank...",
          "columns": [{ "name": "PE", "value": "18.2" }]
        }
      ]
    }
  }
}
```

Fallback field names for stocks array: `response.data.list?.scannerDetails || response.data.stock || response.data.stocks`

### Response Shape (technical-trends)

```json
{
  "success": 1,
  "data": [
    {
      "companyName": "Infosys",
      "ticker": "INFY",
      "last_rate": "1520.00",
      "percent_change": "1.2",
      "scId": "INF02",
      "trendPrice": "1480",
      "changeStatus": "Uptrend"
    }
  ]
}
```

### Parsing Logic

```typescript
// proscanner / techscanner
const stocks = response.data.list?.scannerDetails || response.data.stock || response.data.stocks || [];
for (const stock of stocks) {
  const mcsymbol  = stock.stkId || stock.sc_id;          // MC internal ID
  const stockName = stock.stkname || stock.stock_name || stock.shortName;
  const nseSymbol = getSymbolFromMcsymbol(mcsymbol);     // resolve via hardcoded map
}

// technical-trends
const stocks = json.data.map(item => ({
  mcsymbol:  item.scId || item.symbol,
  stockName: item.companyName || item.ticker,
  ltp:       item.last_rate || item.lastPrice,
  perChg:    item.percent_change || item.percentageChange,
}));
```

### Hardcoded Screener List

220 entries in `MC_SCREENERS` array:

```typescript
interface McScreenerConfig {
  catId: string;   // '1'–'9' for pro; '17','25' for tech
  scanId: string;  // numeric string for pro; pattern string for tech
  type: 'pro' | 'tech';
  is_positive: boolean;
}

// Sample pro screeners (catId 1 = large-cap fundamental):
{ catId: '1', scanId: '146', type: 'pro', is_positive: true },
{ catId: '1', scanId: '181', type: 'pro', is_positive: true },
// ... 170+ more

// Sample tech screeners:
{ catId: '25', scanId: 'OHLC_D_P_BPBULL',        type: 'tech', is_positive: true  },
{ catId: '25', scanId: 'OHLC_D_I_DSMARTBULLC',   type: 'tech', is_positive: true  },
{ catId: '25', scanId: 'OHLC_D_P_BPBEAR',        type: 'tech', is_positive: false },
{ catId: '17', scanId: 'OHLC_W_P_52HIGH',        type: 'tech', is_positive: true  },
{ catId: '17', scanId: 'OHLC_D_P_2YRHIGH',       type: 'tech', is_positive: true  },
{ catId: '17', scanId: 'OHLC_W_P_52LOW',         type: 'tech', is_positive: false },
// Full tech scanId list: OHLC_D_I_RSIPOWBO, RSI70607DNBU, ADBBPBUY, MOMRAVBU,
// ST5133BULL, SQZBULLBO, 10DSTOCHBULL, CLABVPWH, RSIMULTIBAG, BOLDBULL, BTSTOND,
// CLSERIESBULL, TRNGLCANDBULL, RISE3BULL (and BEAR variants), ALLTIMEH, ALLTIMEL, etc.
```

### HTTP Client (mcFetchJson)

```typescript
const mcSemaphore = new Semaphore(10);  // max 10 concurrent requests

async function mcFetchJson(url, retries = 3) {
  return mcSemaphore.run(async () => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const res = await fetch(url, {
        headers: { /* see above */ },
        signal: AbortSignal.timeout(10000)   // 10s timeout
      });
      if (!res.ok) {
        if (res.status === 503 && attempt < retries) {
          // exponential backoff: 1s, 2s, 4s (capped at 10s) + jitter
          await sleep(Math.min(1000 * 2**(attempt-1), 10000) + Math.random() * 1000);
          continue;
        }
        return null;
      }
      return res.json();
    }
  });
}
```

### Rate Limiting

- Semaphore: 10 concurrent MC requests
- 500ms delay between screeners in sync loop
- 30-min in-memory cache per `type:catId:scanId` key

### DB Write

```typescript
// Upsert screener metadata
db.prepare(`
  INSERT INTO moneycontrol_screeners (scan_id, cat_id, screener_name, type, is_positive)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(scan_id) DO UPDATE SET
    screener_name = excluded.screener_name,
    last_updated  = CURRENT_TIMESTAMP
`).run(scanId, catId, screenerName, type, is_positive ? 1 : 0);

// Replace stocks
db.prepare('DELETE FROM moneycontrol_screener_stocks WHERE scan_id = ?').run(scanId);
for (const stock of stocks) {
  db.prepare(`
    INSERT INTO moneycontrol_screener_stocks (scan_id, mcsymbol, stock_name, symbol)
    VALUES (?, ?, ?, ?)
  `).run(scanId, mcsymbol, stockName, nseSymbol);
}
```

### Symbol Resolution

MC uses opaque internal IDs (`stkId`, e.g. `HDF01`). Resolution via hardcoded lookup map in `stockMapping.ts`:

```typescript
// getSymbolFromMcsymbol(mcsymbol: string): string | null
// Looks up mcsymbol in stocklist.ts hardcoded map of 180 liquid stocks.
// Returns NSE symbol (e.g. 'HDFCBANK') or null if unmapped.
```

---

## 3. ETnow (Economic Times)

### API Endpoint

```
POST https://screener.indiatimes.com/screener/v2/screenerByScreenerIdForWeb
Content-Type: application/json
```

### Request Body

```json
{
  "viewId": 6916,
  "sort": [],
  "pagesize": 20,
  "pageno": 1,
  "deviceId": "web",
  "filterType": "index",
  "filterValue": [],
  "screenerId": "73",
  "queryCondition": "<filter string from et_screeners.json>"
}
```

### Request Headers

```
content-type:    application/json
referer:         https://economictimes.indiatimes.com/
accept:          */*
User-Agent:      Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
Origin:          https://economictimes.indiatimes.com
Accept-Language: en-US,en;q=0.9
```

### Response Shape

```json
{
  "dataList": [
    {
      "assetName":   "Coal India Ltd",
      "assetSymbol": "COALINDIAEQ",
      "currentPrice": 450.25,
      "priceChange":  5.30,
      "percentChange": 1.19
    }
  ],
  "message": "Success",
  "statusCode": 200
}
```

Fallback response paths (handle all variants):
```typescript
const records = response.dataList
  || response.searchResult?.searchData?.records
  || response.data?.records
  || [];
```

### Parsing / Symbol Normalisation

```typescript
for (const record of records) {
  const stockName = record.assetName || record.name || record.companyName
                  || record.stock_name || record.shortName || '';
  const rawSymbol = record.assetSymbol || record.stkId || record.symbol
                  || record.code || record.nseid || '';

  // Strip exchange suffix: "COALINDIAEQ" → "COALINDIA"
  const nseSymbol = rawSymbol
    .replace(/-NSE$/i, '')
    .replace(/EQ$/i, '')
    .replace(/BE$/i, '')
    .trim();
}
```

### Screener Seeding (one-time)

ETnow has no discovery API. Screeners are seeded from `et_screeners.json` (438 entries captured via browser HAR):

```typescript
// et_screeners.json shape:
{
  "requests": [
    {
      "screenerId": "73",
      "label": "Cash Cows",
      "request": {
        "postData": "{\"queryCondition\":\"...\",\"viewId\":6916,...}"
      }
    }
  ]
}

// Init logic:
function initEtnowScreeners(): void {
  const count = db.prepare('SELECT count(*) as count FROM etnow_screeners').get();
  if (count.count > 20) return;  // already seeded

  const jsonPath = path.join(process.cwd(), 'et_screeners.json');
  if (fs.existsSync(jsonPath)) {
    const requests = JSON.parse(fs.readFileSync(jsonPath)).requests;
    db.transaction(() => {
      for (const req of requests) {
        const query = typeof req.request?.postData === 'string'
          ? req.request.postData
          : JSON.stringify(req.request?.postData || {});
        db.prepare(`INSERT OR IGNORE INTO etnow_screeners (screener_id, screener_name, query_condition)
                    VALUES (?, ?, ?)`).run(req.screenerId, req.label, query);
      }
    })();
  }
}
```

### queryCondition Extraction (double-encoded JSON)

```typescript
// query_condition stored in DB is double-encoded:
// outer = JSON.parse(stored_string)  → may be a string
// inner = JSON.parse(outer)          → object with queryCondition field
let queryCondition = '';
if (screener.query_condition) {
  const outer = JSON.parse(screener.query_condition);
  const inner = typeof outer === 'string' ? JSON.parse(outer) : outer;
  queryCondition = inner?.queryCondition ?? '';
}
```

### Fallback Screener List (13 canonical, no et_screeners.json needed)

```typescript
const ETNOW_SCREENER_DEFINITIONS = [
  { id: '73',   name: 'Cash Cows' },
  { id: '75',   name: 'Elite Bluechips' },
  { id: '79',   name: 'Zero Debt Quality' },
  { id: '91',   name: 'Buy on Dips' },
  { id: '195',  name: 'Potential Multibaggers' },
  { id: '118',  name: 'Straight Flush' },
  { id: '362',  name: 'RSI Oversold' },
  { id: '518',  name: 'The Tata Empire' },
  { id: '520',  name: 'Adani Universe' },
  { id: '514',  name: 'PSU Gems' },
  { id: '515',  name: 'Monopoly Biz' },
  { id: '1101', name: 'Defence Sector' },
  { id: '1100', name: 'Infra Boost' },
];
// When using fallback, queryCondition = '' (empty string) — API still works for most screeners
```

### Rate Limiting

- 800ms delay between screeners
- No semaphore (sequential)
- No explicit cache (re-fetches on every sync call)

### DB Write

```typescript
db.transaction(() => {
  db.prepare('DELETE FROM etnow_screener_stocks WHERE screener_id = ?').run(screenerId);
  for (const record of records) {
    if (nseSymbol) {
      db.prepare(`INSERT OR IGNORE INTO etnow_screener_stocks (screener_id, symbol, stock_name)
                  VALUES (?, ?, ?)`).run(screenerId, nseSymbol, stockName);
    }
  }
})();
```

---

## Unified Screener ID Conventions

Prefix-based routing used in tRPC layer and frontend:

| Prefix | Provider | Example |
|--------|----------|---------|
| (none) | Trendlyne | `strong-performers` |
| `MC_`  | MoneyControl | `MC_146` |
| `ET_`  | ETnow | `ET_73` |

```typescript
// Routing logic in getTrendlyneScreener tRPC procedure:
if (screenpk.startsWith('MC_')) {
  // serve from moneycontrol_screener_stocks WHERE scan_id = screenpk.slice(3)
} else if (screenpk.startsWith('ET_')) {
  // fetch live from fetchETnowScreener(screenerId, queryCondition)
} else {
  // fetch from Trendlyne API via fetchTrendlyneScreenerData(screenpk, screenerName)
}
```

---

## Stock → Screener Lookup (reverse query)

Used for per-stock confluence analysis:

```sql
-- Trendlyne
SELECT s.screener_id, s.screener_name, m.inferred_sentiment
FROM trendlyne_screeners s
JOIN trendlyne_screener_stocks ss ON s.screener_id = ss.screener_id
LEFT JOIN screener_master m ON s.screener_id = m.scan_id
WHERE ss.symbol = ?;

-- MoneyControl
SELECT s.scan_id, s.screener_name, m.inferred_sentiment, s.is_positive, s.type
FROM moneycontrol_screeners s
JOIN moneycontrol_screener_stocks ss ON s.scan_id = ss.scan_id
LEFT JOIN screener_master m ON s.scan_id = m.scan_id
WHERE ss.symbol = ?;

-- ETnow
SELECT s.screener_id, s.screener_name, m.inferred_sentiment
FROM etnow_screeners s
JOIN etnow_screener_stocks ss ON s.screener_id = ss.screener_id
LEFT JOIN screener_master m ON s.screener_id = m.scan_id
WHERE ss.symbol = ?;
```

---

## Sync Schedule

| Operation | Trigger | Interval |
|-----------|---------|----------|
| MC screener sync | BullMQ repeatable job | 12 hours |
| ETnow screener sync | BullMQ repeatable job | 12 hours |
| Trendlyne screener data | BullMQ repeatable job | 12 hours |
| Trendlyne screener discovery | Manual / once per 24h | On-demand |
| In-memory cache (Trendlyne) | Per request | 5 min TTL |
| In-memory cache (MC screener) | Per request | 30 min TTL |

---

## NSE Symbol Resolution

All three providers use different internal IDs. Resolution to canonical NSE symbol:

```
Trendlyne: tlId (numeric)  → getStockMappingByTLId(tlId)?.symbol
                           → fallback: getStockMappingByName(fullName)?.symbol

MoneyControl: mcsymbol     → getSymbolFromMcsymbol(mcsymbol)
              (e.g. HDF01) → hardcoded 180-stock map in stocklist.ts

ETnow: assetSymbol         → strip suffix: replace(/-NSE$/i,'').replace(/EQ$/i,'').replace(/BE$/i,'')
       (e.g. COALINDIAEQ)  → result is already the NSE symbol
```

---

## File Map (source codebase)

| File | Role |
|------|------|
| `src/server/trendlyneScreener.ts` | Trendlyne fetch, parse, cache, discovery, NLP categorise, DB write |
| `src/server/moneycontrol.ts` | MC screener fetch + 30-min cache |
| `src/server/moneycontrolScreener.ts` | MC screener list (220 configs), sync loop, DB write |
| `src/server/mcApiService.ts` | MC HTTP client: semaphore(10), retry/backoff, timeout |
| `src/server/etnow.ts` | ETnow HTTP client, init/seed logic, reverse lookup |
| `src/server/etnowScreenerSync.ts` | ETnow sync loop, queryCondition parsing, DB write |
| `src/server/db.ts:95–167` | All 6 screener table definitions |
| `src/server/routers/screeners.router.ts` | tRPC endpoints: fetch, sync, list, per-stock lookup |
| `src/server/stockMapping.ts` | Symbol resolution: TL id→NSE, MC id→NSE |
| `src/data/stocklist.ts` | 180-stock master map with mcsymbol, tlid, isin fields |
| `et_screeners.json` | 438 ETnow screeners captured via browser HAR (queryCondition payloads) |

---

## Rebuilding in a New Codebase — Checklist

1. **DB**: Create 6 tables above (4 source tables + screener_master + optional index tables).
2. **MC client**: Implement `mcFetchJson` with semaphore(10), 3 retries, exponential backoff, 10s timeout.
3. **MC sync**: Iterate `MC_SCREENERS` array (220 entries), call proscanner/techscanner endpoints, upsert.
4. **ETnow seed**: Ship `et_screeners.json` or use 13-item fallback list. Parse double-encoded `query_condition`.
5. **ETnow sync**: POST to indiatimes screener endpoint, strip `EQ`/`BE`/`-NSE` from `assetSymbol`.
6. **Trendlyne discovery**: One-time crawl of all NSE stock IDs → collect screener names + screenpk. Cache in DB.
7. **Trendlyne sync**: For each screener in DB, GET with `screenpk` + `groupName`, parse column-indexed `tableData`.
8. **Symbol resolution**: Build a map `mcsymbol → NSE symbol` for MC. For ETnow: suffix stripping. For Trendlyne: map `tlid → NSE symbol`.
9. **NLP categorisation**: Apply sentiment/category/timeframe inference on screener name at save time.
10. **Unified prefix routing**: `MC_<scanId>`, `ET_<screenerId>`, bare slug for Trendlyne.
