import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import {
  Activity, TrendingUp, TrendingDown, ChevronRight, RefreshCw,
  BarChart2, BrainCircuit, Sparkles, AlertTriangle, ShieldCheck,
  ArrowRight, ArrowUpRight, ArrowDownRight
} from 'lucide-react';
import { cn } from '../lib/utils';
import { RiskMetricsDashboard } from './RiskMetricsDashboard';

const fmt = (n: number | null | undefined, dec = 2) =>
  n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });

const pctColor = (v: number | null | undefined) =>
  v == null ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-rose-400';

const sign = (v: number | null | undefined) =>
  v == null ? '' : v >= 0 ? '+' : '';

export const TradeDecisionCockpit: React.FC<{ onSelectStock: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [rightPanel, setRightPanel] = useState<'context' | 'detail'>('context');
  const [selectedCand, setSelectedCand] = useState<any>(null);

  const { data: cockpitRes, isLoading: cockpitLoading, refetch } =
    trpc.getTradeDecisionCockpitData.useQuery(undefined, { refetchInterval: 60000, refetchOnWindowFocus: false });

  const { data: overviewRes } =
    trpc.getAllIndices.useQuery(undefined, { refetchInterval: 30000, refetchOnWindowFocus: false });

  const { data: adRes } =
    trpc.getAdvanceDecline.useQuery(undefined, { refetchInterval: 60000, refetchOnWindowFocus: false });

  const { data: sectorRes } =
    trpc.getSectorPerformance.useQuery(undefined, { refetchInterval: 300000, refetchOnWindowFocus: false });

  const { data: moversRes } =
    trpc.getTopMovers.useQuery(undefined, { refetchInterval: 60000, refetchOnWindowFocus: false });

  const { data: fiiRes } =
    trpc.getFiiDiiFlow.useQuery(undefined, { refetchInterval: 300000, refetchOnWindowFocus: false });

  const { data: sentimentRes } =
    trpc.getMarketSentiment.useQuery(undefined, { refetchInterval: 120000, refetchOnWindowFocus: false });

  const cockpitData = cockpitRes?.success ? cockpitRes.data : null;
  const overview: any = cockpitData?.marketOverview || {};
  const candidates: any[] = cockpitData?.candidates || [];

  const isTradeActive = overview.verdict === 'TRADE';

  // Market pulse data
  const indices: any[] = (overviewRes as any)?.data?.indiceList?.flatMap((g: any) => g.list) ?? (overviewRes as any)?.indices ?? (overviewRes as any)?.data ?? [];
  const nifty    = indices.find((i: any) => /nifty\s*50/i.test(i.name) || i.symbol === 'NIFTY 50' || i.symbol === '^NSEI');
  const bankNifty = indices.find((i: any) => /bank.?nifty/i.test(i.name) || i.symbol === 'NIFTY BANK');
  const sensex   = indices.find((i: any) => /sensex/i.test(i.name) || i.symbol === 'BSE SENSEX');

  const adData: any = adRes || {};
  const advances = adData.advances ?? adData.advancing ?? null;
  const declines = adData.declines ?? adData.declining ?? null;

  const sectors: any[] = (sectorRes as any)?.sectors || (sectorRes as any)?.data || [];
  const gainers: any[] = (moversRes as any)?.gainers || (moversRes as any)?.topGainers || [];
  const losers:  any[] = (moversRes as any)?.losers  || (moversRes as any)?.topLosers  || [];
  const fiiRows: any[] = (fiiRes   as any)?.data     || (fiiRes   as any)?.flows       || [];
  const sentimentScore: number | null = (sentimentRes as any)?.latest?.overall_score ?? (sentimentRes as any)?.score ?? (sentimentRes as any)?.overallScore ?? null;
  const pcr: number | null = (sentimentRes as any)?.pcr ?? (sentimentRes as any)?.latest?.pcr ?? (sentimentRes as any)?.putCallRatio ?? null;

  const selectCand = (c: any) => {
    setSelectedCand(c);
    setRightPanel('detail');
  };

  if (cockpitLoading) {
    return (
      <div className="py-48 flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest animate-pulse">Running Quant Scans…</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-screen-2xl mx-auto">

      {/* ── Market Pulse Strip ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {[
          { label: 'Nifty 50',    v: nifty?.lastPrice    ?? nifty?.price,    chg: nifty?.change,    pct: nifty?.pChange    ?? nifty?.changePct },
          { label: 'Bank Nifty',  v: bankNifty?.lastPrice ?? bankNifty?.price, chg: bankNifty?.change, pct: bankNifty?.pChange ?? bankNifty?.changePct },
          { label: 'Sensex',      v: sensex?.lastPrice   ?? sensex?.price,   chg: sensex?.change,   pct: sensex?.pChange   ?? sensex?.changePct },
          { label: 'Adv / Dec',   v: advances != null && declines != null ? `${advances}/${declines}` : null, pct: advances != null && declines != null ? (advances - declines) / Math.max(1, advances + declines) * 100 : null, plain: true },
          { label: 'PCR',         v: pcr != null ? fmt(pcr, 2) : null, pct: pcr != null ? (pcr - 1) * 100 : null, plain: true },
          { label: 'Sentiment',   v: sentimentScore != null ? `${sentimentScore > 0 ? '+' : ''}${fmt(sentimentScore, 1)}` : null, pct: sentimentScore, plain: true },
        ].map((item, i) => (
          <div key={i} className="bg-slate-900/60 border border-slate-800/50 rounded-xl px-3 py-2">
            <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">{item.label}</p>
            {item.v != null ? (
              <>
                <p className="text-sm font-black text-white tabular-nums mt-0.5">
                  {item.plain ? item.v : `₹${fmt(item.v as number, 0)}`}
                </p>
                {item.pct != null && !item.plain && (
                  <p className={cn('text-[10px] font-bold tabular-nums', pctColor(item.pct as number))}>
                    {sign(item.pct as number)}{fmt(item.pct as number, 2)}%
                  </p>
                )}
                {item.pct != null && item.plain && (
                  <p className={cn('text-[10px] font-bold', pctColor(item.pct as number))}>
                    {(item.pct as number) > 0 ? 'Bullish' : (item.pct as number) < 0 ? 'Bearish' : 'Neutral'}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm font-black text-slate-600 mt-0.5">—</p>
            )}
          </div>
        ))}
      </div>

      {/* ── Verdict Banner ─────────────────────────────────────────── */}
      <div className={cn(
        'flex items-center justify-between px-4 py-3 rounded-2xl border',
        isTradeActive
          ? 'bg-emerald-950/30 border-emerald-500/25 text-emerald-300'
          : 'bg-amber-950/25 border-amber-500/20 text-amber-300'
      )}>
        <div className="flex items-center gap-3">
          {isTradeActive
            ? <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
            : <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
          <div>
            <span className="text-xs font-black uppercase tracking-wide">
              {isTradeActive ? 'Trade Signal Active' : 'Risk-Off — No Trade'}
            </span>
            <p className="text-[10px] text-slate-400 font-medium mt-0.5">
              {overview.verdictReason || 'Run technical scans from the Signals tab to populate candidates.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[10px] font-bold text-slate-400 hidden sm:block">
            {overview.activeSignalsCount ?? candidates.length} signals · A/D {overview.advDecRatio ?? '—'}x · Win {overview.avgWinProbability ?? '—'}%
          </span>
          <button onClick={() => refetch()}
            className="p-2 bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 rounded-lg text-slate-400 transition-all">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Main Grid ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">

        {/* Candidate Table — 8 cols */}
        <div className="xl:col-span-8 bg-slate-900/40 border border-slate-800/50 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/50">
            <div>
              <h3 className="text-xs font-black text-white uppercase tracking-wider">Trade Candidates</h3>
              <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5">Ranked by composite quant score · click row for detail</p>
            </div>
            <span className="text-[9px] bg-slate-800 text-slate-300 font-bold px-2 py-0.5 rounded uppercase">
              Top {candidates.length}
            </span>
          </div>

          {candidates.length === 0 ? (
            <div className="py-16 text-center">
              <Sparkles className="w-8 h-8 text-slate-700 mx-auto mb-2" />
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">No candidates — run Signals scan first</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-800/40">
                    {['Stock / Sector', 'Price ₹', 'Chg%', 'RSI', 'MACD', 'Setup', 'Score', 'Entry / SL', 'Win%', ''].map((h, i) => (
                      <th key={i} className={cn(
                        'px-3 py-2.5 text-[9px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap',
                        i > 1 && 'text-center'
                      )}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/20">
                  {candidates.map((c: any) => {
                    const rsi = c.rsi ?? null;
                    const macdBull = c.macd != null && c.macdSignal != null ? c.macd > c.macdSignal : null;
                    const isSelected = selectedCand?.symbol === c.symbol;
                    return (
                      <tr key={c.symbol}
                        onClick={() => selectCand(c)}
                        className={cn(
                          'cursor-pointer hover:bg-slate-800/30 transition-colors',
                          isSelected && 'bg-indigo-950/20'
                        )}>

                        {/* Stock + Sector */}
                        <td className="px-3 py-3 min-w-[130px]">
                          <div className="flex items-center gap-1.5">
                            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
                              (c.changePct ?? 0) >= 0 ? 'bg-emerald-500' : 'bg-rose-500')} />
                            <div>
                              <p className="text-xs font-black text-white">{c.symbol}</p>
                              <p className="text-[9px] text-slate-500 truncate max-w-[100px]">{c.sector || c.name || ''}</p>
                            </div>
                          </div>
                        </td>

                        {/* Price */}
                        <td className="px-3 py-3 text-xs font-black text-white tabular-nums whitespace-nowrap">
                          ₹{fmt(c.cmp ?? c.price, 1)}
                        </td>

                        {/* Change% */}
                        <td className="px-3 py-3 text-center">
                          <span className={cn('text-[10px] font-black tabular-nums', pctColor(c.changePct))}>
                            {sign(c.changePct)}{fmt(c.changePct, 2)}%
                          </span>
                        </td>

                        {/* RSI */}
                        <td className="px-3 py-3 text-center">
                          {rsi != null ? (
                            <span className={cn('text-[10px] font-black tabular-nums px-1.5 py-0.5 rounded',
                              rsi >= 70 ? 'text-rose-400 bg-rose-950/30'
                              : rsi <= 30 ? 'text-emerald-400 bg-emerald-950/30'
                              : 'text-slate-300')}>
                              {fmt(rsi, 1)}
                              {rsi >= 70 ? ' OB' : rsi <= 30 ? ' OS' : ''}
                            </span>
                          ) : <span className="text-slate-600 text-[10px]">—</span>}
                        </td>

                        {/* MACD */}
                        <td className="px-3 py-3 text-center">
                          {macdBull != null ? (
                            <span className={cn('text-[9px] font-black px-1.5 py-0.5 rounded border',
                              macdBull
                                ? 'text-emerald-400 bg-emerald-950/30 border-emerald-800/40'
                                : 'text-rose-400 bg-rose-950/30 border-rose-800/40')}>
                              {macdBull ? 'Bull' : 'Bear'}
                            </span>
                          ) : <span className="text-slate-600 text-[10px]">—</span>}
                        </td>

                        {/* Setup / Action Advice */}
                        <td className="px-3 py-3 text-center">
                          <span className={cn('text-[9px] font-black px-2 py-0.5 rounded border whitespace-nowrap',
                            c.actionAdvice === 'STRONG BUY' ? 'text-violet-400 bg-violet-950/30 border-violet-800/40'
                            : c.actionAdvice === 'BUY' ? 'text-emerald-400 bg-emerald-950/30 border-emerald-800/40'
                            : 'text-slate-400 bg-slate-800/30 border-slate-700/40')}>
                            {c.actionAdvice || 'WATCH'}
                          </span>
                        </td>

                        {/* Score + mini bar */}
                        <td className="px-3 py-3 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <span className="text-xs font-black text-white tabular-nums">{c.compositeScore}</span>
                            <div className="w-14 h-1 bg-slate-800 rounded-full overflow-hidden">
                              <div className={cn('h-full rounded-full',
                                c.compositeScore >= 75 ? 'bg-violet-500'
                                : c.compositeScore >= 60 ? 'bg-emerald-500'
                                : 'bg-amber-500')}
                                style={{ width: `${Math.min(100, c.compositeScore)}%` }} />
                            </div>
                          </div>
                        </td>

                        {/* Entry / SL */}
                        <td className="px-3 py-3 text-center whitespace-nowrap">
                          <p className="text-[10px] font-bold text-slate-300 tabular-nums">
                            {c.entryPrice ? `₹${fmt(c.entryPrice, 1)}` : '—'}
                          </p>
                          <p className="text-[9px] font-bold text-rose-400 tabular-nums">
                            {c.stopLoss ? `SL ₹${fmt(c.stopLoss, 1)}` : ''}
                          </p>
                        </td>

                        {/* Win% */}
                        <td className="px-3 py-3 text-center text-xs font-black text-indigo-400 tabular-nums">
                          {c.mlProbability != null ? `${c.mlProbability}%` : '—'}
                        </td>

                        {/* Open Full */}
                        <td className="px-3 py-3 text-right">
                          <button
                            onClick={e => { e.stopPropagation(); onSelectStock(c.symbol); }}
                            className="p-1.5 bg-slate-800/60 hover:bg-indigo-600/20 border border-slate-700/50 hover:border-indigo-500/40 rounded-lg text-slate-400 hover:text-indigo-400 transition-all">
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right Panel — 4 cols */}
        <div className="xl:col-span-4 flex flex-col gap-3">
          {/* Toggle tabs */}
          <div className="flex gap-1 bg-slate-900/60 border border-slate-800/50 rounded-xl p-1">
            {[
              { id: 'context', label: 'Market Context', icon: BarChart2 },
              { id: 'detail',  label: 'Candidate Detail', icon: BrainCircuit },
            ].map(tab => (
              <button key={tab.id}
                onClick={() => setRightPanel(tab.id as any)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all',
                  rightPanel === tab.id
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : 'text-slate-500 hover:text-slate-300'
                )}>
                <tab.icon className="w-3 h-3" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Market Context panel */}
          {rightPanel === 'context' && (
            <div className="space-y-3">

              {/* PCR + Sentiment */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3">
                  <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Put/Call Ratio</p>
                  <p className={cn('text-lg font-black tabular-nums mt-0.5',
                    pcr != null && pcr > 1.2 ? 'text-emerald-400'
                    : pcr != null && pcr < 0.8 ? 'text-rose-400'
                    : 'text-white')}>
                    {pcr != null ? fmt(pcr, 2) : '—'}
                  </p>
                  <p className="text-[9px] text-slate-500 mt-0.5">
                    {pcr == null ? '' : pcr > 1.2 ? 'Contrarian Bull' : pcr < 0.8 ? 'Contrarian Bear' : 'Neutral'}
                  </p>
                </div>
                <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3">
                  <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Sentiment</p>
                  <p className={cn('text-lg font-black tabular-nums mt-0.5',
                    sentimentScore != null && sentimentScore > 0 ? 'text-emerald-400'
                    : sentimentScore != null && sentimentScore < 0 ? 'text-rose-400'
                    : 'text-white')}>
                    {sentimentScore != null ? `${sentimentScore > 0 ? '+' : ''}${fmt(sentimentScore, 2)}` : '—'}
                  </p>
                  <p className="text-[9px] text-slate-500 mt-0.5">
                    {sentimentScore == null ? '' : sentimentScore > 0.3 ? 'Bullish' : sentimentScore < -0.3 ? 'Bearish' : 'Neutral'}
                  </p>
                </div>
              </div>

              {/* Sector Performance */}
              {sectors.length > 0 && (
                <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Activity className="w-3 h-3" /> Sector Performance
                  </p>
                  <div className="space-y-1.5">
                    {sectors.slice(0, 7).map((s: any, i: number) => {
                      const chg = s.change ?? s.changePct ?? s.pChange ?? s.mcapPerChange ?? 0;
                      const pct = Math.abs(chg);
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-[9px] text-slate-400 w-20 truncate shrink-0">{s.sector || s.name}</span>
                          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={cn('h-full rounded-full', chg >= 0 ? 'bg-emerald-500' : 'bg-rose-500')}
                              style={{ width: `${Math.min(100, pct * 10)}%` }} />
                          </div>
                          <span className={cn('text-[9px] font-bold tabular-nums w-10 text-right', pctColor(chg))}>
                            {sign(chg)}{fmt(chg, 1)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Top Movers */}
              {(gainers.length > 0 || losers.length > 0) && (
                <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <TrendingUp className="w-3 h-3" /> Top Movers
                  </p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    {gainers.slice(0, 4).map((g: any, i: number) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-[9px] text-slate-300 font-bold truncate max-w-[55px]">{g.symbol}</span>
                        <span className="text-[9px] font-black text-emerald-400 tabular-nums">
                          +{fmt(g.pChange ?? g.changePct, 1)}%
                        </span>
                      </div>
                    ))}
                    {losers.slice(0, 4).map((l: any, i: number) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-[9px] text-slate-300 font-bold truncate max-w-[55px]">{l.symbol}</span>
                        <span className="text-[9px] font-black text-rose-400 tabular-nums">
                          {fmt(l.pChange ?? l.changePct, 1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* FII/DII Flow */}
              {fiiRows.length > 0 && (
                <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-2">FII / DII Flow (₹ Cr)</p>
                  <table className="w-full">
                    <thead>
                      <tr>
                        {['Date', 'FII Net', 'DII Net'].map(h => (
                          <th key={h} className="text-[8.5px] font-bold text-slate-500 uppercase pb-1 text-right first:text-left">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fiiRows.slice(0, 5).map((r: any, i: number) => {
                        const fiiNet = r.fiiNet ?? r.fii_net ?? r.fiiNetPurchases ?? null;
                        const diiNet = r.diiNet ?? r.dii_net ?? r.diiNetPurchases ?? null;
                        return (
                          <tr key={i} className="border-t border-slate-800/30">
                            <td className="text-[9px] text-slate-400 py-1">{r.date ?? r.tradeDate ?? '—'}</td>
                            <td className={cn('text-[9px] font-bold tabular-nums py-1 text-right', pctColor(fiiNet))}>
                              {fiiNet != null ? `${sign(fiiNet)}${fmt(fiiNet, 0)}` : '—'}
                            </td>
                            <td className={cn('text-[9px] font-bold tabular-nums py-1 text-right', pctColor(diiNet))}>
                              {diiNet != null ? `${sign(diiNet)}${fmt(diiNet, 0)}` : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Candidate Detail panel */}
          {rightPanel === 'detail' && (
            <div>
              {!selectedCand ? (
                <div className="py-16 bg-slate-900/40 border border-slate-800/50 rounded-xl text-center">
                  <Sparkles className="w-7 h-7 text-slate-700 mx-auto mb-2" />
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                    Click a candidate to see detail
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Header cards */}
                  <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="text-base font-black text-white uppercase">{selectedCand.symbol}</h4>
                        <p className="text-[9px] text-slate-500 font-bold">{selectedCand.sector || selectedCand.name}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-black text-white tabular-nums">
                          ₹{fmt(selectedCand.cmp ?? selectedCand.price, 1)}
                        </p>
                        <p className={cn('text-[10px] font-black tabular-nums', pctColor(selectedCand.changePct))}>
                          {sign(selectedCand.changePct)}{fmt(selectedCand.changePct, 2)}%
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-slate-800/40">
                      <div>
                        <p className="text-[8.5px] text-slate-500 uppercase">Score</p>
                        <p className="text-sm font-black text-indigo-400">{selectedCand.compositeScore}</p>
                      </div>
                      <div>
                        <p className="text-[8.5px] text-slate-500 uppercase">Win%</p>
                        <p className="text-sm font-black text-emerald-400">
                          {selectedCand.mlProbability != null ? `${selectedCand.mlProbability}%` : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[8.5px] text-slate-500 uppercase">Setup</p>
                        <p className="text-[10px] font-black text-violet-400">{selectedCand.actionAdvice || '—'}</p>
                      </div>
                    </div>
                  </div>

                  {/* Entry / Target / SL */}
                  <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3 space-y-2">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Trade Levels</p>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      {[
                        { label: 'Entry', v: selectedCand.entryPrice, color: 'text-indigo-400' },
                        { label: 'Target', v: selectedCand.targetPrice, color: 'text-emerald-400' },
                        { label: 'Stop', v: selectedCand.stopLoss, color: 'text-rose-400' },
                      ].map((lv, i) => (
                        <div key={i} className="bg-slate-800/40 rounded-lg p-2">
                          <p className="text-[8.5px] text-slate-500 uppercase">{lv.label}</p>
                          <p className={cn('text-xs font-black tabular-nums', lv.color)}>
                            {lv.v ? `₹${fmt(lv.v, 1)}` : '—'}
                          </p>
                        </div>
                      ))}
                    </div>
                    {(() => {
                      const e = parseFloat(selectedCand.entryPrice);
                      const t = parseFloat(selectedCand.targetPrice);
                      const s = parseFloat(selectedCand.stopLoss);
                      if (e > 0 && t > e && s > 0 && e > s) {
                        const rr = ((t - e) / (e - s)).toFixed(1);
                        return (
                          <div className="flex justify-between items-center pt-2 border-t border-slate-800/40">
                            <span className="text-[9px] text-slate-400 uppercase font-bold">Risk : Reward</span>
                            <span className={cn('text-xs font-black px-2 py-0.5 rounded border',
                              parseFloat(rr) >= 2 ? 'text-emerald-400 bg-emerald-950/30 border-emerald-800/40'
                              : 'text-amber-400 bg-amber-950/20 border-amber-800/30')}>
                              1 : {rr}
                            </span>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>

                  {/* Factor Bars */}
                  {/* Fixed 2026-07-30 (Finding #97, full-stack audit): only "ML Win Prob"
                      below is a validated backend score; the other 4 are ad hoc linear
                      transforms invented client-side with no calibration
                      (techSignalCount*25, 100-quantRank, 50+smartMoneyCr*5,
                      50+newsSentiment*50) -- they used to render with equal visual weight,
                      implying a validated 5-factor model backs this trade decision when it
                      doesn't. Kept the same underlying values (a backend rewrite of these
                      transforms is a separate, larger initiative) but now visually and
                      textually distinguishes the one real model score from the 4 raw/
                      derived heuristics per the audit's minimum-bar recommendation. */}
                  <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3 space-y-2">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Factor Breakdown</p>
                    {[
                      { label: 'ML Win Prob', v: selectedCand.mlProbability, color: 'bg-indigo-500', isModel: true },
                      { label: 'Technical Signals (derived)', v: Math.min(100, (selectedCand.techSignalCount ?? 0) * 25), color: 'bg-emerald-500', isModel: false },
                      { label: 'Quant Rank (derived)', v: Math.max(0, 100 - (selectedCand.quantRank ?? 100)), color: 'bg-amber-500', isModel: false },
                      { label: 'Smart Money (derived)', v: Math.min(100, Math.max(0, 50 + (selectedCand.smartMoneyCr ?? 0) * 5)), color: 'bg-pink-500', isModel: false },
                      { label: 'News Sentiment (derived)', v: Math.min(100, Math.max(0, 50 + (selectedCand.newsSentiment ?? 0) * 50)), color: 'bg-blue-500', isModel: false },
                    ].map((f, i) => (
                      <div key={i} title={f.isModel ? 'Validated ML model output' : 'Client-side heuristic, not a calibrated model score'}>
                        <div className="flex justify-between text-[9px] font-bold mb-0.5">
                          <span className={f.isModel ? "text-slate-300" : "text-slate-500"}>{f.label}</span>
                          <span className="text-slate-300 tabular-nums">{f.v != null ? `${Math.round(f.v)}%` : '—'}</span>
                        </div>
                        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div className={cn('h-full rounded-full', f.color, !f.isModel && 'opacity-60')}
                            style={{ width: `${f.v ?? 0}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Technical Grid */}
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      {
                        label: 'RSI (14)',
                        val: selectedCand.rsi ? fmt(selectedCand.rsi, 1) : '—',
                        sub: selectedCand.rsi >= 70 ? 'Overbought' : selectedCand.rsi <= 30 ? 'Oversold' : 'Neutral',
                        color: selectedCand.rsi >= 70 ? 'text-rose-400' : selectedCand.rsi <= 30 ? 'text-emerald-400' : 'text-slate-300'
                      },
                      {
                        label: 'MACD',
                        val: selectedCand.macd != null ? fmt(selectedCand.macd, 2) : '—',
                        sub: selectedCand.macd != null && selectedCand.macdSignal != null
                          ? (selectedCand.macd > selectedCand.macdSignal ? 'Bullish Cross' : 'Bearish Cross') : '',
                        color: selectedCand.macd == null || selectedCand.macdSignal == null ? 'text-slate-400' : (selectedCand.macd > selectedCand.macdSignal ? 'text-emerald-400' : 'text-rose-400')
                      },
                      {
                        label: 'SMA 50/200',
                        val: selectedCand.sma50 != null && selectedCand.sma200 != null ? `${fmt(selectedCand.sma50, 0)}/${fmt(selectedCand.sma200, 0)}` : '—',
                        sub: selectedCand.sma50 == null || selectedCand.sma200 == null ? '' : (selectedCand.sma50 > selectedCand.sma200 ? 'Golden Cross' : 'Death Cross'),
                        color: selectedCand.sma50 == null || selectedCand.sma200 == null ? 'text-slate-400' : (selectedCand.sma50 > selectedCand.sma200 ? 'text-emerald-400' : 'text-rose-400')
                      },
                      {
                        label: 'Vol Ratio',
                        val: selectedCand.volumeRatio ? `${fmt(selectedCand.volumeRatio, 1)}x` : '—',
                        sub: selectedCand.volumeRatio >= 1.5 ? 'High Volume' : 'Normal',
                        color: selectedCand.volumeRatio >= 1.5 ? 'text-emerald-400' : 'text-slate-400'
                      },
                    ].map((ind, i) => (
                      <div key={i} className="bg-slate-900/60 border border-slate-800/40 rounded-lg p-2">
                        <p className="text-[8.5px] text-slate-500 uppercase font-bold">{ind.label}</p>
                        <p className="text-xs font-black text-white tabular-nums mt-0.5">{ind.val}</p>
                        <p className={cn('text-[8.5px] font-bold mt-0.5', ind.color)}>{ind.sub}</p>
                      </div>
                    ))}
                  </div>

                  {/* AI Insight */}
                  {selectedCand.aiInsight && (
                    <div className="bg-indigo-950/20 border border-indigo-800/30 rounded-xl p-3">
                      <p className="text-[8.5px] font-bold text-indigo-400 uppercase tracking-wider mb-1">AI Analysis</p>
                      <p className="text-[10px] text-slate-300 leading-relaxed">{selectedCand.aiInsight}</p>
                    </div>
                  )}

                  {/* Signal Confluence */}
                  {(() => {
                    try {
                      const sigs = JSON.parse(selectedCand.signalsJson || '[]');
                      if (sigs.length > 0) return (
                        <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-3 space-y-1.5">
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Signal Confluence</p>
                          {sigs.slice(0, 4).map((s: any, i: number) => (
                            <div key={i} className="flex items-start gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 mt-1 shrink-0" />
                              <div>
                                <p className="text-[9px] font-black text-indigo-300 uppercase">{s.type?.replace(/_/g, ' ')}</p>
                                <p className="text-[9px] text-slate-400">{s.detail}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    } catch { /* skip */ }
                    return null;
                  })()}

                  {/* Open Full Analysis */}
                  <button
                    onClick={() => onSelectStock(selectedCand.symbol)}
                    className="w-full py-3 bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-black text-[10px] uppercase tracking-widest rounded-xl hover:shadow-[0_0_20px_rgba(99,102,241,0.3)] transition-all flex items-center justify-center gap-2">
                    Open Full Analysis
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Risk & Multi-Factor Dashboard ────────────────────────── */}
      <RiskMetricsDashboard focusSymbol={selectedCand?.symbol} collapsed={true} />
    </div>
  );
};

export default TradeDecisionCockpit;
