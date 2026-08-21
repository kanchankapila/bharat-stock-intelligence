import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { Bell, Plus, X, TrendingUp, TrendingDown } from 'lucide-react';

export const PriceAlertsPanel: React.FC<{ userId?: string; defaultSymbol?: string }> = ({ userId, defaultSymbol }) => {
  const [symbol, setSymbol] = useState(defaultSymbol || '');
  const [condition, setCondition] = useState<'ABOVE' | 'BELOW'>('ABOVE');
  const [threshold, setThreshold] = useState('');

  const utils = trpc.useContext();
  const { data: alerts = [], isLoading } = trpc.getMyPriceAlerts.useQuery(
    undefined,
    { enabled: !!userId, staleTime: 30_000, refetchInterval: 60_000 }
  );

  const create = trpc.createPriceAlert.useMutation({
    onSuccess: () => {
      utils.getMyPriceAlerts.invalidate();
      setThreshold('');
    },
  });
  const cancel = trpc.cancelPriceAlert.useMutation({
    onSuccess: () => utils.getMyPriceAlerts.invalidate(),
  });

  if (!userId) {
    return (
      <div className="v1-card p-5 text-xs text-slate-500 font-data">
        Sign in to set price alerts.
      </div>
    );
  }

  const activeAlerts = alerts.filter((a: any) => a.status === 'ACTIVE');
  const triggeredAlerts = alerts.filter((a: any) => a.status === 'TRIGGERED').slice(0, 10);

  const handleCreate = () => {
    const t = parseFloat(threshold);
    if (!symbol.trim() || !Number.isFinite(t) || t <= 0) return;
    create.mutate({ symbol: symbol.trim().toUpperCase(), condition, thresholdPrice: t });
  };

  return (
    <div className="v1-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Bell className="w-5 h-5 text-amber-400" />
        <h3 className="text-sm font-bold text-slate-100 font-display uppercase tracking-widest">Price Alerts</h3>
      </div>

      {/* Create form */}
      <div className="flex flex-wrap gap-2 mb-5">
        <input
          type="text"
          placeholder="Symbol"
          value={symbol}
          onChange={e => setSymbol(e.target.value.toUpperCase())}
          className="w-28 bg-slate-950 border border-slate-800 text-slate-200 text-xs font-data rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
        />
        <select
          value={condition}
          onChange={e => setCondition(e.target.value as 'ABOVE' | 'BELOW')}
          className="bg-slate-950 border border-slate-800 text-slate-200 text-xs font-data rounded-lg px-3 py-2 focus:outline-none"
        >
          <option value="ABOVE">Goes above</option>
          <option value="BELOW">Falls below</option>
        </select>
        <input
          type="number"
          placeholder="₹ price"
          value={threshold}
          onChange={e => setThreshold(e.target.value)}
          className="w-28 bg-slate-950 border border-slate-800 text-slate-200 text-xs font-data rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
        />
        <button
          onClick={handleCreate}
          disabled={create.isPending}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" /> Add Alert
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-slate-500 font-data">Loading alerts&hellip;</p>
      ) : (
        <div className="space-y-4">
          {activeAlerts.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-slate-500 font-display uppercase tracking-wider mb-2">Active ({activeAlerts.length})</p>
              <div className="space-y-1.5">
                {activeAlerts.map((a: any) => (
                  <div key={a.id} className="flex items-center justify-between bg-slate-950/50 border border-slate-800/60 rounded-lg px-3 py-2">
                    <span className="text-xs font-data text-slate-200 flex items-center gap-1.5">
                      {a.condition === 'ABOVE' ? <TrendingUp className="w-3 h-3 text-emerald-400" /> : <TrendingDown className="w-3 h-3 text-rose-400" />}
                      <b>{a.symbol}</b> {a.condition === 'ABOVE' ? '≥' : '≤'} ₹{a.thresholdPrice}
                    </span>
                    <button onClick={() => cancel.mutate({ id: a.id })} className="text-slate-500 hover:text-rose-400">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {triggeredAlerts.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-slate-500 font-display uppercase tracking-wider mb-2">Recently Triggered</p>
              <div className="space-y-1.5">
                {triggeredAlerts.map((a: any) => (
                  <div key={a.id} className="flex items-center justify-between bg-slate-950/30 border border-slate-800/40 rounded-lg px-3 py-2 opacity-70">
                    <span className="text-xs font-data text-slate-400">
                      <b>{a.symbol}</b> {a.condition === 'ABOVE' ? 'crossed above' : 'fell below'} ₹{a.thresholdPrice} — hit ₹{a.triggeredPrice?.toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-600">{a.triggeredAt ? new Date(a.triggeredAt).toLocaleDateString('en-IN') : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {activeAlerts.length === 0 && triggeredAlerts.length === 0 && (
            <p className="text-xs text-slate-500 font-data">No alerts yet — add one above.</p>
          )}
        </div>
      )}
    </div>
  );
};

export default PriceAlertsPanel;
