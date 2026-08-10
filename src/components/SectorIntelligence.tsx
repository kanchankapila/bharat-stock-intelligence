import React, { useState } from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { PieChart, TrendingUp, TrendingDown, Activity, Building2 } from 'lucide-react';
import { resolveConstituentSymbol } from '../lib/resolveConstituentSymbol';

export const SectorHeatmap: React.FC<{ indexId?: string; className?: string }> = ({ indexId, className }) => {
  const { data: sectors, isLoading, isError } = trpc.getSectorPerformance.useQuery({ indexId }, {
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
  });

  // Distinguish "still loading" from "settled with no/errored data" — isLoading only covers
  // the pre-settlement window, so this used to pulse the skeleton forever on a real failure.
  const settledEmpty = !isLoading && (isError || !sectors || sectors.length === 0);

  if (isLoading) return <div className={cn("h-72 bg-slate-900/50 animate-pulse rounded-2xl", className)} />;

  return (
    <Card title="Sector Heatmap" icon={PieChart} className={cn("h-full", className)}>
      {settledEmpty ? (
        <div className="text-xs text-slate-500 py-6 text-center">No sector performance data available right now.</div>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-2">
        {sectors!.map((sector) => (
          <div 
            key={sector.name}
            className={cn(
              "p-2 rounded-lg border flex flex-col justify-between transition-all hover:scale-[1.02]",
              sector.change >= 0 
                ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400" 
                : "bg-rose-500/5 border-rose-500/20 text-rose-400"
            )}
          >
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{sector.name}</span>
            <div className="flex items-end justify-between mt-1">
              <span className="text-base font-black italic tracking-tighter truncate">
                {sector.change >= 0 ? '+' : ''}{sector.change.toFixed(2)}%
              </span>
              <span className="text-[7px] font-bold text-slate-500">{sector.stocks}</span>
            </div>
          </div>
        ))}
      </div>
      )}
    </Card>
  );
};

