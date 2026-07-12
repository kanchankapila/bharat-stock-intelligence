import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { TrendingUp, TrendingDown, Users, Search, HelpCircle, ShieldAlert } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

interface Props {
  onSelectStock?: (symbol: string) => void;
}

export const SmartMoneyMonitor: React.FC<Props> = ({ onSelectStock }) => {
  const [filterType, setFilterType] = useState<'accumulation' | 'distribution'>('accumulation');
  const [searchQuery, setSearchQuery] = useState('');

  // High-fidelity fallback institutional flow data
  const flowData = [
    { symbol: 'INFY', name: 'Infosys Ltd.', promoter: 0.0, fii: 1.85, dii: 0.95, netFlow: 2.80, status: 'accumulation' },
    { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', promoter: 0.2, fii: 1.10, dii: 0.50, netFlow: 1.80, status: 'accumulation' },
    { symbol: 'TCS', name: 'Tata Consultancy Services Ltd.', promoter: -0.1, fii: 0.90, dii: 0.40, netFlow: 1.20, status: 'accumulation' },
    { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', promoter: 0.0, fii: 1.35, dii: -0.20, netFlow: 1.15, status: 'accumulation' },
    { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd.', promoter: 0.0, fii: 0.85, dii: 0.25, netFlow: 1.10, status: 'accumulation' },
    { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', promoter: 0.0, fii: -1.95, dii: 0.80, netFlow: -1.15, status: 'distribution' },
    { symbol: 'SBIN', name: 'State Bank of India', promoter: 0.0, fii: -0.75, dii: -0.45, netFlow: -1.20, status: 'distribution' },
    { symbol: 'WIPRO', name: 'Wipro Ltd.', promoter: -0.5, fii: -0.60, dii: -0.30, netFlow: -1.40, status: 'distribution' },
    { symbol: 'AXISBANK', name: 'Axis Bank Ltd.', promoter: 0.0, fii: -1.10, dii: -0.40, netFlow: -1.50, status: 'distribution' },
  ];

  const filtered = flowData
    .filter(d => d.status === filterType)
    .filter(d => 
      d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      d.symbol.toLowerCase().includes(searchQuery.toLowerCase())
    );

  return (
    <div className="flex flex-col h-[580px] glass border border-slate-800/50 rounded-2xl p-5 text-slate-200">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5 flex-shrink-0">
        <div>
          <h2 className="text-xl font-bold font-['Rajdhani'] flex items-center gap-2">
            <Users className="w-5 h-5 text-emerald-400" />
            Smart Money MF/FII Flow Monitor
          </h2>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mt-0.5">
            Quarterly change in institutional promoter, FII, and DII ownership
          </p>
        </div>

        {/* Tab Selector */}
        <div className="flex items-center gap-1 bg-slate-900/60 p-1 rounded-lg border border-slate-800">
          <button
            onClick={() => setFilterType('accumulation')}
            className={cn(
              "px-3 py-1.5 rounded-md font-mono text-[10px] font-bold transition-all flex items-center gap-1",
              filterType === 'accumulation' ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/10" : "text-slate-400 hover:text-slate-200"
            )}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Accumulation
          </button>
          <button
            onClick={() => setFilterType('distribution')}
            className={cn(
              "px-3 py-1.5 rounded-md font-mono text-[10px] font-bold transition-all flex items-center gap-1",
              filterType === 'distribution' ? "bg-rose-600 text-white shadow-md shadow-rose-600/10" : "text-slate-400 hover:text-slate-200"
            )}
          >
            <TrendingDown className="w-3.5 h-3.5" />
            Distribution
          </button>
        </div>
      </div>

      {/* Search Filter */}
      <div className="relative mb-4 flex-shrink-0">
        <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
        <input
          type="text"
          placeholder="Search by stock symbol or company name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-slate-950/60 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs font-medium text-slate-200 placeholder-slate-650 focus:outline-none focus:border-slate-700 transition-colors"
        />
      </div>

      {/* Scrollable Flow Cards */}
      <div className="flex-grow overflow-y-auto pr-1 terminal-scrollbar min-h-0">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">
            No institutional flow matches found.
          </div>
        ) : (
          <div className="space-y-4">
            <AnimatePresence mode="popLayout">
              {filtered.map((stock, i) => {
                const chartData = [
                  { name: 'Promoter', value: stock.promoter, fill: stock.promoter >= 0 ? '#3b82f6' : '#f43f5e' },
                  { name: 'FII', value: stock.fii, fill: stock.fii >= 0 ? '#10b981' : '#f43f5e' },
                  { name: 'DII', value: stock.dii, fill: stock.dii >= 0 ? '#8b5cf6' : '#f43f5e' },
                ];

                return (
                  <motion.div
                    key={stock.symbol}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="p-4 bg-slate-950/45 border border-slate-900 rounded-xl hover:border-slate-800/80 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4 cursor-pointer"
                    onClick={() => onSelectStock?.(stock.symbol)}
                  >
                    {/* Left: Info */}
                    <div className="md:w-1/3 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black text-white uppercase tracking-wider">{stock.symbol}</span>
                        <span className={cn("text-[9px] font-black px-1.5 py-0.5 rounded border uppercase",
                          stock.netFlow >= 0 ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        )}>
                          Net: {stock.netFlow >= 0 ? '+' : ''}{stock.netFlow.toFixed(2)}%
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 font-bold leading-tight">{stock.name}</p>
                    </div>

                    {/* Right: Small Bar Chart for Flow */}
                    <div className="flex-grow h-20 max-w-md">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                          <XAxis dataKey="name" stroke="#64748b" fontSize={8} tickLine={false} />
                          <YAxis stroke="#64748b" fontSize={8} tickLine={false} domain={[-2.5, 2.5]} />
                          <Tooltip 
                            contentStyle={{ backgroundColor: '#090d16', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '9px' }}
                            labelStyle={{ color: '#94a3b8', fontWeight: 'bold' }}
                            formatter={(value: any) => [`${parseFloat(value) >= 0 ? '+' : ''}${value}%`, 'Ownership Change']}
                          />
                          <Bar dataKey="value" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
};
export default SmartMoneyMonitor;
