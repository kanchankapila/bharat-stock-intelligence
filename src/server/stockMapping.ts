import stockData, { StockMapping } from '../data/stocklist';

export function getStockMapping(query: string): StockMapping | undefined {
  if (!query) return undefined;
  const upperQuery = query.toUpperCase();
  return stockData.find(s => 
    s.symbol.toUpperCase() === upperQuery || 
    s.name.toUpperCase() === upperQuery ||
    s.mcsymbol.toUpperCase() === upperQuery
  );
}

export function getAllStocks(): StockMapping[] {
  return stockData;
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
