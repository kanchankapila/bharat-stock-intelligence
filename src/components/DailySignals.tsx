import React, { useState, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import {
  TrendingDown, TrendingUp, Zap, RefreshCw, AlertCircle,
  Loader2, ChevronUp, ChevronDown, SlidersHorizontal, X,
  CheckCircle2, Activity, Target, BarChart2, ArrowUpRight, Plus, Minus
} from 'lucide-react';
import { cn } from '../lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

type SignalType =
  | 'RSI_DIVERGENCE' | 'HIDDEN_DIVERGENCE' | 'RESISTANCE_BREAKOUT'
  | 'MACD_CROSSOVER' | 'BB_COMPRESSION' | 'GOLDEN_CROSS' | 'OVERSOLD_RECOVERY'
  | 'EMA_BULL_STACK' | 'WEEK_52_BREAKOUT' | 'BULLISH_ENGULFING'
  | 'SUPERTREND_CROSS' | 'NR7_COMPRESSION'
  | 'VOLUME_ACCUMULATION' | 'NEAR_52W_HIGH' | 'CONSECUTIVE_STRENGTH' | 'ATR_CONTRACTION'
  | 'PCR_EXTREME' | 'DEATH_CROSS' | 'RSI_BEARISH_DIVERGENCE' | 'DISTRIBUTION_DAY'
  | 'CONVERGENCE_SIGNAL' | 'REGIME_SECTOR_SIGNAL' | 'QUALITY_OVERSOLD_SIGNAL';

type SignalStrength = 'HIGH' | 'MEDIUM' | 'WATCH';

interface TechSignal { type: SignalType; strength: SignalStrength; detail: string }

interface SignalRow {
  symbol: string;
  name?: string;
  sector?: string;
  date: string;
  signal_score: number;
  signals: TechSignal[];
  rsi?: number;
  sma50?: number;
  sma200?: number;
  macd?: number;
  macd_signal?: number;
  bb_width?: number;
  volume_ratio?: number;
  above_sma200?: number;
  cmp?: number;
  change_pct?: number;
  ai_insight?: string;
  entry_zone?: string;
  stop_loss?: string;
  targets?: string;
  setup_quality?: string;
  time_horizon?: string;
  news_sentiment_score?: number;
}

// ─── Signal metadata ──────────────────────────────────────────────────────────

const SIG_META: Record<SignalType, { label: string; short: string; color: string; bg: string }> = {
  RSI_DIVERGENCE:     { label: 'RSI Divergence',       short: 'RSI Div',    color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/30' },
  HIDDEN_DIVERGENCE:  { label: 'Hidden Divergence',    short: 'Hidden Div', color: 'text-indigo-400', bg: 'bg-indigo-500/10 border-indigo-500/30' },
  RESISTANCE_BREAKOUT:{ label: 'Resistance Breakout',  short: 'Breakout',   color: 'text-emerald-400',bg: 'bg-emerald-500/10 border-emerald-500/30' },
  MACD_CROSSOVER:     { label: 'MACD Crossover',       short: 'MACD ✗',    color: 'text-sky-400',    bg: 'bg-sky-500/10 border-sky-500/30' },
  BB_COMPRESSION:     { label: 'BB Compression',       short: 'Squeeze',    color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/30' },
  GOLDEN_CROSS:       { label: 'Golden Cross',         short: 'Golden ✗',  color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/30' },
  OVERSOLD_RECOVERY:  { label: 'Oversold Recovery',    short: 'OB Recov',   color: 'text-teal-400',   bg: 'bg-teal-500/10 border-teal-500/30' },
  EMA_BULL_STACK:     { label: 'EMA Bull Stack',       short: 'EMA Stack',  color: 'text-lime-400',   bg: 'bg-lime-500/10 border-lime-500/30' },
  WEEK_52_BREAKOUT:   { label: '52-Week Breakout',     short: '52W High',   color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/30' },
  BULLISH_ENGULFING:  { label: 'Bullish Engulfing',    short: 'Engulfing',  color: 'text-emerald-400',  bg: 'bg-emerald-500/10 border-emerald-500/30' },
  SUPERTREND_CROSS:   { label: 'SuperTrend Crossover', short: 'ST Flip↑',   color: 'text-cyan-400',   bg: 'bg-cyan-500/10 border-cyan-500/30' },
  NR7_COMPRESSION:     { label: 'NR7 Compression',       short: 'NR7',         color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/30' },
  VOLUME_ACCUMULATION:    { label: 'Volume Accumulation',   short: 'Vol Accum',    color: 'text-rose-400',    bg: 'bg-rose-500/10 border-rose-500/30' },
  NEAR_52W_HIGH:          { label: 'Near 52-Week High',     short: 'Near 52W',     color: 'text-fuchsia-400', bg: 'bg-fuchsia-500/10 border-fuchsia-500/30' },
  CONSECUTIVE_STRENGTH:   { label: 'Consecutive Strength',  short: 'Consec↑',      color: 'text-emerald-300', bg: 'bg-emerald-600/10 border-emerald-600/30' },
  ATR_CONTRACTION:        { label: 'ATR Contraction',       short: 'ATR Squeeze',  color: 'text-slate-300',   bg: 'bg-slate-500/10 border-slate-500/30' },
  PCR_EXTREME:            { label: 'PCR Extreme',           short: 'PCR Ext',      color: 'text-purple-300',  bg: 'bg-purple-500/10 border-purple-400/30' },
  DEATH_CROSS:            { label: 'Death Cross',           short: 'Death ✗',      color: 'text-rose-500',    bg: 'bg-rose-600/10 border-rose-600/30' },
  RSI_BEARISH_DIVERGENCE: { label: 'RSI Bear Divergence',   short: 'RSI Bear',     color: 'text-orange-400',  bg: 'bg-orange-600/10 border-orange-600/30' },
  DISTRIBUTION_DAY:       { label: 'Distribution Day',      short: 'Distribute',   color: 'text-rose-400',     bg: 'bg-rose-600/10 border-rose-600/30' },
  CONVERGENCE_SIGNAL:     { label: 'Convergence Signal',    short: 'Converge',     color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  REGIME_SECTOR_SIGNAL:   { label: 'Regime + Sector',       short: 'Regime+Sec',   color: 'text-indigo-400',  bg: 'bg-indigo-500/10 border-indigo-500/30' },
  QUALITY_OVERSOLD_SIGNAL:{ label: 'Quality Oversold',      short: 'Qual Ovsld',   color: 'text-teal-400',    bg: 'bg-teal-500/10 border-teal-500/30' },
};

const STRENGTH_COLOR: Record<SignalStrength, string> = {
  HIGH:   'text-emerald-400',
  MEDIUM: 'text-amber-400',
  WATCH:  'text-slate-400',
};

const STRENGTH_DOT: Record<SignalStrength, string> = {
  HIGH:   'bg-emerald-400',
  MEDIUM: 'bg-amber-400',
  WATCH:  'bg-slate-600',
};

// ─── Small helpers ────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const pct = score * 10;
  const color = score >= 7 ? 'bg-emerald-500' : score >= 4 ? 'bg-amber-500' : 'bg-slate-600';
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('text-xs font-black tabular-nums w-6 text-right', score >= 7 ? 'text-emerald-400' : score >= 4 ? 'text-amber-400' : 'text-slate-400')}>
        {score}
      </span>
    </div>
  );
}

function SignalPill({ sig }: { sig: TechSignal }) {
  const m = SIG_META[sig.type];
  if (!m) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-bold', m.bg, m.color)}>
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STRENGTH_DOT[sig.strength])} />
      {m.short}
    </span>
  );
}

function fmtPct(v?: number | null) {
  if (v == null) return <span className="text-slate-400">—</span>;
  return <span className={v >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{v >= 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

// ─── Timeframe returns cell ───────────────────────────────────────────────────

function TimeframeReturnsCell({ symbol }: { symbol: string }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
        }
      },
      { threshold: 0.05, rootMargin: '50px' }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [symbol]);

  const { data: trendlyneTa, isLoading } = trpc.getTrendlyneAdvTechnicalAnalysis.useQuery(
    { symbol },
    { enabled: isVisible, staleTime: 60000 }
  );

  if (!isVisible) {
    return <div ref={containerRef} className="h-6 w-32 bg-slate-800/10 rounded animate-pulse" />;
  }

  if (isLoading) {
    return <div className="text-[10px] text-slate-500 animate-pulse py-1">Loading...</div>;
  }

  if (!trendlyneTa?.body?.parameters?.price_analysis) {
    return <span className="text-slate-500 text-xs">—</span>;
  }

  const pa = trendlyneTa.body.parameters.price_analysis as any[];
  const findReturn = (name: string) => {
    const item = pa.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!item) return null;
    const isPositive = item.colorSafe === 'positive' || item.color === 'positive';
    const isNegative = item.colorSafe === 'negative' || item.color === 'negative';
    const changePctVal = item.changePercentSafe != null ? item.changePercentSafe : item.changePercent;
    const changePctFormatted = typeof changePctVal === 'number' ? changePctVal.toFixed(1) : changePctVal;
    return {
      name,
      formatted: `${isPositive ? '+' : ''}${changePctFormatted}%`,
      color: isPositive ? 'text-emerald-400 font-bold' : isNegative ? 'text-rose-400 font-bold' : 'text-slate-350'
    };
  };

  const w1 = findReturn('1 Week');
  const m1 = findReturn('1 Month');
  const m3 = findReturn('3 Months');
  const y1 = findReturn('1 Year');

  return (
    <div ref={containerRef} className="flex items-center gap-2.5 text-[10px] tabular-nums whitespace-nowrap">
      {w1 && (
        <span className="flex flex-col">
          <span className="text-[7.5px] text-slate-500 font-display uppercase tracking-wider font-bold">1W</span>
          <span className={w1.color}>{w1.formatted}</span>
        </span>
      )}
      {m1 && (
        <span className="flex flex-col">
          <span className="text-[7.5px] text-slate-500 font-display uppercase tracking-wider font-bold">1M</span>
          <span className={m1.color}>{m1.formatted}</span>
        </span>
      )}
      {m3 && (
        <span className="flex flex-col">
          <span className="text-[7.5px] text-slate-500 font-display uppercase tracking-wider font-bold">3M</span>
          <span className={m3.color}>{m3.formatted}</span>
        </span>
      )}
      {y1 && (
        <span className="flex flex-col">
          <span className="text-[7.5px] text-slate-500 font-display uppercase tracking-wider font-bold">1Y</span>
          <span className={y1.color}>{y1.formatted}</span>
        </span>
      )}
    </div>
  );
}

