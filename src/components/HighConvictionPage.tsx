import React from 'react';
import { RefreshCw, Crosshair, Target, AlertTriangle } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ComboStock {
  symbol: string; name: string; sector: string;
  signalScore: number; entryPrice: number; signalTypes: string[];
  piotroski: number; sharpeRatio: number; rankComposite: number;
  bullishScreenerCount: number; return12m: number;
  convictionLevel: string | null; avgTrackRecord: number | null;
  stopLoss: number; target: number; rrRatio: number;
}

interface ComboResult {
  regime: string; reason: string; stocks: ComboStock[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 1) {
  return isNaN(n) ? '—' : n.toFixed(dec);
}

function fmtPrice(n: number) {
  return n > 0
    ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    : '—';
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function RegimeBadge({ regime }: { regime: string }) {
  const style =
    regime === 'BULL'     ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
    regime === 'SIDEWAYS' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                            'bg-rose-500/20 text-rose-400 border-rose-500/30';
  return (
    <span className={cn('text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border', style)}>
      {regime}
    </span>
  );
}

function ConvictionBadge({ level }: { level: string | null }) {
  if (!level) return null;
  const style =
    level === 'A_HIGH'
      ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
      : 'bg-blue-500/20 text-blue-300 border-blue-500/30';
  return (
    <span className={cn('text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border', style)}>
      {level.replace('_', ' ')}
    </span>
  );
}

function SignalPill({ type }: { type: string }) {
  const style =
    type === 'RSI_DIVERGENCE'  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
    type === 'EMA_BULL_STACK'  ? 'bg-sky-500/20 text-sky-400 border-sky-500/30' :
    type === 'NR7_COMPRESSION' ? 'bg-violet-500/20 text-violet-400 border-violet-500/30' :
                                  'bg-slate-700/60 text-slate-400 border-slate-600';
  return (
    <span className={cn('text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border', style)}>
      {type.replace(/_/g, ' ')}
    </span>
  );
}

function MetricCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="text-center">
      <div className={cn('text-sm font-black', color ?? 'text-white')}>{value}</div>
      <div className="text-[9px] text-slate-600 uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  );
}

function HighConvictionCard({
  stock,
  onSelectStock,
}: {
  stock: ComboStock;
  onSelectStock: (s: string) => void;
}) {
  const rrColor =
    stock.rrRatio >= 2 ? 'text-emerald-400' :
    stock.rrRatio >= 1 ? 'text-amber-400'   : 'text-rose-400';

  const retColor = stock.return12m >= 0 ? 'text-emerald-400' : 'text-rose-400';

  const oneLineReason = [
    'RSI div + bull stack',
    `Piotroski ${stock.piotroski}/9`,
    `${stock.bullishScreenerCount} screeners`,
    `Sharpe ${fmt(stock.sharpeRatio)}`,
  ].join(' · ');

  return (
    <div
      className="glass border border-slate-800/50 rounded-2xl p-5 cursor-pointer hover:border-slate-600/60 transition-all flex flex-col gap-4"
      onClick={() => onSelectStock(stock.symbol)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xl font-black text-white tracking-tighter">{stock.symbol}</span>
            <span className="text-[10px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded-full shrink-0">
              {stock.sector}
            </span>
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 truncate">{stock.name}</div>
        </div>
        <ConvictionBadge level={stock.convictionLevel} />
      </div>

      {/* Signal pills + score */}
      <div className="flex flex-wrap items-center gap-1.5">
        {stock.signalTypes.map(t => <SignalPill key={t} type={t} />)}
        <span className="ml-auto text-[10px] text-slate-500 font-bold shrink-0">
          ★ {stock.signalScore}/10
        </span>
      </div>

      {/* Trading levels */}
      <div className="grid grid-cols-4 gap-2 bg-slate-900/40 rounded-xl p-3">
        <div className="text-center">
          <div className="text-xs font-black text-white">{fmtPrice(stock.entryPrice)}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Entry</div>
        </div>
        <div className="text-center">
          <div className="text-xs font-black text-rose-400">{fmtPrice(stock.stopLoss)}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Stop</div>
        </div>
        <div className="text-center">
          <div className="text-xs font-black text-emerald-400">{fmtPrice(stock.target)}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">Target</div>
        </div>
        <div className="text-center">
          <div className={cn('text-xs font-black', rrColor)}>{fmt(stock.rrRatio)}x</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-0.5">R:R</div>
        </div>
      </div>

      {/* Score metrics */}
      <div className="grid grid-cols-5 gap-1">
        <MetricCell
          label="Piotroski"
          value={`${stock.piotroski}/9`}
          color={stock.piotroski >= 7 ? 'text-emerald-400' : 'text-amber-400'}
        />
        <MetricCell
          label="Sharpe"
          value={fmt(stock.sharpeRatio)}
          color={stock.sharpeRatio >= 1.5 ? 'text-emerald-400' : 'text-amber-400'}
        />
        <MetricCell label="Rank" value={`${fmt(stock.rankComposite)}%`} color="text-sky-400" />
        <MetricCell label="Screeners" value={String(stock.bullishScreenerCount)} color="text-violet-400" />
        <MetricCell
          label="12M Ret"
          value={`${fmt(stock.return12m)}%`}
          color={retColor}
        />
      </div>

      {/* One-line reason footer */}
      <div className="text-[10px] text-slate-500 border-t border-slate-800/50 pt-3 leading-relaxed">
        {oneLineReason}
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function HighConvictionPage({
  onSelectStock,
}: {
  onSelectStock: (s: string) => void;
}) {
  const { data, isLoading, refetch, isRefetching } = trpc.getBestComboSignals.useQuery(
    { limit: 20 },
    { refetchInterval: 5 * 60_000 },
  );

  const result = data as ComboResult | undefined;
  const isBear  = result?.regime === 'BEAR';
  const isEmpty = !isLoading && result && result.stocks.length === 0 && !isBear;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Crosshair className="w-5 h-5 text-amber-400" />
          <div>
            <h1 className="text-xl font-black text-white italic uppercase tracking-tighter">
              Best Picks
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              4-gate filter · RSI Divergence + EMA Bull Stack · Piotroski ≥7 · Proven sectors
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {result && <RegimeBadge regime={result.regime} />}
          <span className="text-[10px] text-slate-500">
            {result?.stocks.length ?? 0} setups
          </span>
          <button
            onClick={() => refetch()}
            disabled={isRefetching || isLoading}
            className="p-2 glass-strong border border-slate-800/50 rounded-xl text-slate-400 hover:text-white transition-all disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', (isRefetching || isLoading) && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="glass border border-slate-800/50 rounded-2xl p-5 h-64 animate-pulse" />
          ))}
        </div>
      )}

      {/* Bear regime */}
      {!isLoading && isBear && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <AlertTriangle className="w-10 h-10 text-rose-400" />
          <h2 className="text-lg font-black text-white uppercase tracking-tighter">
            BEAR Regime — Gates Closed
          </h2>
          <p className="text-sm text-slate-500 text-center max-w-sm">
            No new positions. All 4 gates require BULL or SIDEWAYS market regime.
            Check back when conditions improve.
          </p>
        </div>
      )}

      {/* Empty (BULL/SIDEWAYS, 0 results) */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Target className="w-10 h-10 text-slate-600" />
          <h2 className="text-lg font-black text-white uppercase tracking-tighter">
            No Setups Right Now
          </h2>
          <p className="text-sm text-slate-500 text-center max-w-sm">
            No stocks pass all 4 gates simultaneously. Check back after market close
            once the signal scanner and quant scoring have run.
          </p>
        </div>
      )}

      {/* Card grid */}
      {!isLoading && !isBear && result && result.stocks.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {result.stocks.map(stock => (
            <HighConvictionCard
              key={stock.symbol}
              stock={stock}
              onSelectStock={onSelectStock}
            />
          ))}
        </div>
      )}
    </div>
  );
}
