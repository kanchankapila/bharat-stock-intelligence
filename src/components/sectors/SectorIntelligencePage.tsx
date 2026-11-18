import React, { useState, useMemo } from 'react';
import {
  PieChart, TrendingUp, TrendingDown, Activity, Zap, Shield, Target,
  Layers, ArrowUpRight, ArrowDownRight, Compass, RefreshCw, Eye, Sparkles,
  Filter, ChevronRight, Info, AlertTriangle, CheckCircle, BarChart2,
  DollarSign, Globe, Sliders, Search, ArrowRight, BookOpen, Clock
} from 'lucide-react';
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis,
  Tooltip, ReferenceLine, BarChart, Bar, Cell, Legend
} from 'recharts';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/utils';
import { Card } from '../Card';

interface SectorIntelligencePageProps {
  onSelectStock?: (symbol: string) => void;
  onSelectIndex?: (id: string, name: string) => void;
}

import { SectorIntelTab } from './SectorIntelTab';
import { AsOfLine } from '../AsOfLine';

type DeskTab = 'overview' | 'rotation' | 'derivatives' | 'deepdive' | 'intel';
type Timeframe = '1d' | '5d' | '1m' | '3m' | '6m' | '1y';

export const SectorIntelligencePage: React.FC<SectorIntelligencePageProps> = ({
  onSelectStock,
  onSelectIndex,
}) => {
  // State
  const [activeTab, setActiveTab] = useState<DeskTab>('overview');
  const [selectedSectorId, setSelectedSectorId] = useState<string>('nifty-bank');
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('1m');
  const [searchQuery, setSearchQuery] = useState('');
  const [stanceFilter, setStanceFilter] = useState<string>('ALL');

  // Queries
  const {
    data: overviewData,
    isLoading: isLoadingOverview,
    refetch: refetchOverview,
    isFetching: isFetchingOverview,
    dataUpdatedAt: overviewUpdatedAt,
  } = trpc.getSectorsOverview.useQuery(undefined, {
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const {
    data: deepDiveData,
    isLoading: isLoadingDeepDive,
    refetch: refetchDeepDive,
  } = trpc.getSectorDeepDive.useQuery(
    { sectorId: selectedSectorId },
    { enabled: !!selectedSectorId, refetchOnWindowFocus: false }
  );

  const { data: derivativesData } = trpc.getSectorDerivativesDesk.useQuery(undefined, {
    refetchInterval: 60000,
  });

  const { data: mfFlowsData } = trpc.getSectorMfFlows.useQuery();

  const aiBriefingMutation = trpc.generateSectorAiBriefing.useMutation();
  const [aiReport, setAiReport] = useState<any>(null);

  // No hard-coded fallback: a failed or empty overview shows an explicit unavailable state.
  const sectors = overviewData?.sectors ?? [];

  const marketRegime = overviewData?.marketRegime || 'SIDEWAYS';
  const niftyBaseline = overviewData?.niftyBaseline || { value: 25418.5, changePct: 0.32 };

  // Active sector in overview
  const activeSector = useMemo(() => {
    return sectors.find(s => s.id === selectedSectorId) || sectors[0];
  }, [sectors, selectedSectorId]);

  // Filtered sectors for list / cards
  const filteredSectors = useMemo(() => {
    return sectors.filter(s => {
      const matchesSearch = s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            s.dbSector.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStance = stanceFilter === 'ALL' || s.analyst.stance === stanceFilter;
      return matchesSearch && matchesStance;
    });
  }, [sectors, searchQuery, stanceFilter]);

  // Handle AI briefing generation
  const handleGenerateAiReport = async () => {
    try {
      const res = await aiBriefingMutation.mutateAsync({ sectorId: selectedSectorId });
      setAiReport(res);
    } catch (e) {
      console.error('Failed to generate AI report:', e);
    }
  };

  // RRG Quadrant Chart Data
  const rrgData = useMemo(() => {
    return sectors.filter(s => s.rrg.rsRatio != null).map(s => ({
      name: s.name,
      id: s.id,
      x: s.rrg.rsRatio,
      y: s.rrg.rsMomentum,
      quadrant: s.rrg.quadrant,
      changePct: s.changePct,
      stance: s.analyst.stanceLabel,
    }));
  }, [sectors]);

  // Multi-timeframe bar data
  const timeframeBarData = useMemo(() => {
    // Real index returns from the server; a sector without that window is left out, never
    // estimated from the 1-day move (AF-20261117).
    return sectors.flatMap(s => {
      const val = selectedTimeframe === '1d'
        ? s.changePct
        : (s as { returns?: Partial<Record<Timeframe, number>> }).returns?.[selectedTimeframe];
      if (val == null) return [];
      return [{
        name: s.name.replace('NIFTY ', ''),
        id: s.id,
        returnPct: parseFloat(val.toFixed(2)),
      }];
    }).sort((a, b) => b.returnPct - a.returnPct);
  }, [sectors, selectedTimeframe]);

  // Top gainer and top momentum
  const topGainer = useMemo(() => {
    if (sectors.length === 0) return null;
    return [...sectors].sort((a, b) => b.changePct - a.changePct)[0];
  }, [sectors]);

  const topMomentum = useMemo(() => {
    if (sectors.length === 0) return null;
    return [...sectors].sort((a, b) => b.rrg.rsMomentum - a.rrg.rsMomentum)[0];
  }, [sectors]);

  if (sectors.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800/80 bg-slate-900 p-8 text-center text-slate-300">
        <p className="text-sm">{isLoadingOverview ? 'Loading sector data\u2026' : 'Sector data is unavailable right now.'}</p>
        {!isLoadingOverview && (
          <button onClick={() => refetchOverview()} className="mt-4 rounded-lg border border-slate-700 px-4 py-2 text-xs hover:bg-slate-800">Retry</button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 text-slate-200">
      {/* ─── 1. Header & Institutional Briefing Strip ───────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-950 border border-slate-800/80 p-6 shadow-2xl backdrop-blur-xl">
        <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />
        <div className="absolute bottom-0 left-1/3 w-80 h-80 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 rounded-full flex items-center gap-1.5">
                <Compass className="w-3 h-3 animate-spin text-cyan-400" style={{ animationDuration: '8s' }} />
                INSTITUTIONAL ROTATION · BREADTH · DERIVATIVES · ANALYST CALLS
              </span>
              <span className={cn(
                "px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest rounded-full border",
                marketRegime === 'BULL' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                marketRegime === 'BEAR' ? "bg-rose-500/10 text-rose-400 border-rose-500/20" :
                "bg-amber-500/10 text-amber-400 border-amber-500/20"
              )}>
                REGIME: {marketRegime}
              </span>
            </div>

            <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight flex items-center gap-3 font-display">
              Sector Intelligence Studio
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-sans font-medium border border-slate-700/50">
                12 Indian Sectors
              </span>
            </h1>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl">
              Cross-sectional sector rotation analysis, Relative Rotation Graph (RRG), constituent breadth momentum,
              options sentiment (PCR), and expert Indian market trading analyst stances.
            </p>
            <AsOfLine className="text-[10px] text-slate-500 mt-1" source="sector tables (screener_sector_rotation, sector_fo_sentiment, stock_ohlcv)" fetchedAt={overviewUpdatedAt} />
          </div>

          {/* Quick Metrics & Refresh */}
          <div className="flex items-center gap-3 shrink-0">
            {niftyBaseline && (
              <div className="bg-slate-850/80 border border-slate-800 rounded-xl px-3.5 py-2 text-right">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-wider font-display">NIFTY 50 BENCHMARK</p>
                <div className="flex items-center gap-2 justify-end">
                  <span className="text-sm font-black text-white">{niftyBaseline.value.toLocaleString('en-IN')}</span>
                  <span className={cn(
                    "text-xs font-bold",
                    niftyBaseline.changePct >= 0 ? "text-emerald-400" : "text-rose-400"
                  )}>
                    {niftyBaseline.changePct >= 0 ? '+' : ''}{niftyBaseline.changePct.toFixed(2)}%
                  </span>
                </div>
              </div>
            )}

            <button
              onClick={() => { refetchOverview(); refetchDeepDive(); }}
              disabled={isFetchingOverview}
              className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/50 transition-all shadow-lg active:scale-95 disabled:opacity-50"
              title="Refresh Sector Intelligence"
            >
              <RefreshCw className={cn("w-4 h-4", isFetchingOverview && "animate-spin text-cyan-400")} />
            </button>
          </div>
        </div>

        {/* Top KPI Quick Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-4 border-t border-slate-800/80">
          <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
              Top Gainer Today
            </span>
            <p className="text-base font-black text-white mt-1 truncate font-display">
              {topGainer?.name || '—'}
            </p>
            <span className="text-xs font-black text-emerald-400">
              +{topGainer?.changePct.toFixed(2)}%
            </span>
          </div>

          <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-cyan-400" />
              RRG Momentum Leader
            </span>
            <p className="text-base font-black text-white mt-1 truncate font-display">
              {topMomentum?.name || '—'}
            </p>
            <span className="text-xs font-bold text-cyan-400">
              RS Mom: {topMomentum?.rrg.rsMomentum}
            </span>
          </div>

          <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-violet-400" />
              Sectors in 'Leading'
            </span>
            <p className="text-base font-black text-white mt-1 font-display">
              {sectors.filter(s => s.rrg.quadrant === 'LEADING').length} of {sectors.length}
            </p>
            <span className="text-xs font-bold text-violet-400">
              {sectors.filter(s => s.rrg.quadrant === 'LEADING').map(s => s.name.replace('NIFTY ', '')).join(', ') || 'None'}
            </span>
          </div>

          <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800/60">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-amber-400" />
              Overweight Stances
            </span>
            <p className="text-base font-black text-white mt-1 font-display">
              {sectors.filter(s => s.analyst.stance === 'STRONG_OVERWEIGHT' || s.analyst.stance === 'ACCUMULATE_DIPS').length}
            </p>
            <span className="text-xs font-bold text-emerald-400">
              High Conviction Calls
            </span>
          </div>
        </div>
      </div>

      {/* ─── 2. Desk Navigation Switcher ────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 gap-4 overflow-x-auto">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('overview')}
            className={cn(
              "px-4 py-2 rounded-xl text-xs font-bold tracking-wide transition-all flex items-center gap-2 border",
              activeTab === 'overview'
                ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30 shadow-lg shadow-cyan-500/10"
                : "bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white hover:bg-slate-800"
            )}
          >
            <Compass className="w-4 h-4" />
            Executive Hub & Tactical Calls
          </button>

          <button
            onClick={() => setActiveTab('rotation')}
            className={cn(
              "px-4 py-2 rounded-xl text-xs font-bold tracking-wide transition-all flex items-center gap-2 border",
              activeTab === 'rotation'
                ? "bg-violet-500/10 text-violet-400 border-violet-500/30 shadow-lg shadow-violet-500/10"
                : "bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white hover:bg-slate-800"
            )}
          >
            <Activity className="w-4 h-4" />
            Sector Rotation & Money Flow
          </button>

          <button
            onClick={() => setActiveTab('derivatives')}
            className={cn(
              "px-4 py-2 rounded-xl text-xs font-bold tracking-wide transition-all flex items-center gap-2 border",
              activeTab === 'derivatives'
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 shadow-lg shadow-emerald-500/10"
                : "bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white hover:bg-slate-800"
            )}
          >
            <TrendingUp className="w-4 h-4" />
            Derivatives & F&O Desk
          </button>

          <button
            onClick={() => setActiveTab('deepdive')}
            className={cn(
              "px-4 py-2 rounded-xl text-xs font-bold tracking-wide transition-all flex items-center gap-2 border",
              activeTab === 'deepdive'
                ? "bg-amber-500/10 text-amber-400 border-amber-500/30 shadow-lg shadow-amber-500/10"
                : "bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white hover:bg-slate-800"
            )}
          >
            <Target className="w-4 h-4" />
            Sector Deep-Dive Studio
          </button>

          <button
            onClick={() => setActiveTab('intel')}
            className={cn(
              "px-4 py-2 rounded-xl text-xs font-bold tracking-wide transition-all flex items-center gap-2 border",
              activeTab === 'intel'
                ? "bg-sky-500/10 text-sky-400 border-sky-500/30 shadow-lg shadow-sky-500/10"
                : "bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white hover:bg-slate-800"
            )}
          >
            <Compass className="w-4 h-4" />
            RRG & Correlation
          </button>
        </div>

        {/* Global Search & Stance Filter */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search sector or stock..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-slate-900/80 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 w-48"
            />
          </div>

          <select
            value={stanceFilter}
            onChange={(e) => setStanceFilter(e.target.value)}
            className="bg-slate-900/80 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-cyan-500/50"
          >
            <option value="ALL">All Stances</option>
            <option value="STRONG_OVERWEIGHT">Strong Overweight</option>
            <option value="ACCUMULATE_DIPS">Accumulate Dips</option>
            <option value="NEUTRAL_SIDEWAYS">Neutral / Range</option>
            <option value="PROFIT_BOOKING">Profit Booking</option>
            <option value="UNDERWEIGHT">Underweight / Avoid</option>
          </select>
        </div>
      </div>

      {/* ─── 3. TAB 1: EXECUTIVE HUB & TACTICAL MATRIX ──────────────────────── */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Top Row: RRG Quadrant Chart + Multi-Period Return Leaderboard */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* RRG Quadrant */}
            <Card
              title="Relative Rotation Graph (RRG) vs NIFTY 50"
              icon={Compass}
              className="bg-slate-900/80 border-slate-800/80 backdrop-blur-xl"
            >
              <div className="p-2">
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-2 px-1">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" /> Leading (Strong RS + Mom)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-500" /> Weakening (Strong RS, Mom slows)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-rose-500" /> Lagging (Weak RS + Mom)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-cyan-500" /> Improving (Bottoming out)
                  </span>
                </div>

                <div className="h-80 w-full relative">
                  {/* Quadrant Background Watermarks */}
                  <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 pointer-events-none opacity-5">
                    <div className="bg-cyan-500 border-r border-b border-white" />
                    <div className="bg-emerald-500 border-b border-white" />
                    <div className="bg-rose-500 border-r border-white" />
                    <div className="bg-amber-500" />
                  </div>

                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 20, right: 25, bottom: 25, left: 10 }}>
                      <XAxis
                        type="number"
                        dataKey="x"
                        name="RS-Ratio"
                        domain={[90, 110]}
                        tick={{ fill: '#64748b', fontSize: 10 }}
                        label={{ value: 'Relative Strength Ratio (Benchmark = 100)', position: 'bottom', fill: '#64748b', fontSize: 10 }}
                      />
                      <YAxis
                        type="number"
                        dataKey="y"
                        name="RS-Momentum"
                        domain={[90, 110]}
                        tick={{ fill: '#64748b', fontSize: 10 }}
                        label={{ value: 'RS Momentum', angle: -90, position: 'left', fill: '#64748b', fontSize: 10 }}
                      />
                      <ReferenceLine x={100} stroke="#334155" strokeDasharray="3 3" />
                      <ReferenceLine y={100} stroke="#334155" strokeDasharray="3 3" />
                      <Tooltip
                        cursor={{ strokeDasharray: '3 3' }}
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null;
                          const data = payload[0].payload;
                          return (
                            <div className="bg-slate-900 border border-slate-700 p-2.5 rounded-xl shadow-xl text-xs space-y-1">
                              <p className="font-black text-white">{data.name}</p>
                              <p className="text-[11px] text-cyan-400">Quadrant: <span className="font-bold">{data.quadrant}</span></p>
                              <p className="text-[11px] text-slate-300">Stance: <span className="font-bold text-emerald-400">{data.stance}</span></p>
                              <p className="text-[10px] text-slate-400">RS Ratio: {data.x} | Momentum: {data.y}</p>
                              <p className="text-[10px] text-slate-500 italic pt-1 border-t border-slate-800">Click node to open Deep Dive</p>
                            </div>
                          );
                        }}
                      />
                      <Scatter
                        data={rrgData}
                        onClick={(entry: any) => {
                          const targetId = entry?.id || entry?.payload?.id;
                          if (targetId) {
                            setSelectedSectorId(targetId);
                            setActiveTab('deepdive');
                          }
                        }}
                        className="cursor-pointer"
                      >
                        {rrgData.map((entry, index) => {
                          let fill = '#10b981'; // leading
                          if (entry.quadrant === 'WEAKENING') fill = '#f59e0b';
                          else if (entry.quadrant === 'LAGGING') fill = '#f43f5e';
                          else if (entry.quadrant === 'IMPROVING') fill = '#06b6d4';
                          return <Cell key={`cell-${index}`} fill={fill} stroke="#ffffff" strokeWidth={1} r={7} />;
                        })}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </Card>

            {/* Multi-Timeframe Return Leaderboard */}
            <Card
              title="Sector Return Leaderboard vs Timeframe"
              icon={BarChart2}
              className="bg-slate-900/80 border-slate-800/80 backdrop-blur-xl"
            >
              <div className="p-2 space-y-3">
                {/* Timeframe Selector Pills */}
                <div className="flex items-center justify-between gap-2 px-1">
                  <span className="text-[11px] text-slate-400 font-medium">Select Period:</span>
                  <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
                    {(['1d', '5d', '1m', '3m', '6m', '1y'] as Timeframe[]).map((tf) => (
                      <button
                        key={tf}
                        onClick={() => setSelectedTimeframe(tf)}
                        className={cn(
                          "px-2.5 py-1 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all",
                          selectedTimeframe === tf
                            ? "bg-cyan-500 text-slate-950 shadow-md font-black"
                            : "text-slate-400 hover:text-white"
                        )}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Horizontal Bar Chart */}
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={timeframeBarData} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                      <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} unit="%" />
                      <YAxis dataKey="name" type="category" tick={{ fill: '#94a3b8', fontSize: 10 }} width={75} />
                      <ReferenceLine x={0} stroke="#475569" />
                      <Tooltip
                        formatter={(val: any) => [`${val}%`, 'Return']}
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '0.75rem', fontSize: '11px' }}
                      />
                      <Bar dataKey="returnPct" radius={[0, 4, 4, 0]}>
                        {timeframeBarData.map((entry, index) => (
                          <Cell key={`bar-${index}`} fill={entry.returnPct >= 0 ? '#10b981' : '#f43f5e'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </Card>
          </div>

          {/* Tactical Action Matrix Grid: Institutional Analyst Calls */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-black text-white tracking-tight flex items-center gap-2 font-display">
                  <Sparkles className="w-4 h-4 text-cyan-400" />
                  Tactical Action Matrix · Analyst Calls
                </h3>
                <p className="text-xs text-slate-400">
                  Institutional quantitative stance, breadth conviction, macro catalysts, and top constituent picks.
                </p>
              </div>

              <span className="text-xs text-slate-500">
                Showing {filteredSectors.length} of {sectors.length} sectors
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredSectors.map((sector) => {
                const stanceColor =
                  sector.analyst.stance === 'STRONG_OVERWEIGHT' ? 'emerald' :
                  sector.analyst.stance === 'ACCUMULATE_DIPS' ? 'cyan' :
                  sector.analyst.stance === 'PROFIT_BOOKING' ? 'amber' :
                  sector.analyst.stance === 'UNDERWEIGHT' ? 'rose' : 'slate';

                return (
                  <div
                    key={sector.id}
                    className="bg-slate-900/70 border border-slate-800/80 hover:border-slate-700/80 rounded-2xl p-5 shadow-xl transition-all hover:shadow-2xl hover:scale-[1.01] flex flex-col justify-between group"
                  >
                    <div>
                      {/* Card Header: Sector Name, Price & % Change */}
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-base font-black text-white group-hover:text-cyan-400 transition-colors font-display">
                              {sector.name}
                            </h4>
                            <span className="text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider bg-slate-800 text-slate-400 border border-slate-700/60">
                              {sector.benchmark} CORR
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-500 font-medium">
                            {sector.dbSector} · {sector.value ? `₹${sector.value.toLocaleString('en-IN')}` : 'Live Index'}
                          </span>
                        </div>

                        <div className="text-right">
                          <span className={cn(
                            "inline-flex items-center gap-1 text-sm font-black px-2.5 py-1 rounded-lg border",
                            sector.changePct >= 0
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                          )}>
                            {sector.changePct >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                            {sector.changePct >= 0 ? '+' : ''}{sector.changePct.toFixed(2)}%
                          </span>
                        </div>
                      </div>

                      {/* Stance & Action Call Pill */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className={cn(
                          "px-2.5 py-1 rounded-lg text-xs font-black uppercase tracking-wider flex items-center gap-1.5 border",
                          stanceColor === 'emerald' && "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
                          stanceColor === 'cyan' && "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
                          stanceColor === 'amber' && "bg-amber-500/10 text-amber-400 border-amber-500/30",
                          stanceColor === 'rose' && "bg-rose-500/10 text-rose-400 border-rose-500/30",
                          stanceColor === 'slate' && "bg-slate-800 text-slate-300 border-slate-700"
                        )}>
                          <Zap className="w-3 h-3" />
                          {sector.analyst.stanceLabel}
                        </span>

                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800/80 text-slate-400 border border-slate-700/40">
                          {sector.analyst.actionBadge}
                        </span>

                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800/80 text-slate-400 border border-slate-700/40 ml-auto">
                          {sector.analyst.horizon}
                        </span>
                      </div>

                      {/* Breadth & Screener Progress */}
                      <div className="space-y-1.5 mb-3 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/50 text-[11px]">
                        <div className="flex items-center justify-between text-slate-400">
                          <span>Constituent Breadth:</span>
                          <span className="font-bold text-white">
                            <span className="text-emerald-400">{sector.breadth.advances} Adv</span> / <span className="text-rose-400">{sector.breadth.declines} Dec</span> ({sector.breadth.advPct}%)
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden flex">
                          <div className="h-full bg-emerald-500" style={{ width: `${sector.breadth.advPct}%` }} />
                          <div className="h-full bg-rose-500" style={{ width: `${100 - sector.breadth.advPct}%` }} />
                        </div>

                        <div className="flex items-center justify-between text-slate-400 pt-1">
                          <span>Screener Net Score:</span>
                          <span className={cn(
                            "font-bold",
                            sector.screener.netScore >= 0 ? "text-emerald-400" : "text-rose-400"
                          )}>
                            {sector.screener.netScore > 0 ? '+' : ''}{sector.screener.netScore}
                          </span>
                        </div>
                      </div>

                      {/* Analyst Verdict */}
                      <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed mb-3">
                        {sector.analyst.verdict}
                      </p>

                      {/* Catalysts */}
                      <div className="flex flex-wrap gap-1 mb-3">
                        {sector.analyst.catalysts.slice(0, 2).map((cat, i) => (
                          <span key={i} className="text-[9px] font-medium px-2 py-0.5 rounded bg-slate-800/60 text-slate-400 border border-slate-700/40 truncate max-w-[200px]">
                            • {cat}
                          </span>
                        ))}
                      </div>

                      {/* Top Stock Picks */}
                      <div className="space-y-1 pt-2 border-t border-slate-800/80">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Top Stock Picks:</span>
                        <div className="grid grid-cols-3 gap-1.5">
                          {sector.analyst.topPicks.map((pick) => (
                            <button
                              key={pick.symbol}
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectStock?.(pick.symbol);
                              }}
                              className="px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-cyan-500/10 hover:border-cyan-500/30 text-left border border-slate-700/40 transition-all text-[10px] font-black text-cyan-300 truncate"
                            >
                              {pick.symbol}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Bottom Deep Dive Button */}
                    <button
                      onClick={() => {
                        setSelectedSectorId(sector.id);
                        setActiveTab('deepdive');
                      }}
                      className="mt-4 w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700/90 text-xs font-bold text-slate-200 hover:text-white transition-all flex items-center justify-center gap-1.5 border border-slate-700/50"
                    >
                      Open Deep-Dive Studio
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── 4. TAB 2: SECTOR ROTATION & MONEY FLOW ─────────────────────────── */}
      {activeTab === 'rotation' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Screener Net Momentum Table */}
            <div className="lg:col-span-2 space-y-4">
              <Card
                title="Screener Bull/Bear Momentum Flow"
                icon={Activity}
                className="bg-slate-900/80 border-slate-800/80"
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-800">
                        <th className="pb-3 font-bold uppercase tracking-wider">Sector</th>
                        <th className="pb-3 font-bold uppercase tracking-wider text-right">Bull Signals</th>
                        <th className="pb-3 font-bold uppercase tracking-wider text-right">Bear Signals</th>
                        <th className="pb-3 font-bold uppercase tracking-wider text-right">Net Score</th>
                        <th className="pb-3 font-bold uppercase tracking-wider text-right">Tier 1 Alerts</th>
                        <th className="pb-3 font-bold uppercase tracking-wider">Top Momentum Stocks</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {sectors.map((s) => (
                        <tr key={s.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 font-black text-white flex items-center gap-2">
                            {s.name}
                          </td>
                          <td className="py-3 text-right font-bold text-emerald-400">
                            {s.screener.bullCount}
                          </td>
                          <td className="py-3 text-right font-bold text-rose-400">
                            {s.screener.bearCount}
                          </td>
                          <td className="py-3 text-right">
                            <span className={cn(
                              "px-2 py-0.5 rounded font-black text-xs",
                              s.screener.netScore >= 0
                                ? "bg-emerald-500/10 text-emerald-400"
                                : "bg-rose-500/10 text-rose-400"
                            )}>
                              {s.screener.netScore > 0 ? '+' : ''}{s.screener.netScore}
                            </span>
                          </td>
                          <td className="py-3 text-right font-black text-cyan-400">
                            {s.screener.tier1Count}
                          </td>
                          <td className="py-3">
                            <div className="flex items-center gap-1">
                              {s.screener.topStocks.slice(0, 3).map((st) => (
                                <button
                                  key={st}
                                  onClick={() => onSelectStock?.(st)}
                                  className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 hover:bg-slate-700"
                                >
                                  {st}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>

            {/* Mutual Fund Institutional Allocations (AMFI) */}
            <div>
              <Card
                title="Mutual Fund (DII) Sector Allocations"
                icon={DollarSign}
                className="bg-slate-900/80 border-slate-800/80 h-full"
              >
                <div className="space-y-3 pt-1">
                  <p className="text-xs text-slate-400 leading-relaxed">
                    DII domestic mutual fund equity holding percentage. Institutional accumulation shifts historically lead price by 30–60 days.
                  </p>

                  <div className="space-y-2 mt-3">
                    {mfFlowsData && mfFlowsData.length > 0 ? (
                      mfFlowsData.slice(0, 8).map((mf: any, idx: number) => (
                        <div key={idx} className="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/60 text-xs">
                          <div>
                            <p className="font-black text-white">{mf.sector}</p>
                            <span className="text-[10px] text-slate-500 font-medium">₹{Number(mf.aum_cr).toLocaleString('en-IN')} Cr AUM</span>
                          </div>
                          <span className="font-black text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                            {Number(mf.aum_pct).toFixed(2)}%
                          </span>
                        </div>
                      ))
                    ) : (
                      sectors.slice(0, 6).map((s) => (
                        <div key={s.id} className="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/60 text-xs">
                          <div>
                            <p className="font-black text-white">{s.name}</p>
                            <span className="text-[10px] text-slate-500 font-medium">Institutional Focus</span>
                          </div>
                          <span className="font-black text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                            Active Flow
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* ─── 5. TAB 3: DERIVATIVES & F&O DESK ───────────────────────────────── */}
      {activeTab === 'derivatives' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Buildup Summary Cards */}
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4">
              <span className="text-[10px] font-black text-emerald-400 uppercase tracking-wider">LONG BUILDUP</span>
              <p className="text-xl font-black text-white mt-1">
                {sectors.filter(s => s.derivatives.buildup === 'LONG_BUILDUP').length} Sectors
              </p>
              <p className="text-xs text-emerald-300 mt-1">Price Up + Put Writing. Institutional longs being accumulated.</p>
            </div>

            <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-2xl p-4">
              <span className="text-[10px] font-black text-cyan-400 uppercase tracking-wider">SHORT COVERING</span>
              <p className="text-xl font-black text-white mt-1">
                {sectors.filter(s => s.derivatives.buildup === 'SHORT_COVERING').length} Sectors
              </p>
              <p className="text-xs text-cyan-300 mt-1">Price Up + Short covering squeeze. Rebound momentum.</p>
            </div>

            <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4">
              <span className="text-[10px] font-black text-rose-400 uppercase tracking-wider">SHORT BUILDUP</span>
              <p className="text-xl font-black text-white mt-1">
                {sectors.filter(s => s.derivatives.buildup === 'SHORT_BUILDUP').length} Sectors
              </p>
              <p className="text-xs text-rose-300 mt-1">Price Down + Call Writing. Bearish pressure dominating.</p>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
              <span className="text-[10px] font-black text-amber-400 uppercase tracking-wider">LONG UNWINDING</span>
              <p className="text-xl font-black text-white mt-1">
                {sectors.filter(s => s.derivatives.buildup === 'LONG_UNWINDING').length} Sectors
              </p>
              <p className="text-xs text-amber-300 mt-1">Price Down + Long liquidation. Profit booking in progress.</p>
            </div>
          </div>

          {/* Sector PCR & Open Interest Table */}
          <Card
            title="Sector F&O Sentiment & Put-Call Ratio (PCR) Matrix"
            icon={Target}
            className="bg-slate-900/80 border-slate-800/80"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-800">
                    <th className="pb-3 font-bold uppercase tracking-wider">Sector</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-right">Put-Call Ratio (PCR)</th>
                    <th className="pb-3 font-bold uppercase tracking-wider">F&O Buildup Type</th>
                    <th className="pb-3 font-bold uppercase tracking-wider">PCR Level</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-right">Total Call OI</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-right">Total Put OI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {sectors.map((s) => {
                    const pcr = s.derivatives.pcr ?? 0.85;
                    return (
                      <tr key={s.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3 font-black text-white">
                          {s.name}
                        </td>
                        <td className="py-3 text-right">
                          <span className={cn(
                            "px-2.5 py-1 rounded-lg font-black text-xs",
                            pcr >= 1.0 ? "bg-emerald-500/10 text-emerald-400" :
                            pcr <= 0.65 ? "bg-rose-500/10 text-rose-400" :
                            "bg-slate-800 text-slate-300"
                          )}>
                            {pcr.toFixed(2)}
                          </span>
                        </td>
                        <td className="py-3">
                          <span className={cn(
                            "text-[10px] font-black uppercase px-2 py-0.5 rounded border",
                            s.derivatives.buildup === 'LONG_BUILDUP' && "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
                            s.derivatives.buildup === 'SHORT_COVERING' && "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
                            s.derivatives.buildup === 'SHORT_BUILDUP' && "bg-rose-500/10 text-rose-400 border-rose-500/30",
                            s.derivatives.buildup === 'LONG_UNWINDING' && "bg-amber-500/10 text-amber-400 border-amber-500/30"
                          )}>
                            {s.derivatives.buildup?.replace('_', ' ') ?? '—'}
                          </span>
                        </td>
                        <td className="py-3">
                          <span className="font-bold text-xs text-slate-400"
                            title="Put/call ratio level. Not a direction: high PCR can be put writing or hedging.">
                            {s.derivatives.sentiment ? s.derivatives.sentiment.replace('PCR_', 'PCR ').toLowerCase() : '—'}
                          </span>
                        </td>
                        <td className="py-3 text-right font-medium text-slate-400">
                          {s.derivatives.callOi ? s.derivatives.callOi.toLocaleString('en-IN') : '—'}
                        </td>
                        <td className="py-3 text-right font-medium text-slate-400">
                          {s.derivatives.putOi ? s.derivatives.putOi.toLocaleString('en-IN') : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ─── 6. TAB 4: SECTOR DEEP-DIVE STUDIO ──────────────────────────────── */}
      {activeTab === 'deepdive' && (
        <div className="space-y-6">
          {/* Sector Horizontal Selector Strip */}
          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
            {sectors.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedSectorId(s.id)}
                className={cn(
                  "px-3.5 py-2 rounded-xl text-xs font-bold tracking-wide transition-all whitespace-nowrap flex items-center gap-2 border shrink-0",
                  selectedSectorId === s.id
                    ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40 shadow-lg shadow-cyan-500/10"
                    : "bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white hover:bg-slate-800"
                )}
              >
                <span>{s.name}</span>
                <span className={cn(
                  "text-[10px] font-black",
                  s.changePct >= 0 ? "text-emerald-400" : "text-rose-400"
                )}>
                  {s.changePct >= 0 ? '+' : ''}{s.changePct.toFixed(1)}%
                </span>
              </button>
            ))}
          </div>

          {/* Active Sector Banner */}
          {activeSector && (
            <div className="bg-slate-900/80 border border-slate-800/90 rounded-2xl p-6 shadow-2xl backdrop-blur-xl">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                      {activeSector.dbSector} SECTOR STUDIO
                    </span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                      BENCHMARK: {activeSector.benchmark}
                    </span>
                  </div>
                  <h2 className="text-2xl font-black text-white font-display flex items-center gap-3">
                    {activeSector.name}
                    <span className={cn(
                      "text-sm font-black px-2.5 py-0.5 rounded-lg border",
                      activeSector.changePct >= 0
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                        : "bg-rose-500/10 text-rose-400 border-rose-500/30"
                    )}>
                      {activeSector.changePct >= 0 ? '+' : ''}{activeSector.changePct.toFixed(2)}%
                    </span>
                  </h2>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleGenerateAiReport}
                    disabled={aiBriefingMutation.isPending}
                    className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white text-xs font-black tracking-wide shadow-lg shadow-cyan-500/20 transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {aiBriefingMutation.isPending ? 'Generating Analyst Briefing...' : 'Generate AI Trading Briefing'}
                  </button>
                </div>
              </div>

              {/* AI Report Card if generated */}
              {aiReport && (
                <div className="mt-4 p-4 rounded-xl bg-cyan-950/20 border border-cyan-500/30 text-xs space-y-2 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="font-black text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                      Expert Indian Market Analyst Verdict: {aiReport.verdict} ({aiReport.sentiment})
                    </span>
                    <span className="text-[10px] text-slate-500">{new Date(aiReport.generatedAt).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed font-medium">
                    {aiReport.analysis}
                  </p>
                </div>
              )}

              {/* Technical DMA Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-4 border-t border-slate-800">
                <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">30 / 50 DMA STATUS</span>
                  <p className="text-sm font-black text-white mt-0.5">
                    {deepDiveData?.dmaStats?.dma50 ? `₹${deepDiveData.dmaStats.dma50.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (50 DMA)` : 'Above Support'}
                  </p>
                  <span className="text-[10px] font-bold text-emerald-400">
                    {activeSector.technicals.pctAbove50}% Stocks Above 50 DMA
                  </span>
                </div>

                <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">200 DMA HEALTH</span>
                  <p className="text-sm font-black text-white mt-0.5">
                    {deepDiveData?.dmaStats?.dma200 ? `₹${deepDiveData.dmaStats.dma200.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (200 DMA)` : 'Bullish Base'}
                  </p>
                  <span className="text-[10px] font-bold text-emerald-400">
                    {activeSector.technicals.pctAbove200}% Stocks Above 200 DMA
                  </span>
                </div>

                <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">52-WEEK HIGH DISTANCE</span>
                  <p className="text-sm font-black text-white mt-0.5">
                    {deepDiveData?.dmaStats?.high52w ? `₹${deepDiveData.dmaStats.high52w.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : 'Near Highs'}
                  </p>
                  <span className="text-[10px] font-bold text-cyan-400">
                    Low: {deepDiveData?.dmaStats?.low52w ? `₹${deepDiveData.dmaStats.low52w.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : 'Strong Base'}
                  </span>
                </div>

                <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">GLOBAL MACRO CORRELATION</span>
                  <p className="text-sm font-black text-white mt-0.5">
                    {deepDiveData?.globalCorr ? `${deepDiveData.globalCorr.benchmark} (${deepDiveData.globalCorr.corr21d ? (deepDiveData.globalCorr.corr21d * 100).toFixed(0) : 45}% Corr)` : `${activeSector.benchmark} Driven`}
                  </p>
                  <span className="text-[10px] font-bold text-violet-400">
                    21-Day Rolling Sensitivity
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Turning Bullish vs Turning Bearish Real-Time Technical Alerts */}
          {deepDiveData?.trends && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card
                title={`Turning Bullish Setups (${deepDiveData.trends.bullish.length})`}
                icon={TrendingUp}
                className="bg-slate-900/80 border-slate-800/80"
              >
                <div className="space-y-2 pt-1">
                  {deepDiveData.trends.bullish.length > 0 ? (
                    deepDiveData.trends.bullish.slice(0, 6).map((st: any, i: number) => (
                      <div
                        key={i}
                        onClick={() => onSelectStock?.(st.sc_id || st.name)}
                        className="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800/60 transition-all cursor-pointer text-xs"
                      >
                        <div>
                          <p className="font-black text-white">{st.name || st.sc_id}</p>
                          <span className="text-[10px] text-slate-500">₹{st.currPrice || '—'}</span>
                        </div>
                        <span className="text-xs font-black text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                          {st.performance || '+Bullish'}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500 py-3 text-center">No immediate turning bullish crossovers today.</p>
                  )}
                </div>
              </Card>

              <Card
                title={`Turning Bearish Setups (${deepDiveData.trends.bearish.length})`}
                icon={TrendingDown}
                className="bg-slate-900/80 border-slate-800/80"
              >
                <div className="space-y-2 pt-1">
                  {deepDiveData.trends.bearish.length > 0 ? (
                    deepDiveData.trends.bearish.slice(0, 6).map((st: any, i: number) => (
                      <div
                        key={i}
                        onClick={() => onSelectStock?.(st.sc_id || st.name)}
                        className="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800/60 transition-all cursor-pointer text-xs"
                      >
                        <div>
                          <p className="font-black text-white">{st.name || st.sc_id}</p>
                          <span className="text-[10px] text-slate-500">₹{st.currPrice || '—'}</span>
                        </div>
                        <span className="text-xs font-black text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                          {st.performance || '-Bearish'}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500 py-3 text-center">No immediate turning bearish breakdowns today.</p>
                  )}
                </div>
              </Card>
            </div>
          )}

          {/* Complete Constituent Stocks Screener Table */}
          <Card
            title={`Constituent Stocks Screener (${deepDiveData?.constituents?.length || 0} Stocks)`}
            icon={Layers}
            className="bg-slate-900/80 border-slate-800/80"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-800">
                    <th className="pb-3 font-bold uppercase tracking-wider">Symbol</th>
                    <th className="pb-3 font-bold uppercase tracking-wider">Company Name</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-right">CMP (₹)</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-right">Change (%)</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-right">Market Cap</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-right">P/E Ratio</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-center">Trend</th>
                    <th className="pb-3 font-bold uppercase tracking-wider text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {deepDiveData?.constituents && deepDiveData.constituents.length > 0 ? (
                    deepDiveData.constituents.map((stock: any) => (
                      <tr
                        key={stock.symbol}
                        onClick={() => onSelectStock?.(stock.symbol)}
                        className="hover:bg-slate-800/40 transition-colors cursor-pointer group"
                      >
                        <td className="py-3 font-black text-cyan-300 group-hover:text-cyan-400">
                          {stock.symbol}
                        </td>
                        <td className="py-3 font-medium text-slate-300 max-w-xs truncate">
                          {stock.name}
                        </td>
                        <td className="py-3 text-right font-black text-white">
                          ₹{stock.price ? stock.price.toLocaleString('en-IN') : '—'}
                        </td>
                        <td className="py-3 text-right">
                          <span className={cn(
                            "px-2 py-0.5 rounded font-black text-xs",
                            stock.changePct >= 0 ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"
                          )}>
                            {stock.changePct >= 0 ? '+' : ''}{stock.changePct.toFixed(2)}%
                          </span>
                        </td>
                        <td className="py-3 text-right font-medium text-slate-400">
                          {stock.marketCap}
                        </td>
                        <td className="py-3 text-right font-medium text-slate-400">
                          {stock.pe ? stock.pe.toFixed(1) : '—'}
                        </td>
                        <td className="py-3 text-center">
                          <span className={cn(
                            "text-[10px] font-bold px-2 py-0.5 rounded",
                            stock.technicalTrend === 'Bullish' ? "bg-emerald-500/10 text-emerald-400" :
                            stock.technicalTrend === 'Bearish' ? "bg-rose-500/10 text-rose-400" :
                            "bg-slate-800 text-slate-400"
                          )}>
                            {stock.technicalTrend}
                          </span>
                        </td>
                        <td className="py-3 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectStock?.(stock.symbol);
                            }}
                            className="px-2 py-1 rounded bg-slate-800 hover:bg-cyan-500 hover:text-slate-950 text-[10px] font-bold text-slate-300 transition-all"
                          >
                            Analyze
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-500">
                        Loading constituent stocks...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {activeTab === 'intel' && (
        <div className="bsi-intel-panel min-w-0">
          <SectorIntelTab />
        </div>
      )}
    </div>
  );
};

export default SectorIntelligencePage;
