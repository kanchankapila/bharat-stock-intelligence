export interface ScannerItem {
  id: string;
  provider: string;
  name: string;
  type?: string;
  catId?: string | number;
  scanId?: string;
  timeframes?: string[];
  screenerId?: string;
  queryCondition?: string;
}

export interface ScannerCategory {
  category: string;
  items: ScannerItem[];
}

export const SCANNER_CATALOG: ScannerCategory[] = [
  { category: 'Breakout Intelligence', items: [
    { id: 'mc-25-OHLC_D_P_BPBULL',    provider: 'mc', catId: 25, scanId: 'OHLC_D_P_BPBULL',    name: 'Range Breakout',    type: 'techscanner' },
    { id: 'mc-25-OHLC_D_P_WIBL',      provider: 'mc', catId: 25, scanId: 'OHLC_D_P_WIBL',      name: 'White Marubozu',    type: 'techscanner' },
    { id: 'mc-25-OHLC_D_I_RSIPOWBO',  provider: 'mc', catId: 25, scanId: 'OHLC_D_I_RSIPOWBO',  name: 'RSI Resistance BO', type: 'techscanner' },
    { id: 'mc-patterns-triangle',      provider: 'mc', catId: 'patterns', scanId: 'triangle',   name: 'Triangle Breakout', type: 'techscanner' },
    { id: 'mc-patterns-flag',          provider: 'mc', catId: 'patterns', scanId: 'flag',        name: 'Flag Pattern',      type: 'techscanner' },
  ]},
  { category: 'Multi-Timeframe Highs', items: [
    { id: 'hh-15m-1h',   provider: 'custom', name: '15m & 1h New Highs',      type: 'multi-tf', timeframes: ['15m', '1h'] },
    { id: 'hh-1h-4h-d',  provider: 'custom', name: '1h, 4h & Daily Highs',    type: 'multi-tf', timeframes: ['1h', '4h', 'D'] },
    { id: 'hh-d-w',      provider: 'custom', name: 'Daily & Weekly Highs',     type: 'multi-tf', timeframes: ['D', 'W'] },
  ]},
  { category: 'Value & Quality (MC)', items: [
    { id: 'mc-1-146', provider: 'mc', catId: 1, scanId: '146', name: 'Bargain Buys',    type: 'proscanner' },
    { id: 'mc-1-181', provider: 'mc', catId: 1, scanId: '181', name: 'Reasonable Price', type: 'proscanner' },
    { id: 'mc-1-178', provider: 'mc', catId: 1, scanId: '178', name: 'Growth Stocks',   type: 'proscanner' },
  ]},
  { category: 'Technical Breakouts (MC)', items: [
    { id: 'mc-25-BPBULL',    provider: 'mc', catId: 25, scanId: 'OHLC_D_P_BPBULL',    name: 'Bullish Breakaway', type: 'techscanner' },
    { id: 'mc-25-RSIPOWBO',  provider: 'mc', catId: 25, scanId: 'OHLC_D_I_RSIPOWBO',  name: 'RSI Power BO',      type: 'techscanner' },
    { id: 'mc-17-52HIGH',    provider: 'mc', catId: 17, scanId: 'OHLC_W_P_52HIGH',     name: '52 Week High',      type: 'techscanner' },
    { id: 'mc-17-52LOW',     provider: 'mc', catId: 17, scanId: 'OHLC_W_P_52LOW',      name: '52 Week Low',       type: 'techscanner' },
  ]},
  { category: 'Technical Trends (MC)', items: [
    { id: 'mc-tt-bullish',          provider: 'mc', catId: 'uptrend/bullish',          scanId: '7', name: 'Nifty 500 Bullish', type: 'technical-trends' },
    { id: 'mc-tt-turning-bullish',  provider: 'mc', catId: 'uptrend/turning-bullish',  scanId: '7', name: 'Turning Bullish',   type: 'technical-trends' },
    { id: 'mc-tt-bearish',          provider: 'mc', catId: 'downtrend/bearish',        scanId: '7', name: 'Nifty 500 Bearish', type: 'technical-trends' },
    { id: 'mc-tt-turning-bearish',  provider: 'mc', catId: 'downtrend/turning-bearish',scanId: '7', name: 'Turning Bearish',   type: 'technical-trends' },
  ]},
  { category: 'ETnow Elite (ET)', items: [
    { id: 'et-73',  provider: 'et', screenerId: '73',  name: 'Cash Cows',             queryCondition: ' Cash & Cash Equiv (Rs Cr) >=2500 AND  CF Operations (Rs Cr) >=1000 AND  Chg in Working Cap (Rs Cr) >=3000 AND   Quick Ratio >=1.5' },
    { id: 'et-75',  provider: 'et', screenerId: '75',  name: 'Elite Bluechips',        queryCondition: ' Market Cap (Rs Cr) > 60000  AND  Pitroski Score  >=6 AND  Return on Equity (%) >=  Avg ROE 5Y (%) AND  ROA (%) >=  Avg ROA 5Y AND  PEG Ratio <=1.5 AND CFO_By_Profit After Tax (Rs Cr) >=1' },
    { id: 'et-79',  provider: 'et', screenerId: '79',  name: 'Zero Debt Quality',      queryCondition: ' Debt to Equity <=0.1 AND  LT DE Ratio <=0.1 AND  Int Coverage Ratio >=100 AND Market Cap (Rs Cr) >=500 AND  Z Score >=3 AND  Pitroski Score >=6' },
    { id: 'et-91',  provider: 'et', screenerId: '91',  name: 'Buy on Dips',            queryCondition: ' Pitroski Score >=6 AND  YTD Returns (%) <=15 AND  PEG Ratio <=0.8 AND  Sustainable Growth (%) >=7 AND  Market Cap (Rs Cr) >=2000 AND  CFO_By_Profit After Tax (Rs Cr) >=1 AND  PEG Ratio >=0' },
    { id: 'et-195', provider: 'et', screenerId: '195', name: 'Potential Multibaggers', queryCondition: ' Return on Equity (%) >  Return on Equity 1Y (%) AND  Return on Equity (%) >=20 AND  EBITDA Margin % >  EBITDA Margin % 1Y AND  Sustainable Growth (%) >=15 AND Earnings Retention % Net Profit >=85 AND  LT DE Ratio <=1 AND CFO_By_Profit After Tax (Rs Cr) >= 1 AND  Rel Ret vs BSE 500 YTD >=1 AND  PEG Ratio <=1' },
    { id: 'et-118', provider: 'et', screenerId: '118', name: 'Straight Flush',         queryCondition: ' Qtr Net Profit (Rs Cr) >0 AND  PBT before Q1 >0 AND PAT 2 Qtr Ago (Rs Cr) >0 AND PAT 3 Qtr Ago (Rs Cr) >0 AND PAT 4 Qtr Ago (Rs Cr) >0 AND Qtr Net Profit % >10 AND  Net Profit QoQ Chg (%) >20 AND Qtr Net profit YoY Chg (%) >20 AND  Pitroski Score >=6' },
    { id: 'et-362', provider: 'et', screenerId: '362', name: 'RSI Oversold',           queryCondition: ' RSI Current<30 AND RSI Previous<30' },
  ]},
  { category: 'Sector GEMS (ET)', items: [
    { id: 'et-518',  provider: 'et', screenerId: '518',  name: 'The Tata Empire',   queryCondition: ' Tata = True' },
    { id: 'et-520',  provider: 'et', screenerId: '520',  name: 'Adani Universe',    queryCondition: ' Adani Group = True' },
    { id: 'et-514',  provider: 'et', screenerId: '514',  name: 'PSU Gems',          queryCondition: ' Handpicked PSU Gems = True' },
    { id: 'et-515',  provider: 'et', screenerId: '515',  name: 'Monopoly Biz',      queryCondition: ' Monopoly Businesses = True' },
    { id: 'et-1101', provider: 'et', screenerId: '1101', name: 'Defence Sector',    queryCondition: ' Industry=2076' },
    { id: 'et-1100', provider: 'et', screenerId: '1100', name: 'Infra Boost',       queryCondition: ' Industry =2141 AND  PB TTM >=0 AND  Market Cap (Rs Cr) >=300' },
  ]},
];
