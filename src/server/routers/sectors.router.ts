import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure } from '../trpc';
import { dbAll, dbGet } from '../dbAsync';
import { fetchWithCache } from '../cacheService';
import {
  fetchAllIndianIndices,
  fetchSectorPerformance,
  fetchSectorAdvanceDecline,
  fetchSectorStocks,
  fetchIndexStocksList,
} from '../marketData';
import { fetchIndexFullDetails, fetchIndexFundamentals, fetchIndexTechnicals } from '../indexApiService';
import { fetchSectorTechnicalTrends } from '../sectorApiService';
import { getOrRefreshAllStocks } from '../liveStockData';
import { generateStockAnalysis } from '../../services/aiService';

// Standard mapping between Sector definitions, MoneyControl IDs, and Database Taxonomy
export interface SectorDefinition {
  id: string;
  name: string;
  indId: string;
  bridgeSymbol: string;
  dbSector: string;
  mcSlug?: string;
  benchmark: 'SP500' | 'CRUDE' | 'GOLD' | 'DXY';
  defaultPicks: Array<{ symbol: string; rationale: string }>;
  coreCatalysts: string[];
}

export const SECTOR_DEFINITIONS: SectorDefinition[] = [
  {
    id: 'nifty-bank',
    name: 'NIFTY Bank',
    indId: '23',
    bridgeSymbol: 'in;nbx',
    dbSector: 'Financials',
    mcSlug: 'banks',
    benchmark: 'DXY',
    defaultPicks: [
      { symbol: 'HDFCBANK', rationale: 'Credit growth revival & private bank valuation mean reversion' },
      { symbol: 'ICICIBANK', rationale: 'Industry-leading ROA (>2.3%) and robust asset quality' },
      { symbol: 'AXISBANK', rationale: 'Strong retail deposit franchise & NIM stabilization' },
    ],
    coreCatalysts: ['RBI Repo Rate & Liquidity stance', 'Credit offtake vs deposit growth gap', 'Gross/Net NPA cycle lows'],
  },
  {
    id: 'nifty-it',
    name: 'NIFTY IT',
    indId: '19',
    bridgeSymbol: 'in;cnit',
    dbSector: 'Information Technology',
    mcSlug: 'telecom', // closest tech slug
    benchmark: 'SP500',
    defaultPicks: [
      { symbol: 'TCS', rationale: 'Megadeal pipeline conversion & defensive operating margin profile' },
      { symbol: 'INFY', rationale: 'Large BFSI enterprise cloud & generative AI migration ramp' },
      { symbol: 'PERSISTENT', rationale: 'High-growth midcap IT leader outperforming tier-1 peers' },
    ],
    coreCatalysts: ['US Fed interest rate trajectory', 'Nasdaq tech sentiment', 'BFSI & discretionary enterprise IT spending'],
  },
  {
    id: 'nifty-auto',
    name: 'NIFTY Auto',
    indId: '52',
    bridgeSymbol: 'in;cnxa',
    dbSector: 'Consumer Discretionary',
    mcSlug: 'capital-goods',
    benchmark: 'SP500',
    defaultPicks: [
      { symbol: 'TATAMOTORS', rationale: 'JLR order book stability and EV commercial leadership in India' },
      { symbol: 'M&M', rationale: 'Dominant SUV market share and robust farm equipment resilience' },
      { symbol: 'BAJAJ-AUTO', rationale: 'Triumph ramp-up and recovering export volume growth' },
    ],
    coreCatalysts: ['Festive & rural retail volume dispatches', 'Commodity input costs (Steel/Aluminium)', 'EV adoption rate'],
  },
  {
    id: 'nifty-pharma',
    name: 'NIFTY Pharma',
    indId: '41',
    bridgeSymbol: 'in;cpr',
    dbSector: 'Healthcare',
    mcSlug: 'healthcare',
    benchmark: 'SP500',
    defaultPicks: [
      { symbol: 'SUNPHARMA', rationale: 'Specialty global pipeline ramp and robust domestic formulation cashflow' },
      { symbol: 'CIPLA', rationale: 'Inhalation franchise leadership in US and dominant chronic portfolio' },
      { symbol: 'LUPIN', rationale: 'US generics price stabilization & strong gSpiriva traction' },
    ],
    coreCatalysts: ['US generic price erosion moderation', 'USFDA audit clearance rates', 'Domestic chronic therapy expansion'],
  },
  {
    id: 'nifty-fmcg',
    name: 'NIFTY FMCG',
    indId: '39',
    bridgeSymbol: 'in;cfm',
    dbSector: 'Consumer Staples',
    mcSlug: 'fmcg',
    benchmark: 'SP500',
    defaultPicks: [
      { symbol: 'ITC', rationale: 'Cigarette volume stability with strong hotel demerger value unlocking' },
      { symbol: 'HINDUNILVR', rationale: 'Rural demand pickup with margin expansion as palm oil cools' },
      { symbol: 'NESTLEIND', rationale: 'Premium packaged food volume elasticity & deep distribution moat' },
    ],
    coreCatalysts: ['Rural wage growth & monsoon distribution', 'Raw material commodity basket (Palm oil, Wheat, Sugar)', 'Defensive rotation in volatile markets'],
  },
  {
    id: 'nifty-metal',
    name: 'NIFTY Metal',
    indId: '51',
    bridgeSymbol: 'IN;CNXM',
    dbSector: 'Materials',
    mcSlug: 'metals-mining',
    benchmark: 'GOLD',
    defaultPicks: [
      { symbol: 'TATASTEEL', rationale: 'Domestic capacity expansion and European turnaround restructuring' },
      { symbol: 'JINDALSTEL', rationale: 'Lowest cost producer with massive Angul capacity expansion' },
      { symbol: 'HINDALCO', rationale: 'Novelis beverage can demand rebound and elevated aluminium spreads' },
    ],
    coreCatalysts: ['China stimulus & industrial demand', 'LME base metal price momentum', 'Domestic infrastructure capex'],
  },
  {
    id: 'nifty-energy',
    name: 'NIFTY Energy',
    indId: '38',
    bridgeSymbol: 'in;cgy',
    dbSector: 'Energy',
    mcSlug: 'oil-gas',
    benchmark: 'CRUDE',
    defaultPicks: [
      { symbol: 'RELIANCE', rationale: 'Oil-to-Chemicals GRM stability paired with Jio & Retail monetization' },
      { symbol: 'NTPC', rationale: 'Aggressive green energy capex with regulated 15.5% ROE thermal base' },
      { symbol: 'ONGC', rationale: 'Robust domestic crude realization & high dividend yield protection' },
    ],
    coreCatalysts: ['Brent crude oil price volatility', 'Gross Refining Margins (GRMs)', 'Power peak demand & green hydrogen transition'],
  },
  {
    id: 'nifty-realty',
    name: 'NIFTY Realty',
    indId: '34',
    bridgeSymbol: 'in;crl',
    dbSector: 'Real Estate',
    mcSlug: 'infrastructure',
    benchmark: 'SP500',
    defaultPicks: [
      { symbol: 'DLF', rationale: 'Unmatched luxury launch momentum and zero net-debt balance sheet' },
      { symbol: 'GODREJPROP', rationale: 'Aggressive land acquisition and record pre-sales booking volume' },
      { symbol: 'OBEROIRLTY', rationale: 'High-margin MMR luxury residential & annuity asset ramp' },
    ],
    coreCatalysts: ['Home loan interest rates', 'Tier-1 residential inventory absorption', 'Commercial office SEZ leasing'],
  },
  {
    id: 'nifty-infra',
    name: 'NIFTY Infra',
    indId: '35',
    bridgeSymbol: 'in;cfr',
    dbSector: 'Industrials',
    mcSlug: 'infrastructure',
    benchmark: 'SP500',
    defaultPicks: [
      { symbol: 'LT', rationale: 'Record order book (>₹4.7 Lakh Cr) with robust international GCC pipeline' },
      { symbol: 'BHARTIARTL', rationale: 'Sustained ARPU accretion & premium 5G subscriber migration' },
      { symbol: 'ULTRACEMCO', rationale: 'Market consolidation and pan-India cement pricing power' },
    ],
    coreCatalysts: ['Union budget capital expenditure execution', 'National Highway & Rail ordering pace', 'Private sector capex revival'],
  },
  {
    id: 'nifty-psu-bank',
    name: 'NIFTY PSU Bank',
    indId: '43',
    bridgeSymbol: 'in;cuk',
    dbSector: 'Financials',
    mcSlug: 'banks',
    benchmark: 'DXY',
    defaultPicks: [
      { symbol: 'SBIN', rationale: 'Systemic balance sheet fortress with industry-leading corporate credit pipeline' },
      { symbol: 'BANKBARODA', rationale: 'Strong retail loan momentum and healthy net interest margins' },
      { symbol: 'CANBK', rationale: 'Lowest price-to-book multiple with continuous ROE expansion (>18%)' },
    ],
    coreCatalysts: ['Treasury gains on bond yield movements', 'Cleaned up corporate balance sheets', 'PSU dividend payout visibility'],
  },
  {
    id: 'nifty-fin-service',
    name: 'NIFTY Financial Services',
    indId: 'finsrv',
    bridgeSymbol: 'mc;finsrv',
    dbSector: 'Financials',
    mcSlug: 'finance',
    benchmark: 'DXY',
    defaultPicks: [
      { symbol: 'BAJFINANCE', rationale: 'Omnichannel consumer financing leadership with customer franchise compounding' },
      { symbol: 'CHOLAFIN', rationale: 'Vehicle finance revival & diversified new SME lending growth' },
      { symbol: 'SHRIRAMFIN', rationale: 'Used commercial vehicle financing strength with high net interest margins' },
    ],
    coreCatalysts: ['Retail consumer credit cycle', 'Cost of wholesale borrowing for NBFCs', 'Asset quality in unsecured loans'],
  },
  {
    id: 'nifty-media',
    name: 'NIFTY Media',
    indId: '50',
    bridgeSymbol: 'in;cnmx',
    dbSector: 'Communication Services',
    mcSlug: 'telecom',
    benchmark: 'SP500',
    defaultPicks: [
      { symbol: 'SUNTV', rationale: 'Regional broadcast monopoly with strong net cash balance sheet and high dividend yield' },
      { symbol: 'PVRINOX', rationale: 'Box office occupancy normalization and operating leverage in multiplexes' },
      { symbol: 'ZEEL', rationale: 'Cost rationalization and potential strategic alliances' },
    ],
    coreCatalysts: ['Digital advertising spending trends', 'OTT monetization & subscriber growth', 'Content acquisition costs'],
  },
];

