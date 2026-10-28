import React, { useMemo, useState } from 'react';
import { trpc } from '../lib/trpc';
import { CalendarClock, CheckCircle2, FlaskConical, Database, Search, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { cn } from '../lib/utils';

// Research surface over earnings_preview.py's nightly snapshot. It forecasts how strong a company's
// results will be; the backtest shown on the Backtest tab is why it does NOT claim to forecast the price move.

type Tab = 'upcoming' | 'reported' | 'backtest' | 'sources';
type Row = Record<string, any>;

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'upcoming', label: 'Upcoming results', icon: CalendarClock },
  { key: 'reported', label: 'Reported this season', icon: CheckCircle2 },
  { key: 'backtest', label: 'Backtest & learning', icon: FlaskConical },
  { key: 'sources', label: 'Data sources', icon: Database },
];

export const FEATURE_LABELS: Record<string, string> = {
  beat_score_4q: 'Beat history (last 4 qtrs)',
  prior_pat_yoy: 'Last quarter profit growth',
  prior_rev_yoy: 'Last quarter revenue growth',
  peer_pat_yoy: 'Peers already reported: profit growth',
  peer_reaction_1d: 'Peers already reported: price reaction',
  eps_rev_30d: 'Analyst EPS revision (30d)',
  target_rev_30d: 'Analyst target revision (30d)',
  runup_20d: 'Price run-up into results (20d)',
  news_sent_30d: 'News sentiment (30d)',
  buy_share: 'Analyst buy share',
};

