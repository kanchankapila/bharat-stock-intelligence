# Code Location Map - Live Data Integration

## 🗺️ File Structure

```
project-root/
│
├── 📄 CHANGES_SUMMARY.md                    ⭐ What changed (this file's parent)
├── 📄 LIVE_DATA_INTEGRATION.md              ⭐ Detailed architecture docs
├── 📄 LIVE_DATA_QUICK_REFERENCE.md          ⭐ Quick start guide
│
├── src/
│   ├── server/
│   │   ├── 🆕 liveStockData.ts              ⭐ **CORE FETCHING MODULE (162 lines)**
│   │   │   ├── fetchStockQuoteMoneyControl()     [Lines 13-55]
│   │   ├── │   ├── API: MoneyControl
│   │   │   │   └── Returns: price, change, volume, etc.
│   │   │   │
│   │   │   ├── fetchStockQuoteFinnhub()         [Lines 58-100]
│   │   │   │   ├── API: Finnhub (fallback)
│   │   │   │   └── Requires: FINNHUB_API_KEY
│   │   │   │
│   │   │   ├── fetchAllLiveStocks()            [Lines 105-132]
│   │   │   │   ├── Parallel fetch for all stocks
│   │   │   │   └── Uses Promise.allSettled()
│   │   │   │
│   │   │   ├── fetchStockDataWithCache()       [Lines 135-160]
│   │   │   │   ├── 30-second cache
│   │   │   │   └── Tries MoneyControl → Finnhub
│   │   │   │
│   │   │   └── getOrRefreshAllStocks()         [Lines 164-180]
│   │   │       ├── Smart refresh logic
│   │   │       └── 5-minute refresh interval
│   │   │
│   │   ├── ✏️ router.ts                       **MODIFIED - TRPC ENDPOINTS**
│   │   │   ├── import liveStockData            [Line 30]
│   │   │   ├── getLiveStockQuote               [Lines 212-220]
│   │   │   │   └── GET /api/trpc/getLiveStockQuote?input={"symbol":"RELIANCE"}
│   │   │   │
│   │   │   └── getLiveStocks                   [Lines 221-230]
│   │   │       └── GET /api/trpc/getLiveStocks
│   │   │
│   │   ├── stockMapping.ts
│   │   ├── technicalScanner.ts
│   │   ├── ... (other server files unchanged)
│   │
│   ├── services/
│   │   └── ✏️ marketService.ts                **MODIFIED - REACT HOOK**
│   │       ├── import { trpc }                 [Line 2]
│   │       ├── useMarketData()                 [Lines 23-70]
│   │       │   ├── const { data: liveStocks } = trpc.getLiveStocks.useQuery()
│   │       │   ├── refetchInterval: 5 * 60 * 1000 ms
│   │       │   ├── staleTime: 30 * 1000 ms
│   │       │   └── Fallback to INITIAL_STOCKS on error
│   │       │
│   │       └── INITIAL_STOCKS                  [Lines 18]
│   │           └── Dummy data as fallback
│   │
│   ├── ✏️ main.tsx                            **MODIFIED - TRPC CLIENT**
│   │   ├── transformer: superjson             [Line 13]
│   │   └── httpBatchLink: transformer         [Line 18]
│   │
│   ├── App.tsx                                 (No changes needed)
│   └── ... (other files)
│
└── .env (Optional)
    └── FINNHUB_API_KEY=your_key_here
```

---

## 🔍 Exact Line References

### File: `src/server/liveStockData.ts` (NEW)

| Function | Lines | Purpose |
|----------|-------|---------|
| `fetchStockQuoteMoneyControl()` | 13-55 | Fetch from MoneyControl API |
| `fetchStockQuoteFinnhub()` | 58-100 | Fetch from Finnhub API |
| `formatVolume()` | 102-109 | Helper: format volume numbers |
| `fetchAllLiveStocks()` | 111-134 | Fetch all stocks in parallel |
| Cache setup | 136-137 | `const stockCache = new Map()` |
| `fetchStockDataWithCache()` | 140-165 | Smart fetch with caching |
| `getOrRefreshAllStocks()` | 168-182 | Auto-refresh handler |

