/**
 * Centralized Symbol Resolver (PHASE 2 FIX)
 * 
 * Provides unified symbol resolution across all data sources (NSE, MC, Trendlyne, ETnow).
 * Eliminates scattered mapping logic and provides single source of truth for symbol resolution.
 * 
 * Symbol Resolution Hierarchy (tried in order):
 * 1. Hardcoded stocklist.ts (180 major stocks, highest priority)
 * 2. Database nse_stocks table (2000+ NSE stocks)
 * 3. API fallbacks (MoneyControl autocomplete, Trendlyne, etc.)
 * 
 * Usage:
 *   const resolver = SymbolResolver.getInstance();
 *   const mapping = resolver.resolveSymbol('TCS');  // → NSE symbol
 *   const mcSymbol = resolver.resolveMCSymbol('TCS');  // → MoneyControl symbol
 *   const tlId = resolver.resolveTrendlyneId('TCS');  // → Trendlyne ID
 */

import db from './db';
import stockData, { StockMapping } from '../data/stocklist';
import { resolveMoneycontrolSymbol, getStockMapping } from './stockMapping';

type SymbolSource = 'NSE' | 'MC' | 'TL' | 'ET' | 'YAHOO';

interface SymbolRecord {
  nseSymbol: string;
  mcSymbol?: string;
  tlId?: string;
  tlName?: string;
  yahooSymbol?: string;
  etSymbol?: string;
  isin?: string;
  companyName: string;
  sector?: string;
  industry?: string;
  source: SymbolSource;
  lastUpdated: string;
}

interface ResolutionResult {
  nseSymbol: string;
  mcSymbol?: string;
  tlId?: string;
  yahooSymbol?: string;
  companyName: string;
  confidence: number;  // 0-100: how confident is this mapping
  source: SymbolSource;
}

export class SymbolResolver {
  private static instance: SymbolResolver;
  private cache: Map<string, SymbolRecord> = new Map();
  private initialized: boolean = false;

  private constructor() {}

  public static getInstance(): SymbolResolver {
    if (!SymbolResolver.instance) {
      SymbolResolver.instance = new SymbolResolver();
    }
    return SymbolResolver.instance;
  }

  /**
   * Initialize resolver: load all symbols into cache
   * Call this once at application startup
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('[SymbolResolver] Initializing symbol cache...');
    
    // 1. Load from hardcoded stocklist (highest priority)
    for (const stock of stockData) {
      const key = stock.symbol.toUpperCase();
      this.cache.set(key, {
        nseSymbol: stock.symbol,
        mcSymbol: stock.mcsymbol,
        tlId: stock.tlid,
        tlName: stock.tlname,
        isin: stock.isin,
        companyName: stock.name,
        source: 'NSE',
        lastUpdated: new Date().toISOString(),
      });
    }

    // 2. Load from NSE master list in DB (extends coverage)
    try {
      const nseStocks = db.prepare(`
        SELECT DISTINCT 
          symbol AS nseSymbol, 
          company_name AS companyName,
          sector,
          industry
        FROM nse_stocks
        LIMIT 2000
      `).all() as any[];

      for (const stock of nseStocks) {
        const key = stock.nseSymbol.toUpperCase();
        if (!this.cache.has(key)) {  // Don't override hardcoded mappings
          this.cache.set(key, {
            nseSymbol: stock.nseSymbol,
            companyName: stock.companyName,
            sector: stock.sector,
            industry: stock.industry,
            source: 'NSE',
            lastUpdated: new Date().toISOString(),
          });
        }
      }
    } catch (err: any) {
      console.warn('[SymbolResolver] Could not load NSE stocks from DB:', err.message);
    }

    this.initialized = true;
    console.log(`[SymbolResolver] Initialized with ${this.cache.size} symbols`);
  }

  /**
   * Resolve a symbol query to NSE symbol
   * Accepts: NSE symbol, company name, MC symbol, Trendlyne ID, ISIN
   */
  public resolveSymbol(query: string): ResolutionResult | null {
    if (!query) return null;

    const upperQuery = query.toUpperCase();

    // 1. Direct cache lookup (NSE symbol)
    if (this.cache.has(upperQuery)) {
      const record = this.cache.get(upperQuery)!;
      return this._toResolutionResult(record, 100);
    }

    // 2. Search by company name (partial match)
    for (const [_, record] of this.cache) {
      if (record.companyName.toUpperCase().includes(upperQuery)) {
        return this._toResolutionResult(record, 80);
      }
    }

    // 3. Search by MC symbol
    for (const [_, record] of this.cache) {
      if (record.mcSymbol?.toUpperCase() === upperQuery) {
        return this._toResolutionResult(record, 90);
      }
    }

    // 4. Search by ISIN
    for (const [_, record] of this.cache) {
      if (record.isin?.toUpperCase() === upperQuery) {
        return this._toResolutionResult(record, 95);
      }
    }

    // 5. Search by Trendlyne ID
    for (const [_, record] of this.cache) {
      if (record.tlId === query) {
        return this._toResolutionResult(record, 90);
      }
    }

    // 6. Fallback to hardcoded stocklist (for edge cases)
    const hardcoded = getStockMapping(query);
    if (hardcoded) {
      const record: SymbolRecord = {
        nseSymbol: hardcoded.symbol,
        mcSymbol: hardcoded.mcsymbol,
        tlId: hardcoded.tlid,
        tlName: hardcoded.tlname,
        isin: hardcoded.isin,
        companyName: hardcoded.name,
        source: 'NSE',
        lastUpdated: new Date().toISOString(),
      };
      return this._toResolutionResult(record, 85);
    }

    return null;
  }

