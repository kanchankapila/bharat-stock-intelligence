import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  TrendingUp, TrendingDown, Zap, BarChart3, Plus, Minus,
  ArrowUpRight, ArrowDownRight, RefreshCw, Activity
} from 'lucide-react';
import stockData from '../data/stocklist';

interface MomentumIntelligenceProps {
  watchlist: string[];
  onToggle: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
  onSelectStock: (symbol: string) => void;
}

const SEGMENTS = [
  { key: 'all', label: 'ALL', color: '#60a5fa' },
  { key: 'fno', label: 'F&O', color: '#a78bfa' },
  { key: 'largecap', label: 'LARGE', color: '#34d399' },
  { key: 'midcap', label: 'MID', color: '#facc15' },
  { key: 'smallcap', label: 'SMALL', color: '#fb923c' },
] as const;

type SegmentKey = 'all' | 'fno' | 'largecap' | 'midcap' | 'smallcap';

// Trendlyne quick-access screeners organized by category
const TL_QUICK_SCREENERS = [
  { id: '17096', label: 'Top Gainers', sentiment: 'bullish', icon: '📈' },
  { id: '17098', label: 'Top Losers', sentiment: 'bearish', icon: '📉' },
  { id: '17110', label: '52W High', sentiment: 'bullish', icon: '🚀' },
  { id: '17109', label: '52W Low', sentiment: 'bearish', icon: '🕳️' },
  { id: '17097', label: 'Vol Shockers', sentiment: 'neutral', icon: '⚡' },
  { id: '17099', label: 'Hi Vol Hi Gain', sentiment: 'bullish', icon: '💹' },
  { id: '17100', label: 'Hi Vol Top Loser', sentiment: 'bearish', icon: '🔴' },
  { id: '79795', label: 'Outperf 1W', sentiment: 'bullish', icon: '🏆' },
  { id: '79796', label: 'Outperf 1D', sentiment: 'bullish', icon: '🎯' },
  { id: '79811', label: 'Underperf 1D', sentiment: 'bearish', icon: '👎' },
  { id: '9844', label: 'Rising Delivery', sentiment: 'bullish', icon: '📦' },
  { id: '20014', label: 'Broker Upgrades', sentiment: 'bullish', icon: '⬆️' },
  { id: '27', label: 'RSI/MFI Overbought', sentiment: 'bearish', icon: '🔥' },
  { id: '28', label: 'RSI/MFI Oversold', sentiment: 'bullish', icon: '❄️' },
  { id: '22', label: 'Promoters Buying', sentiment: 'bullish', icon: '🤝' },
  { id: '24', label: 'Pataka Stocks', sentiment: 'bullish', icon: '💥' },
  { id: '40', label: 'Near Hi/Lo 2x Vol', sentiment: 'neutral', icon: '🎲' },
  { id: '42', label: 'Hi Vol Hi Growth', sentiment: 'bullish', icon: '🌱' },
] as const;

function resolveStock(symbol: string): string {
  const s = stockData.find(x => x.symbol.toUpperCase() === symbol.toUpperCase());
  return s?.name || symbol;
}