### File: `src/server/router.ts` (MODIFIED)

| Addition | Lines | What It Does |
|----------|-------|--------------|
| Import liveStockData | 30 | `import { fetchStockDataWithCache, getOrRefreshAllStocks }` |
| `getLiveStockQuote` | 212-220 | TRPC: Get single stock quote |
| `getLiveStocks` | 221-230 | TRPC: Get all live stocks |

### File: `src/services/marketService.ts` (MODIFIED)

| Change | Lines | Details |
|--------|-------|---------|
| Import trpc | 2 | `import { trpc }` |
| useMarketData() | 23-70 | **NEW VERSION** - uses TRPC |
| INITIAL_STOCKS | 18 | Kept as fallback |
| Old function removed | N/A | Replaced completely |
| getIndexData() | 72-79 | Index data (unchanged) |

### File: `src/main.tsx` (MODIFIED)

| Change | Lines | What It Does |
|--------|-------|--------------|
| Line 13 | Client config | Added `transformer: superjson` |
| Line 18 | httpBatchLink | Added `transformer: superjson` |

---

## 📊 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER'S BROWSER                                │
│                     (Frontend - React)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  App.tsx                                                          │
│    └─> useMarketData()                                           │
│          (src/services/marketService.ts : 23-70)                │
│          │                                                        │
│          └─> trpc.getLiveStocks.useQuery()                      │
│                  refetch interval: 5 min                         │
│                  stale time: 30 sec                              │
│                  cache time: 10 min                              │
│                  │                                               │
│                  └─> HTTP POST /api/trpc/getLiveStocks          │
│                                                                   │
└─────────────────────────────────────────┬───────────────────────┘
                                          │
                                          │ TRPC Serialization
                                          │ (superjson)
                                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    NODE.JS SERVER                                 │
│                   (Backend - tRPC Router)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  router.ts (221-230)                                            │
│    └─> getLiveStocks procedure                                  │
│          └─> getOrRefreshAllStocks()                            │
│              (src/server/liveStockData.ts : 168-182)           │
│              │                                                   │
│              ├─> For each stock (RELIANCE, TCS, etc.):         │
│              │   │                                              │
│              │   ├─> fetchStockDataWithCache(symbol)           │
│              │   │   (liveStockData.ts : 140-165)             │
│              │   │   │                                          │
│              │   │   ├─> Check 30-sec cache                    │
│              │   │   ├─> If miss:                              │
│              │   │   │   ├─> fetchStockQuoteMoneyControl()    │
│              │   │   │   │   (liveStockData.ts : 13-55)       │
│              │   │   │   │   └─> API: moneycontrol.com        │
│              │   │   │   │                                      │
│              │   │   │   └─> If fails:                         │
│              │   │   │       ├─> fetchStockQuoteFinnhub()      │
│              │   │   │       │   (liveStockData.ts : 58-100)  │
│              │   │   │       │   └─> API: finnhub.io           │
│              │   │   │       │                                  │
│              │   │   └─> Cache result (30 sec)                 │
│              │   │                                              │
│              │   └─> Return: MarketData object                 │
│              │       {symbol, name, price, change, ...}        │
│              │                                                   │
│              └─> Return: Array<MarketData>                     │
│                  │                                              │
│                  └─> TRPC Response (via superjson)             │
│                                                                   │
└─────────────────────────────────────────┬───────────────────────┘
                                          │
                                          │ HTTP 200
                                          │ Content-Type: application/json
                                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    USER'S BROWSER                                │
│                     (Frontend - React)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  useMarketData() receives:                                      │
│    [                                                             │
│      { symbol: "RELIANCE", price: 2954.20, ... },              │
│      { symbol: "TCS", price: 3982.15, ... },                   │
│      ...                                                         │
│    ]                                                             │
│  │                                                               │
│  └─> useState(liveStocks)                                       │
│        │                                                         │
│        └─> UI Re-renders                                        │
│              └─> Dashboard shows real live prices! ✅           │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔗 API Endpoints