  /**
   * Resolve to MoneyControl symbol
   */
  public async resolveMCSymbol(query: string): Promise<string | null> {
    const resolved = this.resolveSymbol(query);
    if (!resolved) return null;

    if (resolved.mcSymbol) return resolved.mcSymbol;

    // Fallback: Try MC API
    try {
      const mc = await resolveMoneycontrolSymbol(query);
      if (mc) {
        // Update cache
        this._updateCacheWithMCSymbol(resolved.nseSymbol, mc);
      }
      return mc;
    } catch {
      return null;
    }
  }

  /**
   * Resolve to Trendlyne ID
   */
  public resolveTrendlyneId(query: string): string | null {
    const resolved = this.resolveSymbol(query);
    if (!resolved) return null;
    return resolved.tlId || null;
  }

  /**
   * Batch resolve multiple symbols
   */
  public resolveBatch(queries: string[]): Map<string, ResolutionResult> {
    const results = new Map<string, ResolutionResult>();
    for (const query of queries) {
      const resolved = this.resolveSymbol(query);
      if (resolved) {
        results.set(query.toUpperCase(), resolved);
      }
    }
    return results;
  }

  /**
   * Get all symbols matching a pattern
   */
  public searchSymbols(pattern: string, limit: number = 20): ResolutionResult[] {
    const upperPattern = pattern.toUpperCase();
    const results: ResolutionResult[] = [];

    for (const [_, record] of this.cache) {
      if (
        record.nseSymbol.toUpperCase().includes(upperPattern) ||
        record.companyName.toUpperCase().includes(upperPattern)
      ) {
        results.push(this._toResolutionResult(record, 70));
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Update cache with newly discovered MC symbol mapping
   */
  private _updateCacheWithMCSymbol(nseSymbol: string, mcSymbol: string): void {
    const key = nseSymbol.toUpperCase();
    const record = this.cache.get(key);
    if (record) {
      record.mcSymbol = mcSymbol;
      record.lastUpdated = new Date().toISOString();
    }
  }

  /**
   * Convert internal record to resolution result
   */
  private _toResolutionResult(record: SymbolRecord, confidence: number): ResolutionResult {
    return {
      nseSymbol: record.nseSymbol,
      mcSymbol: record.mcSymbol,
      tlId: record.tlId,
      yahooSymbol: record.yahooSymbol,
      companyName: record.companyName,
      confidence,
      source: record.source,
    };
  }

  /**
   * Clear cache (useful for testing or manual refresh)
   */
  public clearCache(): void {
    this.cache.clear();
    this.initialized = false;
  }

  /**
   * Get cache statistics
   */
  public getStats(): { totalSymbols: number; symbolsWithMC: number; symbolsWithTL: number } {
    let symbolsWithMC = 0;
    let symbolsWithTL = 0;

    for (const [_, record] of this.cache) {
      if (record.mcSymbol) symbolsWithMC++;
      if (record.tlId) symbolsWithTL++;
    }

    return {
      totalSymbols: this.cache.size,
      symbolsWithMC,
      symbolsWithTL,
    };
  }
}

// Lazy-loaded singleton export (don't initialize on import)
let _instance: SymbolResolver | null = null;
export function getSymbolResolver(): SymbolResolver {
  if (!_instance) {
    _instance = SymbolResolver.getInstance();
  }
  return _instance;
}