// ─── Expanded detail panel ────────────────────────────────────────────────────

function ExpandedRow({ r, onSelectStock }: { r: SignalRow; onSelectStock: (s: string) => void }) {
  const sma200Gap = r.sma200 && r.cmp ? ((r.cmp - r.sma200) / r.sma200 * 100) : null;
  const sma50Gap  = r.sma50  && r.cmp ? ((r.cmp - r.sma50)  / r.sma50  * 100) : null;

  const { data: trendlyneTa, isLoading: loadingTa } = trpc.getTrendlyneAdvTechnicalAnalysis.useQuery(
    { symbol: r.symbol },
    { staleTime: 60000 }
  );

  return (
    <tr>
      <td colSpan={11} className="px-4 pb-4 pt-0 bg-slate-900/60">
        <div className="rounded-xl border border-slate-800/50 bg-slate-900/40 p-4 space-y-4">
          {/* Signal details */}
          <div className="space-y-2">
            {r.signals.map((s, i) => {
              const m = SIG_META[s.type];
              if (!m) return null;
              return (
                <div key={i} className={cn('rounded-lg border px-3 py-2 flex items-start gap-3', m.bg)}>
                  <span className={cn('text-[10px] font-black font-display uppercase tracking-wider shrink-0 mt-0.5', m.color)}>{m.label}</span>
                  <span className={cn('text-[10px] font-bold font-display uppercase tracking-wider shrink-0 mt-0.5', STRENGTH_COLOR[s.strength])}>{s.strength}</span>
                  <span className="text-xs text-slate-400">{s.detail}</span>
                </div>
              );
            })}
          </div>

          {/* Trendlyne Performance Returns */}
          {loadingTa ? (
            <div className="flex items-center gap-2 py-2 text-xs text-slate-400 bg-slate-800/10 border border-slate-800/30 rounded-xl px-3 animate-pulse">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
              <span>Fetching timeframe returns from Trendlyne...</span>
            </div>
          ) : trendlyneTa?.body?.parameters?.price_analysis ? (
            <div className="v1-card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-indigo-400" />
                  Trendlyne Performance Returns ({trendlyneTa.body.parameters.beta_benchmark_index || 'NIFTY 50'})
                </span>
                {trendlyneTa.body.parameters.last_modified && (
                  <span className="text-[8px] text-slate-500">
                    Updated: {trendlyneTa.body.parameters.last_modified}
                  </span>
                )}
              </div>
              
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                {trendlyneTa.body.parameters.price_analysis.map((item: any, idx: number) => {
                  const isPositive = item.colorSafe === 'positive' || item.color === 'positive';
                  const isNegative = item.colorSafe === 'negative' || item.color === 'negative';
                  const changePctVal = item.changePercentSafe != null ? item.changePercentSafe : item.changePercent;
                  const changePctFormatted = typeof changePctVal === 'number' ? changePctVal.toFixed(1) : changePctVal;
                  
                  return (
                    <div 
                      key={idx} 
                      className="flex-shrink-0 min-w-[80px] p-2 bg-slate-950/60 rounded-lg border border-slate-800/40 flex flex-col justify-between hover:border-slate-700 transition-colors"
                    >
                      <span className="text-[8px] font-bold text-slate-500 font-display uppercase tracking-wider">{item.name}</span>
                      <span className={cn(
                        "text-[11px] font-black italic mt-0.5",
                        isPositive ? "text-emerald-400" : isNegative ? "text-rose-400" : "text-slate-350"
                      )}>
                        {isPositive ? '+' : ''}{changePctFormatted}%
                      </span>
                    </div>
                  );
                })}
              </div>

              {trendlyneTa.body.parameters.price_insight && trendlyneTa.body.parameters.price_insight.length > 0 && (
                <div className="space-y-1 pt-1.5 border-t border-slate-800/40">
                  {trendlyneTa.body.parameters.price_insight.slice(0, 3).map((insight: any, idx: number) => (
                    <div key={idx} className={cn("text-[9px] px-2 py-0.5 rounded border flex items-center gap-1.5", 
                      insight.color === 'positive' ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-400" :
                      insight.color === 'negative' ? "bg-rose-500/5 border-rose-500/10 text-rose-400" :
                      "bg-slate-900 border-slate-800 text-slate-400"
                    )}>
                      <span className="inline-block w-1 h-1 rounded-full bg-current shrink-0" />
                      <span>{insight.longtext || insight.shorttext || String(insight)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* Indicator grid */}
          <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-2">
            {[
              { label: 'RSI(14)',    value: r.rsi?.toFixed(1) },
              { label: 'vs SMA50',  value: sma50Gap != null ? `${sma50Gap >= 0 ? '+' : ''}${sma50Gap.toFixed(1)}%` : null },
              { label: 'vs SMA200', value: sma200Gap != null ? `${sma200Gap >= 0 ? '+' : ''}${sma200Gap.toFixed(1)}%` : null },
              { label: 'Vol Ratio', value: r.volume_ratio?.toFixed(2) + '×' },
              { label: 'MACD',      value: r.macd?.toFixed(3) },
              { label: 'Signal',    value: r.macd_signal?.toFixed(3) },
              { label: 'BB Width',  value: r.bb_width?.toFixed(3) },
              { label: 'SMA200',    value: r.above_sma200 ? '✓ Above' : '✗ Below' },
              { label: 'News Sent', value: r.news_sentiment_score != null ? `${r.news_sentiment_score >= 0 ? '+' : ''}${r.news_sentiment_score.toFixed(2)}` : '0.00' },
            ].map(({ label, value }) => (
              <div key={label} className="bg-slate-800/50 rounded-lg p-2 text-center">
                <div className="text-[9px] font-bold font-display uppercase tracking-wider text-slate-400 mb-0.5">{label}</div>
                <div className="text-xs font-bold text-slate-200">{value ?? '—'}</div>
              </div>
            ))}
          </div>

          {/* AI insight */}
          {r.ai_insight && (
            <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-3 space-y-2">
              <p className="text-xs font-bold text-indigo-400 font-display uppercase tracking-wider">AI Analysis</p>
              <p className="text-sm text-slate-300 leading-relaxed">{r.ai_insight}</p>
              <div className="grid grid-cols-3 gap-2 mt-2">
                {r.entry_zone && (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-center">
                    <div className="text-[9px] font-bold text-emerald-500 font-display uppercase tracking-wider">Entry</div>
                    <div className="text-xs text-emerald-300 font-bold mt-0.5">{r.entry_zone}</div>
                  </div>
                )}
                {r.stop_loss && (
                  <div className="bg-rose-500/10 border border-rose-500/20 rounded-lg p-2 text-center">
                    <div className="text-[9px] font-bold text-rose-500 font-display uppercase tracking-wider">Stop Loss</div>
                    <div className="text-xs text-rose-300 font-bold mt-0.5">{r.stop_loss}</div>
                  </div>
                )}
                {r.targets && (
                  <div className="bg-sky-500/10 border border-sky-500/20 rounded-lg p-2 text-center">
                    <div className="text-[9px] font-bold text-sky-500 font-display uppercase tracking-wider">Targets</div>
                    <div className="text-xs text-sky-300 font-bold mt-0.5">{r.targets}</div>
                  </div>
                )}
              </div>
              {(r.setup_quality || r.time_horizon) && (
                <div className="flex items-center gap-3 text-[10px] text-slate-400">
                  {r.setup_quality && <span>Quality: <span className="text-slate-300 font-bold">{r.setup_quality}</span></span>}
                  {r.time_horizon  && <span>Horizon: <span className="text-slate-300 font-bold">{r.time_horizon}</span></span>}
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => onSelectStock(r.symbol)}
            className="text-xs font-bold text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            View full chart & details →
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Filter panel ─────────────────────────────────────────────────────────────

interface Filters { minScore: number; signalTypes: SignalType[]; aboveSma200: boolean; minVolumeRatio: number }

function FilterPanel({ filters, onChange, onClose }: {
  filters: Filters;
  onChange: (f: Filters) => void;
  onClose: () => void;
}) {
  const [local, setLocal] = useState<Filters>(filters);

  const allTypes = Object.keys(SIG_META) as SignalType[];

  return (
    <div className="glass border border-slate-800/30 rounded-2xl p-4 space-y-4 w-80 shadow-2xl">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-slate-200">Filters</span>
        <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
      </div>

      <div>
        <label className="text-[10px] font-bold font-display uppercase tracking-wider text-slate-400">Min Score: {local.minScore}</label>
        <input type="range" min={1} max={10} value={local.minScore}
          onChange={e => setLocal(p => ({ ...p, minScore: +e.target.value }))}
          className="w-full mt-1 accent-indigo-500"
        />
      </div>

      <div>
        <label className="text-[10px] font-bold font-display uppercase tracking-wider text-slate-400 block mb-2">Signal Types</label>
        <div className="flex flex-wrap gap-1.5">
          {allTypes.map(t => {
            const m = SIG_META[t];
            const active = local.signalTypes.length === 0 || local.signalTypes.includes(t);
            return (
              <button
                key={t}
                onClick={() => setLocal(p => {
                  const cur = p.signalTypes.length === 0 ? allTypes : p.signalTypes;
                  const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
                  return { ...p, signalTypes: next.length === allTypes.length ? [] : next };
                })}
                className={cn('px-2 py-0.5 rounded-md border text-[10px] font-bold transition-all',
                  active ? cn(m.bg, m.color) : 'bg-slate-800 border-slate-800/30 text-slate-400'
                )}
              >{m.short}</button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input id="sma200f" type="checkbox" checked={local.aboveSma200}
          onChange={e => setLocal(p => ({ ...p, aboveSma200: e.target.checked }))}
          className="rounded" />
        <label htmlFor="sma200f" className="text-sm text-slate-300">Above SMA200 only</label>
      </div>

      <div>
        <label className="text-[10px] font-bold font-display uppercase tracking-wider text-slate-400">
          Min Volume Ratio: {local.minVolumeRatio.toFixed(1)}×
        </label>
        <input type="range" min={1} max={5} step={0.5} value={local.minVolumeRatio}
          onChange={e => setLocal(p => ({ ...p, minVolumeRatio: +e.target.value }))}
          className="w-full mt-1 accent-indigo-500"
        />
      </div>

      <div className="flex gap-2">
        <button onClick={() => { onChange(local); onClose(); }}
          className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold py-2 rounded-xl transition-colors">Apply</button>
        <button onClick={() => { const d = { minScore: 1, signalTypes: [], aboveSma200: false, minVolumeRatio: 1 }; setLocal(d); onChange(d); onClose(); }}
          className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-bold py-2 rounded-xl transition-colors">Reset</button>
      </div>
    </div>
  );
}

// ─── Sort header ──────────────────────────────────────────────────────────────

function SortTh({ label, sortKey, sort, onSort }: {
  label: string; sortKey: string;
  sort: { key: string; dir: 'asc' | 'desc' };
  onSort: (k: string) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-400 cursor-pointer hover:text-slate-300 select-none whitespace-nowrap"
      onClick={() => onSort(sortKey)}>
      <span className="flex items-center gap-1">
        {label}
        {active && (sort.dir === 'desc' ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}
      </span>
    </th>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface DailySignalsProps {
  onSelectStock: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
}

export function DailySignals({ onSelectStock, watchlist = [], onToggleWatchlist }: DailySignalsProps) {
  const [selectedDate, setSelectedDate] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<Filters>({ minScore: 1, signalTypes: [], aboveSma200: false, minVolumeRatio: 1 });
  const [showFilters, setShowFilters] = useState(false);
  const [showWinRates, setShowWinRates] = useState(false);
  const [showSector, setShowSector] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'signal_score', dir: 'desc' });
  const [expanded, setExpanded] = useState<string | null>(null);

  const [isScanning, setIsScanning] = React.useState(false);
  const { data: status, refetch: refetchStatus } = trpc.getTechnicalSignalsStatus.useQuery(
    undefined, { refetchInterval: isScanning ? 15_000 : 60_000 }
  );
  const { data: dates } = trpc.getSignalDates.useQuery();
  const { data: rawRows, isLoading, error, refetch } = trpc.getTechnicalSignals.useQuery(
    { date: selectedDate, minScore: filters.minScore, limit: 200 }
  );
  const { data: winRates } = trpc.getSignalWinRates.useQuery(undefined, { enabled: showWinRates });
  const { data: sectorStats } = trpc.getSectorSignalStats.useQuery(
    { date: selectedDate }, { enabled: showSector }
  );
  const rescan = trpc.runTechnicalSignalScan.useMutation({
    onMutate: () => setIsScanning(true),
    onSuccess: () => { refetch(); refetchStatus(); },
    onSettled: () => setIsScanning(false),
  });

  const rows = (rawRows as SignalRow[] | undefined) ?? [];

  const filtered = useMemo(() => {
    let r = [...rows];
    if (filters.aboveSma200) r = r.filter(s => s.above_sma200 === 1);
    if (filters.minVolumeRatio > 1) r = r.filter(s => (s.volume_ratio ?? 0) >= filters.minVolumeRatio);
    if (filters.signalTypes.length > 0) {
      r = r.filter(s => s.signals.some(sig => filters.signalTypes.includes(sig.type)));
    }
    r.sort((a, b) => {
      const av = ((a as unknown) as Record<string, number>)[sort.key] ?? 0;
      const bv = ((b as unknown) as Record<string, number>)[sort.key] ?? 0;
      return sort.dir === 'desc' ? bv - av : av - bv;
    });
    return r;
  }, [rows, filters, sort]);

  function toggleSort(key: string) {
    setSort(p => p.key === key ? { key, dir: p.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  }

  const summary = (status as { summary?: Record<string, unknown> } | undefined)?.summary;
  const prog    = (status as { progress?: { isRunning?: boolean } } | undefined)?.progress;
  const byType  = (summary as { bySignalType?: Record<string, number> } | undefined)?.bySignalType ?? {};
  const byScore = (summary as { byScore?: Record<string, number> } | undefined)?.byScore ?? {};
  const totalToday = (summary as { totalToday?: number } | undefined)?.totalToday ?? 0;
  const lastComputed = (summary as { lastComputed?: string } | undefined)?.lastComputed;

  const activeFilterCount = [
    filters.minScore > 1,
    filters.signalTypes.length > 0,
    filters.aboveSma200,
    filters.minVolumeRatio > 1,
  ].filter(Boolean).length;

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div>
          <h2 className="v1-title-page tracking-tight flex items-center gap-2">
            <Zap className="w-6 h-6 text-amber-400" />
            Daily Technical Signals
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            {totalToday > 0
              ? `${totalToday} setups detected today across all NSE stocks`
              : 'Scan runs daily at 8:30 AM IST — 12 pattern types across all NSE stocks'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {prog?.isRunning && (
            <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Scanning…
            </div>
          )}
          <button
            onClick={() => setShowFilters(p => !p)}
            className={cn('flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold border transition-colors',
              showFilters || activeFilterCount > 0
                ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                : 'bg-slate-800 border-slate-800/30 text-slate-400 hover:text-white'
            )}
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters {activeFilterCount > 0 && (
              <span className="bg-indigo-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]">{activeFilterCount}</span>
            )}
          </button>
          <button
            onClick={() => { refetch(); refetchStatus(); }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold bg-slate-800 border border-slate-800/30 text-slate-400 hover:text-white transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowSector(p => !p)}
            className={cn('flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold border transition-colors',
              showSector
                ? 'bg-violet-600/20 border-violet-500/40 text-violet-300'
                : 'bg-slate-800 border-slate-800/30 text-slate-400 hover:text-white'
            )}
          >
            <Activity className="w-4 h-4" />
            Sectors
          </button>
          <button
            onClick={() => setShowWinRates(p => !p)}
            className={cn('flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold border transition-colors',
              showWinRates
                ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-800 border-slate-800/30 text-slate-400 hover:text-white'
            )}
          >
            <BarChart2 className="w-4 h-4" />
            Win Rates
          </button>
          <button
            onClick={() => rescan.mutate({})}
            disabled={rescan.isPending || prog?.isRunning}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold bg-amber-600/20 border border-amber-500/30 text-amber-300 hover:text-amber-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Activity className="w-4 h-4" />
            {rescan.isPending ? 'Queuing…' : 'Rescan'}
          </button>
        </div>
      </div>

      {/* Summary stats */}
      {totalToday > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="rounded-xl border border-slate-800/50 bg-slate-950/30 p-3">
            <div className="v1-data-label">Total Setups</div>
            <div className="v1-data-value text-slate-100 tabular-nums mt-1">{totalToday}</div>
          </div>
          {Object.entries(byScore).map(([band, count]) => (
            <div key={band} className="rounded-xl border border-slate-800/50 bg-slate-950/30 p-3">
              <div className="v1-data-label">Score {band}</div>
              <div className={cn('v1-data-value tabular-nums mt-1',
                band === '7-10' ? 'text-emerald-400' : band === '4-6' ? 'text-amber-400' : 'text-slate-400'
              )}>{count}</div>
            </div>
          ))}
          {lastComputed && (
            <div className="rounded-xl border border-slate-800/50 bg-slate-950/30 p-3 col-span-2 md:col-span-1">
              <div className="v1-data-label">Last Computed</div>
              <div className="v1-data-value text-slate-300 mt-1">
                {new Date(lastComputed).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Signal type breakdown */}
      {Object.keys(byType).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(Object.entries(byType) as [SignalType, number][]).map(([type, count]) => {
            const m = SIG_META[type];
            if (!m) return null;
            return (
              <div key={type} className={cn('flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-bold', m.bg, m.color)}>
                {m.label}
                <span className="opacity-70">{count}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Date selector */}
      {dates && dates.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold font-display uppercase tracking-wider text-slate-400">Date:</span>
          {dates.slice(0, 7).map(d => (
            <button key={d}
              onClick={() => setSelectedDate(d === selectedDate ? undefined : d)}
              className={cn('px-3 py-1 rounded-lg text-xs font-bold border transition-colors',
                d === (selectedDate ?? dates[0])
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-800/30 text-slate-400 hover:text-white'
              )}
            >{d}</button>
          ))}
        </div>
      )}

      {/* Win Rate Panel */}
      {showWinRates && (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="v1-title-section flex items-center gap-2">
              <BarChart2 className="w-4 h-4" />
              Historical Win Rates
            </p>
            <p className="text-[10px] text-slate-400">Based on actual stock prices N days after signal date</p>
          </div>

          {/* A win rate is not a comparable number without the labeling convention behind it:
              measurement.md records path_barrier (max-favorable-excursion) and terminal_pct2
              (fixed +/-2% terminal) producing 88-91% vs 41-44% over the IDENTICAL calendar
              window, i.e. the gap is almost entirely the label, not skill. Rendering the
              percentage alone invites reading a path-barrier number as if it were a terminal
              one. Same disclosure principle as LegacyScoreBanner on the non-canonical scoring
              pages. */}
          {winRates?.labelDefinition && (
            <p className="text-[10px] leading-relaxed text-amber-300/80 border border-amber-500/20 bg-amber-500/5 rounded-lg px-2.5 py-1.5">
              Labeled <span className="font-data font-bold">{winRates.labelDefinition}</span> —
              a path-based max-favorable-excursion rule, counting a WIN if the barrier was touched
              at any point in the window. It is <span className="font-bold">not comparable</span> to
              a fixed terminal-return win rate, which runs far lower on the same signals. Technical
              scanner outcomes only; confluence-sourced signals use a different rule and are excluded.
            </p>
          )}

          {!winRates && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading win rate data…
            </div>
          )}

          {winRates && winRates.overall.total === 0 && (
            <p className="text-sm text-slate-400">No resolved outcomes yet. Win rates populate automatically as signal dates age past 5 and 15 days.</p>
          )}

          {winRates && winRates.overall.total > 0 && (
            <>
              {/* Overall stats */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  { label: 'Total Trades', value: winRates.overall.total.toString(), color: 'text-slate-100', card: 'v1-card-neutral' as const },
                  { label: 'Win Rate', value: `${winRates.overall.winRate.toFixed(1)}%`, color: winRates.overall.winRate >= 55 ? 'text-emerald-400' : winRates.overall.winRate >= 45 ? 'text-amber-400' : 'text-rose-400', card: winRates.overall.winRate >= 55 ? 'v1-card-up' as const : winRates.overall.winRate >= 45 ? 'v1-card-neutral' as const : 'v1-card-down' as const },
                  { label: 'Avg Return', value: `${winRates.overall.avgReturn >= 0 ? '+' : ''}${winRates.overall.avgReturn.toFixed(2)}%`, color: winRates.overall.avgReturn >= 0 ? 'text-emerald-400' : 'text-rose-400', card: winRates.overall.avgReturn >= 0 ? 'v1-card-up' as const : 'v1-card-down' as const },
                  { label: 'Avg Win', value: `+${winRates.overall.avgWin.toFixed(2)}%`, color: 'text-emerald-400', card: 'v1-card-up' as const },
                  { label: 'Avg Loss', value: `${winRates.overall.avgLoss.toFixed(2)}%`, color: 'text-rose-400', card: 'v1-card-down' as const },
                ].map(({ label, value, color, card }) => (
                  <div key={label} className={cn(card, 'p-3 text-center')}>
                    <div className="v1-data-label mb-1">{label}</div>
                    <div className={cn('v1-data-value tabular-nums', color)}>{value}</div>
                  </div>
                ))}
              </div>

              {/* By horizon */}
              <div className="grid grid-cols-2 gap-3">
                {([5, 15] as const).map(h => {
                  const hd = winRates.byHorizon[h];
                  if (!hd || hd.total === 0) return null;
                  return (
                    <div key={h} className="v1-card p-3">
                      <p className="text-[10px] font-bold font-display uppercase tracking-wider text-slate-400 mb-2">{h}-Day Horizon</p>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-400">{hd.total} trades</span>
                        <span className={cn('text-lg font-black', hd.winRate >= 55 ? 'text-emerald-400' : hd.winRate >= 45 ? 'text-amber-400' : 'text-rose-400')}>
                          {hd.winRate.toFixed(1)}% WR
                        </span>
                        <span className={cn('text-sm font-bold', hd.avgReturn >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                          {hd.avgReturn >= 0 ? '+' : ''}{hd.avgReturn.toFixed(2)}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* By signal type */}
              {Object.keys(winRates.bySignalType).length > 0 && (
                <div>
                  <p className="text-[10px] font-bold font-display uppercase tracking-wider text-slate-400 mb-2">Win Rate by Signal Type</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {(Object.entries(winRates.bySignalType) as [SignalType, { total: number; wins: number; winRate: number; avgReturn: number }][])
                      .sort((a, b) => b[1].winRate - a[1].winRate)
                      .map(([type, stats]) => {
                        const m = SIG_META[type];
                        if (!m || stats.total < 3) return null;
                        const wr = stats.winRate;
                        return (
                          <div key={type} className="flex items-center gap-3 bg-slate-900/40 rounded-lg border border-slate-800/50 px-3 py-2">
                            <span className={cn('text-[10px] font-black min-w-[80px]', m.color)}>{m.short}</span>
                            <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div className={cn('h-full rounded-full', wr >= 55 ? 'bg-emerald-500' : wr >= 45 ? 'bg-amber-500' : 'bg-rose-500')}
                                style={{ width: `${Math.min(wr, 100)}%` }} />
                            </div>
                            <span className={cn('text-xs font-black w-12 text-right tabular-nums', wr >= 55 ? 'text-emerald-400' : wr >= 45 ? 'text-amber-400' : 'text-rose-400')}>
                              {wr.toFixed(0)}%
                            </span>
                            <span className="text-[10px] text-slate-400 w-12 text-right tabular-nums">n={stats.total}</span>
                          </div>
                        );
                      })
                    }
                  </div>
                </div>
              )}

              {/* By score bucket */}
              {Object.keys(winRates.byScoreBucket).length > 0 && (
                <div>
                  <p className="text-[10px] font-bold font-display uppercase tracking-wider text-slate-400 mb-2">Win Rate by Signal Score</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(['7-10', '4-6', '1-3'] as const).map(bucket => {
                      const b = winRates.byScoreBucket[bucket];
                      if (!b || b.total === 0) return null;
                      return (
                        <div key={bucket} className="v1-card p-3 text-center">
                          <div className="text-[9px] font-bold font-display uppercase tracking-wider text-slate-400 mb-1">Score {bucket}</div>
                          <div className={cn('text-lg font-black', b.winRate >= 55 ? 'text-emerald-400' : b.winRate >= 45 ? 'text-amber-400' : 'text-rose-400')}>
                            {b.winRate.toFixed(0)}%
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5">{b.total} trades</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Sector Momentum Panel */}
      {showSector && (
        <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="v1-title-section flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Sector Momentum — Sympathy Play Radar
            </p>
            <p className="text-[10px] text-slate-400">Sectors with most technical setups today · use to find sympathy stocks before they move</p>
          </div>

          {(!sectorStats || sectorStats.length === 0) && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading sector data…
            </div>
          )}

          {sectorStats && sectorStats.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {sectorStats.slice(0, 9).map(sec => (
                <div key={sec.sector}
                  className={cn('rounded-xl border p-3 space-y-2',
                    sec.hotFlag
                      ? 'border-violet-500/40 bg-violet-500/10'
                      : 'border-slate-800/30 bg-slate-900/40'
                  )}
                >
                  {/* Sector header */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-black text-slate-100 truncate">{sec.sector}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {sec.hotFlag && (
                        <span className="text-[9px] font-black bg-violet-500 text-white px-1.5 py-0.5 rounded-full">🔥 HOT</span>
                      )}
                      <span className="text-[10px] font-bold text-violet-300 bg-violet-500/20 px-2 py-0.5 rounded-full">
                        {sec.totalSignals} setups
                      </span>
                    </div>
                  </div>

                  {/* Avg score bar */}
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-400 w-16 shrink-0">Avg score</span>
                    <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', sec.avgScore >= 6 ? 'bg-emerald-500' : sec.avgScore >= 4 ? 'bg-amber-500' : 'bg-slate-600')}
                        style={{ width: `${sec.avgScore * 10}%` }}
                      />
                    </div>
                    <span className={cn('text-[10px] font-black w-6 tabular-nums', sec.avgScore >= 6 ? 'text-emerald-400' : sec.avgScore >= 4 ? 'text-amber-400' : 'text-slate-400')}>
                      {sec.avgScore}
                    </span>
                  </div>

                  {/* Top stocks */}
                  <div className="space-y-1">
                    {sec.topStocks.slice(0, 3).map(s => (
                      <div key={s.symbol}
                        className="flex items-center gap-2 cursor-pointer hover:bg-white/5 rounded-lg px-1.5 py-1 transition-colors"
                        onClick={() => onSelectStock(s.symbol)}
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-[11px] font-bold text-slate-200">{s.symbol}</span>
                          {s.name && s.name !== s.symbol && (
                            <span className="text-[9px] text-slate-400 ml-1 truncate hidden sm:inline">{s.name}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className={cn('text-[9px] font-bold', s.changePct == null ? 'text-slate-500' : s.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                            {s.changePct == null ? '—' : `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(1)}%`}
                          </span>
                          <span className={cn('text-[9px] font-black px-1 py-0.5 rounded',
                            s.score >= 7 ? 'bg-emerald-500/20 text-emerald-400' :
                            s.score >= 4 ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-700 text-slate-400'
                          )}>{s.score}</span>
                        </div>
                        {/* Signal type pills (max 2) */}
                        <div className="flex gap-0.5">
                          {s.signalTypes.slice(0, 2).map(t => {
                            const m = SIG_META[t as SignalType];
                            return m ? (
                              <span key={t} className={cn('text-[8px] font-bold px-1 py-0.5 rounded border', m.bg, m.color)}>
                                {m.short}
                              </span>
                            ) : null;
                          })}
                        </div>
                      </div>
                    ))}
                  </div>

                  {sec.highScoreCount > 0 && (
                    <p className="text-[9px] text-emerald-400 font-bold">
                      {sec.highScoreCount} stock{sec.highScoreCount > 1 ? 's' : ''} with score ≥ 7
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-slate-400">
            💡 When a sector peer reports strong earnings/order win, other stocks in the same sector often move in sympathy within 1-2 sessions. Use this panel to front-run that rotation.
          </p>
        </div>
      )}

      {/* Filter panel */}
      {showFilters && (
        <FilterPanel filters={filters} onChange={setFilters} onClose={() => setShowFilters(false)} />
      )}

      {/* Error */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
          <div>
            <p className="text-sm font-bold text-rose-400">Failed to load signals</p>
            <p className="text-xs text-slate-400 mt-0.5">{(error as { message?: string })?.message}</p>
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoading && !rows.length && (
        <div className="flex items-center justify-center py-24 gap-3 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading signal data…</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && totalToday === 0 && (
        <div className="flex flex-col items-center py-24 gap-4 text-center">
          <Zap className="w-12 h-12 text-slate-300" />
          <p className="text-slate-200 font-bold">No signals computed yet for today</p>
          <p className="text-slate-400 text-sm max-w-sm">
            The scanner runs automatically at 8:30 AM IST. You can also trigger it manually via the Rescan button.
          </p>
        </div>
      )}

      {/* Results table */}
      {filtered.length > 0 && (
        <div className="rounded-2xl border border-slate-800/50 bg-slate-950/30 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-800/50">
              <tr>
                <th className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-400 w-6">#</th>
                <SortTh label="Symbol"   sortKey="symbol"       sort={sort} onSort={toggleSort} />
                <th className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-400">Signals</th>
                <SortTh label="Score"    sortKey="signal_score" sort={sort} onSort={toggleSort} />
                <SortTh label="CMP"      sortKey="cmp"          sort={sort} onSort={toggleSort} />
                <SortTh label="Chg%"     sortKey="change_pct"   sort={sort} onSort={toggleSort} />
                <th className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-400">Trendlyne Returns</th>
                <SortTh label="RSI"      sortKey="rsi"          sort={sort} onSort={toggleSort} />
                <SortTh label="Vol Ratio" sortKey="volume_ratio" sort={sort} onSort={toggleSort} />
                <th className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-400">SMA200</th>
                <th className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-400">AI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40">
              {filtered.map((r, i) => (
                <React.Fragment key={r.symbol}>
                  <tr
                    className={cn('cursor-pointer transition-colors', expanded === r.symbol ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]')}
                    onClick={() => setExpanded(expanded === r.symbol ? null : r.symbol)}
                  >
                    <td className="py-2.5 px-3 text-slate-400 text-xs">{i + 1}</td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <div onClick={(e) => e.stopPropagation()}>
                          {watchlist.includes(r.symbol) ? (
                            <button
                              onClick={() => onToggleWatchlist(r.symbol)}
                              className="p-1 bg-rose-500/10 border border-rose-500/20 rounded text-rose-500 hover:bg-rose-500 hover:text-indigo-600 transition-all shadow-sm flex items-center justify-center w-5.5 h-5.5"
                              title="Remove from Watchlist"
                            >
                              <Minus className="w-2.5 h-2.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => onToggleWatchlist(r.symbol, { price: r.cmp, name: r.name, source: `Scanner: ${r.signals[0]?.detail || 'Technical Scan'}` })}
                              className="p-1 bg-emerald-500/10 border border-emerald-500/20 rounded text-emerald-500 hover:bg-emerald-500 hover:text-indigo-600 transition-all shadow-sm flex items-center justify-center w-5.5 h-5.5"
                              title="Add to Watchlist"
                            >
                              <Plus className="w-2.5 h-2.5" />
                            </button>
                          )}
                        </div>

                        <div 
                          className="cursor-pointer group/sym min-w-[70px]"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectStock(r.symbol);
                          }}
                        >
                          <div className="font-black text-slate-100 group-hover/sym:text-indigo-400 transition-colors flex items-center gap-1 text-[11px] leading-tight">
                            {r.symbol}
                            <ArrowUpRight className="w-2.5 h-2.5 opacity-0 group-hover/sym:opacity-100 transition-opacity text-indigo-400" />
                          </div>
                          {r.name && <div className="text-[9px] text-slate-400 font-bold font-display uppercase tracking-wider truncate max-w-[120px] mt-0.5 leading-none">{r.name}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="flex flex-wrap gap-1">
                        {r.signals.map((s, j) => <SignalPill key={j} sig={s} />)}
                      </div>
                    </td>
                    <td className="py-2.5 px-3"><ScoreBar score={r.signal_score} /></td>
                    <td className="py-2.5 px-3 font-bold text-slate-100 tabular-nums">
                      {r.cmp ? `₹${r.cmp.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3">{fmtPct(r.change_pct)}</td>
                    <td className="py-2.5 px-3">
                      <TimeframeReturnsCell symbol={r.symbol} />
                    </td>
                    <td className="py-2.5 px-3 tabular-nums text-slate-300">
                      <span className={cn(
                        'font-bold',
                        (r.rsi ?? 50) >= 70 ? 'text-rose-400' :
                        (r.rsi ?? 50) <= 30 ? 'text-emerald-400' : 'text-slate-300'
                      )}>{r.rsi?.toFixed(1) ?? '—'}</span>
                    </td>
                    <td className="py-2.5 px-3 tabular-nums text-slate-300">
                      <span className={cn((r.volume_ratio ?? 0) >= 2 ? 'text-emerald-400 font-bold' : '')}>
                        {r.volume_ratio ? `${r.volume_ratio.toFixed(1)}×` : '—'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      {r.above_sma200
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        : <TrendingDown className="w-4 h-4 text-rose-500/50" />}
                    </td>
                    <td className="py-2.5 px-3">
                      {r.ai_insight
                        ? <span title="AI insight available"><Target className="w-4 h-4 text-indigo-400" /></span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                  {expanded === r.symbol && (
                    <ExpandedRow r={r} onSelectStock={onSelectStock} />
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="rounded-xl border border-slate-800/50 bg-slate-950/20 p-4">
        <p className="text-xs font-bold text-slate-400 mb-3">Signal Legend</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {(Object.entries(SIG_META) as [SignalType, typeof SIG_META[SignalType]][]).map(([type, m]) => (
            <div key={type} className={cn('rounded-lg border px-3 py-2', m.bg)}>
              <div className={cn('text-[10px] font-black font-display uppercase tracking-wider', m.color)}>{m.label}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                {type === 'RSI_DIVERGENCE'     && 'Price falls, RSI rises above SMA200'}
                {type === 'HIDDEN_DIVERGENCE'  && 'Price HL, RSI LL — trend continuation'}
                {type === 'RESISTANCE_BREAKOUT'&& 'Price > 20D high on ≥1.5× volume'}
                {type === 'MACD_CROSSOVER'     && 'MACD crossed above signal line today'}
                {type === 'BB_COMPRESSION'     && 'BB width at 60D low — coiling spring'}
                {type === 'GOLDEN_CROSS'       && 'SMA50 just crossed above SMA200'}
                {type === 'OVERSOLD_RECOVERY'  && 'RSI bounced from <35 to >40 above SMA200'}
                {type === 'EMA_BULL_STACK'        && 'EMA8>EMA21>EMA50>SMA200, price leading'}
                {type === 'WEEK_52_BREAKOUT'      && 'Close > 52-week high, price discovery'}
                {type === 'BULLISH_ENGULFING'     && 'Today engulfs yesterday bearish on volume'}
                {type === 'SUPERTREND_CROSS'      && 'SuperTrend(7,3) flipped bullish today'}
                {type === 'NR7_COMPRESSION'       && 'Narrowest range in 7 days, pre-breakout'}
                {type === 'VOLUME_ACCUMULATION'   && '3+/5 sessions >2× avg vol, price flat — smart money stealth buying'}
                {type === 'NEAR_52W_HIGH'         && 'Within 3% of 52W high — breakout imminent'}
                {type === 'CONSECUTIVE_STRENGTH'  && '4+ consecutive up-closes with rising volume'}
                {type === 'ATR_CONTRACTION'       && 'ATR(14) at 60-day low — volatility coiled, big move loading'}
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-slate-400 mt-3">⚠️ Educational only. Not SEBI-registered investment advice. Always do your own research.</p>
      </div>
    </div>
  );
}
