import React, { useState, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import { motion, AnimatePresence } from 'motion/react';
import {
  BrainCircuit, Target, Search, Filter, ChevronRight,
  Layers, Calculator, Flame, Eye, Bookmark, Gauge, DollarSign, Scale
} from 'lucide-react';
import { cn } from '../lib/utils';
import { LegacyScoreBanner } from './CanonicalSourceNote';
import { parseDecisionMatrixInputs, buildMatrixItems } from './decisionMatrixInputs';

const fmt = (n: number | null | undefined, dec = 2) =>
  n == null || isNaN(n) ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });

// Input is already in ₹ crore (getFiiDiiFlow.fii_net); it used to be divided by 1e7 as if rupees.
const fmtCr = (cr: number | null | undefined) => {
  if (cr == null || isNaN(cr)) return '—';
  return `${cr >= 0 ? '+' : '−'}₹${Math.abs(cr).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
};

const fmtSignedPct = (n: number | null | undefined) =>
  n == null || isNaN(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;

const pctColor = (v: number | null | undefined) =>
  v == null || isNaN(v) ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-rose-400';

const bgPctColor = (v: number | null | undefined) =>
  v == null || isNaN(v) ? 'bg-slate-800/50 text-slate-300 border-slate-700' : v >= 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-rose-500/10 text-rose-400 border-rose-500/30';

interface Props {
  onSelectStock: (symbol: string) => void;
  onToggleWatchlist?: (symbol: string) => void;
  watchlist?: string[];
}

type TabType = 'matrix' | 'regime' | 'smart-money' | 'fno' | 'calculator';
type ViewType = 'table' | 'grid';

export const UltimateDecisionMatrix: React.FC<Props> = ({
  onSelectStock,
  onToggleWatchlist,
  watchlist = []
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('matrix');
  const [viewType, setViewType] = useState<ViewType>('table');
  const [searchTerm, setSearchTerm] = useState('');
  const [strategyFilter, setStrategyFilter] = useState<string>('ALL');
  const [convictionFilter, setConvictionFilter] = useState<number>(0);

  // Position Risk Calculator State
  const [calcPortfolioSize, setCalcPortfolioSize] = useState<number>(500000);
  const [calcRiskPct, setCalcRiskPct] = useState<number>(2);
  const [calcEntryPrice, setCalcEntryPrice] = useState<number>(1000);
  const [calcStopLoss, setCalcStopLoss] = useState<number>(950);
  const [calcTargetPrice, setCalcTargetPrice] = useState<number>(1150);

  // tRPC Procedures
  const { data: cockpitRes } = trpc.getTradeDecisionCockpitData.useQuery(undefined, { refetchInterval: 60000, refetchOnWindowFocus: false });
  const { data: recsRes } = trpc.getBuyRecommendations.useQuery({ limit: 30 }, { refetchInterval: 120000, refetchOnWindowFocus: false });
  const { data: overviewRes } = trpc.getAllIndices.useQuery(undefined, { refetchInterval: 30000, refetchOnWindowFocus: false });
  const { data: adRes } = trpc.getAdvanceDecline.useQuery(undefined, { refetchInterval: 60000, refetchOnWindowFocus: false });
  const { data: fiiRes } = trpc.getFiiDiiFlow.useQuery({ days: 10 }, { refetchInterval: 300000, refetchOnWindowFocus: false });
  const { data: sentimentRes } = trpc.getMarketSentiment.useQuery(undefined, { refetchInterval: 120000, refetchOnWindowFocus: false });
  const { data: regimeRes } = trpc.getRegimeSummary.useQuery(undefined, { refetchInterval: 300000, refetchOnWindowFocus: false });
  const { data: buildupRes } = trpc.getFuturesBuildupMatrix.useQuery({ perBucket: 5 }, { refetchInterval: 300000, refetchOnWindowFocus: false });

  const cockpitData = cockpitRes?.success ? cockpitRes.data : null;
  const rawCandidates: any[] = cockpitData?.candidates || [];
  const unifiedRecs: any[] = (recsRes as any)?.picks ?? [];

  const { nifty, bankNifty, vix, advances, declines, fiiNetCr, fiiDate, pcr } =
    parseDecisionMatrixInputs({ overviewRes, adRes, fiiRes, sentimentRes });
  const advPct = advances != null && declines != null && advances + declines > 0
    ? Math.round((advances / (advances + declines)) * 100) : null;
  const regime = regimeRes?.current ?? null;
  const pcrText = pcr == null ? '—' : pcr.toFixed(2);

  const combinedItems = useMemo(() => buildMatrixItems(rawCandidates, unifiedRecs), [rawCandidates, unifiedRecs]);

  const filteredItems = useMemo(() => {
    return combinedItems.filter(item => {
      if (searchTerm && !item.symbol.toLowerCase().includes(searchTerm.toLowerCase()) && !item.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
      if (strategyFilter !== 'ALL' && item.setupType !== strategyFilter) return false;
      if (convictionFilter > 0 && item.confidence < convictionFilter) return false;
      return true;
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }, [combinedItems, searchTerm, strategyFilter, convictionFilter]);

  const topPicks = useMemo(() => [...combinedItems].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 3), [combinedItems]);

  const calcResult = useMemo(() => {
    const maxRiskAmount = (calcPortfolioSize * calcRiskPct) / 100;
    const riskPerShare = Math.max(1, Math.abs(calcEntryPrice - calcStopLoss));
    const sharesCount = Math.floor(maxRiskAmount / riskPerShare);
    const totalPositionCost = sharesCount * calcEntryPrice;
    const portfolioAllocPct = (totalPositionCost / calcPortfolioSize) * 100;
    const rewardPerShare = Math.max(0, calcTargetPrice - calcEntryPrice);
    const expectedProfit = sharesCount * rewardPerShare;
    const rrRatio = (rewardPerShare / riskPerShare).toFixed(2);
    return { maxRiskAmount, riskPerShare, sharesCount, totalPositionCost, portfolioAllocPct, expectedProfit, rrRatio };
  }, [calcPortfolioSize, calcRiskPct, calcEntryPrice, calcStopLoss, calcTargetPrice]);

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100 p-4 lg:p-6 font-sans space-y-6">
      <LegacyScoreBanner note="The Decision Matrix synthesizes cross-engine ML models, institutional money flow, F&O positioning, and technical breakout setups into a single unified workspace." />

      {/* ── HEADER & TELEMETRY STRIP ─────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900/90 to-indigo-950/40 border border-slate-800/80 p-5 shadow-2xl backdrop-blur-xl">
        <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/10 blur-[120px] pointer-events-none rounded-full" />
        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800/60 pb-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1.5 shadow-[0_0_12px_rgba(6,182,212,0.2)]">
                <BrainCircuit className="w-3 h-3 text-cyan-400" /> V5 DECISION ENGINE PRO
              </span>
            </div>
            <h1 className="text-2xl lg:text-3xl font-black text-white tracking-tight font-display">
              Ultimate Decision Intelligence Cockpit
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              Consolidated high-conviction alpha signals combining v1 Deep Quant, v2 Telemetry, v3 Cross-Engine Scores, and v4 Command Briefing.
            </p>
          </div>

          <div className="flex items-center gap-3 bg-slate-950/80 p-3 rounded-xl border border-slate-800/80 shadow-inner">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <Flame className="w-5 h-5 text-emerald-400 animate-pulse" />
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">MARKET BIAS & STANCE</div>
              {/* Canonical HMM regime (getRegimeSummary) -- this headline used to be a hard-coded
                  "BULLISH MOMENTUM" shown whatever the market did (AF-20260930-43). */}
              <div className={cn('text-sm font-black tracking-wide flex items-center gap-1.5',
                regime?.regime === 'BULL' ? 'text-emerald-400' : regime?.regime === 'BEAR' || regime?.regime === 'CRASH' ? 'text-rose-400' : 'text-amber-400')}>
                {regime ? `${regime.regime} REGIME` : '—'}
              </div>
              <div className="text-[10px] text-slate-400 font-mono">{regime?.guidance?.action ?? 'Regime unavailable'}</div>
            </div>
          </div>
        </div>

        {/* Telemetry Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-4">
          <div className="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">NIFTY 50</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-sm font-mono font-bold text-white">{fmt(nifty?.value, 0)}</span>
              <span className={cn("text-xs font-mono font-bold", pctColor(nifty?.changePct))}>{fmtSignedPct(nifty?.changePct)}</span>
            </div>
          </div>

          <div className="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">BANK NIFTY</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-sm font-mono font-bold text-white">{fmt(bankNifty?.value, 0)}</span>
              <span className={cn("text-xs font-mono font-bold", pctColor(bankNifty?.changePct))}>{fmtSignedPct(bankNifty?.changePct)}</span>
            </div>
          </div>

          <div className="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">INDIA VIX</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-sm font-mono font-bold text-amber-400">{fmt(vix, 2)}</span>
            </div>
          </div>

          <div className="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">FII NET FLOW</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className={cn("text-sm font-mono font-bold", pctColor(fiiNetCr))}>{fmtCr(fiiNetCr)}</span>
              {fiiDate && <span className="text-[9px] text-slate-500 font-mono">{fiiDate}</span>}
            </div>
          </div>

          <div className="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">BREADTH</span>
            <div className="mt-1 space-y-1">
              <div className="flex justify-between text-[10px] font-mono font-bold">
                <span className="text-emerald-400">{advances ?? '—'} Adv</span>
                <span className="text-rose-400">{declines ?? '—'} Dec</span>
              </div>
              {advPct != null && (
                <div className="w-full h-1.5 bg-rose-500/30 rounded-full overflow-hidden flex">
                  <div className="h-full bg-emerald-500" style={{ width: `${advPct}%` }} />
                </div>
              )}
            </div>
          </div>

          <div className="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">F&O PCR</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-sm font-mono font-bold text-cyan-400">{pcrText}</span>
              {pcr != null && (
                <span className="text-[10px] text-cyan-400 font-bold uppercase">{pcr >= 1 ? 'PUTS ≥ CALLS' : 'CALLS > PUTS'}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── TOP 3 HERO CARDS ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {topPicks.map((pick, index) => (
          <motion.div
            key={pick.symbol}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="group relative rounded-2xl bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800 p-5 hover:border-cyan-500/50 transition-all duration-300 shadow-xl overflow-hidden"
          >
            <div className="absolute top-0 right-0 bg-cyan-500/20 px-3 py-1 rounded-bl-xl border-l border-b border-cyan-500/30 text-right">
              <span className="text-[10px] font-black text-cyan-400 uppercase">RANK #0{index + 1} ALPHA</span>
            </div>

            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-black text-white group-hover:text-cyan-400 transition-colors font-display">
                    {pick.symbol}
                  </h3>
                  <span className={cn("px-2 py-0.5 text-[9px] font-black rounded border", bgPctColor(pick.changePct))}>
                    {fmtSignedPct(pick.changePct)}
                  </span>
                </div>
                <p className="text-xs text-slate-400 truncate max-w-[200px]">{pick.name}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
                <div>
                  <span className="text-[9px] font-bold text-slate-400 uppercase block">AI SCORE</span>
                  <div className="text-lg font-mono font-black text-emerald-400">{pick.score ?? '—'}<span className="text-xs text-slate-500">/100</span></div>
                </div>
                <div>
                  <span className="text-[9px] font-bold text-slate-400 uppercase block">CONVICTION</span>
                  <div className="text-lg font-mono font-black text-cyan-400">{pick.confidence != null ? `${Math.round(pick.confidence)}%` : '—'}</div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
                <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800">
                  <span className="text-slate-400 font-bold block">ENTRY</span>
                  <span className="font-mono font-bold text-white">{pick.entryZone ?? '—'}</span>
                </div>
                <div className="bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
                  <span className="text-emerald-400 font-bold block">TARGET</span>
                  <span className="font-mono font-bold text-emerald-400">{pick.target1 != null ? `₹${fmt(pick.target1, 0)}` : '—'}</span>
                </div>
                <div className="bg-rose-500/10 p-2 rounded-lg border border-rose-500/20">
                  <span className="text-rose-400 font-bold block">STOP LOSS</span>
                  <span className="font-mono font-bold text-rose-400">{pick.stopLoss != null ? `₹${fmt(pick.stopLoss, 0)}` : '—'}</span>
                </div>
              </div>

              <p className="text-xs text-slate-300 italic bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/50 leading-relaxed">
                {pick.reasoning ? `"${pick.reasoning}"` : 'No rationale recorded for this pick.'}
              </p>

              <div className="pt-1 flex gap-2">
                <button
                  onClick={() => onSelectStock(pick.symbol)}
                  className="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white text-xs font-bold transition-all shadow-md flex items-center justify-center gap-1.5"
                >
                  <Eye className="w-3.5 h-3.5" /> Inspect Setup
                </button>
                {onToggleWatchlist && (
                  <button
                    onClick={() => onToggleWatchlist(pick.symbol)}
                    className={cn(
                      "p-2 rounded-xl border transition-colors flex items-center justify-center",
                      watchlist.includes(pick.symbol) ? "bg-amber-500/20 border-amber-500/40 text-amber-400" : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                    )}
                  >
                    <Bookmark className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </div>
      {/* ── NAVIGATION TABS ────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/90 p-3 rounded-2xl border border-slate-800 backdrop-blur-md">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 md:pb-0">
          {[
            { id: 'matrix', label: 'Decision Matrix', icon: Layers },
            { id: 'regime', label: 'Market Regime', icon: Gauge },
            { id: 'smart-money', label: 'Institutional Flow', icon: DollarSign },
            { id: 'fno', label: 'F&O Derivatives Radar', icon: Flame },
            { id: 'calculator', label: 'Position Risk Tool', icon: Calculator },
          ].map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabType)}
                className={cn(
                  "px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shrink-0",
                  active ? "bg-gradient-to-r from-cyan-500 to-indigo-600 text-white shadow-lg shadow-cyan-500/20" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === 'matrix' && (
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search symbol..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="pl-9 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 w-44"
              />
            </div>
            <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button onClick={() => setViewType('table')} className={cn("px-2.5 py-1 rounded-lg text-xs font-bold", viewType === 'table' ? "bg-slate-800 text-cyan-400" : "text-slate-400")}>Table</button>
              <button onClick={() => setViewType('grid')} className={cn("px-2.5 py-1 rounded-lg text-xs font-bold", viewType === 'grid' ? "bg-slate-800 text-cyan-400" : "text-slate-400")}>Grid</button>
            </div>
          </div>
        )}
      </div>
      {/* ── TAB CONTENT ─────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {activeTab === 'matrix' && (
          <motion.div key="matrix" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 bg-slate-900/40 p-3 rounded-xl border border-slate-800/60 text-xs">
              <span className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">SETUPS:</span>
              {['ALL', 'BREAKOUT', 'QUANT_ALPHA', 'SMART_MONEY', 'FNO_BUILDUP'].map(st => (
                <button
                  key={st}
                  onClick={() => setStrategyFilter(st)}
                  className={cn("px-3 py-1 rounded-lg font-bold text-[11px]", strategyFilter === st ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/40" : "bg-slate-950 text-slate-400 border border-slate-800")}
                >
                  {st.replace('_', ' ')}
                </button>
              ))}
            </div>

            {viewType === 'table' ? (
              <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-950/60 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      <th className="py-3.5 px-4">SYMBOL & COMPANY</th>
                      <th className="py-3.5 px-3">PRICE / CHG</th>
                      <th className="py-3.5 px-3">VERDICT</th>
                      <th className="py-3.5 px-3 text-center">AI SCORE</th>
                      <th className="py-3.5 px-3 text-center">R:R RATIO</th>
                      <th className="py-3.5 px-3">TARGET / STOP</th>
                      <th className="py-3.5 px-4">AI REASONING</th>
                      <th className="py-3.5 px-4 text-right">ACTION</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs font-mono">
                    {filteredItems.map(item => (
                      <tr key={item.symbol} className="hover:bg-slate-800/40 transition-colors group cursor-pointer" onClick={() => onSelectStock(item.symbol)}>
                        <td className="py-3 px-4 font-sans">
                          <div className="font-black text-white group-hover:text-cyan-400 transition-colors text-sm">{item.symbol}</div>
                          <div className="text-[10px] text-slate-400 truncate max-w-[140px]">{item.name}</div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="font-bold text-white">{item.price != null ? `₹${fmt(item.price, 1)}` : '—'}</div>
                          <div className={cn("text-[10px] font-bold", pctColor(item.changePct))}>{fmtSignedPct(item.changePct)}</div>
                        </td>
                        <td className="py-3 px-3 font-sans">
                          <span className={cn("px-2.5 py-1 rounded-md text-[10px] font-black uppercase", (item.action ?? '').includes('STRONG') ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" : "bg-cyan-500/20 text-cyan-400 border border-cyan-500/40")}>
                            {item.action ?? '—'}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-center">
                          <span className="font-black text-sm text-emerald-400">{item.score ?? '—'}</span>
                        </td>
                        <td className="py-3 px-3 text-center font-bold text-cyan-400">{item.rrRatio ?? '—'}</td>
                        <td className="py-3 px-3 text-[11px]">
                          <div className="text-emerald-400 font-bold">T: {item.target1 != null ? `₹${fmt(item.target1, 0)}` : '—'}</div>
                          <div className="text-rose-400">SL: {item.stopLoss != null ? `₹${fmt(item.stopLoss, 0)}` : '—'}</div>
                        </td>
                        <td className="py-3 px-4 font-sans text-slate-300 text-[11px] max-w-xs leading-snug">{item.reasoning ?? '—'}</td>
                        <td className="py-3 px-4 text-right font-sans">
                          <button onClick={() => onSelectStock(item.symbol)} className="p-2 rounded-xl bg-slate-800 hover:bg-cyan-600 text-slate-300 hover:text-white transition-colors">
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {filteredItems.map(item => (
                  <div key={item.symbol} className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl space-y-3 cursor-pointer" onClick={() => onSelectStock(item.symbol)}>
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="text-base font-black text-white">{item.symbol}</h4>
                        <p className="text-xs text-slate-400">{item.name}</p>
                      </div>
                      <span className={cn("px-2 py-0.5 text-xs font-bold rounded", bgPctColor(item.changePct))}>{fmtSignedPct(item.changePct)}</span>
                    </div>
                    {item.reasoning && <p className="text-xs text-slate-300 line-clamp-2">"{item.reasoning}"</p>}
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
        {activeTab === 'regime' && (
          <motion.div key="regime" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-2">
                {/* Every headline below used to be a hard-coded verdict ("LOW VOLATILITY", "LONG
                    BUILD-UP", "NET ACCUMULATION", "70% allocation") shown whatever the data said
                    (AF-20260930-43). Now: the live value, and only a factual description of it. */}
                <span className="text-xs font-bold text-slate-400 uppercase">INDIA VIX</span>
                <h3 className="text-xl font-black text-amber-400">{fmt(vix, 2)}</h3>
                <p className="text-xs text-slate-400">Live India VIX (annualised expected 30-day NIFTY volatility, %).</p>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-2">
                <span className="text-xs font-bold text-slate-400 uppercase">NIFTY PUT/CALL RATIO</span>
                <h3 className="text-xl font-black text-cyan-400">{pcrText}</h3>
                <p className="text-xs text-slate-400">{pcr == null ? 'PCR unavailable.' : pcr >= 1 ? 'More put than call open interest.' : 'More call than put open interest.'}</p>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-2">
                <span className="text-xs font-bold text-slate-400 uppercase">FII NET FLOW{fiiDate ? ` · ${fiiDate}` : ''}</span>
                <h3 className={cn('text-xl font-black', pctColor(fiiNetCr))}>{fiiNetCr == null ? '—' : fiiNetCr >= 0 ? 'NET BUYING' : 'NET SELLING'}</h3>
                <p className="text-xs text-slate-400">FII cash-market net: {fmtCr(fiiNetCr)}.</p>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-2">
                <span className="text-xs font-bold text-slate-400 uppercase">REGIME GUIDANCE</span>
                <h3 className={cn('text-xl font-black', regime?.regime === 'BULL' ? 'text-emerald-400' : regime?.regime === 'BEAR' || regime?.regime === 'CRASH' ? 'text-rose-400' : 'text-amber-400')}>
                  {regime?.regime ?? '—'}
                </h3>
                <p className="text-xs text-slate-400">{regime?.guidance?.action ?? 'Regime unavailable.'} (canonical HMM regime detector)</p>
              </div>
            </div>
          </motion.div>
        )}

        {activeTab === 'smart-money' && (
          <motion.div key="smart-money" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-4">
              <h3 className="text-lg font-black text-white flex items-center gap-2 font-display">
                <DollarSign className="w-5 h-5 text-emerald-400" /> Institutional Flow & Superstar Accumulation Radar
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {combinedItems.slice(0, 6).map(item => (
                  <div key={item.symbol} className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-black text-white">{item.symbol}</h4>
                      <p className="text-xs text-slate-400">{item.name}</p>
                    </div>
                    <button onClick={() => onSelectStock(item.symbol)} className="px-3 py-1.5 bg-slate-800 hover:bg-cyan-600 text-xs font-bold text-white rounded-lg transition-colors">
                      Inspect
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {activeTab === 'fno' && (
          <motion.div key="fno" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-4">
              <h3 className="text-lg font-black text-white flex items-center gap-2 font-display">
                <Flame className="w-5 h-5 text-amber-400" /> Open Interest Build-Up Matrix
                <span className="text-[10px] font-mono font-normal text-slate-500">
                  {buildupRes?.asOf ? `stock futures, near month · ${buildupRes.asOf}` : 'no futures OI data'}
                </span>
              </h3>
              {/* Was four hard-coded ticker lists (RELIANCE, HAL, TATASTEEL ...); now
                  stock_futures_oi_history via getFuturesBuildupMatrix (AF-20260930-41). */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-center">
                {([
                  ['Long Buildup', 'LONG BUILD-UP', 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'],
                  ['Short Covering', 'SHORT COVERING', 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'],
                  ['Short Buildup', 'SHORT BUILD-UP', 'bg-rose-500/10 border-rose-500/30 text-rose-400'],
                  ['Long Unwinding', 'LONG UNWINDING', 'bg-amber-500/10 border-amber-500/30 text-amber-400'],
                ] as const).map(([key, label, tone]) => {
                  const rows = buildupRes?.buckets?.[key] ?? [];
                  return (
                    <div key={key} className={cn('border p-4 rounded-xl', tone)}>
                      <span className="text-[10px] font-bold uppercase block">{label}</span>
                      {rows.length ? (
                        <div className="mt-1 flex flex-wrap justify-center gap-1">
                          {rows.map(r => (
                            <button key={r.symbol} onClick={() => onSelectStock(r.symbol)}
                              className="text-xs font-mono font-bold text-white hover:underline">
                              {r.symbol}{r.oi_pct_change != null ? ` (${r.oi_pct_change > 0 ? '+' : ''}${r.oi_pct_change.toFixed(1)}% OI)` : ''}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs font-mono text-slate-500 mt-1">{buildupRes ? 'none this session' : '—'}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}

        {activeTab === 'calculator' && (
          <motion.div key="calculator" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-4">
              <h3 className="text-base font-black text-white flex items-center gap-2 border-b border-slate-800 pb-3 font-sans">
                <Calculator className="w-4 h-4 text-cyan-400" /> Position Risk Simulator
              </h3>
              <div className="space-y-3 text-xs">
                <div>
                  <label className="text-slate-400 font-bold block mb-1">Portfolio Size (₹)</label>
                  <input type="number" value={calcPortfolioSize} onChange={e => setCalcPortfolioSize(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-white" />
                </div>
                <div>
                  <label className="text-slate-400 font-bold block mb-1">Risk Per Trade (%)</label>
                  <input type="number" step="0.5" value={calcRiskPct} onChange={e => setCalcRiskPct(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-white" />
                </div>
                <div>
                  <label className="text-slate-400 font-bold block mb-1">Entry Price (₹)</label>
                  <input type="number" value={calcEntryPrice} onChange={e => setCalcEntryPrice(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-white" />
                </div>
                <div>
                  <label className="text-slate-400 font-bold block mb-1">Stop Loss (₹)</label>
                  <input type="number" value={calcStopLoss} onChange={e => setCalcStopLoss(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-white" />
                </div>
                <div>
                  <label className="text-slate-400 font-bold block mb-1">Target Price (₹)</label>
                  <input type="number" value={calcTargetPrice} onChange={e => setCalcTargetPrice(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-white" />
                </div>
              </div>
            </div>

            <div className="lg:col-span-2 bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-5 font-mono">
              <h3 className="text-base font-black text-white flex items-center gap-2 border-b border-slate-800 pb-3 font-sans">
                <Scale className="w-4 h-4 text-emerald-400" /> Optimal Execution Breakdown
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-400 font-bold uppercase block font-sans">SHARES TO BUY</span>
                  <span className="text-2xl font-black text-cyan-400">{calcResult.sharesCount.toLocaleString('en-IN')}</span>
                </div>
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-400 font-bold uppercase block font-sans">MAX TRADE RISK</span>
                  <span className="text-2xl font-black text-rose-400">₹{fmt(calcResult.maxRiskAmount, 0)}</span>
                </div>
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-400 font-bold uppercase block font-sans">EXPECTED PROFIT</span>
                  <span className="text-2xl font-black text-emerald-400">₹{fmt(calcResult.expectedProfit, 0)}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default UltimateDecisionMatrix;