### Get All Stocks (Live)
```
Endpoint: POST /api/trpc/getLiveStocks
Called by: useMarketData() hook
Query params: none
Response: Array<MarketData>

Example call:
fetch('http://localhost:3000/api/trpc/getLiveStocks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
})
.then(r => r.json())
.then(data => console.log(data))
```

### Get Single Stock (Live)
```
Endpoint: POST /api/trpc/getLiveStockQuote
Input: { symbol: "RELIANCE" }
Response: MarketData

Example call:
fetch('http://localhost:3000/api/trpc/getLiveStockQuote', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ symbol: 'RELIANCE' })
})
.then(r => r.json())
.then(data => console.log(data))
```

---

## 📋 Code Examples

### Example 1: Using Live Data in Component

```typescript
import { useMarketData } from './services/marketService';

function MyComponent() {
  const stocks = useMarketData(); // Fetches live data
  
  return (
    <div>
      {stocks.map(stock => (
        <div key={stock.symbol}>
          <p>{stock.name}: ₹{stock.price}</p>
          <p>Change: {stock.change} ({stock.changePct}%)</p>
        </div>
      ))}
    </div>
  );
}
```

### Example 2: MoneyControl API Call

```typescript
// This is what happens internally in liveStockData.ts
const symbol = 'RELIANCE';
const mcsymbol = 'BE03'; // From stockMapping

const url = `https://www.moneycontrol.com/mcapi/v1/quote/${mcsymbol}`;
const response = await fetch(url);
const apiData = await response.json();

// Transforms to:
const marketData = {
  symbol: 'RELIANCE',
  price: apiData.data.quote.ltPrice,
  change: apiData.data.quote.ltPrice - apiData.data.quote.previousPrice,
  // ... etc
};
```

### Example 3: Caching Mechanism

```typescript
// In liveStockData.ts (lines 136-160)
const stockCache = new Map();

function fetchStockDataWithCache(symbol) {
  // Check cache first
  const cached = stockCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < 30000) {
    return cached.data; // Return cached within 30 seconds
  }
  
  // Fetch new data
  const data = fetchFromAPI(symbol);
  
  // Cache it
  stockCache.set(symbol, { data, timestamp: Date.now() });
  
  return data;
}
```

---

## ✅ Verification Steps

### 1. Check Files Exist
```bash
ls -la src/server/liveStockData.ts      # Should exist ✅
ls -la CHANGES_SUMMARY.md                # Should exist ✅
ls -la LIVE_DATA_INTEGRATION.md          # Should exist ✅
```

### 2. Check Imports
```bash
grep "liveStockData" src/server/router.ts     # Should have import ✅
grep "trpc" src/services/marketService.ts     # Should have import ✅
grep "superjson" src/main.tsx                 # Should appear twice ✅
```

### 3. Run Server
```bash
npm run dev
# Should show: 🚀 Server running on http://localhost:3000
```

### 4. Check Browser
```
Open http://localhost:3000
Press F12 → Console
Should see: [LIVE DATA] Fetching data for 100 stocks...
           [LIVE DATA] Successfully fetched XX stock quotes
```

---

## 🎯 Summary

| Component | Location | Status | Purpose |
|-----------|----------|--------|---------|
| Live Data Module | `src/server/liveStockData.ts` | ⭐ NEW | Fetches real data |
| TRPC Endpoints | `src/server/router.ts` | ✏️ MODIFIED | API routes |
| React Hook | `src/services/marketService.ts` | ✏️ MODIFIED | Frontend hook |
| TRPC Client | `src/main.tsx` | ✏️ MODIFIED | Serialization fix |
| Docs | `LIVE_DATA_INTEGRATION.md` | ⭐ NEW | Detailed guide |
| Docs | `LIVE_DATA_QUICK_REFERENCE.md` | ⭐ NEW | Quick start |
| Docs | `CHANGES_SUMMARY.md` | ⭐ NEW | Change list |

---

**Total Changes**: 4 files modified + 1 new file + 3 documentation files

**Status**: ✅ Ready for live data!