export function pct(x: unknown, digits = 1): string {
  return typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—';
}
export function signedPct(x: unknown, digits = 1): string {
  return typeof x === 'number' && Number.isFinite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%` : '—';
}
function num(x: unknown, digits = 2): string {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : '—';
}
function tone(x: unknown): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'text-slate-500';
  return x > 0 ? 'text-emerald-400' : x < 0 ? 'text-rose-400' : 'text-slate-300';
}
export function setupLabel(decile: unknown): { label: string; cls: string } {
  if (typeof decile !== 'number') return { label: 'Not enough data', cls: 'bg-slate-700/40 text-slate-400' };
  if (decile >= 9) return { label: 'Strong results likely', cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' };
  if (decile >= 7) return { label: 'Above-average', cls: 'bg-emerald-500/10 text-emerald-400' };
  if (decile >= 4) return { label: 'Middling', cls: 'bg-slate-700/40 text-slate-300' };
  if (decile >= 2) return { label: 'Below-average', cls: 'bg-rose-500/10 text-rose-400' };
  return { label: 'Weak results likely', cls: 'bg-rose-500/15 text-rose-300 border border-rose-500/30' };
}
function tStat(s: any): string {
  if (!s || s.t == null) return 'n/a';
  return `t ${num(s.t, 1)} · ${s.n} wks`;
}

function ForecastLog({ symbol }: { symbol: string }) {
  const { data, isLoading } = trpc.getEarningsPreviewLog.useQuery({ symbol }, { staleTime: 10 * 60 * 1000 });
  if (isLoading) return <div className="text-xs text-slate-500">Loading forecast log…</div>;
  if (!data?.length) return <div className="text-xs text-slate-500">No forecast logged yet: the first one is written by tonight's run.</div>;
  const current = data.filter(r => r.model_version === data[0].model_version);
  return (
    <div className="flex flex-wrap gap-2">
      {current.slice(0, 12).map(r => (
        <span key={`${r.as_of_date}-${r.model_version}`} className="text-[11px] rounded bg-slate-800/70 px-2 py-1 text-slate-300">
          {r.as_of_date}: decile {r.decile ?? '—'} ({r.score_pct != null ? `${Math.round(r.score_pct)}th pct` : 'n/a'})
        </span>
      ))}
    </div>
  );
}

function UpcomingDetail({ r }: { r: Row }) {
  const feats = ['beat_score_4q', 'prior_pat_yoy', 'prior_rev_yoy', 'peer_pat_yoy', 'peer_reaction_1d',
                 'eps_rev_30d', 'target_rev_30d', 'runup_20d', 'news_sent_30d', 'buy_share'];
  return (
    <div className="grid gap-4 md:grid-cols-2 p-4 bg-slate-900/40">
      <div>
        <div className="v1-data-label mb-2">What fed the forecast (as of the last close)</div>
        <table className="w-full text-xs">
          <tbody>
            {feats.map(f => (
              <tr key={f} className="border-b border-slate-800/60">
                <td className="py-1 text-slate-400">{FEATURE_LABELS[f]}</td>
                <td className={cn('py-1 text-right font-mono', tone(r[f]))}>
                  {f === 'beat_score_4q' || f === 'news_sent_30d' ? num(r[f]) : f === 'buy_share' ? pct(r[f], 0) : signedPct(r[f])}
                </td>
              </tr>
            ))}
            <tr><td className="py-1 text-slate-400">Consensus target vs price</td><td className={cn('py-1 text-right font-mono', tone(r.target_upside))}>{signedPct(r.target_upside)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="space-y-3">
        <div>
          <div className="v1-data-label mb-1">What historically followed this decile</div>
          <div className="text-xs text-slate-300 leading-relaxed">
            Median profit growth {signedPct(r.hist_pat_yoy_median)} · profit grew in {pct(r.hist_p_growth_positive, 0)} of cases ·
            grew &gt;20% in {pct(r.hist_p_growth_over_20pct, 0)} · beat consensus in {pct(r.hist_p_beat, 0)} (where covered)
          </div>
        </div>
        {r.concall_takeaway && (
          <div>
            <div className="v1-data-label mb-1">Last concall {r.concall_tone ? `· tone: ${r.concall_tone}` : ''}</div>
            <p className="text-xs text-slate-400 line-clamp-4">{r.concall_takeaway}</p>
          </div>
        )}
        <div>
          <div className="v1-data-label mb-1">Forecast log (how the call moved as results neared)</div>
          <ForecastLog symbol={r.symbol} />
        </div>
      </div>
    </div>
  );
}

function UpcomingTab({ rows, onSelectStock }: { rows: Row[]; onSelectStock?: (s: string) => void }) {
  const [q, setQ] = useState('');
  const [liquidOnly, setLiquidOnly] = useState(true);
  const [sort, setSort] = useState<'score' | 'date'>('score');
  const [open, setOpen] = useState<string | null>(null);
  const view = useMemo(() => rows
    .filter(r => !q || `${r.symbol} ${r.name ?? ''} ${r.sector ?? ''}`.toUpperCase().includes(q.toUpperCase()))
    .filter(r => !liquidOnly || (r.adt_cr ?? 0) >= 10)
    .sort((a, b) => sort === 'date'
      ? String(a.expected_date).localeCompare(String(b.expected_date))
      : (b.score ?? -99) - (a.score ?? -99)), [rows, q, liquidOnly, sort]);
  return (
    <div className="v1-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-3 border-b border-slate-800">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Symbol, name or sector" className="v1-input w-56 pl-9 text-xs" aria-label="Filter companies" />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={liquidOnly} onChange={e => setLiquidOnly(e.target.checked)} />
          Tradeable only (avg turnover ≥ ₹10 cr/day)
        </label>
        <div className="flex gap-1 ml-auto text-xs">
          {(['score', 'date'] as const).map(s => (
            <button key={s} onClick={() => setSort(s)} className={cn('px-3 py-1 rounded', sort === s ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400')}>
              {s === 'score' ? 'Strongest forecast' : 'Result date'}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 text-slate-400">
            <tr>
              <th className="p-2 text-left" />
              <th className="p-2 text-left">Company</th>
              <th className="p-2 text-left">Results</th>
              <th className="p-2 text-left">Forecast</th>
              <th className="p-2 text-right">Percentile</th>
              <th className="p-2 text-right">Last qtr profit</th>
              <th className="p-2 text-right">Peers' profit</th>
              <th className="p-2 text-right">Beat history</th>
              <th className="p-2 text-right">20d run-up</th>
              <th className="p-2 text-right">Inputs</th>
            </tr>
          </thead>
          <tbody>
            {view.map(r => {
              const s = setupLabel(r.decile);
              const isOpen = open === r.symbol;
              return (
                <React.Fragment key={r.symbol}>
                  <tr className="border-b border-slate-800/60 hover:bg-slate-800/30 cursor-pointer" onClick={() => setOpen(isOpen ? null : r.symbol)}>
                    <td className="p-2 text-slate-500">{isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</td>
                    <td className="p-2">
                      <button className="font-semibold text-slate-100 hover:text-emerald-300" onClick={e => { e.stopPropagation(); onSelectStock?.(r.symbol); }}>{r.symbol}</button>
                      <div className="text-[11px] text-slate-500 truncate max-w-[14rem]">{r.name ?? ''}{r.sector ? ` · ${r.sector}` : ''}</div>
                    </td>
                    <td className="p-2 text-slate-300 whitespace-nowrap">{String(r.expected_date ?? '').slice(0, 10)}</td>
                    <td className="p-2"><span className={cn('rounded px-2 py-0.5 whitespace-nowrap', s.cls)}>{s.label}</span></td>
                    <td className="p-2 text-right font-mono text-slate-200">{r.score_pct != null ? Math.round(r.score_pct) : '—'}</td>
                    <td className={cn('p-2 text-right font-mono', tone(r.prior_pat_yoy))}>{signedPct(r.prior_pat_yoy, 0)}</td>
                    <td className={cn('p-2 text-right font-mono', tone(r.peer_pat_yoy))}>{signedPct(r.peer_pat_yoy, 0)}</td>
                    <td className={cn('p-2 text-right font-mono', tone(r.beat_score_4q))}>{num(r.beat_score_4q)}</td>
                    <td className={cn('p-2 text-right font-mono', tone(r.runup_20d))}>{signedPct(r.runup_20d)}</td>
                    <td className="p-2 text-right text-slate-500">{r.n_features}</td>
                  </tr>
                  {isOpen && <tr><td colSpan={10}><UpcomingDetail r={r} /></td></tr>}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        {!view.length && <div className="p-6 text-center text-sm text-slate-500">No upcoming results match.</div>}
      </div>
    </div>
  );
}

function ReportedTab({ rows, grading }: { rows: Row[]; grading: Row }) {
  const rec = grading?.reconstructed_top_quintile;
  const ic = grading?.reconstructed_pat_yoy;
  return (
    <div className="space-y-4">
      <div className="v1-grid-4">
        <div className="v1-stat-pill"><div className="v1-data-value">{rows.length}</div><div className="v1-data-label">Tradeable reporters so far</div></div>
        <div className="v1-stat-pill"><div className="v1-data-value">{ic?.rank_ic != null ? num(ic.rank_ic) : '—'}</div><div className="v1-data-label">Forecast vs actual profit growth (rank IC, n {ic?.n ?? 0})</div></div>
        <div className="v1-stat-pill"><div className="v1-data-value">{signedPct(rec?.pat_yoy_median, 0)}</div><div className="v1-data-label">Top-fifth forecast: median growth (rest {signedPct(rec?.rest_pat_yoy_median, 0)})</div></div>
        <div className="v1-stat-pill"><div className="v1-data-value">{signedPct(rec?.abn_1d)}</div><div className="v1-data-label">Top-fifth forecast: next-day move vs market (rest {signedPct(rec?.rest_abn_1d)})</div></div>
      </div>
      <p className="text-xs text-slate-500">
        Forecasts here are rebuilt from data public at the close before each result. Rows tagged "logged" are graded against the forecast
        this page actually saved before the result; that count grows from the first nightly run.
      </p>
      <div className="v1-card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 text-slate-400">
            <tr>
              <th className="p-2 text-left">Company</th><th className="p-2 text-left">Filed</th><th className="p-2 text-left">Forecast</th>
              <th className="p-2 text-right">Actual profit YoY</th><th className="p-2 text-right">Revenue YoY</th><th className="p-2 text-left">vs consensus</th>
              <th className="p-2 text-right">Next day vs mkt</th><th className="p-2 text-right">5 days vs mkt</th><th className="p-2 text-left">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const s = setupLabel(r.decile ?? null);
              const beat = r.beat_actual === 1 ? 'Beat' : r.beat_actual === -1 ? 'Miss' : r.beat_actual === 0 ? 'In line' : '—';
              return (
                <tr key={r.symbol} className="border-b border-slate-800/60">
                  <td className="p-2"><div className="font-semibold text-slate-100">{r.symbol}</div><div className="text-[11px] text-slate-500 truncate max-w-[12rem]">{r.sector ?? ''}</div></td>
                  <td className="p-2 text-slate-400 whitespace-nowrap">{String(r.broadcast_ts ?? '').slice(0, 10)}</td>
                  <td className="p-2 whitespace-nowrap">
                    <span className={cn('rounded px-2 py-0.5', s.cls)}>{s.label}</span>
                    {r.logged_score != null && <span className="ml-1 text-[10px] text-emerald-400">logged</span>}
                  </td>
                  <td className={cn('p-2 text-right font-mono', tone(r.pat_yoy))}>{signedPct(r.pat_yoy, 0)}</td>
                  <td className={cn('p-2 text-right font-mono', tone(r.rev_yoy))}>{signedPct(r.rev_yoy, 0)}</td>
                  <td className={cn('p-2', r.beat_actual === 1 ? 'text-emerald-400' : r.beat_actual === -1 ? 'text-rose-400' : 'text-slate-400')}>{beat}</td>
                  <td className={cn('p-2 text-right font-mono', tone(r.abn_1d))}>{signedPct(r.abn_1d)}</td>
                  <td className={cn('p-2 text-right font-mono', tone(r.abn_5d))}>{signedPct(r.abn_5d)}</td>
                  <td className="p-2 text-[11px] text-slate-500">{r.growth_src === 'filing_xbrl' ? 'NSE filing' : r.growth_src ? 'restated' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Verdict({ ok, title, detail }: { ok: boolean | null; title: string; detail: string }) {
  return (
    <div className={cn('rounded-lg border p-3', ok ? 'border-emerald-500/30 bg-emerald-500/5' : ok === false ? 'border-rose-500/30 bg-rose-500/5' : 'border-slate-700 bg-slate-800/30')}>
      <div className={cn('text-sm font-semibold', ok ? 'text-emerald-300' : ok === false ? 'text-rose-300' : 'text-slate-300')}>{title}</div>
      <div className="text-xs text-slate-400 mt-1 leading-relaxed">{detail}</div>
    </div>
  );
}

function BacktestTab({ bt }: { bt: Row | null }) {
  if (!bt) return <div className="v1-card p-6 text-sm text-slate-500">No backtest snapshot yet.</div>;
  const v = bt.verdict ?? {};
  const main = v.primary_score === 'score_learned' ? bt.composite_learned : bt.composite_equal;
  const fc = main?.pat_yoy;
  const r5 = main?.abn_5d;
  const lead = bt.price_lead;
  const deciles: Row[] = bt.calibration?.deciles ?? [];
  const latestW = (bt.weight_history ?? []).slice(-1)[0];
  const featRows = Object.entries(bt.features ?? {}) as [string, Row][];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Verdict ok={!!v.forecast_ic_pass} title={`Results strength: ${v.forecast_ic_pass ? 'forecastable' : 'not shown'}`}
          detail={`Rank IC ${num(fc?.ic?.mean)} between the forecast and the profit growth actually reported (${tStat(fc?.ic)}). Top fifth averaged ${signedPct(fc?.quintile_mean?.['5'], 0)} growth, bottom fifth ${signedPct(fc?.quintile_mean?.['1'], 0)}.`} />
        <Verdict ok={false} title="Price reaction: not forecastable from this"
          detail={`Rank IC ${num(r5?.ic?.mean, 3)} vs the 5-day move after results (${tStat(r5?.ic)}). Buying the top fifth the day before results returned ${signedPct(r5?.top_quintile_net?.mean, 2)} vs the market after 0.30% costs. The predictable part of growth is already in the price.`} />
        <Verdict ok={lead?.forward_state === 'PASS' ? true : lead?.forward_state === 'FAIL' ? false : null}
          title={`Run-up lead: ${lead?.forward_state ?? 'n/a'} (forward test)`}
          detail={`In-sample (found 2026-10-27, not pre-registered): stocks with the strongest 20-day run-up beat other reporters by ${signedPct(lead?.in_sample?.mean, 2)} over 5 days (${tStat(lead?.in_sample)}). Graded forward only from ${lead?.rule?.forward_from}; ${lead?.forward?.n ?? 0} of ${lead?.rule?.min_cohorts} weeks so far. Relative only: not a long-only trade.`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="v1-card p-4">
          <div className="v1-title-card text-sm mb-1">What followed each forecast decile</div>
          <p className="text-[11px] text-slate-500 mb-3">Median reported profit growth, {bt.events_liquid} tradeable results, {bt.seasons} seasons ({bt.first_reaction} to {bt.last_reaction}), walk-forward.</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={deciles.map(d => ({ d: `D${d.decile}`, g: (d.pat_yoy_median ?? 0) * 100, r: (d.abn_1d_mean ?? 0) * 100 }))}>
                <XAxis dataKey="d" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} unit="%" />
                <Tooltip formatter={(x: number) => `${x.toFixed(1)}%`} contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                <ReferenceLine y={0} stroke="#475569" />
                <Bar dataKey="g" name="Median profit growth">
                  {deciles.map((d, i) => <Cell key={i} fill={(d.pat_yoy_median ?? 0) >= 0 ? '#10b981' : '#f43f5e'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="v1-card p-4 overflow-x-auto">
          <div className="v1-title-card text-sm mb-2">Odds by decile</div>
          <table className="w-full text-xs">
            <thead className="text-slate-400"><tr><th className="text-left p-1">Decile</th><th className="text-right p-1">n</th><th className="text-right p-1">Profit grew</th><th className="text-right p-1">Grew &gt;20%</th><th className="text-right p-1">Beat</th><th className="text-right p-1">Next day</th><th className="text-right p-1">5 days</th></tr></thead>
            <tbody>
              {deciles.map(d => (
                <tr key={d.decile} className="border-t border-slate-800/60">
                  <td className="p-1 text-slate-300">D{d.decile}</td><td className="p-1 text-right text-slate-500">{d.n}</td>
                  <td className="p-1 text-right font-mono">{pct(d.p_growth_positive, 0)}</td><td className="p-1 text-right font-mono">{pct(d.p_growth_over_20pct, 0)}</td>
                  <td className="p-1 text-right font-mono">{pct(d.p_beat, 0)}</td>
                  <td className={cn('p-1 text-right font-mono', tone(d.abn_1d_mean))}>{signedPct(d.abn_1d_mean, 2)}</td>
                  <td className={cn('p-1 text-right font-mono', tone(d.abn_5d_mean))}>{signedPct(d.abn_5d_mean, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="v1-card p-4 overflow-x-auto">
          <div className="v1-title-card text-sm mb-1">Each input, measured</div>
          <p className="text-[11px] text-slate-500 mb-2">Mean rank IC per results-week; t over weeks. Coverage = share of tradeable results with the input.</p>
          <table className="w-full text-xs">
            <thead className="text-slate-400"><tr><th className="text-left p-1">Input</th><th className="text-right p-1">Coverage</th><th className="text-right p-1">vs profit growth</th><th className="text-right p-1">vs next-day move</th><th className="text-right p-1">vs 5-day move</th></tr></thead>
            <tbody>
              {featRows.map(([f, s]) => (
                <tr key={f} className="border-t border-slate-800/60">
                  <td className="p-1 text-slate-300">{FEATURE_LABELS[f] ?? f}<span className="ml-1 text-[10px] text-slate-500">{s.role}</span></td>
                  <td className="p-1 text-right text-slate-500">{pct(s.coverage, 0)}</td>
                  {(['pat_yoy', 'abn_1d', 'abn_5d'] as const).map(o => (
                    <td key={o} className={cn('p-1 text-right font-mono', s[o]?.t != null && Math.abs(s[o].t) >= 2 ? tone(s[o].mean) : 'text-slate-500')}>
                      {num(s[o]?.mean, 3)} <span className="text-[10px] text-slate-500">({s[o]?.t != null ? num(s[o].t, 1) : 'n/a'})</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="v1-card p-4">
          <div className="v1-title-card text-sm mb-1">How the model improves over time</div>
          <p className="text-[11px] text-slate-500 mb-3">
            Each season is scored with weights learned only from results-weeks that had already closed, starting from equal weights.
            Learned weights replace the equal-weight control only if they beat it out of sample (paired t ≥ {bt.protocol?.learned?.promote_t} over ≥ {bt.protocol?.learned?.min_oos_seasons} seasons).
            Status: <span className={v.learned_promoted ? 'text-emerald-300' : 'text-slate-300'}>{v.learned_promoted ? 'promoted' : 'not promoted'}</span>,
            IC gain {num(v.learned_vs_equal_ic_diff?.mean, 3)} ({tStat(v.learned_vs_equal_ic_diff)}, {v.learned_oos_seasons} seasons).
          </p>
          {latestW && (
            <div className="space-y-1.5">
              <div className="v1-data-label">Current weights</div>
              {Object.entries(latestW.weights as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([f, w]) => (
                <div key={f} className="flex items-center gap-2 text-xs">
                  <span className="w-56 text-slate-400 truncate">{FEATURE_LABELS[f] ?? f}</span>
                  <div className="flex-1 h-2 rounded bg-slate-800"><div className="h-2 rounded bg-emerald-500/70" style={{ width: `${Math.round(w * 100)}%` }} /></div>
                  <span className="w-10 text-right font-mono text-slate-300">{Math.round(w * 100)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="v1-card p-4 overflow-x-auto">
        <div className="v1-title-card text-sm mb-2">Season by season</div>
        <table className="w-full text-xs">
          <thead className="text-slate-400"><tr><th className="text-left p-1">Quarter</th><th className="text-right p-1">Results</th><th className="text-right p-1">Scored</th><th className="text-right p-1">Forecast vs growth IC</th><th className="text-right p-1">Forecast vs 5-day move IC</th></tr></thead>
          <tbody>
            {(bt.by_season ?? []).map((s: Row) => (
              <tr key={s.season} className="border-t border-slate-800/60">
                <td className="p-1 text-slate-300">{s.season}</td><td className="p-1 text-right text-slate-500">{s.events}</td><td className="p-1 text-right text-slate-500">{s.scored}</td>
                <td className={cn('p-1 text-right font-mono', tone(s.forecast_ic?.mean))}>{num(s.forecast_ic?.mean, 3)}</td>
                <td className={cn('p-1 text-right font-mono', tone(s.reaction_5d_ic?.mean))}>{num(s.reaction_5d_ic?.mean, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-slate-500 mt-2">{bt.evidence} Protocol {bt.protocol?.version} ({bt.protocol_hash}), frozen {bt.protocol?.frozen_on}.</p>
      </div>
    </div>
  );
}

const SOURCES: { name: string; table: string; use: string; window: string }[] = [
  { name: 'NSE results filings', table: 'nse_results_filings', use: 'Exact broadcast time of every quarterly result: the event clock and the history the backtest runs on', window: 'since 2021' },
  { name: 'NSE filing XBRL financials', table: 'nse_filing_financials', use: 'First-reported profit and revenue (not restated): actual growth this season', window: 'quarters from 2025-09' },
  { name: 'MarketsMojo quarterly history', table: 'dalalos_financial_trends_history', use: 'Prior-quarter growth and actual growth in past seasons (restated values, dated by the filing)', window: 'since 2018' },
  { name: 'MoneyControl estimates hits/misses', table: 'mc_estimates_hits_misses', use: 'Beat / in-line / miss vs consensus by quarter: beat history and the realised beat', window: 'analyst-covered names, since 2023-12' },
  { name: 'Analyst consensus snapshots', table: 'analyst_estimates_history', use: 'Daily consensus EPS, target, buy count: 30-day revisions before results', window: 'since 2026-06' },
  { name: 'MoneyControl results calendar', table: 'stock_earnings_dates', use: 'Which companies report in the next 21 days (rescheduled dates dropped)', window: 'current + next weeks' },
  { name: 'Stock industry/sector', table: 'nse_stocks', use: 'Peer groups for read-through from companies that already reported', window: 'current' },
  { name: 'Daily prices', table: 'stock_ohlcv', use: 'Run-up into results, liquidity floor, reaction after results', window: 'since 2021' },
  { name: 'News linked to symbols', table: 'news_symbol_link', use: 'Sentiment in the 30 days before results (context only; no measured edge)', window: 'sparse before 2026-07' },
  { name: 'Concall takeaways', table: 'concall_takeaways', use: 'Last quarter management tone and key takeaway (shown, not scored)', window: 'since 2026-06' },
];

function SourcesTab({ bt }: { bt: Row | null }) {
  return (
    <div className="v1-card p-4 overflow-x-auto">
      <p className="text-xs text-slate-400 mb-3">
        Reviewed 2026-10-27. Also checked and left out: broker targets (trendlyne_analyst_targets: known only months after the report date),
        options implied move (stock_option_features_history ends 2024-07), insider trades (stale since 2026-05), and exchange-announcement news
        (measured 2026-10-09: the move is over within ~15 minutes, faster than our feed).
      </p>
      <table className="w-full text-xs">
        <thead className="text-slate-400"><tr><th className="text-left p-1">Source</th><th className="text-left p-1">Table</th><th className="text-left p-1">Used for</th><th className="text-left p-1">History</th></tr></thead>
        <tbody>
          {SOURCES.map(s => (
            <tr key={s.table} className="border-t border-slate-800/60 align-top">
              <td className="p-1 text-slate-200">{s.name}</td><td className="p-1 font-mono text-[11px] text-slate-500">{s.table}</td>
              <td className="p-1 text-slate-400">{s.use}</td><td className="p-1 text-slate-500">{s.window}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {bt?.growth_sources && (
        <p className="text-[11px] text-slate-500 mt-3">
          Actual-growth source across the backtest: {Object.entries(bt.growth_sources).map(([k, n]) => `${k === 'filing_xbrl' ? 'NSE filing' : 'restated history'} ${n}`).join(' · ')}.
        </p>
      )}
    </div>
  );
}

export const EarningsPreviewPage: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [tab, setTab] = useState<Tab>('upcoming');
  const { data, isLoading } = trpc.getEarningsPreview.useQuery(undefined, { staleTime: 10 * 60 * 1000, refetchOnWindowFocus: false });
  const live = data?.live;
  const upcoming: Row[] = live?.upcoming ?? [];
  const reported: Row[] = live?.reported ?? [];
  const strong = upcoming.filter(r => (r.decile ?? 0) >= 9 && (r.adt_cr ?? 0) >= 10).length;
  return (
    <div className="v1-page space-y-5">
      <div className="v1-header">
        <div className="v1-header-left">
          <h1 className="v1-title-page">Earnings Preview</h1>
          <p className="text-sm text-slate-400">Which upcoming reporters look set for strong results, and how those calls have held up</p>
        </div>
        <div className="text-right text-[11px] text-slate-500">
          {live ? <>Season ending {live.season} · as of close {live.as_of_session}<br />Research only: not a buy list</> : null}
        </div>
      </div>

      {isLoading && <div className="flex justify-center h-40 items-center"><div className="animate-spin w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full" /></div>}
      {!isLoading && !live && <div className="v1-card p-6 text-sm text-slate-400">No preview snapshot yet: earnings_preview.py writes it nightly in ml-daily-ops.</div>}

      {live && (
        <>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200/90">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              The forecast predicts how strong the reported numbers will be, and it does that well in the backtest. It does not predict the share-price
              move: over {data?.backtest?.seasons ?? '—'} seasons, stocks forecast to report strongly did no better after results than other reporters.
              Results that beat what the market expected move the price. Results the market already expected do not.
            </span>
          </div>
          <div className="v1-grid-4">
            <div className="v1-stat-pill"><div className="v1-data-value">{upcoming.length}</div><div className="v1-data-label">Reporting in the next 3 weeks</div></div>
            <div className="v1-stat-pill v1-stat-pill-up"><div className="v1-data-value">{strong}</div><div className="v1-data-label">Tradeable, top-two-decile forecast</div></div>
            <div className="v1-stat-pill"><div className="v1-data-value">{reported.length}</div><div className="v1-data-label">Already reported (tradeable)</div></div>
            <div className="v1-stat-pill"><div className="v1-data-value">{live.primary_model === 'learned' ? 'Learned' : 'Equal'}</div><div className="v1-data-label">Weighting in use</div></div>
          </div>
          <div className="flex gap-1 bg-slate-800/40 rounded-xl p-1 overflow-x-auto" role="tablist">
            {TABS.map(t => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                className={cn('flex items-center gap-1.5 py-2 px-4 rounded-lg text-xs font-semibold whitespace-nowrap',
                  tab === t.key ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-slate-400 hover:text-slate-300')}>
                <t.icon className="w-3.5 h-3.5" />{t.label}
              </button>
            ))}
          </div>
          {tab === 'upcoming' && <UpcomingTab rows={upcoming} onSelectStock={onSelectStock} />}
          {tab === 'reported' && <ReportedTab rows={reported} grading={live.live_grading} />}
          {tab === 'backtest' && <BacktestTab bt={data?.backtest ?? null} />}
          {tab === 'sources' && <SourcesTab bt={data?.backtest ?? null} />}
        </>
      )}
    </div>
  );
};

export default EarningsPreviewPage;
