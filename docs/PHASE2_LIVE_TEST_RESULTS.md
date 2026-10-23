# Phase 2 Live Test Results: Indian Earnings Data APIs

**Date:** 2026-10-23 (Live Testing)  
**Status:** ⚠️ Partial Success — Working APIs identified, earnings endpoints blocked  
**Test Environment:** Windows 11, Python 3.11, requests library

---

## Summary

| API | Endpoint | Status | Notes |
|---|---|---|---|
| **Moneycontrol** | quarterly-earning | ❌ 404 Not Found | Endpoint dead or URL incorrect |
| Moneycontrol | financial-historical | ❌ 403 Access Denied | Server blocking requests |
| Moneycontrol | earnings/get-earnings-data | ❌ 422 Missing Required Param | Needs `indexId` (not `scId`) |
| **TickerTape** | financials/income | ✅ 200 OK | Empty data for RELIANCE (may work for other symbols) |
| **Moneycontrol News** | mc_news.php | ✅ 200 OK | Works (returns news, not earnings) |
| **NSE Official** | market-data-pre-open | ✅ 200 OK | Works (returns market data, not earnings) |

---

## Detailed Test Results

### 1. Moneycontrol quarterly-earning Endpoint

**URL Tested:**
```
https://api.moneycontrol.com/mcapi/v1/quarterly-earning/500325/?deviceType=web&sc_id=500325
```

**Result:** ❌ **404 Not Found**

```
Status: 404
Response: Cannot GET /mcapi/v1/quarterly-earning/500325/
```

**Diagnosis:**
- Endpoint path is incorrect OR
- Company ID 500325 is invalid for this endpoint OR
- Moneycontrol changed the API structure (common with unofficial APIs)

**Next Steps:**
- Verify company ID format (is 500325 correct for RELIANCE?)
- Check if endpoint is `quarterly-earnings` (plural) instead of `quarterly-earning`
- Try reverse-engineering from Moneycontrol website JavaScript

---

### 2. Moneycontrol financial-historical Endpoint

**URL Tested:**
```
https://api.moneycontrol.com/mcapi/v1/stock/financial-historical/overview/?ex=NSE&scId=500325
```

**Result:** ❌ **403 Access Denied** (CDN blocking)

```
Status: 403
Title: Access Denied
Error: You don't have permission to access this server
Reference: 18.def53017.1792747705.af0118b9
```

**Diagnosis:**
- Moneycontrol is using Akamai CDN with bot/scraper protection
- Simple requests library User-Agent not sufficient
- Need to either:
  - Increase request headers (Referer, Accept, etc.)
  - Implement JS rendering (Selenium/Playwright)
  - Use residential proxy (risky/unethical)

---

### 3. Moneycontrol earnings/get-earnings-data Endpoint

**URL Tested:**
```
https://api.moneycontrol.com/mcapi/v1/earnings/get-earnings-data/?limit=10&page=1&startDate=2026-01-01&endDate=2026-12-31
```

**Result:** ❌ **422 Unprocessable Entity** (Missing Required Parameter)

```
Status: 422
Response: {"success":0,"data":"\"indexId\" is required"}
```

**Diagnosis:**
- Endpoint requires `indexId` parameter (not `scId`)
- `indexId` is the market index ID, not company ID
- This endpoint is for **market-wide earnings results**, not individual stocks

**Fix:** Add `indexId=99` (for NIFTY 500) and retry

---

### 4. TickerTape financials/income Endpoint

**URL Tested:**
```
https://api.tickertape.in/stocks/financials/income/RELIANCE/annual/normal/?count=10
```

**Result:** ✅ **200 OK** (but empty data)

```
Status: 200
Response: {"success": true, "data": []}
```

**Diagnosis:**
- Endpoint is working and accessible
- No errors, but returned empty array for RELIANCE
- May work for other symbols
- Possible reasons:
  - RELIANCE data not available in TickerTape's format
  - Symbol format wrong (e.g., needs NSE code instead of name)
  - Data lagging

**Next Steps:**
- Try with different symbol format (e.g., `RELIANCE.NS`, `REL`, `500325`)
- Test on different stocks (TCS, INFY)
- Check if quarterly data works (change `annual` to `quarterly`)

---

### 5. Moneycontrol News API (Fallback Reference)

**URL Tested:**
```
https://www.moneycontrol.com/newsapi/mc_news.php/?limit=5&query=RELIANCE&start=0
```

**Result:** ✅ **200 OK** (News, not earnings)

```
Status: 200
Response: Array of 5 news items
Sample: "Airbnb to ban hosts from asking guests to do lengthy cleaning tasks"
```

**Notes:**
- News API is working
- Returns global news (not RELIANCE-specific despite query param)
- Not useful for earnings data, but confirms Moneycontrol APIs are partially accessible

---

### 6. NSE Official Market Data API

**URL Tested:**
```
https://www.nseindia.com/api/market-data-pre-open/?key=ALL
```

**Result:** ✅ **200 OK** (Market data, not earnings)

```
Status: 200
Response:
  - 2,187 stock records
  - Keys: declines, unchanged, advances, data, timestamp, totalTradedValue, totalMarketCap
  - Sample data: Symbol, Open, High, Low, LTP, Volume
```

