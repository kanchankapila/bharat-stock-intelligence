import stockData, { StockMapping } from '../data/stocklist';

const _bySymbol = new Map<string, StockMapping>(stockData.map(s => [s.symbol.toUpperCase(), s]));
const _byName   = new Map<string, StockMapping>(stockData.map(s => [s.name.toUpperCase(), s]));
const _byMcSym  = new Map<string, StockMapping>(stockData.map(s => [s.mcsymbol.toUpperCase(), s]));
const _byIsin   = new Map<string, StockMapping>(stockData.map(s => [s.isin.toUpperCase(), s]));
const _byTlid   = new Map<string, StockMapping>(stockData.map(s => [s.tlid, s]));

export function getStockMapping(query: string): StockMapping | undefined {
  if (!query) return undefined;
  const q = query.toUpperCase();
  return _bySymbol.get(q) ?? _byName.get(q) ?? _byMcSym.get(q) ?? _byIsin.get(q) ?? _byTlid.get(query);
}

/**
 * Returns all mapped tickers for a given stock symbol/name
 */
export function getStockTickers(query: string) {
  const mapping = getStockMapping(query);
  if (!mapping) return null;
  return {
    mcsymbol: mapping.mcsymbol,
    tlid: mapping.tlid,
    tlname: mapping.tlname,
    isin: mapping.isin,
    symbol: mapping.symbol,
    stockid: mapping.stockid,
    companyid: mapping.companyid
  };
}

// In-memory cache to avoid redundant API calls
const scIdCache = new Map<string, string>();

export async function resolveMoneycontrolSymbol(query: string): Promise<string | null> {
  if (!query) return null;
  const upperQuery = query.toUpperCase();
  
  // 1. Check hardcoded mapping first
  const mapping = getStockMapping(upperQuery);
  if (mapping && mapping.mcsymbol) {
    return mapping.mcsymbol;
  }
  
  // 2. Check cache
  if (scIdCache.has(upperQuery)) {
    return scIdCache.get(upperQuery) || null;
  }

  // 3. Fallback to Moneycontrol autocomplete API
  try {
    const res = await fetch(`https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?query=${encodeURIComponent(upperQuery)}&type=1&format=json`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      signal: AbortSignal.timeout(10000)
    });
    
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        // Try to find exact match by looking for the symbol in the display name
        const exactMatch = data.find(item => {
           const matchText = (item.pdt_dis_nm || "").toUpperCase();
           // Common formats in MC: "... <span>INE..., SYMBOL, ..." or just matching the name
           return matchText.includes(` ${upperQuery},`) || 
                  matchText.includes(`, ${upperQuery},`) ||
                  matchText.includes(`, ${upperQuery}<`);
        });
        
        if (exactMatch && exactMatch.sc_id) {
          scIdCache.set(upperQuery, exactMatch.sc_id);
          return exactMatch.sc_id;
        }
        
        // If no exact symbol match, just return the first one as best effort
        if (data[0].sc_id) {
          scIdCache.set(upperQuery, data[0].sc_id);
          return data[0].sc_id;
        }
      }
    }
  } catch (error) {
    console.error(`Error resolving Moneycontrol scId for ${query}:`, error);
  }
  
  return null;
}

export function getAllStocks(): StockMapping[] {
  return stockData;
}

/**
 * Returns the NSE symbol for a given MoneyControl mcsymbol (scId)
 */
export function getSymbolFromMcsymbol(mcsymbol: string): string | null {
  if (!mcsymbol) return null;
  const upper = mcsymbol.toUpperCase();
  const found = stockData.find(s => s.mcsymbol.toUpperCase() === upper);
  return found ? found.symbol : null;
}

export interface IndexMapping {
  symbol: string;
  name: string;
  id: string;
}

