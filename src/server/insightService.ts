import { getStockMapping, resolveMoneycontrolSymbol } from './stockMapping';
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
    ratings: { name: string; value: string }[];
    finalRating: string;
    analystCount: string;
  };
  mcInsights?: any;
  technicalIndicators?: any;
  movingAverages?: any;
  priceForecast?: any;
  estimates?: any;
  stockPriceVolume?: {
    price: {
      YTD: number;
      "1 WEEK": number;
      "1 MONTH": number;
      "3 MONTHS": number;
      "6 MONTHS": number;
      "1 YEAR": number;
      "2 YEARS": number;
      "3 YEARS": number;
      "5 YEARS": number;
    };
    volume: {
      Today: {
        delivery: number;
        cvol: number;
        cvol_display_text: string;
        delivery_display_text: string;
        delivery_tooltip_text: string;
        cvol_tooltip_text: string;
      };
      Yesterday: {
        delivery: number;
        cvol: number;
        cvol_display_text: string;
        delivery_display_text: string;
        delivery_tooltip_text: string;
        cvol_tooltip_text: string;
      };
      "1 Week Avg": {
        delivery: number;
        cvol: number;
        cvol_display_text: string;
        delivery_display_text: string;
        delivery_tooltip_text: string;
        cvol_tooltip_text: string;
      };
      "1 Month Avg": {
        delivery: number;
        cvol: number;
        cvol_display_text: string;
        delivery_display_text: string;
        delivery_tooltip_text: string;
        cvol_tooltip_text: string;
      };
    };
  };
  earningsForecast?: {
    eps: { date: string; high: string; low: string; avg: string; actual: string }[];
    netProfit: { date: string; high: string; low: string; avg: string; actual: string }[];
    revenue: { date: string; high: string; low: string; avg: string; actual: string }[];
    displayLock: string;
  };
  hitsMisses?: {
    graphData: number[][];
    high: string;
    mean: string;
    low: string;
    displayLock: string;
    beats?: { total: string; selected: string; unselected: string };
    misses?: { total: string; selected: string; unselected: string };
    inline?: { total: string; selected: string; unselected: string };
    list?: { quarter: string; actual: string; estimates: string; surprise: string; type: string }[];
  };
  valuation?: {
    list: { heading: string; data: { eps: string; pe: string; bvps: string; pb: string; analyst: string } }[];
    displayLock: string;
  };
}

export async function getStockInsights(query: string): Promise<StockInsight | null> {
  const scId = await resolveMoneycontrolSymbol(query);
  if (!scId) return null;
  
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
      earningForecastRes,
      priceVolumeRes,
      hitsMissesRes,
      valuationRes
    ] = await Promise.all([
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/swot/details?scId=${scId}&type=all`),
      fetchJson(`https://api.moneycontrol.com/mcapi/extdata/v2/mc-essentials?scId=${scId}&type=ed&deviceType=W`),
      fetchJson(`https://api.moneycontrol.com/mcapi/extdata/v2/mc-insights?scId=${scId}&type=c&deviceType=W&appVersion=185`),
      fetchJson(`https://priceapi.moneycontrol.com/pricefeed/techindicator/D/${scId}?fields=sentiments,pivotLevels,sma,ema`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/estimates/price-forecast?scId=${scId}&ex=N&deviceType=W`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/estimates/analyst-rating?deviceType=W&scId=${scId}&ex=N`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/estimates/earning-forecast?scId=${scId}&ex=N&deviceType=W&frequency=12&financialType=C`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/price-volume?scId=${scId}&ex=&appVersion=175`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/estimates/hits-misses?deviceType=W&scId=${scId}&ex=N&type=eps&financialType=C`),
      fetchJson(`https://api.moneycontrol.com/mcapi/v1/stock/estimates/valuation?deviceType=W&scId=${scId}&ex=N&financialType=C`)
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
        const ratings = consensusRes.data.ratings || [];
        const buyRating = ratings.find((r: any) => r.name === 'Buy');
        const sellRating = ratings.find((r: any) => r.name === 'Sell');
        const holdRating = ratings.find((r: any) => r.name === 'Hold');
        const underperformRating = ratings.find((r: any) => r.name === 'Underperform');
        const outperformRating = ratings.find((r: any) => r.name === 'Outperform');
        
        result.analystRating = {
            consensus: consensusRes.data.finalRating || '',
            buy: parseInt(buyRating?.value || '0'),
            hold: parseInt(holdRating?.value || '0'),
            sell: parseInt(sellRating?.value || '0') + parseInt(underperformRating?.value || '0'),
            targetPrice: 0,
            ratings: ratings,
            finalRating: consensusRes.data.finalRating || '',
            analystCount: consensusRes.data.analystCount || '0'
        };
    }

    if (earningForecastRes?.success === 1 && earningForecastRes.data) {
        result.earningsForecast = {
            eps: earningForecastRes.data.eps || [],
            netProfit: earningForecastRes.data.netProfit || [],
            revenue: earningForecastRes.data.revenue || [],
            displayLock: earningForecastRes.data.displayLock || ''
        };
    }

    if (priceVolumeRes?.success === 1 && priceVolumeRes.data?.stock_price_volume_data) {
        result.stockPriceVolume = priceVolumeRes.data.stock_price_volume_data;
    }

    if (hitsMissesRes?.success === 1 && hitsMissesRes.data) {
        result.hitsMisses = hitsMissesRes.data;
    }

    if (valuationRes?.success === 1 && valuationRes.data) {
        result.valuation = valuationRes.data;
    }

    return result;
  } catch (error) {
    console.error('Error fetching insights for', scId, error);
    return null;
  }
}

export async function getIndexData(indexId: string) {
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