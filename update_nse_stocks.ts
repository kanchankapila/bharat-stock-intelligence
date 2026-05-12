import fs from 'fs';
import { nseStocksData } from './src/data/nseStocks';

const csv = fs.readFileSync('EQUITY_L.csv', 'utf-8');
const lines = csv.split('\n');

const existingMap = new Map();
for (const stock of nseStocksData) {
  existingMap.set(stock.symbol, stock);
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

const allStocks = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  
  const parts = parseCSVLine(line);
  if (parts.length < 7) continue;

  const symbol = parts[0];
  const name = parts[1];
  const series = parts[2];
  const listing_date = parts[3];
  const isin = parts[6];

  if (!['EQ', 'BE', 'SM'].includes(series)) continue;

  if (existingMap.has(symbol)) {
    allStocks.push(existingMap.get(symbol));
    existingMap.delete(symbol);
  } else {
    let formattedDate = listing_date;
    try {
      const months: Record<string, string> = { 'JAN':'01', 'FEB':'02', 'MAR':'03', 'APR':'04', 'MAY':'05', 'JUN':'06', 'JUL':'07', 'AUG':'08', 'SEP':'09', 'OCT':'10', 'NOV':'11', 'DEC':'12' };
      if (listing_date.includes('-')) {
        const [d, m, y] = listing_date.split('-');
        if (months[m.toUpperCase()]) {
           formattedDate = `${y}-${months[m.toUpperCase()]}-${d.padStart(2, '0')}`;
        }
      }
    } catch(e) {}

    allStocks.push({
      symbol,
      name,
      sector: 'Unknown',
      industry: 'Unknown',
      isin,
      listing_date: formattedDate
    });
  }
}

for (const stock of existingMap.values()) {
  allStocks.push(stock);
}

allStocks.sort((a, b) => a.symbol.localeCompare(b.symbol));

const fileContent = `// Comprehensive NSE Stock List with Metadata
// This file contains all major NSE listed stocks with sector and industry information

export interface NSEStock {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  isin: string;
  listing_date?: string;
}

export const nseStocksData: NSEStock[] = ${JSON.stringify(allStocks, null, 2)};

export function getNSEStockBySymbol(symbol: string): NSEStock | undefined {
  return nseStocksData.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());
}

export function getNSEStocksBySector(sector: string): NSEStock[] {
  return nseStocksData.filter(s => s.sector.toLowerCase() === sector.toLowerCase());
}

export function getNSEStocksByIndustry(industry: string): NSEStock[] {
  return nseStocksData.filter(s => s.industry.toLowerCase() === industry.toLowerCase());
}

export function searchNSEStocks(query: string): NSEStock[] {
  if (!query) return [];
  const lowerQuery = query.toLowerCase();
  return nseStocksData.filter(s => 
    s.symbol.toLowerCase().includes(lowerQuery) || 
    s.name.toLowerCase().includes(lowerQuery)
  );
}

export function getAllNSEStocks(): NSEStock[] {
  return nseStocksData;
}
`;

fs.writeFileSync('src/data/nseStocks.ts', fileContent, 'utf-8');
console.log('Updated src/data/nseStocks.ts with ' + allStocks.length + ' stocks.');
