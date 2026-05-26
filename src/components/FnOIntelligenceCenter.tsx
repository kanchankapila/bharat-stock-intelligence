import React, { useState, useMemo } from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import {
  Zap, Activity, TrendingUp, TrendingDown,
  ShieldAlert, Target, BarChart3, Filter, ChevronRight,
  AlertTriangle, Eye, Flame
} from 'lucide-react';
import { Card } from './MCCommon';
import FnOHeatmap from './FnOHeatmap';

interface FnOScannerProps {
  onSelectStock: (symbol: string) => void;
}

// ── Data field name aliases from the Trendlyne API ──────────────────────────
const BUILDUP_META: Record<string, { color: string; icon: string; signal: 'bullish' | 'bearish' | 'neutral' }> = {
  'Long Build Up':   { color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20', icon: '▲', signal: 'bullish' },
  'Short Build Up':  { color: 'bg-rose-500/15 text-rose-400 border-rose-500/20',          icon: '▼', signal: 'bearish' },
  'Short Covering':  { color: 'bg-sky-500/15 text-sky-400 border-sky-500/20',             icon: '↑', signal: 'bullish' },
  'Long Unwinding':  { color: 'bg-amber-500/15 text-amber-400 border-amber-500/20',       icon: '↓', signal: 'bearish' },
};

// ── Scanner-specific column definitions ────────────────────────────────────
// Each entry: { key: header.name from API, label: display label, fmt: format type }
type ColFmt = 'price' | 'chg' | 'oi' | 'vol' | 'iv' | 'greek' | 'coc' | 'basis';
interface ColDef { keys: string[]; label: string; fmt: ColFmt }

const FUTURES_COLS: Record<string, ColDef[]> = {
  'long-build-up':   [
    { keys: ['ltp', 'current_price'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['day_change', 'daychange'],               label: 'Day%',     fmt: 'chg'   },
    { keys: ['open_interest'],                          label: 'OI (Lots)',fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['cost_of_carry', 'coc', 'costofcarry'],   label: 'CoC%',     fmt: 'coc'   },
  ],
  'short-build-up':  [
    { keys: ['ltp', 'current_price'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['day_change', 'daychange'],               label: 'Day%',     fmt: 'chg'   },
    { keys: ['open_interest'],                          label: 'OI (Lots)',fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['cost_of_carry', 'coc', 'costofcarry'],   label: 'CoC%',     fmt: 'coc'   },
  ],
  'short-covering':  [
    { keys: ['ltp', 'current_price'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['day_change', 'daychange'],               label: 'Day%',     fmt: 'chg'   },
    { keys: ['open_interest'],                          label: 'OI (Lots)',fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['traded_contracts', 'volume'],            label: 'Vol',      fmt: 'vol'   },
  ],
  'long-unwinding':  [
    { keys: ['ltp', 'current_price'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['day_change', 'daychange'],               label: 'Day%',     fmt: 'chg'   },
    { keys: ['open_interest'],                          label: 'OI (Lots)',fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['traded_contracts', 'volume'],            label: 'Vol',      fmt: 'vol'   },
  ],
  'oi-gainers':  [
    { keys: ['ltp', 'current_price'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['open_interest'],                          label: 'OI (Lots)',fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['ttv', 'total_traded_value'],             label: 'TTV (Cr)', fmt: 'vol'   },
    { keys: ['traded_contracts', 'volume'],            label: 'Vol',      fmt: 'vol'   },
  ],
  'premium':  [
    { keys: ['ltp', 'current_price'],                  label: 'Fut LTP',  fmt: 'price' },
    { keys: ['currentPrice', 'spot_price'],            label: 'Spot',     fmt: 'price' },
    { keys: ['basis'],                                  label: 'Basis',    fmt: 'basis' },
    { keys: ['cost_of_carry', 'coc'],                  label: 'CoC%',     fmt: 'coc'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
  ],
  'discount':  [
    { keys: ['ltp', 'current_price'],                  label: 'Fut LTP',  fmt: 'price' },
    { keys: ['currentPrice', 'spot_price'],            label: 'Spot',     fmt: 'price' },
    { keys: ['basis'],                                  label: 'Basis',    fmt: 'basis' },
    { keys: ['cost_of_carry', 'coc'],                  label: 'CoC%',     fmt: 'coc'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
  ],
  'most-active-value': [
    { keys: ['ltp', 'current_price'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['ttv', 'total_traded_value'],             label: 'TTV (Cr)', fmt: 'vol'   },
    { keys: ['traded_contracts', 'volume'],            label: 'Vol',      fmt: 'vol'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
  ],
  'most-active-contract': [
    { keys: ['ltp', 'current_price'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['traded_contracts', 'volume'],            label: 'Vol',      fmt: 'vol'   },
    { keys: ['ttv', 'total_traded_value'],             label: 'TTV (Cr)', fmt: 'vol'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
  ],
};
const OPTIONS_COLS: Record<string, ColDef[]> = {
  'oi-gainers-call': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['oi_difference', 'oi_abs'],               label: 'OI Chg',   fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
  ],
  'oi-gainers-put': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['oi_difference', 'oi_abs'],               label: 'OI Chg',   fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
  ],
  'iv-rise': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['day_change', 'daychange'],               label: 'Day%',     fmt: 'chg'   },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
    { keys: ['iv_change', 'ivchange'],                 label: 'IV Chg%',  fmt: 'chg'   },
    { keys: ['delta'],                                  label: 'Δ Delta',  fmt: 'greek' },
  ],
  'iv-fall': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
    { keys: ['iv_change', 'ivchange'],                 label: 'IV Chg%',  fmt: 'chg'   },
    { keys: ['theta'],                                  label: 'Θ Theta',  fmt: 'greek' },
    { keys: ['vega'],                                   label: 'ν Vega',   fmt: 'greek' },
  ],
  'most-active-value': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['ttv', 'total_traded_value'],             label: 'TTV (Cr)', fmt: 'vol'   },
    { keys: ['traded_contracts', 'volume'],            label: 'Vol',      fmt: 'vol'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
  ],
  'most-active-contract': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['traded_contracts', 'volume'],            label: 'Vol',      fmt: 'vol'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
  ],
  'long-build-up': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['day_change', 'daychange'],               label: 'Day%',     fmt: 'chg'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
  ],
  'short-build-up': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['day_change', 'daychange'],               label: 'Day%',     fmt: 'chg'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
  ],
  'short-covering': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['day_change', 'daychange'],               label: 'Day%',     fmt: 'chg'   },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
    { keys: ['oi_change', 'oichange'],                 label: 'OI Chg%',  fmt: 'chg'   },
    { keys: ['delta'],                                  label: 'Δ Delta',  fmt: 'greek' },
  ],
  'in-money': [
    { keys: ['current_price', 'ltp'],                  label: 'LTP',      fmt: 'price' },
    { keys: ['implied_volatility', 'iv'],              label: 'IV%',      fmt: 'iv'    },
    { keys: ['delta'],                                  label: 'Δ Delta',  fmt: 'greek' },
    { keys: ['theta'],                                  label: 'Θ Theta',  fmt: 'greek' },
    { keys: ['open_interest'],                          label: 'OI',       fmt: 'oi'    },
  ],
};
const DEFAULT_FUT_COLS: ColDef[] = [
  { keys: ['ltp', 'current_price'],    label: 'LTP',     fmt: 'price' },
  { keys: ['day_change'],              label: 'Day%',    fmt: 'chg'   },
  { keys: ['open_interest'],           label: 'OI',      fmt: 'oi'    },
  { keys: ['oi_change'],               label: 'OI Chg%', fmt: 'chg'   },
  { keys: ['ttv'],                     label: 'TTV',     fmt: 'vol'   },
];
const DEFAULT_OPT_COLS: ColDef[] = [
  { keys: ['current_price', 'ltp'],   label: 'LTP',     fmt: 'price' },
  { keys: ['day_change'],             label: 'Day%',    fmt: 'chg'   },
  { keys: ['open_interest'],          label: 'OI',      fmt: 'oi'    },
  { keys: ['oi_change'],              label: 'OI Chg%', fmt: 'chg'   },
  { keys: ['implied_volatility'],     label: 'IV%',     fmt: 'iv'    },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function findCol(headers: any[], colDef: ColDef): number {
  for (const key of colDef.keys) {
    const idx = headers.findIndex(h =>
      h.name === key || h.name?.toLowerCase() === key || h.name?.toLowerCase().includes(key.toLowerCase())
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

function formatCell(val: any, fmt: ColFmt): string {
  if (val == null || val === '' || val === 'null') return '—';
  const n = typeof val === 'number' ? val : parseFloat(val);
  if (isNaN(n)) return String(val);
  switch (fmt) {
    case 'price':  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    case 'oi':     return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toFixed(0);
    case 'vol':    return n >= 1e7 ? `${(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `${(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toFixed(0);
    case 'iv':     return `${n.toFixed(1)}`;
    case 'greek':  return n.toFixed(2);
    case 'chg':    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
    case 'coc':    return `${n.toFixed(2)}%`;
    case 'basis':  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
    default:       return n.toFixed(2);
  }
}

function cellColor(val: any, fmt: ColFmt): string {
  const n = typeof val === 'number' ? val : parseFloat(val);
  if (isNaN(n)) return 'text-slate-400';
  switch (fmt) {
    case 'chg':
    case 'coc':
    case 'basis':  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-slate-400';
    case 'iv':     return n > 30 ? 'text-amber-400' : n > 20 ? 'text-yellow-400' : 'text-slate-300';
    case 'greek':  return 'text-indigo-300';
    case 'oi':     return 'text-white font-semibold';
    default:       return 'text-white';
  }
}

function getMoneyness(delta: number | null): { label: string; cls: string } | null {
  if (delta == null) return null;
  const abs = Math.abs(delta);
  if (abs >= 0.65) return { label: 'ITM', cls: 'bg-emerald-500/20 text-emerald-400' };
  if (abs >= 0.35) return { label: 'ATM', cls: 'bg-yellow-500/20 text-yellow-400' };
  return { label: 'OTM', cls: 'bg-slate-700 text-slate-400' };
}

// ── Market intelligence summary ─────────────────────────────────────────────
function useIntelligence(rows: any[][], isOptions: boolean) {
  return useMemo(() => {
    if (!rows.length) return null;
    const builtup = rows.map(r => (typeof r[r.length - 1] === 'string' ? r[r.length - 1] : null));
    const bull = builtup.filter(b => b === 'Long Build Up' || b === 'Short Covering').length;
    const bear = builtup.filter(b => b === 'Short Build Up' || b === 'Long Unwinding').length;
    const neutral = rows.length - bull - bear;
    const dominantBuildup = (() => {
      const counts: Record<string, number> = {};
      builtup.forEach(b => { if (b) counts[b] = (counts[b] || 0) + 1; });
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Mixed';
    })();

    let avgIV: number | null = null;
    let avgIVChg: number | null = null;
    let avgOIChg: number | null = null;
    let totalOI: number | null = null;

    if (isOptions) {
      // OI at index 8, OI chg% at 10, IV at 11, IV chg% at 12
      const ivs = rows.map(r => typeof r[11] === 'number' ? r[11] : null).filter(Boolean) as number[];
      const ivChgs = rows.map(r => typeof r[12] === 'number' ? r[12] : null).filter(Boolean) as number[];
      const oiChgs = rows.map(r => typeof r[10] === 'number' ? r[10] : null).filter(Boolean) as number[];
      avgIV = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
      avgIVChg = ivChgs.length ? ivChgs.reduce((a, b) => a + b, 0) / ivChgs.length : null;
      avgOIChg = oiChgs.length ? oiChgs.reduce((a, b) => a + b, 0) / oiChgs.length : null;
      totalOI = rows.reduce((sum, r) => sum + (typeof r[8] === 'number' ? r[8] : 0), 0);
    } else {
      // OI at index 7, OI chg% at 8
      const oiChgs = rows.map(r => typeof r[8] === 'number' ? r[8] : null).filter(v => v != null) as number[];
      avgOIChg = oiChgs.length ? oiChgs.reduce((a, b) => a + b, 0) / oiChgs.length : null;
      totalOI = rows.reduce((sum, r) => sum + (typeof r[7] === 'number' ? r[7] : 0), 0);
    }

    const sentimentPct = rows.length ? Math.round((bull / rows.length) * 100) : 50;
    return { total: rows.length, bull, bear, neutral, sentimentPct, dominantBuildup, avgIV, avgIVChg, avgOIChg, totalOI };
  }, [rows, isOptions]);
}

// ── Sub-components ──────────────────────────────────────────────────────────
const SentimentMeter: React.FC<{ pct: number; bull: number; bear: number; total: number }> = ({ pct, bull, bear, total }) => {
  const color = pct >= 60 ? 'bg-emerald-500' : pct <= 40 ? 'bg-rose-500' : 'bg-amber-500';
  const label = pct >= 60 ? 'Bullish' : pct <= 40 ? 'Bearish' : 'Neutral';
  return (
    <div className="flex-1 min-w-[180px] p-4 bg-slate-900/60 border border-slate-800/50 rounded-2xl">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Market Sentiment</p>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
        </div>
        <span className={cn("text-[10px] font-black uppercase", pct >= 60 ? 'text-emerald-400' : pct <= 40 ? 'text-rose-400' : 'text-amber-400')}>{label}</span>
      </div>
      <div className="flex gap-3 mt-2">
        <span className="text-[10px] text-emerald-500 font-black">▲ {bull} Bull</span>
        <span className="text-[10px] text-rose-500 font-black">▼ {bear} Bear</span>
        <span className="text-[10px] text-slate-400 font-bold">● {total} Total</span>
      </div>
    </div>
  );
};

// ── Main Component ──────────────────────────────────────────────────────────
const FnOIntelligenceCenter: React.FC<FnOScannerProps> = ({ onSelectStock }) => {
  const [activeTab, setActiveTab] = useState<'options' | 'futures'>('futures');
  const [activeScanner, setActiveScanner] = useState<string>('long-build-up');
  const [instType, setInstType] = useState<'all' | 'index' | 'stock'>('all');

  const { data: scannerData, isLoading } = trpc.getTrendlyneFnoScanners.useQuery({
    mtype: activeTab,
    screenType: activeScanner,
    instType: instType === 'all' ? undefined : instType,
  });

  const scanners = {
    futures: [
      { id: 'long-build-up',    name: 'Long Buildup',    icon: TrendingUp,   desc: 'Price ↑ + OI ↑ — Bullish Accumulation',      sentiment: 'bullish' },
      { id: 'short-build-up',   name: 'Short Buildup',   icon: TrendingDown, desc: 'Price ↓ + OI ↑ — Fresh Short Positions',      sentiment: 'bearish' },
      { id: 'short-covering',   name: 'Short Covering',  icon: Zap,          desc: 'Price ↑ + OI ↓ — Shorts Being Squeezed',      sentiment: 'bullish' },
      { id: 'long-unwinding',   name: 'Long Unwinding',  icon: ShieldAlert,  desc: 'Price ↓ + OI ↓ — Longs Exiting',             sentiment: 'bearish' },
      { id: 'oi-gainers',       name: 'OI Gainers',      icon: Activity,     desc: 'Maximum Open Interest Addition',              sentiment: 'neutral' },
      { id: 'premium',          name: 'High Premium',    icon: Target,       desc: 'Futures trading above Spot — Bullish Basis',  sentiment: 'bullish' },
      { id: 'discount',         name: 'High Discount',   icon: ShieldAlert,  desc: 'Futures trading below Spot — Bearish Basis',  sentiment: 'bearish' },
      { id: 'most-active-value',name: 'Most Active',     icon: Flame,        desc: 'Highest Turnover — Institutional Interest',   sentiment: 'neutral' },
    ],
    options: [
      { id: 'oi-gainers-call',  name: 'Call OI Gainers', icon: TrendingUp,   desc: 'Max Call OI Addition — Resistance Building',  sentiment: 'bearish' },
      { id: 'oi-gainers-put',   name: 'Put OI Gainers',  icon: TrendingDown, desc: 'Max Put OI Addition — Support Building',      sentiment: 'bullish' },
      { id: 'iv-rise',          name: 'IV Spike',         icon: Zap,          desc: 'IV Rising — Event/Breakout Anticipated',     sentiment: 'neutral' },
      { id: 'iv-fall',          name: 'IV Crush',         icon: ShieldAlert,  desc: 'IV Falling — Theta Sellers Profiting',        sentiment: 'neutral' },
      { id: 'most-active-value',name: 'Most Active',      icon: Flame,        desc: 'Highest Turnover — Smart Money Focus',        sentiment: 'neutral' },
      { id: 'long-build-up',    name: 'Long Buildup',     icon: TrendingUp,   desc: 'Option Longs Accumulating',                  sentiment: 'bullish' },
      { id: 'short-build-up',   name: 'Short Buildup',    icon: TrendingDown, desc: 'Option Writers Adding Shorts',                sentiment: 'bearish' },
      { id: 'short-covering',   name: 'Short Covering',   icon: Zap,          desc: 'Option Shorts Being Covered',                sentiment: 'bullish' },
    ]
  };

  const headers: any[] = scannerData?.header || [];
  const rows: any[][] = scannerData?.tableData || [];
  const isOptions = activeTab === 'options';
  const intel = useIntelligence(rows, isOptions);

  // Build column map using header names
  const colConfig = isOptions
    ? (OPTIONS_COLS[activeScanner] || DEFAULT_OPT_COLS)
    : (FUTURES_COLS[activeScanner] || DEFAULT_FUT_COLS);

  const resolvedCols = colConfig.map(def => ({ def, idx: findCol(headers, def) })).filter(c => c.idx >= 0);

  // For options: find delta column index for moneyness
  const deltaIdx = isOptions ? findCol(headers, { keys: ['delta'], label: '', fmt: 'greek' }) : -1;
  // Find OI change % index for the mini-bar
  const oiChgIdx = isOptions
    ? findCol(headers, { keys: ['oi_change', 'oichange'], label: '', fmt: 'chg' })
    : findCol(headers, { keys: ['oi_change', 'oichange'], label: '', fmt: 'chg' });
  const maxOIChg = rows.length > 0
    ? Math.max(...rows.map(r => Math.abs(typeof r[oiChgIdx] === 'number' ? r[oiChgIdx] : 0)))
    : 1;

  const currentScanner = scanners[activeTab].find(s => s.id === activeScanner);

  // Dynamic expert commentary from actual data
  const expertCommentary = useMemo(() => {
    if (!intel || intel.total === 0) return 'Awaiting live data to generate commentary...';
    const dominant = intel.dominantBuildup;
    const sentStr = intel.sentimentPct >= 60 ? 'bullish' : intel.sentimentPct <= 40 ? 'bearish' : 'mixed';
    const oiStr = intel.avgOIChg != null ? `Average OI change of ${intel.avgOIChg >= 0 ? '+' : ''}${intel.avgOIChg.toFixed(1)}% signals ${Math.abs(intel.avgOIChg) > 15 ? 'aggressive' : 'moderate'} ${intel.avgOIChg >= 0 ? 'fresh positioning' : 'position unwinding'}.` : '';
    const ivStr = intel.avgIV != null ? ` Current average IV at ${intel.avgIV.toFixed(1)}% with ${intel.avgIVChg != null && intel.avgIVChg > 0 ? 'rising' : 'falling'} momentum.` : '';
    return `${intel.total} signals scanned — ${dominant} dominates with a ${sentStr} bias across ${intel.bull} bullish vs ${intel.bear} bearish readings. ${oiStr}${ivStr}`;
  }, [intel]);

  const strategyNote = useMemo(() => {
    const futNotes: Record<string, string> = {
      'long-build-up':    'Fresh longs with rising OI confirm trend strength. Look for stocks where OI Chg% > 15% AND Price Chg% > 1% for highest conviction setups. Cost of Carry above 10% signals strong rollover intent.',
      'short-build-up':   'Aggressive short sellers are building positions. Focus on high OI stocks nearing technical resistance. Stocks with CoC trending negative indicate heaviest short pressure.',
      'short-covering':   'Trapped shorts covering losses create momentum spikes. These moves can be violent but short-lived. Prioritize stocks where OI fell >20% to identify the most squeezed positions.',
      'long-unwinding':   'Smart money is exiting long positions. Can signal trend exhaustion or profit-booking at highs. High-OI unwind with falling volume often precedes sharp reversals.',
      'oi-gainers':       'Pure OI accumulation without buildup context means positioning is ambiguous — watch price direction next session. Largest OI gainers often become the session\'s leaders.',
      'premium':          'High basis/premium reflects strong bullish conviction in futures vs spot. Cost of Carry above 15% annualised is extreme — usually corrects via spot rally or futures decline.',
      'discount':         'Futures at discount signals near-term bearish bias or dividend anticipation. Discount > 1% often arises from aggressive put buying or index arbitrage unwinding.',
      'most-active-value':'Institutional volume hotspots. Heavy TTV without OI change = churning (no new conviction). TTV surge with OI spike = directional bet being placed.',
    };
    const optNotes: Record<string, string> = {
      'oi-gainers-call':  'Max Call OI concentration = market\'s overhead resistance zone. Strikes with highest OI become "Max Pain" magnets. Sellers writing here expect price stays below that level.',
      'oi-gainers-put':   'Max Put OI concentration = market\'s support floor. Put writers at key strikes signal confidence in holding that level. Watch for gamma squeeze if spot approaches these strikes.',
      'iv-rise':          'Rising IV signals market uncertainty or anticipation of a big move. Options buyers benefit most here. Focus on names where IV is rising but the underlying is still quiet — the explosion is coming.',
      'iv-fall':          'Falling IV (IV crush) rewards option sellers and premium sellers. Best for covered calls, put writing, or short straddles. Theta decay accelerates when IV contracts.',
      'long-build-up':    'Options accumulation — calls being bought (bullish) or puts being written (also bullish). High delta + rising OI = directional bet being placed with conviction.',
      'short-build-up':   'Option writers adding short positions signals expectation of range-bound or opposite movement. Watch gamma risk if price breaches strike levels.',
      'short-covering':   'Traders who wrote options are buying them back — often accelerates near expiry. Focus on high-OI strikes where theta erodes rapidly to catch the fastest movers.',
      'most-active-value':'Most liquid options attract institutional hedging and speculative flow. Use TTV/OI ratio to identify where premium is being paid vs. collected.',
    };
    const notes = activeTab === 'futures' ? futNotes : optNotes;
    return notes[activeScanner] || 'Monitor overall OI trends, buildup patterns, and price-volume confirmation before initiating positions.';
  }, [activeScanner]);

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h1 className="text-3xl font-black text-white italic uppercase tracking-tighter">F&O Intelligence Center</h1>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1 italic">Real-time derivative analytics — {scannerData?.expiry ? `Expiry: ${scannerData.expiry}` : 'Live'}</p>
        </div>

        <div className="flex flex-col gap-3 items-end">
          <div className="flex glass border border-slate-800/50 p-1 rounded-2xl">
            <button onClick={() => { setActiveTab('futures'); setActiveScanner('long-build-up'); }}
              className={cn("px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all",
                activeTab === 'futures' ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20" : "text-slate-400 hover:text-slate-300")}>
              Futures
            </button>
            <button onClick={() => { setActiveTab('options'); setActiveScanner('oi-gainers-call'); }}
              className={cn("px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all",
                activeTab === 'options' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:text-slate-300")}>
              Options
            </button>
          </div>
          <div className="flex glass border border-slate-800/50 p-1 rounded-xl gap-0.5">
            {(['all', 'index', 'stock'] as const).map(t => (
              <button key={t} onClick={() => setInstType(t)}
                className={cn("px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all",
                  instType === t ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-400")}>
                {t === 'all' ? 'All' : t === 'index' ? 'Indices' : 'Stocks'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Heatmap */}
      <FnOHeatmap onSelectStock={onSelectStock} />

      {/* Market Intelligence Summary Strip */}
      {intel && intel.total > 0 && (
        <div className="flex flex-wrap gap-3">
          <SentimentMeter pct={intel.sentimentPct} bull={intel.bull} bear={intel.bear} total={intel.total} />

          <div className="flex-1 min-w-[140px] p-4 bg-slate-900/60 border border-slate-800/50 rounded-2xl">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Dominant Buildup</p>
            <p className={cn("text-sm font-black uppercase italic",
              BUILDUP_META[intel.dominantBuildup]?.signal === 'bullish' ? 'text-emerald-400' :
              BUILDUP_META[intel.dominantBuildup]?.signal === 'bearish' ? 'text-rose-400' : 'text-amber-400')}>
              {intel.dominantBuildup}
            </p>
            <p className="text-[10px] text-slate-400 font-bold mt-1 uppercase tracking-widest">
              {BUILDUP_META[intel.dominantBuildup]?.signal === 'bullish' ? '→ Smart money accumulating' :
               BUILDUP_META[intel.dominantBuildup]?.signal === 'bearish' ? '→ Distribution underway' : '→ Mixed signals'}
            </p>
          </div>

          {intel.avgOIChg != null && (
            <div className="flex-1 min-w-[130px] p-4 bg-slate-900/60 border border-slate-800/50 rounded-2xl">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Avg OI Change</p>
              <p className={cn("text-xl font-black tabular-nums italic",
                intel.avgOIChg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {intel.avgOIChg >= 0 ? '+' : ''}{intel.avgOIChg.toFixed(1)}%
              </p>
              <p className="text-[10px] text-slate-400 font-bold mt-1 uppercase tracking-widest">
                {Math.abs(intel.avgOIChg) > 20 ? 'Aggressive' : Math.abs(intel.avgOIChg) > 10 ? 'Moderate' : 'Mild'} flow
              </p>
            </div>
          )}

          {intel.avgIV != null && (
            <div className="flex-1 min-w-[130px] p-4 bg-slate-900/60 border border-slate-800/50 rounded-2xl">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Avg IV</p>
              <p className={cn("text-xl font-black tabular-nums italic",
                intel.avgIV > 30 ? 'text-amber-400' : intel.avgIV > 20 ? 'text-yellow-400' : 'text-slate-300')}>
                {intel.avgIV.toFixed(1)}%
              </p>
              <p className={cn("text-[10px] font-bold mt-1 uppercase tracking-widest",
                intel.avgIVChg != null && intel.avgIVChg > 0 ? 'text-amber-500' : 'text-slate-400')}>
                {intel.avgIVChg != null ? `${intel.avgIVChg >= 0 ? '+' : ''}${intel.avgIVChg.toFixed(1)}% vs prev` : 'Implied Volatility'}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Sidebar Scanners */}
        <div className="lg:col-span-3 space-y-2">
          <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
            <Filter className="w-3 h-3" /> Select Strategy
          </h3>
          {scanners[activeTab].map(s => (
            <button key={s.id} onClick={() => setActiveScanner(s.id)}
              className={cn("w-full p-3.5 rounded-2xl border text-left transition-all group relative overflow-hidden",
                activeScanner === s.id ? "bg-slate-800 border-blue-500/50" : "glass-strong border-slate-800/50 hover:border-slate-800/30")}>
              <div className="flex items-center gap-3 relative z-10">
                <div className={cn("p-2 rounded-xl transition-colors flex-shrink-0",
                  activeScanner === s.id ? "bg-blue-500 text-white" : "glass text-slate-400 group-hover:text-slate-300")}>
                  <s.icon className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className={cn("text-[11px] font-black uppercase tracking-tight truncate",
                      activeScanner === s.id ? "text-white" : "text-slate-400")}>{s.name}</p>
                    <span className={cn("text-[7px] font-black px-1 py-0.5 rounded uppercase flex-shrink-0",
                      s.sentiment === 'bullish' ? 'bg-emerald-500/10 text-emerald-500' :
                      s.sentiment === 'bearish' ? 'bg-rose-500/10 text-rose-500' : 'bg-slate-800 text-slate-400')}>
                      {s.sentiment}
                    </span>
                  </div>
                  <p className="text-[9.5px] font-bold text-slate-400 uppercase tracking-widest mt-0.5 leading-tight">{s.desc}</p>
                </div>
              </div>
              {activeScanner === s.id && <div className="absolute right-0 top-0 bottom-0 w-1 bg-blue-500" />}
            </button>
          ))}
        </div>

        {/* Main Panel */}
        <div className="lg:col-span-9 space-y-5">
          <Card title={`${(currentScanner?.name || activeScanner).toUpperCase()} — ${instType === 'all' ? 'All F&O' : instType === 'index' ? 'Index' : 'Stocks'}`} icon={BarChart3}>
            <div className="overflow-x-auto rounded-2xl border border-slate-800/30 glass-strong/50">
              {isLoading ? (
                <div className="py-48 flex flex-col items-center justify-center space-y-4">
                  <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] animate-pulse">Scanning F&O Universe...</p>
                </div>
              ) : rows.length > 0 ? (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-900/60">
                      <th className="px-5 py-3.5 font-black text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-800/50">Asset</th>
                      {isOptions && (
                        <th className="px-3 py-3.5 font-black text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-800/50 text-center">Type</th>
                      )}
                      {resolvedCols.map(({ def }) => (
                        <th key={def.label} className="px-5 py-3.5 font-black text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-800/50 text-right">{def.label}</th>
                      ))}
                      <th className="px-3 py-3.5 font-black text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-800/50 text-center">OI Flow</th>
                      <th className="px-4 py-3.5 font-black text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-800/50 text-center">Signal</th>
                      <th className="px-4 py-3.5 font-black text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-800/50 text-right">Go</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/30">
                    {rows.map((row, idx) => {
                      const stockInfo = row[0];
                      const cb = stockInfo?.callbackinfo || {};
                      const nseCode = cb.nseCode || stockInfo?.name || 'Unknown';
                      const buildup: string | null = typeof row[row.length - 1] === 'string' ? row[row.length - 1] : null;
                      const buildupMeta = buildup ? BUILDUP_META[buildup] : null;

                      // Options-specific
                      const optType = isOptions ? String(row[1] || '') : undefined;
                      const strikePrice = isOptions && typeof row[2] === 'number' ? row[2] : undefined;
                      const deltaVal = deltaIdx >= 0 ? (typeof row[deltaIdx] === 'number' ? row[deltaIdx] : null) : null;
                      const moneyness = isOptions && deltaVal != null ? getMoneyness(deltaVal) : null;

                      // OI change for mini-bar
                      const oiChgVal = oiChgIdx >= 0 ? (typeof row[oiChgIdx] === 'number' ? row[oiChgIdx] : 0) : 0;
                      const barWidth = maxOIChg > 0 ? Math.min(100, Math.abs(oiChgVal / maxOIChg) * 100) : 0;
                      const barColor = oiChgVal >= 0 ? 'bg-emerald-500' : 'bg-rose-500';

                      return (
                        <tr key={idx} className="hover:bg-slate-800/20 group transition-all cursor-pointer" onClick={() => onSelectStock(nseCode)}>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className={cn("p-1.5 rounded-lg transition-colors",
                                buildupMeta?.signal === 'bullish' ? 'bg-emerald-500/10' :
                                buildupMeta?.signal === 'bearish' ? 'bg-rose-500/10' : 'glass')}>
                                {buildupMeta?.signal === 'bullish' ? <TrendingUp className="w-3 h-3 text-emerald-400" /> :
                                 buildupMeta?.signal === 'bearish' ? <TrendingDown className="w-3 h-3 text-rose-400" /> :
                                 <Activity className="w-3 h-3 text-slate-400" />}
                              </div>
                              <div>
                                <p className="text-[11px] font-black text-white group-hover:text-blue-400 transition-colors uppercase italic leading-none">{stockInfo?.name}</p>
                                {isOptions && strikePrice != null ? (
                                  <div className="flex items-center gap-1 mt-0.5">
                                    <p className="text-[10px] text-slate-400 font-bold">₹{strikePrice.toLocaleString('en-IN')}</p>
                                    {moneyness && (
                                      <span className={cn("text-[7px] font-black px-1 py-0.5 rounded", moneyness.cls)}>{moneyness.label}</span>
                                    )}
                                  </div>
                                ) : (
                                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{nseCode}</p>
                                )}
                              </div>
                            </div>
                          </td>

                          {isOptions && optType && (
                            <td className="px-3 py-3.5 text-center">
                              <span className={cn("px-1.5 py-0.5 rounded text-[9.5px] font-black uppercase",
                                optType === 'Call' ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                                {optType === 'Call' ? 'CE' : 'PE'}
                              </span>
                            </td>
                          )}

                          {resolvedCols.map(({ def, idx: colIdx }) => {
                            const val = row[colIdx];
                            const formatted = formatCell(val, def.fmt);
                            const color = cellColor(val, def.fmt);
                            return (
                              <td key={def.label} className={cn("px-5 py-3.5 text-right text-[10px] tabular-nums font-medium", color)}>
                                {formatted}
                              </td>
                            );
                          })}

                          {/* OI Flow mini-bar */}
                          <td className="px-3 py-3.5">
                            <div className="flex flex-col items-center gap-1 w-16">
                              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div className={cn("h-full rounded-full", barColor)} style={{ width: `${barWidth}%` }} />
                              </div>
                              <span className={cn("text-[9.5px] font-black tabular-nums",
                                oiChgVal >= 0 ? 'text-emerald-500' : 'text-rose-500')}>
                                {oiChgVal >= 0 ? '+' : ''}{oiChgVal.toFixed(1)}%
                              </span>
                            </div>
                          </td>

                          {/* Signal badge */}
                          <td className="px-4 py-3.5 text-center">
                            {buildup ? (
                              <span className={cn("px-2 py-0.5 rounded-full text-[7px] font-black uppercase whitespace-nowrap border",
                                buildupMeta?.color || 'bg-slate-800 text-slate-400 border-slate-800/30')}>
                                {buildupMeta?.icon} {buildup}
                              </span>
                            ) : <Eye className="w-3 h-3 text-slate-300 mx-auto" />}
                          </td>

                          <td className="px-4 py-3.5 text-right">
                            <button
                              onClick={e => { e.stopPropagation(); onSelectStock(nseCode); }}
                              className="p-1.5 glass border border-slate-800/50 rounded-lg text-slate-400 hover:text-white hover:border-slate-600 transition-all">
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="py-24 text-center">
                  <AlertTriangle className="w-8 h-8 text-slate-200 mx-auto mb-4" />
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">No signals detected — market may be closed or data loading</p>
                </div>
              )}
            </div>
          </Card>

          {/* Intelligence Commentary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="p-5 bg-blue-500/5 border border-blue-500/20 rounded-3xl relative overflow-hidden">
              <Zap className="absolute -right-4 -bottom-4 w-20 h-20 text-blue-500/10 -rotate-12" />
              <div className="flex items-center gap-2 mb-2">
                <Eye className="w-3 h-3 text-blue-400" />
                <h4 className="text-[10px] font-black text-blue-400 uppercase tracking-widest italic">Live Market Read</h4>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed font-medium relative z-10 italic">
                "{expertCommentary}"
              </p>
            </div>

            <div className="p-5 bg-emerald-500/5 border border-emerald-500/20 rounded-3xl relative overflow-hidden">
              <Target className="absolute -right-4 -bottom-4 w-20 h-20 text-emerald-500/10 -rotate-12" />
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-3 h-3 text-emerald-400" />
                <h4 className="text-[10px] font-black text-emerald-400 uppercase tracking-widest italic">Strategy Playbook</h4>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed font-medium relative z-10 italic">
                {strategyNote}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FnOIntelligenceCenter;
