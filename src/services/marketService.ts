import { useState, useEffect, useCallback } from 'react';
import { trpc } from '../lib/trpc';

export interface MarketData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  volume: string;
  high: number;
  low: number;
  open: number;
  prevClose: number;
}

// Keep initial dummy data as fallback in case live data fetch fails
const INITIAL_STOCKS: MarketData[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', price: 2954.20, change: 14.45, changePct: 0.49, volume: '2.4M', high: 2970, low: 2930, open: 2940, prevClose: 2939.75 },
  // ... (rest of dummy data kept for fallback)
];

export function useMarketData() {
  const [stocks, setStocks] = useState<MarketData[]>(INITIAL_STOCKS);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch live stocks from TRPC endpoint
  // This fetches real data from MoneyControl API and other sources
  const { data: liveStocks, isLoading: isLoadingLive } = trpc.getLiveStocks.useQuery(undefined, {
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
    staleTime: 30 * 1000, // Data is fresh for 30 seconds
    gcTime: 10 * 60 * 1000, // Cache for 10 minutes
  });

  useEffect(() => {
    if (isLoadingLive) {
      setIsLoading(true);
    } else if (liveStocks && liveStocks.length > 0) {
      // Use live data if available
      setStocks(liveStocks);
      setIsLoading(false);
      setError(null);
    } else {
      // Fallback to initial dummy data if live data fails
      console.warn('[MARKET DATA] Live data fetch failed, using fallback dummy data');
      setError('Using cached/dummy data - live fetch unavailable');
      setIsLoading(false);
    }
  }, [liveStocks, isLoadingLive]);

  // Simulate minor price variations for live feel
  // (Optional: disable this if you want pure API data)
  useEffect(() => {
    if (!liveStocks || liveStocks.length === 0) return;

    const interval = setInterval(() => {
      setStocks(prevStocks => 
        prevStocks.map(stock => {
          // Very small volatility (0.05% max change per update)
          const volatility = 0.0005;
          const change = (Math.random() - 0.5) * 2 * volatility * stock.price;
          const newPrice = stock.price + change;
          const totalChange = newPrice - stock.prevClose;
          const totalChangePct = (totalChange / stock.prevClose) * 100;

          return {
            ...stock,
            price: Number(newPrice.toFixed(2)),
            change: Number(totalChange.toFixed(2)),
            changePct: Number(totalChangePct.toFixed(2)),
            high: Math.max(stock.high, newPrice),
            low: Math.min(stock.low, newPrice),
          };
        })
      );
    }, 5000); // Update every 5 seconds

    return () => clearInterval(interval);
  }, [liveStocks]);

  return stocks;
}

export const getIndexData = () => [
  { name: 'Nifty 50', value: 22453.20, change: 0.84, isUp: true },
  { name: 'Sensex', value: 73845.54, change: 0.72, isUp: true },
  { name: 'Bank Nifty', value: 47285.30, change: 1.24, isUp: true },
  { name: 'India VIX', value: 14.82, change: -2.40, isUp: false },
  { name: 'Nifty IT', value: 37420.15, change: -0.34, isUp: false },
  { name: 'Nifty Midcap', value: 49210.80, change: 0.55, isUp: true },
];

