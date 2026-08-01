import React, { useState, useEffect, useMemo } from 'react';
import {
  Search, LayoutGrid, LineChart, BadgeDollarSign, Users, Landmark,
  CalendarClock, Newspaper, ShieldAlert, Star, StarOff, ArrowUpRight, ArrowDownRight,
  Building2, Tags,
} from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';
import { V2LightweightChart } from '../../v2/components/widgets/V2LightweightChart';
import { OptionChainView } from '../../components/OptionChainView';
import { WhyThisPick } from '../../components/WhyThisPick';
import { McNewsCard, McNewsLinks, McNewsEmptyState } from '../../components/McNewsCard';
import { StockTagRow, ConvictionPill } from '../../components/StockTagRow';
import { relativeFromNow } from '../../lib/timeFormat';
import { V4QuickNav } from '../components/V4QuickNav';

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
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto glass-strong rounded-xl border border-slate-800 terminal-scrollbar">
          {results.slice(0, 15).map((s: any) => (
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

// ─── Overview tab: unified score + reasoning (the "why", not shown anywhere else today) ──
const OverviewTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: scoreDetail } = trpc.getStockScoreDetail.useQuery({ symbol, timeframe: 'long_term' });
  const score = scoreDetail?.score;
  const factors = scoreDetail?.factors;

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
            <span className="text-[10px] text-slate-600 mt-0.5">{Math.round(score.confidence * 100)}% confidence</span>
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
                  r.sentiment === 'bullish' ? 'text-emerald-400' : r.sentiment === 'bearish' ? 'text-rose-400' : 'text-indigo-400'
                )}>›</span>
                {r.name}
                {r.source && <span className="text-slate-600 ml-1">({r.source})</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="lg:col-span-2">
        <WhyThisPick symbol={symbol} timeframe="long_term" />
      </div>
    </div>
  );
};

// ─── Technicals tab: REAL OHLCV chart (getOHLCData), not synthetic/random data ──
const TechnicalsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: ohlc, isLoading } = trpc.getOHLCData.useQuery({ symbol, dur: '6m' });
  const { data: predictions } = trpc.getTechnicalPredictions.useQuery({ symbol });

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
          {Array.isArray(predictions.patterns) && predictions.patterns.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-800/60">
              {predictions.patterns.map((p: string, i: number) => (
                <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">{p}</span>
              ))}
            </div>
          )}
          <TechnicalReadTags predictions={predictions} />
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

  if (!fundamentals) {
    return (
      <Card title="Fundamentals" icon={BadgeDollarSign}>
        <div className="text-xs text-slate-500 py-4">No fundamentals data captured yet for {symbol}.</div>
      </Card>
    );
  }

  return (
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
  );
};

// ─── Ownership & Insider tab — NEW, not shown anywhere in the app today ────
const OwnershipTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: shareholding } = trpc.getShareholding.useQuery({ symbol });
  const { data: insiders } = trpc.getInsiderTransactions.useQuery({ symbol, limit: 25 });
  const { data: mf } = trpc.getMFInvestments.useQuery({ symbol });

  const sh = shareholding?.data ?? shareholding;
  const holdingRows: [string, any][] = [
    ['Promoter %', sh?.promoter_pct ?? sh?.promoterHolding],
    ['FII %', sh?.fii_pct ?? sh?.fiiHolding],
    ['DII / MF %', sh?.mf_pct ?? sh?.mfHolding],
    ['Pledge %', sh?.pledge_pct ?? sh?.pledgePct],
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
        {mf && Array.isArray(mf) && mf.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-800/60">
            <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1.5">Mutual Fund Holders</div>
            {mf.slice(0, 5).map((m: any, i: number) => (
              <div key={i} className="flex justify-between text-[11px] text-slate-400 py-0.5">
                <span className="truncate">{m.fund_name ?? m.fundName ?? '—'}</span>
                <span className="font-mono text-slate-300">{fmt(m.holding_pct ?? m.pct)}%</span>
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
    </div>
  );
};

// ─── F&O tab ────────────────────────────────────────────────────────────────
const FnoTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: signals } = trpc.getFnOSignals.useQuery({ symbol });
  const sentiment = signals?.marketSentiment;

  return (
    <div className="space-y-4">
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
const EarningsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: forecast } = trpc.getMcEarningsForecast.useQuery({ symbol });
  const { data: rating } = trpc.getMcAnalystRating.useQuery({ symbol });
  const { data: consensus } = trpc.getMcConsensus.useQuery({ symbol });
  const { data: priceTarget } = trpc.getMcPriceForecast.useQuery({ symbol });
  const { data: actions } = trpc.getCorporateActions.useQuery({ symbol });

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

      <Card title="Corporate Actions" icon={CalendarClock} className="lg:col-span-2">
        {!actions || (Array.isArray(actions) && actions.length === 0) ? (
          <div className="text-xs text-slate-500 py-4">No recent corporate actions for {symbol}.</div>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto terminal-scrollbar">
            {(Array.isArray(actions) ? actions : []).map((a: any, i: number) => (
              <div key={i} className="flex justify-between text-[11px] text-slate-400 border-b border-slate-800/40 pb-1">
                <span>{a.action_type ?? a.purpose}</span>
                <span className="font-mono text-slate-300">{a.ex_date}</span>
              </div>
            ))}
          </div>
        )}
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
}> = ({ symbol, stockMeta, isWatched, onToggleWatchlist }) => {
  const { data: quote } = trpc.getLiveStockQuote.useQuery({ symbol }, { enabled: !!symbol, refetchInterval: 30_000, retry: false });
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
}

export const StockIntelligencePage: React.FC<StockIntelligencePageProps> = ({
  initialSymbol, watchlist = [], onToggleWatchlist,
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
          <StockHeaderCard symbol={symbol} stockMeta={stockMeta} isWatched={isWatched} onToggleWatchlist={onToggleWatchlist} />

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
            {tab === 'overview' && <OverviewTab symbol={symbol} />}
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
