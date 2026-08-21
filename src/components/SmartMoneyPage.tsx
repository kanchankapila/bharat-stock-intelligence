import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { TrendingUp, TrendingDown, DollarSign, Users, BarChart2, RefreshCw, Calendar } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie
} from 'recharts';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';
import { SmartMoneyMonitor } from './SmartMoneyMonitor';
import { SeasonalityCalendar } from './SeasonalityCalendar';

interface SmartMoneyPageProps {
  onSelectStock?: (symbol: string) => void;
}

type DealTab = 'large' | 'block' | 'insider' | 'institutional' | 'sector' | 'fii_mf_flows' | 'seasonality';

const DEAL_TABS: { key: DealTab; label: string; icon: React.ElementType }[] = [
  { key: 'large',         label: 'Large Deals',     icon: DollarSign },
  { key: 'block',         label: 'Block Deals',      icon: DollarSign },
  { key: 'insider',       label: 'Insider Trading',  icon: Users      },
  { key: 'institutional', label: 'Institutional',    icon: TrendingUp },
  { key: 'sector',        label: 'By Sector',        icon: BarChart2  },
  { key: 'fii_mf_flows',  label: 'MF/FII Flows',    icon: Users      },
  { key: 'seasonality',   label: 'Seasonality',     icon: Calendar   },
];


const COLORS = ['#10b981', '#f43f5e', '#6366f1', '#f97316', '#8b5cf6', '#ec4899'];