// Helper to determine Analyst Stance & Trading Call from Quantitative data
function computeAnalystStance(
  rsRatio: number,
  rsMomentum: number,
  changePct: number,
  breadthAdvPct: number,
  screenerNetScore: number,
  pcr: number | null
): {
  stance: 'STRONG_OVERWEIGHT' | 'ACCUMULATE_DIPS' | 'NEUTRAL_SIDEWAYS' | 'PROFIT_BOOKING' | 'UNDERWEIGHT';
  stanceLabel: string;
  actionBadge: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  horizon: 'INTRADAY' | 'SWING (1-3W)' | 'POSITIONAL (1-3M)';
  verdict: string;
} {
  // Quantitative composite scoring
  let score = 0;
  if (rsRatio > 100) score += 2;
  if (rsMomentum > 100) score += 2;
  if (changePct > 0.5) score += 1;
  if (breadthAdvPct >= 65) score += 2;
  else if (breadthAdvPct <= 35) score -= 2;
  if (screenerNetScore > 100) score += 2;
  else if (screenerNetScore < -50) score -= 2;
  if (pcr !== null) {
    if (pcr >= 1.0) score += 1;
    else if (pcr <= 0.6) score -= 1;
  }

  if (score >= 6) {
    return {
      stance: 'STRONG_OVERWEIGHT',
      stanceLabel: 'Strong Overweight',
      actionBadge: 'Aggressive Long',
      riskLevel: 'LOW',
      horizon: 'POSITIONAL (1-3M)',
      verdict: 'High-conviction market leadership with expanding breadth and institutional accumulation. Maintain aggressive long positioning.',
    };
  } else if (score >= 2) {
    return {
      stance: 'ACCUMULATE_DIPS',
      stanceLabel: 'Accumulate on Dips',
      actionBadge: 'Buy on Pullback',
      riskLevel: 'MEDIUM',
      horizon: 'SWING (1-3W)',
      verdict: 'Constructive uptrend with supportive underlying momentum. Accumulate high-quality constituents on shallow intraday pullbacks.',
    };
  } else if (score >= -1) {
    if (rsRatio > 100 && rsMomentum < 100) {
      return {
        stance: 'PROFIT_BOOKING',
        stanceLabel: 'Profit Booking',
        actionBadge: 'Trim Longs / Trail SL',
        riskLevel: 'MEDIUM',
        horizon: 'SWING (1-3W)',
        verdict: 'Sector has had strong run-up but momentum is cooling. Recommend taking partial profits and trailing stop-losses on existing longs.',
      };
    }
    return {
      stance: 'NEUTRAL_SIDEWAYS',
      stanceLabel: 'Neutral / Consolidation',
      actionBadge: 'Range-bound / Selective',
      riskLevel: 'MEDIUM',
      horizon: 'INTRADAY',
      verdict: 'Sector is consolidating in a defined range without clear directional conviction. Restrict trading to range extremes or selective stock-specific setups.',
    };
  } else {
    return {
      stance: 'UNDERWEIGHT',
      stanceLabel: 'Underweight / Avoid',
      actionBadge: 'Avoid / Hedge',
      riskLevel: 'HIGH',
      horizon: 'SWING (1-3W)',
      verdict: 'Persistent underperformance vs NIFTY 50 with deteriorating breadth and net screener selling. Avoid fresh long exposure; viable short hedge candidate.',
    };
  }
}

