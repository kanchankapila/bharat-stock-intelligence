import React, { useState, useEffect, useMemo, useRef } from 'react';
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, BarChart, Bar } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import {
  Activity, Zap, TrendingUp, ArrowUpRight, ArrowDownRight,
  History, Plus, RefreshCw, Cpu, Radio, BarChart2,
  Search, ShieldAlert, Target, Sparkles, Layers, BookOpen,
  CheckCircle, ChevronDown, HelpCircle, Briefcase, Award,
  Sliders, TrendingDown, Eye, PlusCircle, Check, X
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '../../../lib/utils';
import { trpc } from '../../../lib/trpc';
import { useNewsFeed } from '../../../services/newsService';
import type { MarketData } from '../../../services/marketService';
import { V2LightweightChart } from '../../../v2/components/widgets/V2LightweightChart';
import { OptionChainView } from '../../../components/OptionChainView';
import { MarketIndices } from '../../../components/MarketIndices';
import { SectorHeatmap } from '../../../components/SectorIntelligence';
import { MomentumIntelligence } from '../../../components/MomentumIntelligence';
import { TopMoversIntelligence } from '../../../components/TopMoversIntelligence';
import { IntradayBreakouts } from '../../../components/IntradayBreakouts';
import { IndexOverview } from '../../../components/MarketInsights';
import { ModelRocPanel } from '../../../components/ModelRocPanel';
import { GlobalMarkets } from '../../../components/GlobalMarkets';
import { PremarketPanel } from '../../../components/PremarketPanel';
import { LiveMarketScreener } from '../../../components/LiveMarketScreener';
import { EODMarketScreener } from '../../../components/EODMarketScreener';
import TrendlyneScreenerPanel from '../../../components/TrendlyneScreenerPanel';

// Fonts & styling details
const FONT_FAMILY_DISPLAY = "'Rajdhani', sans-serif";
const FONT_FAMILY_MONO = "'Space Mono', monospace";
const emerald = '#10b981';
const rose = '#ef4444';
const amber = '#f59e0b';
const hold = '#eab308';

function fmtPct(n: number) {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

// ─── ScoreGauge ─────────────────────────────────────────────────────────────
const ScoreGauge: React.FC<{ value: number | null | undefined }> = ({ value }) => {
  const r = 40;
  const c = 50;
  const circ = 2 * Math.PI * r;
  const has = value != null && Number.isFinite(value);
  const v = has ? (value as number) : 0;
  const pct = Math.min(v, 100) / 100;
  const color = !has ? '#64748b' : v >= 75 ? emerald : v >= 50 ? amber : rose;

  return (
    <div className="flex flex-col items-center justify-center relative w-24 h-24">
      <svg width={85} height={85} viewBox="0 0 100 100" className="transform -rotate-90">
        <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth={8} />
        <motion.circle
          cx={c} cy={c} r={r}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: circ }}
          animate={{ strokeDashoffset: circ * (1 - pct) }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 6px ${color}60)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-black font-mono tracking-tighter text-slate-100">{has ? v : 'N/A'}</span>
        <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest font-mono">QUANT SCORE</span>
      </div>
    </div>
  );
};