const InsiderFilingsTable: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data: filings = [], isLoading } = trpc.getInsiderTransactions.useQuery({ limit: 100 }, {
    staleTime: 15 * 60 * 1000,
  });

  return (
    <div className="v1-card overflow-hidden">
      <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-800/50 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-300">NSE Insider Filings — Promoter / Designated Person</span>
        <span className="text-[10px] text-slate-500 font-data">before/after % holding, from SAST/PIT disclosures</span>
      </div>
      {isLoading ? (
        <div className="p-4 text-xs text-slate-500 font-data">Loading filings&hellip;</div>
      ) : filings.length === 0 ? (
        <div className="p-4 text-xs text-slate-500 font-data">No recent insider filings.</div>
      ) : (
        <div className="overflow-y-auto max-h-96">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900/80">
              <tr className="text-[10px] text-slate-500 font-display uppercase tracking-wider">
                <th className="text-left px-3 py-2 font-medium">Symbol</th>
                <th className="text-left px-3 py-2 font-medium">Person</th>
                <th className="text-left px-3 py-2 font-medium">Category</th>
                <th className="text-left px-3 py-2 font-medium">Mode</th>
                <th className="text-right px-3 py-2 font-medium">Value (₹Cr)</th>
                <th className="text-right px-3 py-2 font-medium">Before %</th>
                <th className="text-right px-3 py-2 font-medium">After %</th>
                <th className="text-right px-3 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {filings.map((f: any, i: number) => {
                const isBuy = /acqui|buy|allot|subscri/i.test(f.transaction_mode || '');
                const isSell = /dispos|sell|sale/i.test(f.transaction_mode || '');
                return (
                  <tr
                    key={i}
                    className="hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => onSelectStock?.(f.symbol)}
                  >
                    <td className="px-3 py-1.5 font-bold text-slate-200">{f.symbol}</td>
                    <td className="px-3 py-1.5 text-slate-300 truncate max-w-[160px]">{f.person_name}</td>
                    <td className="px-3 py-1.5 text-slate-400">{f.person_category || '—'}</td>
                    <td className={cn("px-3 py-1.5 font-medium", isBuy ? "text-emerald-400" : isSell ? "text-rose-400" : "text-slate-400")}>
                      {f.transaction_mode}
                    </td>
                    <td className="px-3 py-1.5 text-right font-data text-slate-300">
                      {f.value_cr != null ? Number(f.value_cr).toFixed(2) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-data text-slate-400">
                      {f.before_pct != null ? `${Number(f.before_pct).toFixed(2)}%` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-data text-slate-200">
                      {f.after_pct != null ? `${Number(f.after_pct).toFixed(2)}%` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-data text-slate-500">{f.transaction_date}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// pct_transacted (% of the company's float) is the reason this source was chosen — a ₹12cr
// deal is a control transaction in a microcap and a rounding error in a large-cap, so raw
// value_cr alone isn't comparable across symbols.
const BlockDealsTable: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data: deals = [], isLoading } = trpc.getBlockDeals.useQuery({ limit: 100 }, {
    staleTime: 15 * 60 * 1000,
  });

  return (
    <div className="v1-card overflow-hidden">
      <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-800/50 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-300">Bulk / Block Deals</span>
        <span className="text-[10px] text-slate-500 font-data">% of float transacted, from NSE + Tickertape</span>
      </div>
      {isLoading ? (
        <div className="p-4 text-xs text-slate-500 font-data">Loading deals&hellip;</div>
      ) : deals.length === 0 ? (
        <div className="p-4 text-xs text-slate-500 font-data">No recent block deals.</div>
      ) : (
        <div className="overflow-y-auto max-h-96">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900/80">
              <tr className="text-[10px] text-slate-500 font-display uppercase tracking-wider">
                <th className="text-left px-3 py-2 font-medium">Symbol</th>
                <th className="text-left px-3 py-2 font-medium">Client</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-right px-3 py-2 font-medium">Value (₹Cr)</th>
                <th className="text-right px-3 py-2 font-medium">% of Float</th>
                <th className="text-right px-3 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {deals.map((d: any, i: number) => {
                const isBuy = /buy|purch|acqui/i.test(d.trade_type || '');
                const isSell = /sell|sale|dispos/i.test(d.trade_type || '');
                return (
                  <tr
                    key={i}
                    className="hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => onSelectStock?.(d.symbol)}
                  >
                    <td className="px-3 py-1.5 font-bold text-slate-200">{d.symbol}</td>
                    <td className="px-3 py-1.5 text-slate-300 truncate max-w-[220px]">{d.client_name || '—'}</td>
                    <td className={cn("px-3 py-1.5 font-medium", isBuy ? "text-emerald-400" : isSell ? "text-rose-400" : "text-slate-400")}>
                      {d.trade_type || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-data text-slate-300">
                      {d.value_cr != null ? Number(d.value_cr).toFixed(2) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-data text-slate-200">
                      {d.pct_transacted != null ? `${Number(d.pct_transacted).toFixed(2)}%` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-data text-slate-500">{d.date}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export const SmartMoneyPage: React.FC<SmartMoneyPageProps> = ({ onSelectStock }) => {
  const [activeTab, setActiveTab] = useState<DealTab>('large');
  const { data, isLoading, isError, refetch } = trpc.getDeals.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full" />
    </div>
  );

  if (isError) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
      <p className="text-sm text-rose-400 font-bold">Failed to load smart-money deal data.</p>
      <button onClick={() => refetch()} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700">
        Retry
      </button>
    </div>
  );

  const d = data as any;
  const largeDealList: any[] = d?.largeDeal?.data?.list || d?.all?.data?.list || [];
  const insiderBuyList: any[] = d?.insiderBuy?.data?.list || [];
  const insiderSellList: any[] = d?.insiderSell?.data?.list || [];
  const investorBuyList: any[] = d?.investorBuy?.data?.list || [];
  const investorSellList: any[] = d?.investorSell?.data?.list || [];
  const sectorList: any[] = d?.sectorWise?.data?.list || [];
  const topStockList: any[] = d?.topStock?.data?.list || [];

  const sectorChartData = sectorList.slice(0, 8).map((s: any) => ({
    name: s.sector || s.sectorName || 'Other',
    value: parseFloat(s.dealsValue || s.value || 0),
  }));

  const insiderNetData = [
    { name: 'Buy', value: insiderBuyList.length, fill: '#10b981' },
    { name: 'Sell', value: insiderSellList.length, fill: '#f43f5e' },
  ];

  const renderDealRow = (deal: any, i: number) => {
    const chg = parseFloat(deal.pChange || deal.percentChange || 0);
    return (
      <motion.tr
        key={i}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: i * 0.03 }}
        className="border-b border-slate-800/20 hover:bg-slate-700/20 cursor-pointer"
        onClick={() => onSelectStock?.(deal.symbol || deal.scId)}
      >
        <td className="py-2.5 px-3">
          <div className="text-xs font-bold text-slate-100">{deal.companyName || deal.company || deal.symbol}</div>
          <div className="text-xs text-slate-400">{deal.dealType || deal.type}</div>
        </td>
        <td className="py-2.5 px-3 text-xs text-slate-300">{deal.buyerName || deal.sellerName || deal.party || '—'}</td>
        <td className="py-2.5 px-3 text-xs font-data text-white text-right">
          ₹{parseFloat(deal.dealsValue || deal.value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}Cr
        </td>
        <td className="py-2.5 px-3 text-xs text-slate-400 text-right">{deal.dealDate || deal.date || '—'}</td>
        <td className="py-2.5 px-3 text-right">
          <span className={cn('text-xs font-bold', chg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
            {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
          </span>
        </td>
      </motion.tr>
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="v1-title-page">Smart Money</h1>
          <p className="text-sm text-slate-400 mt-0.5">Institutional deals, insider activity, and block trades</p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/50 text-slate-300 hover:bg-slate-600/50 text-xs transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Large Deals',   value: largeDealList.length,   icon: DollarSign, color: 'text-indigo-400'    },
          { label: 'Insider Buys',  value: insiderBuyList.length,  icon: TrendingUp, color: 'text-emerald-400' },
          { label: 'Insider Sells', value: insiderSellList.length, icon: TrendingDown,color: 'text-rose-400'    },
          { label: 'Top Stocks',    value: topStockList.length,    icon: BarChart2,  color: 'text-amber-400'   },
        ].map((card, i) => (
          <div key={i} className="v1-card p-4">
            <card.icon className={cn('w-4 h-4 mb-2', card.color)} />
            <div className="v1-data-value text-white">{card.value}</div>
            <div className="v1-data-label mt-0.5">{card.label}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-1 bg-slate-800/40 rounded-xl p-1">
        {DEAL_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all',
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

      {activeTab === 'large' && (
        <div className="v1-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-900/60">
                <tr>
                  <th className="text-left py-2.5 px-3 text-xs font-semibold text-slate-400">Company</th>
                  <th className="text-left py-2.5 px-3 text-xs font-semibold text-slate-400">Party</th>
                  <th className="text-right py-2.5 px-3 text-xs font-semibold text-slate-400">Deal Value</th>
                  <th className="text-right py-2.5 px-3 text-xs font-semibold text-slate-400">Date</th>
                  <th className="text-right py-2.5 px-3 text-xs font-semibold text-slate-400">Chg%</th>
                </tr>
              </thead>
              <tbody>
                {largeDealList.slice(0, 20).map(renderDealRow)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'block' && <BlockDealsTable onSelectStock={onSelectStock} />}

      {activeTab === 'insider' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="v1-card p-4">
            <div className="v1-title-card mb-3">Insider Buy vs Sell</div>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={insiderNetData} dataKey="value" cx="50%" cy="50%" outerRadius={70} label={({ name, value }: any) => `${name}: ${value}`}>
                  {insiderNetData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="v1-card overflow-hidden">
            <div className="px-3 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
              <span className="text-xs font-bold text-emerald-400">Insider BUYS ({insiderBuyList.length})</span>
            </div>
            <div className="overflow-y-auto max-h-64">
              <table className="w-full">
                <tbody>{insiderBuyList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
          <div className="v1-card overflow-hidden">
            <div className="px-3 py-2 bg-rose-500/10 border-b border-rose-500/20">
              <span className="text-xs font-bold text-rose-400">Insider SELLS ({insiderSellList.length})</span>
            </div>
            <div className="overflow-y-auto max-h-64">
              <table className="w-full">
                <tbody>{insiderSellList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>

          <div className="lg:col-span-3">
            <InsiderFilingsTable onSelectStock={onSelectStock} />
          </div>
        </div>
      )}

      {activeTab === 'institutional' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="v1-card overflow-hidden">
            <div className="px-3 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
              <span className="text-xs font-bold text-emerald-400">Investor BUYS</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              <table className="w-full">
                <tbody>{investorBuyList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
          <div className="v1-card overflow-hidden">
            <div className="px-3 py-2 bg-rose-500/10 border-b border-rose-500/20">
              <span className="text-xs font-bold text-rose-400">Investor SELLS</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              <table className="w-full">
                <tbody>{investorSellList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'sector' && sectorChartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="v1-card p-4">
            <div className="v1-title-card mb-3">Deal Value by Sector</div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={sectorChartData} layout="vertical" margin={{ left: 80, right: 16 }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} width={80} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155' }}
                  formatter={(v: any) => [`₹${v.toFixed(0)}Cr`, 'Deal Value']}
                />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {sectorChartData.map((_, idx) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="v1-card overflow-hidden">
            <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-800/30">
              <span className="text-xs font-bold text-slate-300">Top Stocks by Deal Value</span>
            </div>
            <div className="overflow-y-auto max-h-80">
              <table className="w-full">
                <tbody>{topStockList.slice(0, 15).map(renderDealRow)}</tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'fii_mf_flows' && (
        <SmartMoneyMonitor onSelectStock={onSelectStock} />
      )}

      {activeTab === 'seasonality' && (
        <SeasonalityCalendar onSelectStock={onSelectStock} />
      )}
    </div>
  );
};
export default SmartMoneyPage;

