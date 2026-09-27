import { Brain, ShieldAlert } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ago, DASH, frac, n0, num, pct } from '../lib/format';
import { Chip, Meter, Panel, Stat } from '../components/Primitives';
import { BarRow } from '../components/Charts';
import { DataTable } from '../components/DataTable';

/**
 * EDGE — the page that tells you how much to trust everything else.
 *
 * This is the most important screen on the desk and the one most product
 * dashboards omit. Every pick the platform publishes is a claim that some signal
 * has predicted a forward move; this page shows what those signals have actually
 * done against resolved outcomes. A 29% headline win rate looks like failure, and
 * under a path-barrier label with a 3% barrier 29% is excellent — so the label
 * definition is displayed beside the number, always, and neither appears without
 * the other.
 *
 * Nothing here is re-weighted or "improved". It is the platform's own measured
 * record, shown as measured.
 */
export default function EdgePage() {
  return (
    <div className="tala-rise space-y-3 p-3">
      <Caveat />
      <div className="grid gap-3 lg:grid-cols-3">
        <OverallCard />
        <ByRegimeCard />
        <TopSignalsCard />
      </div>
      <SignalTypes />
      <ModelRegistry />
    </div>
  );
}

function Caveat() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warn/25 bg-warn/[0.05] px-3.5 py-2.5">
      <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warn" />
      <p className="text-[11px] leading-relaxed text-mark-2">
        <span className="font-semibold text-warn">Read this before the numbers.</span> Every figure below is
        measured on <em>resolved</em> outcomes at a fixed forward horizon under a specific label definition —
        not on live price action, and not adjusted for costs, slippage, or whether you could actually have got
        the fill. A good number here means the signal carries information. It does not mean a book built on it
        would have made money.
      </p>
    </div>
  );
}

function OverallCard() {
  const { data } = trpc.getPerformanceDashboard.useQuery(undefined, { staleTime: 30 * 60_000 });
  const o: any = (data as any)?.overall;

  return (
    <Panel accent eyebrow="HEADLINE" title="All resolved signals">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Win rate"
          value={frac(o?.win_rate)}
          size="xl"
          tone={(num(o?.win_rate) ?? 0) >= 0.5 ? 'text-up' : 'text-down'}
        />
        <Stat
          label="Avg return"
          value={pct(o?.avg_return_pct)}
          size="xl"
          tone={(num(o?.avg_return_pct) ?? 0) >= 0 ? 'text-up' : 'text-down'}
        />
        <Stat label="Sharpe" value={num(o?.sharpe_ratio)?.toFixed(2) ?? DASH} size="lg" />
        <Stat
          label="Profit factor"
          value={num(o?.profit_factor)?.toFixed(2) ?? DASH}
          size="lg"
          tone={(num(o?.profit_factor) ?? 0) > 1.5 ? 'text-up' : 'text-warn'}
        />
        <Stat label="Max drawdown" value={pct(o?.max_drawdown_pct)} size="lg" tone="text-down" />
        <Stat
          label="Alpha vs Nifty"
          value={pct(o?.alpha_vs_nifty)}
          size="lg"
          tone={(num(o?.alpha_vs_nifty) ?? 0) >= 0 ? 'text-up' : 'text-down'}
        />
      </div>
    </Panel>
  );
}

/** Per-regime performance is the most actionable cut on this page: a strategy that
 *  only works in BULL is a real strategy — but only if you know that it is one. */
function ByRegimeCard() {
  const { data } = trpc.getPerformanceDashboard.useQuery(undefined, { staleTime: 30 * 60_000 });
  const rows: any[] = (data as any)?.byRegime ?? [];
  const max = Math.max(0.01, ...rows.map((r) => num(r.avg_win_rate) ?? 0));

  return (
    <Panel eyebrow="REGIME" title="Performance by market regime">
      <div className="space-y-0.5">
        {rows.map((r) => (
          <BarRow
            key={r.market_regime}
            label={r.market_regime}
            value={num(r.avg_win_rate)}
            max={max}
            tone={
              (num(r.avg_win_rate) ?? 0) >= 0.5
                ? 'bg-up/70'
                : (num(r.avg_win_rate) ?? 0) >= 0.4
                  ? 'bg-marigold/60'
                  : 'bg-down/50'
            }
            right={frac(r.avg_win_rate)}
            sub={n0(r.total_signals)}
          />
        ))}
      </div>
      {rows.length > 0 && (
        <p className="mt-2.5 border-t border-line pt-2.5 text-[10px] leading-relaxed text-mark-4">
          Read this alongside the regime banner. If the same signal reads very differently across regimes, the
          regime filter is doing most of the work — not the signal.
        </p>
      )}
    </Panel>
  );
}

