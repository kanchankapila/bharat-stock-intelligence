import React, { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  ShieldAlert, Activity, BarChart2, TrendingUp, TrendingDown, RefreshCw,
  Search, DollarSign, PieChart, Monitor, AlertTriangle, Clock,
} from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { formatINR, formatNumber, formatPct, DASH, convictionBadge } from '../lib';
import { KpiCard } from '../components/KpiCard';
import { AsOfBanner } from '../components/AsOfBanner';
import { DataTable, DataTableColumn } from '../components/DataTable';
import { SignalBadge, ConvictionBadge } from '../components/SignalBadge';
import { PriceChart } from '../components/PriceChart';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';

export const StockDetailPage: React.FC = () => {
  const { symbol } = useParams<{ symbol: string }>();
  const sym = (symbol ?? '').toUpperCase();

  const { data: canonical, isLoading: canonicalLoading, isError: canonicalError } = trpc.getUnifiedScoreForSymbol.useQuery(
    { symbol: sym }, { enabled: !!sym, staleTime: 5 * 60 * 1000 },
  );

  const { data: scoreDetail, isLoading: scoreLoading, isError: scoreError } = trpc.getStockScoreDetail.useQuery(
    { symbol: sym, timeframe: 'long_term' },
    { enabled: !!sym, staleTime: 5 * 60 * 1000 },
  );
  const { data: techRow, isLoading: techLoading, isError: techError } = trpc.getTechnicalPredictions.useQuery(
    { symbol: sym },
    { enabled: !!sym, staleTime: 5 * 60 * 1000 },
  );
  // getTechnicalDetails returns the MoneyControl indicator blob with no OHLCV array — the
  // chart reads getOHLCData ({success, data:[{time(unix-s), open, high, low, close}]}) instead.
  const { data: ohlcRaw, isError: ohlcError } = trpc.getOHLCData.useQuery(
    { symbol: sym, dur: '6M' },
    { enabled: !!sym, staleTime: 5 * 60 * 1000 },
  );
  const { data: signalHistory, isLoading: signalsLoading, isError: signalsError } = trpc.getSignalHistory.useQuery(
    { symbol: sym },
    { enabled: !!sym, staleTime: 5 * 60 * 1000 },
  );
  const { data: fno, isLoading: fnoLoading, isError: fnoError } = trpc.getFnoOptionChainSummary.useQuery(
    { symbol: sym },
    { enabled: !!sym, staleTime: 2 * 60 * 1000 },
  );

  const score = canonical ? { ...canonical, score: canonical.unified_score, last_updated: canonical.generated_at } : null;
  const factors = (scoreDetail as any)?.factors ?? null;
  // getTechnicalPredictions = latest technical_signals row + mlRankPct (rsi, adx, sma50, sma200…)
  const tech = (techRow as any) ?? null;
  const candles = (((ohlcRaw as any)?.data ?? []) as any[])
    .filter((d) => d?.time != null && d.open != null && d.high != null && d.low != null && d.close != null)
    .map((d) => ({
      time: new Date(Number(d.time) * 1000).toISOString().slice(0, 10),
      open: Number(d.open), high: Number(d.high), low: Number(d.low), close: Number(d.close),
    }));
  if (canonicalError || scoreError || techError || ohlcError || signalsError || fnoError) return <QueryError />;
  return (
    <div className="v7-page">
      <div className="v7-page-header">
        <div className="v7-page-title-wrap">
          <div className="v7-page-icon"><ShieldAlert size={20} strokeWidth={2} /></div>
          <div>
            <h1 className="v7-page-title">{sym || 'Stock Analysis'}</h1>
            <p className="v7-page-kicker">Canonical session: {canonical?.computed_at ?? DASH} · Source panels retain their own observation times</p>
          </div>
        </div>
        <div className="v7-page-actions">
          <AsOfBanner asOf={score?.last_updated ?? null} label="Canonical score as of" stale={canonicalLoading} />
          <button className="v7-btn v7-btn-ghost" onClick={() => window.location.reload()}>
            <RefreshCw className="w-4 h-4" size={16} strokeWidth={1.6} /> Refresh
          </button>
        </div>
      </div>

      {!sym && (
        <EmptyState icon={<Search className="w-10 h-10 text-slate-600" />} title="No stock selected" variant="info" />
      )}

      {sym && (
        <>
          {/* ─── Score KPI strip ─── */}
          <div className="v7-kpi-grid">
            <KpiCard title="Unified Score" value={score?.score} change={null} changePct={null} unit="number" decimals={1} asOf={score?.last_updated ?? null} stale={!score} />
            <KpiCard title="Canonical engine coverage" value={score?.engine_coverage_count} change={null} changePct={null} unit="number" decimals={0} asOf={null} stale={!score} />
          </div>

          {/* ─── Classification + conviction ─── */}
          <div className="v7-grid-cols-2">
            <div className="v7-card">
              <div className="v7-card-head">
                <span className="v7-card-title">Classification</span>
                <span className="text-[10px] font-bold text-slate-400 uppercase">Latest batch</span>
              </div>
              <div className="pt-4">
                <SignalBadge type={score?.classification ?? null} className="mb-2" />
                <p className="text-[11px] text-slate-500">{score?.classification ? `Classified as ${score.classification} in the latest computed batch.` : 'No classification available for this stock.'}</p>
              </div>
            </div>
            <div className="v7-card">
              <div className="v7-card-head">
                <span className="v7-card-title">Conviction</span>
                <span className="text-[10px] font-bold text-slate-400 uppercase">Position sizing input</span>
              </div>
              <div className="pt-4">
                <ConvictionBadge level={score?.conviction_level ?? null} className="mb-2" />
                <p className="text-[11px] text-slate-500">Direction-agnostic strength, not a probability of profit. No position sizing guidance is supplied by this reader.</p>
              </div>
            </div>
          </div>

          {/* ─── Factor breakdown ─── */}
          <div className="v7-card">
            <div className="v7-card-head">
              <span className="v7-card-title">Legacy component breakdown</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase">Not canonical ranking contributions</span>
            </div>
            <div className="v7-grid-cols-5">
              {[
                { label: 'Technical', value: factors?.technical },
                { label: 'Fundamental', value: factors?.fundamental },
                { label: 'Momentum', value: factors?.momentum },
                { label: 'Valuation', value: factors?.valuation },
                { label: 'Delivery', value: factors?.delivery },
              ].map((f) => (
                <div key={f.label} className="px-3 py-3 rounded-xl border border-slate-800/40 bg-slate-900/30">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">{f.label}</div>
                  <div className="font-data font-bold text-slate-200">{f.value == null ? DASH : Number(f.value).toFixed(1)}</div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-3">Legacy stock_factor_breakdown diagnostics are separate from the canonical score above; they are not its engine weights or contributions. Missing diagnostics are unknown, not evidence of zero exposure.</p>
          </div>

          {/* ─── Technicals ─── */}
          <div className="v7-grid-cols-2">
            <div className="v7-card">
              <div className="v7-card-head">
                <span className="v7-card-title">Price Chart</span>
                <span className="text-[10px] font-bold text-slate-400 uppercase">Daily candles · latest batch</span>
              </div>
              <div className="h-[320px]">
                {candles.length ? (
                  <PriceChart data={candles} symbol={sym} />
                ) : (
                  <div className="h-full v7-empty" style={{ padding: '20px 0' }}>
                    <div className="v7-empty-icon"><Monitor className="w-10 h-10 text-slate-600" /></div>
                    <h4 className="v7-empty-title">No price history</h4>
                    <p className="v7-empty-text">OHLCV data not available for this symbol right now (MoneyControl + stock_ohlcv both empty).</p>
                  </div>
                )}
              </div>
            </div>
            <div className="v7-card">
              <div className="v7-card-head">
                <span className="v7-card-title">Technical Indicators</span>
                <span className="text-[10px] font-bold text-slate-400 uppercase">Latest close values</span>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">RSI</span>
                  <span className="font-data text-slate-300">{tech?.rsi == null ? DASH : Number(tech.rsi).toFixed(1)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">ADX</span>
                  <span className="font-data text-slate-300">{tech?.adx == null ? DASH : Number(tech.adx).toFixed(1)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">SMA 50</span>
                  <span className="font-data text-slate-300">{tech?.sma50 == null ? DASH : formatNumber(tech.sma50, 2)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">SMA 200</span>
                  <span className="font-data text-slate-300">{tech?.sma200 == null ? DASH : formatNumber(tech.sma200, 2)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">ML rank</span>
                  <span className="font-data text-slate-300">{tech?.mlRankPct == null ? DASH : `top ${Math.max(1, Math.round(100 - Number(tech.mlRankPct)))}%`}</span>
                </div>
              </div>
              <p className="text-[11px] text-slate-500 mt-3">From the latest complete technical_signals day. ML rank is a percentile among today's stocks — not a probability of winning.</p>
            </div>
          </div>

          {/* ─── Signals ─── */}
          <div className="v7-card">
            <div className="v7-card-head">
              <span className="v7-card-title">Signal History</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase">unified_signals for this stock</span>
            </div>
            <div className="v7-table-wrap">
              <table className="v7-table">
                <thead>
                  <tr>
                    <th className="w-48">Date</th>
                    <th>Source</th>
                    <th className="text-center w-40">Type</th>
                    <th className="text-right w-48">Entry</th>
                    <th className="text-right w-48">Target</th>
                    <th className="text-right w-48">Stop</th>
                    <th className="text-right w-48">Confidence</th>
                    <th className="text-right w-48">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(signalHistory as any[])?.length ? signalHistory.map((s: any) => (
                    <tr key={s.id}>
                      <td className="font-data text-slate-300">{s.createdAt ? new Date(s.createdAt).toLocaleDateString('en-IN') : '—'}</td>
                      <td className="text-xs text-slate-500">{s.source ?? '—'}</td>
                      <td className="text-center"><SignalBadge type={s.type ?? null} className="mx-auto" /></td>
                      <td className="text-right font-data text-slate-300">{s.entry == null ? DASH : Number(s.entry).toFixed(2)}</td>
                      <td className="text-right font-data text-slate-300">{s.target == null ? DASH : Number(s.target).toFixed(2)}</td>
                      <td className="text-right font-data text-slate-300">{s.stopLoss == null ? DASH : Number(s.stopLoss).toFixed(2)}</td>
                      <td className="text-right font-data text-slate-300">{s.confidence == null ? DASH : `${Number(s.confidence).toFixed(0)}%`}</td>
                      <td className="text-right text-xs font-medium text-slate-400">{s.status ?? '—'}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={8} className="text-center py-6 text-slate-500">No signals on record for this stock.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ─── F&O ─── */}
          <div className="v7-card">
            <div className="v7-card-head">
              <span className="v7-card-title">F&O Option Chain</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase">Nearest expiry · PCR / OI</span>
            </div>
            <div className="v7-grid-cols-3">
              <div>
                <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">PCR</div>
                <div className="font-data font-bold">{fno?.pcr == null ? DASH : Number(fno.pcr).toFixed(2)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Call OI</div>
                <div className="font-data font-bold">{fno?.callTotalOI == null ? DASH : formatNumber(fno.callTotalOI, 0)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Put OI</div>
                <div className="font-data font-bold">{fno?.putTotalOI == null ? DASH : formatNumber(fno.putTotalOI, 0)}</div>
              </div>
            </div>
            <p className="text-[11px] text-slate-500 mt-3">Option-chain OI shown in contracts for the nearest expiry; figures may be delayed by one refresh cycle.</p>
          </div>
        </>
      )}
    </div>
  );
};

export default StockDetailPage;
