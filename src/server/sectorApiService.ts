import { mcFetchJson } from './mcApiService';

export interface SectorTrendStock {
  sc_id: string;
  name: string;
  currTrend: string;
  currPrice: string;
  currTimestamp: string;
  prevTrendDate: string;
  prevTrend: string;
  prevTrendClose: string;
  performance: string;
  slugUrl: string;
}

export async function fetchSectorTechnicalTrends(sectorName: string): Promise<{
  bullish: SectorTrendStock[];
  bearish: SectorTrendStock[];
}> {
  // Normalize sector names (e.g. "Software & IT Services" -> "Software & IT Services")
  // MoneyControl expectations: "Finance", "Chemicals", "Capital Goods", "Healthcare", "Software & IT Services", etc.
  const bullishUrl = `https://priceapi.moneycontrol.com/technicalCompanyData/categoryTechnicalTrend/uptrend/turningBullish/sector?categoryValue=${encodeURIComponent(sectorName)}&sort=performance&order=asc&deviceType=W`;
  const bearishUrl = `https://priceapi.moneycontrol.com/technicalCompanyData/categoryTechnicalTrend/downtrend/turningBearish/sector?categoryValue=${encodeURIComponent(sectorName)}&sort=performance&order=asc&deviceType=W`;

  try {
    const [bullishRes, bearishRes] = await Promise.all([
      mcFetchJson<any>(bullishUrl),
      mcFetchJson<any>(bearishUrl)
    ]);

    const bullish: SectorTrendStock[] = [];
    if (bullishRes?.data && typeof bullishRes.data === 'object') {
      Object.values(bullishRes.data).forEach((item: any) => {
        if (item && item.sc_id) bullish.push(item);
      });
    }

    const bearish: SectorTrendStock[] = [];
    if (bearishRes?.data && typeof bearishRes.data === 'object') {
      Object.values(bearishRes.data).forEach((item: any) => {
        if (item && item.sc_id) bearish.push(item);
      });
    }

    return { bullish, bearish };
  } catch (err) {
    console.error(`[SectorTrends] Failed to fetch technical trends for ${sectorName}:`, err);
    return { bullish: [], bearish: [] };
  }
}
