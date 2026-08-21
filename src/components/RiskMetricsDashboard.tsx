import { useState, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import {
  Shield, TrendingUp, TrendingDown, AlertTriangle, Activity,
  ChevronDown, ChevronUp, Info, Zap, BarChart2
} from 'lucide-react';

// ── Risk tier colour config ────────────────────────────────────────────────────
const RISK_TIER_CONFIG = {
  Low:     { color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-500' },
  Medium:  { color: 'text-amber-400',   bg: 'bg-amber-500/10  border-amber-500/30',   dot: 'bg-amber-500'   },
  High:    { color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/30',  dot: 'bg-orange-500'  },
  Extreme: { color: 'text-rose-400',    bg: 'bg-rose-500/10   border-rose-500/30',    dot: 'bg-rose-500'    },
  Unknown: { color: 'text-slate-400',   bg: 'bg-slate-700/20  border-slate-600/30',   dot: 'bg-slate-500'   },
} as const;

const REGIME_CONFIG: Record<string, { color: string; bg: string; ring: string; icon: string }> = {
  BULL:     { color: 'text-emerald-300', bg: 'bg-emerald-500/15', ring: 'ring-emerald-500/40', icon: '🐂' },
  SIDEWAYS: { color: 'text-amber-300',   bg: 'bg-amber-500/15',   ring: 'ring-amber-500/40',   icon: '↔' },
  HIGH_VOL: { color: 'text-orange-300',  bg: 'bg-orange-500/15',  ring: 'ring-orange-500/40',  icon: '⚡' },
  BEAR:     { color: 'text-rose-300',    bg: 'bg-rose-500/15',    ring: 'ring-rose-500/40',    icon: '🐻' },
  CRASH:    { color: 'text-red-300',     bg: 'bg-red-500/15',     ring: 'ring-red-500/40',     icon: '⛔' },
};

// ── Helpers ────────────────────────────────────────────────────────────────────
const fmt  = (v: number | null | undefined, d = 2) => v == null ? '—' : v.toFixed(d);
const fmtP = (v: number | null | undefined) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

function RadarBar({ label, value, max = 100, color }: { label: string; value: number | null; max?: number; color: string }) {
  const pct = value == null ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 text-slate-400 text-right">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-slate-300 text-right">{fmt(value, 1)}</span>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RegimeBadge() {
  const { data } = trpc.getRegimeSummary.useQuery();
  if (!data?.current) return null;

  const { regime, prob, guidance } = data.current;
  const cfg = REGIME_CONFIG[regime] ?? REGIME_CONFIG.SIDEWAYS;

  return (
    <div className={`flex items-center gap-3 px-4 py-2 rounded-xl border ${cfg.bg} ring-1 ${cfg.ring}`}>
      <span className="text-lg">{cfg.icon}</span>
      <div>
        <div className={`font-bold text-sm tracking-wide ${cfg.color}`}>{regime} REGIME</div>
        <div className="text-xs text-slate-400">{guidance.action} · {Math.round(prob * 100)}% confidence</div>
      </div>
    </div>
  );
}

function MetricCell({ label, value, unit = '', good = 'high', tooltip }: {
  label: string;
  value: number | null;
  unit?: string;
  good?: 'high' | 'low';
  tooltip?: string;
}) {
  const isGood = value == null ? null :
    good === 'high' ? value > 0 : value < 1.2;

  return (
    <div className="flex flex-col gap-0.5" title={tooltip}>
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-sm font-data font-bold ${
        value == null ? 'text-slate-600' :
        isGood ? 'text-emerald-400' : 'text-rose-400'
      }`}>
        {value == null ? '—' : `${fmt(value)}${unit}`}
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  /** Symbol to drill into for single-stock detail. Optional. */
  focusSymbol?: string;
  /** Show collapsed by default */
  collapsed?: boolean;
}

export const RiskMetricsDashboard: React.FC<Props> = ({ focusSymbol, collapsed = false }) => {
  const [expanded, setExpanded] = useState(!collapsed);
  const [maxBeta, setMaxBeta] = useState<number | undefined>(undefined);
  const [minScore, setMinScore] = useState(0);
  const [sectorFilter, setSectorFilter] = useState('ALL');

  // ── Per-symbol detail ──────────────────────────────────────────────────────
  const { data: symbolRisk } = trpc.getRiskMetrics.useQuery(
    { symbol: focusSymbol! },
    { enabled: !!focusSymbol }
  );

  // ── Universe rankings ──────────────────────────────────────────────────────
  const { data: topStocks, isLoading } = trpc.getMultiFactorScores.useQuery({
    limit: 50,
    minScore,
    maxBeta,
    sector: sectorFilter !== 'ALL' ? sectorFilter : undefined,
  });

  // ── Universe distribution ──────────────────────────────────────────────────
  const { data: distribution } = trpc.getRiskDistribution.useQuery();

  // Sectors from top stocks
  const sectors = useMemo(() => {
    if (!topStocks) return ['ALL'];
    const s = [...new Set(topStocks.map((r: any) => r.sector).filter(Boolean))].sort();
    return ['ALL', ...s];
  }, [topStocks]);

  return (
    <div className="v1-card overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-slate-800/40 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-violet-500/10 border border-violet-500/20">
            <Shield className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <h3 className="v1-title-card">Risk & Multi-Factor Dashboard</h3>
            <p className="text-xs text-slate-500">Beta · Sortino · VaR · Quality+Momentum+Value factors</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <RegimeBadge />
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-slate-500" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-500" />
          )}
        </div>
      </div>

      {!expanded && (
        <div className="h-px bg-slate-800" />
      )}

      {expanded && (
        <div className="px-5 pb-5 space-y-5">

          {/* ── Per-symbol detail panel ──────────────────────────────────── */}
          {symbolRisk && (
            <div className="v1-card p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-bold text-slate-200">{symbolRisk.symbol}</div>
                  <div className="text-xs text-slate-500">{symbolRisk.name} · {symbolRisk.sector}</div>
                </div>
                {symbolRisk.risk_tier && (
                  <span className={`px-3 py-1 rounded-full text-xs font-bold border ${
                    RISK_TIER_CONFIG[symbolRisk.risk_tier as keyof typeof RISK_TIER_CONFIG]?.bg ?? ''
                  } ${RISK_TIER_CONFIG[symbolRisk.risk_tier as keyof typeof RISK_TIER_CONFIG]?.color ?? ''}`}>
                    {symbolRisk.risk_tier} Risk
                  </span>
                )}
              </div>

              {/* Risk metrics row */}
              <div className="grid grid-cols-4 gap-4">
                <MetricCell label="Beta 1Y"    value={symbolRisk.beta_1y}      unit="×"  good="low"  tooltip="1-year rolling beta vs Nifty 50" />
                <MetricCell label="Sharpe"     value={symbolRisk.sharpe_ratio} unit=""   good="high" tooltip="Annualised Sharpe ratio (risk-adjusted return)" />
                <MetricCell label="Sortino"    value={symbolRisk.sortino_ratio} unit=""  good="high" tooltip="Like Sharpe but penalises only downside volatility" />
                <MetricCell label="VaR 95%"    value={symbolRisk.var_95}       unit="%"  good="low"  tooltip="Maximum daily loss expected with 95% confidence" />
                <MetricCell label="Beta 6M"    value={symbolRisk.beta_6m}      unit="×"  good="low"  tooltip="6-month rolling beta — catches regime change faster" />
                <MetricCell label="Max DD 1Y"  value={symbolRisk.max_drawdown_1y} unit="%" good="low" tooltip="Peak-to-trough % decline over the last 252 days" />
                <MetricCell label="Vol p.a."   value={symbolRisk.annualized_vol} unit="%"  good="low" tooltip="Annualised daily return standard deviation" />
                <MetricCell label="Rank"       value={symbolRisk.rank_composite} unit=""  good="high" tooltip="Composite percentile rank 0-100" />
              </div>

              {/* Multi-factor radar bars */}
              {symbolRisk.mf_composite_score != null && (
                <div className="space-y-2 pt-2 border-t border-slate-700/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">Multi-Factor Breakdown</span>
                    <span className="text-xs font-bold text-violet-400">
                      Composite: {fmt(symbolRisk.mf_composite_score, 1)}
                    </span>
                  </div>
                  <RadarBar label="Quality"    value={symbolRisk.mf_quality_score}   color="bg-emerald-500" />
                  <RadarBar label="Momentum"   value={symbolRisk.mf_momentum_score}  color="bg-sky-500"     />
                  <RadarBar label="Value"      value={symbolRisk.mf_value_score}     color="bg-amber-500"   />
                  <RadarBar label="Risk-Adj"   value={symbolRisk.mf_risk_adj_score}  color="bg-violet-500"  />
                  <RadarBar label="Macro"      value={symbolRisk.mf_macro_score}     color="bg-teal-500"    />
                </div>
              )}
            </div>
          )}

          {/* ── Filters row ──────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Max Beta filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Max Beta:</span>
              {[undefined, 0.8, 1.0, 1.2, 1.5].map(val => (
                <button
                  key={val ?? 'any'}
                  onClick={() => setMaxBeta(val)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    maxBeta === val
                      ? 'bg-violet-500/20 border-violet-500/50 text-violet-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {val === undefined ? 'Any' : `≤${val}`}
                </button>
              ))}
            </div>

            {/* Min score filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Min Score:</span>
              {[0, 50, 60, 70, 80].map(v => (
                <button
                  key={v}
                  onClick={() => setMinScore(v)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    minScore === v
                      ? 'bg-violet-500/20 border-violet-500/50 text-violet-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {v === 0 ? 'All' : `${v}+`}
                </button>
              ))}
            </div>

            {/* Sector filter */}
            <select
              value={sectorFilter}
              onChange={e => setSectorFilter(e.target.value)}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300"
            >
              {sectors.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* ── Universe distribution pill row ───────────────────────────── */}
          {distribution && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-slate-500">Universe risk:</span>
              {Object.entries(distribution.tiers).map(([tier, count]) => {
                const cfg = RISK_TIER_CONFIG[tier as keyof typeof RISK_TIER_CONFIG] ?? RISK_TIER_CONFIG.Unknown;
                return (
                  <span key={tier} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${cfg.bg} ${cfg.color}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                    {tier}: {count}
                  </span>
                );
              })}
              {distribution.avgBeta && (
                <span className="text-slate-500 ml-2">
                  Avg Beta: {distribution.avgBeta.toFixed(2)}
                </span>
              )}
            </div>
          )}

          {/* ── Top stocks table ─────────────────────────────────────────── */}
          {isLoading ? (
            <div className="text-center py-8 text-slate-500 text-sm">Loading risk metrics...</div>
          ) : !topStocks?.length ? (
            <div className="text-center py-8 text-slate-600 text-sm">
              No multi-factor scores yet. Run: <code className="text-violet-400">python multi_factor_scorer.py</code>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-800">
                    <th className="text-left py-2 px-2 font-medium">Symbol</th>
                    <th className="text-right py-2 px-2 font-medium">Risk</th>
                    <th className="text-right py-2 px-2 font-medium">Beta</th>
                    <th className="text-right py-2 px-2 font-medium">Sharpe</th>
                    <th className="text-right py-2 px-2 font-medium">Sortino</th>
                    <th className="text-right py-2 px-2 font-medium">VaR 95%</th>
                    <th className="text-right py-2 px-2 font-medium">MF Score</th>
                    <th className="text-right py-2 px-2 font-medium">Class</th>
                  </tr>
                </thead>
                <tbody>
                  {topStocks.map((row: any, i: number) => {
                    const tier = row.risk_tier as keyof typeof RISK_TIER_CONFIG;
                    const rCfg = RISK_TIER_CONFIG[tier] ?? RISK_TIER_CONFIG.Unknown;
                    return (
                      <tr key={row.symbol} className={`border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors ${i % 2 === 0 ? '' : 'bg-slate-800/10'}`}>
                        <td className="py-2 px-2">
                          <div className="font-bold text-slate-200">{row.symbol}</div>
                          <div className="text-slate-500 text-[10px]">{row.sector}</div>
                        </td>
                        <td className="py-2 px-2 text-right">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] ${rCfg.bg} ${rCfg.color}`}>
                            <span className={`w-1 h-1 rounded-full ${rCfg.dot}`} />
                            {tier}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right font-data text-slate-300">{fmt(row.beta_1y, 2)}</td>
                        <td className={`py-2 px-2 text-right font-data ${row.sharpe_ratio > 1 ? 'text-emerald-400' : row.sharpe_ratio < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                          {fmt(row.sharpe_ratio, 2)}
                        </td>
                        <td className={`py-2 px-2 text-right font-data ${row.sortino_ratio > 1.5 ? 'text-emerald-400' : row.sortino_ratio < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                          {fmt(row.sortino_ratio, 2)}
                        </td>
                        <td className={`py-2 px-2 text-right font-data ${row.var_95 > 4 ? 'text-rose-400' : row.var_95 < 2 ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {fmt(row.var_95, 1)}%
                        </td>
                        <td className="py-2 px-2 text-right">
                          <span className="font-bold text-violet-400">{fmt(row.mf_composite_score, 1)}</span>
                        </td>
                        <td className="py-2 px-2 text-right">
                          <span className={`text-[10px] font-medium ${
                            row.composite_class === 'Strong Buy' ? 'text-emerald-400' :
                            row.composite_class === 'Buy' ? 'text-teal-400' :
                            row.composite_class === 'Hold' ? 'text-slate-400' :
                            'text-rose-400'
                          }`}>
                            {row.composite_class ?? '—'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default RiskMetricsDashboard;