// ─── BreadthGauge ─────────────────────────────────────────────────────────────
const BreadthGauge: React.FC<{ stocks: MarketData[] }> = ({ stocks }) => {
  const adv = stocks.filter(s => s.changePct > 0).length;
  const dec = stocks.filter(s => s.changePct < 0).length;
  const total = adv + dec || 1;
  const ratio = adv / total;

  const R = 54;
  const cx = 70; const cy = 70;
  const startAngle = Math.PI * 0.85;
  const endAngle   = Math.PI * 0.15;
  const sweep      = 2 * Math.PI - (startAngle - endAngle);

  const arcPath = (fraction: number, r: number) => {
    const start = startAngle;
    const end   = start + sweep * fraction;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const large = sweep * fraction > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const gaugeColor = ratio > 0.6 ? emerald : ratio < 0.4 ? rose : hold;

  return (
    <div className="flex flex-col items-center">
      <svg width={130} height={90} viewBox="0 0 140 100">
        <path d={arcPath(1, R)} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={8} strokeLinecap="round" />
        <motion.path
          d={arcPath(ratio, R)}
          fill="none"
          stroke={gaugeColor}
          strokeWidth={8}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: ratio }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 6px ${gaugeColor}88)` }}
        />
        <text x={cx} y={cy - 4} textAnchor="middle"
          style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 18, fontWeight: 700, fill: '#f8fafc' }}>
          {Math.round(ratio * 100)}%
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle"
          style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 8, fill: '#475569', letterSpacing: 2, textTransform: 'uppercase' }}>
          BREADTH
        </text>
        <text x={12} y={90} style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, fill: rose }}>{dec}↓</text>
        <text x={112} y={90} style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, fill: emerald }}>{adv}↑</text>
      </svg>
    </div>
  );
};

// ─── ConfidenceRing ───────────────────────────────────────────────────────────
const ConfidenceRing: React.FC<{ value: number; signal: string }> = ({ value, signal }) => {
  const r = 14; const c = 18;
  const circ = 2 * Math.PI * r;
  const color = signal === 'BUY' ? emerald : signal === 'SELL' ? rose : hold;
  const pct = Math.min(value, 100) / 100;

  return (
    <svg width={36} height={36} viewBox="0 0 36 36" style={{ flexShrink: 0 }}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={3} />
      <motion.circle
        cx={c} cy={c} r={r}
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circ}
        initial={{ strokeDashoffset: circ }}
        animate={{ strokeDashoffset: circ * (1 - pct) }}
        transition={{ duration: 0.9, ease: 'easeOut' }}
        transform={`rotate(-90 ${c} ${c})`}
        style={{ filter: `drop-shadow(0 0 4px ${color}80)` }}
      />
      <text x={c} y={c + 4} textAnchor="middle"
        style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 7, fill: '#cbd5e1', fontWeight: 700 }}>
        {value}%
      </text>
    </svg>
  );
};

// ─── SignalCard ───────────────────────────────────────────────────────────────
const SignalCard: React.FC<{
  signal: any;
  onClick: () => void;
  onHistory: () => void;
}> = ({ signal, onClick, onHistory }) => {
  const color = signal.signal === 'BUY' ? emerald : signal.signal === 'SELL' ? rose : hold;
  const bg = signal.signal === 'BUY' ? 'rgba(16,185,129,0.04)' : signal.signal === 'SELL' ? 'rgba(239,68,68,0.04)' : 'rgba(245,158,11,0.04)';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="group cursor-pointer p-3 border rounded-xl flex items-center justify-between transition-all hover:bg-slate-900/30"
      style={{
        background: bg,
        borderColor: `${color}18`,
      }}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 w-full">
        <ConfidenceRing value={signal.confidence} signal={signal.signal} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-slate-100 tracking-wider font-mono uppercase">{signal.symbol}</span>
            <span className="text-[9px] font-black font-mono tracking-widest px-2 py-0.5 rounded uppercase"
              style={{ color, background: `${color}10`, border: `1px solid ${color}20` }}>
              {signal.signal}
            </span>
          </div>
          <p className="text-[10px] text-slate-400 truncate mt-1 leading-normal font-mono">
            {signal.reasoning?.slice(0, 56) ?? ''}...
          </p>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-800/40">
            <span className="text-[9px] font-mono text-slate-500">
              Entry: ₹{signal.entry} <span className="text-emerald-400">· Target: ₹{signal.target}</span>
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onHistory(); }}
              className="flex items-center gap-1 text-[8px] font-black font-mono text-indigo-400 hover:text-indigo-300 transition-colors uppercase tracking-widest"
            >
              <History size={10} /> History
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

// ─── SignalHistoryModal ───────────────────────────────────────────────────────
const SignalHistoryModal: React.FC<{ symbol: string; onClose: () => void }> = ({ symbol, onClose }) => {
  const { data: history, isLoading } = trpc.getSignalHistory.useQuery({ symbol });

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/80 backdrop-blur-md"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative w-full max-w-xl flex flex-col max-h-[80vh] glass-strong rounded-2xl overflow-hidden"
      >
        <div className="border-b border-slate-800 p-4 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
              <History size={14} className="text-indigo-400" />
            </div>
            <div>
              <div className="text-sm font-black text-slate-100 uppercase tracking-widest font-mono">{symbol} Signal Audit</div>
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-wider font-mono mt-0.5">Historical AI Performance Ledger</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg font-bold">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 terminal-scrollbar">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Activity className="w-8 h-8 text-indigo-500 animate-pulse mb-3" />
              <p className="text-[9px] text-slate-500 font-black uppercase tracking-widest animate-pulse font-mono">Syncing Audit Trail...</p>
            </div>
          ) : history && (history as any[]).length > 0 ? (
            (history as any[]).map((sig: any) => {
              const c = sig.type === 'BUY' ? emerald : rose;
              return (
                <div key={sig.id} className="p-3 bg-slate-900/40 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-black px-2 py-0.5 rounded font-mono border"
                        style={{ color: c, borderColor: `${c}30`, background: `${c}10` }}>
                        {sig.type}
                      </span>
                      <span className="text-[9px] font-mono text-slate-500">
                        {sig.createdAt?.seconds
                          ? format(new Date(sig.createdAt.seconds * 1000), 'MMM dd yyyy, HH:mm')
                          : 'Recent'}
                      </span>
                    </div>
                    {sig.status && (
                      <span className={cn(
                        "text-[9px] font-mono font-bold uppercase",
                        sig.status === 'COMPLETED' ? "text-emerald-400" : sig.status === 'FAILED' ? "text-rose-400" : "text-slate-500"
                      )}>{sig.status}</span>
                    )}
                  </div>
                  {sig.reasoning && (
                    <p className="text-[10px] text-slate-400 leading-relaxed font-mono">
                      {sig.reasoning}
                    </p>
                  )}
                  <div className="flex gap-4 text-[9px] font-mono text-slate-500 pt-1">
                    {sig.entry && <span>Entry: ₹{sig.entry}</span>}
                    {sig.target && <span className="text-emerald-400">Target: ₹{sig.target}</span>}
                    {sig.stopLoss && <span className="text-rose-400">SL: ₹{sig.stopLoss}</span>}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-center py-12 text-slate-500 font-mono text-xs uppercase tracking-widest">No Signals Registered</div>
          )}
        </div>
      </motion.div>
    </div>
  );
};

// ─── SectionLabel ─────────────────────────────────────────────────────────────
const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-3 mb-4 select-none">
    <span className="inline-block w-8 h-0.5 bg-gradient-to-r from-indigo-500 to-transparent" />
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.25em] font-sans">{children}</span>
    <span className="inline-block flex-1 h-px bg-slate-800/40" />
  </div>
);

// ─── V3 Dashboard Main Component ──────────────────────────────────────────────
interface V3DashboardProps {
  stocks: MarketData[];
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
  onSelectStock?: (symbol: string) => void;
  onSelectIndex?: (id: string, name: string) => void;
  initialSymbol?: string;
  initialTab?: 'market-pulse' | 'quant-ml' | 'signals' | 'stock-intelligence';
}

export const V3Dashboard: React.FC<V3DashboardProps> = ({
  stocks,
  watchlist,
  onToggleWatchlist,
  onSelectStock,
  onSelectIndex,
  initialSymbol,
  initialTab,
}) => {
  const news = useNewsFeed();
  const [activeTab, setActiveTab] = useState<'market-pulse' | 'quant-ml' | 'signals' | 'stock-intelligence'>(initialTab || 'market-pulse');
  
  // Stock Search / Intelligence State
  const [searchSymbol, setSearchSymbol] = useState(initialSymbol || 'RELIANCE');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [stockDetailTab, setStockDetailTab] = useState<'Technicals' | 'Fundamentals' | 'Options'>('Technicals');
  
  // Bloomberg Terminal Command Bar States
  const [terminalInput, setTerminalInput] = useState('');
  const [showTerminalSuggestions, setShowTerminalSuggestions] = useState(false);
  const [warrenModalOpen, setWarrenModalOpen] = useState(false);
  const [warrenQuery, setWarrenQuery] = useState('');
  const [warrenOutput, setWarrenOutput] = useState('');
  const [isWarrenRunning, setIsWarrenRunning] = useState(false);

  // Sync changes to initialSymbol/initialTab
  useEffect(() => {
    if (initialSymbol) {
      setSearchSymbol(initialSymbol);
    }
  }, [initialSymbol]);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Global Keyboard Shortcuts (F2-F5 for tabs, Escape, Slash to focus command)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInputFocused = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || (activeEl as HTMLElement).isContentEditable);
      
      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        const cmdBar = document.getElementById('bbg-command-bar');
        if (cmdBar) {
          cmdBar.focus();
          (cmdBar as HTMLInputElement).select();
        }
      } else if (e.key === 'Escape') {
        if (warrenModalOpen) {
          setWarrenModalOpen(false);
          e.preventDefault();
        } else {
          setTerminalInput('');
          setShowTerminalSuggestions(false);
          const cmdBar = document.getElementById('bbg-command-bar');
          if (cmdBar && document.activeElement === cmdBar) {
            cmdBar.blur();
          }
        }
      } else if (!isInputFocused) {
        if (e.key === 'F2') {
          e.preventDefault();
          setActiveTab('market-pulse');
        } else if (e.key === 'F3') {
          e.preventDefault();
          setActiveTab('quant-ml');
        } else if (e.key === 'F4') {
          e.preventDefault();
          setActiveTab('signals');
        } else if (e.key === 'F5') {
          e.preventDefault();
          setActiveTab('stock-intelligence');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [warrenModalOpen]);

  // Modals / Signal Engine states
  const [selectedSignal, setSelectedSignal] = useState<any | null>(null);
  const [historySymbol, setHistorySymbol] = useState<string | null>(null);
  const [aiSignals, setAiSignals] = useState<any[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [queueProgress, setQueueProgress] = useState<{ completed: number; total: number } | null>(null);

  // Queries for Nifty / VIX charts
  const { data: niftyOhlc } = trpc.getOHLCData.useQuery({ symbol: 'in;NSX', dur: '1M' });
  const { data: vixData } = trpc.getIndiaVix.useQuery(undefined, { refetchInterval: 30000 });
  const { data: dashboardData } = trpc.getPerformanceDashboard.useQuery() as { data: any };
  const { data: fiiDiiData } = trpc.getFiiDiiFlow.useQuery({ days: 10 });
  const { data: featImportance } = trpc.getFeatureImportance.useQuery({ modelName: 'ensemble', topN: 8 });

  // Stock Intelligence Queries
  const { data: unifiedDataRaw, isLoading: loadingUnified } = trpc.getAlphaQuantDetail.useQuery({ symbol: searchSymbol }, { enabled: !!searchSymbol });
  const unifiedData = unifiedDataRaw as any;
  const { data: niftyTraderData, isLoading: loadingNiftyTrader } = trpc.getNiftyTraderData.useQuery({ symbol: searchSymbol }, { enabled: !!searchSymbol });
  const { data: trendlyneOverview } = trpc.getTrendlyneOverview.useQuery({ symbol: searchSymbol }, { enabled: !!searchSymbol });
  const { data: fno } = trpc.getFnOSignals.useQuery({ symbol: searchSymbol }, { enabled: !!searchSymbol });
  const { data: stockOhlc } = trpc.getOHLCData.useQuery({ symbol: searchSymbol, dur: '6M' }, { enabled: !!searchSymbol });

  // Signal Engine Enqueue Mutation
  const enqueueSignalsMutation = trpc.enqueueSignals.useMutation();
  const { data: queueStats, refetch: refetchStats } = trpc.getQueueStats.useQuery(undefined, {
    refetchInterval: isGenerating ? 2000 : false,
  });
  const { data: savedSignals, refetch: refetchSignals } = trpc.getSignals.useQuery(
    { limit: 50 },
    { refetchInterval: isGenerating ? 3000 : false },
  );

  // Auto-generate signals on load if empty
  useEffect(() => {
    if (aiSignals.length === 0 && stocks.length > 0 && !isGenerating) {
      handleGenerateSignals();
    }
  }, [stocks.length]);

  // Sync scan progress
  useEffect(() => {
    if (!isGenerating || !savedSignals) return;
    const mapped = (savedSignals as any[]).map((s: any) => ({
      symbol: s.symbol, type: s.type, signal: s.type,
      entry: s.entry, target: s.target, stopLoss: s.stopLoss,
      confidence: s.confidence, reasoning: s.reasoning,
    }));
    setAiSignals(mapped);

    if (queueStats) {
      const { waiting, active, total } = queueStats as any;
      setQueueProgress({ completed: (queueStats as any).completed ?? 0, total: total ?? 0 });
      if ((waiting === 0 && active === 0 && total > 0) || !(queueStats as any).available) {
        setIsGenerating(false);
        setQueueProgress(null);
      }
    }
  }, [queueStats, savedSignals, isGenerating]);

  const handleGenerateSignals = async () => {
    if (stocks.length === 0) return;
    setIsGenerating(true);
    setQueueProgress({ completed: 0, total: stocks.length });
    try {
      const payload = stocks.map(s => ({ symbol: s.symbol, stockData: s as unknown as Record<string, unknown> }));
      const result = await enqueueSignalsMutation.mutateAsync(payload);
      if (!result.queueAvailable) {
        setIsGenerating(false);
        setQueueProgress(null);
      } else {
        setQueueProgress({ completed: 0, total: result.queued });
        refetchStats();
        refetchSignals();
      }
    } catch {
      setIsGenerating(false);
      setQueueProgress(null);
    }
  };

  // Helper to switch to stock analysis from any card click
  const selectStockForDeepAnalysis = (symbol: string) => {
    setSearchSymbol(symbol);
    setActiveTab('stock-intelligence');
    if (onSelectStock) onSelectStock(symbol);
  };

  // Search Suggestion Logic
  const filteredSuggestions = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toUpperCase();
    return stocks.filter(s => s.symbol.toUpperCase().includes(q) || s.name.toUpperCase().includes(q)).slice(0, 8);
  }, [searchQuery, stocks]);

  const currentStockData = useMemo(() => {
    return stocks.find(s => s.symbol.toUpperCase() === searchSymbol.toUpperCase()) || stocks[0];
  }, [searchSymbol, stocks]);

  const currentStockPrice = currentStockData?.price || 1000;

  // Chart data processing for Nifty 50
  const niftyGraphData = useMemo(() => {
    const candles: any[] = niftyOhlc?.data ?? [];
    return candles.slice(-30).map((d: any, i: number) => ({
      time: i,
      value: +(d.close ?? d.c ?? 0),
    }));
  }, [niftyOhlc]);

  const chartTrending = niftyGraphData.length > 1
    ? niftyGraphData[niftyGraphData.length - 1].value >= niftyGraphData[0].value
    : true;
  const niftyColor = chartTrending ? emerald : rose;

  // Chart data processing for VIX
  const vixResult = (vixData as any)?.resultData;
  const vixGraphData = useMemo(() => {
    if (!vixResult?.chart_data) return [];
    return vixResult.chart_data.split(',').map((v: string, i: number) => ({
      time: i,
      value: parseFloat(v),
    }));
  }, [vixResult]);

  const vixTrending = (vixResult?.change_per ?? 0) >= 0;
  const vixColor = !vixTrending ? emerald : rose; // Falling VIX is bullish

  // FII/DII Net Cash Flow Processing
  const flowChartData = useMemo(() => {
    return (fiiDiiData ?? []).slice().reverse().map((f: any) => ({
      date: f.date,
      FII: f.fii_net ?? 0,
      DII: f.dii_net ?? 0,
    }));
  }, [fiiDiiData]);

  // Model Feature Importance Processing
  const featureChartData = useMemo(() => {
    return (featImportance ?? []).map((f: any) => ({
      name: f.feature_name.replace('_', ' ').toUpperCase(),
      Weight: f.importance * 100,
    }));
  }, [featImportance]);

  // Candlestick data for selected stock, from real OHLC history (Moneycontrol via getOHLCData).
  const stockCandlestickData = useMemo(() => {
    const rows: any[] = (stockOhlc as any)?.data ?? [];
    return rows
      .filter(d => d.open != null && d.high != null && d.low != null && d.close != null)
      .map(d => ({
        time: new Date(d.time * 1000).toISOString().split('T')[0],
        open: +d.open,
        high: +d.high,
        low: +d.low,
        close: +d.close,
      }));
  }, [stockOhlc]);

  // Pivot levels from the real pivotData already fetched via getNiftyTraderData; '—' when
  // a level isn't present rather than a synthetic offset that looks like a real computation.
  const pivotLevels = useMemo(() => {
    const p = (niftyTraderData as any)?.pivotData || {};
    const num = (v: any) => (v != null && !isNaN(+v)) ? +v : null;
    return {
      s2: num(p.s2), s1: num(p.s1), pp: num(p.pp ?? p.pivot), r1: num(p.r1), r2: num(p.r2),
    };
  }, [niftyTraderData]);

  // Quant Scores Factor Breakdown mappings
  const factors = unifiedData?.factors;
  const score = unifiedData?.score;
  const factorsList = [
    { label: 'Technical', val: factors?.technical ?? 0, color: 'from-blue-600 to-cyan-500', textClass: 'text-cyan-400' },
    { label: 'Fundamental', val: factors?.fundamental ?? 0, color: 'from-emerald-600 to-teal-500', textClass: 'text-emerald-400' },
    { label: 'Momentum', val: factors?.momentum ?? 0, color: 'from-violet-600 to-indigo-500', textClass: 'text-indigo-400' },
    { label: 'Valuation', val: factors?.valuation ?? 0, color: 'from-amber-600 to-yellow-500', textClass: 'text-amber-400' },
    { label: 'Delivery', val: factors?.delivery ?? 0, color: 'from-fuchsia-600 to-pink-500', textClass: 'text-fuchsia-400' },
    { label: 'News Sentiment', val: factors?.news ?? 0, color: 'from-rose-600 to-red-500', textClass: 'text-rose-400' },
  ];

  // SWOT formatting helper
  const swotCategories = trendlyneOverview?.swot ? [
    { key: 'strengths', label: 'Strengths', badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', dot: emerald },
    { key: 'weaknesses', label: 'Weaknesses', badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/20', dot: rose },
    { key: 'opportunities', label: 'Opportunities', badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/20', dot: '#3b82f6' },
    { key: 'threats', label: 'Threats', badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/20', dot: amber },
  ] : [];

  // Trendlyne Checklist variables
  const checklistData = trendlyneOverview?.checklist?.checklistData || {};
  const checklistScore = trendlyneOverview?.checklist?.score || 0;
  const checklistYes = trendlyneOverview?.checklist?.yesCount || 0;
  const checklistTotal = trendlyneOverview?.checklist?.total || 0;

  // DVM Scores
  const dvm = trendlyneOverview?.dvm;
  const qVal = dvm?.quality?.score ?? dvm?.durability?.score ?? null;
  const vVal = dvm?.valuation?.score ?? null;
  const tVal = dvm?.technicals?.score ?? dvm?.momentum?.score ?? null;

  // NSE / NiftyTrader fundamental financials helper
  const peers = niftyTraderData?.industryData?.lstFinancires || [];
  const annualPerformance = niftyTraderData?.industryData?.lstfutureprojectval || [];
  const quarterlyPerformance = niftyTraderData?.industryData?.lastThreeQTRModel || [];

  // Ratio mapping from Tradebrains
  const ratioItems = (unifiedData as any)?.ratios?.item || [];
  const getRatio = (name: string) => {
    const row = ratioItems.find((r: any) => (r.label || "").toLowerCase().includes(name.toLowerCase()));
    return row ? row.value : '—';
  };

  const advancers = stocks.filter(s => s.changePct > 0).length;
  const decliners = stocks.filter(s => s.changePct < 0).length;

  // ── Bloomberg Terminal Command Processor & Warren AI ──
  const handleExportData = () => {
    if (!searchSymbol) return;
    const dataToExport = {
      symbol: searchSymbol,
      quantDetails: unifiedData,
      financials: niftyTraderData,
      overview: trendlyneOverview,
      derivatives: fno,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${searchSymbol}_bbg_export.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const generateWarrenReport = (symbol: string, prompt: string) => {
    const stock = stocks.find(s => s.symbol.toUpperCase() === symbol.toUpperCase()) || stocks[0];
    const sName = stock?.name || symbol;
    const price = stock?.price || 0;
    const change = stock?.changePct || 0;

    const nt = niftyTraderData as any;
    const fn = fno as any;

    const isSmaBullish = nt?.movingAverages?.status === 'bullish';
    const pivot = nt?.pivotData || {};
    const gap = nt?.gaps || {};

    const pe = getRatio('PE Ratio') || '—';
    const de = getRatio('Debt to Equity') || '—';
    const pb = getRatio('PB Ratio') || '—';
    
    const scoreVal = unifiedData?.score?.score || 0;
    const trendSWOT = trendlyneOverview?.swot || {};
    const strengthsCount = trendSWOT.strengths?.length || 0;
    const weaknessesCount = trendSWOT.weaknesses?.length || 0;
    const optPCR = fn?.pcrIndex?.pcr || '—';
    const painStrike = fn?.maxPainStrike || '—';

    return `=============================================================================
BBG WARREN-AI FINANCIAL ANALYST SYSTEM v2.1 (INTEGRATED QUANT ENVIRONMENT)
=============================================================================
SECURITY EVALUATED : ${symbol} (${sName})
MARKET STATUS      : ACTIVE | PRICE: INR ${price.toLocaleString()} (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)
ANALYSIS PROMPT    : "${prompt}"
EVALUATION TIMESTAMP: ${new Date().toISOString()}

-----------------------------------------------------------------------------
1. NEURAL MULTI-FACTOR SCORECARD
-----------------------------------------------------------------------------
* ALPHA CONFIDENCE SCORE: ${scoreVal}/100 [${scoreVal >= 70 ? 'STRONG BUY CONVICTION' : scoreVal >= 50 ? 'NEUTRAL HOLD' : 'BEARISH ACCUMULATE'}]
* Technical Factor      : ${factors?.technical ?? 0}/100
* Fundamental Factor    : ${factors?.fundamental ?? 0}/100
* Momentum Factor       : ${factors?.momentum ?? 0}/100
* Valuation Factor      : ${factors?.valuation ?? 0}/100
* Delivery Factor        : ${factors?.delivery ?? 0}/100
* News Sentiment Factor : ${factors?.news ?? 0}/100

-----------------------------------------------------------------------------
2. TECHNICAL REGIME & PIVOT MATRIX
-----------------------------------------------------------------------------
* Moving Averages Trend : ${isSmaBullish ? 'BULLISH ALIGNMENT (SMA 50 > SMA 200)' : 'MIXED INDICATORS'}
* Intraday Gap Action   : ${gap.direction ? `${gap.direction.toUpperCase()} GAP OPENING AT ${gap.gapSize ?? '0.00'}%` : 'FLAT PRICE CONSOLIDATION'}
* Pivot Support (S1)    : INR ${pivot.s1 ?? '—'}
* Pivot Resistance (R1) : INR ${pivot.r1 ?? '—'}
* Narrow Range NR7 Alert: ${(niftyTraderData as any)?.nr7Pattern ? 'ALERT: NR7 NARROW RANGE DETECTED (EXPECT BREAKOUT)' : 'NORMAL VOLATILITY'}

-----------------------------------------------------------------------------
3. FUNDAMENTAL DATA & SWOT ANALYSIS
-----------------------------------------------------------------------------
* Valuation PE Multiple : ${pe} | Price-to-Book: ${pb}
* Balance Sheet Leverage: Debt-to-Equity ${de}
* Trendlyne DVM Audits  : Quality [${qVal ?? '—'}/100] | Valuation [${vVal ?? '—'}/100] | Technicals [${tVal ?? '—'}/100]
* Checklist Pass Rate   : ${checklistYes}/${checklistTotal} Audit items passed (${checklistScore}%)
* SWOT Indicators       : ${strengthsCount} Strengths | ${weaknessesCount} Weaknesses
  - Strength Highlight  : ${trendSWOT.strengths?.[0]?.text || 'Capital structure remains highly stable.'}
  - Risk Mitigation     : ${trendSWOT.weaknesses?.[0]?.text || 'Higher valuations present slight momentum friction.'}

-----------------------------------------------------------------------------
4. DERIVATIVES & OPTIONS FLOW SCAN
-----------------------------------------------------------------------------
* Put-Call Ratio (PCR)  : ${optPCR} [${parseFloat(optPCR) > 1.2 ? 'EXTREMELY BULLISH' : parseFloat(optPCR) < 0.8 ? 'OVERBOUGHT BEARISH' : 'BALANCED FLOW'}]
* Max Pain Strike Zone  : Strike Price INR ${painStrike}
* Option Chain Outlook  : Heavy Open Interest consolidation at ${painStrike} strike level.

-----------------------------------------------------------------------------
5. QUANT SUMMARY RECOMMENDATION
-----------------------------------------------------------------------------
Based on the multi-factor scoring array and SWOT profiles, ${symbol} displays ${scoreVal >= 70 ? 'strong capital appreciation momentum' : 'consolidative regime pricing'}. The quantitative model advises: ${scoreVal >= 70 ? 'ACCUMULATE on minor pullbacks' : 'HOLD position while monitoring PCR shifts'}.

=============================================================================
[WARREN-AI SYSTEM ONLINE - REPORT GENERATED COMPLETELY - ESC TO EXIT]
=============================================================================`;
  };

  const triggerWarrenAI = (prompt: string) => {
    setWarrenQuery(prompt);
    setWarrenModalOpen(true);
    setIsWarrenRunning(true);
    setWarrenOutput('');

    const fullReport = generateWarrenReport(searchSymbol, prompt);
    let index = 0;
    
    const interval = setInterval(() => {
      if (index < fullReport.length) {
        setWarrenOutput(prev => prev + fullReport.substr(index, 3));
        index += 3;
      } else {
        setIsWarrenRunning(false);
        clearInterval(interval);
      }
    }, 15);
  };

  const executeTerminalCommand = (rawCmd: string) => {
    const cmd = rawCmd.trim();
    if (!cmd) return;

    if (cmd.toUpperCase() === 'HELP') {
      alert("Bloomberg Terminal Shortcuts Guide:\n" +
            "- F2: Market Pulse\n" +
            "- F3: Quant & ML Registry\n" +
            "- F4: Signals & Scanners\n" +
            "- F5: Stock Intelligence\n" +
            "- <SYMBOL> DES: Views Description of Stock\n" +
            "- <SYMBOL> CAND: Views Candle Chart\n" +
            "- <SYMBOL> FIN: Views Financials\n" +
            "- <SYMBOL> OPT: Views Option Chain\n" +
            "- FED / TREAS / ECON: Macro Views\n" +
            "- EXPORT: Download Stock Data JSON\n" +
            "- ASK '<query>': AI Quant Report Card");
      setTerminalInput('');
      return;
    }

    if (cmd.toUpperCase() === 'EXPORT') {
      handleExportData();
      setTerminalInput('');
      return;
    }

    if (cmd.toUpperCase().startsWith('ASK ') || cmd.toLowerCase().startsWith('/ask ')) {
      const queryContent = cmd.substring(4).replace(/['"]/g, '').trim();
      triggerWarrenAI(queryContent);
      setTerminalInput('');
      return;
    }

    const parts = cmd.toUpperCase().split(/\s+/);
    if (parts.length === 2) {
      const symbolCandidate = parts[0];
      const fnCandidate = parts[1];

      const matchedStock = stocks.find(s => s.symbol.toUpperCase() === symbolCandidate);
      if (matchedStock) {
        setSearchSymbol(matchedStock.symbol);
        setActiveTab('stock-intelligence');
        if (['DES', 'FIN'].includes(fnCandidate)) {
          setStockDetailTab('Fundamentals');
        } else if (fnCandidate === 'CAND') {
          setStockDetailTab('Technicals');
        } else if (fnCandidate === 'OPT') {
          setStockDetailTab('Options');
        }
      }
    } else if (parts.length === 1) {
      const token = parts[0];
      if (['DES', 'FIN'].includes(token)) {
        setActiveTab('stock-intelligence');
        setStockDetailTab('Fundamentals');
      } else if (token === 'CAND') {
        setActiveTab('stock-intelligence');
        setStockDetailTab('Technicals');
      } else if (token === 'OPT') {
        setActiveTab('stock-intelligence');
        setStockDetailTab('Options');
      } else if (token === 'ECON') {
        setActiveTab('market-pulse');
      } else if (token === 'FED' || token === 'TREAS') {
        setActiveTab('market-pulse');
      } else {
        const matchedStock = stocks.find(s => s.symbol.toUpperCase() === token);
        if (matchedStock) {
          setSearchSymbol(matchedStock.symbol);
          setActiveTab('stock-intelligence');
        }
      }
    }

    setTerminalInput('');
    setShowTerminalSuggestions(false);
  };

  const filteredTerminalSuggestions = useMemo(() => {
    const q = terminalInput.trim().toUpperCase();
    if (!q) return [];
    
    const allShortcuts = [
      { command: `${searchSymbol} DES`, desc: `Description of ${searchSymbol}` },
      { command: `${searchSymbol} CAND`, desc: `Candle Chart of ${searchSymbol}` },
      { command: `${searchSymbol} FIN`, desc: `Financials for ${searchSymbol}` },
      { command: `${searchSymbol} OPT`, desc: `Options Chain for ${searchSymbol}` },
      { command: 'ECON', desc: 'Economic calendar' },
      { command: 'FED', desc: 'FRED Macro index statistics' },
      { command: 'TREAS', desc: 'US Treasury yield levels' },
      { command: 'EXPORT', desc: 'Export details to JSON file' },
      { command: `ASK "Evaluate SWOT for ${searchSymbol}"`, desc: 'Trigger AI analyst report' },
      { command: 'HELP', desc: 'View CLI command guide' },
    ];
    
    const matchingStocks = stocks.filter(s => s.symbol.toUpperCase().includes(q) || s.name.toUpperCase().includes(q)).slice(0, 3);
    matchingStocks.forEach(s => {
      allShortcuts.unshift(
        { command: `${s.symbol} DES`, desc: `Description of ${s.symbol}` },
        { command: `${s.symbol} CAND`, desc: `Candle Chart of ${s.symbol}` }
      );
    });

    return allShortcuts.filter(s => s.command.toUpperCase().includes(q)).slice(0, 8);
  }, [terminalInput, searchSymbol, stocks]);

  return (
    <div className="space-y-6 relative">
      {/* ── Bloomberg Command Terminal Input Bar ── */}
      <div className="bg-black border border-amber-500/30 rounded-xl p-2 font-mono flex items-center gap-2 select-none shadow-[0_0_10px_rgba(245,158,11,0.05)] relative z-20">
        <span className="text-[10px] font-black text-amber-500 tracking-wider blink shrink-0">BBG-FREE &gt;</span>
        <input
          id="bbg-command-bar"
          type="text"
          value={terminalInput}
          onChange={(e) => {
            setTerminalInput(e.target.value);
            setShowTerminalSuggestions(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              executeTerminalCommand(terminalInput);
            } else if (e.key === 'Escape') {
              setTerminalInput('');
              setShowTerminalSuggestions(false);
              e.currentTarget.blur();
            }
          }}
          placeholder="Type command (e.g. INFY DES, CAND, FED, TREAS, ASK 'Analyze INFY') or press '/' to focus..."
          className="flex-grow bg-transparent text-[12px] text-amber-400 focus:outline-none placeholder-amber-500/30 font-semibold"
        />
        <div className="flex items-center gap-1.5 text-[9px] font-black text-slate-500 bg-slate-900/50 px-2 py-0.5 rounded border border-slate-800">
          <span className="text-amber-500 font-mono">F2-F5</span> SWITCH TABS
        </div>
      </div>

      {/* ── Bloomberg Command Suggestions ── */}
      {showTerminalSuggestions && terminalInput.trim() && (
        <div className="absolute z-30 bg-black border border-amber-500/40 rounded-xl mt-1 shadow-2xl p-2 font-mono max-h-60 overflow-y-auto text-[11px] w-96 text-left left-2 top-[46px]">
          <div className="text-slate-500 px-2 py-1 text-[9px] uppercase font-black border-b border-slate-950">Terminal Command Matches</div>
          {filteredTerminalSuggestions.map((s, idx) => (
            <button
              key={idx}
              onClick={() => {
                setTerminalInput(s.command);
                setShowTerminalSuggestions(false);
                executeTerminalCommand(s.command);
              }}
              className="w-full text-left px-2 py-1.5 hover:bg-slate-900 rounded flex justify-between text-amber-400 font-medium cursor-pointer"
            >
              <span>{s.command}</span>
              <span className="text-slate-500 text-[9px] font-black uppercase">{s.desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Tabs Navigation Header ─────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-terminal-panel border border-terminal-border p-2 rounded-2xl">
        <div className="flex gap-1 overflow-x-auto w-full md:w-auto p-1">
          {[
            { id: 'market-pulse', label: 'Market Pulse', icon: Activity },
            { id: 'quant-ml', label: 'Quant & ML Registry', icon: Cpu },
            { id: 'signals', label: 'Signals & Scanners', icon: Radio },
            { id: 'stock-intelligence', label: 'Stock Intelligence', icon: Sparkles }
          ].map(tab => {
            const ActiveIcon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={cn(
                  "px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 shrink-0 cursor-pointer",
                  active
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40"
                )}
              >
                <ActiveIcon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Global Live Ticker Info */}
        <div className="flex items-center gap-3 pr-4 font-mono text-[10px] font-bold text-slate-400 select-none">
          <span className="bg-slate-900/60 border border-slate-800/80 px-2.5 py-1 rounded-md uppercase tracking-wider flex items-center gap-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            NSE Livestream
          </span>
          <span className="hidden sm:inline text-slate-500">|</span>
          <span className="hidden sm:inline">Active WATCHLISTS: <span className="text-slate-200 font-extrabold">{watchlist.length}</span></span>
        </div>
      </div>

      {/* ── Active View Containers ────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -15 }}
          transition={{ duration: 0.25 }}
        >

          {/* ──────────────────────────────────────────────────────────────── */}
          {/* ── TAB 1: MARKET PULSE ───────────────────────────────────────── */}
          {/* ──────────────────────────────────────────────────────────────── */}
          {activeTab === 'market-pulse' && (
            <div className="space-y-6">
              {/* Indices Strip */}
              <div className="w-full">
                <MarketIndices onSelect={(id, name) => onSelectIndex?.(id, name)} />
              </div>

              {/* Layout Grid: Stack charts left, Breadth + News right */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                {/* Charts Area */}
                <div className="lg:col-span-8 space-y-6 flex flex-col">
                  {/* Nifty 50 Candle/Area Chart */}
                  <div className="glass border border-slate-800/60 rounded-2xl p-5 flex-1 relative overflow-hidden">
                    <div className="flex justify-between items-center mb-4">
                      <div>
                        <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest font-mono">Benchmark Index</p>
                        <h3 className="text-sm font-black text-slate-200 font-mono uppercase mt-0.5">Nifty 50 Index (30 Days)</h3>
                      </div>
                      <div className="text-right">
                        {niftyGraphData.length > 0 && (
                          <span className="text-lg font-black font-mono text-slate-200">
                            {niftyGraphData[niftyGraphData.length - 1].value.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
                          </span>
                        )}
                        {niftyGraphData.length > 1 && (
                          <span className={cn("text-[10px] font-black font-mono ml-2", chartTrending ? "text-emerald-400" : "text-rose-400")}>
                            {fmtPct(((niftyGraphData[niftyGraphData.length - 1].value - niftyGraphData[0].value) / niftyGraphData[0].value) * 100)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={niftyGraphData} margin={{ top: 5, right: 0, bottom: 0, left: 0 }}>
                          <defs>
                            <linearGradient id="niftyV3Grad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={niftyColor} stopOpacity={0.2} />
                              <stop offset="95%" stopColor={niftyColor} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 4" stroke="#161b22" vertical={false} />
                          <XAxis dataKey="time" hide />
                          <YAxis hide domain={['auto', 'auto']} />
                          <Tooltip
                            contentStyle={{ background: '#0a0b0e', border: '1px solid #21262d', borderRadius: 8, fontSize: 10, fontFamily: FONT_FAMILY_MONO, color: '#f8fafc' }}
                            formatter={(v: any) => [v.toLocaleString('en-IN', { maximumFractionDigits: 1 }), 'Nifty 50']}
                            labelFormatter={() => ''}
                          />
                          <Area type="monotone" dataKey="value" stroke={niftyColor} strokeWidth={2} fill="url(#niftyV3Grad)" dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* VIX Area Chart */}
                  <div className="glass border border-slate-800/60 rounded-2xl p-5 flex-1 relative overflow-hidden">
                    <div className="flex justify-between items-center mb-4">
                      <div>
                        <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest font-mono">Volatility Index</p>
                        <h3 className="text-sm font-black text-slate-200 font-mono uppercase mt-0.5">India VIX Metric</h3>
                      </div>
                      <div className="text-right">
                        {vixResult && (
                          <span className="text-lg font-black font-mono text-slate-200">
                            {vixResult.last_trade_price?.toFixed(2)}
                          </span>
                        )}
                        <span className={cn("text-[10px] font-black font-mono ml-2", vixColor === emerald ? "text-emerald-400" : "text-rose-400")}>
                          {vixResult ? fmtPct(vixResult.change_per) : ''}
                        </span>
                      </div>
                    </div>

                    <div className="h-40">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={vixGraphData} margin={{ top: 5, right: 0, bottom: 0, left: 0 }}>
                          <defs>
                            <linearGradient id="vixV3Grad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={vixColor} stopOpacity={0.15} />
                              <stop offset="95%" stopColor={vixColor} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 4" stroke="#161b22" vertical={false} />
                          <XAxis dataKey="time" hide />
                          <YAxis hide domain={['auto', 'auto']} />
                          <Tooltip
                            contentStyle={{ background: '#0a0b0e', border: '1px solid #21262d', borderRadius: 8, fontSize: 10, fontFamily: FONT_FAMILY_MONO, color: '#f8fafc' }}
                            formatter={(v: any) => [v.toFixed(2), 'India VIX']}
                            labelFormatter={() => ''}
                          />
                          <Area type="monotone" dataKey="value" stroke={vixColor} strokeWidth={1.5} fill="url(#vixV3Grad)" dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                </div>

                {/* Right: Breadth & News */}
                <div className="lg:col-span-4 space-y-6 flex flex-col justify-between">
                  {/* Breadth Widget */}
                  <div className="glass border border-slate-800/60 rounded-2xl p-5 flex flex-col justify-between items-center text-center">
                    <div className="w-full">
                      <SectionLabel>Market Breadth</SectionLabel>
                    </div>
                    <BreadthGauge stocks={stocks} />
                    <div className="grid grid-cols-3 gap-2 w-full mt-4 border-t border-slate-800/60 pt-3 text-[10px] font-mono">
                      <div className="text-left"><span className="text-emerald-400 font-extrabold block">ADV</span> {advancers}</div>
                      <div className="text-center text-slate-500"><span className="font-bold block">UNCH</span> {stocks.length - advancers - decliners}</div>
                      <div className="text-right"><span className="text-rose-400 font-extrabold block">DEC</span> {decliners}</div>
                    </div>
                  </div>

                  {/* Live News */}
                  <div className="glass border border-slate-800/60 rounded-2xl p-5 flex-1 flex flex-col min-h-[300px]">
                    <SectionLabel>Cognitive News Feed</SectionLabel>
                    <div className="space-y-4 flex-1 overflow-y-auto pr-1 terminal-scrollbar max-h-[320px]">
                      {news.slice(0, 5).map(item => (
                        <div key={item.id} className="border-b border-slate-800/40 pb-3 last:border-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className={cn("text-[8px] font-black uppercase px-2 py-0.5 rounded font-mono border",
                              item.category === 'Economy' ? "text-amber-400 bg-amber-500/5 border-amber-500/10" : "text-sky-400 bg-sky-500/5 border-sky-500/10"
                            )}>
                              {item.category}
                            </span>
                            <span className="text-[8px] font-mono text-slate-500">{item.time}</span>
                          </div>
                          <p className="text-[11px] font-bold text-slate-300 leading-normal hover:text-indigo-400 transition-colors cursor-pointer">
                            {item.title}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                </div>

              </div>

              {/* Sub-Rows: Sector Heatmap, movers, and premarket */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="glass border border-slate-800/60 rounded-2xl p-5">
                  <SectionLabel>Index Overview Matrix</SectionLabel>
                  <IndexOverview onSelectIndex={onSelectIndex} />
                </div>
                <div className="glass border border-slate-800/60 rounded-2xl p-5">
                  <SectionLabel>Global Indices</SectionLabel>
                  <GlobalMarkets />
                </div>
              </div>

              {/* Heatmap & movers */}
              <div className="glass border border-slate-800/60 rounded-2xl p-5">
                <SectionLabel>Sector Heatmap Allocation</SectionLabel>
                <SectorHeatmap />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 glass border border-slate-800/60 rounded-2xl p-5">
                  <SectionLabel>Momentum Scanners</SectionLabel>
                  <MomentumIntelligence watchlist={watchlist} onToggle={onToggleWatchlist} onSelectStock={selectStockForDeepAnalysis} />
                </div>
                <div className="lg:col-span-4 glass border border-slate-800/60 rounded-2xl p-5">
                  <SectionLabel>Intraday Breakouts</SectionLabel>
                  <IntradayBreakouts onSelectStock={selectStockForDeepAnalysis} />
                </div>
              </div>

              {/* Top Movers widget */}
              <div className="glass border border-slate-800/60 rounded-2xl p-5">
                <SectionLabel>Extreme Movers (Daily)</SectionLabel>
                <TopMoversIntelligence onSelectStock={selectStockForDeepAnalysis} />
              </div>

              {/* Pre-Market Panel */}
              <div className="glass border border-slate-800/60 rounded-2xl p-5">
                <SectionLabel>Pre-Market Intelligence</SectionLabel>
                <PremarketPanel onSelectStock={selectStockForDeepAnalysis} />
              </div>

            </div>
          )}

          {/* ──────────────────────────────────────────────────────────────── */}
          {/* ── TAB 2: QUANT & ML REGISTRY ────────────────────────────────── */}
          {/* ──────────────────────────────────────────────────────────────── */}
          {activeTab === 'quant-ml' && (
            <div className="space-y-6">
              {/* Header metrics */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {[
                  { label: 'Ensemble Win Rate', val: dashboardData?.overall?.win_rate != null ? `${(dashboardData.overall.win_rate * 100).toFixed(1)}%` : '—', sub: 'Resolved WIN rate', progress: dashboardData?.overall?.win_rate != null ? dashboardData.overall.win_rate * 100 : undefined },
                  { label: 'Ann. Sharpe Ratio', val: dashboardData?.overall?.sharpe_ratio != null ? dashboardData.overall.sharpe_ratio.toFixed(2) : '—', sub: 'Risk-adjusted return' },
                  { label: 'ML Trading Signals', val: dashboardData?.overall?.total_signals != null ? dashboardData.overall.total_signals : '—', sub: 'Resolved signal count' },
                  { label: 'Alpha vs Nifty 50', val: dashboardData?.overall?.alpha_vs_nifty != null ? `${dashboardData.overall.alpha_vs_nifty >= 0 ? '+' : ''}${(dashboardData.overall.alpha_vs_nifty * 100).toFixed(2)}%` : '—', sub: 'Excess vs benchmark', color: dashboardData?.overall?.alpha_vs_nifty == null ? 'text-slate-300' : dashboardData.overall.alpha_vs_nifty >= 0 ? 'text-emerald-400' : 'text-rose-400' }
                ].map((item, idx) => (
                  <div key={idx} className="glass border border-slate-800/60 p-4 rounded-xl relative overflow-hidden">
                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest font-mono">{item.label}</span>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span className={cn("text-xl font-black font-mono italic", item.color || "text-slate-200")}>{item.val}</span>
                      <span className="text-[8px] text-slate-400 font-bold uppercase tracking-wider font-mono">{item.sub}</span>
                    </div>
                    {item.progress !== undefined && (
                      <div className="w-full h-1 bg-slate-900 rounded-full mt-3 overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${item.progress}%` }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* FII DII Daily Net Cash Flow and Model Importance */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                {/* FII DII Net Flow */}
                <div className="lg:col-span-8 glass border border-slate-800/60 rounded-2xl p-5">
                  <div className="flex justify-between items-center mb-4">
                    <div>
                      <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">FII & DII Net Cash Flow Matrix</h3>
                      <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5 font-mono">Net buying / selling values in Crores (Last 10 Days)</p>
                    </div>
                    <span className="text-[8px] font-black text-indigo-400 bg-indigo-500/5 px-2 py-0.5 rounded border border-indigo-500/10 font-mono uppercase tracking-widest">Database Sync Active</span>
                  </div>

                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={flowChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#161b22" vertical={false} />
                        <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 9, fontFamily: FONT_FAMILY_MONO }} />
                        <YAxis tick={{ fill: '#64748b', fontSize: 9, fontFamily: FONT_FAMILY_MONO }} />
                        <Tooltip contentStyle={{ backgroundColor: '#0d1117', border: '1px solid #21262d', borderRadius: 8, fontSize: 10, fontFamily: FONT_FAMILY_MONO, color: '#f8fafc' }} />
                        <Bar dataKey="FII" fill="#f43f5e" radius={[2, 2, 0, 0]} name="FII Net" />
                        <Bar dataKey="DII" fill="#10b981" radius={[2, 2, 0, 0]} name="DII Net" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Feature Importance */}
                <div className="lg:col-span-4 glass border border-slate-800/60 rounded-2xl p-5">
                  <div>
                    <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">Ensemble Feature Weights</h3>
                    <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5 font-mono">Computed feature importance values (%)</p>
                  </div>

                  {featureChartData.length > 0 ? (
                    <div className="h-64 mt-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={featureChartData} layout="vertical">
                          <CartesianGrid strokeDasharray="3 3" stroke="#161b22" horizontal={false} />
                          <XAxis type="number" hide />
                          <YAxis dataKey="name" type="category" tick={{ fill: '#94a3b8', fontSize: 8, fontFamily: FONT_FAMILY_MONO }} width={100} />
                          <Tooltip contentStyle={{ backgroundColor: '#0d1117', border: '1px solid #21262d', borderRadius: 8, fontSize: 10, fontFamily: FONT_FAMILY_MONO, color: '#f8fafc' }} />
                          <Bar dataKey="Weight" fill="#8a2be2" radius={[0, 2, 2, 0]} name="Weight %" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="h-64 flex items-center justify-center border border-dashed border-slate-800 rounded-xl mt-4">
                      <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">No Features Loaded</span>
                    </div>
                  )}
                </div>

              </div>

              {/* Model Registry and Strategy Performance */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                {/* Active Model Registry */}
                <div className="lg:col-span-6 glass border border-slate-800/60 rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Cpu className="w-4 h-4 text-indigo-400 animate-pulse" />
                    <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">Active Model Registry</h3>
                  </div>

                  <div className="space-y-3">
                    {((dashboardData as any)?.latestModel || []).map((m: any, idx: number) => (
                      <div key={idx} className="p-3 bg-slate-900/30 border border-slate-800 rounded-xl flex justify-between items-center hover:border-indigo-500/40 transition-colors">
                        <div>
                          <h4 className="text-xs font-black text-slate-200 font-mono uppercase">{m.model_name}</h4>
                          <p className="text-[9px] text-slate-400 font-black uppercase mt-0.5 font-mono">{m.model_type}</p>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-black text-indigo-400 font-mono uppercase">AUC: {m.cv_roc_auc != null ? m.cv_roc_auc.toFixed(3) : 'N/A'}</span>
                          <p className="text-[8px] text-slate-500 font-bold uppercase mt-0.5 font-mono">{m.training_samples} samples trained</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Top Performance Metrics */}
                <div className="lg:col-span-6 glass border border-slate-800/60 rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Layers className="w-4 h-4 text-emerald-400" />
                    <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">Strategy Leaderboard</h3>
                  </div>

                  <div className="space-y-3">
                    {((dashboardData as any)?.topSignals || []).map((s: any, idx: number) => (
                      <div key={idx} className="p-3 bg-slate-900/30 border border-slate-800 rounded-xl flex justify-between items-center hover:border-emerald-500/40 transition-colors">
                        <div>
                          <h4 className="text-xs font-black text-slate-200 uppercase font-mono">{s.strategy_name.replace('_', ' ')}</h4>
                          <p className="text-[9px] text-slate-400 font-black uppercase mt-0.5 font-mono">{s.total_signals} Total signals</p>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-black text-emerald-400 font-mono">{(s.win_rate * 100).toFixed(1)}% WR</span>
                          <p className="text-[8px] text-slate-500 font-bold uppercase mt-0.5 font-mono">Sharpe Ratio: {s.sharpe_ratio != null ? s.sharpe_ratio.toFixed(2) : 'N/A'}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>

              {/* Deployment ROC / AUC diagnostics — live win-probability vs realized outcome */}
              <ModelRocPanel />

            </div>
          )}

          {/* ──────────────────────────────────────────────────────────────── */}
          {/* ── TAB 3: SIGNALS & SCANNERS ─────────────────────────────────── */}
          {/* ──────────────────────────────────────────────────────────────── */}
          {activeTab === 'signals' && (
            <div className="space-y-6">
              {/* Scan Trigger and active count */}
              <div className="glass border border-slate-800/60 rounded-2xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
                    <Radio size={16} className="text-indigo-400 animate-pulse" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider font-mono">Cognitive Machine Signals</h3>
                    <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5 font-mono">
                      Queue scan details: {isGenerating ? `Scanning ${queueProgress?.completed}/${queueProgress?.total}` : 'Active Signal Engine: IDLE'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 w-full md:w-auto">
                  {/* Progress tracker */}
                  {isGenerating && queueProgress && queueProgress.total > 0 && (
                    <div className="flex-1 md:w-48">
                      <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-indigo-500 rounded-full"
                          animate={{ width: `${Math.round((queueProgress.completed / queueProgress.total) * 100)}%` }}
                          transition={{ duration: 0.4 }}
                        />
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleGenerateSignals}
                    disabled={isGenerating}
                    className={cn(
                      "px-4 py-2 border rounded-xl text-xs font-black font-mono uppercase tracking-widest transition-all cursor-pointer flex items-center gap-2",
                      isGenerating
                        ? "bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed"
                        : "bg-indigo-600/15 border-indigo-500/30 text-indigo-400 hover:bg-indigo-600 hover:text-white"
                    )}
                  >
                    <RefreshCw size={12} className={cn(isGenerating && "animate-spin")} />
                    {isGenerating ? 'SCANNING' : 'RESCAN ALL'}
                  </button>
                </div>
              </div>

              {/* Signals list */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                {/* Active signals (col-span-4) */}
                <div className="lg:col-span-4 glass border border-slate-800/60 rounded-2xl p-5 flex flex-col h-[520px]">
                  <SectionLabel>Active Machine Signals ({aiSignals.length})</SectionLabel>
                  <div className="flex-1 overflow-y-auto space-y-3 pr-1 terminal-scrollbar mt-2">
                    {aiSignals.length > 0 ? (
                      aiSignals.map((sig, idx) => (
                        <SignalCard
                          key={`${sig.symbol}-${idx}`}
                          signal={sig}
                          onClick={() => selectStockForDeepAnalysis(sig.symbol)}
                          onHistory={() => setHistorySymbol(sig.symbol)}
                        />
                      ))
                    ) : (
                      <div className="flex flex-col items-center justify-center py-20 text-slate-500 font-mono text-xs uppercase tracking-widest">
                        <Zap size={24} className="text-slate-800 animate-pulse mb-3" />
                        No signals generated
                      </div>
                    )}
                  </div>
                </div>

                {/* Screener dashboards (col-span-8) */}
                <div className="lg:col-span-8 glass border border-slate-800/60 rounded-2xl p-5 flex flex-col">
                  <SectionLabel>Unified Screeners & Trackers</SectionLabel>
                  <div className="flex-1 overflow-y-auto pr-1 terminal-scrollbar space-y-8 mt-2 h-[480px]">
                    <div className="p-4 bg-slate-900/30 border border-slate-800 rounded-xl">
                      <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest font-mono mb-3">Live Market Screener (Intraday)</p>
                      <LiveMarketScreener onSelectStock={selectStockForDeepAnalysis} />
                    </div>

                    <div className="p-4 bg-slate-900/30 border border-slate-800 rounded-xl">
                      <p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest font-mono mb-3">EOD Market Screener (Daily Closing)</p>
                      <EODMarketScreener onSelectStock={selectStockForDeepAnalysis} />
                    </div>

                    <div className="p-4 bg-slate-900/30 border border-slate-800 rounded-xl">
                      <p className="text-[10px] font-black text-amber-400 uppercase tracking-widest font-mono mb-3">Trendlyne Screener Discovery</p>
                      <TrendlyneScreenerPanel onSelectStock={selectStockForDeepAnalysis} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />
                    </div>
                  </div>
                </div>

              </div>

            </div>
          )}

          {/* ──────────────────────────────────────────────────────────────── */}
          {/* ── TAB 4: STOCK INTELLIGENCE ─────────────────────────────────── */}
          {/* ──────────────────────────────────────────────────────────────── */}
          {activeTab === 'stock-intelligence' && (
            <div className="space-y-6">
              
              {/* Autocomplete Search Header */}
              <div className="glass border border-slate-800/60 rounded-2xl p-5 flex flex-col md:flex-row justify-between items-center gap-4 relative">
                <div className="flex items-center gap-3 w-full md:w-auto">
                  <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
                    <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
                  </div>
                  <div>
                    <h2 className="text-base font-black text-slate-100 uppercase tracking-wider font-mono">Cognitive Quant Search</h2>
                    <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5 font-mono">Deep-Dive Stock intelligence terminal</p>
                  </div>
                </div>

                {/* Suggestion input field */}
                <div className="relative w-full md:w-80">
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                    <input
                      type="text"
                      placeholder="Search symbol / company name..."
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setShowSuggestions(true);
                      }}
                      onFocus={() => setShowSuggestions(true)}
                      className="w-full bg-slate-950/80 border border-slate-800 hover:border-slate-700 text-slate-200 text-xs rounded-xl pl-9 pr-4 py-2.5 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-mono"
                    />
                  </div>

                  {/* Suggestion Dropdown */}
                  {showSuggestions && searchQuery.trim() !== '' && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowSuggestions(false)} />
                      <div className="absolute left-0 right-0 mt-2 bg-slate-950 border border-slate-800 rounded-xl shadow-2xl z-50 overflow-hidden max-h-60 overflow-y-auto font-mono text-xs">
                        {filteredSuggestions.length > 0 ? (
                          filteredSuggestions.map(s => (
                            <button
                              key={s.symbol}
                              onClick={() => {
                                setSearchSymbol(s.symbol);
                                setSearchQuery('');
                                setShowSuggestions(false);
                              }}
                              className="w-full text-left px-4 py-3 border-b border-slate-900/60 hover:bg-slate-900/40 transition-colors flex justify-between items-center"
                            >
                              <div>
                                <span className="font-black text-slate-100 uppercase block">{s.symbol}</span>
                                <span className="text-[9px] text-slate-400 block mt-0.5 truncate max-w-[180px]">{s.name}</span>
                              </div>
                              <span className="text-[10px] text-slate-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded font-bold uppercase">{s.sector || 'NSE'}</span>
                            </button>
                          ))
                        ) : (
                          <div className="p-4 text-center text-slate-500 text-[10px] uppercase font-bold tracking-widest">No Matches Found</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Details Display (Render skeleton or data card) */}
              {loadingUnified || loadingNiftyTrader ? (
                <div className="h-96 flex flex-col justify-center items-center gap-3">
                  <Activity className="w-10 h-10 text-indigo-500 animate-pulse" />
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest animate-pulse font-mono">Compiling Cognitive Indicators...</p>
                </div>
              ) : (
                <div className="space-y-6">
                  
                  {/* Stock Profile Header Details */}
                  <div className="glass border border-slate-800/60 rounded-2xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="text-2xl font-black text-slate-100 font-mono tracking-tighter uppercase italic">{searchSymbol}</span>
                        <span className="text-xs bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded font-bold tracking-widest uppercase font-mono">
                          {currentStockData?.sector || niftyTraderData?.analysisData?.symbolData?.industry_name || 'Stock'}
                        </span>
                      </div>
                      <h4 className="text-xs font-bold text-slate-400 mt-1 uppercase">
                        {currentStockData?.name || niftyTraderData?.analysisData?.symbolData?.company_name || 'NSE Equities'}
                      </h4>
                    </div>

                    <div className="flex gap-6 text-right select-none font-mono">
                      <div>
                        <span className="text-[9px] text-slate-500 font-black block">LTP PRICE</span>
                        <span className="text-xl font-black text-slate-200">₹{currentStockPrice.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-[9px] text-slate-500 font-black block">CHANGE</span>
                        <span className={cn("text-xs font-black block mt-1.5", (currentStockData?.changePct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                          {fmtPct(currentStockData?.changePct ?? 0)}
                        </span>
                      </div>
                      <div className="hidden sm:block">
                        <span className="text-[9px] text-slate-500 font-black block">52W RANGE</span>
                        <span className="text-xs font-semibold text-slate-300 block mt-1.5">
                          ₹{currentStockData?.low52w?.toFixed(0) || '—'} - ₹{currentStockData?.high52w?.toFixed(0) || '—'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Stock detail tabs */}
                  <div className="flex glass border border-slate-800/50 p-1 rounded-2xl w-fit">
                    {[
                      { id: 'Technicals', label: 'Technicals', icon: BarChart2 },
                      { id: 'Fundamentals', label: 'Fundamentals & SWOT', icon: BookOpen },
                      { id: 'Options', label: 'Derivatives (F&O)', icon: Target }
                    ].map(st => {
                      const Icon = st.icon;
                      const active = stockDetailTab === st.id;
                      return (
                        <button
                          key={st.id}
                          onClick={() => setStockDetailTab(st.id as any)}
                          className={cn(
                            "px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 cursor-pointer",
                            active ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:text-slate-200"
                          )}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {st.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* ── STOCK TECHNICALS TAB ── */}
                  {stockDetailTab === 'Technicals' && (
                    <div className="space-y-6">
                      
                      {/* Price charts */}
                      <div className="p-2 bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden">
                        <V2LightweightChart data={stockCandlestickData} symbol={searchSymbol} height={400} />
                      </div>

                      {/* Moving averages and Pivot levels */}
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        
                        {/* Pivot Levels */}
                        <div className="lg:col-span-7 glass border border-slate-800/60 rounded-2xl p-5">
                          <SectionLabel>Standard Pivot Points</SectionLabel>
                          <div className="grid grid-cols-5 gap-2 mt-4 font-mono">
                            {[
                              { label: 'S2', price: pivotLevels.s2 },
                              { label: 'S1', price: pivotLevels.s1 },
                              { label: 'Pivot', price: pivotLevels.pp },
                              { label: 'R1', price: pivotLevels.r1 },
                              { label: 'R2', price: pivotLevels.r2 }
                            ].map(lvl => (
                              <div key={lvl.label} className="p-3 bg-slate-900/30 border border-slate-800 rounded-lg text-center">
                                <span className="text-[8px] font-black text-slate-500 block">{lvl.label}</span>
                                <span className="text-xs font-black text-slate-100 block mt-1">{lvl.price != null ? `₹${lvl.price.toFixed(1)}` : '—'}</span>
                              </div>
                            ))}
                          </div>

                          {/* Gap analysis messages */}
                          <div className="mt-6 border-t border-slate-800/60 pt-4">
                            <span className="text-[9px] font-black text-slate-400 font-mono block uppercase mb-3">NSE Daily Gap Scans</span>
                            <div className="space-y-2 max-h-[140px] overflow-y-auto pr-1 terminal-scrollbar font-mono text-[10px]">
                              {niftyTraderData?.analysisData?.msg_data?.length ? (
                                niftyTraderData.analysisData.msg_data.map((msg: string, idx: number) => (
                                  <div key={idx} className={cn("p-2 rounded-lg border",
                                    msg.toLowerCase().includes('support') ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-400" : "bg-rose-500/5 border-rose-500/10 text-rose-400"
                                  )}>
                                    {msg}
                                  </div>
                                ))
                              ) : (
                                <div className="text-slate-500 py-4 text-center uppercase font-bold tracking-widest text-[9px]">No Unfilled Gaps Detected</div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Moving averages and delivery */}
                        <div className="lg:col-span-5 space-y-6">
                          {/* Moving averages */}
                          <div className="glass border border-slate-800/60 rounded-2xl p-5">
                            <SectionLabel>Moving Averages Alignment</SectionLabel>
                            <div className="space-y-2.5 mt-2 font-mono text-[10px] font-bold">
                              {[
                                { label: '10 SMA', val: niftyTraderData?.analysisData?.stocktrend?.sma_10_days },
                                { label: '20 SMA', val: niftyTraderData?.analysisData?.stocktrend?.sma_20_days },
                                { label: '50 SMA', val: niftyTraderData?.analysisData?.stocktrend?.sma_50_days },
                                { label: '100 SMA', val: niftyTraderData?.analysisData?.stocktrend?.sma_100_days },
                                { label: '200 SMA', val: niftyTraderData?.analysisData?.stocktrend?.sma_200_days },
                              ].map(sma => {
                                const val: number | null = (sma.val != null && !isNaN(+sma.val)) ? +sma.val : null;
                                const isAbove = val != null && currentStockPrice >= val;
                                return (
                                  <div key={sma.label} className="flex justify-between items-center border-b border-slate-800/40 pb-2 last:border-0 last:pb-0">
                                    <span className="text-slate-400">{sma.label}</span>
                                    <div className="flex items-center gap-3">
                                      <span className="text-slate-200">{val != null ? `₹${val.toFixed(2)}` : '—'}</span>
                                      {val != null && (
                                      <span className={cn("text-[9px] font-black px-1.5 py-0.5 rounded", isAbove ? "text-emerald-400 bg-emerald-500/5" : "text-rose-400 bg-rose-500/5")}>
                                        {isAbove ? 'ABOVE' : 'BELOW'}
                                      </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          {/* Delivery stats */}
                          <div className="glass border border-slate-800/60 rounded-2xl p-5">
                            <SectionLabel>Pattern & Volume Breakout</SectionLabel>
                            <div className="grid grid-cols-2 gap-4 mt-2">
                              <div className="p-3 bg-slate-900/30 border border-slate-800 rounded-xl">
                                <span className="text-[8px] font-black text-slate-500 block font-mono">DELIVERY %</span>
                                <span className="text-base font-black text-slate-200 font-mono mt-1 block">
                                  {niftyTraderData?.analysisData?.priceTable?.[0]?.delivery_percentage ?? '—'}
                                </span>
                              </div>
                              <div className="p-3 bg-slate-900/30 border border-slate-800 rounded-xl">
                                <span className="text-[8px] font-black text-slate-500 block font-mono">NR7 PATTERN</span>
                                <span className={cn("text-base font-black font-mono mt-1 block",
                                  niftyTraderData?.analysisData?.stocktrend?.nr7_today?.toLowerCase() === 'yes' ? "text-blue-400" : "text-slate-400"
                                )}>
                                  {niftyTraderData?.analysisData?.stocktrend?.nr7_today || 'NO'}
                                </span>
                              </div>
                            </div>
                          </div>

                        </div>

                      </div>

                    </div>
                  )}

                  {/* ── STOCK FUNDAMENTALS & SWOT TAB ── */}
                  {stockDetailTab === 'Fundamentals' && (
                    <div className="space-y-6">
                      
                      {/* Factor Scoring and Profile narrative */}
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        
                        {/* Circle Gauge + Factor list */}
                        <div className="lg:col-span-5 glass border border-slate-800/60 rounded-2xl p-5 flex flex-col sm:flex-row justify-between items-center gap-6">
                          <ScoreGauge value={score?.score ?? null} />
                          <div className="flex-1 w-full space-y-2 text-[10px] font-bold">
                            <span className="text-[8px] font-black text-slate-500 block uppercase tracking-widest font-mono">Factor Scores</span>
                            {factorsList.map(f => (
                              <div key={f.label} className="space-y-1">
                                <div className="flex justify-between items-center text-[9px] font-mono">
                                  <span className="text-slate-400">{f.label}</span>
                                  <span className={f.textClass}>{f.val}/100</span>
                                </div>
                                <div className="h-1 bg-slate-900 rounded-full overflow-hidden">
                                  <div className={cn("h-full bg-gradient-to-r rounded-full", f.color)} style={{ width: `${f.val}%` }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* AI narrative */}
                        <div className="lg:col-span-7 glass border border-slate-800/60 rounded-2xl p-5 relative overflow-hidden flex flex-col justify-between">
                          <div>
                            <div className="flex items-center justify-between mb-3">
                              <h3 className="text-xs font-black text-emerald-400 flex items-center gap-1.5 font-mono">
                                <Cpu className="w-4 h-4 animate-pulse" /> AI Profile Audit
                              </h3>
                              {/* Grow badges */}
                              <div className="flex gap-2">
                                {unifiedData?.tradebrains?.growth_score !== undefined && (
                                  <span className="text-[8px] font-black bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded uppercase tracking-wider font-mono">
                                    High Growth Scope
                                  </span>
                                )}
                              </div>
                            </div>
                            <p className="text-[11px] text-slate-300 leading-relaxed font-medium">
                              {unifiedData?.companyProfileData?.companyDescription || 'Cognitive profile is compiling details from latest exchange filings. Growth prospects remain inline with core sector indices.'}
                            </p>
                          </div>
                          
                          {/* Growth score indicator */}
                          <div className="mt-4 pt-3 border-t border-slate-800/60 flex items-center gap-3">
                            <span className="text-[9px] font-black text-slate-400 font-mono uppercase shrink-0">Company Health Score:</span>
                            <div className="flex-1 h-1.5 bg-slate-900 rounded-full overflow-hidden">
                              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${unifiedData?.tradebrains?.health_score != null ? unifiedData.tradebrains.health_score : 0}%` }} />
                            </div>
                            <span className="text-[9px] font-black text-emerald-400 font-mono shrink-0">{unifiedData?.tradebrains?.health_score != null ? `${unifiedData.tradebrains.health_score}/100` : 'N/A'}</span>
                          </div>
                        </div>

                      </div>

                      {/* SWOT and Checklist */}
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        
                        {/* SWOT Analysis */}
                        <div className="lg:col-span-7 glass border border-slate-800/60 rounded-2xl p-5">
                          <SectionLabel>Trendlyne SWOT Breakdown</SectionLabel>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                            {swotCategories.map(cat => {
                              const list = trendlyneOverview?.swot?.[cat.key] || [];
                              return (
                                <div key={cat.key} className="space-y-2">
                                  <span className={cn("text-[8px] font-black border uppercase tracking-widest px-2.5 py-1 rounded-md font-mono", cat.badgeColor)}>
                                    {cat.label} ({list.length})
                                  </span>
                                  <div className="space-y-1.5 max-h-[140px] overflow-y-auto pr-1 terminal-scrollbar">
                                    {list.length > 0 ? (
                                      list.map((item: string, idx: number) => (
                                        <div key={idx} className="p-2 bg-slate-900/30 border border-slate-800/60 rounded-lg text-[9px] text-slate-400 leading-normal flex items-start gap-2 font-mono">
                                          <span className="text-slate-500 font-bold">•</span>
                                          <span>{item}</span>
                                        </div>
                                      ))
                                    ) : (
                                      <div className="text-[8px] text-slate-600 font-bold uppercase tracking-widest font-mono py-2">No key parameters identified</div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Checklist pass rates */}
                        <div className="lg:col-span-5 glass border border-slate-800/60 rounded-2xl p-5">
                          <SectionLabel>Checklist Audit Pass Rates</SectionLabel>
                          {checklistTotal > 0 ? (
                            <div className="space-y-4 mt-2">
                              <div className="flex justify-between items-center border-b border-slate-800/40 pb-3">
                                <div>
                                  <span className="text-[8px] font-black text-slate-500 block font-mono">PASS RATE</span>
                                  <span className="text-lg font-black text-slate-100 font-mono block mt-0.5">
                                    {checklistScore.toFixed(1)}%
                                  </span>
                                </div>
                                <span className={cn("text-[9px] font-black px-2.5 py-1 rounded-lg border font-mono uppercase tracking-wider",
                                  checklistScore >= 60 ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                                )}>
                                  {checklistYes} / {checklistTotal} Passed
                                </span>
                              </div>

                              {/* Checklist Items list */}
                              <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1 terminal-scrollbar">
                                {Object.keys(checklistData).map(section => (
                                  <div key={section} className="space-y-1 border-b border-slate-800/30 pb-2 last:border-0 last:pb-0">
                                    <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest font-mono">{section}</span>
                                    {checklistData[section].map((item: any, i: number) => (
                                      <div key={i} className="flex justify-between items-center text-[9px] font-mono leading-normal p-1.5 bg-slate-900/10 border border-slate-800/30 rounded">
                                        <span className="text-slate-400 truncate max-w-[190px]">{item.question}</span>
                                        <span className={cn("font-black text-[8px]", item.answer ? "text-emerald-400" : "text-rose-400")}>
                                          {item.answer ? 'PASS' : 'FAIL'}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="text-slate-500 text-center py-12 uppercase font-black font-mono tracking-widest text-[10px]">No Checklist Registered</div>
                          )}
                        </div>

                      </div>

                      {/* DVM and Ratios layout */}
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        
                        {/* DVM */}
                        <div className="lg:col-span-5 glass border border-slate-800/60 rounded-2xl p-5">
                          <SectionLabel>Trendlyne DVM Scores</SectionLabel>
                          <div className="space-y-3 mt-2 font-mono text-[9px] font-bold">
                            {[
                              { label: 'Quality / Durability', val: qVal, color: 'from-emerald-600 to-teal-500', textClass: 'text-emerald-400' },
                              { label: 'Valuation Index', val: vVal, color: 'from-amber-600 to-yellow-500', textClass: 'text-amber-400' },
                              { label: 'Technicals / Momentum', val: tVal, color: 'from-blue-600 to-cyan-500', textClass: 'text-blue-400' }
                            ].map(p => (
                              <div key={p.label} className="space-y-1">
                                <div className="flex justify-between text-slate-400">
                                  <span>{p.label}</span>
                                  <span className={p.textClass}>{p.val ?? '—'}/100</span>
                                </div>
                                <div className="h-1 bg-slate-900 rounded-full overflow-hidden">
                                  <div className={cn("h-full bg-gradient-to-r rounded-full", p.color)} style={{ width: `${p.val || 0}%` }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Ratios */}
                        <div className="lg:col-span-7 glass border border-slate-800/60 rounded-2xl p-5">
                          <SectionLabel>Fundamental Financial Ratios</SectionLabel>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-2 font-mono text-[10px] font-bold">
                            {[
                              { label: 'P/E Ratio', val: getRatio('PE Ratio') },
                              { label: 'Debt to Equity', val: getRatio('Debt to Equity') },
                              { label: 'Price to Book', val: getRatio('Price to Book') },
                              { label: 'Return on Equity (ROE)', val: getRatio('Return on Equity') },
                              { label: 'Operating Margin', val: getRatio('Operating Margin') },
                              { label: 'Current Ratio', val: getRatio('Current Ratio') }
                            ].map(ratio => (
                              <div key={ratio.label} className="p-3 bg-slate-900/30 border border-slate-800 rounded-xl">
                                <span className="text-[8px] font-black text-slate-500 block">{ratio.label}</span>
                                <span className="text-xs font-black text-slate-200 block mt-1">{ratio.val}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                      </div>

                      {/* Peer comparisons, Quarterly and Annual Financial details */}
                      <div className="glass border border-slate-800/60 rounded-2xl p-5">
                        <SectionLabel>Industry Peer Comparisons</SectionLabel>
                        <div className="overflow-x-auto terminal-scrollbar mt-2">
                          <table className="w-full text-left border-collapse font-mono text-[10px]">
                            <thead>
                              <tr className="border-b border-slate-800 pb-2">
                                <th className="pb-2 text-slate-500 font-bold">SYMBOL</th>
                                <th className="pb-2 text-slate-500 font-bold">COMPANY</th>
                                <th className="pb-2 text-slate-500 font-bold text-right">MKT CAP (CR)</th>
                                <th className="pb-2 text-slate-500 font-bold text-right">PRICE (LTP)</th>
                                <th className="pb-2 text-slate-500 font-bold text-right">P/E</th>
                                <th className="pb-2 text-slate-500 font-bold text-right">SALES GR %</th>
                                <th className="pb-2 text-slate-500 font-bold text-right">BOOK VALUE</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/40">
                              {peers.map((peer: any, idx: number) => {
                                const isCurrent = peer.symbol?.toUpperCase() === searchSymbol.toUpperCase();
                                return (
                                  <tr key={idx} className={cn("hover:bg-slate-900/20", isCurrent && "bg-indigo-950/25 text-indigo-300 font-extrabold")}>
                                    <td className="py-2.5 font-black">{peer.symbol}</td>
                                    <td className="py-2.5 font-sans text-slate-400 max-w-[150px] truncate">{peer.company_Name}</td>
                                    <td className="py-2.5 text-right">{peer.market_Cap ? parseFloat(peer.market_Cap).toLocaleString('en-IN') : '—'}</td>
                                    <td className="py-2.5 text-right">₹{peer.current_price || peer.cmp || '—'}</td>
                                    <td className="py-2.5 text-right">{peer.stock_PE || '—'}</td>
                                    <td className={cn("py-2.5 text-right", parseFloat(peer.sales_Growth) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                      {peer.sales_Growth ? `${peer.sales_Growth}%` : '—'}
                                    </td>
                                    <td className="py-2.5 text-right">₹{peer.book_Value || '—'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Dividends & Board Meetings details */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="glass border border-slate-800/60 rounded-2xl p-5">
                          <SectionLabel>Dividends declared</SectionLabel>
                          <div className="space-y-2 mt-2 font-mono text-[10px]">
                            {unifiedData?.eventsData?.dividendTableData?.length ? (
                              unifiedData.eventsData.dividendTableData.slice(0, 4).map((d: any, i: number) => (
                                <div key={i} className="flex justify-between items-center p-2.5 bg-slate-900/30 border border-slate-800 rounded-xl">
                                  <div>
                                    <span className="text-[8px] font-black text-amber-400 uppercase tracking-widest">{d.dividendType}</span>
                                    <span className="text-xs font-black block mt-0.5 text-slate-200">₹{d.dividendAmount}</span>
                                  </div>
                                  <span className="text-[9px] text-slate-400 bg-slate-950 px-2 py-0.5 border border-slate-800 rounded">{d.exDate}</span>
                                </div>
                              ))
                            ) : (
                              <div className="text-slate-500 text-center py-6 font-bold uppercase tracking-widest text-[9px]">No dividend distributions registered</div>
                            )}
                          </div>
                        </div>

                        <div className="glass border border-slate-800/60 rounded-2xl p-5">
                          <SectionLabel>Board Meetings Calendar</SectionLabel>
                          <div className="space-y-2 mt-2 font-mono text-[10px]">
                            {unifiedData?.eventsData?.boardMeetingTableData?.length ? (
                              unifiedData.eventsData.boardMeetingTableData.slice(0, 4).map((meeting: any, i: number) => (
                                <div key={i} className="flex justify-between items-center p-2.5 bg-slate-900/30 border border-slate-800 rounded-xl">
                                  <span className="font-bold text-slate-300 w-48 truncate leading-tight">{meeting.purpose}</span>
                                  <span className="text-[9px] text-slate-400 bg-slate-950 px-2 py-0.5 border border-slate-800 rounded shrink-0">{meeting.boardMeetDate}</span>
                                </div>
                              ))
                            ) : (
                              <div className="text-slate-500 text-center py-6 font-bold uppercase tracking-widest text-[9px]">No upcoming board meetings scheduled</div>
                            )}
                          </div>
                        </div>
                      </div>

                    </div>
                  )}

                  {/* ── STOCK DERIVATIVES TAB ── */}
                  {stockDetailTab === 'Options' && (
                    <div className="space-y-6">
                      
                      {/* PCR and Max pain visualizer */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        
                        <div className="p-5 glass border border-slate-800/60 rounded-2xl flex items-center gap-6">
                          <Target className="w-12 h-12 text-amber-500 opacity-25" />
                          <div>
                            <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest font-mono block">Put-Call Ratio (PCR)</span>
                            <span className="text-3xl font-black text-emerald-400 font-mono mt-1 block">
                              {fno?.marketSentiment?.pcr != null ? fno.marketSentiment.pcr.toFixed(2) : 'N/A'}
                            </span>
                            <span className="text-[9px] font-black uppercase text-slate-400 mt-1 block font-mono">Derivatives Sentiment bias</span>
                          </div>
                        </div>

                        <div className="p-5 glass border border-slate-800/60 rounded-2xl flex items-center gap-6">
                          <Activity className="w-12 h-12 text-indigo-500 opacity-25" />
                          <div>
                            <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest font-mono block">Max Pain Strike Zone</span>
                            <span className="text-3xl font-black text-slate-200 font-mono mt-1 block">
                              ₹{fno?.marketSentiment?.maxPain || '—'}
                            </span>
                            <span className="text-[9px] font-black uppercase text-slate-400 mt-1 block font-mono">Expected Expiry Option Expiry Pin</span>
                          </div>
                        </div>

                      </div>

                      {/* Embed Option Chain View directly */}
                      <div className="glass border border-slate-800/60 rounded-2xl p-5">
                        <OptionChainView defaultSymbol={searchSymbol} />
                      </div>

                    </div>
                  )}

                </div>
              )}

            </div>
          )}

        </motion.div>
      </AnimatePresence>

      {/* ── Modals / Overlays ────────────────────────────────────────────── */}
      <AnimatePresence>
        {historySymbol && (
          <SignalHistoryModal symbol={historySymbol} onClose={() => setHistorySymbol(null)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectedSignal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setSelectedSignal(null)}
              className="absolute inset-0 bg-black/85 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              className="relative w-full max-w-lg glass-strong rounded-2xl overflow-hidden"
            >
              <div className="border-b border-slate-800 p-4 flex items-center justify-between bg-slate-950/60 font-mono">
                <div>
                  <h3 className="text-base font-black text-slate-100 uppercase tracking-wider">{selectedSignal.symbol}</h3>
                  <p className="text-[8px] text-slate-500 font-bold uppercase mt-0.5 tracking-widest">Deep Neural Reasoning · Confidence: {selectedSignal.confidence}%</p>
                </div>
                <button onClick={() => setSelectedSignal(null)} className="text-slate-400 hover:text-white text-lg">×</button>
              </div>

              <div className="p-5 space-y-4 font-mono text-xs">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: 'ENTRY', val: `₹${selectedSignal.entry}`, c: 'text-slate-200 bg-slate-900/40 border-slate-800' },
                    { label: 'TARGET', val: `₹${selectedSignal.target}`, c: 'text-emerald-400 bg-emerald-500/5 border-emerald-500/10' },
                    { label: 'STOP LOSS', val: `₹${selectedSignal.stopLoss}`, c: 'text-rose-400 bg-rose-500/5 border-rose-500/10' }
                  ].map(x => (
                    <div key={x.label} className={cn("p-2 border rounded-lg", x.c)}>
                      <span className="text-[7px] text-slate-500 block font-bold tracking-widest">{x.label}</span>
                      <span className="text-sm font-black block mt-1">{x.val}</span>
                    </div>
                  ))}
                </div>

                <div className="p-3 bg-slate-900/30 border border-slate-800 rounded-xl">
                  <span className="text-[8px] font-black text-slate-500 tracking-widest block uppercase mb-1">Reasoning Analysis</span>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    {selectedSignal.reasoning}
                  </p>
                </div>

                <button
                  onClick={() => setSelectedSignal(null)}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-[10px] py-2.5 rounded-lg uppercase tracking-widest transition-colors font-sans"
                >
                  Confirm Acknowledgment
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Warren AI Assistant Floating Terminal Modal ── */}
      <AnimatePresence>
        {warrenModalOpen && (
          <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4 backdrop-blur-md">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-black border-2 border-emerald-500/80 rounded-2xl w-full max-w-3xl h-[600px] flex flex-col font-mono text-emerald-400 shadow-[0_0_40px_rgba(16,185,129,0.3)]"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between px-4 py-2 bg-slate-950 border-b border-emerald-500/40 select-none">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
                  <span className="text-[10px] font-black uppercase tracking-wider text-emerald-300 font-mono">
                    BBG WARREN-AI COGNITIVE DESK | CODENAME: LLAMA-3-LOCAL
                  </span>
                </div>
                <button
                  onClick={() => setWarrenModalOpen(false)}
                  className="text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-y-auto p-4 text-[11px] leading-relaxed select-text terminal-scrollbar space-y-4 bg-black">
                <div className="text-slate-500 uppercase tracking-widest text-[9px] mb-2 font-black border-b border-slate-950 pb-1">
                  Prompt Query Evaluated
                </div>
                <div className="text-emerald-300 bg-slate-950/60 p-2.5 rounded border border-slate-900 mb-4 font-mono">
                  &gt; {warrenQuery}
                </div>

                <div className="text-slate-500 uppercase tracking-widest text-[9px] mb-2 font-black border-b border-slate-950 pb-1">
                  Cognitive Analysis Stream
                </div>
                <pre className="whitespace-pre-wrap font-mono text-emerald-400 leading-normal selection:bg-emerald-500/20">
                  {warrenOutput}
                  {isWarrenRunning && <span className="inline-block w-1.5 h-4 bg-emerald-400 ml-0.5 animate-pulse" />}
                </pre>
              </div>

              {/* Modal Footer */}
              <div className="flex justify-between items-center px-4 py-2.5 bg-slate-950 border-t border-emerald-500/20 select-none text-[9px] font-black text-slate-500 font-mono">
                <span>WARREN-AI v2.1 (ONLINE)</span>
                <button
                  onClick={() => setWarrenModalOpen(false)}
                  className="px-3 py-1 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 rounded transition-colors uppercase tracking-wider cursor-pointer font-bold"
                >
                  Close Terminal [ESC]
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