function TopSignalsCard() {
  const { data } = trpc.getPerformanceDashboard.useQuery(undefined, { staleTime: 30 * 60_000 });
  const rows: any[] = (data as any)?.topSignals ?? [];

  return (
    <Panel dense eyebrow="BEST" title="Highest hit-rate signal types">
      <DataTable
        rows={rows}
        getKey={(r: any) => r.strategy_name}
        dense
        initialSort={{ key: 'wr', dir: 'desc' }}
        maxHeight="260px"
        columns={[
          { key: 'name', header: 'Signal', sort: (r: any) => r.strategy_name, cell: (r: any) => (
            <span className="font-mono text-[10px] text-mark-2">{r.strategy_name}</span>
          ) },
          { key: 'wr', header: 'Win rate', align: 'right', sort: (r: any) => num(r.win_rate), cell: (r: any) => (
            <span className={cn('tnum font-mono font-semibold', (num(r.win_rate) ?? 0) >= 0.5 ? 'text-up' : 'text-mark-2')}>
              {frac(r.win_rate)}
            </span>
          ) },
          { key: 'ret', header: 'Avg ret', align: 'right', sort: (r: any) => num(r.avg_return_pct), cell: (r: any) => (
            <span className={cn('tnum font-mono', (num(r.avg_return_pct) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
              {pct(r.avg_return_pct)}
            </span>
          ) },
          { key: 'n', header: 'n', align: 'right', hideBelow: 'md', sort: (r: any) => num(r.total_signals), cell: (r: any) => (
            <span className="tnum font-mono text-[10px] text-mark-4">{n0(r.total_signals)}</span>
          ) },
        ]}
        emptyLabel="No resolved signal statistics yet"
      />
    </Panel>
  );
}

/**
 * Per-signal-type win rates at each horizon, beside the score-bucket calibration
 * panel. The latter answers "does a higher score actually mean a better outcome?",
 * which is the assumption the entire ranking rests on.
 */
function SignalTypes() {
  const { data, isLoading } = trpc.getSignalTypeStats.useQuery(undefined, { staleTime: 30 * 60_000 });
  const { data: win } = trpc.getSignalWinRates.useQuery(undefined, { staleTime: 30 * 60_000 });
  const rows: any[] = Array.isArray(data) ? data : [];
  const w: any = win ?? {};
  const buckets: any[] = Object.entries(w.byScoreBucket ?? {}).map(([k, v]: [string, any]) => ({ bucket: k, ...v }));

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel dense eyebrow="LABEL" title={'Win rate by signal type - ' + (w.labelDefinition ?? 'definition unavailable')}>
        <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
          A signal "wins" when price reaches the upper barrier before the lower one within the stated horizon.
          The label definition changes the number completely - always read it with the rate.
        </p>
        <DataTable
          rows={rows}
          getKey={(r: any) => r.signal_type + '-' + r.horizon_days + '-' + r.market_regime}
          isLoading={isLoading}
          dense
          maxHeight="380px"
          initialSort={{ key: 'wr', dir: 'desc' }}
          columns={[
            { key: 'type', header: 'Signal', sort: (r: any) => r.signal_type, cell: (r: any) => (
              <span className="font-mono text-[10px] text-mark-2">{r.signal_type}</span>
            ) },
            { key: 'hz', header: 'H', align: 'right', hideBelow: 'md', sort: (r: any) => num(r.horizon_days), cell: (r: any) => (
              <span className="tnum font-mono text-[10px] text-mark-4">{r.horizon_days}d</span>
            ) },
            { key: 'rg', header: 'Regime', hideBelow: 'lg', sort: (r: any) => r.market_regime, cell: (r: any) => (
              <span className="text-[10px] text-mark-4">{r.market_regime}</span>
            ) },
            { key: 'n', header: 'n', align: 'right', sort: (r: any) => num(r.total_occurrences), cell: (r: any) => (
              <span className="tnum font-mono text-[10px] text-mark-3">{n0(r.total_occurrences)}</span>
            ) },
            { key: 'wr', header: 'Win rate', align: 'right', sort: (r: any) => num(r.win_rate), cell: (r: any) => (
              <span className={cn('tnum font-mono font-semibold', (num(r.win_rate) ?? 0) >= 0.5 ? 'text-up' : (num(r.win_rate) ?? 0) < 0.35 ? 'text-down' : 'text-mark-2')}>
                {frac(r.win_rate)}
              </span>
            ) },
            { key: 'avg', header: 'Median', align: 'right', hideBelow: 'xl', sort: (r: any) => num(r.median_return_pct), cell: (r: any) => (
              <span className={cn('tnum font-mono', (num(r.median_return_pct) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
                {pct(r.median_return_pct)}
              </span>
            ) },
          ]}
          emptyLabel="No resolved signal-type statistics yet"
        />
      </Panel>

      <Panel dense eyebrow="CALIBRATION" title="Does a higher score actually pay?">
        <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
          Win rate bucketed by the score the platform published. If this is not monotonically increasing, the
          ranking is not carrying the information it appears to - the single most important thing to check
          before trusting any score on this desk.
        </p>
        <div className="space-y-2 p-3.5">
          {buckets.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-mark-4">No score-bucket statistics computed.</p>
          ) : (
            buckets.map((b) => {
              // getSignalWinRates returns winRate in PERCENT (9.2 = 9.2%), unlike
              // getPerformanceDashboard which returns a 0..1 fraction. Treating them
              // the same would render the real 9.2% as 920%, so normalise explicitly.
              const wrPct = num(b.winRate);
              const wr = wrPct === null ? null : wrPct / 100;
              return (
                <div key={b.bucket}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="font-mono text-[11px] text-mark-2">Score {b.bucket}</span>
                    <span className="tnum font-mono text-[11px]">
                      <span className={cn('font-semibold', (wr ?? 0) >= 0.5 ? 'text-up' : (wr ?? 0) < 0.35 ? 'text-down' : 'text-mark-2')}>
                        {frac(wr)}
                      </span>
                      <span className="ml-2 text-[10px] text-mark-4">
                        n={n0(b.total)} · avg {pct(b.avgReturn)}
                      </span>
                    </span>
                  </div>
                  <Meter
                    value={(wr ?? 0) * 100}
                    tone={(wr ?? 0) >= 0.5 ? 'bg-up/70' : (wr ?? 0) < 0.35 ? 'bg-down/60' : 'bg-marigold/60'}
                  />
                </div>
              );
            })
          )}
          {w.overall && (
            <div className="mt-3 grid grid-cols-3 gap-3 border-t border-line pt-3">
              <Stat label="Total" value={n0(w.overall.total)} size="sm" />
              <Stat label="Wins" value={n0(w.overall.wins)} size="sm" tone="text-up" />
              <Stat label="Losses" value={n0(w.overall.losses)} size="sm" tone="text-down" />
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** The model registry. AUC is shown but not dressed up: cross-validated ROC-AUC
 *  measures ranking skill on data the model has already seen, not future
 *  profitability, and an inactive model is labelled inactive rather than quietly
 *  counted anywhere else on the desk. */
function ModelRegistry() {
  const { data, isLoading } = trpc.getMLModelRegistry.useQuery(undefined, { staleTime: 30 * 60_000 });
  const rows: any[] = Array.isArray(data) ? data : [];

  return (
    <Panel dense eyebrow="MODELS" title="Model registry">
      <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
        Cross-validated ROC-AUC per model version. AUC measures how well a model ranks outcomes it has already
        seen; it is not a return forecast.
      </p>
      <DataTable
        rows={rows}
        getKey={(r: any) => r.model_name + '-' + r.model_version}
        isLoading={isLoading}
        dense
        maxHeight="320px"
        initialSort={{ key: 'auc', dir: 'desc' }}
        columns={[
          { key: 'name', header: 'Model', sort: (r: any) => r.model_name, cell: (r: any) => (
            <span className="flex items-center gap-1.5">
              <Brain size={11} className="text-mark-4" />
              <span className="font-mono text-[10px] text-mark-2">{r.model_name}</span>
            </span>
          ) },
          { key: 'ver', header: 'Version', hideBelow: 'md', sort: (r: any) => r.model_version, cell: (r: any) => (
            <span className="font-mono text-[10px] text-mark-4">{r.model_version}</span>
          ) },
          { key: 'type', header: 'Target', hideBelow: 'lg', sort: (r: any) => r.model_type, cell: (r: any) => (
            <span className="text-[10px] text-mark-3">{String(r.model_type ?? '').replace(/_/g, ' ')}</span>
          ) },
          { key: 'hz', header: 'H', align: 'right', hideBelow: 'xl', sort: (r: any) => num(r.horizon_days), cell: (r: any) => (
            <span className="tnum font-mono text-[10px] text-mark-4">{r.horizon_days ?? DASH}d</span>
          ) },
          { key: 'feat', header: 'Feat', align: 'right', hideBelow: 'xl', sort: (r: any) => num(r.feature_count), cell: (r: any) => (
            <span className="tnum font-mono text-[10px] text-mark-4">{n0(r.feature_count)}</span>
          ) },
          { key: 'auc', header: 'CV AUC', align: 'right', sort: (r: any) => num(r.cv_roc_auc), cell: (r: any) => {
            const auc = num(r.cv_roc_auc);
            return (
              <span className={cn('tnum font-mono font-semibold', (auc ?? 0) >= 0.6 ? 'text-up' : (auc ?? 0) >= 0.5 ? 'text-warn' : 'text-down')}>
                {auc?.toFixed(3) ?? DASH}
              </span>
            );
          } },
          { key: 'active', header: 'State', align: 'center', sort: (r: any) => num(r.is_active), cell: (r: any) => (
            <Chip tone={r.is_active ? 'up' : 'neutral'}>{r.is_active ? 'ACTIVE' : 'idle'}</Chip>
          ) },
          { key: 'trained', header: 'Trained', align: 'right', hideBelow: 'xl', sort: (r: any) => r.trained_at, cell: (r: any) => (
            <span className="font-mono text-[9px] text-mark-4">{ago(r.trained_at)}</span>
          ) },
        ]}
        emptyLabel="No models registered"
      />
    </Panel>
  );
}
