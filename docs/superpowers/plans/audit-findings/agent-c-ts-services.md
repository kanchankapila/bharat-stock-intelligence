# Findings — src/server business/data-service layer audit

## CRASH
(none found with high confidence — retry loops are capped, divide-by-zero guarded in confluence/correlation/quant math, JSON.parse calls in the trading-signal critical path are try/caught.)

## SILENT

- `src/server/insightService.ts:242-260` (`getIndexData`) | SILENT | On any fetch failure (or non-JSON response) the `catch (e) {}` swallows the error and the function falls through to a **hardcoded fake index snapshot** (`NIFTY 50 @ 22450.30`) that looks like live data to every caller. | Return `null`/throw on failure instead of a fabricated quote, and log the error; let the caller decide on a fallback.
- `src/server/insightService.ts:244` | SILENT | Same fetch has no `AbortSignal.timeout`, so a hung MoneyControl index endpoint stalls indefinitely before falling through to the fake data above. | Add `signal: AbortSignal.timeout(10000)` per repo convention.
- `src/server/stockMapping.ts:54` | SILENT | The MoneyControl autosuggest fallback resolver (used when a symbol isn't in the 180-stock `stocklist.ts`) has no timeout — a hang here blocks ticker resolution for any code path relying on this fallback, with no visible error. | Add `AbortSignal.timeout(10000)`.
- `src/server/fnoService.ts:191, 282` | SILENT | NiftyTrader expiry lookup and Trendlyne F&O heatmap fetches have no timeout while sibling fetches in the same file (lines 229, 261) do — inconsistent, and a hang silently stalls F&O signal generation. | Add `AbortSignal.timeout(...)` to match the other calls in this file.
- `src/server/marketIntelService.ts:463, 476, 501, 531, 578` | SILENT | Five fetches (NiftyTrader symbol list, option chain, India VIX, live/EOD market screener POSTs) have no timeout; failures/hangs here feed screener and options intelligence with no bound. | Add `AbortSignal.timeout(10000)` consistently.
- `src/server/niftytraderService.ts:65,70,75` | SILENT | Three parallel `Promise.all` fetches for industry/analysis/financial data have no timeout — one slow leg blocks all three and stalls the caller. | Add `AbortSignal.timeout(...)` to each.
- `src/server/topMoversService.ts:30` | SILENT | Top movers fetch has no timeout, unlike most other fetchers in this slice. | Add `AbortSignal.timeout(10000)`.
- `src/server/globalMarketService.ts:22` | SILENT | Global market data fetch has no timeout; failure path returns `[]` silently (acceptable) but a hang is unbounded. | Add timeout.
- `src/server/technicalSignalsService.ts:909, 999` | SILENT | Anthropic AI-insight call and Telegram notification fetch both lack timeouts; the Telegram one is already wrapped in try/catch that only logs, so a hang there stalls signal delivery for no visible reason. | Add `AbortSignal.timeout(...)` to both.
- `src/server/marketData.ts:24, 61, 73, 189, 244, 288, 315, 355` | SILENT | Eight of nine fetches in this file omit the timeout that line 227 correctly uses — inconsistent and each is an unbounded-hang risk in a file that backs technical scan data (`technicalScanner.ts` imports from it). | Standardize all fetches here on `AbortSignal.timeout(10000)`.
- `src/server/etnow.ts:94` | SILENT | ETnow screener POST has no timeout. | Add `AbortSignal.timeout(10000)`.
- `src/server/ollamaManager.ts:10` | SILENT | Ollama health-check fetch has no timeout; if Ollama hangs (vs. erroring/refusing), `isOllamaAvailable()` never resolves, which can stall any caller awaiting it before falling back to Gemini. | Add a short `AbortSignal.timeout(2000-3000)`.
- `src/server/mcApiService.ts:344` | MINOR/SILENT | `try { return JSON.parse(text); } catch { return null; }` silently discards the raw response body on parse failure with no logging, making "MoneyControl changed their response format" invisible until scores go stale. | Log `text.slice(0,200)` on parse failure.

## MINOR

- `src/server/scoringService.ts:229` | MINOR | `catch {}` around `JSON.parse(run.records_json)` silently drops a malformed `screener_runs.records_json`; downstream `if (!symbols.length) return []` makes this safe but the root cause (corrupt run row) goes unlogged. | Add a `console.warn` in the catch.
- `src/server/technicalScanner.ts:35-37, 129-131` | MINOR | Both `catch (e) { console.error(...) }` blocks log but otherwise degrade silently (return `null` / continue); acceptable given they're cache-read/cache-write paths, but worth noting cache misses are indistinguishable from corruption. | No change required; informational only.
- `src/server/correlationService.ts` / `quantScoringWorker.ts` / `confluenceEngine.ts` | MINOR | Reviewed for unguarded `parseFloat`/`Number`/divide-by-zero in the scoring math — all guarded correctly (`denominator === 0 ? 0 : ...`, `traded > 0 && !isNaN(...)`, `NaN || 0` idiom). No action needed; noted as a clean spot-check.

## Ticker/symbol resolution
No violations found in this slice: `moneycontrolScreener.ts`, `moneycontrolService.ts`, `symbolResolver.ts`, and `trendlyneChecklistCycle.ts` all read `mcsymbol`/`tlid`/`stockid` from DB or `stocklist.ts` rather than constructing them. `niftytraderService.ts` and `tradebrainsService.ts` pass the raw NSE symbol directly to their APIs (both providers accept the NSE symbol natively), which is the documented exception, not a violation.

## Retry loops
`mcApiService.ts:316` (`mcFetchJson`), `liveStockData.ts`, `trendlyneAuthService.ts`, and `fundamentalsSyncService.ts` all use bounded retry counts with exponential backoff — no infinite-retry risk found.

**Highest-priority fix**: `insightService.ts` `getIndexData` returning fabricated index data on failure is the most dangerous finding — it's indistinguishable from real data to any consumer and could silently drive trading decisions off a static, years-stale snapshot.