export const indexData: IndexMapping[] = [
  { symbol: 'in;SEN', name: 'SENSEX', id: '4' },
  { symbol: 'in;NSX', name: 'NIFTY 50', id: '9' },
  { symbol: 'in;ccx', name: 'NIFTY Midcap 100', id: '27' },
  { symbol: 'in;cnxs', name: 'NIFTY Smallcap 100', id: '53' },
  { symbol: 'in;cjn', name: 'NIFTY NEXT 50', id: '6' },
  { symbol: 'in;ncx', name: 'NIFTY 500', id: '7' },
  { symbol: 'IN;aox', name: 'BSE Auto', id: '20' },
  { symbol: 'in;bip', name: 'BSE IPO', id: '33' },
  { symbol: 'IN;bkx', name: 'BSE BANKEX', id: '18' },
  { symbol: 'IN;CDX', name: 'BSE Cons Durables', id: '16' },
  { symbol: 'IN;CGX', name: 'BSE CAP GOODS', id: '13' },
  { symbol: 'IN;MLX', name: 'BSE Metal', id: '21' },
  { symbol: 'IN;ogx', name: 'BSE Oil & Gas', id: '22' },
  { symbol: 'in;pbx', name: 'BSE PSU', id: '11' },
  { symbol: 'in;rea', name: 'BSE REALTY', id: '29' },
  { symbol: 'in;tkx', name: 'BSE TECk', id: '10' },
  { symbol: 'IN;NTL', name: 'BSE 100', id: '1' },
  { symbol: 'IN;SEI', name: 'BSE 200', id: '2' },
  { symbol: 'IN;BNX', name: 'BSE 500', id: '12' },
  { symbol: 'in;bpo', name: 'BSE POWER', id: '30' },
  { symbol: 'in;mfy', name: 'NIFTY MIDCAP 50', id: '31' },
  { symbol: 'in;nnx', name: 'NIFTY 100', id: '28' },
  { symbol: 'in;nbx', name: 'NIFTY BANK', id: '23' },
  { symbol: 'in;cnit', name: 'NIFTY IT', id: '19' },
  { symbol: 'in;crl', name: 'NIFTY REALTY', id: '34' },
  { symbol: 'in;cfr', name: 'NIFTY INFRA', id: '35' },
  { symbol: 'in;cgy', name: 'NIFTY ENERGY', id: '38' },
  { symbol: 'in;cfm', name: 'NIFTY FMCG', id: '39' },
  { symbol: 'in;cxc', name: 'NIFTY MNC', id: '40' },
  { symbol: 'in;cpr', name: 'NIFTY PHARMA', id: '41' },
  { symbol: 'in;cps', name: 'NIFTY PSE', id: '42' },
  { symbol: 'in;cuk', name: 'NIFTY PSU BANK', id: '43' },
  { symbol: 'in;crv', name: 'NIFTY SERV SECTOR', id: '44' },
  { symbol: 'in;cnmx', name: 'NIFTY MEDIA', id: '50' },
  { symbol: 'in;CNXM', name: 'NIFTY METAL', id: '51' },
  { symbol: 'in;cnxa', name: 'NIFTY AUTO', id: '52' },
  { symbol: 'in;IDXN', name: 'India VIX', id: '36' },
  { symbol: 'mc;finsrv', name: 'Nifty FinSrv', id: '47' },
  { symbol: 'mc;alphalo', name: 'NIFTY AlphaLowVol 30', id: 'mc;alphalo' },
  { symbol: 'mc;nmotm30', name: 'Nifty200 Momentum 30', id: 'mc;nmotm30' }
];

export function getIndexMapping(query: string): IndexMapping | undefined {
  if (!query) return undefined;
  const upperQuery = query.toUpperCase();
  return indexData.find(idx => 
    idx.symbol.toUpperCase() === upperQuery || 
    idx.name.toUpperCase() === upperQuery ||
    idx.id === query
  );
}

export function getStockMappingByTLId(tlId: string): StockMapping | undefined {
  if (!tlId) return undefined;
  return stockData.find(s => s.tlid === tlId);
}

export function getStockMappingByName(name: string): StockMapping | undefined {
  if (!name) return undefined;
  const upperName = name.toUpperCase();
  return stockData.find(s => s.name.toUpperCase() === upperName || s.tlname.toUpperCase() === name.toLowerCase().replace(/ /g, '-'));
}
