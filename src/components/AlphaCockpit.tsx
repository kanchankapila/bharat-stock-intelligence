import { useState, useMemo, useEffect } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  TrendingUp, TrendingDown, Shield, Zap, Star, Activity,
  ChevronUp, ChevronDown, AlertTriangle, Users, BarChart2,
  Clock, ArrowUpRight, ArrowDownRight, Percent, Info,
  DollarSign, Sliders, Database, CheckCircle2, Target,
  ShieldAlert, Scale, RefreshCw, Layers, Calendar
} from 'lucide-react';
import { formatISTWithLocal, relativeFromNow } from '../lib/timeFormat';
import { CanonicalBadge } from './CanonicalSourceNote';
import { V4QuickNav } from '../v4/components/V4QuickNav';

// ─── Style Maps ───────────────────────────────────────────────────────────────

const CONVICTION_STYLES = {
  S_ELITE:  { label: 'S-Elite', bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', text: 'text-emerald-400', barColor: 'bg-emerald-500' },
  A_HIGH:   { label: 'A-High', bg: 'bg-sky-500/10 border-sky-500/30 text-sky-400', text: 'text-sky-400', barColor: 'bg-sky-500' },
  B_MEDIUM: { label: 'B-Medium', bg: 'bg-amber-500/10 border-amber-500/20 text-amber-400', text: 'text-amber-400', barColor: 'bg-amber-500' },
  C_LOW:    { label: 'C-Low', bg: 'bg-slate-700/20 border-slate-600/30 text-slate-400', text: 'text-slate-400', barColor: 'bg-slate-500' },
  D_MARGINAL: { label: 'D-Marginal', bg: 'bg-rose-500/10 border-rose-500/20 text-rose-400', text: 'text-rose-400', barColor: 'bg-rose-500' }
} as const;

const CLASSIFICATION_COLORS: Record<string, string> = {
  'Strong Buy': 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  'Buy': 'bg-teal-500/20 text-teal-300 border-teal-500/30',
  'Hold': 'bg-slate-800 text-slate-300 border-slate-700',
  'Avoid': 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  'Sell': 'bg-rose-500/20 text-rose-300 border-rose-500/30'
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatPct = (v: number | null | undefined, decimals = 2) => {
  if (v == null || isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`;
};

const formatAmount = (v: number | null | undefined) => {
  if (v == null || isNaN(v)) return '—';
  if (v >= 100) return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  return `₹${v.toFixed(2)}`;
};

// Read side of the trade journal — saveSignalAction (below) could already log a trade, but
// getSignalActions (the user's own history + win-rate) was never called anywhere.
const TradeJournalPanel: React.FC = () => {
  const { data, isLoading, isError } = trpc.getSignalActions.useQuery({ limit: 25 });
  const actions = data?.actions ?? [];
  const stats = data?.stats;

  if (isError) return null; // not signed in, or a real failure — either way, nothing to show
  return (
    <div className="v1-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-black text-slate-300 font-display uppercase tracking-widest">My Trade Journal</h3>
        {stats && stats.totalCount > 0 && (
          <span className="text-[10px] font-data text-slate-400">
            {stats.winRate}% win rate · ₹{stats.totalPnl.toFixed(0)} P&amp;L over {stats.totalCount} closed
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="text-xs text-slate-500 py-4">Loading…</div>
      ) : actions.length === 0 ? (
        <div className="text-xs text-slate-500 py-4">No logged trade actions yet — use "LOG EXECUTE BUY" above to start one.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[9px] text-slate-500 font-display uppercase tracking-wider">
                <th className="text-left px-2 py-1.5 font-medium">Symbol</th>
                <th className="text-left px-2 py-1.5 font-medium">Action</th>
                <th className="text-right px-2 py-1.5 font-medium">Entry</th>
                <th className="text-right px-2 py-1.5 font-medium">P&amp;L</th>
                <th className="text-right px-2 py-1.5 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {actions.map((a: any) => (
                <tr key={a.id}>
                  <td className="px-2 py-1.5 font-bold text-slate-200">{a.symbol}</td>
                  <td className={cn("px-2 py-1.5 font-medium", a.action_type === 'BUY' ? "text-emerald-400" : "text-slate-400")}>{a.action_type}</td>
                  <td className="px-2 py-1.5 text-right font-data text-slate-300">{a.entry_actual ?? a.entry_price_rec ?? '—'}</td>
                  <td className={cn("px-2 py-1.5 text-right font-data", (a.pnl ?? 0) > 0 ? "text-emerald-400" : (a.pnl ?? 0) < 0 ? "text-rose-400" : "text-slate-500")}>
                    {a.pnl != null ? a.pnl.toFixed(2) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-data text-slate-500">{a.executed_at ? new Date(a.executed_at).toLocaleDateString('en-IN') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export const AlphaCockpit: React.FC = () => {
  // Navigation & Filtering States
  const [conviction, setConviction] = useState<'ALL' | 'S_ELITE' | 'A_HIGH' | 'B_MEDIUM'>('ALL');
  const [horizon, setHorizon] = useState<'ALL' | 'intraday' | 'swing' | 'long_term'>('ALL');
  const [selectedSector, setSelectedSector] = useState<string>('ALL');

  // Trade Simulator States
  const [simulatorCapital, setSimulatorCapital] = useState<number>(100000);
  const [simulatorRiskPct, setSimulatorRiskPct] = useState<number>(1);
  const [simulatorTargetType, setSimulatorTargetType] = useState<'target_1' | 'target_2'>('target_1');
  const [actionNotes, setActionNotes] = useState<string>('');

  // Selected Stock Symbol
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null);

  // Status Alerts
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Queries
  const { data: recommendationsData, isLoading: recommendationsLoading, refetch: refetchPicks, dataUpdatedAt } =
    trpc.getBuyRecommendations.useQuery({
      conviction,
      horizon,
      limit: 100
    }, { refetchInterval: 3 * 60_000, refetchOnWindowFocus: true });

  // Standardized on days:10 (2026-08-02 perf pass) -- matches every other current-flow caller
  // of getFiiDiiFlow so React Query shares one cache entry instead of a per-component variant;
  // only fiiDiiData[0] (the latest row) is used below.
  const { data: fiiDiiData } = trpc.getFiiDiiFlow.useQuery({ days: 10 }, { refetchInterval: 5 * 60_000 });
  const { data: signalStats } = trpc.getSignalQualityReport.useQuery({ horizonDays: 15 }, { refetchInterval: 10 * 60_000 });

  // Mutations
  const logActionMutation = trpc.saveSignalAction.useMutation({
    onSuccess: () => {
      showToast('Trade action logged successfully to the database!', 'success');
      setActionNotes('');
    },
    onError: (err) => {
      showToast(`Failed to log trade action: ${err.message}`, 'error');
    }
  });

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  };

  // Sector List Extraction
  const sectorList = useMemo(() => {
    if (!recommendationsData?.picks) return [];
    const sectors = recommendationsData.picks
      .map((p: any) => p.sector)
      .filter((s: string): s is string => !!s);
    return ['ALL', ...Array.from(new Set(sectors))].sort();
  }, [recommendationsData]);

  // Filtered Picks
  const filteredPicks = useMemo(() => {
    if (!recommendationsData?.picks) return [];
    return recommendationsData.picks.filter((p: any) => {
      if (selectedSector !== 'ALL' && p.sector !== selectedSector) return false;
      return true;
    });
  }, [recommendationsData, selectedSector]);

  // Selected Pick
  const selectedPick = useMemo(() => {
    if (!filteredPicks || filteredPicks.length === 0) return null;
    if (activeSymbol) {
      const found = filteredPicks.find((p: any) => p.symbol === activeSymbol);
      if (found) return found;
    }
    return filteredPicks[0];
  }, [filteredPicks, activeSymbol]);

  // Auto-select first stock when list reloads
  useEffect(() => {
    if (filteredPicks.length > 0 && !activeSymbol) {
      setActiveSymbol(filteredPicks[0].symbol);
    }
  }, [filteredPicks]);

  // Calibration statistics for the active symbol's main signal type
  const matchedCalibration = useMemo(() => {
    if (!selectedPick || !signalStats?.bySignalType) return null;
    const sigType = selectedPick.signal_type || 'CONFLUENCE';
    return signalStats.bySignalType.find((s: any) => 
      s.signal_type?.toUpperCase() === sigType.toUpperCase()
    );
  }, [selectedPick, signalStats]);

  // Macro Regime Indicators
  const regime = useMemo(() => {
    const raw = recommendationsData?.regime;
    if (typeof raw === 'string') {
      return { name: raw, confidence: 0.7 };
    }
    if (raw && typeof raw === 'object') {
      const r = raw as any;
      return {
        name: r.name || 'BULL',
        confidence: r.confidence || 0.7
      };
    }
    return { name: 'BULL', confidence: 0.7 };
  }, [recommendationsData]);

  // FII / DII net flow calculation
  const latestFlow = useMemo(() => {
    if (!fiiDiiData || fiiDiiData.length === 0) return null;
    return fiiDiiData[0];
  }, [fiiDiiData]);

  // Position Sizing Calculations
  const calculatorResults = useMemo(() => {
    if (!selectedPick) return null;
    const cmp = selectedPick.livePrice || selectedPick.cmp || 0;
    const sl = selectedPick.stop_loss || 0;
    const targetPrice = selectedPick[simulatorTargetType] || 0;

    if (cmp <= 0 || sl <= 0 || sl >= cmp) {
      return { isValid: false, reason: sl >= cmp ? 'Stop Loss must be below Entry price' : 'Invalid prices' };
    }

    const riskAmount = simulatorCapital * (simulatorRiskPct / 100);
    const stopLossDiff = cmp - sl;
    const sharesToBuy = Math.floor(riskAmount / stopLossDiff);
    const totalRequiredCapital = sharesToBuy * cmp;

    if (sharesToBuy <= 0) {
      return { isValid: false, reason: 'Risk budget is too small to buy even 1 share.' };
    }

    const actualLoss = sharesToBuy * stopLossDiff;
    const targetDiff = targetPrice - cmp;
    const potentialProfit = sharesToBuy * targetDiff;
    const riskRewardRatio = targetDiff / stopLossDiff;

    return {
      isValid: true,
      sharesToBuy,
      totalRequiredCapital,
      riskAmount: actualLoss,
      potentialProfit,
      riskRewardRatio,
      leverageExceeded: totalRequiredCapital > simulatorCapital,
    };
  }, [selectedPick, simulatorCapital, simulatorRiskPct, simulatorTargetType]);

  // Execute logger submission
  const handleLogExecution = (actionType: 'BUY' | 'SKIP' | 'HOLD' | 'SELL') => {
    if (!selectedPick) return;

    // Get recommended entry (mid of entry low/high)
    const entryLow = selectedPick.entry_zone_low || selectedPick.livePrice || selectedPick.cmp;
    const entryHigh = selectedPick.entry_zone_high || selectedPick.livePrice || selectedPick.cmp;
    const entryRec = (entryLow + entryHigh) / 2;

    logActionMutation.mutate({
      signalId: selectedPick.id || 9999, // default indicator ID if recommendation lacks a unique PK
      signalSource: 'quant',
      symbol: selectedPick.symbol,
      actionType,
      quantity: calculatorResults?.isValid ? calculatorResults.sharesToBuy : undefined,
      entryPriceRec: entryRec,
      entryActual: selectedPick.livePrice || selectedPick.cmp,
      targetPriceRec: selectedPick[simulatorTargetType] || selectedPick.target_1,
      notes: actionNotes || `Logged from Alpha Cockpit. Allocation: ₹${simulatorCapital.toLocaleString()}.`
    });
  };

  // Thermometer percentage helper
  const getThermomPosition = (cmp: number, sl: number, entryLow: number, target: number) => {
    if (cmp <= sl) return 0;
    if (cmp >= target) return 100;
    const range = target - sl;
    const relative = cmp - sl;
    return Math.round((relative / range) * 100);
  };

  const getEntryRangePercentage = (sl: number, entryLow: number, entryHigh: number, target: number) => {
    const range = target - sl;
    if (range <= 0) return { start: 20, end: 40 };
    const start = ((entryLow - sl) / range) * 100;
    const end = ((entryHigh - sl) / range) * 100;
    return {
      start: Math.max(0, Math.min(95, Math.round(start))),
      end: Math.max(5, Math.min(100, Math.round(end)))
    };
  };

  return (
    <div className="space-y-6 select-none font-sans">
      <V4QuickNav />

      {/* Toast Alert */}
      {toast && (
        <div className={cn(
          "fixed bottom-6 right-6 z-50 p-4 rounded-xl border shadow-2xl flex items-center gap-3 backdrop-blur-md max-w-sm animate-bounce",
          toast.type === 'success' 
            ? "bg-emerald-950/90 border-emerald-500/40 text-emerald-300"
            : "bg-rose-950/90 border-rose-500/40 text-rose-300"
        )}>
          <CheckCircle2 className={cn("w-5 h-5 shrink-0", toast.type === 'success' ? "text-emerald-400" : "text-rose-400")} />
          <span className="text-xs font-bold font-data">{toast.message}</span>
        </div>
      )}

      {/* Header Banner */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600/20 border border-indigo-500/30 rounded-xl flex items-center justify-center shadow-lg">
              <Zap className="w-5 h-5 text-indigo-400 fill-indigo-400/20" />
            </div>
            <div>
              <h1 className="v1-title-page flex items-center gap-2">
                Quant Alpha Cockpit
                <CanonicalBadge />
              </h1>
              <p className="text-[10px] text-slate-400 font-data font-bold tracking-widest uppercase mt-0.5">
                Phase 3 Decision Authority & Execution Router
              </p>
              {recommendationsData?.lastComputedAt && (
                <p className="text-[9px] text-slate-500 font-data mt-1 normal-case tracking-normal">
                  Model run {formatISTWithLocal(recommendationsData.lastComputedAt)}
                  {dataUpdatedAt > 0 && <span className="ml-1.5 text-slate-600">· fetched {relativeFromNow(dataUpdatedAt)}</span>}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Global Macro Overlay */}
        <div className="flex flex-wrap items-center gap-4">
          {/* Regime Detector */}
          <div className={cn(regime.name === 'BULL' ? 'v1-card-up' : regime.name === 'BEAR' ? 'v1-card-down' : 'v1-card-neutral', 'px-4 py-2 flex items-center gap-3')}>
            <Sliders className="w-4 h-4 text-indigo-400" />
            <div>
              <span className="text-[8px] text-slate-500 font-data block font-bold font-display uppercase tracking-widest">Nifty Regime</span>
              <span className="text-xs font-black text-slate-200 flex items-center gap-1.5 font-data">
                <span className={cn(
                  "inline-block w-2 h-2 rounded-full",
                  regime.name === 'BULL' ? "bg-emerald-500" : regime.name === 'BEAR' ? "bg-rose-500" : "bg-sky-500"
                )} />
                {regime.name} ({Math.round(regime.confidence * 100)}%)
              </span>
            </div>
          </div>

          {/* FII/DII Smart Money Flows */}
          {latestFlow && (
            <div className={cn(latestFlow.fii_net == null ? 'v1-card-neutral' : latestFlow.fii_net >= 0 ? 'v1-card-up' : 'v1-card-down', 'px-4 py-2 flex items-center gap-3')}>
              <Users className="w-4 h-4 text-sky-400" />
              <div>
                <span className="text-[8px] text-slate-500 font-data block font-bold font-display uppercase tracking-widest">FII Net Flow (Daily)</span>
                <span className={cn("text-xs font-black font-data", latestFlow.fii_net == null ? "text-slate-500" : latestFlow.fii_net >= 0 ? "text-emerald-400" : "text-rose-400")}>
                  {latestFlow.fii_net == null ? '—' : `${latestFlow.fii_net >= 0 ? 'Buy +' : 'Sell '}₹${Math.abs(latestFlow.fii_net).toFixed(0)} Cr`}
                </span>
              </div>
            </div>
          )}

          {/* Refresh Button */}
          <button
            onClick={() => { refetchPicks(); showToast('Recalculating score updates...', 'success'); }}
            className="v1-btn-icon"
            title="Refresh Picks"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Panel Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        
        {/* Left Column: Stock Selection List (5 Cols) */}
        <div className="xl:col-span-4 space-y-4">
          <div className="v1-card p-4 space-y-4">
            <div className="flex justify-between items-center border-b border-slate-800/80 pb-3">
              <h2 className="text-xs font-black uppercase text-slate-300 tracking-wider flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-indigo-400" />
                Alpha Ranking Picks ({filteredPicks.length})
              </h2>
            </div>

            {/* Quick Filters */}
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div>
                <label className="text-slate-500 font-bold uppercase block mb-1">Conviction</label>
                <select 
                  value={conviction} 
                  onChange={(e) => setConviction(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-300 px-2 py-1.5 rounded-lg outline-none cursor-pointer focus:border-indigo-500/50 font-bold"
                >
                  <option value="ALL">All Levels</option>
                  <option value="S_ELITE">S-Elite Only</option>
                  <option value="A_HIGH">A-High & Better</option>
                  <option value="B_MEDIUM">B-Medium & Better</option>
                </select>
              </div>

              <div>
                <label className="text-slate-500 font-bold uppercase block mb-1">Time Horizon</label>
                <select 
                  value={horizon} 
                  onChange={(e) => setHorizon(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-300 px-2 py-1.5 rounded-lg outline-none cursor-pointer focus:border-indigo-500/50 font-bold"
                >
                  <option value="ALL">All Horizons</option>
                  <option value="intraday">Intraday</option>
                  <option value="swing">Swing</option>
                  <option value="long_term">Long-Term</option>
                </select>
              </div>

              <div className="col-span-2">
                <label className="text-slate-500 font-bold uppercase block mb-1">Sector Filter</label>
                <select 
                  value={selectedSector} 
                  onChange={(e) => setSelectedSector(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-300 px-2 py-1.5 rounded-lg outline-none cursor-pointer focus:border-indigo-500/50 font-bold"
                >
                  {sectorList.map(sec => (
                    <option key={sec} value={sec}>{sec === 'ALL' ? 'All Sectors' : sec}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* List */}
            {recommendationsLoading ? (
              <div className="py-20 flex flex-col items-center justify-center">
                <RefreshCw className="w-8 h-8 text-indigo-500/40 animate-spin mb-4" />
                <p className="text-[10px] text-slate-400 font-bold tracking-widest uppercase font-data animate-pulse">Running Rank Engine...</p>
              </div>
            ) : filteredPicks.length === 0 ? (
              <div className="py-20 text-center bg-slate-950/20 border border-slate-900 rounded-xl">
                <AlertTriangle className="w-8 h-8 text-amber-500/30 mx-auto mb-3" />
                <p className="text-xs text-slate-400 font-bold uppercase">No Confluent Signals Found</p>
                <p className="text-[9px] text-slate-500 mt-1">Try loosening your filter constraints</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[450px] overflow-y-auto pr-1 terminal-scrollbar">
                {filteredPicks.map((p: any) => {
                  const isActive = selectedPick?.symbol === p.symbol;
                  const scoreColor = p.unified_score >= 80 ? 'text-emerald-400' : p.unified_score >= 60 ? 'text-sky-400' : 'text-slate-400';
                  const style = CONVICTION_STYLES[p.conviction_level as keyof typeof CONVICTION_STYLES] || CONVICTION_STYLES.B_MEDIUM;
                  return (
                    <div
                      key={p.symbol}
                      onClick={() => setActiveSymbol(p.symbol)}
                      className={cn(
                        "p-3 rounded-xl border transition-all cursor-pointer flex justify-between items-center group select-none relative overflow-hidden",
                        isActive
                          ? "bg-slate-800/80 border-indigo-500/60 shadow-[0_0_15px_rgba(99,102,241,0.15)] text-slate-100"
                          : "bg-slate-950/30 border-slate-850 hover:bg-slate-900/40 text-slate-300"
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-sm italic tracking-tight font-data">{p.symbol}</span>
                          <span className={cn("v1-badge text-[8px] uppercase tracking-wider", style.bg)}>
                            {style.label}
                          </span>
                        </div>
                        <p className="text-[9px] text-slate-500 font-data mt-0.5 truncate">{p.sector || 'Uncategorized'}</p>
                      </div>

                      <div className="text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <span className="text-[9px] text-slate-500 font-data font-bold uppercase">Score</span>
                          <span className={cn("font-black text-sm font-data", scoreColor)}>{Math.round(p.unified_score)}</span>
                        </div>
                        <div className="text-[8px] text-slate-500 font-data mt-0.5 font-display uppercase tracking-wide">
                          ₹{p.livePrice?.toFixed(0) || p.cmp?.toFixed(0) || '—'}
                          <span className={cn("ml-1 font-bold", p.changePercent == null ? "text-slate-500" : p.changePercent >= 0 ? "text-emerald-500" : "text-rose-500")}>
                            {formatPct(p.changePercent, 1)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick Statistics Summary */}
          <div className="bg-gradient-to-br from-indigo-950/20 to-slate-900/40 border border-slate-800/50 p-4 rounded-2xl flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-[8px] text-slate-400 font-bold font-display uppercase tracking-widest font-data">Platform Accuracy</span>
              <div className="text-2xl font-black text-slate-200 font-data italic">
                {signalStats?.recommendationStats?.wins && signalStats?.recommendationStats?.total ? (
                  `${Math.round((signalStats.recommendationStats.wins / signalStats.recommendationStats.total) * 100)}%`
                ) : '—'}
              </div>
              <p className="text-[8px] text-slate-500 font-semibold font-data">Win rate on computed exits</p>
            </div>
            <div className="h-10 w-px bg-slate-800" />
            <div className="space-y-1 text-right">
              <span className="text-[8px] text-slate-400 font-bold font-display uppercase tracking-widest font-data">Total Recommendations</span>
              <div className="text-2xl font-black text-indigo-400 font-data italic">
                {signalStats?.recommendationStats?.total || '—'}
              </div>
              <p className="text-[8px] text-slate-500 font-semibold font-data">Active tracking database</p>
            </div>
          </div>
        </div>

        {/* Right Columns: Focus Stock Details, Decision Cards, Simulator (8 Cols) */}
        <div className="xl:col-span-8 space-y-6">
          {selectedPick ? (
            <>
              {/* Profile Card & Scoring Breakdowns */}
              <div className="v1-card p-6 space-y-6">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800/80 pb-4 gap-3">
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-2xl font-black text-slate-100 tracking-tighter font-data uppercase">{selectedPick.symbol}</h2>
                      <span className={cn(
                        "v1-badge font-display uppercase tracking-widest font-data",
                        CLASSIFICATION_COLORS[selectedPick.classification] || 'bg-slate-800 border-slate-700 text-slate-300'
                      )}>
                        {selectedPick.classification}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 font-bold mt-1 font-data font-display uppercase tracking-widest">
                      {selectedPick.sector} • {selectedPick.timeframe?.replace('_', ' ') || 'SWING'} Setup
                    </p>
                  </div>

                  <div className="text-left sm:text-right">
                    <span className="text-[9px] text-slate-500 font-bold block font-display uppercase tracking-widest font-data">Current Price</span>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-black text-slate-200 font-data">
                        {formatAmount(selectedPick.livePrice || selectedPick.cmp)}
                      </span>
                      <span className={cn("text-xs font-bold font-data", selectedPick.changePercent == null ? "text-slate-500" : selectedPick.changePercent >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {formatPct(selectedPick.changePercent)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Score Matrix Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  
                  {/* Unified Score */}
                  <div className="v1-stat-pill p-3 justify-between">
                    <span className="text-[9px] text-slate-500 font-bold font-display uppercase tracking-wider block font-data">Unified Score</span>
                    <div className="flex items-baseline justify-between mt-2">
                      <span className="text-xl font-black text-slate-200 font-data">{Math.round(selectedPick.unified_score)}</span>
                      <span className="text-[8px] text-slate-500 font-semibold font-data">/ 100</span>
                    </div>
                    <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden">
                      <div className="h-full bg-indigo-500" style={{ width: `${selectedPick.unified_score}%` }} />
                    </div>
                  </div>

                  {/* ML Ensemble Score */}
                  <div className="v1-stat-pill p-3 justify-between">
                    <span className="text-[9px] text-slate-500 font-bold font-display uppercase tracking-wider block font-data">ML Ensemble</span>
                    <div className="flex items-baseline justify-between mt-2">
                      <span className="text-xl font-black text-indigo-300 font-data">
                        {selectedPick.ml_score != null ? Math.round(selectedPick.ml_score) : '—'}
                      </span>
                      <span className="text-[8px] text-slate-500 font-semibold font-data">/ 100</span>
                    </div>
                    <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden">
                      <div className="h-full bg-indigo-400" style={{ width: `${selectedPick.ml_score || 0}%` }} />
                    </div>
                  </div>

                  {/* Deep Learning Score */}
                  <div className="v1-stat-pill p-3 justify-between">
                    <span className="text-[9px] text-slate-500 font-bold font-display uppercase tracking-wider block font-data">Deep Learning</span>
                    <div className="flex items-baseline justify-between mt-2">
                      <span className="text-xl font-black text-sky-300 font-data">
                        {selectedPick.dl_score != null ? Math.round(selectedPick.dl_score) : '—'}
                      </span>
                      <span className="text-[8px] text-slate-500 font-semibold font-data">/ 100</span>
                    </div>
                    <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden">
                      <div className="h-full bg-sky-400" style={{ width: `${selectedPick.dl_score || 0}%` }} />
                    </div>
                  </div>

                  {/* Screener Confluence */}
                  <div className="v1-stat-pill p-3 justify-between">
                    <span className="text-[9px] text-slate-500 font-bold font-display uppercase tracking-wider block font-data">Confluence Count</span>
                    <div className="flex items-baseline justify-between mt-2">
                      <span className="text-xl font-black text-teal-300 font-data">
                        {selectedPick.bullish_screener_count || '—'}
                      </span>
                      <span className="text-[8px] text-slate-500 font-semibold font-data">Bullish</span>
                    </div>
                    <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden">
                      <div className="h-full bg-teal-400" style={{ width: `${Math.min(10, selectedPick.bullish_screener_count || 0) * 10}%` }} />
                    </div>
                  </div>
                </div>

                {/* Score breakdown pillars */}
                {selectedPick.fundamental_score != null || selectedPick.technical_score != null || selectedPick.confluence_score != null ? (
                  <div className="bg-slate-950/20 border border-slate-850/50 p-4 rounded-xl space-y-3">
                    <span className="text-[9px] text-slate-400 font-bold font-display uppercase tracking-widest block font-data">Pillar Analysis Ranks</span>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {selectedPick.technical_score != null && (
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-500 font-medium">Technical Rank:</span>
                          <span className="font-bold text-slate-200 font-data">{selectedPick.technical_score.toFixed(1)}%</span>
                        </div>
                      )}
                      {selectedPick.fundamental_score != null && (
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-500 font-medium">Fundamental Rank:</span>
                          <span className="font-bold text-slate-200 font-data">{selectedPick.fundamental_score.toFixed(1)}%</span>
                        </div>
                      )}
                      {selectedPick.confluence_score != null && (
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-500 font-medium">Confluence Rank:</span>
                          <span className="font-bold text-slate-200 font-data">{selectedPick.confluence_score.toFixed(1)}%</span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}

                {/* Decisive Trade Levels & Horizontal Thermometer */}
                <div className="border-t border-slate-850 pt-4 space-y-4">
                  <h3 className="text-xs font-black uppercase text-slate-300 tracking-wider flex items-center gap-2">
                    <Target className="w-4 h-4 text-indigo-400" />
                    Decisive Entry & Execution Levels
                  </h3>

                  {/* Level Cards */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    
                    {/* Entry Range */}
                    <div className="v1-stat-pill p-3 text-center items-center">
                      <span className="text-[8px] text-slate-500 font-data font-bold font-display uppercase tracking-wider block">Recommended Entry</span>
                      <span className="text-sm font-black text-slate-100 font-data block mt-1.5">
                        {selectedPick.entry_zone_low ? `₹${selectedPick.entry_zone_low.toFixed(0)}` : '—'}
                        {selectedPick.entry_zone_high && selectedPick.entry_zone_high !== selectedPick.entry_zone_low ? ` - ₹${selectedPick.entry_zone_high.toFixed(0)}` : ''}
                      </span>
                    </div>

                    {/* Stop Loss */}
                    <div className="v1-stat-pill v1-stat-pill-down p-3 text-center items-center">
                      <span className="text-[8px] text-rose-400 font-data font-bold font-display uppercase tracking-wider block">Downside Stop Loss</span>
                      <span className="text-sm font-black text-rose-300 font-data block mt-1.5">
                        {selectedPick.stop_loss ? `₹${selectedPick.stop_loss.toFixed(0)}` : '—'}
                      </span>
                    </div>

                    {/* Target 1 */}
                    <div className="v1-stat-pill v1-stat-pill-up p-3 text-center items-center">
                      <span className="text-[8px] text-emerald-400 font-data font-bold font-display uppercase tracking-wider block">Target 1</span>
                      <span className="text-sm font-black text-emerald-300 font-data block mt-1.5">
                        {selectedPick.target_1 ? `₹${selectedPick.target_1.toFixed(0)}` : '—'}
                      </span>
                    </div>

                    {/* Target 2 */}
                    <div className="v1-stat-pill v1-stat-pill-up p-3 text-center items-center">
                      <span className="text-[8px] text-emerald-400 font-data font-bold font-display uppercase tracking-wider block">Target 2</span>
                      <span className="text-sm font-black text-emerald-300 font-data block mt-1.5">
                        {selectedPick.target_2 ? `₹${selectedPick.target_2.toFixed(0)}` : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Horizontal Visual Thermometer */}
                  {selectedPick.stop_loss && selectedPick.target_1 && (
                    <div className="bg-slate-950/40 border border-slate-850 p-4 rounded-xl space-y-2">
                      <div className="flex justify-between text-[9px] text-slate-500 font-data uppercase font-bold">
                        <span>Stop Loss (₹{selectedPick.stop_loss.toFixed(0)})</span>
                        <span className="text-indigo-400">Current Price (₹{(selectedPick.livePrice || selectedPick.cmp)?.toFixed(0)})</span>
                        <span>Target 1 (₹{selectedPick.target_1.toFixed(0)})</span>
                      </div>
                      <div className="h-2 bg-slate-800 rounded-full relative overflow-visible mt-1">
                        
                        {/* Entry Range Highlight */}
                        {selectedPick.entry_zone_low && selectedPick.entry_zone_high && (
                          (() => {
                            const { start, end } = getEntryRangePercentage(
                              selectedPick.stop_loss,
                              selectedPick.entry_zone_low,
                              selectedPick.entry_zone_high,
                              selectedPick.target_1
                            );
                            return (
                              <div
                                className="absolute h-2 bg-indigo-500/35 border-x border-indigo-400/50"
                                style={{ left: `${start}%`, width: `${end - start}%` }}
                                title="Entry Zone"
                              />
                            );
                          })()
                        )}

                        {/* CMP Dot */}
                        <div
                          className="absolute w-4 h-4 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.8)] -top-1 border-2 border-slate-900 -translate-x-1/2 transition-all duration-500"
                          style={{ left: `${getThermomPosition(selectedPick.livePrice || selectedPick.cmp, selectedPick.stop_loss, selectedPick.entry_zone_low || selectedPick.stop_loss, selectedPick.target_1)}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[8px] text-slate-500 font-data">
                        <span>Downside Risk</span>
                        <span className="text-indigo-400/70 font-bold">Entry Zone (Highlighted)</span>
                        <span>Upside Target</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Trade Justification & Rationale */}
                {selectedPick.trade_reasoning && (
                  <div className="border-t border-slate-850 pt-4 space-y-2">
                    <h3 className="text-xs font-black uppercase text-slate-300 tracking-wider flex items-center gap-2">
                      <Info className="w-4 h-4 text-indigo-400" />
                      Quant Rationale & Confluences
                    </h3>
                    <div className="bg-slate-950/30 border border-slate-850 p-4 rounded-xl relative overflow-hidden">
                      <p className="text-xs text-slate-300 leading-relaxed font-medium italic">
                        "{selectedPick.trade_reasoning}"
                      </p>

                      {/* Active Screener Names */}
                      {selectedPick.screener_names_json && (
                        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-850 pt-3">
                          {(() => {
                            try {
                              const list = JSON.parse(selectedPick.screener_names_json);
                              if (Array.isArray(list)) {
                                return list.map((name: string, i: number) => (
                                  <span key={i} className="v1-badge text-[8px] font-data bg-indigo-950/40 border-indigo-900/40 text-indigo-300 uppercase">
                                    {name}
                                  </span>
                                ));
                              }
                            } catch { /* parse fail */ }
                            return null;
                          })()}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Grid: Risk Gater Checklist & Simulator Panel */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                {/* Risk Checklist (ASM/GSM, Earnings Proximity, Options Skew, Pledging) */}
                <div className="v1-card p-5 space-y-4">
                  <h3 className="text-xs font-black uppercase text-slate-355 tracking-wider flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-rose-400" />
                    Regulatory & Technical Risk Gate
                  </h3>

                  <div className="space-y-2.5 text-[11px] font-data">
                    
                    {/* ASM / GSM Surveillance Flag */}
                    <div className="v1-stat-pill flex-row items-center justify-between p-2.5">
                      <div className="flex items-center gap-2">
                        <Shield className="w-4 h-4 text-slate-500" />
                        <span className="text-slate-400">ASM / GSM Status</span>
                      </div>
                      <span className={cn(
                        "v1-badge text-[9px] uppercase",
                        selectedPick.asm_flag || selectedPick.gsm_stage ? "bg-rose-500/20 border-rose-500/40 text-rose-400" : "bg-emerald-500/20 border-emerald-500/40 text-emerald-400"
                      )}>
                        {selectedPick.asm_flag ? 'ASM Active' : selectedPick.gsm_stage ? `GSM Stage ${selectedPick.gsm_stage}` : 'Clean'}
                      </span>
                    </div>

                    {/* Earnings Proximity */}
                    <div className="v1-stat-pill flex-row items-center justify-between p-2.5">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-slate-500" />
                        <span className="text-slate-400">Earnings Proximity</span>
                      </div>
                      <span className={cn(
                        "v1-badge text-[9px]",
                        selectedPick.days_to_next_results != null && selectedPick.days_to_next_results <= 5
                          ? "bg-rose-500/20 border-rose-500/40 text-rose-400"
                          : "bg-slate-800/60 border-slate-700/40 text-slate-300"
                      )}>
                        {selectedPick.days_to_next_results != null
                          ? `${selectedPick.days_to_next_results} Days Left`
                          : 'No Event Set'}
                      </span>
                    </div>

                    {/* Options Implied Volatility Rank */}
                    <div className="v1-stat-pill flex-row items-center justify-between p-2.5">
                      <div className="flex items-center gap-2">
                        <Activity className="w-4 h-4 text-slate-500" />
                        <span className="text-slate-400">Options IV Rank / Skew</span>
                      </div>
                      <span className="text-slate-300 font-bold">
                        {selectedPick.iv_rank != null ? `IVR ${Math.round(selectedPick.iv_rank * 100)}` : '—'}
                        {selectedPick.iv_skew != null ? ` / Skew ${selectedPick.iv_skew.toFixed(2)}` : ''}
                      </span>
                    </div>

                    {/* Promoter net transaction */}
                    <div className="v1-stat-pill flex-row items-center justify-between p-2.5">
                      <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-slate-500" />
                        <span className="text-slate-400">Promoter Trades (90d)</span>
                      </div>
                      <span className={cn(
                        "font-bold",
                        selectedPick.promoter_net_90d != null && selectedPick.promoter_net_90d > 0 ? "text-emerald-400" :
                        selectedPick.promoter_net_90d != null && selectedPick.promoter_net_90d < 0 ? "text-rose-400" : "text-slate-500"
                      )}>
                        {selectedPick.promoter_net_90d != null
                          ? `${selectedPick.promoter_net_90d >= 0 ? '+' : ''}${selectedPick.promoter_net_90d.toFixed(2)} Cr`
                          : 'No activity'}
                      </span>
                    </div>

                    {/* Calibrated Win Rate (Calibration tab) */}
                    {matchedCalibration && (
                      <div className="v1-stat-pill flex-row items-center justify-between p-2.5">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-indigo-400" />
                          <span className="text-slate-400">Historical Win Rate</span>
                        </div>
                        <span className="text-indigo-300 font-black font-data">
                          {(matchedCalibration.win_rate * 100).toFixed(0)}% ({matchedCalibration.total_signals} samples)
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Capital Allocation & Simulator (Calculator & Logger) */}
                <div className="v1-card p-5 space-y-4">
                  <h3 className="text-xs font-black uppercase text-slate-350 tracking-wider flex items-center gap-2">
                    <Scale className="w-4 h-4 text-indigo-400" />
                    Allocation Calculator & Decision Log
                  </h3>

                  {/* Inputs */}
                  <div className="grid grid-cols-2 gap-3 text-[10px]">
                    <div>
                      <label className="text-slate-500 font-bold uppercase block mb-1">Trading Capital (₹)</label>
                      <input 
                        type="number"
                        value={simulatorCapital}
                        onChange={(e) => setSimulatorCapital(Math.max(100, +e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 text-slate-200 px-3 py-1.5 rounded-lg outline-none focus:border-indigo-500/50 font-bold font-data"
                      />
                    </div>
                    <div>
                      <label className="text-slate-500 font-bold uppercase block mb-1">Risk Percentage (%)</label>
                      <input 
                        type="number"
                        step="0.1"
                        value={simulatorRiskPct}
                        onChange={(e) => setSimulatorRiskPct(Math.max(0.1, +e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 text-slate-200 px-3 py-1.5 rounded-lg outline-none focus:border-indigo-500/50 font-bold font-data"
                      />
                    </div>
                    
                    <div className="col-span-2">
                      <label className="text-slate-500 font-bold uppercase block mb-1">Profit Target Level</label>
                      <div className="flex gap-2">
                        {(['target_1', 'target_2'] as const).map((t) => (
                          <button
                            key={t}
                            onClick={() => setSimulatorTargetType(t)}
                            className={cn(
                              "flex-1 py-1.5 border rounded-lg text-[9px] uppercase font-bold tracking-wider font-data",
                              simulatorTargetType === t 
                                ? "bg-indigo-600/10 border-indigo-500/60 text-indigo-400"
                                : "bg-slate-950 border-slate-800 text-slate-500 hover:text-slate-300"
                            )}
                          >
                            {t === 'target_1' ? `Target 1 (₹${selectedPick.target_1?.toFixed(0) || '—'})` : `Target 2 (₹${selectedPick.target_2?.toFixed(0) || '—'})`}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Results Pane */}
                  {calculatorResults ? (
                    calculatorResults.isValid ? (
                      <div className="bg-slate-950/50 border border-slate-850 p-3 rounded-xl text-[11px] font-data space-y-2">
                        <div className="flex justify-between">
                          <span className="text-slate-500">Position Size:</span>
                          <span className="font-bold text-slate-200">{calculatorResults.sharesToBuy} Shares</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Capital Required:</span>
                          <span className={cn("font-bold text-slate-200", calculatorResults.leverageExceeded ? "text-amber-400" : "")}>
                            {formatAmount(calculatorResults.totalRequiredCapital)}
                            {calculatorResults.leverageExceeded && <span className="text-[9px] ml-1 font-bold text-amber-500 block text-right">(Exceeds Capital!)</span>}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Stop Loss Risk:</span>
                          <span className="font-bold text-rose-400">{formatAmount(calculatorResults.riskAmount)} ({simulatorRiskPct}%)</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Potential Profit:</span>
                          <span className="font-bold text-emerald-400">{formatAmount(calculatorResults.potentialProfit)} ({((calculatorResults.potentialProfit / simulatorCapital) * 100).toFixed(1)}%)</span>
                        </div>
                        <div className="flex justify-between border-t border-slate-900 pt-1">
                          <span className="text-slate-500">Risk/Reward Ratio:</span>
                          <span className="font-bold text-slate-200">1 : {calculatorResults.riskRewardRatio?.toFixed(2)}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="bg-rose-950/20 border border-rose-900/40 p-3 rounded-xl flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                        <span className="text-[10px] text-rose-300 font-bold font-data">{calculatorResults.reason}</span>
                      </div>
                    )
                  ) : null}

                  {/* Input Execution Note */}
                  <div>
                    <input 
                      type="text"
                      placeholder="Add brief execution journal note..."
                      value={actionNotes}
                      onChange={(e) => setActionNotes(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 text-slate-300 px-3 py-1.5 rounded-lg outline-none focus:border-indigo-500/50 text-xs font-bold"
                    />
                  </div>

                  {/* Actions Trigger */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleLogExecution('BUY')}
                      disabled={logActionMutation.isPending}
                      className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-emerald-950 text-xs font-black rounded-xl transition-all shadow-lg text-center cursor-pointer"
                    >
                      LOG EXECUTE BUY
                    </button>
                    <button
                      onClick={() => handleLogExecution('SKIP')}
                      disabled={logActionMutation.isPending}
                      className="v1-btn-secondary flex-1 py-2.5 text-xs font-black"
                    >
                      LOG SKIP SETUP
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="v1-card p-20 text-center">
              <Zap className="w-12 h-12 text-slate-500/30 mx-auto mb-4 animate-pulse" />
              <p className="text-slate-400 font-bold uppercase">Select an active stock setup from the ranking picks list</p>
            </div>
          )}
        </div>
      </div>

      <TradeJournalPanel />
    </div>
  );
};
