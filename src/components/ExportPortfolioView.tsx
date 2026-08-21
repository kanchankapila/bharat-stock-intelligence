import React, { useState } from 'react';
import { auth } from '../lib/firebase';

export default function ExportPortfolioView() {
  const [loading, setLoading] = useState(false);
  const [picks, setPicks] = useState<any[]>([]);
  const [stats, setStats] = useState<any | null>(null);
  const [start, setStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [end, setEnd] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });


  async function fetchPicks(runBacktest = false) {
    setLoading(true);
    setStats(null);
    try {
      // /api/export-picks sits outside tRPC and requires either a same-host caller or a
      // logged-in user's Firebase ID token — see src/server/internalAuth.ts. Mirrors the same
      // header shape main.tsx's tRPC client already attaches on every request.
      const idToken = await auth.currentUser?.getIdToken();
      const resp = await fetch('/api/export-picks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({ strategy: 'composite', limit: 20, riskModel: 'risk_parity', start: runBacktest ? start : undefined, end: runBacktest ? end : undefined, runBacktest })
      });
      if (resp.status === 401) throw new Error('Sign in to export a portfolio.');
      const j = await resp.json();
      if (!j.success) throw new Error(j.error || 'Export failed');
      setPicks(j.picks || []);
      if (runBacktest) setStats(j.backtest || null);
    } catch (e: any) {
      alert('Error: ' + (e?.message || e));
    } finally { setLoading(false); }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Export Portfolio</h2>
          <p className="text-xs text-slate-400">Generate portfolio weights and optionally run a backtest</p>
        </div>
        <div className="flex items-center gap-2">
          <input className="bg-slate-800 px-2 py-1 rounded" value={start} onChange={e => setStart(e.target.value)} type="date" />
          <input className="bg-slate-800 px-2 py-1 rounded" value={end} onChange={e => setEnd(e.target.value)} type="date" />
          <button className="px-3 py-1 rounded bg-emerald-600" onClick={() => fetchPicks(false)} disabled={loading}>Generate</button>
          <button className="px-3 py-1 rounded bg-amber-600" onClick={() => fetchPicks(true)} disabled={loading}>Generate + Backtest</button>
        </div>
      </div>

      {loading && <div>Working…</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {picks.map(p => (
          <div key={p.symbol} className="v1-card p-3">
            <div className="flex justify-between items-center">
              <div>
                <div className="font-semibold">{p.symbol}</div>
                <div className="text-xs text-slate-400">Vol {p.volPct?.toFixed?.(2)}%</div>
              </div>
              <div className="text-right">
                <div className="font-data font-semibold">{(p.weight * 100).toFixed(2)}%</div>
                <div className="text-xs text-slate-500">weight</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {stats && (
        <div className="v1-card p-4">
          <h3 className="font-semibold">Backtest summary</h3>
          <pre className="text-xs overflow-auto mt-2" style={{maxHeight:300}}>{JSON.stringify(stats, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
