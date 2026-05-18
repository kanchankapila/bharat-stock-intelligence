import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { 
  TrendingUp, TrendingDown, RefreshCw, Layers, ShieldAlert,
  ArrowUpRight, ArrowDownRight, Award, CircleDollarSign
} from 'lucide-react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer 
} from 'recharts';

export const SmartMoneyFlowPage: React.FC<{ onSelectStock: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const { data: dashboard, isLoading: dashboardLoading, refetch: refetchDashboard } = trpc.getSmartMoneyDashboardData.useQuery();
  const { data: bulkDeals, isLoading: bulkLoading, refetch: refetchDeals } = trpc.getBulkDealsData.useQuery({});
  const { data: insiderTrades, isLoading: insiderLoading, refetch: refetchInsiders } = trpc.getInsiderTradesData.useQuery({});

  const syncMutation = trpc.syncSmartMoney.useMutation({
    onSuccess: (res) => {
      setIsSyncing(false);
      setSyncStatus(`Successfully synced ${res.bulkDealsSynced} bulk deals and ${res.insiderTradesSynced} promoter trades!`);
      refetchDashboard();
      refetchDeals();
      refetchInsiders();
      setTimeout(() => setSyncStatus(null), 5000);
    },
    onError: (err) => {
      setIsSyncing(false);
      setSyncStatus(`Sync failed: ${err.message}`);
      setTimeout(() => setSyncStatus(null), 5000);
    }
  });

  const handleManualSync = () => {
    setIsSyncing(true);
    setSyncStatus('Initiating corporate filings scraping...');
    syncMutation.mutate();
  };

  const isLoading = dashboardLoading || bulkLoading || insiderLoading;

  if (isLoading) {
    return (
      <div className="py-48 flex flex-col items-center justify-center space-y-6">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 border-2 border-indigo-500/20 rounded-full" />
          <div className="absolute inset-0 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] animate-pulse">Scanning Institutional Filings...</p>
      </div>
    );
  }

  const netBuys = dashboard?.institutionalNetBuys || [];
  const promoterBuys = dashboard?.promoterAccumulations || [];

  return (
    <div className="p-6 space-y-6">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h2 className="text-3xl font-black text-white italic tracking-tighter uppercase flex items-center gap-3">
            <CircleDollarSign className="w-8 h-8 text-indigo-400" />
            Smart Money Flow Tracker
          </h2>
          <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1 italic">
            Analyzing corporate insider trade filings and institutional block deals
          </p>
        </div>

        <div className="flex items-center gap-4">
          {syncStatus && (
            <span className="text-[10px] font-bold text-slate-400 bg-slate-900 border border-slate-800 px-4 py-2.5 rounded-xl">
              {syncStatus}
            </span>
          )}
          <button
            onClick={handleManualSync}
            disabled={isSyncing}
            className="flex items-center gap-2 bg-gradient-to-r from-indigo-500 to-violet-600 text-white px-5 py-3 rounded-2xl text-[10px] font-black tracking-widest transition-all hover:shadow-[0_0_20px_rgba(99,102,241,0.4)] disabled:opacity-50 uppercase"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing...' : 'Sync Corporate Filings'}
          </button>
        </div>
      </div>

      {/* Overview stats cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Institutional FII/DII Buys */}
        <div className="p-5 bg-slate-900/60 border border-slate-800 rounded-3xl space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <Award className="w-4 h-4 text-amber-500" /> FII/DII Net Accumulation Leaders
            </h3>
            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">30-day window</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {netBuys.slice(0, 4).map((item: any) => (
              <div 
                key={item.symbol} 
                onClick={() => onSelectStock(item.symbol)}
                className="p-3 bg-slate-950 border border-slate-800/80 rounded-2xl hover:border-slate-700 transition-all cursor-pointer flex justify-between items-center"
              >
                <div>
                  <p className="text-xs font-black text-white">{item.symbol}</p>
                  <p className="text-[9px] text-emerald-400 font-bold mt-0.5">₹{item.netValueCr.toFixed(1)} Cr Net Buy</p>
                </div>
                <ArrowUpRight className="w-4 h-4 text-emerald-500" />
              </div>
            ))}
          </div>
        </div>

        {/* Promoter Accumulations */}
        <div className="p-5 bg-slate-900/60 border border-slate-800 rounded-3xl space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-400" /> Promoter Insider buying signals
            </h3>
            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Acquisition Filings</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {promoterBuys.slice(0, 4).map((item: any) => (
              <div 
                key={item.symbol} 
                onClick={() => onSelectStock(item.symbol)}
                className="p-3 bg-slate-950 border border-slate-800/80 rounded-2xl hover:border-slate-700 transition-all cursor-pointer flex justify-between items-center"
              >
                <div>
                  <p className="text-xs font-black text-white">{item.symbol}</p>
                  <p className="text-[9px] text-indigo-400 font-bold mt-0.5">₹{(item.netPromoterValueInr / 10_000_000).toFixed(2)} Cr</p>
                </div>
                <ArrowUpRight className="w-4 h-4 text-indigo-500" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Chart Panel */}
      {bulkDeals && bulkDeals.length > 0 && (
        <div className="p-5 bg-slate-900/40 border border-slate-800/60 rounded-3xl space-y-4">
          <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">FII/DII Institutional Block Deal Flow Intensity</h3>
          <div className="h-64 pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={bulkDeals.slice().reverse().map((d: any) => ({
                date: d.date,
                valueCr: d.valueCr
              }))}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" stroke="#475569" fontSize={9} tickLine={false} />
                <YAxis stroke="#475569" fontSize={9} tickLine={false} unit="Cr" />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                  itemStyle={{ fontSize: '11px', fontWeight: 'bold' }}
                />
                <Area type="monotone" dataKey="valueCr" stroke="#6366f1" fill="#6366f1" fillOpacity={0.08} name="Transaction Value" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Dual Table Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Bulk Deals */}
        <div className="xl:col-span-7 bg-slate-950 border border-slate-800/80 rounded-3xl overflow-hidden flex flex-col">
          <div className="p-5 border-b border-slate-800 bg-slate-900/40 flex justify-between items-center">
            <h3 className="text-xs font-black text-white uppercase tracking-wider">Institutional Bulk/Block Deals</h3>
            <span className="text-[8px] bg-slate-800 text-slate-300 font-bold px-2 py-1 rounded-md uppercase">NSE/BSE</span>
          </div>

          <div className="overflow-x-auto max-h-[400px]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-900/30 border-b border-slate-800/60">
                  <th className="px-4 py-3 text-[8px] font-black text-slate-500 uppercase tracking-widest">Asset</th>
                  <th className="px-4 py-3 text-[8px] font-black text-slate-500 uppercase tracking-widest">Investor Client</th>
                  <th className="px-4 py-3 text-[8px] font-black text-slate-500 uppercase tracking-widest text-center">Type</th>
                  <th className="px-4 py-3 text-[8px] font-black text-slate-500 uppercase tracking-widest text-right">Value (Cr)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/20">
                {bulkDeals && bulkDeals.map((deal: any, i: number) => (
                  <tr 
                    key={i} 
                    onClick={() => onSelectStock(deal.symbol)}
                    className="hover:bg-slate-900/20 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3.5">
                      <span className="text-xs font-black text-white group-hover:text-indigo-400">{deal.symbol}</span>
                      <span className="block text-[8px] text-slate-500 font-semibold mt-0.5">{deal.date}</span>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-300 truncate max-w-[150px] font-medium">{deal.clientName}</td>
                    <td className="px-4 py-3.5 text-center">
                      <span className={`text-[8px] font-black px-2 py-1 rounded-md border ${
                        deal.dealType === 'BUY' 
                          ? 'text-emerald-400 bg-emerald-400/5 border-emerald-400/10' 
                          : 'text-rose-400 bg-rose-400/5 border-rose-400/10'
                      }`}>
                        {deal.dealType}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-black text-xs text-white">₹{deal.valueCr.toFixed(2)} Cr</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Insider Transactions */}
        <div className="xl:col-span-5 bg-slate-950 border border-slate-800/80 rounded-3xl overflow-hidden flex flex-col">
          <div className="p-5 border-b border-slate-800 bg-slate-900/40 flex justify-between items-center">
            <h3 className="text-xs font-black text-white uppercase tracking-wider">Promoter Holdings Changes</h3>
            <span className="text-[8px] bg-slate-800 text-slate-300 font-bold px-2 py-1 rounded-md uppercase">SEBI Filings</span>
          </div>

          <div className="overflow-x-auto max-h-[400px]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-900/30 border-b border-slate-800/60">
                  <th className="px-4 py-3 text-[8px] font-black text-slate-500 uppercase tracking-widest">Asset</th>
                  <th className="px-4 py-3 text-[8px] font-black text-slate-500 uppercase tracking-widest">Acquirer/Category</th>
                  <th className="px-4 py-3 text-[8px] font-black text-slate-500 uppercase tracking-widest text-right">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/20">
                {insiderTrades && insiderTrades.map((t: any, i: number) => (
                  <tr 
                    key={i} 
                    onClick={() => onSelectStock(t.symbol)}
                    className="hover:bg-slate-900/20 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3.5">
                      <span className="text-xs font-black text-white group-hover:text-indigo-400">{t.symbol}</span>
                      <span className="block text-[8px] text-slate-500 font-semibold mt-0.5">{t.date}</span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="text-xs text-slate-300 font-semibold block truncate max-w-[150px]">{t.acquirerName}</span>
                      <span className="text-[8px] font-black uppercase text-indigo-400 mt-0.5 block">{t.category} ({t.typeOfTransaction})</span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-black text-xs text-white">
                      ₹{Math.abs(t.valueInr || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
