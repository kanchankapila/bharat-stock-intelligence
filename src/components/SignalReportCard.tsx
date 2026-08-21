import React from 'react';
import { trpc } from '../lib/trpc';
import { Card } from './Card';
import { LiveHitRates } from './LiveHitRates';
import { Loader2, ChartLine, TrendingUp, ArrowUpRight, ArrowDownRight, Activity, BarChart2, Target } from 'lucide-react';

const formatPct = (value?: number | null) => {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(2)}%`;
};

const formatNum = (value?: number | null) => {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

const formatDate = (value?: string | null) => {
  if (!value) return '—';
  return new Date(value).toLocaleDateString();
};

export function SignalReportCard() {
  const { data, isLoading, error } = trpc.getSignalReportCard.useQuery();

  if (isLoading) {
    return (
      <div className="p-6">
        <Card title="Signal Report Card">
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 className="w-8 h-8 animate-spin mr-3" />
            Loading signal report...
          </div>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <Card title="Signal Report Card">
          <div className="text-rose-300">Unable to load the signal report card. {error?.message ?? ''}</div>
        </Card>
      </div>
    );
  }

  const {
    sourceSummary,
    outcomeSummary,
    activeSignalGrowth,
    recommendationSummary,
    recommendationSourceBreakdown,
    recentBacktestResults,
    strategyPerformance,
  } = data;

  const tradeCandidates = [...activeSignalGrowth]
    .sort((a, b) => (b.growth_pct ?? 0) - (a.growth_pct ?? 0))
    .slice(0, 12);

  const alphaCandidates = [...activeSignalGrowth]
    .filter((row) => row.growth_pct != null)
    .sort((a, b) => (b.growth_pct ?? 0) - (a.growth_pct ?? 0))
    .slice(0, 6);

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="v1-title-page">Signal Intelligence Engine</h1>
        <p className="mt-2 text-sm text-slate-400">Overview of current engine performance, confidence, and source signal health.</p>
      </div>

      <LiveHitRates />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Signal Coverage" icon={ChartLine}>
          <div className="space-y-3 text-sm text-slate-300">
            <div className="flex justify-between">
              <span>Total recommendations</span>
              <strong className="text-white">{formatNum(recommendationSummary.total_recommendations)}</strong>
            </div>
            <div className="flex justify-between">
              <span>Win rate</span>
              <strong className="text-white">{formatPct(recommendationSummary.win_count && recommendationSummary.total_recommendations ? (recommendationSummary.win_count / recommendationSummary.total_recommendations) * 100 : 0)}</strong>
            </div>
            <div className="flex justify-between">
              <span>Avg return</span>
              <strong className="text-white">{formatPct(recommendationSummary.avg_actual_return_pct)}</strong>
            </div>
            <div className="flex justify-between">
              <span>Worst return</span>
              <strong className="text-white">{formatPct(recommendationSummary.worst_actual_return_pct)}</strong>
            </div>
          </div>
        </Card>

        <Card title="Source Confidence" icon={Activity}>
          <div className="space-y-3 text-sm text-slate-300">
            <div className="flex justify-between">
              <span>Avg signal confidence</span>
              <strong className="text-white">{formatPct(sourceSummary.reduce((sum, row) => sum + (row.avg_confidence_score ?? 0), 0) / Math.max(sourceSummary.length, 1))}</strong>
            </div>
            <div className="flex justify-between">
              <span>Avg technical score</span>
              <strong className="text-white">{formatNum(sourceSummary.reduce((sum, row) => sum + (row.avg_technical_score ?? 0), 0) / Math.max(sourceSummary.length, 1))}</strong>
            </div>
            <div className="flex justify-between">
              <span>Avg quant score</span>
              <strong className="text-white">{formatNum(sourceSummary.reduce((sum, row) => sum + (row.avg_quant_score ?? 0), 0) / Math.max(sourceSummary.length, 1))}</strong>
            </div>
            <div className="flex justify-between">
              <span>Avg signal age</span>
              <strong className="text-white">{formatNum(sourceSummary.reduce((sum, row) => sum + (row.avg_age_days ?? 0), 0) / Math.max(sourceSummary.length, 1))}d</strong>
            </div>
          </div>
        </Card>

        <Card title="Recent Backtests" icon={BarChart2}>
          <div className="space-y-3 text-sm text-slate-300">
            <div className="flex justify-between">
              <span>Runs</span>
              <strong className="text-white">{recentBacktestResults.length}</strong>
            </div>
            <div className="flex justify-between">
              <span>Latest CAGR</span>
              <strong className="text-white">{formatPct(recentBacktestResults[0]?.cagr_pct)}</strong>
            </div>
            <div className="flex justify-between">
              <span>Best win rate</span>
              <strong className="text-white">{formatPct(Math.max(...recentBacktestResults.map(r => r.win_rate ?? 0)))}</strong>
            </div>
          </div>
        </Card>
      </div>

      <div>
        <h2 className="v1-title-section">Trade Candidates</h2>
        <p className="mt-2 text-sm text-slate-400">Stocks with live signals and growth since the signal was generated.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-1">
        <Card title="Trade Candidates" icon={ArrowUpRight}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Signal Source</th>
                  <th className="px-3 py-2">Generated</th>
                  <th className="px-3 py-2 text-right">Entry</th>
                  <th className="px-3 py-2 text-right">Growth</th>
                </tr>
              </thead>
              <tbody>
                {tradeCandidates.map((row, index) => (
                  <tr key={`${row.id}-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.symbol}</td>
                    <td className="px-3 py-2 text-slate-400">{row.signal_source}</td>
                    <td className="px-3 py-2 text-slate-300">{formatDate(row.signal_date)}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{formatNum(row.entry_price)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${row.growth_pct != null && row.growth_pct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {formatPct(row.growth_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div>
        <h2 className="v1-title-section">Strategy Intelligence</h2>
        <p className="mt-2 text-sm text-slate-400">Performance metrics from strategy evaluation and backtest analytics.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Top Strategy Performance" icon={Target}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Strategy</th>
                  <th className="px-3 py-2">Win Rate</th>
                  <th className="px-3 py-2">Avg Return</th>
                </tr>
              </thead>
              <tbody>
                {strategyPerformance.slice(0, 10).map((row, index) => (
                  <tr key={`${row.strategy_name}-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.strategy_name}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.win_rate)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.avg_return_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Strategy Builder Hub" icon={Activity}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Signals</th>
                  <th className="px-3 py-2">Active</th>
                  <th className="px-3 py-2">Avg Confidence</th>
                </tr>
              </thead>
              <tbody>
                {sourceSummary.map((row, index) => (
                  <tr key={`${row.signal_source}-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.signal_source}</td>
                    <td className="px-3 py-2 text-slate-300">{formatNum(row.total_signals)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatNum(row.active_signals)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.avg_confidence_score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div>
        <h2 className="v1-title-section">Alpha</h2>
        <p className="mt-2 text-sm text-slate-400">The strongest signal performers by growth since generation.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-1">
        <Card title="Alpha Candidates" icon={TrendingUp}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Growth Since Signal</th>
                  <th className="px-3 py-2 text-right">Entry</th>
                  <th className="px-3 py-2">Generated</th>
                </tr>
              </thead>
              <tbody>
                {alphaCandidates.map((row, index) => (
                  <tr key={`${row.id}-alpha-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.symbol}</td>
                    <td className="px-3 py-2 text-slate-400">{row.signal_source}</td>
                    <td className={`px-3 py-2 text-slate-300 font-semibold ${row.growth_pct != null && row.growth_pct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {formatPct(row.growth_pct)}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300">{formatNum(row.entry_price)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatDate(row.signal_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Top Strategy Performance" icon={Target}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Strategy</th>
                  <th className="px-3 py-2">Win Rate</th>
                  <th className="px-3 py-2">Avg Return</th>
                </tr>
              </thead>
              <tbody>
                {strategyPerformance.slice(0, 10).map((row, index) => (
                  <tr key={`${row.strategy_name}-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.strategy_name}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.win_rate)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.avg_return_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Signal Source Breakdown" icon={Activity}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Signal Source</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">Active</th>
                  <th className="px-3 py-2">Avg Confidence</th>
                  <th className="px-3 py-2">Avg Tech</th>
                  <th className="px-3 py-2">Avg Quant</th>
                </tr>
              </thead>
              <tbody>
                {sourceSummary.map((row, index) => (
                  <tr key={`${row.signal_source}-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.signal_source}</td>
                    <td className="px-3 py-2 text-slate-300">{formatNum(row.total_signals)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatNum(row.active_signals)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.avg_confidence_score)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatNum(row.avg_technical_score)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatNum(row.avg_quant_score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Recommendation Breakdown" icon={Activity}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Count</th>
                  <th className="px-3 py-2">Avg Return</th>
                  <th className="px-3 py-2">Avg Confidence</th>
                </tr>
              </thead>
              <tbody>
                {recommendationSourceBreakdown.map((row, index) => (
                  <tr key={`${row.source}-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.source}</td>
                    <td className="px-3 py-2 text-slate-300">{formatNum(row.total_recs)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.avg_actual_return_pct)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.avg_confidence_score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Recent Backtest Runs" icon={ArrowDownRight}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Run</th>
                  <th className="px-3 py-2">Win Rate</th>
                  <th className="px-3 py-2">Return</th>
                </tr>
              </thead>
              <tbody>
                {recentBacktestResults.slice(0, 10).map((row, index) => (
                  <tr key={`${row.run_name}-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.run_name}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.win_rate)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.total_return_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-1">
        <Card title="Outcome Summary by Source" icon={Activity}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left border-separate border-spacing-y-2">
              <thead>
                <tr className="text-slate-400 text-xs uppercase tracking-[0.2em]">
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Horizon</th>
                  <th className="px-3 py-2">Win %</th>
                  <th className="px-3 py-2">Avg Return</th>
                </tr>
              </thead>
              <tbody>
                {outcomeSummary.map((row, index) => (
                  <tr key={`${row.signal_source}-${row.horizon_days}-${index}`} className="bg-slate-950/60 hover:bg-slate-900 transition-colors even:bg-slate-900/50">
                    <td className="px-3 py-2 font-semibold text-white">{row.signal_source}</td>
                    <td className="px-3 py-2 text-slate-300">{row.horizon_days}d</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.win_count && row.total_outcomes ? (row.win_count / row.total_outcomes) * 100 : 0)}</td>
                    <td className="px-3 py-2 text-slate-300">{formatPct(row.avg_return_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
