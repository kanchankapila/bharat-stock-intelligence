import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import {
  Activity, Zap, TrendingUp, ArrowUpRight, ArrowDownRight,
  History, Plus, RefreshCw, Cpu, Radio, BarChart2, Gauge,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { useNewsFeed } from '../services/newsService';
import type { MarketData } from '../services/marketService';
import { MarketIndices } from './MarketIndices';
import { SectorHeatmap } from './SectorIntelligence';
import { MomentumIntelligence } from './MomentumIntelligence';
import { TopMoversIntelligence } from './TopMoversIntelligence';
import { IntradayBreakouts } from './IntradayBreakouts';
import { IndexOverview } from './MarketInsights';
import { GlobalMarkets } from './GlobalMarkets';
import { PremarketPanel } from './PremarketPanel';
import { LiveMarketScreener } from './LiveMarketScreener';
import { EODMarketScreener } from './EODMarketScreener';

// ─── Fonts injected once ──────────────────────────────────────────────────────
const FONT_FAMILY_DISPLAY = "'Rajdhani', sans-serif";
const FONT_FAMILY_MONO = "'Space Mono', monospace";

// ─── Design tokens ────────────────────────────────────────────────────────────
const amber = '#f97316';   // saffron accent
const emerald = '#22c55e'; // bullish
const rose = '#ef4444';    // bearish
const hold = '#eab308';    // hold

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtPct(n: number) {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

// ─── BreadthGauge ─────────────────────────────────────────────────────────────
const BreadthGauge: React.FC<{ stocks: MarketData[] }> = ({ stocks }) => {
  const adv = stocks.filter(s => s.changePct > 0).length;
  const dec = stocks.filter(s => s.changePct < 0).length;
  const total = adv + dec || 1;
  const ratio = adv / total;

  const R = 58;
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

  const gaugeColor =
    ratio > 0.6 ? emerald :
    ratio < 0.4 ? rose :
    hold;

  return (
    <div className="flex flex-col items-center">
      <svg width={140} height={100} viewBox="0 0 140 100">
        {/* Track */}
        <path d={arcPath(1, R)} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={10} strokeLinecap="round" />
        {/* Fill */}
        <motion.path
          d={arcPath(ratio, R)}
          fill="none"
          stroke={gaugeColor}
          strokeWidth={10}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: ratio }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 6px ${gaugeColor}88)` }}
        />
        {/* Centre text */}
        <text x={cx} y={cy - 4} textAnchor="middle"
          style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 18, fontWeight: 700, fill: '#f8fafc' }}>
          {Math.round(ratio * 100)}%
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle"
          style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 9, fill: '#475569', letterSpacing: 2, textTransform: 'uppercase' }}>
          BREADTH
        </text>
        {/* Labels */}
        <text x={12} y={95} style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, fill: rose }}>{dec}↓</text>
        <text x={110} y={95} style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, fill: emerald }}>{adv}↑</text>
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
  const bg    = signal.signal === 'BUY' ? 'rgba(34,197,94,0.06)' : signal.signal === 'SELL' ? 'rgba(239,68,68,0.06)' : 'rgba(234,179,8,0.06)';

  return (
    <motion.div
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      className="group cursor-pointer"
      style={{
        background: bg,
        border: `1px solid ${color}22`,
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 6,
      }}
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        <ConfidenceRing value={signal.confidence} signal={signal.signal} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 13, fontWeight: 700, color: '#f8fafc', letterSpacing: 1 }}>
              {signal.symbol}
            </span>
            <span style={{
              fontFamily: FONT_FAMILY_DISPLAY, fontSize: 9, fontWeight: 700,
              color, background: `${color}18`, border: `1px solid ${color}30`,
              borderRadius: 4, padding: '1px 6px', letterSpacing: 2,
            }}>
              {signal.signal}
            </span>
          </div>
          <p className="text-slate-400 truncate" style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, marginTop: 2 }}>
            {signal.reasoning?.slice(0, 48) ?? ''}…
          </p>
          <div className="flex items-center gap-3 mt-1.5">
            <span style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: '#475569' }}>
              ₹{signal.entry} <span style={{ color: emerald }}>▲{signal.target}</span>
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onHistory(); }}
              className="ml-auto flex items-center gap-1 text-slate-400 hover:text-slate-300 transition-colors"
              style={{ fontSize: 9, fontFamily: FONT_FAMILY_DISPLAY, letterSpacing: 1 }}
            >
              <History size={9} /> HIST
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

// ─── SignalHistoryModal ───────────────────────────────────────────────────────
export const SignalHistoryModal: React.FC<{ symbol: string; onClose: () => void }> = ({ symbol, onClose }) => {
  const { data: history, isLoading } = trpc.getSignalHistory.useQuery({ symbol });

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative w-full max-w-2xl flex flex-col max-h-[85vh]"
        style={{
          background: '#0a0b0e',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '16px 20px' }}
          className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(249,115,22,0.1)',
              border: '1px solid rgba(249,115,22,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <History size={14} color={amber} />
            </div>
            <div>
              <div style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 16, fontWeight: 700, color: '#f8fafc', letterSpacing: 1 }}>
                {symbol} — SIGNAL HISTORY
              </div>
              <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: '#475569', marginTop: 1 }}>
                HISTORICAL AI PERFORMANCE AUDIT
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <Plus className="w-5 h-5 rotate-45" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto hide-scrollbar" style={{ padding: 16 }}>
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Activity className="w-8 h-8 animate-pulse" style={{ color: amber, opacity: 0.4 }} />
              <p style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 10, color: '#475569', marginTop: 12, letterSpacing: 2 }}>
                SYNCING HISTORY…
              </p>
            </div>
          ) : history && (history as any[]).length > 0 ? (
            <div className="space-y-3">
              {(history as any[]).map((sig: any) => {
                const c = sig.type === 'BUY' ? emerald : rose;
                return (
                  <div key={sig.id} style={{
                    background: '#0d0f13', border: '1px solid rgba(255,255,255,0.05)',
                    borderRadius: 10, padding: '12px 14px',
                  }}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span style={{
                          fontFamily: FONT_FAMILY_DISPLAY, fontSize: 10, fontWeight: 700, letterSpacing: 2,
                          color: c, background: `${c}12`, border: `1px solid ${c}28`,
                          borderRadius: 4, padding: '2px 7px',
                        }}>{sig.type}</span>
                        <span style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: '#475569' }}>
                          {sig.createdAt?.seconds
                            ? format(new Date(sig.createdAt.seconds * 1000), 'MMM dd, HH:mm')
                            : 'Recent'}
                        </span>
                      </div>
                      {sig.status && (
                        <span style={{
                          fontFamily: FONT_FAMILY_MONO, fontSize: 9,
                          color: sig.status === 'COMPLETED' ? emerald : sig.status === 'FAILED' ? rose : '#64748b',
                          letterSpacing: 1,
                        }}>{sig.status}</span>
                      )}
                    </div>
                    {sig.reasoning && (
                      <p style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: '#64748b', marginTop: 6, lineHeight: 1.5 }}>
                        {sig.reasoning}
                      </p>
                    )}
                    <div className="flex gap-4 mt-2">
                      {sig.entry && <span style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: '#475569' }}>ENTRY ₹{sig.entry}</span>}
                      {sig.target && <span style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: emerald }}>TGT ₹{sig.target}</span>}
                      {sig.stopLoss && <span style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: rose }}>SL ₹{sig.stopLoss}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16">
              <BarChart2 size={28} style={{ color: '#1e293b' }} />
              <p style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 10, color: '#334155', marginTop: 10, letterSpacing: 2 }}>
                NO HISTORY FOUND
              </p>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};

// ─── KPI Chip ─────────────────────────────────────────────────────────────────
const KpiChip: React.FC<{
  label: string;
  value: string;
  sub?: string;
  up?: boolean | null;
  accent?: string;
  icon?: React.ReactNode;
}> = ({ label, value, sub, up, accent = amber, icon }) => (
  <div className="glass shadow-[0_4px_20px_rgba(0,0,0,0.02)] border border-slate-800/50 border-t-2" style={{
    flex: 1, minWidth: 0,
    borderTopColor: accent,
    borderRadius: 10,
    padding: '12px 16px',
    display: 'flex', flexDirection: 'column', gap: 4,
  }}>
    <div className="flex items-center gap-1.5" style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 9, color: '#64748b', letterSpacing: 3, textTransform: 'uppercase' }}>
      {icon}
      {label}
    </div>
    <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 18, fontWeight: 700, color: '#0f172a', letterSpacing: -0.5 }}>
      {value}
    </div>
    {sub !== undefined && (
      <div style={{
        fontFamily: FONT_FAMILY_MONO, fontSize: 10,
        color: up === true ? '#059669' : up === false ? '#dc2626' : '#64748b',
      }}>
        {sub}
      </div>
    )}
  </div>
);

// ─── SectionLabel ─────────────────────────────────────────────────────────────
const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    fontFamily: FONT_FAMILY_DISPLAY, fontSize: 9, fontWeight: 700,
    color: '#334155', letterSpacing: 4, textTransform: 'uppercase',
    marginBottom: 10,
    display: 'flex', alignItems: 'center', gap: 6,
  }}>
    <span style={{ display: 'inline-block', width: 16, height: 1, background: '#334155' }} />
    {children}
    <span style={{ display: 'inline-block', flex: 1, height: 1, background: 'rgba(255,255,255,0.04)' }} />
  </div>
);

// ─── DashboardPage ────────────────────────────────────────────────────────────
interface DashboardPageProps {
  stocks: MarketData[];
  onNewSignal: (signal: any) => void;
  onSelectStock: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
  onSelectIndex?: (id: string, name: string) => void;
}

const DashboardPage: React.FC<DashboardPageProps> = ({
  stocks, onNewSignal, onSelectStock, watchlist, onToggleWatchlist, onSelectIndex,
}) => {
  const navigate = useNavigate();
  const news = useNewsFeed();
  const [aiSignals, setAiSignals] = useState<any[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [queueProgress, setQueueProgress] = useState<{ completed: number; total: number } | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<any | null>(null);
  const [historySymbol, setHistorySymbol] = useState<string | null>(null);

  const { data: niftyOhlc } = trpc.getOHLCData.useQuery({ symbol: 'in;NSX', dur: '1M' });
  const { data: vixData } = trpc.getIndiaVix.useQuery(undefined, { refetchInterval: 30000 });
  const graphData = useMemo(() => {
    const candles: any[] = niftyOhlc?.data ?? [];
    return candles.slice(-30).map((d: any, i: number) => ({
      time: i,
      value: +(d.close ?? d.c ?? 0),
    }));
  }, [niftyOhlc]);

  const enqueueSignalsMutation = trpc.enqueueSignals.useMutation();
  const { data: queueStats, refetch: refetchStats } = trpc.getQueueStats.useQuery(undefined, {
    refetchInterval: isGenerating ? 2000 : false,
  });
  const { data: accuracyMetrics } = trpc.getAccuracyMetrics.useQuery(undefined, {
    staleTime: 15 * 60 * 1000,
  });
  const { data: savedSignals, refetch: refetchSignals } = trpc.getSignals.useQuery(
    { limit: 50 },
    { refetchInterval: isGenerating ? 3000 : false },
  );

  useEffect(() => {
    if (!isGenerating || !savedSignals) return;
    const mapped = (savedSignals as any[]).map((s: any) => ({
      symbol: s.symbol, type: s.type, signal: s.type,
      entry: s.entry, target: s.target, stopLoss: s.stopLoss,
      confidence: s.confidence, reasoning: s.reasoning, history: [],
    }));
    setAiSignals(mapped);

    if (queueStats) {
      const { waiting, active, total } = queueStats as any;
      setQueueProgress({ completed: (queueStats as any).completed ?? 0, total: total ?? 0 });
      if ((waiting === 0 && active === 0 && total > 0) || !(queueStats as any).available) {
        setIsGenerating(false);
        setQueueProgress(null);
        mapped.filter((s: any) => (s.type === 'BUY' || s.type === 'SELL') && s.confidence > 70)
          .slice(0, 5).forEach((s: any) => onNewSignal(s));
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

  useEffect(() => {
    if (aiSignals.length === 0 && stocks.length > 0 && !isGenerating) {
      handleGenerateSignals();
    }
  }, [stocks.length]);

  // Derived market stats — this component polls getQueueStats every 2s and getSignals every
  // 3s while signal generation is running (potentially minutes on a cold cache), and every
  // tick re-rendered this component. These sorts/filters over the full live `stocks` list only
  // need to recompute when the market data itself changes, not on every queue-status tick.
  const { advancers, decliners, topGainers, topLosers, niftyStock } = useMemo(() => ({
    advancers: stocks.filter(s => s.changePct > 0).length,
    decliners: stocks.filter(s => s.changePct < 0).length,
    topGainers: [...stocks].sort((a, b) => b.changePct - a.changePct).slice(0, 5),
    topLosers: [...stocks].sort((a, b) => a.changePct - b.changePct).slice(0, 5),
    niftyStock: stocks.find(s => s.symbol === 'NIFTY' || s.symbol === 'NIFTY50') ?? stocks[0],
  }), [stocks]);

  const signalCount = aiSignals.filter(s => s.signal === 'BUY' || s.signal === 'SELL').length;
  const buySignals  = aiSignals.filter(s => s.signal === 'BUY').length;

  // Chart min/max for Y-axis domain
  const chartMin = graphData.length ? Math.min(...graphData.map(d => d.value)) * 0.9995 : 'auto';
  const chartMax = graphData.length ? Math.max(...graphData.map(d => d.value)) * 1.0005 : 'auto';

  // Trend: is today's last value > first value?
  const chartTrending = graphData.length > 1
    ? graphData[graphData.length - 1].value >= graphData[0].value
    : true;
  const chartColor = chartTrending ? emerald : rose;

  // Process VIX data
  const vixResult = (vixData as any)?.resultData;
  const vixGraphData = useMemo(() => {
    if (!vixResult?.chart_data) return [];
    return vixResult.chart_data.split(',').map((v: string, i: number) => ({
      time: i,
      value: parseFloat(v),
    }));
  }, [vixResult]);

  const vixTrending = (vixResult?.change_per ?? 0) >= 0;
  // Falling VIX is bullish (emerald), Rising VIX is bearish (rose)
  const vixColor = !vixTrending ? emerald : rose;

  const vixMin = vixGraphData.length ? Math.min(...vixGraphData.map(d => d.value)) * 0.98 : 'auto';
  const vixMax = vixGraphData.length ? Math.max(...vixGraphData.map(d => d.value)) * 1.02 : 'auto';

  return (
    <div style={{ padding: '12px 16px', background: 'transparent', minHeight: '100vh' }}>

      {/* ── V4 entry point ───────────────────────────────────────────────
          This dashboard (v1) is still the default landing experience, but v4's
          MarketCommandCenter/StockIntelligencePage are already reachable via the sidebar
          ("Market Command"/"Stock Intelligence" in both AppShell.tsx and V2AppShell.tsx) --
          just not prominently, buried among 30+ other nav items. This is a second, more
          discoverable entry point from the page every session actually lands on first. */}
      <button
        onClick={() => navigate('/market-command')}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', marginBottom: 12, padding: '10px 16px',
          background: 'linear-gradient(90deg, rgba(79,70,229,0.15), rgba(59,130,246,0.08))',
          border: '1px solid rgba(99,102,241,0.3)', borderRadius: 10,
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Gauge size={16} color="#818cf8" />
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>
              Try the new Market Command Center
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>
              Regime/breadth header, pre-market briefing, F&amp;O read, sector rotation — the next-gen dashboard
            </div>
          </div>
        </div>
        <ArrowUpRight size={14} color="#818cf8" style={{ flexShrink: 0 }} />
      </button>

      {/* ── Top Picks entry point ────────────────────────────────────────
          One canonical "most accurate signals only" page (S_ELITE/A_HIGH conviction,
          Buy-classified only) instead of navigating through the many screener/scanner
          pages to find what's actually worth acting on. Also surfaces same-day intraday
          picks with an honest gate-open/closed status, previously not shown anywhere. */}
      <button
        onClick={() => navigate('/buy-recs')}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', marginBottom: 12, padding: '10px 16px',
          background: 'linear-gradient(90deg, rgba(16,185,129,0.15), rgba(5,150,105,0.08))',
          border: '1px solid rgba(16,185,129,0.3)', borderRadius: 10,
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={16} color="#34d399" />
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>
              View Top Picks — highest-conviction signals only
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>
              S/A-tier Buy calls plus gated intraday picks, instead of scanning every screener page
            </div>
          </div>
        </div>
        <ArrowUpRight size={14} color="#34d399" style={{ flexShrink: 0 }} />
      </button>

      {/* ── Row 0: Market Indices Strip ─────────────────────────────────── */}
      <div style={{ marginBottom: 12 }}>
        <MarketIndices onSelect={(id, name) => onSelectIndex?.(id, name)} />
      </div>

      {/* ── Row 1: KPI Chips ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <KpiChip
          label="Market Breadth"
          value={`${advancers}↑  ${decliners}↓`}
          sub={advancers > decliners ? 'Bullish bias' : 'Bearish bias'}
          up={advancers > decliners}
          accent={advancers > decliners ? emerald : rose}
          icon={<Activity size={9} />}
        />
        <KpiChip
          label="AI Signals Active"
          value={String(signalCount)}
          sub={`${buySignals} BUY · ${signalCount - buySignals} SELL`}
          up={buySignals > signalCount / 2}
          accent={amber}
          icon={<Cpu size={9} />}
        />
        <KpiChip
          label="Signal Queue"
          value={isGenerating ? `${queueProgress?.completed ?? 0}/${queueProgress?.total ?? 0}` : 'IDLE'}
          sub={isGenerating ? 'Analysing…' : 'Ready'}
          up={null}
          accent={isGenerating ? amber : '#1e293b'}
          icon={<Radio size={9} />}
        />
        <KpiChip
          label="Win Rate"
          value={accuracyMetrics && accuracyMetrics.totalSignals > 0 ? `${accuracyMetrics.profitHitRate.toFixed(0)}%` : '—'}
          sub={accuracyMetrics && accuracyMetrics.totalSignals > 0 ? `${accuracyMetrics.totalSignals} signals resolved` : 'No resolved signals yet'}
          up={(accuracyMetrics?.profitHitRate ?? 0) >= 50}
          accent={emerald}
          icon={<TrendingUp size={9} />}
        />
      </div>

      {/* ── Row 2: Main 3-Column Body ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 280px', gap: 10, marginBottom: 12 }}>

        {/* LEFT: Breadth + Movers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Breadth gauge */}
          <div className="glass shadow-[0_4px_20px_rgba(0,0,0,0.02)] border border-slate-800/50 border-t-2" style={{
            borderTopColor: amber,
            borderRadius: 10,
            padding: '14px 10px',
          }}>
            <SectionLabel>Breadth</SectionLabel>
            <BreadthGauge stocks={stocks} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: emerald }}>
                ADV {advancers}
              </div>
              <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: '#475569' }}>
                UNCH {stocks.length - advancers - decliners}
              </div>
              <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: rose }}>
                DEC {decliners}
              </div>
            </div>
          </div>

          {/* Top movers */}
          <div className="glass border border-slate-800/50 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" style={{
            borderRadius: 10,
            padding: '14px 12px',
            flex: 1,
          }}>
            <SectionLabel>Top Gainers</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {topGainers.map(s => (
                <button
                  key={s.symbol}
                  onClick={() => onSelectStock(s.symbol)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: 'rgba(34,197,94,0.04)', border: '1px solid rgba(34,197,94,0.1)',
                    borderRadius: 6, padding: '5px 8px', cursor: 'pointer',
                  }}
                >
                  <span style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 11, fontWeight: 700, color: '#1e293b', letterSpacing: 0.5 }}>
                    {s.symbol}
                  </span>
                  <span style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 10, color: emerald }}>
                    {fmtPct(s.changePct)}
                  </span>
                </button>
              ))}
            </div>

            <div style={{ margin: '10px 0 8px', height: 1, background: 'rgba(255,255,255,0.04)' }} />

            <SectionLabel>Top Losers</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {topLosers.map(s => (
                <button
                  key={s.symbol}
                  onClick={() => onSelectStock(s.symbol)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.1)',
                    borderRadius: 6, padding: '5px 8px', cursor: 'pointer',
                  }}
                >
                  <span style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 11, fontWeight: 700, color: '#1e293b', letterSpacing: 0.5 }}>
                    {s.symbol}
                  </span>
                  <span style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 10, color: rose }}>
                    {fmtPct(s.changePct)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* CENTER: Nifty Chart + Sector Heatmap */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Nifty chart */}
          <div className="glass border border-slate-800/50 border-t-2 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" style={{
            borderTopColor: chartColor,
            borderRadius: 10,
            padding: '14px 16px',
          }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <div>
                <SectionLabel>NIFTY 50 — 30D</SectionLabel>
                {graphData.length > 0 && (
                  <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 22, fontWeight: 700, color: '#0f172a', lineHeight: 1 }}>
                    {graphData[graphData.length - 1].value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </div>
                )}
              </div>
              {graphData.length > 1 && (
                <div style={{
                  fontFamily: FONT_FAMILY_MONO, fontSize: 11,
                  color: chartTrending ? emerald : rose,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  {chartTrending ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                  {fmtPct(((graphData[graphData.length - 1].value - graphData[0].value) / graphData[0].value) * 100)}
                </div>
              )}
            </div>

            <div style={{ height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={graphData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="chartGradDash" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chartColor} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="rgba(0,0,0,0.04)" vertical={false} />
                  <XAxis dataKey="time" hide />
                  <YAxis hide domain={[chartMin, chartMax]} />
                  <Tooltip
                    contentStyle={{
                      background: '#ffffff', border: '1px solid rgba(0,0,0,0.08)',
                      borderRadius: 8, fontFamily: FONT_FAMILY_MONO, fontSize: 10, color: '#0f172a',
                    }}
                    formatter={(v: any) => [v.toLocaleString('en-IN', { maximumFractionDigits: 0 }), 'Nifty']}
                    labelFormatter={() => ''}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={chartColor}
                    strokeWidth={2}
                    fill="url(#chartGradDash)"
                    dot={false}
                    activeDot={{ r: 4, fill: chartColor, strokeWidth: 0 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* VIX chart */}
          {vixResult && (
            <div className="glass border border-slate-800/50 border-t-2 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" style={{
              borderTopColor: vixColor,
              borderRadius: 10,
              padding: '14px 16px',
            }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                <div>
                  <SectionLabel>INDIA VIX</SectionLabel>
                  <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 22, fontWeight: 700, color: '#0f172a', lineHeight: 1 }}>
                    {vixResult.last_trade_price?.toFixed(2)}
                  </div>
                </div>
                <div style={{
                  fontFamily: FONT_FAMILY_MONO, fontSize: 11,
                  color: vixColor,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  {vixTrending ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                  {fmtPct(vixResult.change_per)}
                </div>
              </div>

              <div style={{ height: 100 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={vixGraphData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="vixGradDash" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={vixColor} stopOpacity={0.25} />
                        <stop offset="95%" stopColor={vixColor} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 4" stroke="rgba(0,0,0,0.04)" vertical={false} />
                    <XAxis dataKey="time" hide />
                    <YAxis hide domain={[vixMin, vixMax]} />
                    <Tooltip
                      contentStyle={{
                        background: '#ffffff', border: '1px solid rgba(0,0,0,0.08)',
                        borderRadius: 8, fontFamily: FONT_FAMILY_MONO, fontSize: 10, color: '#0f172a',
                      }}
                      formatter={(v: any) => [v.toFixed(2), 'VIX']}
                      labelFormatter={() => ''}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke={vixColor}
                      strokeWidth={2}
                      fill="url(#vixGradDash)"
                      dot={false}
                      activeDot={{ r: 4, fill: vixColor, strokeWidth: 0 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Sector Heatmap */}
          <div className="glass border border-slate-800/50 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" style={{
            borderRadius: 10,
            padding: '14px 16px',
            flex: 1,
          }}>
            <SectionLabel>Sector Heatmap</SectionLabel>
            <SectorHeatmap className="h-full" />
          </div>
        </div>

        {/* RIGHT: AI Signals + News */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* AI Signals */}
          <div className="glass border border-slate-800/50 border-t-2 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" style={{
            borderTopColor: amber,
            borderRadius: 10,
            padding: '14px 12px',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
              <SectionLabel>AI Signals</SectionLabel>
              <button
                onClick={handleGenerateSignals}
                disabled={isGenerating}
                style={{
                  fontFamily: FONT_FAMILY_MONO, fontSize: 8, letterSpacing: 2,
                  color: isGenerating ? '#334155' : amber,
                  background: 'transparent', border: 'none', cursor: isGenerating ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}
              >
                <RefreshCw size={9} className={isGenerating ? 'animate-spin' : ''} />
                {isGenerating ? 'SCANNING' : 'REFRESH'}
              </button>
            </div>

            {/* Progress bar */}
            {isGenerating && queueProgress && queueProgress.total > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ height: 2, background: 'rgba(0,0,0,0.05)', borderRadius: 1, overflow: 'hidden' }}>
                  <motion.div
                    style={{ height: '100%', background: amber, borderRadius: 1 }}
                    animate={{ width: `${Math.round((queueProgress.completed / queueProgress.total) * 100)}%` }}
                    transition={{ duration: 0.4 }}
                  />
                </div>
                <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 8, color: '#334155', marginTop: 3, textAlign: 'right' }}>
                  {queueProgress.completed}/{queueProgress.total}
                </div>
              </div>
            )}

            <div style={{ flex: 1, overflowY: 'auto' }} className="hide-scrollbar">
              {aiSignals.length > 0 ? (
                aiSignals.slice(0, 8).map((sig, i) => (
                  <SignalCard
                    key={`${sig.symbol}-${i}`}
                    signal={sig}
                    onClick={() => onSelectStock(sig.symbol)}
                    onHistory={() => setHistorySymbol(sig.symbol)}
                  />
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-12">
                  <Zap size={24} style={{ color: `${amber}33` }} />
                  <p style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: '#334155', marginTop: 10, letterSpacing: 2 }}>
                    ENGINE INITIALISING…
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Latest News */}
          <div className="glass border border-slate-800/50 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" style={{
            borderRadius: 10,
            padding: '14px 12px',
          }}>
            <SectionLabel>Live News</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {news.slice(0, 4).map(item => (
                <div key={item.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)', paddingBottom: 8 }}>
                  <div className="flex items-center gap-2" style={{ marginBottom: 3 }}>
                    <span style={{
                      fontFamily: FONT_FAMILY_MONO, fontSize: 8, letterSpacing: 1,
                      color: item.category === 'Economy' ? '#f59e0b' : item.category === 'Stock' ? '#60a5fa' : '#a78bfa',
                      background: item.category === 'Economy' ? 'rgba(245,158,11,0.1)' : item.category === 'Stock' ? 'rgba(96,165,250,0.1)' : 'rgba(167,139,250,0.1)',
                      padding: '1px 5px', borderRadius: 3,
                    }}>{item.category}</span>
                    <span style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 8, color: '#334155' }}>{item.time}</span>
                  </div>
                  <p style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 11, fontWeight: 600, color: '#334155', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {item.title}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Row 3: Index Overview + Global Markets ────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div className="glass border border-slate-800/50 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" style={{ borderRadius: 10, padding: '14px 16px' }}>
          <SectionLabel>Index Overview</SectionLabel>
          <IndexOverview onSelectIndex={onSelectIndex} />
        </div>
        <div className="glass border border-slate-800/50 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" style={{ borderRadius: 10, padding: '14px 16px' }}>
          <SectionLabel>Global Markets</SectionLabel>
          <GlobalMarkets />
        </div>
      </div>

      {/* ── Row 4: Top Movers ─────────────────────────────────────────────── */}
      <div style={{ marginBottom: 12 }}>
        <TopMoversIntelligence onSelectStock={onSelectStock} />
      </div>

      {/* ── Row 5: Intraday Breakouts ────────────────────────────────────── */}
      <div style={{ marginBottom: 12 }}>
        <IntradayBreakouts onSelectStock={onSelectStock} />
      </div>

      {/* ── Row 6: Momentum ──────────────────────────────────────────────── */}
      <div>
        <MomentumIntelligence watchlist={watchlist} onToggle={onToggleWatchlist} onSelectStock={onSelectStock} />
      </div>

      {/* Pre-Market Intelligence */}
      <div className="mt-6">
        <PremarketPanel onSelectStock={onSelectStock} />
      </div>

      {/* ── Row 7: Live Market Screener ──────────────────────────────────── */}
      <div style={{ marginTop: 24, marginBottom: 12 }}>
        <LiveMarketScreener onSelectStock={onSelectStock} />
      </div>

      {/* ── Row 8: EOD Market Screener ───────────────────────────────────── */}
      <div style={{ marginTop: 24, marginBottom: 12 }}>
        <EODMarketScreener onSelectStock={onSelectStock} />
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────── */}
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
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 16 }}
              className="relative w-full max-w-lg"
              style={{
                background: '#0a0b0e', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 14, overflow: 'hidden',
              }}
            >
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '16px 20px' }}
                className="flex items-center justify-between">
                <div>
                  <div style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 20, fontWeight: 700, color: '#f8fafc', letterSpacing: 1 }}>
                    {selectedSignal.symbol}
                  </div>
                  <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 9, color: '#475569', marginTop: 2, letterSpacing: 2 }}>
                    AI DEEP ANALYSIS · {selectedSignal.confidence}% CONFIDENCE
                  </div>
                </div>
                <button onClick={() => setSelectedSignal(null)} className="text-slate-400 hover:text-white transition-colors">
                  <Plus className="w-5 h-5 rotate-45" />
                </button>
              </div>
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {[
                    { l: 'ENTRY', v: `₹${selectedSignal.entry}`, c: '#f8fafc' },
                    { l: 'TARGET', v: `₹${selectedSignal.target}`, c: emerald },
                    { l: 'STOP LOSS', v: `₹${selectedSignal.stopLoss}`, c: rose },
                  ].map(({ l, v, c }) => (
                    <div key={l} style={{ background: '#0d0f13', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                      <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 8, color: '#475569', letterSpacing: 2, marginBottom: 4 }}>{l}</div>
                      <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 14, fontWeight: 700, color: c }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ background: '#0d0f13', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 8, color: '#475569', letterSpacing: 2, marginBottom: 6 }}>REASONING</div>
                  <p style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 10, color: '#94a3b8', lineHeight: 1.6 }}>
                    {selectedSignal.reasoning}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedSignal(null)}
                  style={{
                    fontFamily: FONT_FAMILY_DISPLAY, fontSize: 12, fontWeight: 700, letterSpacing: 3,
                    background: amber, color: '#000', border: 'none', borderRadius: 8,
                    padding: '12px', cursor: 'pointer', textTransform: 'uppercase',
                  }}
                >
                  ACKNOWLEDGE
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default DashboardPage;
