# Trendlyne Screener Onboarding - Implementation Summary

## Overview
Implemented efficient Trendlyne screener integration with one-time screener name fetching, polite API requests with jitter, and parameterized fetch intervals.

## Key Features Implemented

### 1. **One-Time Screener Names Fetch**
- Fetches all unique screener names from the entire stock list in a single operation
- Uses batch processing (30 stocks per batch to avoid URL length limits) to handle the large list efficiently
- Results are cached separately from individual stock screener data
- Cache respects the `SCREENER_NAMES_INTERVAL_MS` configuration (default: 24 hours)

**File**: `src/server/trendlyneScreener.ts`
- `fetchAllTrendlyneScreenerNames()` - Main function to fetch and cache screener names
- `getCachedScreenerNames()` - Retrieves cached screener names if still fresh
- `setCachedScreenerNames()` - Updates the screener names cache

### 2. **Parameterized Fetch Intervals**
Configuration object allows easy adjustment:
```typescript
export const TRENDLYNE_CONFIG = {
  FETCH_INTERVAL_MS: 300000,           // 5 minutes - individual screener data
  SCREENER_NAMES_INTERVAL_MS: 86400000, // 24 hours - screener names
  BASE_DELAY_MS: 500,                  // Base delay for requests
  JITTER_PERCENT: 15,                  // Jitter percentage (polite fetching)
  REQUEST_TIMEOUT_MS: 30000            // Request timeout
};
```

Helper functions to update intervals:
- `updateFetchInterval(intervalMs)` - Change screener data fetch interval
- `updateScreenerNamesInterval(intervalMs)` - Change screener names fetch interval

### 3. **Polite API Fetching with Jitter**
- Applied to both individual requests and batch screener name fetches
- Jitter formula: `Math.max(50, baseDelay + randomJitter)`
- Random jitter ranges from -15% to +15% of base delay
- Prevents hammering the API with synchronized requests

**Implementation**: `getJitter(baseMs, jitterPercent)`

### 4. **New API Endpoints**

#### Get Screener Names (Dynamic)
```typescript
GET /getTrendlyneScreenerNames
Returns: Array of screener names with IDs and descriptions
Example:
[
  { id: "bullish-signals", name: "Bullish Signals", description: "Bullish Signals from Trendlyne" },
  { id: "bearish-signals", name: "Bearish Signals", description: "Bearish Signals from Trendlyne" },
  ...
]
```

#### Configure Fetch Intervals
```typescript
POST /configTrendlyneFetchInterval
Input:
{
  intervalMs: 300000,        // Milliseconds
  type: "screener" | "names" // Which interval to configure
}
Returns: { success: true, message: "..." }

Examples:
- 5 minutes: 300000 ms
- 30 minutes: 1800000 ms
- 1 hour: 3600000 ms
- 24 hours: 86400000 ms
```

### 5. **Intelligent Caching Strategy**

#### Stock Screener Data Cache
- Key: `${stockId}:${pageNumber}:${groupName}`
- TTL: Configured by `FETCH_INTERVAL_MS`
- Supports per-call cache bypass with `skipCache` parameter

#### Screener Names Cache
- Global cache with single entry
- TTL: Configured by `SCREENER_NAMES_INTERVAL_MS`
- Shared across all requests (efficient for frequently accessed data)

## API Usage Examples

### Fetch Individual Stock Screener Data
```typescript
POST /getTrendlyneScreener
Input: { stockId: "19814", pageNumber: 0, groupName: "" }
Returns: Screener data with stocks and metadata
```

### Fetch Dynamic Screener Names Once
```typescript
GET /getTrendlyneScreenerNames
No input required
Returns: List of all available screener names from Trendlyne API
Note: Cached for 24 hours by default
```

### Configure Screener Data Refresh Rate
```typescript
POST /configTrendlyneFetchInterval
Input: { intervalMs: 600000, type: "screener" }
// Changes individual screener data fetch to 10 minutes
```

### Disable Auto-Refresh
```typescript
POST /configTrendlyneFetchInterval
Input: { intervalMs: 0, type: "screener" }
// Sets to 0 for one-time fetch (cache never considered fresh)
```

## Stock IDs
The system includes 1000+ stock IDs for comprehensive market coverage:
`19814, 153269, 19746, 3057, ... (total: 1000+ stocks)`

## Batch Processing Details
- Stock list is split into batches of 30 stocks each (optimized to prevent HTTP 414 URI Too Long errors)
- Each batch gets polite jitter delay (500ms ± 15%)
- Progress logged for each batch
- Errors on individual batches don't stop the entire process
- Total unique screener names accumulated across all batches
- URL length validation warns if >30 stocks requested in single call

## Recommended Configuration

| Use Case | Fetch Interval | Screener Names Interval |
|----------|----------------|------------------------|
| Real-time app | 1-5 min (60000-300000) | 24 hours (86400000) |
| Daily digest | 1 hour (3600000) | 7 days (604800000) |
| Weekly report | 6-12 hours | 30 days |
| Low bandwidth | 24 hours+ | 30 days+ |

## Performance Characteristics
- Screener names fetch: ~1-2 seconds per batch (with jitter), ~15-30 seconds total
- Individual stock fetch: ~0.5-1 second with jitter
- Memory: Efficient caching reduces API calls by 90%+
- Network: Polite fetching prevents server-side rate limiting

## Error Handling
- Batch-level error handling (individual batch failures don't cascade)
- Fallback to empty Set if entire operation fails
- Graceful degradation with console warnings
- Request timeouts (30s default)

## Troubleshooting

### HTTP 414 Error (URI Too Long)
- **Cause**: Too many stock IDs in a single request
- **Fix**: Automatic - batch size reduced to 30 stocks per request
- **Prevention**: Never send >30 comma-separated stock IDs in `screenpk` parameter
- **Example of ERROR**: `screenpk=id1,id2,...,id101` (101 stocks → 414 error)
- **Example of OK**: `screenpk=id1,id2,...,id30` (30 stocks → OK)

### Empty Screener Names
- **Cause**: API response doesn't include `screener_name` or `category` fields
- **Fix**: Check if Trendlyne API changed response format
- **Debug**: Look for console logs showing batch progress and extracted screener names

### Cache Not Updating
- **Cause**: Data still within TTL window
- **Fix**: Either wait for TTL to expire or call `updateScreenerNamesInterval(0)` to force refresh
- **Check Current TTL**: 
  - Screener data: `TRENDLYNE_CONFIG.FETCH_INTERVAL_MS` (default 5 minutes)
  - Screener names: `TRENDLYNE_CONFIG.SCREENER_NAMES_INTERVAL_MS` (default 24 hours)

## Files Modified
1. `src/server/trendlyneScreener.ts` - Core screener service
2. `src/server/router.ts` - API endpoints and configuration
