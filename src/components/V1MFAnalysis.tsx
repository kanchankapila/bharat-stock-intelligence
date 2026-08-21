import React, { useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip,
} from 'recharts';
import { Activity, PieChart } from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { Card } from './Card';

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this tab only mounts when a user opens a stock's
// MF/Ownership tab.
export const V1MFAnalysis: React.FC<{ symbol: string }> = ({ symbol }) => {
  // Finding #74 (2026-07-28 audit): this component took a `symbol` prop but never queried
  // with it — "Top Mutual Fund Holders" was 5 hardcoded identical rows and "FII/DII Trends"
  // was Math.random()-generated, both fabricated and identical for every stock. The live
  // per-fund holder breakdown endpoint (mf_holding) is confirmed dead (404) as of this fix —
  // no per-fund-name data source exists in this codebase — so this now shows the real,
  // stock-specific aggregate MF/FII/DII/promoter ownership + QoQ trend from getShareholding
  // (live-verified working) instead of inventing fund-level detail. FII/DII Trends is wired
  // to the real market-wide getFiiDiiFlow series already used elsewhere in the app.
  const { data: sh } = trpc.getShareholding.useQuery({ symbol });
  // Standardized on days:10 (2026-08-02 perf pass) -- matches the query key already used by
  // V2Dashboard/V3Dashboard/MoneyFlowPulseWidget/AlphaCockpit/TradeDecisionCockpit, so React
  // Query dedupes this into ONE shared fetch/cache entry across all of them instead of each
  // `days` variant firing its own independent request. This component only shows a 6-day
  // chart, so slice(0, 6) client-side instead of asking the server for a narrower window.
  const { data: fiiDii } = trpc.getFiiDiiFlow.useQuery({ days: 10 });

  const mfPct = (sh as any)?.summary?.mf?.percentage ?? (sh as any)?.mf_pct ?? null;
  const mfChg = (sh as any)?.summary?.mf?.changeQoQ ?? (sh as any)?.mf_chg_qoq ?? null;
  const fiiPct = (sh as any)?.summary?.fii?.percentage ?? (sh as any)?.fii_pct ?? null;
  const diiPct = (sh as any)?.summary?.dii?.percentage ?? (sh as any)?.dii_pct ?? null;
  const promPct = (sh as any)?.summary?.promoters?.percentage ?? (sh as any)?.promoter_pct ?? null;

  const flowSeries = useMemo(
    () => Array.isArray(fiiDii) ? [...fiiDii].slice(0, 6).reverse().map((r: any) => ({
      date: r.date, fii: r.fii_net, dii: r.dii_net,
    })) : [],
    [fiiDii],
  );

  return (
    <div className="space-y-6">
       <Card title={`Institutional & MF Ownership — ${symbol}`} icon={PieChart}>
          {mfPct === null && fiiPct === null ? (
            <p className="text-slate-400 text-[10px] uppercase font-bold tracking-widest text-center py-8">
              Shareholding data unavailable for {symbol}
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Mutual Funds', pct: mfPct, chg: mfChg },
                { label: 'FII', pct: fiiPct, chg: null },
                { label: 'DII', pct: diiPct, chg: null },
                { label: 'Promoters', pct: promPct, chg: null },
              ].map(row => (
                <div key={row.label} className="text-center p-3 glass-strong rounded-xl border border-slate-800/50">
                  <p className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">{row.label}</p>
                  <p className="text-xl font-black text-white italic tracking-tighter">
                    {row.pct !== null ? `${Number(row.pct).toFixed(2)}%` : '—'}
                  </p>
                  {row.chg !== null && (
                    <p className={cn("text-[9px] font-bold mt-1", Number(row.chg) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {Number(row.chg) >= 0 ? '+' : ''}{Number(row.chg).toFixed(2)}% QoQ
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
       </Card>

       <Card title="FII/DII Trends (Market-Wide)" icon={Activity}>
          {flowSeries.length === 0 ? (
            <p className="text-slate-400 text-[10px] uppercase font-bold tracking-widest text-center py-8">
              FII/DII flow data unavailable
            </p>
          ) : (
            <div className="h-48 mt-4">
               <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={flowSeries}>
                     <XAxis dataKey="date" hide />
                     <YAxis hide />
                     <Tooltip
                       contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                       itemStyle={{ fontSize: '11px', fontWeight: 'bold' }}
                     />
                     <Area type="monotone" dataKey="fii" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} name="FII Net (₹ Cr)" />
                     <Area type="monotone" dataKey="dii" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.1} name="DII Net (₹ Cr)" />
                  </AreaChart>
               </ResponsiveContainer>
            </div>
          )}
          <p className="text-[10px] text-slate-400 mt-4 italic text-center font-bold">Net FII/DII flow across the whole market, not specific to {symbol} — no per-stock FII/DII flow source exists</p>
       </Card>
    </div>
  );
};

export default V1MFAnalysis;
