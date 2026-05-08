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
  mcInsights?: any;
  technicalIndicators?: any;
  movingAverages?: any;
  priceForecast?: any;
  estimates?: any;
}

export async function getStockInsights(query: string): Promise<StockInsight | null> {
  const mapping = getStockMapping(query);
  if (!mapping) return null;

  const scId = mapping.mcsymbol;
  
  try {
    const fetchJson = async (url: string) => {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        return res.ok ? await res.json() : null;
      } catch (e) {
        return null;
      }
    };

    const [
      swotRes,
      essentialsRes,
      mcInsights,
      techIndRes,
      forecastRes,
      consensusRes,
      earningForecastRes
    ] = await Promise.all([
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/swot/details?scId=${scId}&type=all`),
      fetchJson(`https://api.moneycontrol.com/mcapi/extdata/v2/mc-essentials?scId=${scId}&type=ed&deviceType=W`),
      fetchJson(`https://api.moneycontrol.com/mcapi/extdata/v2/mc-insights?scId=${scId}&type=c&deviceType=W&appVersion=185`),
      fetchJson(`https://priceapi.moneycontrol.com/pricefeed/techindicator/D/${scId}?fields=sentiments,pivotLevels,sma,ema`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/estimates/price-forecast?scId=${scId}&ex=N&deviceType=W`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/estimates/consensus?scId=${scId}&ex=N&deviceType=W`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/estimates/earning-forecast?scId=${scId}&ex=N&deviceType=W&frequency=12&financialType=C`)
    ]);

    const result: StockInsight = {};

    if (swotRes?.success === 1 && swotRes.data) {
      result.swot = {
        strengths: swotRes.data.strengths?.info || [],
        weaknesses: swotRes.data.weaknesses?.info || [],
        opportunities: swotRes.data.opportunities?.info || [],
        threats: swotRes.data.threats?.info || []
      };
    } else if (mcInsights?.success === 1 && mcInsights.data?.swot) {
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

    if (mcInsights?.success === 1 && mcInsights.data) {
        result.technicalTrend = mcInsights.data.classification?.name;
        result.mcInsights = mcInsights.data;
    }

    if (techIndRes?.code === '200' && techIndRes.data) {
        result.technicalIndicators = techIndRes.data.sentiments;
        result.movingAverages = {
            sma: techIndRes.data.sma,
            ema: techIndRes.data.ema
        };
    }

    if (forecastRes?.success === 1 && forecastRes.data) {
        result.priceForecast = forecastRes.data;
    }

    if (consensusRes?.success === 1 && consensusRes.data) {
        result.analystRating = {
            consensus: consensusRes.data.consensus || '',
            buy: consensusRes.data.buyPercentage || 0,
            hold: consensusRes.data.holdPercentage || 0,
            sell: consensusRes.data.sellPercentage || 0,
            targetPrice: consensusRes.data.targetPrice || 0
        };
    }

    if (earningForecastRes?.success === 1 && earningForecastRes.data) {
        result.estimates = earningForecastRes.data;
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
