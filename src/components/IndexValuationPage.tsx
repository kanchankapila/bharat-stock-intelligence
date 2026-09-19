import React from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ReferenceArea } from 'recharts';
import { trpc } from '../lib/trpc';
import { V1PageFrame } from './v1/V1PageFrame';
import { QueryError } from './IntelligenceQueryError';
import { cn } from '../lib/utils';

// fetchIndexPeChart / fetchIndexPbChart (src/server/indexApiService.ts) normalise MoneyControl's
// fundamentals graph to [{ date, value, indexValue }] where `value` is the ratio and
// `indexValue` is the index level on that date. Returns null when the feed has nothing.
type Point = { date: string; value: number; indexValue: number };

const INDEX_CHOICES = [
  { id: '9', name: 'NIFTY 50' },
  { id: '23', name: 'NIFTY BANK' },
  { id: '7', name: 'NIFTY 500' },
  { id: '6', name: 'NIFTY NEXT 50' },
  { id: '19', name: 'NIFTY IT' },
  { id: '38', name: 'NIFTY ENERGY' },
  { id: '52', name: 'NIFTY AUTO' },
  { id: '41', name: 'NIFTY PHARMA' },
  { id: '39', name: 'NIFTY FMCG' },
  { id: '51', name: 'NIFTY METAL' },
];

const DURATIONS = [
  { id: '1Y', label: '1 year' },
  { id: '3Y', label: '3 years' },
  { id: '5Y', label: '5 years' },
];

// Linear-interpolated percentile from a sorted array; used for the bands AND for the
// "where does today sit" read, so the two can never disagree.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Share of observations at or below `value` -- the percentile rank of the latest print.
export function percentileRank(values: number[], value: number): number {
  if (values.length === 0) return NaN;
  const below = values.filter(v => v <= value).length;
  return (below / values.length) * 100;
}

function RatioPanel({ title, ratioLabel, points, loading }: { title: string; ratioLabel: string; points: Point[]; loading: boolean }) {
  const stats = React.useMemo(() => {
    const values = points.map(p => p.value).filter(v => Number.isFinite(v));
    const sorted = [...values].sort((a, b) => a - b);
    const latest = values.length > 0 ? values[values.length - 1] : NaN;
    const p25 = percentile(sorted, 0.25);
    const p75 = percentile(sorted, 0.75);
    // Tukey "far out" fence (3xIQR): MoneyControl's P/B feed has been observed carrying
    // gross junk on isolated sessions (e.g. 26.00 against a ~3.3 median). Nothing is
    // cleaned or dropped -- the outliers are surfaced as a data-quality flag instead, and
    // every statistic below stays computed from the returned series verbatim.
    const fenceHi = p75 + 3 * (p75 - p25);
    const fenceLo = p25 - 3 * (p75 - p25);
    const outliers = sorted.length >= 8
      ? points.filter(p => Number.isFinite(p.value) && (p.value > fenceHi || p.value < fenceLo))
      : [];
    return {
      p25,
      median: percentile(sorted, 0.5),
      p75,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      latest,
      rank: percentileRank(values, latest),
      count: values.length,
      outliers,
    };
  }, [points]);

  const hasData = points.length > 0 && Number.isFinite(stats.latest);

  if (loading) {
    return <div className="bsi-intel-panel"><h3 className="font-display mb-3">{title}</h3><div className="h-[240px] animate-pulse rounded-xl bg-slate-900/50" /></div>;
  }
  if (!hasData) {
    return (
      <div className="bsi-intel-panel">
        <h3 className="font-display mb-1">{title}</h3>
        <p className="bsi-intel-note">No stored series for this index and window. The upstream feed returned nothing — an absence, not a zero.</p>
      </div>
    );
  }

  const rich = stats.rank >= 70;
  const cheap = stats.rank <= 30;
  const gradId = `iv-grad-${ratioLabel.replace(/[^a-zA-Z]/g, '')}`;

  return (
    <div className="bsi-intel-panel">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display">{title}</h3>
          <p className="bsi-intel-note">{ratioLabel} versus its own history, with the interquartile band shaded.</p>
        </div>
        <div className="text-right">
          <span className="font-mono text-2xl text-white">{stats.latest.toFixed(2)}</span>
          <span className={cn('block text-[11px] font-semibold', rich ? 'text-[var(--bsi-down)]' : cheap ? 'text-[var(--bsi-up)]' : 'text-slate-400')}>
            {stats.rank.toFixed(0)}th percentile of {stats.count} sessions
          </span>
        </div>
      </div>

      <div className="h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
            <ReferenceArea y1={stats.p25} y2={stats.p75} fill="#6366f1" fillOpacity={0.06} />
            <XAxis dataKey="date" hide />
            <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#64748b' }} width={44} />
            <Tooltip
              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', fontSize: 11 }}
              labelStyle={{ color: '#94a3b8' }}
              formatter={(v: number) => [v.toFixed(2), ratioLabel]}
            />
            <ReferenceLine y={stats.median} stroke="#f59e0b" strokeDasharray="4 4" />
            <ReferenceLine y={stats.p75} stroke="#475569" strokeDasharray="2 4" />
            <ReferenceLine y={stats.p25} stroke="#475569" strokeDasharray="2 4" />
            <Area type="monotone" dataKey="value" stroke="#818cf8" strokeWidth={1.5} fill={`url(#${gradId})`} isAnimationActive animationDuration={1200} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
        <div><dt className="text-slate-500">25th pct</dt><dd className="font-mono text-slate-300">{stats.p25.toFixed(2)}</dd></div>
        <div><dt className="text-slate-500">Median</dt><dd className="font-mono text-amber-400">{stats.median.toFixed(2)}</dd></div>
        <div><dt className="text-slate-500">75th pct</dt><dd className="font-mono text-slate-300">{stats.p75.toFixed(2)}</dd></div>
        <div><dt className="text-slate-500">Range</dt><dd className="font-mono text-slate-300">{stats.min.toFixed(2)}–{stats.max.toFixed(2)}</dd></div>
      </dl>

      {stats.outliers.length > 0 && (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          Vendor data-quality flag: MoneyControl's {ratioLabel} feed returns {stats.outliers.length} of {stats.count} sessions
          far outside the series' 3×IQR fence (e.g. {stats.outliers[0].value.toFixed(2)} on {stats.outliers[0].date}).
          Every figure above includes them verbatim — treat the range line, and the percentile verdict below, with suspicion
          until the upstream series is clean.
        </p>
      )}

      <p className="bsi-intel-note mt-3">
        {rich
          ? `Above ${stats.rank.toFixed(0)}% of the last ${stats.count} sessions — the multiple is rich against its own recent history, which limits upside from re-rating alone.`
          : cheap
            ? `Below ${(100 - stats.rank).toFixed(0)}% of the last ${stats.count} sessions — the multiple is cheap against its own recent history, which leaves room for re-rating.`
            : `Mid-range: the multiple sits near its own ${stats.count}-session median, so neither a re-rating tailwind nor a de-rating headwind is implied.`}
      </p>
    </div>
  );
}