const StockRow: React.FC<{
  stock: any;
  isBullish: boolean;
  watchlist: string[];
  onToggle: (s: string, meta?: any) => void;
  onSelectStock: (s: string) => void;
}> = ({ stock, isBullish, watchlist, onToggle, onSelectStock }) => {
  const sym = stock.symbol || stock.scId || '';
  const name = resolveStock(sym);
  const pct = parseFloat(String(stock.percentChange || 0));
  const inWatch = watchlist.includes(sym);

  return (
    <div
      onClick={() => sym && onSelectStock(sym)}
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all cursor-pointer group',
        isBullish
          ? 'border-emerald-500/20 hover:border-emerald-500/40 bg-emerald-500/[0.05] hover:bg-emerald-500/[0.08]'
          : 'border-rose-500/20 hover:border-rose-500/40 bg-rose-500/[0.05] hover:bg-rose-500/[0.08]'
      )}
    >
      {/* Watchlist btn */}
      <div onClick={e => e.stopPropagation()}>
        <button
          onClick={() => inWatch
            ? onToggle(sym)
            : onToggle(sym, { price: stock.lastPrice, name, source: `Momentum: ${isBullish ? 'Bullish' : 'Bearish'}` })
          }
          className={cn(
            'w-6 h-6 rounded-lg flex items-center justify-center border transition-all',
            inWatch
              ? 'bg-rose-500/10 border-rose-500/20 text-rose-400 hover:bg-rose-500 hover:text-white'
              : isBullish
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500 hover:text-white'
                : 'bg-slate-900 border-slate-850 text-slate-400 hover:bg-slate-200 hover:text-slate-200'
          )}
        >
          {inWatch ? <Minus className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
        </button>
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <p className={cn(
          'text-[11px] font-black uppercase truncate leading-none',
          isBullish ? 'text-slate-200 group-hover:text-emerald-700' : 'text-slate-200 group-hover:text-rose-700'
        )} style={{ fontFamily: "'Space Mono', monospace" }}>
          {sym}
        </p>
        <p className="text-[9.5px] text-slate-400 font-semibold truncate mt-0.5 leading-none" style={{ fontFamily: "'Rajdhani', sans-serif", letterSpacing: 2 }}>
          {stock.trend || ''}
        </p>
      </div>

      {/* Price & pct */}
      <div className="text-right shrink-0">
        <p className="text-[11px] font-bold text-slate-300 tabular-nums" style={{ fontFamily: "'Space Mono', monospace" }}>
          ₹{Number(stock.lastPrice || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
        </p>
        <p className={cn('text-[10px] font-black tabular-nums mt-0.5', pct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
          {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
        </p>
      </div>
    </div>
  );
};

// Quick Screener Tile
const QuickScreenerTile: React.FC<{
  screener: typeof TL_QUICK_SCREENERS[number];
  onSelectStock: (s: string) => void;
}> = ({ screener }) => {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, refetch } = trpc.getTrendlyneJsonScreener.useQuery(
    { screenerId: screener.id, limit: 10 },
    { enabled: expanded, staleTime: 5 * 60 * 1000 }
  );

  const color = screener.sentiment === 'bullish' ? '#16a34a' : screener.sentiment === 'bearish' ? '#dc2626' : '#d97706';

  return (
    <div
      style={{ border: `1px solid ${color}33`, background: 'rgba(10, 11, 16, 0.65)', borderRadius: 10 }}
      className="overflow-hidden shadow-[0_1px_4px_rgba(0,0,0,0.01)]"
    >
      <button
        onClick={() => { setExpanded(v => !v); if (!expanded) refetch(); }}
        className="w-full flex items-center justify-between px-3 py-2.5 gap-2 hover:bg-white/[0.03] transition-all"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm">{screener.icon}</span>
          <span className="text-[11px] font-black uppercase truncate" style={{ fontFamily: "'Rajdhani', sans-serif", letterSpacing: 2, color: '#475569' }}>
            {screener.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {data?.data?.length ? (
            <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: `${color}18`, color }}>
              {data.data.length}
            </span>
          ) : null}
          <span className="text-[10px]" style={{ color: '#334155' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800/50 px-3 py-2 space-y-1 max-h-48 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="w-4 h-4 animate-spin" style={{ color: '#334155' }} />
            </div>
          ) : data?.data?.length ? (
            data.data.map((item, i) => (
              <a
                key={i}
                href={item.stockurl || '#'}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between py-1 hover:bg-white/[0.03] rounded-lg px-1 transition-all"
              >
                <span className="text-[11px] font-black uppercase" style={{ fontFamily: "'Space Mono', monospace", color: '#1e293b' }}>
                  {item.name}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] tabular-nums" style={{ color: '#334155' }}>
                    ₹{item.currentPrice}
                  </span>
                  <span className={cn('text-[10px] font-black tabular-nums', parseFloat(item.value) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                    {parseFloat(item.value) >= 0 ? '+' : ''}{parseFloat(item.value).toFixed(2)}%
                  </span>
                </div>
              </a>
            ))
          ) : (
            <p className="text-[9px] text-slate-400 text-center py-2">No data available</p>
          )}
        </div>
      )}
    </div>
  );
};

export const MomentumIntelligence: React.FC<MomentumIntelligenceProps> = ({
  watchlist,
  onToggle,
  onSelectStock
}) => {
  const [trendType, setTrendType] = useState<'bullish' | 'bearish' | 'turning-bullish' | 'turning-bearish'>('bullish');
  const [segment, setSegment] = useState<SegmentKey>('fno');
  const [view, setView] = useState<'trends' | 'screeners'>('trends');

  const { data: trendsData, isLoading, refetch } = trpc.getTechTrendsBySegment.useQuery(
    { type: trendType },
    { refetchInterval: 5 * 60 * 1000, staleTime: 4 * 60 * 1000 }
  );

  const stocks: any[] = (trendsData as any)?.[segment] || [];
  const isBullishMode = trendType.includes('bullish');
  const accentColor = isBullishMode ? '#16a34a' : '#dc2626';

  return (
    <div className="glass rounded-2xl p-[18px_20px] min-h-[480px] shadow-sm flex flex-col justify-between">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: 8, padding: '6px 8px' }}>
            <Zap className="w-4 h-4" style={{ color: '#fbbf24' }} />
          </div>
          <div>
            <h3 style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 3, color: '#f8fafc', textTransform: 'uppercase' }}>
              Momentum Intelligence
            </h3>
            <p style={{ fontFamily: "'Space Mono', monospace", fontSize: 9.5, color: '#334155', letterSpacing: 2 }}>
              LIVE · 5 MIN REFRESH
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* View Toggle */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: 2 }}>
            {(['trends', 'screeners'] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  padding: '3px 10px',
                  borderRadius: 6,
                  fontSize: 9.5,
                  fontWeight: 800,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  fontFamily: "'Rajdhani', sans-serif",
                  transition: 'all 0.2s',
                  background: view === v ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: view === v ? '#f8fafc' : '#475569',
                  boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.05)' : 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {v === 'trends' ? '📊 Trends' : '🔍 Screeners'}
              </button>
            ))}
          </div>

          <button
            onClick={() => refetch()}
            disabled={isLoading}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} style={{ color: '#334155' }} />
          </button>
        </div>
      </div>

      {view === 'trends' ? (
        <>
          {/* Trend Type Row */}
          <div className="flex gap-1.5 mb-3 flex-wrap">
            {[
              { v: 'bullish', label: '🟢 Bullish', color: '#16a34a' },
              { v: 'turning-bullish', label: '↗ Turning ↑', color: '#22c55e' },
              { v: 'bearish', label: '🔴 Bearish', color: '#dc2626' },
              { v: 'turning-bearish', label: '↘ Turning ↓', color: '#ef4444' },
            ].map(opt => (
              <button
                key={opt.v}
                onClick={() => setTrendType(opt.v as any)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 20,
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: 1.5,
                  fontFamily: "'Rajdhani', sans-serif",
                  border: `1px solid ${trendType === opt.v ? opt.color + '60' : 'rgba(255,255,255,0.06)'}`,
                  background: trendType === opt.v ? opt.color + '15' : 'transparent',
                  color: trendType === opt.v ? opt.color : '#475569',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  textTransform: 'uppercase',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Segment Tabs */}
          <div className="flex gap-1 mb-4">
            {SEGMENTS.map(seg => (
              <button
                key={seg.key}
                onClick={() => setSegment(seg.key)}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  borderRadius: 8,
                  fontSize: 9.5,
                  fontWeight: 800,
                  letterSpacing: 2,
                  fontFamily: "'Rajdhani', sans-serif",
                  border: `1px solid ${segment === seg.key ? seg.color + '50' : 'rgba(255,255,255,0.05)'}`,
                  background: segment === seg.key ? seg.color + '14' : 'transparent',
                  color: segment === seg.key ? seg.color : '#334155',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  textTransform: 'uppercase',
                }}
              >
                {seg.label}
              </button>
            ))}
          </div>

          {/* Stock List */}
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-10 rounded-xl shimmer" />
              ))
            ) : stocks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-center">
                <Activity className="w-8 h-8 mb-2" style={{ color: '#1e293b' }} />
                <p style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10.5, color: '#334155', letterSpacing: 2 }}>NO DATA FOR THIS SEGMENT</p>
              </div>
            ) : (
              stocks.slice(0, 15).map((stock: any, i: number) => (
                <StockRow
                  key={`${stock.scId}-${i}`}
                  stock={stock}
                  isBullish={isBullishMode}
                  watchlist={watchlist}
                  onToggle={onToggle}
                  onSelectStock={onSelectStock}
                />
              ))
            )}
          </div>

          {/* Footer count */}
          <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-800/50">
            <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9.5, color: '#334155', letterSpacing: 2 }}>
              SOURCE: MONEYCONTROL TECHNICAL TRENDS
            </span>
            <div className="flex items-center gap-1.5">
              {isBullishMode
                ? <ArrowUpRight className="w-3 h-3" style={{ color: accentColor }} />
                : <ArrowDownRight className="w-3 h-3" style={{ color: accentColor }} />
              }
              <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 10.5, fontWeight: 700, color: accentColor }}>
                {stocks.length} STOCKS
              </span>
            </div>
          </div>
        </>
      ) : (
        /* Quick Screeners Grid */
        <div>
          <p style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10.5, letterSpacing: 3, color: '#334155', textTransform: 'uppercase', marginBottom: 12 }}>
            TRENDLYNE QUICK-ACCESS SCREENERS — CLICK TO EXPAND
          </p>
          <div className="grid grid-cols-2 gap-2 max-h-96 overflow-y-auto">
            {TL_QUICK_SCREENERS.map(screener => (
              <QuickScreenerTile
                key={screener.id}
                screener={screener}
                onSelectStock={onSelectStock}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
