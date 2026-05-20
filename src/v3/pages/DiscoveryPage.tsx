import React from 'react';
import TrendlyneScreenerPanel from '../../components/TrendlyneScreenerPanel';
import { TrendlyneSectorDashboard } from '../../components/TrendlyneSectorDashboard';
import { ShieldAlert, Info } from 'lucide-react';

const DiscoveryPage: React.FC = () => {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            Screener & Discovery
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            Institutional-grade screeners, sector rotation, and anomaly detection.
          </p>
        </div>
        
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-lg">
          <Info className="w-4 h-4" />
          Live Trendlyne Integration Active
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Main Screener Area */}
        <div className="xl:col-span-2 space-y-6">
          <TrendlyneScreenerPanel watchlist={[]} onToggleWatchlist={() => {}} />
        </div>

        {/* Sector Rotation & Themes */}
        <div className="xl:col-span-1 space-y-6">
          <TrendlyneSectorDashboard />
        </div>
      </div>
    </div>
  );
};

export default DiscoveryPage;