export const sectorsRouter = router({
  // ─── 1. Main Overview: All Sectors + RRG + Breadth + Analyst Calls ─────────
  getSectorsOverview: publicProcedure.query(async () => {
    return fetchWithCache('sectors:overview:v2', async () => {
      // 1. Fetch live indices
      let keyIndicesList: any[] = [];
      try {
        const indData = await fetchAllIndianIndices();
        if (indData?.success === 1 && Array.isArray(indData.data?.indiceList)) {
          for (const group of indData.data.indiceList) {
            if (Array.isArray(group.list)) {
              keyIndicesList.push(...group.list);
            }
          }
        }
      } catch (err) {
        console.warn('[SectorsRouter] Failed to fetch Indian indices:', err);
      }

      // 2. Fetch Multi-timeframe performance from MoneyControl
      let perfMap = new Map<string, number>();
      try {
        const perfData1m = await fetchSectorPerformance({ dur: '1m', limit: 30 });
        if (perfData1m?.data) {
          for (const item of perfData1m.data) {
            perfMap.set((item.sectorName || item.sector || '').toLowerCase(), item.percentChange ?? item.mcapPerChange ?? 0);
          }
        }
      } catch (err) {
        console.warn('[SectorsRouter] Sector perf error:', err);
      }

      // 3. Fetch Advance / Decline Breadth from MoneyControl
      let adMap = new Map<string, { advances: number; declines: number; changePer: string }>();
      try {
        const adData = await fetchSectorAdvanceDecline();
        if (adData?.data && Array.isArray(adData.data)) {
          for (const row of adData.data) {
            const indexName = String(row.indexName || '').toLowerCase();
            adMap.set(indexName, {
              advances: Number(row.advance || 0),
              declines: Number(row.decline || 0),
              changePer: String(row.changePer || '0'),
            });
          }
        }
      } catch (err) {
        console.warn('[SectorsRouter] Sector A/D error:', err);
      }

      // 4. Query screener_sector_rotation for latest date
      let screenerMap = new Map<string, any>();
      try {
        const screenerRows = await dbAll<any>(`
          SELECT sector, bull_count, bear_count, net_score, tier1_bull_count, breadth_score, top_stocks, date
          FROM screener_sector_rotation
          WHERE date = (SELECT MAX(date) FROM screener_sector_rotation)
        `);
        for (const r of screenerRows) {
          screenerMap.set(r.sector.toLowerCase(), r);
        }
      } catch (err) {
        console.warn('[SectorsRouter] Screener sector rotation error:', err);
      }

      // 5. Query sector_fo_sentiment for latest options PCR
      let foMap = new Map<string, any>();
      try {
        const foRows = await dbAll<any>(`
          SELECT sector, sector_pcr, total_call_oi, total_put_oi, symbol_count, date
          FROM sector_fo_sentiment
          WHERE date = (SELECT MAX(date) FROM sector_fo_sentiment)
        `);
        for (const r of foRows) {
          foMap.set(r.sector.toLowerCase(), r);
        }
      } catch (err) {
        console.warn('[SectorsRouter] Sector F&O sentiment error:', err);
      }

      // 6. Query technical stats (% above 50 DMA, 200 DMA, avg RSI)
      let techStatsMap = new Map<string, { pctAbove50: number; pctAbove200: number; avgRsi: number }>();
      try {
        const techRows = await dbAll<any>(`
          SELECT ns.sector,
                 COUNT(*) as total_stocks,
                 SUM(CASE WHEN ts.cmp > ts.sma50 THEN 1 ELSE 0 END) as above_50,
                 SUM(CASE WHEN ts.above_sma200 = 1 OR ts.cmp > ts.sma200 THEN 1 ELSE 0 END) as above_200,
                 AVG(ts.rsi) as avg_rsi
          FROM technical_signals ts
          JOIN nse_stocks ns ON ns.symbol = ts.symbol
          WHERE ts.date = (SELECT MAX(date) FROM technical_signals)
            AND ns.sector IS NOT NULL AND ns.sector != ''
          GROUP BY ns.sector
        `);
        for (const r of techRows) {
          const total = Number(r.total_stocks) || 1;
          techStatsMap.set(r.sector.toLowerCase(), {
            pctAbove50: Math.round((Number(r.above_50) / total) * 100),
            pctAbove200: Math.round((Number(r.above_200) / total) * 100),
            avgRsi: Math.round(Number(r.avg_rsi) || 50),
          });
        }
      } catch (err) {
        console.warn('[SectorsRouter] Tech signals stats error:', err);
      }

      // 7. Get NIFTY 50 baseline for relative calculations
      const niftyIndex = keyIndicesList.find((i: any) =>
        i.name?.toUpperCase() === 'NIFTY 50' || i.name?.toUpperCase() === 'NIFTY'
      );
      const niftyChangePct = niftyIndex ? parseFloat(String(niftyIndex.changePer ?? '0')) : 0.0;

      // 8. Assemble comprehensive sector intelligence records
      const sectors = SECTOR_DEFINITIONS.map((def) => {
        // Match live index
        const matchedIndex = keyIndicesList.find((i: any) => {
          const u = (i.name || '').toUpperCase();
          const target = def.name.toUpperCase();
          return u === target || u.replace('NIFTY ', '') === target.replace('NIFTY ', '');
        });

        const parseNum = (v: unknown) => parseFloat(String(v ?? '0').replace(/,/g, '')) || 0;

        const liveValue = matchedIndex ? parseNum(matchedIndex.value) : 0;
        const liveChange = matchedIndex ? parseNum(matchedIndex.change) : 0;
        const liveChangePct = matchedIndex ? parseNum(matchedIndex.changePer) : 0;

        // Match Breadth
        const adEntry = Array.from(adMap.entries()).find(([name]) =>
          name.includes(def.name.toLowerCase().replace('nifty ', '')) ||
          name.includes(def.id.replace('nifty-', ''))
        )?.[1] || { advances: 0, declines: 0, changePer: '0' };

        const totalBreadth = adEntry.advances + adEntry.declines || 1;
        const advPct = Math.round((adEntry.advances / totalBreadth) * 100);

        // Match Screener
        const screener = screenerMap.get(def.dbSector.toLowerCase()) || {
          net_score: 0,
          bull_count: 0,
          bear_count: 0,
          tier1_bull_count: 0,
          breadth_score: 0,
          top_stocks: '[]',
        };

        let screenerTopStocks: string[] = [];
        try {
          screenerTopStocks = JSON.parse(screener.top_stocks || '[]');
        } catch { /* empty */ }

        // Match F&O
        const fo = foMap.get(def.dbSector.toLowerCase()) || null;
        const pcr = fo?.sector_pcr ? parseFloat(Number(fo.sector_pcr).toFixed(2)) : null;
        const callOi = fo?.total_call_oi ? Number(fo.total_call_oi) : null;
        const putOi = fo?.total_put_oi ? Number(fo.total_put_oi) : null;

        let foSentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
        if (pcr !== null) {
          if (pcr > 0.95) foSentiment = 'BULLISH';
          else if (pcr < 0.65) foSentiment = 'BEARISH';
        }

        let buildup: 'LONG_BUILDUP' | 'SHORT_COVERING' | 'SHORT_BUILDUP' | 'LONG_UNWINDING' = 'LONG_BUILDUP';
        if (liveChangePct >= 0) {
          buildup = pcr && pcr >= 0.8 ? 'LONG_BUILDUP' : 'SHORT_COVERING';
        } else {
          buildup = pcr && pcr <= 0.7 ? 'SHORT_BUILDUP' : 'LONG_UNWINDING';
        }

        // Match Technicals
        const tech = techStatsMap.get(def.dbSector.toLowerCase()) || {
          pctAbove50: 50,
          pctAbove200: 50,
          avgRsi: 50,
        };

        // Relative Strength (RS) & Relative Rotation Graph (RRG) coordinates
        // RS-Ratio: normalized relative return vs Nifty 50 (>100 is outperforming)
        // RS-Momentum: rate of change of relative return (>100 is accelerating)
        const relPerf1d = liveChangePct - niftyChangePct;
        const relPerf1m = (perfMap.get(def.dbSector.toLowerCase()) ?? (liveChangePct * 5)) - (niftyChangePct * 4);

        const rsRatio = parseFloat((100 + relPerf1m * 1.5).toFixed(2));
        const rsMomentum = parseFloat((100 + relPerf1d * 4).toFixed(2));

        let quadrant: 'LEADING' | 'WEAKENING' | 'LAGGING' | 'IMPROVING' = 'LEADING';
        if (rsRatio >= 100 && rsMomentum >= 100) quadrant = 'LEADING';
        else if (rsRatio >= 100 && rsMomentum < 100) quadrant = 'WEAKENING';
        else if (rsRatio < 100 && rsMomentum < 100) quadrant = 'LAGGING';
        else quadrant = 'IMPROVING';

        // Analyst Stance
        const analyst = computeAnalystStance(
          rsRatio,
          rsMomentum,
          liveChangePct,
          advPct,
          screener.net_score,
          pcr
        );

        // Curated Top Stock Picks
        const topPicks = def.defaultPicks.map((pick) => ({
          symbol: pick.symbol,
          rationale: pick.rationale,
          action: analyst.actionBadge,
        }));

        return {
          id: def.id,
          name: def.name,
          indId: def.indId,
          bridgeSymbol: def.bridgeSymbol,
          dbSector: def.dbSector,
          mcSlug: def.mcSlug,
          benchmark: def.benchmark,
          value: liveValue,
          change: liveChange,
          changePct: liveChangePct,
          breadth: {
            advances: adEntry.advances,
            declines: adEntry.declines,
            ratio: totalBreadth > 0 ? parseFloat((adEntry.advances / (adEntry.declines || 1)).toFixed(2)) : 1,
            advPct,
          },
          screener: {
            netScore: Number(screener.net_score || 0),
            bullCount: Number(screener.bull_count || 0),
            bearCount: Number(screener.bear_count || 0),
            tier1Count: Number(screener.tier1_bull_count || 0),
            breadthScore: parseFloat(Number(screener.breadth_score || 0).toFixed(1)),
            topStocks: screenerTopStocks.slice(0, 5),
          },
          derivatives: {
            pcr,
            callOi,
            putOi,
            sentiment: foSentiment,
            buildup,
          },
          technicals: tech,
          rrg: {
            rsRatio,
            rsMomentum,
            quadrant,
          },
          analyst: {
            ...analyst,
            catalysts: def.coreCatalysts,
            topPicks,
          },
        };
      });

      // Sort by live % change descending by default
      sectors.sort((a, b) => b.changePct - a.changePct);

      // Current market regime from technical_signals
      const regimeRow = await dbGet<any>(`
        SELECT nifty_regime FROM technical_signals
        WHERE nifty_regime IS NOT NULL ORDER BY date DESC LIMIT 1
      `);
      const marketRegime = regimeRow?.nifty_regime || 'SIDEWAYS';

      return {
        sectors,
        niftyBaseline: {
          value: niftyIndex ? parseFloat(String(niftyIndex.value).replace(/,/g, '')) : 0,
          changePct: niftyChangePct,
        },
        marketRegime,
        timestamp: new Date().toISOString(),
      };
    }, 30);
  }),

  // ─── 2. Detailed Sector Deep-Dive Studio ────────────────────────────────────
  getSectorDeepDive: publicProcedure
    .input(z.object({ sectorId: z.string() }))
    .query(async ({ input }) => {
      const def = SECTOR_DEFINITIONS.find((s) => s.id === input.sectorId) || SECTOR_DEFINITIONS[0];

      return fetchWithCache(`sectors:deepdive:${def.id}`, async () => {
        // 1. Index full details + fundamentals + technicals
        const [fullDetails, fundamentals, technicals] = await Promise.all([
          fetchIndexFullDetails(def.indId).catch(() => null),
          fetchIndexFundamentals(def.indId).catch(() => null),
          fetchIndexTechnicals('D', def.bridgeSymbol).catch(() => null),
        ]);

        // 2. Turning bullish / turning bearish scanner stocks
        const trends = await fetchSectorTechnicalTrends(def.dbSector).catch(() => ({
          bullish: [],
          bearish: [],
        }));

        // 3. Constituent stocks: try index stocks list first
        let constituentStocks: any[] = [];
        try {
          const indexStocksRes = await fetchIndexStocksList(def.indId);
          if (indexStocksRes?.item && Array.isArray(indexStocksRes.item) && indexStocksRes.item.length > 0) {
            constituentStocks = indexStocksRes.item.map((st: any) => ({
              symbol: st.id || st.shortname,
              name: st.shortname || st.id,
              price: parseFloat(String(st.lastvalue || '0').replace(/,/g, '')),
              changePct: parseFloat(String(st.percentchange || '0').replace(/,/g, '')),
              marketCap: st.mktcap || '—',
              pe: null,
              divYield: null,
              technicalTrend: st.direction === '1' ? 'Bullish' : 'Bearish',
            }));
          }
        } catch { /* continue */ }

        if (constituentStocks.length === 0 && def.mcSlug) {
          try {
            const mcStocksRes = await fetchSectorStocks(def.mcSlug);
            if (mcStocksRes && Array.isArray(mcStocksRes.data) && mcStocksRes.data.length > 0) {
              constituentStocks = mcStocksRes.data.map((st: any) => ({
                symbol: st.symbol || st.sc_id || st.name,
                name: st.name || st.company || st.symbol,
                price: parseFloat(String(st.lastPrice || st.price || '0').replace(/,/g, '')),
                changePct: parseFloat(String(st.percentChange || st.changePct || '0').replace(/,/g, '')),
                marketCap: st.marketCap || st.mcap || '—',
                pe: parseFloat(String(st.pe || '0')) || null,
                divYield: parseFloat(String(st.divYield || '0')) || null,
                technicalTrend: st.technicalTrend || st.trend || 'Neutral',
              }));
            }
          } catch { /* continue */ }
        }

        // Fast DB fallback: query nse_stocks with latest technical_signals cmp
        if (constituentStocks.length === 0) {
          try {
            const dbRows = await dbAll<any>(`
              SELECT ns.symbol, ns.name, ts.cmp as price, ts.change_pct as "changePct",
                     CASE WHEN ts.signal_score >= 3 THEN 'Bullish' ELSE 'Neutral' END as "technicalTrend"
              FROM nse_stocks ns
              LEFT JOIN technical_signals ts ON ts.symbol = ns.symbol
                AND ts.date = (SELECT MAX(date) FROM technical_signals)
              WHERE ns.sector = ? OR ns.industry = ?
              ORDER BY ts.cmp DESC NULLS LAST
              LIMIT 30
            `, [def.dbSector, def.dbSector]);
            if (dbRows && dbRows.length > 0) {
              constituentStocks = dbRows.map((r: any) => ({
                symbol: r.symbol,
                name: r.name || r.symbol,
                price: Number(r.price) || 0,
                changePct: Number(r.changePct) || 0,
                marketCap: '—',
                pe: null,
                divYield: null,
                technicalTrend: r.technicalTrend || 'Neutral',
              }));
            }
          } catch { /* continue */ }
        }

        // 4. Global Correlation context from sector_global_corr
        let globalCorr: any = null;
        try {
          const corrRow = await dbGet<any>(`
            SELECT * FROM sector_global_corr
            WHERE sector = ?
            ORDER BY date DESC LIMIT 1
          `, [def.dbSector]);
          if (corrRow) {
            globalCorr = {
              benchmark: corrRow.benchmark,
              corr21d: corrRow.corr_21d,
              corr63d: corrRow.corr_63d,
              date: corrRow.date,
            };
          }
        } catch { /* ignore */ }

        // 5. Index Moving Averages
        const idxOverview = fullDetails?.indices || {};
        const parseDma = (v: unknown) => {
          if (!v) return null;
          const n = parseFloat(String(v).replace(/,/g, ''));
          return isNaN(n) || n <= 0 ? null : n;
        };
        const dmaStats = {
          dma30: parseDma(idxOverview.dayavg30),
          dma50: parseDma(idxOverview.dayavg50),
          dma150: parseDma(idxOverview.dayavg150),
          dma200: parseDma(idxOverview.dayavg200),
          high52w: parseDma(idxOverview.yearlyhigh),
          low52w: parseDma(idxOverview.yearlylow),
          pivots: technicals?.pivotLevels || null,
          rsi: technicals?.indicators?.rsi || null,
          macd: technicals?.indicators?.macd || null,
        };

        return {
          sectorDef: def,
          overview: idxOverview,
          dmaStats,
          fundamentals,
          technicals,
          globalCorr,
          trends,
          constituents: constituentStocks,
        };
      }, 60);
    }),

  // ─── 3. Sector Rotation & Institutional Money Flow Timeline ───────────────
  getSectorRotationHistory: publicProcedure
    .input(z.object({ days: z.number().min(7).max(90).default(30) }).optional())
    .query(async ({ input }) => {
      const days = input?.days ?? 30;
      return fetchWithCache(`sectors:rotation-history:${days}`, async () => {
        const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString().slice(0, 10);
        const rows = await dbAll<any>(`
          SELECT sector, date, net_score, bull_count, bear_count, tier1_bull_count, breadth_score
          FROM screener_sector_rotation
          WHERE date >= ?
          ORDER BY date ASC, net_score DESC
        `, [cutoff]);

        // Group by date
        const byDate: Record<string, any[]> = {};
        for (const r of rows) {
          (byDate[r.date] ??= []).push(r);
        }

        return {
          history: rows,
          dates: Object.keys(byDate).sort(),
        };
      }, 300);
    }),

  // ─── 4. Sector Derivatives & F&O Desk ──────────────────────────────────────
  getSectorDerivativesDesk: publicProcedure.query(async () => {
    return fetchWithCache('sectors:derivatives-desk', async () => {
      const rows = await dbAll<any>(`
        SELECT sector, date, sector_pcr, total_call_oi, total_put_oi, symbol_count
        FROM sector_fo_sentiment
        WHERE date = (SELECT MAX(date) FROM sector_fo_sentiment)
        ORDER BY sector_pcr DESC
      `);

      return rows.map((r: any) => {
        const pcr = r.sector_pcr ? parseFloat(Number(r.sector_pcr).toFixed(2)) : 1.0;
        let sentiment: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH' = 'NEUTRAL';
        if (pcr >= 1.2) sentiment = 'STRONG_BULLISH';
        else if (pcr >= 0.9) sentiment = 'BULLISH';
        else if (pcr <= 0.55) sentiment = 'STRONG_BEARISH';
        else if (pcr <= 0.75) sentiment = 'BEARISH';

        return {
          sector: r.sector,
          date: r.date,
          pcr,
          callOi: Number(r.total_call_oi || 0),
          putOi: Number(r.total_put_oi || 0),
          symbolCount: Number(r.symbol_count || 0),
          sentiment,
        };
      });
    }, 60);
  }),

  // ─── 5. Mutual Fund Institutional Allocations ──────────────────────────────
  getSectorMfFlows: publicProcedure.query(async () => {
    return fetchWithCache('sectors:mf-flows', async () => {
      const rows = await dbAll<any>(`
        SELECT month, sector, aum_cr, aum_pct
        FROM mf_sector_allocation
        ORDER BY month DESC, aum_pct DESC
        LIMIT 60
      `);

      return rows;
    }, 3600);
  }),

  // ─── 6. On-Demand AI Sector Analyst Briefing ───────────────────────────────
  generateSectorAiBriefing: publicProcedure
    .input(z.object({ sectorId: z.string() }))
    .mutation(async ({ input }) => {
      const def = SECTOR_DEFINITIONS.find((s) => s.id === input.sectorId) || SECTOR_DEFINITIONS[0];

      // Collect data payload
      const [fullDetails, fundamentals, screenerRow, foRow] = await Promise.all([
        fetchIndexFullDetails(def.indId).catch(() => null),
        fetchIndexFundamentals(def.indId).catch(() => null),
        dbGet<any>(`
          SELECT * FROM screener_sector_rotation
          WHERE sector = ? ORDER BY date DESC LIMIT 1
        `, [def.dbSector]),
        dbGet<any>(`
          SELECT * FROM sector_fo_sentiment
          WHERE sector = ? ORDER BY date DESC LIMIT 1
        `, [def.dbSector]),
      ]);

      const payload = {
        sector: def.name,
        indId: def.indId,
        benchmark: def.benchmark,
        catalysts: def.coreCatalysts,
        indexOverview: fullDetails?.indices || {},
        fundamentals,
        screenerNetScore: screenerRow?.net_score || 0,
        optionsPcr: foRow?.sector_pcr || 1.0,
      };

      try {
        const result = await generateStockAnalysis(def.name, payload);
        return {
          sector: def.name,
          verdict: result.signal,
          sentiment: result.sentiment,
          confidence: result.confidence,
          analysis: result.reasoning,
          generatedAt: new Date().toISOString(),
        };
      } catch (err: any) {
        // Honest failure: a broken AI call must NOT be masked by a fabricated bullish
        // verdict (the fabrication class behind AF-20260914-05 and the audit-findings
        // "skip is not success" rule). Throw so the client keeps its own static
        // editorial fallback instead of rendering invented analysis as if the model
        // produced it.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `AI briefing generation failed for ${def.name}: ${err?.message ?? 'unknown error'}`,
          cause: err,
        });
      }
    }),
});