export const SectorPerformance: React.FC<{ className?: string }> = ({ className }) => {
  const { data, isLoading } = trpc.getMarketMapData.useQuery({ indId: '38' }); // Energy by default

  if (isLoading || !data) return <div className="h-40 bg-slate-900/50 animate-pulse rounded-2xl" />;

  const sectors = (data as any)?.item || [];

  return (
    <Card title="Market Map (Sectors)" icon={PieChart} className={cn("h-full", className)}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {sectors.slice(0, 8).map((s: any) => (
          <div key={s.id} className="p-3 bg-slate-950 border border-slate-800 rounded-xl hover:border-slate-700 transition-all">
            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">{s.shortname}</p>
            <div className="flex items-center justify-between">
              <p className={cn(
                "text-base font-black italic tracking-tighter",
                s.direction === "1" ? "text-emerald-400" : "text-rose-400"
              )}>
                {s.percentchange}%
              </p>
              <div className={cn(
                "p-0.5 rounded",
                s.direction === "1" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
              )}>
                {s.direction === "1" ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
              </div>
            </div>
            <p className="text-[7px] text-slate-600 font-bold uppercase mt-1">Cap: ₹{s.mktcap} Cr</p>
          </div>
        ))}
      </div>
    </Card>
  );
};

// Sector-wise advance/decline breadth (MC ad-ratio/category-wise-list) -- how many
// constituents of each sectoral index are up vs down right now, a different cut than
// SectorHeatmap's price-return ranking. Replaces the market-map page's old TradingView
// heatmap embed, which loaded a third-party script with no fallback when it failed silently.
export const SectorAdvanceDecline: React.FC<{ className?: string }> = ({ className }) => {
  const { data, isLoading } = trpc.getSectorAdvanceDecline.useQuery(undefined, { refetchInterval: 30000 });
  const rows: any[] = (data as any)?.data ?? [];

  if (isLoading) return <div className={cn("h-72 bg-slate-900/50 animate-pulse rounded-2xl", className)} />;
  if (rows.length === 0) {
    return (
      <Card title="Sector Advance / Decline" icon={Activity} className={className}>
        <div className="text-xs text-slate-500 py-6 text-center">No sector breadth data available right now.</div>
      </Card>
    );
  }

  return (
    <Card title="Sector Advance / Decline" icon={Activity} className={cn("h-full", className)}>
      <div className="space-y-2 pt-2">
        {rows.map((s: any) => {
          const adv = Number(s.advance ?? 0);
          const dec = Number(s.decline ?? 0);
          const total = adv + dec || 1;
          const up = parseFloat(s.changePer ?? '0') >= 0;
          return (
            <div key={s.indexId ?? s.indexName} className="flex items-center gap-3">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 w-32 truncate shrink-0">
                {s.indexName}
              </span>
              <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden flex">
                <div className="h-full bg-emerald-500" style={{ width: `${(adv / total) * 100}%` }} />
                <div className="h-full bg-rose-500" style={{ width: `${(dec / total) * 100}%` }} />
              </div>
              <span className="text-[10px] font-bold text-emerald-400 w-6 text-right">{adv}</span>
              <span className="text-[10px] font-bold text-rose-400 w-6 text-right">{dec}</span>
              <span className={cn("text-[10px] font-black w-14 text-right", up ? "text-emerald-400" : "text-rose-400")}>
                {up ? '+' : ''}{s.changePer}%
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// Live-verified MC sector taxonomy slugs (sector/get-all-stocks/financials?slug=) -- several
// obvious guesses (it/pharma/auto/cement/media/construction) 404 under different, unverified
// spellings, so this list is only the ones actually confirmed live rather than a guessed
// full sector list.
const SECTOR_SLUGS: { slug: string; label: string }[] = [
  { slug: 'finance',       label: 'Finance' },
  { slug: 'banks',         label: 'Banks' },
  { slug: 'fmcg',          label: 'FMCG' },
  { slug: 'oil-gas',       label: 'Oil & Gas' },
  { slug: 'power',         label: 'Power' },
  { slug: 'metals-mining', label: 'Metals & Mining' },
  { slug: 'healthcare',    label: 'Healthcare' },
  { slug: 'capital-goods', label: 'Capital Goods' },
  { slug: 'telecom',       label: 'Telecom' },
  { slug: 'chemicals',     label: 'Chemicals' },
  { slug: 'textiles',      label: 'Textiles' },
  { slug: 'infrastructure', label: 'Infrastructure' },
];

// Sector -> constituent-stock mapping with per-stock financials -- "sector mappings", not
// just a sector-level number. onSelectStock resolution reuses the same stockName-based match
// already proven in MCIndexDetailPanel.tsx's resolveConstituentSymbol, since this endpoint's
// `scId` is an opaque MC code (e.g. "BAF"), not the NSE ticker.
export const SectorConstituents: React.FC<{ onSelectStock?: (symbol: string) => void; className?: string }> = ({ onSelectStock, className }) => {
  const [slug, setSlug] = useState(SECTOR_SLUGS[0].slug);
  const { data, isLoading } = trpc.getSectorStocks.useQuery({ slug });
  const sectorData = (data as any)?.data;
  const stocks: any[] = sectorData?.data ?? [];

  return (
    <Card
      title="Sector Constituents"
      icon={Building2}
      className={className}
      action={
        <select
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="bg-slate-900 border border-slate-800 rounded-lg text-[10px] font-bold text-slate-300 px-2 py-1 outline-none"
        >
          {SECTOR_SLUGS.map((s) => <option key={s.slug} value={s.slug}>{s.label}</option>)}
        </select>
      }
    >
      {isLoading ? (
        <div className="h-48 animate-pulse bg-slate-900/50 rounded-xl" />
      ) : stocks.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">No data available for this sector right now.</div>
      ) : (
        <div className="overflow-x-auto pt-2">
          <table className="w-full">
            <thead>
              <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800/50">
                <th className="text-left pb-2 pr-3">Stock</th>
                <th className="text-right pb-2 pr-3">Price</th>
                <th className="text-right pb-2 pr-3">Chg%</th>
                <th className="text-right pb-2 pr-3">Mkt Cap (Cr)</th>
                <th className="text-right pb-2 pr-3">Div Yield</th>
                <th className="text-right pb-2">Trend</th>
              </tr>
            </thead>
            <tbody>
              {stocks.slice(0, 20).map((s: any, i: number) => {
                const up = parseFloat(s.perChange ?? '0') >= 0;
                const nseSym = resolveConstituentSymbol({ id: s.scId, shortname: s.stockName });
                const clickable = !!onSelectStock && !!nseSym;
                return (
                  <tr
                    key={i}
                    onClick={() => clickable && onSelectStock!(nseSym!)}
                    className={cn("border-t border-slate-800/40", clickable ? "cursor-pointer hover:bg-slate-800/30" : "")}
                  >
                    <td className="py-2 pr-3 text-xs font-bold text-slate-200">{s.stockName}</td>
                    <td className="py-2 pr-3 text-right text-xs font-mono text-slate-100">₹{s.currPrice}</td>
                    <td className={cn("py-2 pr-3 text-right text-xs font-bold", up ? "text-emerald-400" : "text-rose-400")}>
                      {up ? '+' : ''}{s.perChange}%
                    </td>
                    <td className="py-2 pr-3 text-right text-[10px] text-slate-400">{s.marketCap}</td>
                    <td className="py-2 pr-3 text-right text-[10px] text-slate-400">{s.dividendYield}%</td>
                    <td className="py-2 text-right text-[9px] font-bold text-slate-400">{s.techTrend ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};