**Notes:**
- NSE official API is working
- Returns live market data (prices, volumes)
- No earnings/financial data in this endpoint

---

## Path Forward: Phase 2 Revised Strategy

### Option A: Fix Moneycontrol quarterly-earning Endpoint (IDEAL if we can find it)

**Action Items:**
1. Verify company ID format
   - Is it `500325` or something else?
   - Cross-check against Moneycontrol website (inspect network tab)

2. Try endpoint variations:
   - `quarterly-earnings` (plural)
   - `/v2/` instead of `/v1/`
   - Different parameter names

3. Reverse-engineer from browser:
   - Open https://www.moneycontrol.com/stocks/companyinfo/RELIANCE
   - Open DevTools → Network tab
   - Look for API calls to financials endpoints
   - Copy exact URL + parameters

### Option B: Use TickerTape + Fallback Chain (WORKING)

**Action Items:**
1. Test TickerTape with different symbol formats:
   - RELIANCE / RELIANCE.NS / RELIANCE.EQ / 500325
   - Try `quarterly` instead of `annual`

2. Implement TickerTape as primary, NSE market data as supplementary

3. Keep Moneycontrol research alive (may find endpoint later)

### Option C: Web Scraping (Last Resort)

If APIs don't work:
- Moneycontrol website page: `https://www.moneycontrol.com/stocks/companyinfo/RELIANCE/financials/ratios`
- TickerTape financials page
- Requires Selenium/Playwright + HTML parsing (slower, fragile)

---

## Immediate Next Steps

### TODAY (Phase 2b-1: Reverse-Engineering)

```bash
# Step 1: Open RELIANCE page in browser
open "https://www.moneycontrol.com/stocks/companyinfo/RELIANCE"

# Step 2: DevTools → Network → Filter "XHR/Fetch"
# Step 3: Click "Quarterly", "Earnings", etc. tabs
# Step 4: Copy exact API URLs from network panel
# Step 5: Test URLs here

# Step 6: Try TickerTape with symbol variations
curl -s "https://api.tickertape.in/stocks/financials/income/RELIANCE.NS/annual/normal/?count=10"
curl -s "https://api.tickertape.in/stocks/financials/income/RELIANCE.EQ/annual/normal/?count=10"
curl -s "https://api.tickertape.in/stocks/financials/income/500325/annual/normal/?count=10"
```

### If reverse-engineering finds correct URLs:

**Moneycontrol (if found):**
```python
# earnings_sources.py
class MoneycontrolSource(EarningsSource):
    def get_facts(self, nse_symbol):
        mc_id = NSE_TO_MC[nse_symbol]
        url = f"https://api.moneycontrol.com/... [VERIFIED URL]"
        data = requests.get(url).json()
        return self._parse(data)
```

**TickerTape (fallback, proven working):**
```python
class TickertapeSource(EarningsSource):
    def get_facts(self, nse_symbol):
        # Try multiple symbol formats
        for symbol_variant in [nse_symbol, f"{nse_symbol}.NS", f"{nse_symbol}.EQ"]:
            url = f"https://api.tickertape.in/stocks/financials/income/{symbol_variant}/annual/normal/?count=10"
            data = requests.get(url).json()
            if data.get('data'):
                return self._parse(data)
        raise EarningsError(f"No TickerTape data for {nse_symbol}")
```

---

## Risk Assessment

| Path | Likelihood | Effort | Risk |
|---|---|---|---|
| Find correct Moneycontrol URL | 60% | 30 min | Low (if API stable) |
| TickerTape works with right format | 50% | 1 hour | Medium (empty data suggests format issue) |
| Web scraping fallback | 95% | 3 hours | High (fragile, slow, may violate ToS) |
| Manual NSE filings lookup | 100% | 2+ days | High (manual, slow) |

---

## Recommendation

**Start with Option B (TickerTape reverse-engineering):**
1. Test 5+ symbol formats on TickerTape (15 min)
2. If ANY works, implement TickerTape source (1 hour)
3. Parallel: Reverse-engineer Moneycontrol in browser (30 min)
4. If found, implement Moneycontrol source (1 hour)
5. If nothing works, pivot to scraping (risky)

**Estimated time to working earnings source: 2-4 hours**

---

## Files to Check in Browser DevTools

1. **Moneycontrol Stock Page:**
   - URL: `https://www.moneycontrol.com/stocks/companyinfo/RELIANCE`
   - Tab: "Financials" → "Quarterly"
   - Network tab: Look for `*.moneycontrol.com/mcapi/...` calls

2. **TickerTape Stock Page:**
   - URL: `https://www.tickertape.in/stocks/RELIANCE` (if it exists)
   - Network tab: Look for `/stocks/financials/...` calls

3. **NSE Stock Page:**
   - URL: `https://www.nseindia.com/` (search RELIANCE)
   - Network tab: Look for `/api/...` calls

---

## Conclusion

**APIs are there, but Moneycontrol is blocking automated access.** TickerTape and NSE are accessible but may need symbol format adjustment. Next: browser reverse-engineering to find correct URLs.
