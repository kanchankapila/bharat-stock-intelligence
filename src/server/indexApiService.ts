import { mcFetchJson } from './mcApiService';

export interface IndexOverview {
  stkexchg: string;
  exchange: string;
  ind_id: string;
  lastprice: string;
  change: string;
  percentchange: string;
  direction: string;
  open: string;
  high: string;
  low: string;
  prevclose: string;
  yearlyhigh: string;
  yearlylow: string;
  ytd: string;
  week1: string;
  month1: string;
  month3: string;
  month6: string;
  year1: string;
  year2: string;
  year3: string;
  year5: string;
  dayavg30: string;
  dayavg50: string;
  dayavg150: string;
  dayavg200: string;
  lastupdated: string;
  bridgesymbol: string;
  market_state: string;
}

export interface IndexFundamentals {
  pe: string;
  pb: string;
  divYield: string;
  sectorWeights: { sector: string; weight: string }[];
}

export interface IndexConstituent {
  symbol: string;
  name: string;
  lastPrice: string;
  change: string;
  percentChange: string;
}

export async function fetchIndianIndices() {
  const url = `https://api.moneycontrol.com/mcapi/v1/indices/get-indian-indices`;
  return mcFetchJson<any>(url);
}

export async function fetchIndexFullDetails(indId: string) {
  const url = `https://appfeeds.moneycontrol.com/jsonapi/market/indices&format=json&ind_id=${indId}`;
  return mcFetchJson<any>(url);
}

export async function fetchIndexFundamentals(indId: string) {
  const url = `https://api.moneycontrol.com/mcapi/v1/indices/fundamentals/overview?indId=${indId}`;
  const res = await mcFetchJson<any>(url);
  if (!res || res.success !== 1 || !res.data) return null;
  
  const d = res.data;
  return {
    pe: d.ttmPe,
    pb: d.pb,
    divYield: d.div_yield,
    sectorWeights: d.sector_weights?.map((sw: any) => ({
      sector: sw.sector_name,
      weight: sw.weight
    })) || []
  };
}

export async function fetchIndexConstituents(indId: string, type: '0' | '1' = '0') {
  const url = `https://appfeeds.moneycontrol.com/jsonapi/market/marketmap&format=json&type=${type}&ind_id=${indId}`;
  return mcFetchJson<any>(url);
}

export async function fetchIndexTechnicals(period: 'D' | 'W' | 'M', bridgeSymbol: string) {
  const encoded = encodeURIComponent(bridgeSymbol);
  const url = `https://priceapi.moneycontrol.com/pricefeed/techindicator/${period}/${encoded}`;
  return mcFetchJson<any>(url);
}

export async function fetchAdvanceDecline(ex: string = 'N') {
  const url = `https://api.moneycontrol.com/mcapi/v1/indices/chart/exchange-advdec?ex=${ex}`;
  return mcFetchJson<any>(url);
}

export async function fetchIndexGraph(indId: string, range: string = '1d', type: string = 'line') {
  const url = `https://appfeeds.moneycontrol.com/jsonapi/market/graph&format=json&ind_id=${indId}&range=${range}&type=${type}`;
  return mcFetchJson<any>(url);
}
