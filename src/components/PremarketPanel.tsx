import React from 'react';
import { trpc } from '../lib/trpc';
import { TrendingUp, Globe, Clock, Newspaper, Eye, BarChart2, Activity } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

interface PremarketPanelProps {
  onSelectStock?: (symbol: string) => void;
}

export const PremarketPanel: React.FC<PremarketPanelProps> = ({ onSelectStock }) => {
  const { data, isLoading } = trpc.getPremarket.useQuery(undefined, {
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-48">
      <div className="animate-spin w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full" />
    </div>
  );

  const globalMarkets = (data as any)?.globalMarkets?.data?.globalMarketData || [];
  const stocks = (data as any)?.stocksToWatch?.data?.list || [];
  const brokerRecos = (data as any)?.brokerReco?.data?.list || [];
  const fllData = (data as any)?.fllActivity?.data;
  const upcomingEvents = (data as any)?.ecalendar?.data?.upcoming_event_calendar || [];
  const news = (data as any)?.news?.data?.list || [];

  const hasAnyData = globalMarkets.length > 0 || stocks.length > 0 || brokerRecos.length > 0
    || !!fllData || upcomingEvents.length > 0 || news.length > 0;

  if (!data || !hasAnyData) return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="w-5 h-5 text-emerald-400" />
        <h2 className="text-lg font-bold text-white">Pre-Market Intelligence</h2>
      </div>
      <div className="v1-card p-6 text-center">
        <Globe className="w-8 h-8 text-slate-500 mx-auto mb-2" />
        <p className="text-sm text-slate-400">Pre-market data unavailable</p>
        <p className="text-xs text-slate-500 mt-1">MoneyControl API may be temporarily unreachable</p>
      </div>
    </div>
  );

  const fllChartData = fllData ? [
    { name: 'FII Buy', value: parseFloat(fllData.fii_buy || 0), fill: '#10b981' },
    { name: 'FII Sell', value: parseFloat(fllData.fii_sell || 0), fill: '#f43f5e' },
    { name: 'DII Buy', value: parseFloat(fllData.dii_buy || 0), fill: '#3b82f6' },
    { name: 'DII Sell', value: parseFloat(fllData.dii_sell || 0), fill: '#f97316' },
  ] : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-2">
        <Activity className="w-5 h-5 text-emerald-400" />
        <h2 className="text-lg font-bold text-white">Pre-Market Intelligence</h2>
        <span className="text-xs text-slate-400 ml-auto">
          {new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST
        </span>
      </div>

      {globalMarkets.length > 0 && (
        <div className="v1-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Globe className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold text-slate-300">Global Markets</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {globalMarkets.slice(0, 12).map((mkt: any, i: number) => {
              const chg = parseFloat(mkt.change || mkt.pChange || 0);
              const isPos = chg >= 0;
              return (
                <div key={i} className={cn(isPos ? 'v1-card-up' : 'v1-card-down', 'p-2.5 text-center')}>
                  <div className="text-xs text-slate-400 truncate mb-1">{mkt.name || mkt.market_name}</div>
                  <div className="text-sm font-bold text-white">{mkt.price || mkt.lastPrice}</div>
                  <div className={cn('text-xs font-medium', isPos ? 'text-emerald-400' : 'text-red-400')}>
                    {isPos ? '+' : ''}{chg.toFixed(2)}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {stocks.length > 0 && (
          <div className="v1-card p-4 lg:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <Eye className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-semibold text-slate-300">Stocks to Watch</span>
            </div>
            <div className="space-y-2">
              {stocks.map((s: any, i: number) => {
                const chg = parseFloat(s.percentChange || s.pChange || 0);
                return (
                  <motion.div
                    key={i}
                    className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 cursor-pointer hover:bg-slate-700/60 transition-colors"
                    onClick={() => onSelectStock?.(s.symbol || s.scId)}
                    whileHover={{ x: 2 }}
                  >
                    <div>
                      <div className="text-xs font-bold text-white">{s.symbol || s.scId}</div>
                      <div className="text-xs text-slate-400 truncate max-w-[120px]">{s.companyName || s.name}</div>
                    </div>
                    <div className={cn('text-xs font-bold', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}

        {fllChartData.length > 0 && (
          <div className="v1-card p-4 lg:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <BarChart2 className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-semibold text-slate-300">FII / DII Activity</span>
              {fllData?.date && <span className="text-xs text-slate-500 ml-auto">{fllData.date}</span>}
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={fllChartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  labelStyle={{ color: '#f1f5f9' }}
                  formatter={(v: any) => [`₹${(v / 100).toFixed(0)}Cr`, '']}
                />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {fllChartData.map((entry, index) => (
                    <Cell key={index} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {fllData && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div className="text-center">
                  <div className="text-xs text-slate-500">FII Net</div>
                  {fllData.fii_net == null ? <div className="text-sm font-bold text-slate-500">—</div> : (() => {
                    const fii = parseFloat(fllData.fii_net);
                    return (
                      <div className={cn('text-sm font-bold', fii >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {fii >= 0 ? '+' : ''}₹{(fii / 100).toFixed(0)}Cr
                      </div>
                    );
                  })()}
                </div>
                <div className="text-center">
                  <div className="text-xs text-slate-500">DII Net</div>
                  {fllData.dii_net == null ? <div className="text-sm font-bold text-slate-500">—</div> : (() => {
                    const dii = parseFloat(fllData.dii_net);
                    return (
                      <div className={cn('text-sm font-bold', dii >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {dii >= 0 ? '+' : ''}₹{(dii / 100).toFixed(0)}Cr
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}

        {upcomingEvents.length > 0 && (
          <div className="v1-card p-4 lg:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-cyan-400" />
              <span className="text-sm font-semibold text-slate-300">Economic Calendar</span>
            </div>
            <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
              {upcomingEvents.slice(0, 8).map((evt: any, i: number) => (
                <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-slate-900/60">
                  <div className="shrink-0 text-xs text-cyan-400 font-data mt-0.5">{evt.event_date || evt.date}</div>
                  <div>
                    <div className="text-xs font-medium text-white leading-tight">{evt.event_name || evt.title}</div>
                    {evt.impact && (
                      <span className={cn('text-xs px-1 rounded',
                        evt.impact === 'High' ? 'text-red-400' : evt.impact === 'Medium' ? 'text-amber-400' : 'text-slate-500'
                      )}>{evt.impact}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {brokerRecos.length > 0 && (
        <div className="v1-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-semibold text-slate-300">Broker Research Recommendations</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {brokerRecos.slice(0, 6).map((reco: any, i: number) => (
              <div key={i} className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/30">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span
                    className="text-xs font-bold text-white cursor-pointer hover:text-emerald-400"
                    onClick={() => onSelectStock?.(reco.symbol || reco.scId)}
                  >
                    {reco.companyName || reco.name || reco.symbol}
                  </span>
                  <span className={cn('text-xs px-1.5 py-0.5 rounded font-semibold shrink-0',
                    reco.recommendation === 'Buy' || reco.action === 'Buy' ? 'bg-emerald-500/20 text-emerald-400' :
                    reco.recommendation === 'Sell' || reco.action === 'Sell' ? 'bg-red-500/20 text-red-400' :
                    'bg-amber-500/20 text-amber-400'
                  )}>
                    {reco.recommendation || reco.action || 'Hold'}
                  </span>
                </div>
                <div className="text-xs text-slate-500">{reco.brokerName || reco.broker}</div>
                {reco.targetPrice && (
                  <div className="text-xs text-slate-400 mt-1">Target: <span className="text-white font-medium">₹{reco.targetPrice}</span></div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {news.length > 0 && (
        <div className="v1-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Newspaper className="w-4 h-4 text-slate-400" />
            <span className="text-sm font-semibold text-slate-300">Pre-Market News</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {news.slice(0, 6).map((item: any, i: number) => (
              <a
                key={i}
                href={item.url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="block p-2 rounded-lg bg-slate-900/60 hover:bg-slate-700/60 transition-colors"
              >
                <div className="text-xs font-medium text-slate-200 leading-snug line-clamp-2">{item.title || item.headline}</div>
                <div className="text-xs text-slate-500 mt-1">{item.source || item.publisher}</div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PremarketPanel;
