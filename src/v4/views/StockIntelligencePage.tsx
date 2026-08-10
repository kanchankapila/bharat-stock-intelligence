import React, { useState, useEffect, useMemo } from 'react';
import {
  Search, LayoutGrid, LineChart, BadgeDollarSign, Users, Landmark,
  CalendarClock, Newspaper, ShieldAlert, Star, StarOff, ArrowUpRight, ArrowDownRight,
  Building2, Tags, Compass, Mic2, Gauge, ShoppingBag,
} from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';
import { V2LightweightChart } from '../../v2/components/widgets/V2LightweightChart';
import { OptionChainView } from '../../components/OptionChainView';
import IndexFnoOverview from '../../components/IndexFnoOverview';
import { WhyThisPick } from '../../components/WhyThisPick';
import { McNewsCard, McNewsLinks, McNewsEmptyState } from '../../components/McNewsCard';
import { StockTagRow, ConvictionPill } from '../../components/StockTagRow';
import { relativeFromNow } from '../../lib/timeFormat';
import { V4QuickNav } from '../components/V4QuickNav';
import { AddToPortfolioButton } from '../../components/AddToPortfolioButton';
import { PriceFreshnessBadge } from '../../components/PriceFreshnessBadge';

type TabId = 'overview' | 'technicals' | 'fundamentals' | 'ownership' | 'fno' | 'earnings' | 'news';

const TABS: { id: TabId; label: string; icon: any }[] = [
  { id: 'overview',     label: 'Overview',           icon: LayoutGrid },
  { id: 'technicals',   label: 'Technicals',         icon: LineChart },
  { id: 'fundamentals', label: 'Fundamentals',       icon: BadgeDollarSign },
  { id: 'ownership',    label: 'Ownership & Insider', icon: Users },
  { id: 'fno',          label: 'F&O',                icon: Landmark },
  { id: 'earnings',     label: 'Earnings',           icon: CalendarClock },
  { id: 'news',         label: 'News & Sentiment',   icon: Newspaper },
];

function fmt(n: any, digits = 2): string {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}