export default function IndexValuationPage() {
  const [indId, setIndId] = React.useState('9');
  const [duration, setDuration] = React.useState('1Y');

  const peQuery = trpc.getIndexPeChart.useQuery({ indId, duration }, { staleTime: 3_600_000 });
  const pbQuery = trpc.getIndexPbChart.useQuery({ indId, duration }, { staleTime: 3_600_000 });

  const pePoints = (peQuery.data ?? []) as Point[];
  const pbPoints = (pbQuery.data ?? []) as Point[];
  const indexName = INDEX_CHOICES.find(i => i.id === indId)?.name ?? indId;

  const latestIndexValue = React.useMemo(() => {
    const fromPe = pePoints.length > 0 ? pePoints[pePoints.length - 1].indexValue : NaN;
    if (Number.isFinite(fromPe)) return fromPe;
    const fromPb = pbPoints.length > 0 ? pbPoints[pbPoints.length - 1].indexValue : NaN;
    return fromPb;
  }, [pePoints, pbPoints]);

  return (
    <V1PageFrame title="Index Valuation" kicker="P/E · P/B · PERCENTILE CONTEXT">
      <div className="space-y-6">
        <div className="bsi-intel-hero">
          <div>
            <span className="bsi-intel-eyebrow">08 / VALUATION CONTEXT</span>
            <h2 className="font-display text-2xl sm:text-3xl mt-2">Is the index expensive?</h2>
            <p className="bsi-intel-note mt-2">
              A single P/E number means nothing without its own history. These panels place today's multiple against every session in the selected window, so "cheap" and "rich" are measured, not asserted.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="bsi-intel-note">
              Index
              <select className="bsi-control block mt-2" value={indId} onChange={e => setIndId(e.target.value)}>
                {INDEX_CHOICES.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="bsi-intel-note">
              Window
              <select className="bsi-control block mt-2" value={duration} onChange={e => setDuration(e.target.value)}>
                {DURATIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {(peQuery.isError || pbQuery.isError) && (
          <QueryError retry={() => { void peQuery.refetch(); void pbQuery.refetch(); }} />
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="bsi-kpi p-4">
            <span className="bsi-kpi-label">Index</span>
            <span className="bsi-kpi-value block">{indexName}</span>
            <span className="bsi-kpi-sub">{duration} window</span>
          </div>
          <div className="bsi-kpi p-4">
            <span className="bsi-kpi-label">Index level (last point)</span>
            <span className="bsi-kpi-value block font-mono">
              {Number.isFinite(latestIndexValue) ? latestIndexValue.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
            </span>
            <span className="bsi-kpi-sub">as reported alongside the ratio series</span>
          </div>
          <div className="bsi-kpi p-4">
            <span className="bsi-kpi-label">Observations</span>
            <span className="bsi-kpi-value block font-mono">{pePoints.length || '—'}</span>
            <span className="bsi-kpi-sub">P/E sessions · {pbPoints.length || '—'} P/B sessions</span>
          </div>
        </div>

        <div className="space-y-4">
          <RatioPanel title={`${indexName} price-to-earnings`} ratioLabel="P/E" points={pePoints} loading={peQuery.isLoading} />
          <RatioPanel title={`${indexName} price-to-book`} ratioLabel="P/B" points={pbPoints} loading={pbQuery.isLoading} />
        </div>

        <p className="bsi-intel-note">
          Percentiles are computed from the returned series itself, so a shorter window makes them more local by construction. Index-level valuation says nothing about any individual stock — a rich index routinely contains cheap constituents. NOT FINANCIAL ADVICE.
        </p>
      </div>
    </V1PageFrame>
  );
}
