import React from 'react';
import { trpc } from '../lib/trpc';
import { Card } from './Card';
import { Loader2, Users } from 'lucide-react';

const n1 = (v?: number | null) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
const n2 = (v?: number | null) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
const money = (cr?: number | null) => {
  if (cr == null || !Number.isFinite(cr)) return '—';
  return cr >= 100000 ? `₹${(cr / 100000).toFixed(2)}L Cr` : `₹${cr.toLocaleString(undefined, { maximumFractionDigits: 0 })} Cr`;
};
const chgColor = (v?: number | null) => (v == null ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-rose-400');

export function FinologyPanel({ symbol }: { symbol: string }) {
  const { data, isLoading, error } = trpc.getFinologyData.useQuery({ symbol }, { enabled: !!symbol });

  if (isLoading) {
    return (
      <Card title="Finology — Valuation & Peers" icon={Users}>
        <div className="flex items-center justify-center py-10 text-slate-400">
          <Loader2 className="mr-3 h-5 w-5 animate-spin" /> Loading Finology data…
        </div>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card title="Finology — Valuation & Peers" icon={Users}>
        <div className="text-sm text-slate-500">No Finology data for {symbol} (needs a mapped fincode).</div>
      </Card>
    );
  }

  const pes = data.peHistory.map((p) => p.pe).filter((x): x is number => x != null);
  const curPe = pes[0] ?? null;
  const loPe = pes.length ? Math.min(...pes) : null;
  const hiPe = pes.length ? Math.max(...pes) : null;
  // Where the current PE sits in its own 1-year range (0 = cheapest, 100 = priciest).
  const pePctile = curPe != null && loPe != null && hiPe != null && hiPe > loPe
    ? Math.round(((curPe - loPe) / (hiPe - loPe)) * 100) : null;

  return (
    <Card title="Finology — Valuation & Peers" icon={Users}>
      <div className="space-y-4">
        {curPe != null && (
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3 text-sm">
            <div><span className="text-slate-500">PE now </span><span className="font-semibold text-white">{n1(curPe)}</span></div>
            <div><span className="text-slate-500">1Y range </span><span className="text-slate-300">{n1(loPe)}–{n1(hiPe)}</span></div>
            {pePctile != null && (
              <div className="flex items-center gap-2">
                <span className="text-slate-500">1Y valuation</span>
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-800">
                  <div className={`h-full ${pePctile > 70 ? 'bg-rose-500' : pePctile < 30 ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${pePctile}%` }} />
                </div>
                <span className="text-xs text-slate-400">{pePctile}%ile</span>
              </div>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                <th className="py-1.5 pr-2">Peer</th>
                <th className="py-1.5 px-2 text-right">Price</th>
                <th className="py-1.5 px-2 text-right">Chg</th>
                <th className="py-1.5 px-2 text-right">PE</th>
                <th className="py-1.5 px-2 text-right">PB</th>
                <th className="py-1.5 px-2 text-right">EPS</th>
                <th className="py-1.5 px-2 text-right">EV/EBITDA</th>
                <th className="py-1.5 pl-2 text-right">Mkt Cap</th>
              </tr>
            </thead>
            <tbody>
              {data.peers.map((p, i) => (
                <tr key={i} className="border-t border-slate-800/70">
                  <td className="py-1.5 pr-2">
                    <div className="font-medium text-slate-200">{p.symbol ?? '—'}</div>
                    <div className="truncate text-[11px] text-slate-500" style={{ maxWidth: 160 }}>{p.name}</div>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-slate-300">{n2(p.close)}</td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${chgColor(p.chgPct)}`}>{p.chgPct == null ? '—' : `${p.chgPct >= 0 ? '+' : ''}${n2(p.chgPct)}%`}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-slate-300">{n1(p.pe)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{n1(p.pb)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{n1(p.eps)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{n1(p.evEbitda)}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-slate-300">{money(p.mcapCr)}</td>
                </tr>
              ))}
              {data.peers.length === 0 && (
                <tr><td colSpan={8} className="py-4 text-center text-slate-500">No peer data.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {data.brief && (
          <p className="text-xs leading-relaxed text-slate-400 line-clamp-4">{data.brief}</p>
        )}
      </div>
    </Card>
  );
}
