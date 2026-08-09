import React, { useState } from 'react';
import { ArrowLeft, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { marketHoursRefetchInterval } from '../lib/timeFormat';
import IndexFnoOverview from './IndexFnoOverview';
import { MCIndexDetailPanel, resolveConstituentSymbol } from './MCIndexDetailPanel';

export const IndexDetailPage: React.FC<{
  indexId: string;
  indexName: string;
  onBack: () => void;
  onSelectStock: (symbol: string) => void;
}> = ({ indexId, indexName, onBack, onSelectStock }) => {
  const [techPeriod, setTechPeriod] = useState<'D' | 'W' | 'M'>('D');

  const { data: details } = trpc.getIndexDetails.useQuery({ indexId }, { refetchInterval: 30000 });
  const { data: fullDetails } = trpc.getIndexFullDetails.useQuery({ indId: indexId }, { refetchInterval: 60000 });
  const { data: priceFeed } = trpc.getIndexPriceFeed.useQuery(
    { bridgeSymbol: (details as any)?.bridgeSymbol ?? '' },
    { enabled: !!(details as any)?.bridgeSymbol, refetchInterval: 30000 }
  );
  const { data: stocksList } = trpc.getIndexStocksList.useQuery({ indId: indexId, type: '0' }, { refetchInterval: marketHoursRefetchInterval(10000) });
  const { data: technicals } = trpc.getIndexTechnicals.useQuery(
    { period: techPeriod, bridgeSymbol: (details as any)?.bridgeSymbol ?? '' },
    { enabled: !!(details as any)?.bridgeSymbol, refetchInterval: 60000 }
  );

  const d = details as any;
  const idx = (fullDetails as any)?.indices;
  const pf = (priceFeed as any)?.data;
  const stocks = (stocksList as any)?.item ?? [];
  const tech = (technicals as any)?.data;
  const isUp = (d?.direction ?? 1) === 1;

  const perf = idx ? [
    { label: 'YTD', value: idx.ytd },
    { label: '1W', value: idx.week1 },
    { label: '1M', value: idx.month1 },
    { label: '3M', value: idx.month3 },
    { label: '6M', value: idx.month6 },
    { label: '1Y', value: idx.year1 },
    { label: '2Y', value: idx.year2 },
    { label: '3Y', value: idx.year3 },
    { label: '5Y', value: idx.year5 },
  ] : [];

  const mas = idx ? [
    { label: '30D MA', value: idx.dayavg30 },
    { label: '50D MA', value: idx.dayavg50 },
    { label: '150D MA', value: idx.dayavg150 },
    { label: '200D MA', value: idx.dayavg200 },
  ] : [];

  return (
    <div className="space-y-6 p-6">
      <button onClick={onBack} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-bold">
        <ArrowLeft className="w-4 h-4" /> All Indices
      </button>

      {/* Header */}
      <div className="glass border border-slate-800/50 rounded-3xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-black text-white uppercase tracking-tight">{indexName}</h1>
              <span className={cn("px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest",
                isUp ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {isUp ? 'Bullish' : 'Bearish'}
              </span>
            </div>
            <div className="flex items-end gap-3">
              <span className="text-4xl font-black text-white tabular-nums">{d?.currentPrice ?? '—'}</span>
              <div className={cn("flex items-center gap-1 mb-1", isUp ? "text-emerald-400" : "text-rose-400")}>
                {isUp ? <ArrowUpRight className="w-5 h-5" /> : <ArrowDownRight className="w-5 h-5" />}
                <span className="text-lg font-black">{d?.priceChange}</span>
                <span className="text-sm opacity-70">({d?.perChange}%)</span>
              </div>
            </div>
            {idx && <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-2">Updated: {idx.lastupdated}</p>}
          </div>
          {idx && (
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Open', value: idx.open },
                { label: 'High', value: idx.high },
                { label: 'Low', value: idx.low },
                { label: 'Prev Close', value: idx.prevclose },
              ].map(s => (
                <div key={s.label} className="glass-strong rounded-xl p-3 text-right min-w-[100px]">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{s.label}</p>
                  <p className="text-sm font-black text-white tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        {idx && (() => {
          const cur = parseFloat((idx.lastprice ?? '0').replace(/,/g, ''));
          const lo = parseFloat((idx.yearlylow ?? '0').replace(/,/g, ''));
          const hi = parseFloat((idx.yearlyhigh ?? '1').replace(/,/g, ''));
          const pct = Math.max(5, Math.min(95, ((cur - lo) / (hi - lo || 1)) * 100));
          return (
            <div className="mt-6">
              <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">
                <span>52W Low: {idx.yearlylow}</span>
                <span>52W High: {idx.yearlyhigh}</span>
              </div>
              <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full", isUp ? "bg-emerald-500" : "bg-rose-500")} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })()}
      </div>

      {/* Performance Returns */}
      {perf.length > 0 && (
        <div className="glass border border-slate-800/50 rounded-3xl p-6">
          <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Performance Returns</h2>
          <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-3">
            {perf.map(p => {
              const v = parseFloat(String(p.value ?? 0));
              return (
                <div key={p.label} className="glass-strong rounded-xl p-3 text-center">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">{p.label}</p>
                  <p className={cn("text-sm font-black tabular-nums", v >= 0 ? "text-emerald-400" : "text-rose-400")}>
                    {v >= 0 ? '+' : ''}{v.toFixed(1)}%
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Moving Averages + A/D */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {mas.length > 0 && (
          <div className="glass border border-slate-800/50 rounded-3xl p-6">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Moving Averages vs Current</h2>
            <div className="space-y-3">
              {mas.map(ma => {
                const cur = parseFloat((idx!.lastprice ?? '0').replace(/,/g, ''));
                const maV = parseFloat((ma.value ?? '0').replace(/,/g, ''));
                const above = cur > maV;
                return (
                  <div key={ma.label} className="flex items-center justify-between p-3 glass-strong rounded-xl">
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{ma.label}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-black text-white tabular-nums">{ma.value}</span>
                      <span className={cn("text-[10px] font-black px-2 py-0.5 rounded uppercase",
                        above ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                        {above ? 'Above' : 'Below'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Advance / Decline */}
        <div className="glass border border-slate-800/50 rounded-3xl p-6">
          <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Advance / Decline</h2>
          {(() => {
            const adv = Number(pf?.adv ?? 0);
            const decl = Number(pf?.decl ?? 0);
            const unchg = Number(pf?.unchg ?? 0);
            const total = adv + decl + unchg || 1;
            return (
              <div className="space-y-4">
                <div className="flex h-8 rounded-lg overflow-hidden gap-px">
                  <div className="bg-emerald-500 transition-all" style={{ width: `${(adv / total) * 100}%` }} />
                  <div className="bg-slate-700 transition-all" style={{ width: `${(unchg / total) * 100}%` }} />
                  <div className="bg-rose-500 transition-all" style={{ width: `${(decl / total) * 100}%` }} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Advances', value: adv, color: 'text-emerald-400' },
                    { label: 'Unchanged', value: unchg, color: 'text-slate-400' },
                    { label: 'Declines', value: decl, color: 'text-rose-400' },
                  ].map(item => (
                    <div key={item.label} className="glass-strong rounded-xl p-3 text-center">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">{item.label}</p>
                      <p className={cn("text-xl font-black tabular-nums", item.color)}>{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Technical Analysis */}
      {tech && (
        <div className="glass border border-slate-800/50 rounded-3xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Technical Analysis</h2>
            <div className="flex gap-1">
              {(['D', 'W', 'M'] as const).map(p => (
                <button key={p} onClick={() => setTechPeriod(p)}
                  className={cn("px-3 py-1 rounded text-[10px] font-black uppercase transition-colors",
                    techPeriod === p ? "bg-blue-500 text-white" : "bg-slate-800 text-slate-400 hover:text-white")}>
                  {p === 'D' ? 'Daily' : p === 'W' ? 'Weekly' : 'Monthly'}
                </button>
              ))}
            </div>
          </div>

          {tech.sentiments && (
            <div className="mb-5 p-4 glass-strong rounded-2xl">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Overall Sentiment</span>
                <span className={cn("px-3 py-1 rounded text-[10px] font-black uppercase",
                  tech.sentiments.indication?.includes('Bullish') ? "bg-emerald-500/10 text-emerald-400" :
                  tech.sentiments.indication?.includes('Bearish') ? "bg-rose-500/10 text-rose-400" :
                  "bg-slate-700 text-slate-300")}>
                  {tech.sentiments.indication}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div><p className="text-emerald-400 text-xl font-black">{tech.sentiments.totalBullish}</p><p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-1">Bullish</p></div>
                <div><p className="text-slate-400 text-xl font-black">{tech.sentiments.totalNeutral}</p><p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-1">Neutral</p></div>
                <div><p className="text-rose-400 text-xl font-black">{tech.sentiments.totalBearish}</p><p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-1">Bearish</p></div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {tech.indicators && (
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Indicators</p>
                <div className="space-y-2">
                  {tech.indicators.map((ind: any) => {
                    const val = Array.isArray(ind.value)
                      ? `UB:${ind.value[0]?.value} LB:${ind.value[1]?.value}`
                      : ind.value;
                    return (
                      <div key={ind.id} className="flex items-center justify-between p-2 glass-strong rounded-lg">
                        <span className="text-[10px] font-black text-slate-400">{ind.displayName}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-100 font-bold tabular-nums">{val}</span>
                          <span className={cn("text-[10px] font-black px-2 py-0.5 rounded uppercase",
                            ind.indication === 'Bullish' ? "bg-emerald-500/10 text-emerald-400" :
                            ind.indication === 'Bearish' ? "bg-rose-500/10 text-rose-400" :
                            "bg-slate-700 text-slate-400")}>
                            {ind.indication}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tech.sma && (
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">SMA Signals</p>
                <div className="space-y-2">
                  {tech.sma.map((s: any) => (
                    <div key={s.key} className="flex items-center justify-between p-2 glass-strong rounded-lg">
                      <span className="text-[10px] font-black text-slate-400">SMA {s.key}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-100 font-bold tabular-nums">{s.value}</span>
                        <span className={cn("text-[10px] font-black px-2 py-0.5 rounded uppercase",
                          s.indication === 'Bullish' ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                          {s.indication}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Derivative Intelligence -- works for any index now (getFnoOptionChainSummary resolves
          the symbol's own expiry via nt_fno_expiry); component self-hides with an empty state
          for indices with no F&O contracts (e.g. sectoral BSE indices). */}
      <IndexFnoOverview symbol={indexName} />

      {/* Extended MC Index Intelligence Panel — PE/PB charts, fundamentals, intraday A/D breadth */}
      <MCIndexDetailPanel indId={indexId} name={indexName} bridgeSymbol={d?.bridgeSymbol ?? ''} />

      {/* Constituent Stocks */}
      {stocks.length > 0 && (
        <div className="glass border border-slate-800/50 rounded-3xl p-6">
          <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">
            Constituent Stocks ({stocks.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-800/50">
                  <th className="text-left pb-3 pr-4">Symbol / Company</th>
                  <th className="text-right pb-3 pr-4">Price</th>
                  <th className="text-right pb-3 pr-4">Change</th>
                  <th className="text-right pb-3 pr-4">Chg%</th>
                  <th className="text-right pb-3 pr-4">Volume</th>
                  <th className="text-right pb-3">Mkt Cap (Cr)</th>
                </tr>
              </thead>
              <tbody>
                {stocks.slice(0, 50).map((s: any) => {
                  const up = s.direction === '1';
                  // Fixed 2026-07-30 (Finding #100, full-stack audit): s.id from MC's
                  // marketmap endpoint is an opaque MC ticker (e.g. "AT18"), not the NSE
                  // symbol -- matching it directly against stockData's .symbol field almost
                  // never hit, so most constituent rows navigated/displayed the wrong
                  // symbol. Reuses MCIndexDetailPanel.tsx's already-correct resolver
                  // (mcsymbol fallback, then company-name fallback) instead of duplicating
                  // a second, wrong version of the same logic.
                  const nseSym = resolveConstituentSymbol(s) || s.id;
                  return (
                    <tr
                      key={s.id}
                      onClick={() => onSelectStock(nseSym)}
                      className="border-t border-slate-800/50/40 hover:bg-slate-800/30 transition-colors cursor-pointer"
                    >
                      <td className="py-2.5 pr-4">
                        <p className="text-sm font-black text-white group-hover:text-blue-400">{nseSym}</p>
                        <p className="text-[10px] text-slate-400 font-bold">{s.shortname}</p>
                      </td>
                      <td className="py-2.5 pr-4 text-right text-sm font-black text-white tabular-nums">₹{s.lastvalue}</td>
                      <td className={cn("py-2.5 pr-4 text-right text-sm font-black tabular-nums", up ? "text-emerald-400" : "text-rose-400")}>
                        {up ? '+' : ''}{s.change}
                      </td>
                      <td className="py-2.5 pr-4 text-right">
                        <span className={cn("text-[10px] font-black px-2 py-0.5 rounded",
                          up ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                          {up ? '+' : ''}{s.percentchange}%
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-right text-[10px] font-bold text-slate-400 tabular-nums">{s.volume}</td>
                      <td className="py-2.5 text-right text-[10px] font-bold text-slate-400 tabular-nums">{s.mktcap}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
