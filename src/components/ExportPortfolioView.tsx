import React, { useState } from 'react';
import { auth } from '../lib/firebase';
import { Download, Calendar, Play } from 'lucide-react';

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
    <div className="v1-page space-y-6">
      <div className="v1-header">
        <div className="v1-header-left">
          <h1 className="v1-title-page flex items-center gap-2.5">
            <Download className="w-6 h-6 text-emerald-400" /> Export Portfolio
          </h1>
          <p className="text-slate-400 text-sm mt-1">Generate portfolio weights and optionally run a backtest</p>
        </div>
        <div className="v1-header-actions">
          <div className="flex flex-wrap items-center gap-2">
            <input className="v1-input text-xs w-auto font-data" value={start} onChange={e => setStart(e.target.value)} type="date" />
            <input className="v1-input text-xs w-auto font-data" value={end} onChange={e => setEnd(e.target.value)} type="date" />
            <button className="v1-btn-primary" onClick={() => fetchPicks(false)} disabled={loading}>
              <Download className="w-4 h-4" /> Generate
            </button>
            <button className="v1-btn-secondary text-amber-400 border-amber-500/30 hover:bg-amber-500/10" onClick={() => fetchPicks(true)} disabled={loading}>
              <Play className="w-4 h-4" /> Generate + Backtest
            </button>
          </div>
        </div>
      </div>

      {loading && <div className="v1-card p-6 text-sm text-slate-400 font-data animate-pulse">Generating portfolio weights & running backtest...</div>}

      {picks.length > 0 && (
        <div className="v1-grid-4">
          {picks.map(p => (
            <div key={p.symbol} className="v1-card p-4 flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div>
                  <span className="font-bold text-white font-display text-base tracking-wide">{p.symbol}</span>
                  <p className="text-xs text-slate-400 font-data mt-0.5">Vol {p.volPct?.toFixed?.(2)}%</p>
                </div>
                <div className="text-right">
                  <span className="v1-data-value text-emerald-400 text-lg">{(p.weight * 100).toFixed(2)}%</span>
                  <p className="v1-data-label mt-0.5">Weight</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {stats && (
        <div className="v1-card p-5">
          <h3 className="v1-title-card mb-3">Backtest Summary</h3>
          <pre className="text-xs text-slate-300 font-data bg-black/40 p-4 rounded-lg border border-white/10 overflow-auto max-h-80">{JSON.stringify(stats, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
