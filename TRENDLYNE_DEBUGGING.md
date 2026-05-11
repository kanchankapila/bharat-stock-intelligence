# Trendlyne Screener Debugging Guide

## Quick Start - Testing the API

### 1. **Test API Connection**
Click the "🧪 Test API" button in the Trendlyne Screeners panel on the dashboard. Check browser console (F12) for output.

Expected console output:
```
🧪 Testing Trendlyne API...
🔍 Testing API with URL: https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/?...
📊 Response Status: 200
📋 Raw API Response: { result: [...], ... }
✅ Parsed Stocks: [...]
📌 Available Fields in First Stock: [...]
```

### 2. **Check Browser Console (F12)**
Open Developer Tools → Console tab to see:
- ✅ Success logs (green)
- ❌ Error logs (red)
- 📊 API responses and data structure

### 3. **Fetch Screener Names**
The panel should automatically fetch screener names when loaded. Look for:
- "Loading screener names from API..." - still fetching
- Categories with names - success
- Error message - check API

## API Endpoints for Testing

### Get Screener Names (Dynamic)
```bash
# Using curl
curl "http://localhost:3000/api/trpc/getTrendlyneScreenerNames"

# In browser console
fetch('/api/trpc/getTrendlyneScreenerNames')
  .then(r => r.json())
  .then(d => console.log(d))
```

### Test Single Stock
```bash
curl "http://localhost:3000/api/trpc/testTrendlyneApi?input={\"stockId\":\"19814\"}"
```

### Get Screener Data
```bash
curl "http://localhost:3000/api/trpc/getTrendlyneScreener?input={\"stockId\":\"19814\",\"pageNumber\":0}"
```

## Common Issues and Fixes

### Issue 1: "No screener results found"
**Cause**: API returning empty data or error

**Debug Steps**:
1. Click "🧪 Test API" button
2. Check console for error message
3. Look at "Response Status" - should be 200
4. Check "Raw API Response" structure

**Fix**:
- If status 414: URL too long (batch size too large) - **FIXED, should work now**
- If status 500: Server error
- If empty result: No stocks for that screener

### Issue 2: "Categories not loading"
**Cause**: Screener names API request failed

**Debug Steps**:
1. Check footer shows error message
2. Open console (F12)
3. Look for error in getTrendlyneScreenerNames query
4. Try "Test API" to verify connectivity

**Fix**:
- Fallback hardcoded categories should appear automatically
- Check network tab in DevTools for failed requests
- Verify API endpoint exists in router

### Issue 3: "Loading forever"
**Cause**: Request timeout or hanging

**Debug Steps**:
1. Open DevTools → Network tab
2. Look for pending requests
3. Check if requests timeout after 30s

**Fix**:
- Page refresh
- Check if Trendlyne API is accessible: visit https://kayal.trendlyne.com/ in browser
- Check server logs for errors

### Issue 4: "Wrong number of stocks"
**Cause**: Batching or filtering issue

**Debug Steps**:
1. Check console logs during fetch
2. Look for "Batch X: Extracted Y screeners" messages
3. Verify stock count in response

## Configuration

### Change Fetch Interval
Open browser console and run:
```javascript
// Change screener data refresh to 10 minutes (600000 ms)
fetch('/api/trpc/configTrendlyneFetchInterval', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    json: { intervalMs: 600000, type: 'screener' }
  })
}).then(r => r.json()).then(d => console.log(d))

// Change screener names refresh to 12 hours (43200000 ms)
fetch('/api/trpc/configTrendlyneFetchInterval', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    json: { intervalMs: 43200000, type: 'names' }
  })
}).then(r => r.json()).then(d => console.log(d))

// Disable caching (always fetch fresh)
fetch('/api/trpc/configTrendlyneFetchInterval', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    json: { intervalMs: 0, type: 'screener' }
  })
}).then(r => r.json()).then(d => console.log(d))
```

## Understanding API Response

### Success Response Structure
```javascript
{
  success: true,
  data: [
    {
      stockId: "19814",
      name: "BHARTIARTL",
      ltp: 245.50,
      change: 2.15,
      changePercent: 0.88,
      screenerName: "Bullish Signals",
      screenerType: "all-in-one",
      // ... other fields from API
    }
  ],
  screenerName: "Trendlyne All-in-One Screener",
  totalResults: 45
}
```

### Error Response Structure
```javascript
{
  success: false,
  data: [],
  totalResults: 0
}
```

## Server Logs

Check server console for:
```
✅ Batch 1: Extracted 15 unique screeners
✅ Batch 2: Extracted 28 unique screeners
✅ Total unique screener names cached: 28
📊 Fetching Trendlyne screeners with category: all
✅ Received 45 stocks from Trendlyne
```

## Network Issues

If API requests fail with CORS or network errors:
1. Check if Trendlyne API is up: https://kayal.trendlyne.com/
2. Check if server is running on correct port
3. Verify CORS headers are correct
4. Check firewall/proxy settings

## Performance

### Expected Load Times
- Screener names fetch: 15-30 seconds (first time, then cached)
- Stock data fetch: 0.5-2 seconds per batch
- Category filter switch: <100ms

### Caching Strategy
- Screener names: cached 24 hours by default
- Stock data: cached 5 minutes by default
- Clear cache by setting interval to 0

## Files to Check

1. **Backend**:
   - `src/server/trendlyneScreener.ts` - Core API logic
   - `src/server/router.ts` - Endpoints and configuration

2. **Frontend**:
   - `src/components/TrendlyneScreenerPanel.tsx` - UI and hooks

3. **Logs**:
   - Browser console (F12)
   - Server terminal output

## Contact Support

If issues persist:
1. Share browser console output (F12)
2. Share server terminal output
3. Share API test result from "🧪 Test API" button
4. Specify error message and expected behavior
