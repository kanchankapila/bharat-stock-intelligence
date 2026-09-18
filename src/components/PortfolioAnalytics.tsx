import React from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';
import { BarChart2, PieChart, TrendingUp, RefreshCw } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { correlationCellClass, factorEntries, percent } from '../lib/intelligenceDisplay';
import { TabBar, type TabItem } from './TabBar';
import { MetricTile } from './MetricTile';
import { QueryError } from './IntelligenceQueryError';

const TABS: TabItem[] = [
  { id: 'risk', label: 'Risk & Correlation', icon: BarChart2 },
  { id: 'radar', label: 'Factor Radar', icon: PieChart },
  { id: 'valuation', label: 'Valuation Snapshot', icon: TrendingUp },
];

type AnalysisResult = {
  sharpe_ratio?: number | string;
  beta?: number | string;
  annualized_return?: number;
  var_95?: number;
  correlation_matrix?: Record<string, Record<string, number>>;
  error?: string;
};

function num(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
}

function CorrelationMatrix({ matrix }: { matrix?: Record<string, Record<string, number>> }) {
  const syms = Object.keys(matrix ?? {});
  if (syms.length === 0) return <p className="bsi-intel-note">No correlation matrix in the analysis response.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs text-left border-collapse">
        <thead>
          <tr>
            <th className="px-2 py-2 bsi-intel-note">Symbol</th>
            {syms.map((s) => <th key={s} className="px-2 py-2 text-center bsi-intel-note">{s}</th>)}
          </tr>
        </thead>
        <tbody>
          {syms.map((row) => (
            <tr key={row}>
              <td className="px-2 py-2 font-semibold text-slate-200">{row}</td>
              {syms.map((col) => {
                const v = matrix?.[row]?.[col];
                return (
                  <td key={col} className={`px-2 py-2 text-center font-mono ${correlationCellClass(v, row === col)}`}>
                    {row === col ? '1.00' : num(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="bsi-intel-note mt-2">Green &lt; 0.3 (diversifying) · amber 0.3–0.7 · red &gt; 0.7 (concentrated). Computed by the alpha-quant service for the symbols above; equal weights.</p>
    </div>
  );
}

export function FactorRadar({ symbol }: { symbol: string }) {
  const query = trpc.getStockScoreDetail.useQuery(
    { symbol, timeframe: 'long_term' as const },
    { enabled: !!symbol, staleTime: 300_000, retry: false },
  );
  const entries = factorEntries(query.data?.factors);
  const score = query.data?.score as { score?: number; classification?: string } | undefined;
  return (
    <div className="space-y-4">
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      {!symbol ? (
        <p className="bsi-intel-note">Add symbols in the sandbox above to inspect their factor components.</p>
      ) : query.isLoading ? (
        <p role="status" className="bsi-intel-note">Loading component factors for {symbol}…</p>
      ) : !query.data ? (
        <p className="bsi-intel-note">No screener score row stored for {symbol} (long_term). Run scoring or pick another symbol.</p>
      ) : entries.length < 3 ? (
        <p className="bsi-intel-note">No numeric factor breakdown stored for {symbol}; a radar needs at least three components. Nothing is synthesized to fill it.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricTile label="Screener composite (non-canonical)" value={typeof score?.score === 'number' ? score.score.toFixed(1) : '—'} />
            <MetricTile label="Classification" value={score?.classification ?? '—'} />
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={entries} outerRadius="72%">
                <PolarGrid stroke="rgba(148,163,184,0.25)" />
                <PolarAngleAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <PolarRadiusAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} />
                <Radar dataKey="value" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.28} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <p className="bsi-intel-note">Component factor scores (0–100) from scoring_engine's stock_factor_breakdown — inputs the canonical unified score ingests, not a ranking. Missing factors are omitted, never zero-filled.</p>
        </>
      )}
    </div>
  );
}

type DvmCell = { score?: number; color?: string };

export function DvmTile({ symbol }: { symbol: string }) {
  const query = trpc.getTrendlyneDVM.useQuery({ symbol }, { staleTime: 3_600_000, retry: false });
  const d = query.data as { durability?: DvmCell; valuation?: DvmCell; momentum?: DvmCell } | null | undefined;
  const rows: [string, DvmCell | undefined][] = [
    ['Valuation', d?.valuation],
    ['Durability', d?.durability],
    ['Momentum', d?.momentum],
  ];
  return (
    <div className="bsi-kpi">
      <span className="bsi-kpi-label">{symbol}</span>
      {query.isLoading ? (
        <p role="status" className="bsi-intel-note">Loading…</p>
      ) : query.isError ? (
        <p className="bsi-intel-note">Unavailable right now.</p>
      ) : !d ? (
        <p className="bsi-intel-note">Not scored yet (synced nightly from Trendlyne).</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map(([label, cell]) => (
            <div key={label} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-400">{label}</span>
              <span className="font-mono" style={cell?.color ? { color: cell.color } : undefined}>
                {typeof cell?.score === 'number' ? cell.score.toFixed(0) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


export default function PortfolioAnalytics() {
  const [tab, setTab] = React.useState('risk');
  const [symbolsInput, setSymbolsInput] = React.useState('RELIANCE, TCS, HDFCBANK, INFY');
  const [radarSymbol, setRadarSymbol] = React.useState('');
  const symbols = React.useMemo(
    () => symbolsInput.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    [symbolsInput],
  );
  const analyze = trpc.analyzePortfolio.useMutation();
  const data = analyze.data as AnalysisResult | undefined;
  const effectiveRadar = radarSymbol || symbols[0] || '';

  const runAnalysis = () => {
    if (symbols.length < 2) return;
    analyze.mutate({ symbols, weights: symbols.map(() => 1 / symbols.length) });
  };

  return (
    <div className="space-y-6">
      <div className="bsi-intel-hero">
        <div>
          <span className="bsi-intel-eyebrow">03 / PORTFOLIO ANALYTICS</span>
          <h2 className="font-display text-2xl sm:text-3xl mt-2">Know what you hold.</h2>
          <p className="bsi-intel-note mt-2">Risk decomposition, factor components and valuation context for any symbol set.</p>
        </div>
        <BarChart2 size={44} className="text-indigo-400 shrink-0" aria-hidden="true" />
      </div>

      <div className="bsi-intel-panel space-y-4">
        <div className="flex flex-col md:flex-row gap-4 items-end">
          <label className="bsi-intel-note flex-1 min-w-40">Portfolio symbols (comma-separated)
            <input
              type="text"
              value={symbolsInput}
              onChange={(e) => setSymbolsInput(e.target.value)}
              className="bsi-control w-full mt-1"
              placeholder="e.g. RELIANCE, TCS, INFY"
            />
          </label>
          <button
            type="button"
            onClick={runAnalysis}
            disabled={analyze.isPending || symbols.length < 2}
            className="bsi-action"
          >
            <RefreshCw size={14} className={analyze.isPending ? 'animate-spin' : undefined} />
            {analyze.isPending ? 'Analyzing…' : 'Analyze portfolio'}
          </button>
        </div>
        <p className="bsi-intel-note">Equal weights across {symbols.length || 0} symbols. The analysis is an on-demand service call, not stored state.</p>
      </div>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'risk' && (
        <section role="tabpanel" aria-label="Risk and Correlation" className="space-y-4">
          {analyze.isError && <QueryError retry={runAnalysis} />}
          {data?.error && <p className="bsi-intel-note">Analysis service reported: {data.error}</p>}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <MetricTile label="Sharpe ratio" value={num(data?.sharpe_ratio)} loading={analyze.isPending} />
            <MetricTile label="Portfolio beta" value={num(data?.beta)} loading={analyze.isPending} />
            <MetricTile label="Ann. return" value={percent(data?.annualized_return, 2)} loading={analyze.isPending} />
            <MetricTile label="VaR (95%, daily)" value={percent(data?.var_95, 2)} loading={analyze.isPending} />
          </div>
          <div className="bsi-intel-panel">
            <h3 className="font-display mb-3">Correlation matrix</h3>
            {analyze.isPending ? <p role="status" className="bsi-intel-note">Computing…</p> : <CorrelationMatrix matrix={data?.correlation_matrix} />}
          </div>
        </section>
      )}

      {tab === 'radar' && (
        <section role="tabpanel" aria-label="Factor Radar" className="space-y-4">
          <label className="bsi-intel-note">Symbol
            <select className="bsi-control block mt-1" value={effectiveRadar} onChange={(e) => setRadarSymbol(e.target.value)}>
              {(symbols.length > 0 ? symbols : ['']).map((s) => <option key={s || 'none'} value={s}>{s || '—'}</option>)}
            </select>
          </label>
          <div className="bsi-intel-panel">
            <FactorRadar symbol={effectiveRadar} />
          </div>
        </section>
      )}

      {tab === 'valuation' && (
        <section role="tabpanel" aria-label="Valuation Snapshot" className="space-y-4">
          {symbols.length === 0 ? (
            <p className="bsi-intel-note">Add symbols in the sandbox above to see their stored valuation context.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {symbols.slice(0, 8).map((s) => <DvmTile key={s} symbol={s} />)}
            </div>
          )}
          <p className="bsi-intel-note">Durability/Valuation/Momentum are Trendlyne's proprietary DVM scores, synced nightly into trendlyne_dvm_scores — third-party context, not a platform ranking. Peer-relative valuation needs a peer-set source no router provides today, so none is implied.</p>
        </section>
      )}

      <p className="bsi-intel-note">Analytic outputs come from the alpha-quant service and stored component scores. Nothing on this page is a ranking or a recommendation. NOT FINANCIAL ADVICE.</p>
    </div>
  );
}