// Keep initial dummy data as fallback in case live data fetch fails
const INITIAL_STOCKS: MarketData[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', price: 2954.20, change: 14.45, changePct: 0.49, volume: '2.4M', high: 2970, low: 2930, open: 2940, prevClose: 2939.75 },
  { symbol: 'TCS', name: 'Tata Consultancy Services', price: 3982.15, change: -12.40, changePct: -0.31, volume: '1.2M', high: 4010, low: 3970, open: 4005, prevClose: 3994.55 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', price: 1542.80, change: 8.20, changePct: 0.53, volume: '8.4M', high: 1555, low: 1530, open: 1535, prevClose: 1534.60 },
  { symbol: 'INFY', name: 'Infosys Limited', price: 1420.30, change: -4.30, changePct: -0.30, volume: '3.1M', high: 1435, low: 1410, open: 1425, prevClose: 1424.60 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', price: 1084.50, change: 15.60, changePct: 1.46, volume: '5.2M', high: 1095, low: 1065, open: 1070, prevClose: 1068.90 },
  { symbol: 'ADANIENT', name: 'Adani Enterprises Ltd', price: 3214.50, change: 128.30, changePct: 4.15, volume: '4.8M', high: 3250, low: 3100, open: 3120, prevClose: 3086.20 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd', price: 1210.40, change: 12.10, changePct: 1.01, volume: '2.9M', high: 1225, low: 1195, open: 1200, prevClose: 1198.30 },
  { symbol: 'ITC', name: 'ITC Limited', price: 428.15, change: -2.35, changePct: -0.55, volume: '12.4M', high: 435, low: 425, open: 432, prevClose: 430.50 },
  { symbol: 'AXISBANK', name: 'Axis Bank Ltd', price: 1120.45, change: 14.20, changePct: 1.28, volume: '4.1M', high: 1135, low: 1105, open: 1110, prevClose: 1106.25 },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', price: 1785.30, change: -5.40, changePct: -0.30, volume: '2.2M', high: 1810, low: 1770, open: 1800, prevClose: 1790.70 },
  { symbol: 'LT', name: 'Larsen & Toubro Ltd', price: 3450.15, change: 42.10, changePct: 1.24, volume: '1.8M', high: 3480, low: 3410, open: 3420, prevClose: 3408.05 },
  { symbol: 'SBIN', name: 'State Bank of India', price: 764.20, change: 5.45, changePct: 0.72, volume: '9.2M', high: 775, low: 755, open: 760, prevClose: 758.75 },
  { symbol: 'MARUTI', name: 'Maruti Suzuki India', price: 12450.00, change: 154.20, changePct: 1.25, volume: '0.4M', high: 12550, low: 12300, open: 12350, prevClose: 12295.80 },
  { symbol: 'SUNPHARMA', name: 'Sun Pharma Industries', price: 1545.60, change: 12.30, changePct: 0.80, volume: '1.5M', high: 1560, low: 1530, open: 1535, prevClose: 1533.30 },
  { symbol: 'HINDALCO', name: 'Hindalco Industries', price: 584.20, change: -8.15, changePct: -1.38, volume: '6.4M', high: 600, low: 580, open: 595, prevClose: 592.35 },
  { symbol: 'TITAN', name: 'Titan Company Ltd', price: 3624.50, change: 48.20, changePct: 1.35, volume: '1.1M', high: 3650, low: 3580, open: 3600, prevClose: 3576.30 },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance Ltd', price: 7245.80, change: -24.15, changePct: -0.33, volume: '1.4M', high: 7350, low: 7200, open: 7300, prevClose: 7269.95 },
  { symbol: 'M&M', name: 'Mahindra & Mahindra', price: 2145.20, change: 32.40, changePct: 1.53, volume: '2.8M', high: 2160, low: 2110, open: 2120, prevClose: 2112.80 },
  { symbol: 'HCLTECH', name: 'HCL Technologies Ltd', price: 1485.40, change: 10.20, changePct: 0.69, volume: '1.9M', high: 1500, low: 1475, open: 1480, prevClose: 1475.20 },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever', price: 2420.15, change: -12.40, changePct: -0.51, volume: '1.6M', high: 2450, low: 2410, open: 2440, prevClose: 2432.55 },
  { symbol: 'ASIANPAINT', name: 'Asian Paints Ltd', price: 2854.30, change: 15.60, changePct: 0.55, volume: '0.8M', high: 2880, low: 2830, open: 2845, prevClose: 2838.70 },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement', price: 9854.20, change: 124.50, changePct: 1.28, volume: '0.3M', high: 9950, low: 9750, open: 9800, prevClose: 9729.70 },
  { symbol: 'JSWSTEEL', name: 'JSW Steel Ltd', price: 894.20, change: -4.15, changePct: -0.46, volume: '3.4M', high: 910, low: 885, open: 905, prevClose: 898.35 },
  { symbol: 'WIPRO', name: 'Wipro Limited', price: 485.30, change: -1.20, changePct: -0.25, volume: '6.1M', high: 495, low: 480, open: 488, prevClose: 486.50 },
  { symbol: 'NTPC', name: 'NTPC Limited', price: 354.20, change: 4.15, changePct: 1.19, volume: '8.4M', high: 360, low: 348, open: 352, prevClose: 350.05 },
  { symbol: 'POWERGRID', name: 'Power Grid Corp', price: 284.15, change: 2.10, changePct: 0.74, volume: '7.2M', high: 288, low: 280, open: 283, prevClose: 282.05 },
  { symbol: 'COALINDIA', name: 'Coal India Ltd', price: 454.20, change: -1.85, changePct: -0.41, volume: '9.4M', high: 465, low: 450, open: 460, prevClose: 456.05 },
  { symbol: 'TATASTEEL', name: 'Tata Steel Ltd', price: 164.20, change: 1.15, changePct: 0.70, volume: '22.4M', high: 168, low: 162, open: 165, prevClose: 163.05 },
  { symbol: 'ADANIPORTS', name: 'Adani Ports & SEZ', price: 1345.20, change: 24.15, changePct: 1.83, volume: '3.8M', high: 1360, low: 1320, open: 1325, prevClose: 1321.05 },
  { symbol: 'GRASIM', name: 'Grasim Industries', price: 2354.20, change: 12.15, changePct: 0.52, volume: '0.8M', high: 2380, low: 2330, open: 2345, prevClose: 2342.05 },
  { symbol: 'BAJAJ-AUTO', name: 'Bajaj Auto Ltd', price: 8945.20, change: 154.20, changePct: 1.75, volume: '0.5M', high: 9050, low: 8850, open: 8880, prevClose: 8791.00 },
  { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd', price: 985.40, change: 12.15, changePct: 1.25, volume: '8.9M', high: 1000, low: 975, open: 980, prevClose: 973.25 },
  { symbol: 'CIPLA', name: 'Cipla Limited', price: 1420.30, change: -8.15, changePct: -0.57, volume: '2.1M', high: 1445, low: 1410, open: 1435, prevClose: 1428.45 },
  { symbol: 'NESTLEIND', name: 'Nestle India Ltd', price: 2453.20, change: 24.15, changePct: 0.99, volume: '0.2M', high: 2480, low: 2430, open: 2445, prevClose: 2429.05 },
  { symbol: 'DIVISLAB', name: 'Divi\'s Laboratories', price: 3845.20, change: 42.15, changePct: 1.11, volume: '0.6M', high: 3880, low: 3810, open: 3820, prevClose: 3803.05 },
  { symbol: 'DRREDDY', name: 'Dr Reddy\'s Labs', price: 6245.20, change: -42.15, changePct: -0.67, volume: '0.7M', high: 6350, low: 6200, open: 6300, prevClose: 6287.35 },
  { symbol: 'BRITANNIA', name: 'Britannia Industries', price: 4854.20, change: 54.15, changePct: 1.13, volume: '0.5M', high: 4900, low: 4810, open: 4820, prevClose: 4800.05 },
  { symbol: 'TECHM', name: 'Tech Mahindra Ltd', price: 1245.20, change: -15.15, changePct: -1.20, volume: '2.5M', high: 1280, low: 1240, open: 1270, prevClose: 1260.35 },
  { symbol: 'INDUSINDBK', name: 'IndusInd Bank Ltd', price: 1542.80, change: 24.15, changePct: 1.59, volume: '3.1M', high: 1560, low: 1520, open: 1530, prevClose: 1518.65 },
  { symbol: 'APOLLOHOSP', name: 'Apollo Hospitals', price: 6245.20, change: 84.15, changePct: 1.37, volume: '0.5M', high: 6350, low: 6200, open: 6220, prevClose: 6161.05 },
  { symbol: 'TATACONSUM', name: 'Tata Consumer Prod', price: 1154.20, change: -12.15, changePct: -1.04, volume: '2.4M', high: 1180, low: 1150, open: 1175, prevClose: 1166.35 },
  { symbol: 'BAJAJFINSV', name: 'Bajaj Finserv Ltd', price: 1642.80, change: 12.15, changePct: 0.75, volume: '1.2M', high: 1665, low: 1630, open: 1640, prevClose: 1630.65 },
  { symbol: 'EICHERMOT', name: 'Eicher Motors Ltd', price: 4542.80, change: 42.15, changePct: 0.94, volume: '0.6M', high: 4600, low: 4520, open: 4530, prevClose: 4500.65 },
  { symbol: 'BPCL', name: 'Bharat Petroleum', price: 584.20, change: 8.15, changePct: 1.41, volume: '5.2M', high: 595, low: 578, open: 580, prevClose: 576.05 },
  { symbol: 'ONGC', name: 'Oil & Natural Gas', price: 274.15, change: -4.15, changePct: -1.49, volume: '11.4M', high: 285, low: 272, open: 282, prevClose: 278.30 },
  { symbol: 'SBILIFE', name: 'SBI Life Insurance', price: 1485.40, change: 15.20, changePct: 1.03, volume: '1.1M', high: 1500, low: 1475, open: 1480, prevClose: 1470.20 },
  { symbol: 'HDFCLIFE', name: 'HDFC Life Insurance', price: 584.20, change: -8.15, changePct: -1.38, volume: '4.4M', high: 600, low: 580, open: 595, prevClose: 592.35 },
  { symbol: 'HEROMOTOCO', name: 'Hero MotoCorp Ltd', price: 4642.80, change: 84.15, changePct: 1.85, volume: '0.6M', high: 4700, low: 4580, open: 4600, prevClose: 4558.65 },
  { symbol: 'LTIM', name: 'LTIMindtree Ltd', price: 4854.20, change: -54.15, changePct: -1.10, volume: '0.4M', high: 4950, low: 4840, open: 4920, prevClose: 4908.35 },
  { symbol: 'SHREECEM', name: 'Shree Cement Ltd', price: 25453.20, change: 124.50, changePct: 0.49, volume: '0.1M', high: 25600, low: 25300, open: 25400, prevClose: 25328.70 },
  { symbol: 'BEL', name: 'Bharat Electronics', price: 224.15, change: 8.15, changePct: 3.77, volume: '15.4M', high: 228, low: 218, open: 220, prevClose: 216.00 },
  { symbol: 'ZOMATO', name: 'Zomato Limited', price: 184.20, change: 4.15, changePct: 2.30, volume: '25.4M', high: 188, low: 180, open: 182, prevClose: 180.05 },
  { symbol: 'HAL', name: 'Hindustan Aeronautics', price: 3845.20, change: 124.15, changePct: 3.34, volume: '1.2M', high: 3900, low: 3780, open: 3800, prevClose: 3721.05 },
  { symbol: 'VBL', name: 'Varun Beverages Ltd', price: 1453.20, change: 14.15, changePct: 0.98, volume: '1.4M', high: 1480, low: 1440, open: 1445, prevClose: 1439.05 },
  { symbol: 'DLF', name: 'DLF Limited', price: 894.20, change: 12.15, changePct: 1.38, volume: '4.4M', high: 910, low: 885, open: 890, prevClose: 882.05 },
  { symbol: 'GAIL', name: 'GAIL (India) Ltd', price: 194.20, change: -4.15, changePct: -2.09, volume: '8.4M', high: 205, low: 192, open: 202, prevClose: 198.35 },
  { symbol: 'CANBK', name: 'Canara Bank', price: 584.20, change: 12.15, changePct: 2.12, volume: '6.4M', high: 595, low: 575, open: 580, prevClose: 572.05 },
  { symbol: 'TRENTS', name: 'Trent Limited', price: 3982.15, change: 124.40, changePct: 3.23, volume: '0.8M', high: 4050, low: 3900, open: 3920, prevClose: 3857.75 },
  { symbol: 'LICI', name: 'Life Insurance Corp', price: 985.40, change: -12.15, changePct: -1.22, volume: '2.9M', high: 1010, low: 980, open: 1005, prevClose: 997.55 },
  { symbol: 'JIOFIN', name: 'Jio Financial Serv', price: 354.20, change: 8.15, changePct: 2.36, volume: '18.4M', high: 362, low: 348, open: 350, prevClose: 346.05 },
  { symbol: 'PAGEIND', name: 'Page Industries', price: 35453.20, change: -454.20, changePct: -1.26, volume: '0.1M', high: 36200, low: 35200, open: 36000, prevClose: 35907.40 },
  { symbol: 'DMART', name: 'Avenue Supermarts', price: 4453.20, change: 54.15, changePct: 1.23, volume: '0.4M', high: 4500, low: 4410, open: 4420, prevClose: 4399.05 },
  { symbol: 'PIDILITIND', name: 'Pidilite Industries', price: 2854.30, change: 42.60, changePct: 1.52, volume: '0.6M', high: 2880, low: 2820, open: 2830, prevClose: 2811.70 },
  { symbol: 'INDIGOT', name: 'InterGlobe Aviation', price: 3450.15, change: 82.10, changePct: 2.44, volume: '0.9M', high: 3480, low: 3380, open: 3400, prevClose: 3368.05 },
  { symbol: 'ABB', name: 'ABB India Ltd', price: 6245.20, change: 124.15, changePct: 2.03, volume: '0.3M', high: 6350, low: 6150, open: 6180, prevClose: 6121.05 },
  { symbol: 'SIEMENS', name: 'Siemens Limited', price: 5845.20, change: 112.15, changePct: 1.96, volume: '0.4M', high: 5950, low: 5750, open: 5780, prevClose: 5733.05 },
  { symbol: 'PNB', name: 'Punjab National Bank', price: 124.15, change: 4.15, changePct: 3.46, volume: '22.4M', high: 128, low: 120, open: 122, prevClose: 120.00 },
  { symbol: 'BANKBARODA', name: 'Bank of Baroda', price: 264.20, change: 8.15, changePct: 3.18, volume: '12.4M', high: 270, low: 258, open: 260, prevClose: 256.05 },
  { symbol: 'UNIONBANK', name: 'Union Bank of India', price: 154.20, change: 4.15, changePct: 2.77, volume: '10.4M', high: 158, low: 150, open: 152, prevClose: 150.05 },
  { symbol: 'TVSMOTOR', name: 'TVS Motor Company', price: 2145.20, change: -32.40, changePct: -1.49, volume: '1.2M', high: 2210, low: 2130, open: 2200, prevClose: 2177.60 },
  { symbol: 'AMBUJACEM', name: 'Ambuja Cements Ltd', price: 614.20, change: 12.15, changePct: 2.02, volume: '4.4M', high: 625, low: 605, open: 608, prevClose: 602.05 },
  { symbol: 'ACC', name: 'ACC Limited', price: 2542.80, change: -24.15, changePct: -0.94, volume: '0.8M', high: 2600, low: 2530, open: 2580, prevClose: 2566.95 },
  { symbol: 'VEDL', name: 'Vedanta Limited', price: 354.20, change: 8.15, changePct: 2.36, volume: '15.4M', high: 362, low: 348, open: 350, prevClose: 346.05 },
  { symbol: 'HINDZINC', name: 'Hindustan Zinc Ltd', price: 324.20, change: -4.15, changePct: -1.26, volume: '1.4M', high: 335, low: 320, open: 332, prevClose: 328.35 },
  { symbol: 'PETRONET', name: 'Petronet LNG Ltd', price: 284.15, change: 4.15, changePct: 1.48, volume: '3.4M', high: 290, low: 282, open: 285, prevClose: 280.00 },
  { symbol: 'COLPAL', name: 'Colgate Palmolive', price: 2645.20, change: 42.15, changePct: 1.62, volume: '0.6M', high: 2680, low: 2610, open: 2620, prevClose: 2603.05 },
  { symbol: 'DABUR', name: 'Dabur India Ltd', price: 524.20, change: -8.15, changePct: -1.53, volume: '3.4M', high: 535, low: 520, open: 532, prevClose: 532.35 },
  { symbol: 'MARICO', name: 'Marico Limited', price: 545.60, change: 5.30, changePct: 0.98, volume: '2.5M', high: 555, low: 540, open: 542, prevClose: 540.30 },
  { symbol: 'GODREJCP', name: 'Godrej Consumer', price: 1245.20, change: 12.15, changePct: 0.99, volume: '0.8M', high: 1265, low: 1235, open: 1240, prevClose: 1233.05 },
  { symbol: 'SRF', name: 'SRF Limited', price: 2453.20, change: -24.15, changePct: -0.97, volume: '0.4M', high: 2500, low: 2430, open: 2480, prevClose: 2477.35 },
  { symbol: 'ASHOKLEY', name: 'Ashok Leyland Ltd', price: 174.20, change: 2.15, changePct: 1.25, volume: '12.4M', high: 178, low: 172, open: 173, prevClose: 172.05 },
  { symbol: 'BERGEPAINT', name: 'Berger Paints Ltd', price: 584.20, change: -4.15, changePct: -0.71, volume: '1.4M', high: 595, low: 580, open: 592, prevClose: 588.35 },
  { symbol: 'POLYCAB', name: 'Polycab India Ltd', price: 4854.20, change: 124.50, changePct: 2.63, volume: '0.6M', high: 4950, low: 4800, open: 4820, prevClose: 4729.70 },
  { symbol: 'CHOLAFIN', name: 'Cholamandalam Inv', price: 1154.20, change: 24.15, changePct: 2.14, volume: '1.4M', high: 1180, low: 1140, open: 1145, prevClose: 1130.05 },
  { symbol: 'MUTHOOTFIN', name: 'Muthoot Finance', price: 1453.20, change: -12.15, changePct: -0.83, volume: '0.8M', high: 1480, low: 1445, open: 1475, prevClose: 1465.35 },
  { symbol: 'RECLTD', name: 'REC Limited', price: 428.15, change: 14.15, changePct: 3.42, volume: '12.4M', high: 435, low: 420, open: 422, prevClose: 414.00 },
  { symbol: 'PFC', name: 'Power Finance Corp', price: 384.20, change: 12.15, changePct: 3.27, volume: '11.4M', high: 392, low: 378, open: 380, prevClose: 372.05 },
  { symbol: 'PERSISTENT', name: 'Persistent Systems', price: 3982.15, change: -45.40, changePct: -1.13, volume: '0.4M', high: 4050, low: 3950, open: 4030, prevClose: 4027.55 },
  { symbol: 'COFORGE', name: 'Coforge Limited', price: 5845.20, change: -112.15, changePct: -1.88, volume: '0.3M', high: 6000, low: 5800, open: 5980, prevClose: 5957.35 },
  { symbol: 'DIXON', name: 'Dixon Technologies', price: 7245.80, change: 245.15, changePct: 3.50, volume: '0.5M', high: 7350, low: 7100, open: 7150, prevClose: 7000.65 },
  { symbol: 'OBEROIRLTY', name: 'Oberoi Realty Ltd', price: 1345.20, change: 42.15, changePct: 3.23, volume: '0.8M', high: 1380, low: 1320, open: 1330, prevClose: 1303.05 },
  { symbol: 'PHOENIXLTD', name: 'Phoenix Mills Ltd', price: 2854.30, change: 82.60, changePct: 2.98, volume: '0.4M', high: 2900, low: 2800, open: 2820, prevClose: 2771.70 },
  { symbol: 'AUBANK', name: 'AU Small Finance', price: 584.20, change: -8.15, changePct: -1.38, volume: '2.4M', high: 600, low: 580, open: 595, prevClose: 592.35 },
  { symbol: 'FEDERALBNK', name: 'Federal Bank Ltd', price: 154.20, change: 2.15, changePct: 1.41, volume: '8.4M', high: 158, low: 152, open: 153, prevClose: 152.05 },
  { symbol: 'IDFCFIRSTB', name: 'IDFC First Bank', price: 84.15, change: 1.45, changePct: 1.75, volume: '15.4M', high: 86, low: 82, open: 83, prevClose: 82.70 },
];
