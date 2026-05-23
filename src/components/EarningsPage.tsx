import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { TrendingUp, Calendar, Zap, BarChart2, RefreshCw } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine
} from 'recharts';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

interface EarningsPageProps {
  onSelectStock?: (symbol: string) => void;
}

type EarningsTab = 'today' | 'calendar' | 'beatmiss' | 'shockers';

const EARNINGS_TABS: { key: EarningsTab; label: string; icon: React.ElementType }[] = [
  { key: 'today',    label: "Today's Results", icon: Zap       },
  { key: 'calendar', label: 'Calendar',         icon: Calendar  },
  { key: 'beatmiss', label: 'Beat / Miss',      icon: BarChart2 },
  { key: 'shockers', label: 'Price Shockers',   icon: TrendingUp},
];

export const EarningsPage: React.FC<EarningsPageProps> = ({ onSelectStock }) => {
  const [activeTab, setActiveTab] = useState<EarningsTab>('today');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);

  const { data, isLoading, refetch } = trpc.getEarnings.useQuery(
    { date: selectedDate },
    { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full" />
    </div>
  );

  const d = data as any;
  const dashboard = d?.dashboard?.data;
  const calendarList: any[] = d?.calendar?.data?.resultCalendar || [];
  const earningsList: any[] = d?.earningsData?.data?.earningsData || d?.earningsData?.data?.list || [];
  const rapidBPList: any[] = d?.rapidBP?.data?.list || [];
  const priceShockerList: any[] = d?.priceShockers?.data?.list || [];
  const actualEstimateList: any[] = d?.actualEstimate?.data?.list || [];

  const beatMissData = rapidBPList.slice(0, 12).map((item: any) => ({
    name: item.companyShortName || item.symbol || (item.companyName || '').slice(0, 8),
    actual: parseFloat(item.actual || item.actualGrowth || 0),
    estimate: parseFloat(item.estimate || item.estimateGrowth || 0),
  }));

  const shockerData = priceShockerList.slice(0, 10).map((item: any) => ({
    name: item.companyShortName || item.symbol || (item.companyName || '').slice(0, 8),
    chg: parseFloat(item.pChange || item.change || 0),
  })).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black text-white">Earnings Tracker</h1>
          <p className="text-sm text-slate-400 mt-0.5">Q-results, beat/miss analysis and price shockers</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-slate-700/50 border border-slate-600 text-slate-200 text-xs"
          />
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/50 text-slate-300 hover:bg-slate-600/50 text-xs transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {dashboard && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Reporting Today',  value: dashboard.totalResults || dashboard.todayCount || '—', color: 'text-blue-400'    },
            { label: 'Beat Estimates',   value: dashboard.beat || '—',                                  color: 'text-emerald-400' },
            { label: 'Missed Estimates', value: dashboard.miss || dashboard.missed || '—',              color: 'text-red-400'    },
            { label: 'In Line',          value: dashboard.inline || dashboard.neutral || '—',           color: 'text-amber-400'  },
          ].map((card, i) => (
            <div key={i} className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
              <div className={cn('text-2xl font-black', card.color)}>{card.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{card.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 bg-slate-800/40 rounded-xl p-1 overflow-x-auto">
        {EARNINGS_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1.5 py-2 px-4 rounded-lg text-xs font-semibold transition-all whitespace-nowrap',
              activeTab === tab.key
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'text-slate-400 hover:text-slate-300'
            )}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'today' && (
        <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-900/60">
                <tr>
                  {['Company', 'Revenue', 'Net Profit', 'YoY Revenue', 'YoY Profit', 'Status'].map(h => (
                    <th key={h} className="text-left py-2.5 px-3 text-xs font-semibold text-slate-400 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {earningsList.slice(0, 25).map((item: any, i: number) => {
                  const revGrowth = parseFloat(item.revGrowth || item.revenueGrowth || 0);
                  const profitGrowth = parseFloat(item.netProfitGrowth || item.profitGrowth || 0);
                  return (
                    <motion.tr
                      key={i}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: i * 0.02 }}
                      className="border-b border-slate-700/30 hover:bg-slate-700/20 cursor-pointer"
                      onClick={() => onSelectStock?.(item.symbol || item.scId)}
                    >
                      <td className="py-2.5 px-3">
                        <div className="text-xs font-bold text-white">{item.companyName || item.name}</div>
                        <div className="text-xs text-slate-500">{item.symbol}</div>
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-300">₹{item.revenue || item.sales || '—'}Cr</td>
                      <td className="py-2.5 px-3 text-xs text-slate-300">₹{item.netProfit || item.profit || '—'}Cr</td>
                      <td className="py-2.5 px-3">
                        <span className={cn('text-xs font-bold', revGrowth >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {revGrowth >= 0 ? '+' : ''}{revGrowth.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={cn('text-xs font-bold', profitGrowth >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {profitGrowth >= 0 ? '+' : ''}{profitGrowth.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={cn('text-xs px-1.5 py-0.5 rounded font-semibold',
                          item.resultStatus === 'beat' ? 'bg-emerald-500/20 text-emerald-400' :
                          item.resultStatus === 'miss' ? 'bg-red-500/20 text-red-400' :
                          'bg-slate-600/50 text-slate-400'
                        )}>
                          {item.resultStatus || '—'}
                        </span>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'calendar' && calendarList.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {calendarList.map((item: any, i: number) => (
            <div
              key={i}
              className="bg-slate-800/50 rounded-xl p-3 border border-slate-700/50 cursor-pointer hover:border-emerald-500/40 transition-colors"
              onClick={() => onSelectStock?.(item.symbol)}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-white">{item.companyName || item.name}</div>
                  <div className="text-xs text-slate-500">{item.symbol}</div>
                </div>
                <div className="text-xs text-cyan-400 font-mono shrink-0">{item.resultDate || item.date}</div>
              </div>
              {item.boardMeetingPurpose && (
                <div className="text-xs text-slate-400 mt-1.5 leading-snug">{item.boardMeetingPurpose}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'beatmiss' && beatMissData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-sm font-semibold text-slate-300 mb-3">Actual vs Estimate Growth (%)</div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={beatMissData} margin={{ left: -10, right: 8 }}>
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#94a3b8' }} angle={-30} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  formatter={(v: any) => [`${v.toFixed(1)}%`, '']}
                />
                <ReferenceLine y={0} stroke="#475569" />
                <Bar dataKey="estimate" name="Estimate" fill="#64748b" radius={[2, 2, 0, 0]} />
                <Bar dataKey="actual" name="Actual" radius={[2, 2, 0, 0]}>
                  {beatMissData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.actual >= entry.estimate ? '#10b981' : '#f43f5e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-700/50">
              <span className="text-xs font-bold text-slate-300">Actual vs Estimate Detail</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              {actualEstimateList.slice(0, 15).map((item: any, i: number) => {
                const beat = parseFloat(item.actual || 0) >= parseFloat(item.estimate || 0);
                return (
                  <div key={i} className="flex items-center justify-between px-3 py-2 border-b border-slate-700/30 hover:bg-slate-700/20 cursor-pointer"
                       onClick={() => onSelectStock?.(item.symbol)}>
                    <div>
                      <div className="text-xs font-bold text-white">{item.companyName || item.symbol}</div>
                      <div className="text-xs text-slate-500">{item.metric || 'Net Profit'}</div>
                    </div>
                    <div className="text-right">
                      <div className={cn('text-xs font-bold', beat ? 'text-emerald-400' : 'text-red-400')}>
                        {beat ? '✓ Beat' : '✗ Miss'}
                      </div>
                      <div className="text-xs text-slate-500">{item.actual} vs {item.estimate}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'shockers' && shockerData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-sm font-semibold text-slate-300 mb-3">Price Impact After Results (%)</div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={shockerData} layout="vertical" margin={{ left: 60, right: 20 }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} width={60} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155' }}
                  formatter={(v: any) => [`${v.toFixed(2)}%`, 'Price Change']}
                />
                <ReferenceLine x={0} stroke="#475569" />
                <Bar dataKey="chg" radius={[0, 3, 3, 0]}>
                  {shockerData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.chg >= 0 ? '#10b981' : '#f43f5e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-700/50">
              <span className="text-xs font-bold text-slate-300">Price Shockers List</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              {priceShockerList.slice(0, 15).map((item: any, i: number) => {
                const chg = parseFloat(item.pChange || item.change || 0);
                return (
                  <div key={i} className="flex items-center justify-between px-3 py-2.5 border-b border-slate-700/30 hover:bg-slate-700/20 cursor-pointer"
                       onClick={() => onSelectStock?.(item.symbol)}>
                    <div>
                      <div className="text-xs font-bold text-white">{item.companyName || item.symbol}</div>
                      <div className="text-xs text-slate-500">₹{item.price || item.lastPrice}</div>
                    </div>
                    <div className={cn('text-sm font-black', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EarningsPage;
