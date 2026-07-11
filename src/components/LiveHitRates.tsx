import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { Card } from './Card';
import { Loader2, Activity } from 'lucide-react';

type Row = {
  signal_source?: string;
  regime?: string;
  horizon_days?: number;
  total?: number;
  wins?: number;
  losses?: number;
  neutrals?: number;
  stops?: number;
  win_rate?: number | null;
  decisive_rate?: number | null;
  neutral_rate?: number | null;
  avg_return?: number | null;
};

// Postgres returns ROUND()/NUMERIC as strings via node-pg — coerce everything to a number.
const N = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = (v?: unknown) => { const n = N(v); return n == null ? '—' : `${n.toFixed(1)}%`; };
const ret = (v?: unknown) => { const n = N(v); return n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; };
const int = (v?: unknown) => (N(v) ?? 0).toLocaleString();

// A live signal is healthy when it actually RESOLVES (high decisive) and wins when it does.
const decisiveColor = (v?: unknown) => { const n = N(v); return n == null ? 'text-slate-500' : n >= 60 ? 'text-emerald-400' : n >= 35 ? 'text-amber-400' : 'text-rose-400'; };
const winColor = (v?: unknown) => { const n = N(v); return n == null ? 'text-slate-500' : n >= 55 ? 'text-emerald-400' : n >= 45 ? 'text-slate-300' : 'text-rose-400'; };
const retColor = (v?: unknown) => { const n = N(v); return n == null ? 'text-slate-500' : n > 0 ? 'text-emerald-400' : 'text-rose-400'; };

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? 'text-white'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function RollupTable({ title, keyName, rows }: { title: string; keyName: 'signal_source' | 'regime'; rows: Row[] }) {
  return (
    <Card title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th className="py-1.5 pr-2">{keyName === 'signal_source' ? 'Source' : 'Regime'}</th>
              <th className="py-1.5 px-2 text-right">n</th>
              <th className="py-1.5 px-2 text-right">Decisive</th>
              <th className="py-1.5 px-2 text-right">Neutral</th>
              <th className="py-1.5 px-2 text-right">Win</th>
              <th className="py-1.5 pl-2 text-right">Avg ret</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-800/70">
                <td className="py-1.5 pr-2 font-medium text-slate-200">{(r as any)[keyName] ?? '—'}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{int(r.total)}</td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${decisiveColor(r.decisive_rate)}`}>{pct(r.decisive_rate)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{pct(r.neutral_rate)}</td>
                <td className={`py-1.5 px-2 text-right tabular-nums ${winColor(r.win_rate)}`}>{pct(r.win_rate)}</td>
                <td className={`py-1.5 pl-2 text-right tabular-nums ${retColor(r.avg_return)}`}>{ret(r.avg_return)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="py-4 text-center text-slate-500">No resolved outcomes in window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function LiveHitRates() {
  const [days, setDays] = useState<number>(180);
  const { data, isLoading, error } = trpc.getLiveHitRates.useQuery({ days, minSignals: 10 });

  const windows = [90, 180, 365];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-indigo-400" />
          <div>
            <h2 className="text-lg font-semibold text-white">Live Hit Rates</h2>
            <p className="text-xs text-slate-500">
              Emitted-signal outcomes from <code className="text-slate-400">unified_signal_outcomes</code>, by source × regime × horizon.
              A low <span className="text-rose-400">decisive</span> rate means signals expire flat before resolving.
            </p>
          </div>
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
          {windows.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                days === w ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Card title="Live Hit Rates">
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="mr-3 h-6 w-6 animate-spin" /> Loading outcomes…
          </div>
        </Card>
      ) : error || !data ? (
        <Card title="Live Hit Rates">
          <div className="text-rose-300">Unable to load hit rates. {error?.message ?? ''}</div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="Resolved signals" value={int(data.overall?.total)} sub={`last ${data.windowDays}d`} />
            <StatTile label="Decisive rate" value={pct(data.overall?.decisive_rate)} tone={decisiveColor(data.overall?.decisive_rate)} sub="resolved directionally" />
            <StatTile label="Neutral rate" value={pct(data.overall?.neutral_rate)} sub="expired flat" />
            <StatTile label="Win rate" value={pct(data.overall?.win_rate)} tone={winColor(data.overall?.win_rate)} sub="of decided" />
            <StatTile label="Avg return" value={ret(data.overall?.avg_return)} tone={retColor(data.overall?.avg_return)} />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <RollupTable title="By source" keyName="signal_source" rows={(data.bySource ?? []) as Row[]} />
            <RollupTable title="By regime" keyName="regime" rows={(data.byRegime ?? []) as Row[]} />
          </div>

          <Card title="Source × Regime × Horizon (≥10 signals)">
            <div className="max-h-[26rem] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-900">
                  <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                    <th className="py-1.5 pr-2">Source</th>
                    <th className="py-1.5 px-2">Regime</th>
                    <th className="py-1.5 px-2 text-right">Hzn</th>
                    <th className="py-1.5 px-2 text-right">n</th>
                    <th className="py-1.5 px-2 text-right">Decisive</th>
                    <th className="py-1.5 px-2 text-right">Neutral</th>
                    <th className="py-1.5 px-2 text-right">Win</th>
                    <th className="py-1.5 px-2 text-right">Stops</th>
                    <th className="py-1.5 pl-2 text-right">Avg ret</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.grid as Row[] ?? []).map((r, i) => (
                    <tr key={i} className="border-t border-slate-800/70">
                      <td className="py-1.5 pr-2 font-medium text-slate-200">{r.signal_source}</td>
                      <td className="py-1.5 px-2 text-slate-300">{r.regime}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{r.horizon_days}d</td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{int(r.total)}</td>
                      <td className={`py-1.5 px-2 text-right tabular-nums ${decisiveColor(r.decisive_rate)}`}>{pct(r.decisive_rate)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{pct(r.neutral_rate)}</td>
                      <td className={`py-1.5 px-2 text-right tabular-nums ${winColor(r.win_rate)}`}>{pct(r.win_rate)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{int(r.stops)}</td>
                      <td className={`py-1.5 pl-2 text-right tabular-nums ${retColor(r.avg_return)}`}>{ret(r.avg_return)}</td>
                    </tr>
                  ))}
                  {(data.grid as Row[] ?? []).length === 0 && (
                    <tr><td colSpan={9} className="py-4 text-center text-slate-500">No source×regime×horizon cell has ≥10 resolved signals in this window.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
