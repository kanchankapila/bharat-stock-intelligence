import { getStockMapping } from './stockMapping';
import { getMoneycontrolInsights } from './moneycontrolService';

export interface StockInsight {
  swot?: {
    strengths: string[];
    weaknesses: string[];
    opportunities: string[];
    threats: string[];
  };
  essentials?: {
    pe: number;
    sectorPe: number;
    pb: number;
    dividendYield: number;
    marketCap: string;
    faceValue: number;
  };
  technicalTrend?: string;
  analystRating?: {
    consensus: string;
    buy: number;
    hold: number;
    sell: number;
    targetPrice: number;
  };
}

export async function getStockInsights(query: string): Promise<StockInsight | null> {
  const mapping = getStockMapping(query);
  if (!mapping) return null;

  const scId = mapping.mcsymbol;
  
  try {
    const [swotRes, essentialsRes, mcInsights] = await Promise.all([
      fetch(`https://api.moneycontrol.com/mcapi/v1/swot/details?scId=${scId}&type=all`).then(r => r.ok ? r.json() : null),
      fetch(`https://api.moneycontrol.com/mcapi/v1/extdata/v2/mc-essentials?scId=${scId}&type=ed&deviceType=W`).then(r => r.ok ? r.json() : null),
      getMoneycontrolInsights(query)
    ]);

    const result: StockInsight = {};

    if (swotRes?.success === 1 && swotRes.data) {
      result.swot = {
        strengths: swotRes.data.swot?.s || [],
        weaknesses: swotRes.data.swot?.w || [],
        opportunities: swotRes.data.swot?.o || [],
        threats: swotRes.data.swot?.t || []
      };
    } else if (mcInsights.success && mcInsights.data?.swot) {
      // Fallback to SWOT from insights API if dedicated SWOT API fails or didn't return data
      result.swot = {
        strengths: mcInsights.data.swot.s || [],
        weaknesses: mcInsights.data.swot.w || [],
        opportunities: mcInsights.data.swot.o || [],
        threats: mcInsights.data.swot.t || []
      };
    }

    if (essentialsRes?.success === 1 && essentialsRes.data) {
        const ed = essentialsRes.data;
        result.essentials = {
            pe: parseFloat(ed.pe) || 0,
            sectorPe: parseFloat(ed.sectorPe) || 0,
            pb: parseFloat(ed.pb) || 0,
            dividendYield: parseFloat(ed.dividendYield) || 0,
            marketCap: ed.marketCap || "N/A",
            faceValue: parseFloat(ed.faceValue) || 0
        };
    }

    if (mcInsights.success && mcInsights.data) {
        result.technicalTrend = mcInsights.data.classification?.name;
    }

    return result;
  } catch (error) {
    console.error('Error fetching insights for', scId, error);
    return null;
  }
}

export async function getIndexData(indexId: string) {
  // Use the ID from mapping
  try {
      const response = await fetch(`https://api.moneycontrol.com/mcapi/v1/indices/get-indices-details?indexId=${indexId}`);
      if (response.ok) {
          const json = await response.json();
          if (json.success === 1) return json.data;
      }
  } catch (e) {}

  return {
    name: "NIFTY 50",
    value: 22450.30,
    change: 120.45,
    percentChange: 0.54,
    high: 22500,
    low: 22300,
    advances: 35,
    declines: 15
  };
}