// ─── Symbol search box ────────────────────────────────────────────────────
const SymbolSearch: React.FC<{ onSelect: (symbol: string) => void }> = ({ onSelect }) => {
  const [q, setQ] = useState('');
  const { data } = trpc.searchNSEStocks.useQuery({ query: q }, { enabled: q.length >= 1 });
  const results = data?.stocks ?? [];

  return (
    <div className="relative">
      <div className="flex items-center gap-2 glass rounded-xl px-3 py-2">
        <Search className="w-4 h-4 text-slate-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search NSE symbol or company name…"
          className="bg-transparent outline-none text-sm text-slate-200 placeholder:text-slate-600 w-72"
        />
      </div>
      {q.length >= 1 && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-96 overflow-y-auto glass-strong rounded-xl border border-slate-800 terminal-scrollbar">
          {results.map((s: any) => (
            <button
              key={s.symbol}
              onClick={() => { onSelect(s.symbol); setQ(''); }}
              className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-indigo-500/10 hover:text-white flex justify-between"
            >
              <span className="font-bold">{s.symbol}</span>
              <span className="text-slate-500 truncate ml-2">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const SWOT_CATEGORIES = [
  { key: 'strengths' as const,     label: 'Strengths',     badge: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', bullet: 'text-emerald-400' },
  { key: 'weaknesses' as const,    label: 'Weaknesses',    badge: 'bg-rose-500/10 text-rose-300 border-rose-500/30',       bullet: 'text-rose-400'    },
  { key: 'opportunities' as const, label: 'Opportunities', badge: 'bg-sky-500/10 text-sky-300 border-sky-500/30',         bullet: 'text-sky-400'     },
  { key: 'threats' as const,       label: 'Threats',        badge: 'bg-amber-500/10 text-amber-300 border-amber-500/30',   bullet: 'text-amber-400'   },
];

// MoneyControl's per-stock SWOT -- fetched via getMcConsolidated (also sourced by
// TechnicalsTab/EarningsTab below for chartPatterns/historicalRating/hitsMisses, which live
// in the same response; each tab pulls only its own piece so nothing is shown twice). Not the
// same component as MCStockInfoPanel's TrendlyneSWOTCard -- rebuilt with this page's own
// Card/glass conventions rather than importing a differently-styled component cross-module.
const SwotCard: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: mc } = trpc.getMcConsolidated.useQuery({ symbol }, { enabled: !!symbol, staleTime: 3600_000 });
  const swot = mc?.swot as { strengths?: string[]; weaknesses?: string[]; opportunities?: string[]; threats?: string[] } | undefined;
  const hasAny = SWOT_CATEGORIES.some((c) => (swot?.[c.key]?.length ?? 0) > 0);
  if (!hasAny) return null;

  return (
    <Card title="SWOT Analysis" icon={LayoutGrid}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {SWOT_CATEGORIES.map((cat) => {
          const items = swot?.[cat.key] ?? [];
          if (items.length === 0) return null;
          return (
            <div key={cat.key}>
              <span className={cn('text-[9px] font-black px-2 py-0.5 rounded-full border uppercase tracking-wide', cat.badge)}>
                {cat.label} ({items.length})
              </span>
              <ul className="mt-2 space-y-1.5">
                {items.map((item, i) => (
                  <li key={i} className="text-[10px] text-slate-400 leading-relaxed flex items-start gap-1.5">
                    <span className={cn('font-black shrink-0', cat.bullet)}>•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

const RRG_QUADRANT_STYLE: Record<string, string> = {
  Leading:    'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  Improving:  'text-sky-400 bg-sky-500/10 border-sky-500/30',
  Weakening:  'text-amber-400 bg-amber-500/10 border-amber-500/30',
  Lagging:    'text-rose-400 bg-rose-500/10 border-rose-500/30',
};

// Sector Relative Rotation Graph context -- is this stock's sector currently outperforming or
// falling behind the market right now. Market-wide payload (getSectorRotationIntel), filtered
// client-side to this stock's own sector.
const SectorRotationBadge: React.FC<{ sector?: string | null }> = ({ sector }) => {
  const { data } = trpc.getSectorRotationIntel.useQuery(undefined, { enabled: !!sector, staleTime: 1_800_000 });
  const row = (data?.rrg as any[] | undefined)?.find((r) => r.sector === sector);
  if (!sector || !row) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 glass rounded-xl">
      <Compass className="w-4 h-4 text-indigo-400 shrink-0" />
      <span className="text-[10px] text-slate-500">Sector rotation — <span className="text-slate-300 font-semibold">{row.sector}</span> is currently</span>
      <span className={cn('text-[9px] font-black px-2 py-0.5 rounded-full border uppercase', RRG_QUADRANT_STYLE[row.quadrant] ?? 'text-slate-400 bg-slate-800 border-slate-700')}>
        {row.quadrant ?? 'Unclassified'}
      </span>
    </div>
  );
};

// ─── Overview tab: unified score + reasoning (the "why", not shown anywhere else today) ──
const OverviewTab: React.FC<{ symbol: string; sector?: string | null }> = ({ symbol, sector }) => {
  const { data: scoreDetail } = trpc.getStockScoreDetail.useQuery({ symbol, timeframe: 'long_term' });
  const { data: quote } = trpc.getLiveStockQuote.useQuery({ symbol }, { enabled: !!symbol, retry: false });
  const score = scoreDetail?.score;
  const factors = scoreDetail?.factors;

  // Day range / 52-week range / volume -- already fetched by StockHeaderCard's own
  // getLiveStockQuote call for the price ticker, just never surfaced in the tab body itself.
  const keyStats: [string, any][] = [
    ['Open', quote?.open], ['Prev Close', quote?.prevClose],
    ['Day High', quote?.high], ['Day Low', quote?.low],
    ['52W High', quote?.high52w], ['52W Low', quote?.low52w],
    ['Volume', quote?.volume],
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card title="Composite Score" icon={LayoutGrid} className="lg:col-span-1">
        <div className="flex flex-col items-center py-2">
          <span className={cn(
            'text-4xl font-black font-mono',
            (score?.score ?? 0) >= 66 ? 'text-emerald-400' : (score?.score ?? 0) <= 34 ? 'text-rose-400' : 'text-amber-400'
          )}>
            {score?.score != null ? Math.round(score.score) : '—'}
          </span>
          <span className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            {score?.classification ?? 'No score yet'}
          </span>
          {score?.confidence != null && (
            // confidence is already a 5-95 integer (scoring_engine.py caps it there directly),
            // not a 0-1 fraction — see TopRatedStocks.tsx's `stock.confidence.toFixed(0)` for
            // the same field used correctly elsewhere.
            <span className="text-[10px] text-slate-600 mt-0.5">{Math.round(score.confidence)}% confidence</span>
          )}
        </div>
        {factors && (
          <div className="mt-3 space-y-2 border-t border-slate-800/60 pt-3">
            {(['technical', 'fundamental', 'momentum', 'valuation', 'delivery', 'news'] as const)
              .filter((k) => (factors as any)[k] != null)
              .map((k) => {
                const v = (factors as any)[k] as number;
                return (
              <div key={k} className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400 capitalize">{k}</span>
                <div className="flex items-center gap-2 w-32">
                  <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full', (v ?? 0) >= 66 ? 'bg-emerald-500' : (v ?? 0) <= 34 ? 'bg-rose-500' : 'bg-amber-500')}
                      style={{ width: `${Math.max(0, Math.min(100, v ?? 0))}%` }}
                    />
                  </div>
                  <span className="text-slate-500 font-mono w-8 text-right">{v != null ? Math.round(v) : '—'}</span>
                </div>
              </div>
                );
              })}
          </div>
        )}
        {score?.reasons && score.reasons.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-slate-800/60 pt-3">
            {score.reasons.slice(0, 6).map((r, i: number) => (
              <li key={i} className="text-[11px] text-slate-400 flex gap-1.5">
                <span className={cn(
                  // scoring_engine.py writes two vocabularies into `reasons`: screener-derived
                  // entries use bullish/bearish, news-derived entries use positive/negative.
                  r.sentiment === 'bullish' || r.sentiment === 'positive' ? 'text-emerald-400'
                    : r.sentiment === 'bearish' || r.sentiment === 'negative' ? 'text-rose-400'
                    : 'text-indigo-400'
                )}>›</span>
                {r.name}
                {r.source && <span className="text-slate-600 ml-1">({r.source})</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="lg:col-span-2 space-y-4">
        <Card title="Key Stats" icon={LayoutGrid}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {keyStats.map(([label, value]) => (
              <div key={label} className="glass rounded-xl p-2.5 text-center">
                <div className="text-sm font-mono font-bold text-slate-100">
                  {label === 'Volume' ? (value ?? '—') : `₹${fmt(value)}`}
                </div>
                <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">{label}</div>
              </div>
            ))}
          </div>
        </Card>
        <SectorRotationBadge sector={sector} />
        <WhyThisPick symbol={symbol} timeframe="long_term" />
        <SwotCard symbol={symbol} />
      </div>
    </div>
  );
};

// ─── Technicals tab: REAL OHLCV chart (getOHLCData), not synthetic/random data ──
const TechnicalsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: ohlc, isLoading } = trpc.getOHLCData.useQuery({ symbol, dur: '6m' });
  const { data: predictions } = trpc.getTechnicalPredictions.useQuery({ symbol });
  // chartPatterns/historicalRating live in the same getMcConsolidated response SwotCard/
  // HitsMissesCard also read (each destructures only its own piece, see those components'
  // own comments) -- not re-fetching a separate endpoint for the same underlying MC blob.
  const { data: mc } = trpc.getMcConsolidated.useQuery({ symbol }, { enabled: !!symbol, staleTime: 3600_000 });
  const chartPatterns = (mc as any)?.chartPatterns;
  const historicalRating = (mc as any)?.historicalRating;
  const hrSnapshot = historicalRating?.data?.[0];

  const chartData = useMemo(() => {
    const rows = ohlc?.data ?? [];
    return rows.map((r: any) => ({
      time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    }));
  }, [ohlc]);

  // sma20 dropped 2026-07-30 (Finding #106, full-stack audit): no data source computes a
  // 20-day SMA anywhere in this codebase -- it doesn't exist on technical_signals or the
  // legacy technical_analysis_signals table, so this key was always going to render nothing.
  const indicatorFields: [string, string][] = [
    ['rsi', 'RSI'], ['macd', 'MACD'], ['adx', 'ADX'],
    ['sma50', 'SMA 50'], ['sma200', 'SMA 200'],
    ['win_probability', 'Win Probability'],
  ];

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="text-xs text-slate-500 p-6">Loading chart…</div>
      ) : chartData.length > 0 ? (
        <V2LightweightChart data={chartData} symbol={symbol} height={340} />
      ) : (
        <Card title="Price Chart" icon={LineChart}>
          <div className="text-xs text-slate-500 py-6 text-center">No historical OHLC data available for {symbol}.</div>
        </Card>
      )}

      {predictions && (
        <Card title="Technical Signal Snapshot" icon={LineChart}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {indicatorFields.map(([key, label]) => (
              predictions[key] != null && (
                <div key={key} className="glass rounded-xl p-2.5 text-center">
                  <div className="text-sm font-mono font-bold text-slate-100">
                    {typeof predictions[key] === 'number' ? fmt(predictions[key]) : String(predictions[key])}
                  </div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">{label}</div>
                </div>
              )
            ))}
          </div>
          {/* predictions.patterns dead-array rendering dropped -- technical_signals has no
              patterns column (nothing writes it), see technicals.router.ts. */}
          <TechnicalReadTags predictions={predictions} />
        </Card>
      )}

      {hrSnapshot?.currSentiment && (() => {
        const isBull = /bullish/i.test(hrSnapshot.currSentiment);
        const isBear = /bearish/i.test(hrSnapshot.currSentiment);
        return (
          <div className={cn(
            'flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border text-xs',
            isBull ? 'bg-emerald-500/5 border-emerald-500/20' : isBear ? 'bg-rose-500/5 border-rose-500/20' : 'glass'
          )}>
            <span className="text-slate-500 uppercase tracking-widest text-[9px] font-black">
              MC Historical Rating — sentiment on {hrSnapshot.currdate ?? '—'}
            </span>
            <span className={cn('font-black italic', isBull ? 'text-emerald-400' : isBear ? 'text-rose-400' : 'text-slate-300')}>
              {hrSnapshot.currSentiment} @ ₹{fmt(hrSnapshot.closePrice)}
            </span>
            {historicalRating?.displayLock === 'Y' && (
              <span className="text-[9px] text-slate-600 italic shrink-0">Trend history is MC Pro</span>
            )}
          </div>
        );
      })()}

      {Array.isArray(chartPatterns?.data) && chartPatterns.data.length > 0 && (
        <Card title="Chart Patterns Detected (MoneyControl)" icon={Gauge}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {chartPatterns.data.map((p: any, i: number) => {
              let meta: any = {};
              try { meta = JSON.parse(p.meta_data || '{}'); } catch { /* ignore malformed meta_data */ }
              const isBuy = meta.pattern_type === 'buy';
              return (
                <div key={i} className="glass rounded-xl p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-200 truncate">{p.pattern_name}</span>
                    {meta.target_return_prcnt != null && (
                      <span className="text-xs font-black text-emerald-400 shrink-0">+{meta.target_return_prcnt}%</span>
                    )}
                  </div>
                  <div className={cn('text-[10px] font-semibold mt-0.5', isBuy ? 'text-emerald-400' : 'text-rose-400')}>
                    {p.comment} · {p.p_status} · {p.time_frame}
                  </div>
                  {(meta.entry_price || meta.target_price || meta.stoploss_price) && (
                    <div className="flex gap-3 mt-1.5 text-[9px] font-mono text-slate-500">
                      {meta.entry_price && <span>Entry ₹{meta.entry_price}</span>}
                      {meta.target_price && <span className="text-emerald-500">Target ₹{meta.target_price}</span>}
                      {meta.stoploss_price && <span className="text-rose-500">Stop ₹{meta.stoploss_price}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
};

// Plain-language read on the raw indicator values -- the numbers above tell an analyst
// something, but "RSI 78" means nothing to someone scanning quickly; the tag does.
const TechnicalReadTags: React.FC<{ predictions: any }> = ({ predictions }) => {
  const tags: { label: string; color: string }[] = [];
  if (predictions.rsi != null) {
    if (predictions.rsi >= 70) tags.push({ label: 'RSI Overbought', color: 'bg-rose-500/15 text-rose-300 border-rose-500/30' });
    else if (predictions.rsi <= 30) tags.push({ label: 'RSI Oversold', color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' });
  }
  if (predictions.macd != null) {
    tags.push(predictions.macd > 0
      ? { label: 'MACD Bullish', color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' }
      : { label: 'MACD Bearish', color: 'bg-rose-500/15 text-rose-300 border-rose-500/30' });
  }
  if (predictions.adx != null && predictions.adx >= 25) {
    tags.push({ label: 'Strong Trend (ADX)', color: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30' });
  }
  if (predictions.win_probability != null) {
    const wp = predictions.win_probability * 100;
    tags.push({
      label: `Win Prob ${wp.toFixed(0)}%`,
      color: wp >= 55 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
        : wp >= 45 ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    });
  }
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-800/60">
      {tags.map((t, i) => (
        <span key={i} className={cn('text-[9px] font-semibold px-2 py-0.5 rounded-full border', t.color)}>{t.label}</span>
      ))}
    </div>
  );
};

// ─── Fundamentals tab ──────────────────────────────────────────────────────
const DVM_COLOR: Record<string, string> = {
  green: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  yellow: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  red: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
};

// Small labeled metric grid used to group fundamentals into named categories
// (Moneycontrol/Trendlyne convention: Valuation / Profitability / Growth / Quality),
// rather than one flat undifferentiated grid of 10 numbers.
const MetricCategoryCard: React.FC<{
  title: string;
  rows: [string, any][];
  flagBad?: (label: string, value: any) => boolean;
}> = ({ title, rows, flagBad }) => {
  const present = rows.filter(([, v]) => v != null);
  if (present.length === 0) return null;
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] font-black text-indigo-300 uppercase tracking-widest mb-2">{title}</div>
      <div className="grid grid-cols-2 gap-2.5">
        {present.map(([label, value]) => (
          <div key={label}>
            <div className={cn('text-sm font-mono font-bold', flagBad?.(label, value) ? 'text-rose-400' : 'text-slate-100')}>{fmt(value)}</div>
            <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-0.5">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const FundamentalsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: fundamentals } = trpc.getStockFundamentals.useQuery({ symbol });
  const { data: ratios } = trpc.getRatios.useQuery({ symbol });
  const { data: dvm } = trpc.getTrendlyneDVM.useQuery({ symbol });
  const { data: checklist } = trpc.getTrendlyneChecklist.useQuery({ symbol });

  if (!fundamentals) {
    return (
      <Card title="Fundamentals" icon={BadgeDollarSign}>
        <div className="text-xs text-slate-500 py-4">No fundamentals data captured yet for {symbol}.</div>
      </Card>
    );
  }

  const dvmRows: [string, any][] = [
    ['Durability', dvm?.durability],
    ['Valuation', dvm?.valuation],
    ['Momentum', dvm?.momentum],
  ];

  return (
    <div className="space-y-4">
      {(dvm || checklist) && (
        <Card title="Trendlyne DVM & Checklist" icon={BadgeDollarSign}>
          <div className="flex flex-wrap items-center gap-4">
            {dvm && dvmRows.map(([label, v]) => v && (
              <div key={label} className={cn('px-3 py-1.5 rounded-lg border text-xs font-bold', DVM_COLOR[v.color] ?? 'text-slate-300 bg-slate-800 border-slate-700')}>
                {label}: {v.score}
              </div>
            ))}
            {checklist && (
              <div className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-xs font-bold text-slate-200">
                Checklist: {checklist.yesCount}/{checklist.total} passed ({checklist.score}%)
              </div>
            )}
          </div>
        </Card>
      )}
      <Card title="Fundamentals" icon={BadgeDollarSign}>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <MetricCategoryCard
            title="Valuation"
            rows={[
              ['Market Cap (Cr)', fundamentals?.market_cap],
              ['P/E', fundamentals?.trailing_pe ?? ratios?.pe],
              ['P/B', fundamentals?.price_to_book ?? ratios?.pb],
              ['Earnings Yield %', fundamentals?.earnings_yield],
            ]}
          />
          <MetricCategoryCard
            title="Profitability"
            rows={[
              ['ROE %', fundamentals?.return_on_equity],
              ['Operating Margin %', fundamentals?.operating_margins],
              ['Piotroski F-Score', fundamentals?.piotroski_f_score],
            ]}
            flagBad={(label, v) => label === 'Piotroski F-Score' && Number(v) < 4}
          />
          <MetricCategoryCard
            title="Growth"
            rows={[
              ['Revenue Growth %', fundamentals?.revenue_growth],
              ['Earnings Growth %', fundamentals?.earnings_growth],
            ]}
            flagBad={(_, v) => Number(v) < 0}
          />
          <MetricCategoryCard
            title="Leverage & Quality"
            rows={[['Debt/Equity', fundamentals?.debt_to_equity]]}
            flagBad={(_, v) => Number(v) > 1.5}
          />
        </div>
      </Card>
    </div>
  );
};

// ─── Ownership & Insider tab — NEW, not shown anywhere in the app today ────
const OwnershipTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: shareholding } = trpc.getShareholding.useQuery({ symbol });
  const { data: insiders } = trpc.getInsiderTransactions.useQuery({ symbol, limit: 25 });
  // Superstar-investor tracking (InvestSights) -- the one feature v5's StockIntelligenceDeskPage.tsx
  // had that this page didn't, per the Phase 3 stock-research-page merge ("V6 Canonical Workbench"
  // proposal). Grafted here rather than v5's own layout/classes so it matches this tab's existing
  // Card/glass conventions instead of mixing two different styling systems in one page.
  const { data: superstarActivity } = trpc.getSuperstarInvestorActivity.useQuery({ symbol, limit: 20 });
  // Transaction-level smart-money activity -- distinct from the % shareholding and per-filing
  // insider data above: real topInvestor block-deal trend with counterparty names, and NSE
  // bulk/block deals carrying pct_transacted (% of float, comparable across cap sizes, unlike
  // raw qty/value). Neither was on this page before.
  const { data: institutionalDeals } = trpc.getInstitutionalDealHistory.useQuery({ symbol, days: 30 }, { enabled: !!symbol });
  const { data: blockDeals } = trpc.getBlockDeals.useQuery({ symbol, limit: 20 }, { enabled: !!symbol });

  const sh = shareholding?.data ?? shareholding;
  // The live ET endpoint (fetchETShareholding) returns a nested { summary: { promoters: {
  // percentage, changeQoQ }, fii: {...}, dii: {...}, mf: {...}, pledge: {...} } } shape --
  // the flat promoter_pct/fii_pct/... fields only exist on the DB fallback path (no live
  // data). Read both, same dual-shape pattern already proven live in V1MFAnalysis.tsx.
  const holdingRows: [string, any][] = [
    ['Promoter %', sh?.summary?.promoters?.percentage ?? sh?.promoter_pct],
    ['FII %', sh?.summary?.fii?.percentage ?? sh?.fii_pct],
    ['DII %', sh?.summary?.dii?.percentage ?? sh?.dii_pct],
    ['MF %', sh?.summary?.mf?.percentage ?? sh?.mf_pct],
    ['Pledge %', sh?.summary?.pledge?.percentage ?? sh?.pledge_pct],
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card title="Shareholding Pattern" icon={Users}>
        {!sh ? (
          <div className="text-xs text-slate-500 py-4">No shareholding data captured yet for {symbol}.</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {holdingRows.map(([label, value]) => (
              <div key={label} className="glass rounded-xl p-2.5">
                <div className={cn(
                  'text-sm font-mono font-bold',
                  label === 'Pledge %' && Number(value) > 0 ? 'text-rose-400' : 'text-slate-100'
                )}>
                  {value != null ? `${fmt(value)}%` : '—'}
                </div>
                <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">{label}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Insider / Promoter Transactions" icon={ShieldAlert}>
        {!insiders || insiders.length === 0 ? (
          <div className="text-xs text-slate-500 py-4">No insider transactions recorded for {symbol}.</div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto terminal-scrollbar">
            {insiders.map((tx: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-[11px] border-b border-slate-800/40 pb-1.5">
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">{tx.person_name} <span className="text-slate-600">({tx.person_category})</span></div>
                  <div className="text-slate-600">{tx.transaction_date}</div>
                </div>
                <span className={cn(
                  'font-mono font-bold shrink-0 ml-2',
                  /buy|acqui/i.test(tx.transaction_mode ?? '') ? 'text-emerald-400' : 'text-rose-400'
                )}>
                  {tx.transaction_mode} · {fmt(tx.quantity, 0)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Superstar Investor Activity" icon={Star} className="lg:col-span-2">
        {!superstarActivity || superstarActivity.length === 0 ? (
          <div className="text-xs text-slate-500 py-4">No superstar investor activity recorded for {symbol}.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-80 overflow-y-auto terminal-scrollbar pr-1">
            {superstarActivity.map((row: any, i: number) => {
              const activity = String(row.change_type ?? 'update').toUpperCase();
              const pctChange = row.pct_holding_change != null ? Number(row.pct_holding_change) : null;
              const isNegative = activity === 'EXIT' || (pctChange != null && pctChange < 0);
              return (
                <div key={`${row.investor_slug}-${row.period_end_date}-${i}`} className="glass rounded-xl p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-200 truncate">
                      {String(row.investor_slug ?? 'investor').replace(/-/g, ' ')}
                    </span>
                    <span className={cn(
                      'text-[9px] font-black uppercase tracking-wide shrink-0 px-1.5 py-0.5 rounded-full border',
                      isNegative ? 'text-rose-400 border-rose-800/60 bg-rose-500/10' : 'text-emerald-400 border-emerald-800/60 bg-emerald-500/10'
                    )}>
                      {activity}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-slate-500">
                    <span>Holding: <span className="text-slate-300 font-mono">{row.curr_pct_holding != null ? `${fmt(row.curr_pct_holding)}%` : '—'}</span></span>
                    <span>Change: <span className={cn('font-mono', isNegative ? 'text-rose-400' : 'text-emerald-400')}>
                      {pctChange != null ? `${pctChange >= 0 ? '+' : ''}${fmt(pctChange)}%` : '—'}
                    </span></span>
                    <span>As of {row.period_end_date ?? '—'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Institutional Deal Trend (30d)" icon={Landmark}>
        {!institutionalDeals || institutionalDeals.length === 0 ? (
          <div className="text-xs text-slate-500 py-4">No topInvestor block-deal activity for {symbol} in the last 30 days.</div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto terminal-scrollbar">
            {institutionalDeals.map((row: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-[11px] border-b border-slate-800/40 pb-1.5">
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">{row.counterparty ?? '—'}</div>
                  <div className="text-slate-600">{row.deal_date}</div>
                </div>
                <span className={cn('font-mono font-bold shrink-0 ml-2', /buy/i.test(row.action ?? '') ? 'text-emerald-400' : 'text-rose-400')}>
                  {row.action} ₹{fmt(row.deal_value_cr_1w, 1)}Cr
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Bulk / Block Deals" icon={ShoppingBag}>
        {!blockDeals || blockDeals.length === 0 ? (
          <div className="text-xs text-slate-500 py-4">No bulk/block deals on record for {symbol}.</div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto terminal-scrollbar">
            {blockDeals.map((row: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-[11px] border-b border-slate-800/40 pb-1.5">
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">{row.client_name ?? '—'}</div>
                  <div className="text-slate-600">{row.date} · {row.trade_type}</div>
                </div>
                <span className="font-mono font-bold shrink-0 ml-2 text-slate-300">
                  {row.pct_transacted != null ? `${fmt(row.pct_transacted)}% of float` : `₹${fmt(row.value_cr, 1)}Cr`}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

// ─── F&O tab ────────────────────────────────────────────────────────────────
const FnoTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: signals } = trpc.getFnOSignals.useQuery({ symbol });
  const sentiment = signals?.marketSentiment;
  // Full F&O-eligible universe (already cached NiftyTrader-sourced list) -- gates the richer
  // PCR/max-pain/key-strikes card below so it only renders for symbols that actually trade
  // options (most of the ~2000-stock universe doesn't), instead of a per-stock empty state.
  const { data: fnoSymbols } = trpc.getFnoSymbols.useQuery();
  const isFnoEligible = fnoSymbols?.includes(symbol.toUpperCase());

  return (
    <div className="space-y-4">
      {isFnoEligible && <IndexFnoOverview symbol={symbol} />}
      {sentiment && (
        <Card title="Options-Implied Sentiment" icon={Landmark}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {([
              ['PCR', sentiment.pcr],
              ['Max Pain', sentiment.maxPain],
              ['OI Trend', sentiment.oiTrend],
              ['IV Rank', sentiment.ivRank],
            ] as [string, any][]).map(([label, value]) => (
              <div key={label} className="glass rounded-xl p-2.5 text-center">
                <div className="text-sm font-mono font-bold text-slate-100">
                  {typeof value === 'number' ? fmt(value) : (value ?? '—')}
                </div>
                <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">{label}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <OptionChainView defaultSymbol={symbol} />
    </div>
  );
};

// ─── Earnings tab ───────────────────────────────────────────────────────────
const ACTION_TYPE_COLOR: Record<string, string> = {
  dividend: 'text-emerald-400 bg-emerald-500/10',
  bonus:    'text-indigo-400 bg-indigo-500/10',
  split:    'text-sky-400 bg-sky-500/10',
  rights:   'text-amber-400 bg-amber-500/10',
};

const EarningsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: forecast } = trpc.getMcEarningsForecast.useQuery({ symbol });
  const { data: rating } = trpc.getMcAnalystRating.useQuery({ symbol });
  const { data: consensus } = trpc.getMcConsensus.useQuery({ symbol });
  const { data: priceTarget } = trpc.getMcPriceForecast.useQuery({ symbol });
  // Replaces getCorporateActions (raw ET live proxy, no persistence, no cross-check) with the
  // persisted + cross-checked pair (see MCStockInfoPanel's "actions" tab) -- same underlying
  // data, better quality, so this is a swap, not a second corporate-actions source on the page.
  const { data: actionHistory } = trpc.getCorporateActionHistory.useQuery({ symbol }, { enabled: !!symbol });
  const { data: filedActions } = trpc.getFiledCorporateActionsCalendar.useQuery({ symbol }, { enabled: !!symbol });
  // hitsMisses lives in the same getMcConsolidated response SwotCard/TechnicalsTab also read.
  const { data: mc } = trpc.getMcConsolidated.useQuery({ symbol }, { enabled: !!symbol, staleTime: 3600_000 });
  const hitsMisses = (mc as any)?.hitsMisses;
  const { data: concallTakeaways } = trpc.getConcallTakeaways.useQuery({ symbol, limit: 8 }, { enabled: !!symbol, staleTime: 900_000 });

  const hasRating = rating && rating.finalRating;
  const hasPriceTarget = priceTarget && (priceTarget.high || priceTarget.mean || priceTarget.low);
  const hasForecast = forecast && (forecast.eps?.length || forecast.revenue?.length || forecast.netProfit?.length);
  const hasConsensus = consensus && Array.isArray(consensus.graphData) && consensus.graphData.length > 0;

  const latestRow = (rows?: { date: string; high: string; low: string; avg: string; actual: string }[]) =>
    rows && rows.length > 0 ? rows[rows.length - 1] : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card title="Analyst Rating & Price Target" icon={CalendarClock}>
        {!hasRating && !hasPriceTarget ? (
          <div className="text-xs text-slate-500 py-4">No analyst coverage data captured yet for {symbol}.</div>
        ) : (
          <div className="space-y-3">
            {hasRating && (
              <div className="flex items-center justify-between">
                <div>
                  <span className={cn(
                    'text-sm font-black uppercase tracking-wide',
                    /buy/i.test(rating.finalRating) ? 'text-emerald-400' : /sell/i.test(rating.finalRating) ? 'text-rose-400' : 'text-amber-400'
                  )}>{rating.finalRating}</span>
                  <div className="text-[10px] text-slate-500 mt-0.5">{rating.analystCount} analysts covering</div>
                </div>
                {Array.isArray(rating.ratings) && (
                  <div className="flex gap-1.5">
                    {rating.ratings.map((r, i) => (
                      <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">{r.name}: {r.value}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {hasPriceTarget && (
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/60">
                <div className="glass rounded-xl p-2.5 text-center">
                  <div className="text-sm font-mono font-bold text-rose-400">₹{fmt(priceTarget.low)}</div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">Low Target</div>
                </div>
                <div className="glass rounded-xl p-2.5 text-center">
                  <div className="text-sm font-mono font-bold text-slate-100">₹{fmt(priceTarget.mean)}</div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">Mean Target</div>
                </div>
                <div className="glass rounded-xl p-2.5 text-center">
                  <div className="text-sm font-mono font-bold text-emerald-400">₹{fmt(priceTarget.high)}</div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">High Target</div>
                </div>
              </div>
            )}
            {hasConsensus && (
              <div className="pt-2 border-t border-slate-800/60">
                <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1.5">Latest Consensus Mix</div>
                <div className="flex flex-wrap gap-1.5">
                  {consensus.graphData.map((series, i) => (
                    Array.isArray(series.data) && series.data.length > 0 && (
                      <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                        {series.name}: {series.data[series.data.length - 1]}
                      </span>
                    )
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Earnings Estimates (latest period)" icon={CalendarClock}>
        {!hasForecast ? (
          <div className="text-xs text-slate-500 py-4">No earnings estimate data captured yet for {symbol}.</div>
        ) : (
          <div className="space-y-2.5">
            {([
              ['EPS', latestRow(forecast.eps)],
              ['Net Profit', latestRow(forecast.netProfit)],
              ['Revenue', latestRow(forecast.revenue)],
            ] as [string, ReturnType<typeof latestRow>][]).map(([label, row]) => row && (
              <div key={label} className="glass rounded-xl p-2.5">
                <div className="flex items-center justify-between text-[10px] text-slate-500 uppercase tracking-widest mb-1">
                  <span>{label}</span><span>{row.date}</span>
                </div>
                <div className="grid grid-cols-4 gap-2 text-center">
                  <div><div className="text-xs font-mono font-bold text-slate-100">{row.avg}</div><div className="text-[8px] text-slate-600">Avg Est</div></div>
                  <div><div className="text-xs font-mono font-bold text-rose-400">{row.low}</div><div className="text-[8px] text-slate-600">Low Est</div></div>
                  <div><div className="text-xs font-mono font-bold text-emerald-400">{row.high}</div><div className="text-[8px] text-slate-600">High Est</div></div>
                  <div><div className="text-xs font-mono font-bold text-indigo-300">{row.actual || '—'}</div><div className="text-[8px] text-slate-600">Actual</div></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {hitsMisses?.list && hitsMisses.list.length > 0 && (
        <Card title="Earnings Hits & Misses (EPS estimate track record)" icon={CalendarClock}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                  <th className="pb-2 pr-3">Quarter</th>
                  <th className="pb-2 pr-3 text-right">Actual</th>
                  <th className="pb-2 pr-3 text-right">Estimate</th>
                  <th className="pb-2 text-right">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {hitsMisses.list.map((row: any, i: number) => (
                  <tr key={i} className="font-bold">
                    <td className="py-1.5 pr-3 text-slate-300">{row.quarter}</td>
                    <td className="py-1.5 pr-3 text-right text-white">{row.actual || '—'}</td>
                    <td className="py-1.5 pr-3 text-right text-slate-300">{row.estimates || '—'}</td>
                    <td className="py-1.5 text-right">
                      <span className={cn(
                        'text-[9px] font-black px-2 py-0.5 rounded uppercase',
                        row.type === 'positive' ? 'bg-emerald-500/10 text-emerald-400' :
                        row.type === 'negative' ? 'bg-rose-500/10 text-rose-400' : 'bg-slate-800 text-slate-400'
                      )}>{row.type}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {concallTakeaways && concallTakeaways.length > 0 && (
        <Card title="Concall Takeaways (AI-Generated)" icon={Mic2}>
          <div className="space-y-2.5 max-h-72 overflow-y-auto terminal-scrollbar pr-1">
            {concallTakeaways.map((c: any, i: number) => (
              <div key={i} className="glass rounded-xl p-2.5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">
                    {c.quarter || c.fiscal_year || 'Latest concall'}
                  </span>
                  {c.tone_assessment && (
                    <span className={cn(
                      'text-[9px] font-black px-2 py-0.5 rounded uppercase shrink-0',
                      /positive|bullish/i.test(c.tone_assessment) ? 'bg-emerald-500/10 text-emerald-400' :
                      /negative|bearish|cautio/i.test(c.tone_assessment) ? 'bg-rose-500/10 text-rose-400' :
                      'bg-slate-800 text-slate-400'
                    )}>
                      {c.tone_assessment}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">{c.key_takeaway}</p>
                <p className="text-[9px] text-slate-600 mt-1">
                  {c.transcript_source ? `Source: ${c.transcript_source}` : ''}{c.announcement_date ? ` · ${c.announcement_date}` : ''}
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Corporate Actions" icon={CalendarClock} className="lg:col-span-2">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">MoneyControl history</div>
            {!actionHistory || actionHistory.length === 0 ? (
              <div className="text-xs text-slate-500 py-4">No dividend, bonus, split or rights history on record for {symbol}.</div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto terminal-scrollbar">
                {actionHistory.map((a: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-[11px] text-slate-400 border-b border-slate-800/40 pb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('text-[9px] px-1.5 py-0.5 rounded font-bold uppercase shrink-0', ACTION_TYPE_COLOR[a.action_type] ?? 'text-slate-400 bg-slate-500/10')}>
                        {a.action_type}
                      </span>
                      <span className="font-mono text-slate-300 shrink-0">{a.record_date || '—'}</span>
                      <span className="truncate">{a.ratio_text ?? (a.amount != null ? `₹${fmt(a.amount)}` : '')}</span>
                    </div>
                    {/* Cross-checked against ohlcv_adjustment_factors -- see getCorporateActionHistory's
                        crossCheck annotation and MCStockInfoPanel's identical "Verified" column. */}
                    {(a.crossCheck === 'confirmed_by_bhavcopy' || a.crossCheck === 'confirmed_via_this_source') ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-bold text-emerald-400 bg-emerald-500/10 shrink-0">✓ Confirmed</span>
                    ) : a.crossCheck === 'unconfirmed' ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-bold text-amber-400 bg-amber-500/10 shrink-0">⚠ Unconfirmed</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Filed with NSE (last/next 6 months)</div>
            {!filedActions || filedActions.length === 0 ? (
              <div className="text-xs text-slate-500 py-4">No NSE-filed corporate action in this window.</div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto terminal-scrollbar">
                {filedActions.map((f: any, i: number) => (
                  <a
                    key={i}
                    href={f.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-2 bg-slate-950/50 border border-slate-800/60 rounded-lg hover:border-slate-700 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase text-emerald-400 bg-emerald-500/10 shrink-0">
                        {(f.category || '').split('|')[0] || 'filing'}
                      </span>
                      <span className="text-[9px] text-slate-500 font-mono shrink-0">{f.filing_date}</span>
                    </div>
                    <p className="text-[11px] text-slate-200 mt-1 leading-snug line-clamp-2">{f.headline}</p>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
};

// ─── News & Sentiment tab ───────────────────────────────────────────────────
const NewsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: mcNewsData, isLoading: loadingMcNews } = trpc.getMcStockNews.useQuery(
    { symbol },
    { staleTime: 60000 },
  );
  const newsList = mcNewsData?.news ?? [];

  return (
    <Card title={`News & Sentiment — ${symbol}`} icon={Newspaper}>
      {loadingMcNews ? (
        <div className="text-xs text-slate-500 py-6 text-center animate-pulse">Fetching latest news for {symbol}…</div>
      ) : newsList.length === 0 ? (
        <McNewsEmptyState status={mcNewsData?.status} symbol={symbol} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {newsList.map((item, idx) => (
              <McNewsCard key={item.posturl || idx} item={item} accent="indigo" />
            ))}
          </div>

          <McNewsLinks
            additionalLinks={mcNewsData?.additional_links}
            moreLink={mcNewsData?.more_link}
            accent="indigo"
          />
        </div>
      )}
    </Card>
  );
};

// ─── Screener membership chips (Moneycontrol/Trendlyne "appears in" convention) ───
const SCREENER_SENTIMENT_STYLE: Record<string, string> = {
  bullish: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  bearish: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  neutral: 'bg-slate-700/40 text-slate-300 border-slate-600/40',
};

const ScreenerChips: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data } = trpc.getStockScreeners.useQuery({ stockId: symbol }, { enabled: !!symbol, staleTime: 15 * 60_000 });
  const screeners = data ?? [];
  const [showAll, setShowAll] = useState(false);
  if (screeners.length === 0) return null;
  const visible = showAll ? screeners : screeners.slice(0, 8);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tags className="w-3 h-3 text-slate-500 shrink-0" />
      {visible.map((s, i) => {
        // et_marketstats' finder doesn't carry a sentiment field (source data has no bull/bear
        // signal, just membership) -- default those to neutral styling rather than erroring.
        const sentiment = (s as { sentiment?: string }).sentiment ?? 'neutral';
        return (
          <span
            key={`${s.id}-${i}`}
            title={s.description || s.name}
            className={cn('px-1.5 py-0.5 rounded text-[9px] font-semibold border', SCREENER_SENTIMENT_STYLE[sentiment] ?? SCREENER_SENTIMENT_STYLE.neutral)}
          >
            {s.name}
          </span>
        );
      })}
      {!showAll && screeners.length > 8 && (
        <button onClick={() => setShowAll(true)} className="text-[9px] text-indigo-400 hover:text-indigo-300 font-semibold">
          +{screeners.length - 8} more
        </button>
      )}
    </div>
  );
};

// ─── Header: Moneycontrol/Trendlyne-style ticker card — price, tags, screeners ───
const StockHeaderCard: React.FC<{
  symbol: string;
  stockMeta?: { name?: string; sector?: string; industry?: string } | null;
  isWatched: boolean;
  onToggleWatchlist?: (symbol: string) => void;
  userId?: string | null;
}> = ({ symbol, stockMeta, isWatched, onToggleWatchlist, userId }) => {
  const { data: quote, dataUpdatedAt: quoteUpdatedAt } = trpc.getLiveStockQuote.useQuery({ symbol }, { enabled: !!symbol, refetchInterval: 30_000, retry: false });
  const { data: predictions } = trpc.getTechnicalPredictions.useQuery({ symbol }, { enabled: !!symbol });
  const { data: unifiedScore, dataUpdatedAt } = trpc.getUnifiedScoreForSymbol.useQuery({ symbol }, { enabled: !!symbol });
  const { data: fundamentals } = trpc.getStockFundamentals.useQuery({ symbol }, { enabled: !!symbol });

  const tagData = predictions ? { ...predictions, fcf_yield: (predictions as any).fcf_yield_approx } : {};
  const isUp = (quote?.changePct ?? 0) >= 0;

  return (
    <div className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900/80 to-slate-950/60 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-black text-slate-100 tracking-tight">{symbol}</h2>
            <ConvictionPill level={unifiedScore?.conviction_level} />
            {unifiedScore?.timeframe && (
              <span className="text-[9px] text-slate-500 uppercase tracking-widest">{unifiedScore.timeframe.replace('_', ' ')}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-0.5">
            <Building2 className="w-3 h-3 text-slate-600" />
            <span>{stockMeta?.name ?? '—'}</span>
            {stockMeta?.sector && <span className="text-slate-600">· {stockMeta.sector}</span>}
            {fundamentals?.market_cap != null && (
              <span className="text-slate-600">· Mkt Cap ₹{fmt(fundamentals.market_cap, 0)} Cr</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {quote?.price != null && (
            <div className="text-right">
              <div className="text-xl font-black font-mono text-slate-100">₹{fmt(quote.price, 2)}</div>
              <div className={cn('flex items-center justify-end gap-1 text-xs font-bold', isUp ? 'text-emerald-400' : 'text-rose-400')}>
                {isUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {fmt(quote.change, 2)} ({fmt(quote.changePct, 2)}%)
              </div>
              <PriceFreshnessBadge updatedAt={quoteUpdatedAt} thresholdMs={90_000} label="price" className="block mt-0.5" />
            </div>
          )}
          {onToggleWatchlist && (
            <button
              onClick={() => onToggleWatchlist(symbol)}
              className="p-2 rounded-lg glass hover:bg-indigo-500/10"
              title={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
            >
              {isWatched ? <Star className="w-4 h-4 text-amber-400 fill-amber-400" /> : <StarOff className="w-4 h-4 text-slate-500" />}
            </button>
          )}
          <AddToPortfolioButton symbol={symbol} currentPrice={quote?.price} userId={userId} variant="pill" />
        </div>
      </div>

      {unifiedScore?.trade_reasoning && (
        <p className="text-[11px] text-slate-400 leading-relaxed border-t border-slate-800/60 pt-2">
          <span className="text-indigo-400 font-semibold">Why: </span>{unifiedScore.trade_reasoning}
          {unifiedScore.engine_coverage_count != null && (
            <span className="text-slate-600 ml-1.5">({unifiedScore.engine_coverage_count}/7 engines · {relativeFromNow(dataUpdatedAt)})</span>
          )}
        </p>
      )}

      <StockTagRow p={tagData} className="border-t border-slate-800/60 pt-2" />
      <ScreenerChips symbol={symbol} />
    </div>
  );
};

// ─── Main page ──────────────────────────────────────────────────────────────
interface StockIntelligencePageProps {
  initialSymbol?: string | null;
  watchlist?: string[];
  onToggleWatchlist?: (symbol: string) => void;
  userId?: string | null;
}

export const StockIntelligencePage: React.FC<StockIntelligencePageProps> = ({
  initialSymbol, watchlist = [], onToggleWatchlist, userId,
}) => {
  const [symbol, setSymbol] = useState<string | null>(initialSymbol ?? null);
  const [tab, setTab] = useState<TabId>('overview');

  useEffect(() => { if (initialSymbol) setSymbol(initialSymbol); }, [initialSymbol]);

  const { data: stockMetaRaw } = trpc.getNSEStockBySymbol.useQuery({ symbol: symbol ?? '' }, { enabled: !!symbol });
  const stockMeta = stockMetaRaw as { name?: string; sector?: string; industry?: string } | null | undefined;
  const isWatched = symbol ? watchlist.includes(symbol) : false;

  return (
    <div className="space-y-4 pb-10">
      <V4QuickNav />
      <SymbolSearch onSelect={setSymbol} />

      {!symbol ? (
        <div className="text-center py-20 text-slate-500 text-sm">Search for a stock above to view its full intelligence profile.</div>
      ) : (
        <>
          <StockHeaderCard symbol={symbol} stockMeta={stockMeta} isWatched={isWatched} onToggleWatchlist={onToggleWatchlist} userId={userId} />

          <div className="flex gap-1 overflow-x-auto terminal-scrollbar border-b border-slate-800/60 pb-1">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-2 rounded-t-lg text-xs font-bold whitespace-nowrap transition-colors',
                    active ? 'bg-indigo-600/15 text-indigo-300 border-b-2 border-indigo-500' : 'text-slate-500 hover:text-slate-300'
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div>
            {tab === 'overview' && <OverviewTab symbol={symbol} sector={stockMeta?.sector} />}
            {tab === 'technicals' && <TechnicalsTab symbol={symbol} />}
            {tab === 'fundamentals' && <FundamentalsTab symbol={symbol} />}
            {tab === 'ownership' && <OwnershipTab symbol={symbol} />}
            {tab === 'fno' && <FnoTab symbol={symbol} />}
            {tab === 'earnings' && <EarningsTab symbol={symbol} />}
            {tab === 'news' && <NewsTab symbol={symbol} />}
          </div>
        </>
      )}
    </div>
  );
};

export default StockIntelligencePage;
