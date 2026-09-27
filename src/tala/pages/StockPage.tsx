import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { DASH, ago, frac, n0, num, parseJson, pct, price, prob, rupees } from '../lib/format';
import {
  buildTradePlan,
  classifyAction,
  convictionTone,
  coverageRead,
  engineBars,
  parseReasons,
  riskFlags,
  riskTone,
  type PickRow,
} from '../lib/insight';
import { Chip, ErrorState, Meter, Panel, ScoreRing, Stat, SymbolLink } from '../components/Primitives';
import { PriceChart, Sparkline } from '../components/Charts';
import { DataTable } from '../components/DataTable';

const RANGES = [
  { k: '1m', label: '1M' },
  { k: '3m', label: '3M' },
  { k: '6m', label: '6M' },
  { k: '1y', label: '1Y' },
] as const;

const TABS = [
  { k: 'setup', label: 'The setup' },
  { k: 'technicals', label: 'Technicals' },
  { k: 'fundamentals', label: 'Fundamentals' },
  { k: 'ownership', label: 'Ownership' },
  { k: 'derivatives', label: 'F&O' },
  { k: 'news', label: 'News' },
] as const;

type TabKey = (typeof TABS)[number]['k'];

/** Concall fields arrive as markdown bullet fragments ("- **Overall tone:** ...").
 *  Rendering raw asterisks in a terminal-dense table looks like a bug, so list and
 *  bold markers are stripped at the presentation edge. */
function stripMarkdown(v: unknown): string {
  return String(v ?? '')
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/\*\*/g, '')
    .trim();
}

/**
 * The single-stock desk.
 *
 * Built around one rule: the verdict comes first, the evidence second, and the
 * disqualifiers never hidden behind a tab. A trader deciding on this page should be
 * able to go from "strong buy" to "not for me" without navigating away, which is
 * why the risk blockers sit directly under the header rather than inside a panel.
 */
export default function StockPage() {
  const { symbol = '' } = useParams<{ symbol: string }>();
  const sym = decodeURIComponent(symbol).toUpperCase();
  const [range, setRange] = useState<string>('3m');
  const [tab, setTab] = useState<TabKey>('setup');

  const unified = trpc.getUnifiedScoreForSymbol.useQuery({ symbol: sym }, { staleTime: 120_000 });
  const quant = trpc.getQuantScore.useQuery({ symbol: sym }, { staleTime: 300_000 });
  const ohlc = trpc.getOHLCData.useQuery({ symbol: sym, dur: range }, { staleTime: 120_000 });
  const dl = trpc.getDLPredictions.useQuery({ symbols: [sym] }, { staleTime: 10 * 60_000 });

  const pick = (unified.data ?? null) as PickRow | null;
  const q: any = quant.data ?? null;
  const dlp: any = Array.isArray(dl.data) ? dl.data[0] ?? null : null;

  const series = useMemo(() => {
    const d: any = ohlc.data;
    const raw: any[] = d?.data ?? d ?? [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((b: any) => ({ date: new Date((b.time ?? b.date) * (b.time ? 1000 : 1)), close: num(b.close ?? b.c) }))
      .filter((b) => b.date.getTime() > 0 && b.close !== null) as { date: Date; close: number }[];
  }, [ohlc.data]);

  const spark = useMemo(() => series.map((b) => b.close), [series]);

  if (unified.isLoading && !unified.data) {
    return (
      <div className="tala-rise space-y-3 p-3">
        <div className="tala-live-dot h-40 rounded-lg border border-line bg-ink-850/50" />
        <div className="grid gap-3 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="tala-live-dot h-56 rounded-lg border border-line bg-ink-850/50" />
          ))}
        </div>
      </div>
    );
  }

  if (unified.error) {
    return (
      <div className="p-3">
        <ErrorState
          error={unified.error}
          onRetry={() => {
            void (unified.refetch() as Promise<unknown>).catch(() => {});
          }}
        />
      </div>
    );
  }

  const flags = pick ? riskFlags({ ...pick, ...q }) : [];
  const blockers = flags.filter((f) => f.level === 'blocker');

  return (
    <div className="tala-rise space-y-3 p-3">
      <Header
        sym={sym}
        name={q?.name}
        sector={q?.sector}
        pick={pick}
        q={q}
        spark={spark}
        blockers={blockers.length}
        range={range}
        onRange={setRange}
      />

      {blockers.length > 0 && (
        <div className="rounded-lg border border-down/30 bg-down/[0.05] px-3.5 py-3">
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert size={14} className="text-down" />
            <span className="text-[12px] font-semibold text-down-2">
              {blockers.length} reason{blockers.length > 1 ? 's' : ''} not to take this trade
            </span>
          </div>
          <ul className="space-y-1.5">
            {blockers.map((f) => (
              <li key={f.label} className={cn('rounded border px-2.5 py-1.5 text-[11px] leading-snug', riskTone(f.level))}>
                <span className="font-semibold">{f.label}.</span> {f.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={cn(
              'rounded border px-2.5 py-1 font-mono text-[10px] tracking-wide uppercase transition-colors',
              tab === t.k
                ? 'border-marigold/40 bg-marigold/10 text-marigold'
                : 'border-line-2 text-mark-3 hover:border-line-3 hover:text-mark-2',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'setup' && <SetupTab pick={pick} q={q} dlp={dlp} />}
      {tab === 'technicals' && <TechnicalsTab q={q} sym={sym} series={series} />}
      {tab === 'fundamentals' && <FundamentalsTab sym={sym} q={q} />}
      {tab === 'ownership' && <OwnershipTab sym={sym} />}
      {tab === 'derivatives' && <DerivativesTab sym={sym} />}
      {tab === 'news' && <NewsTab sym={sym} />}
    </div>
  );
}

function Header({
  sym,
  name,
  sector,
  pick,
  q,
  spark,
  blockers,
  range,
  onRange,
}: {
  sym: string;
  name?: string | null;
  sector?: string | null;
  pick: PickRow | null;
  q: any;
  spark: number[];
  blockers: number;
  range: string;
  onRange: (r: string) => void;
}) {
  const action = classifyAction(pick?.classification);
  const tone = convictionTone(pick?.conviction_level);
  const ltp = num(pick?.livePrice) ?? num(pick?.cmp);
  const chg = num(pick?.changePercent) ?? num(pick?.change_pct);

  return (
    <Panel dense>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-3.5">
        <ScoreRing value={num(pick?.unified_score)} size={76} label="UNIFIED" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SymbolLink symbol={sym} className="text-[20px]" />
            <span
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[10px] font-bold',
                action.tone === 'up'
                  ? 'bg-up/12 text-up'
                  : action.tone === 'down'
                    ? 'bg-down/12 text-down'
                    : 'bg-white/[0.06] text-mark-2',
              )}
            >
              {action.action}
            </span>
            {pick?.conviction_level && (
              <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ring-1', tone.bg, tone.text, tone.ring)}>
                {String(pick.conviction_level).replace('_', ' ')}
              </span>
            )}
            {blockers > 0 && <Chip tone="down">{blockers} BLOCKER{blockers > 1 ? 'S' : ''}</Chip>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mark-3">
            {name && <span className="truncate">{name}</span>}
            {sector && <span className="text-mark-4">{sector}</span>}
            {q?.analyst_rating && <span className="truncate">{q.analyst_rating}</span>}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <div className="text-[9px] tracking-[0.16em] text-mark-4 uppercase">LTP</div>
            <div className="tnum font-mono text-[24px] leading-none font-bold text-mark">{price(ltp)}</div>
            <div className={cn('tnum font-mono text-[11px]', (chg ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(chg)}</div>
          </div>
          {spark.length > 1 && <Sparkline data={spark} width={110} height={38} tone="auto" />}
          <div className="flex gap-0.5">
            {RANGES.map((r) => (
              <button
                key={r.k}
                onClick={() => onRange(r.k)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors',
                  range === r.k ? 'bg-marigold/15 text-marigold' : 'text-mark-4 hover:text-mark-2',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function SetupTab({ pick, q, dlp }: { pick: PickRow | null; q: any; dlp: any }) {
  const plan = pick ? buildTradePlan(pick) : null;
  const bars = pick ? engineBars(pick) : [];
  const cover = pick ? coverageRead(pick) : { n: 0, text: '-', tone: 'flat' as const };
  const reasons = parseReasons(pick?.trade_reasoning);
  const flags = pick ? riskFlags({ ...pick, ...q }) : [];

  if (!pick || !plan) {
    return (
      <Panel dense>
        <p className="px-3.5 py-10 text-center text-[12px] text-mark-3">
          This symbol has no row in the latest unified ranking.
        </p>
        <p className="px-3.5 pb-8 text-center text-[11px] leading-relaxed text-mark-4">
          The ranker publishes rows only for names it scored on the current run. A symbol missing here is
          unscored, not bearish - the technicals tab reads the feature table directly and is populated for a
          much wider set of stocks.
        </p>
      </Panel>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <Panel accent eyebrow="TRADE PLAN" title="Where to enter, where it is wrong">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Entry low" value={price(plan.entryLow)} size="lg" />
            <Stat label="Entry high" value={price(plan.entryHigh)} size="lg" />
            <Stat
              label="Stop loss"
              value={price(plan.stop)}
              size="lg"
              tone="text-down"
              sub={plan.stopPct !== null ? pct(plan.stopPct) : undefined}
            />
            <Stat
              label="Risk : reward"
              value={plan.riskReward === null ? DASH : plan.riskReward.toFixed(1) + ' : 1'}
              size="lg"
              tone={(plan.riskReward ?? 0) >= 2 ? 'text-up' : 'text-warn'}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3">
            {plan.targets.map((t) => (
              <Stat
                key={t.label}
                label={'Target ' + t.label}
                value={price(t.value)}
                size="lg"
                tone="text-up"
                sub={t.pctFromMid !== null ? pct(t.pctFromMid) + ' from entry' : undefined}
              />
            ))}
          </div>
          <p
            className={cn(
              'mt-3 rounded border px-2.5 py-2 text-[11px]',
              plan.inZone
                ? 'border-up/25 bg-up/[0.05] text-up'
                : plan.aboveZone
                  ? 'border-warn/25 bg-warn/[0.05] text-warn'
                  : 'border-line-2 bg-white/[0.02] text-mark-3',
            )}
          >
            {plan.zoneNote}
          </p>
        </Panel>

        <Panel
          eyebrow="ENGINES"
          title="What is scoring this"
          action={<Chip tone={cover.tone === 'up' ? 'up' : cover.tone === 'warn' ? 'warn' : 'neutral'}>{cover.text}</Chip>}
        >
          <div className="space-y-2">
            {bars
              .filter((b) => b.value !== null)
              .map((b) => (
                <div key={b.key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-[10px] tracking-[0.1em] text-mark-3 uppercase">{b.label}</span>
                  <div className="min-w-0 flex-1">
                    <Meter
                      value={b.value}
                      tone={b.lagging ? 'bg-warn/70' : (b.value ?? 0) >= 70 ? 'bg-up/75' : 'bg-marigold/60'}
                    />
                  </div>
                  <span className={cn('tnum w-8 shrink-0 text-right font-mono text-[11px]', b.lagging ? 'text-warn' : 'text-mark-2')}>
                    {(b.value as number).toFixed(0)}
                  </span>
                </div>
              ))}
          </div>
        </Panel>

        <Panel eyebrow="THESIS" title="Why the platform rates it this way">
          {reasons.prose && <p className="text-[12px] leading-relaxed text-mark-2">{reasons.prose}</p>}
          {reasons.tags.length > 0 && (
            <div className={cn('flex flex-wrap gap-1.5', reasons.prose && 'mt-2.5')}>
              {reasons.tags.map((t, i) => (
                <Chip
                  key={t.name + '-' + i}
                  tone={
                    t.sentiment === 'bullish' || t.sentiment === 'positive'
                      ? 'up'
                      : t.sentiment === 'bearish' || t.sentiment === 'negative'
                        ? 'down'
                        : 'neutral'
                  }
                >
                  <span className="opacity-60">{t.source}</span> {t.name.length > 46 ? t.name.slice(0, 45) + '...' : t.name}
                </Chip>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="space-y-3">
        <Panel eyebrow="MODEL" title="Deep-learning forecast">
          {!dlp ? (
            <p className="py-6 text-center text-[11px] text-mark-4">No model output for this symbol on the latest run.</p>
          ) : (
            <div className="space-y-2.5">
              {[1, 5, 15].map((h) => {
                const up = num(dlp['prob_up_' + h + 'd']);
                const dn = num(dlp['prob_dn_' + h + 'd']);
                const exp = num(dlp['exp_ret_' + h + 'd']);
                return (
                  <div key={h}>
                    <div className="mb-1 flex items-baseline justify-between">
                      <span className="font-mono text-[10px] tracking-[0.12em] text-mark-3 uppercase">{h}-day</span>
                      <span className="tnum font-mono text-[10px] text-mark-3">
                        exp <span className={cn((exp ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(exp)}</span>
                      </span>
                    </div>
                    <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.05]">
                      <div className="bg-up/70" style={{ width: (up ?? 0) * 100 + '%' }} />
                      <div className="bg-down/60" style={{ width: (dn ?? 0) * 100 + '%' }} />
                    </div>
                    <div className="mt-0.5 flex justify-between font-mono text-[9px] text-mark-4">
                      <span>up {prob(up)}</span>
                      <span>dn {prob(dn)}</span>
                    </div>
                  </div>
                );
              })}
              <div className="grid grid-cols-2 gap-2 border-t border-line pt-2.5">
                <Stat label="Confidence" value={frac(dlp.confidence)} size="sm" />
                <Stat label="Uncertainty" value={frac(dlp.uncertainty)} size="sm" />
              </div>
              <p className="text-[9px] leading-relaxed text-mark-4">
                {dlp.model_name} v{dlp.model_version} · {dlp.regime} regime. Probabilities are the model's
                own output, not a calibrated forecast.
              </p>
            </div>
          )}
        </Panel>

        <Panel eyebrow="RISK" title="What to watch">
          {flags.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-mark-4">No risk flags raised from the available data.</p>
          ) : (
            <ul className="space-y-1.5">
              {flags.map((f) => (
                <li key={f.label} className={cn('rounded border px-2 py-1.5 text-[10px] leading-snug', riskTone(f.level))}>
                  <span className="font-semibold">{f.label}.</span> {f.detail}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel eyebrow="POSITION" title="Sizing context">
          <div className="space-y-2.5">
            <Stat
              label="Win probability"
              value={prob(pick.win_probability)}
              size="lg"
              tone={(num(pick.win_probability) ?? 0) > 0.55 ? 'text-up' : 'text-warn'}
            />
            <Stat label="Realised vol (20d)" value={num(pick.hv_20d) === null ? DASH : pct(pick.hv_20d, 1)} size="md" />
            <Stat label="Beta (1y)" value={num(q?.beta_1y)?.toFixed(2) ?? DASH} size="md" />
            <Stat
              label="Max drawdown (1y)"
              value={num(q?.max_drawdown_1y) === null ? DASH : pct(q.max_drawdown_1y)}
              size="md"
              tone="text-down"
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** Technicals. Reads the quant_scores row, which is populated for a far wider set
 *  of symbols than the unified ranker - so this tab is the fallback for any stock
 *  the ranker has not scored. */
function TechnicalsTab({ q, sym, series }: { q: any; sym: string; series: { date: Date; close: number }[] }) {
  const { data: tsig } = trpc.getUnifiedScoreForSymbol.useQuery({ symbol: sym }, { staleTime: 120_000 });
  const t: any = tsig ?? {};
  const s = (v: unknown) => (num(v) === null ? DASH : num(v)!.toFixed(1));

  const features = useMemo(
    () => Object.entries(t).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object'),
    [t],
  );

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Panel eyebrow="PRICE" title="Price history" className="lg:col-span-2">
        {series.length > 1 ? (
          <PriceChart
            data={series.map((b) => ({
              date: b.date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
              close: b.close,
            }))}
            height={260}
          />
        ) : (
          <p className="py-12 text-center text-[11px] text-mark-4">No price history available for this window.</p>
        )}
      </Panel>

      <div className="space-y-3">
        <Panel eyebrow="MOMENTUM" title="Returns and trend">
          <div className="space-y-2.5">
            {([['1 week', q?.return_1w], ['1 month', q?.return_1m], ['3 months', q?.return_3m], ['6 months', q?.return_6m], ['12 months', q?.return_12m]] as const).map(([label, v]) => (
              <div key={label} className="flex items-baseline justify-between">
                <span className="text-[11px] text-mark-3">{label}</span>
                <span className={cn('tnum font-mono text-[12px]', (num(v) ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(v)}</span>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-line pt-2.5">
              <span className="text-[11px] text-mark-3">vs 200-DMA</span>
              <span className={cn('tnum font-mono text-[12px]', (num(q?.sma200_distance_pct) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
                {pct(q?.sma200_distance_pct)}
                {q?.above_sma200 === 1 && <span className="ml-1.5 text-[9px] text-up">ABOVE</span>}
              </span>
            </div>
          </div>
        </Panel>

        <Panel eyebrow="RISK" title="Volatility">
          <div className="space-y-2.5">
            <Stat label="Annualised vol" value={num(q?.annualized_vol) === null ? DASH : pct(q.annualized_vol, 1)} size="md" />
            <Stat label="Sharpe" value={s(q?.sharpe_ratio)} size="md" tone={(num(q?.sharpe_ratio) ?? 0) >= 1 ? 'text-up' : 'text-warn'} />
            <Stat label="Sortino" value={s(q?.sortino_ratio)} size="md" />
            <Stat label="Max drawdown 1y" value={num(q?.max_drawdown_1y) === null ? DASH : pct(q.max_drawdown_1y)} size="md" tone="text-down" />
            <Stat label="Value at risk 95%" value={num(q?.var_95) === null ? DASH : pct(q.var_95)} size="md" tone="text-down" />
            <Stat label="Vol rank" value={s(q?.vol_rank)} size="md" sub="0 = calmest in universe" />
          </div>
        </Panel>
      </div>

      <div className="space-y-3 lg:col-span-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Panel dense><Stat label="Momentum" value={s(q?.momentum_score)} size="lg" tone={(num(q?.momentum_score) ?? 0) >= 50 ? 'text-up' : 'text-down'} /></Panel>
          <Panel dense><Stat label="Quality" value={s(q?.mf_quality_score)} size="lg" /></Panel>
          <Panel dense><Stat label="Value" value={s(q?.mf_value_score)} size="lg" /></Panel>
          <Panel dense><Stat label="Risk-adj" value={s(q?.mf_risk_adj_score)} size="lg" /></Panel>
          <Panel dense><Stat label="Macro" value={s(q?.mf_macro_score)} size="lg" /></Panel>
          <Panel dense><Stat label="Piotroski F" value={num(q?.piotroski_f_score) === null ? DASH : String(q.piotroski_f_score)} size="lg" tone={(num(q?.piotroski_f_score) ?? 0) >= 7 ? 'text-up' : 'text-warn'} /></Panel>
        </div>

        <Panel dense eyebrow="SIGNALS" title="Latest feature snapshot">
          <DataTable
            rows={features}
            getKey={(r: [string, unknown], i: number) => r[0] + '-' + i}
            dense
            maxHeight="280px"
            columns={[
              { key: 'k', header: 'Feature', cell: (r: [string, unknown]) => (
                <span className="font-mono text-[10px] text-mark-3">{String(r[0]).replace(/_/g, ' ')}</span>
              ) },
              { key: 'v', header: 'Value', align: 'right', cell: (r: [string, unknown]) => {
                const n = num(r[1]);
                if (n === null) return <span className="tnum font-mono text-[11px] text-mark-2">{String(r[1])}</span>;
                return <span className="tnum font-mono text-[11px] text-mark">{Math.abs(n) > 1000 ? n0(n, 0) : n.toFixed(2)}</span>;
              } },
            ]}
            emptyLabel="No feature snapshot for this symbol"
          />
        </Panel>
      </div>
    </div>
  );
}

function FundamentalsTab({ sym, q }: { sym: string; q: any }) {
  const { data: ratios } = trpc.getRatios.useQuery({ symbol: sym }, { staleTime: 10 * 60_000, retry: false });
  const { data: corp } = trpc.getCorporateActionsCalendar.useQuery(
    { daysBack: 0, daysForward: 90 },
    { staleTime: 3600_000 },
  );
  const actions: any[] = Array.isArray(corp) ? corp : [];

  const kpis: [string, unknown, string][] = [
    ['Market cap', q?.market_cap, 'rupees'],
    ['Trailing P/E', q?.trailing_pe, 'x'],
    ['Forward P/E', q?.forward_pe, 'x'],
    ['ROE', q?.return_on_equity, 'pct'],
    ['Operating margin', q?.operating_margins, 'pct'],
    ['Revenue growth', q?.revenue_growth, 'pct'],
    ['Debt / equity', q?.debt_to_equity, 'x'],
    ['Dividend yield', q?.dividend_yield, 'pct'],
    ['EPS (TTM)', q?.eps_ttm, 'x'],
    ['52W high', q?.fifty_two_week_high, 'price'],
    ['52W low', q?.fifty_two_week_low, 'price'],
  ];

  const ratioEntries = useMemo(
    () =>
      ratios && !Array.isArray(ratios)
        ? Object.entries(ratios as Record<string, unknown>).filter(([, v]) => num(v) !== null).slice(0, 26)
        : [],
    [ratios],
  );

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Panel dense eyebrow="VALUATION" title="Key ratios">
          <DataTable
            rows={kpis}
            getKey={(r: [string, unknown, string]) => r[0]}
            dense
            columns={[
              { key: 'k', header: 'Metric', cell: (r: [string, unknown, string]) => (
                <span className="text-[12px] text-mark-2">{r[0]}</span>
              ) },
              { key: 'v', header: 'Value', align: 'right', cell: (r: [string, unknown, string]) => {
                const n = num(r[1]);
                if (n === null) return <span className="tnum font-mono text-[11px] text-mark-4">{DASH}</span>;
                if (r[2] === 'rupees') return <span className="tnum font-mono text-[11px] text-mark">{rupees(n)}</span>;
                if (r[2] === 'pct') return <span className="tnum font-mono text-[11px] text-mark">{pct(n)}</span>;
                if (r[2] === 'price') return <span className="tnum font-mono text-[11px] text-mark">{price(n)}</span>;
                return <span className="tnum font-mono text-[11px] text-mark">{n0(n, 2)}</span>;
              } },
            ]}
            emptyLabel="No fundamental data for this symbol"
          />
        </Panel>

        <Panel dense eyebrow="CORPORATE" title="Corporate actions - next 90 days" className="mt-3">
          <DataTable
            rows={actions.filter((a) => String(a.symbol).toUpperCase() === sym)}
            getKey={(r: any, i: number) => r.symbol + '-' + r.ex_date + '-' + i}
            dense
            maxHeight="220px"
            columns={[
              { key: 'ex', header: 'Ex-date', sort: (r: any) => r.ex_date, cell: (r: any) => (
                <span className="tnum font-mono text-[11px] text-mark-2">{r.ex_date}</span>
              ) },
              { key: 'type', header: 'Type', sort: (r: any) => r.action_type, cell: (r: any) => (
                <Chip tone="info">{r.action_type}</Chip>
              ) },
              { key: 'amt', header: 'Amount', align: 'right', sort: (r: any) => num(r.amount), cell: (r: any) => (
                <span className="tnum font-mono text-[11px] text-mark">{num(r.amount) === null ? DASH : rupees(r.amount)}</span>
              ) },
              { key: 'ratio', header: 'Ratio', hideBelow: 'md', cell: (r: any) => (
                <span className="font-mono text-[10px] text-mark-3">{r.ratio ?? DASH}</span>
              ) },
            ]}
            emptyLabel="No corporate actions scheduled for this stock"
          />
        </Panel>
      </div>

      <Panel eyebrow="PROVIDER" title="Vendor ratio set">
        {ratioEntries.length === 0 ? (
          <p className="py-6 text-center text-[11px] leading-relaxed text-mark-4">
            No provider ratio set for this symbol - the vendor mapping may not cover it.
          </p>
        ) : (
          <div className="space-y-1.5">
            {ratioEntries.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[10px] text-mark-3">{k.replace(/_/g, ' ')}</span>
                <span className="tnum shrink-0 font-mono text-[11px] text-mark-2">{num(v)!.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Ownership: who actually owns this, and whether that is changing. The smart-money
 *  table is universe-wide (it ranks accumulation across the whole market), so it is
 *  labelled a peer view rather than presented as this stock's own flow. */
function OwnershipTab({ sym }: { sym: string }) {
  const { data: share } = trpc.getShareholding.useQuery({ symbol: sym }, { staleTime: 6 * 3600_000 });
  // The smart-money table is universe-wide by design (it ranks accumulation across
  // every tracked stock), which is why the panel is labelled a peer view rather
  // than this stock's own flow.
  const { data: smart } = trpc.getSmartMoneyFlow.useQuery({ direction: 'accumulation' }, { staleTime: 6 * 3600_000 });
  const { data: insiders } = trpc.getInsiderTransactions.useQuery({ limit: 40 }, { staleTime: 6 * 3600_000 });
  const { data: blocks } = trpc.getBlockDeals.useQuery({ limit: 100 }, { staleTime: 6 * 3600_000 });

  const s: any = share ?? {};
  const smartRows: any[] = Array.isArray(smart) ? smart : [];
  const insiderRows: any[] = (Array.isArray(insiders) ? insiders : []).filter(
    (r: any) => String(r.symbol).toUpperCase() === sym,
  );
  const blockRows: any[] = (Array.isArray(blocks) ? blocks : []).filter(
    (r: any) => String(r.symbol).toUpperCase() === sym,
  );

  const holders: [string, unknown][] = [
    ['Promoter', s.promoter_pct],
    ['FII / FPI', s.fii_pct],
    ['Mutual funds', s.mf_pct],
    ['Pledged', s.pledge_pct],
  ];
  const deltas: [string, unknown][] = [
    ['Promoter d QoQ', s.promoter_chg_qoq],
    ['FII d QoQ', s.fii_chg_qoq],
    ['MF d QoQ', s.mf_chg_qoq],
    ['Pledge d QoQ', s.pledge_chg_qoq],
  ];

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className="space-y-3">
        <Panel eyebrow="HOLDING" title="Shareholding pattern">
          <div className="grid grid-cols-2 gap-3">
            {holders.map(([label, v]) => (
              <div key={label} className="min-w-0">
                <Stat
                  label={label}
                  value={num(v) === null ? DASH : frac(v)}
                  size="lg"
                  tone={label === 'Pledged' && (num(v) ?? 0) > 10 ? 'text-down' : 'text-mark'}
                />
                <Meter value={num(v)} height="h-1" tone={label === 'Pledged' ? 'bg-down/60' : 'bg-marigold/60'} />
              </div>
            ))}
          </div>
        </Panel>

        <Panel eyebrow="MOMENTUM" title="Quarter-on-quarter change">
          <div className="grid grid-cols-2 gap-3">
            {deltas.map(([label, v]) => (
              <Stat
                key={label}
                label={label}
                value={num(v) === null ? DASH : pct(num(v)!, 2)}
                size="md"
                tone={(num(v) ?? 0) > 0 ? 'text-up' : (num(v) ?? 0) < 0 ? 'text-down' : 'text-mark-3'}
              />
            ))}
          </div>
          {(num(s.pledge_chg_qoq) ?? 0) > 0 && (
            <p className="mt-3 rounded border border-down/25 bg-down/[0.05] px-2 py-1.5 text-[10px] text-down-2">
              Promoter pledge is rising - a governance overhang most scorecards under-weight.
            </p>
          )}
        </Panel>
      </div>

      <Panel dense eyebrow="SMART MONEY" title="Accumulation across the universe" action={<Chip tone="neutral">peer view</Chip>}>
        <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
          Ranked by promoter + FII + DII net flow across the whole market, not this stock alone - useful for
          seeing which names smart money is accumulating into this week.
        </p>
        <DataTable
          rows={smartRows}
          getKey={(r: any) => r.symbol}
          dense
          maxHeight="300px"
          initialSort={{ key: 'net', dir: 'desc' }}
          emptyLabel="No smart-money flow snapshot"
          columns={[
            { key: 'symbol', header: 'Symbol', sort: (r: any) => r.symbol, cell: (r: any) => <SymbolLink symbol={r.symbol} /> },
            { key: 'prom', header: 'Prom', align: 'right' as const, hideBelow: 'md' as const, sort: (r: any) => num(r.promoter), cell: (r: any) => (
              <span className={cn('tnum font-mono', (num(r.promoter) ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(r.promoter, 1)}</span>
            ) },
            { key: 'fii', header: 'FII', align: 'right' as const, sort: (r: any) => num(r.fii), cell: (r: any) => (
              <span className={cn('tnum font-mono', (num(r.fii) ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(r.fii, 1)}</span>
            ) },
            { key: 'dii', header: 'DII', align: 'right' as const, hideBelow: 'lg' as const, sort: (r: any) => num(r.dii), cell: (r: any) => (
              <span className={cn('tnum font-mono', (num(r.dii) ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(r.dii, 1)}</span>
            ) },
            { key: 'net', header: 'Net', align: 'right' as const, sort: (r: any) => num(r.netFlow), cell: (r: any) => (
              <span className={cn('tnum font-mono font-semibold', (num(r.netFlow) ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(r.netFlow, 1)}</span>
            ) },
            { key: 'st', header: 'Bias', hideBelow: 'xl' as const, cell: (r: any) => (
              <Chip tone={r.status === 'accumulation' ? 'up' : r.status === 'distribution' ? 'down' : 'neutral'}>{r.status}</Chip>
            ) },
          ]}
        />
      </Panel>

      <div className="space-y-3">
        <Panel dense eyebrow="INSIDER" title="Promoter and director transactions">
          <DataTable
            rows={insiderRows}
            getKey={(r: any, i: number) => r.symbol + '-' + r.transaction_date + '-' + i}
            dense
            maxHeight="220px"
            emptyLabel="No insider transactions recorded for this stock"
            columns={[
              { key: 'date', header: 'Date', sort: (r: any) => r.transaction_date, cell: (r: any) => (
                <span className="tnum font-mono text-[10px] text-mark-3">{r.transaction_date}</span>
              ) },
              { key: 'who', header: 'Person', hideBelow: 'md', cell: (r: any) => (
                <span className="block max-w-[180px] truncate text-[11px] text-mark-2">{r.person_name}</span>
              ) },
              { key: 'qty', header: 'Qty', align: 'right', sort: (r: any) => num(r.quantity), cell: (r: any) => (
                <span className="tnum font-mono text-[11px]">{n0(r.quantity)}</span>
              ) },
              { key: 'val', header: 'Value', align: 'right', sort: (r: any) => num(r.value_cr), cell: (r: any) => (
                <span className="tnum font-mono text-[11px]">{rupees(num(r.value_cr) === null ? null : num(r.value_cr)! * 1e7)}</span>
              ) },
            ]}
          />
        </Panel>

        <Panel dense eyebrow="BLOCK" title="Bulk and block deals">
          <DataTable
            rows={blockRows}
            getKey={(r: any, i: number) => r.symbol + '-' + r.date + '-' + i}
            dense
            maxHeight="200px"
            emptyLabel="No block deals for this stock"
            columns={[
              { key: 'date', header: 'Date', sort: (r: any) => r.date, cell: (r: any) => (
                <span className="tnum font-mono text-[10px] text-mark-3">{r.date}</span>
              ) },
              { key: 'qty', header: 'Qty', align: 'right', sort: (r: any) => num(r.qty), cell: (r: any) => (
                <span className="tnum font-mono text-[11px]">{n0(r.qty)}</span>
              ) },
              { key: 'price', header: 'Price', align: 'right', sort: (r: any) => num(r.price), cell: (r: any) => (
                <span className="tnum font-mono text-[11px]">{price(r.price)}</span>
              ) },
              { key: 'val', header: 'Value', align: 'right', sort: (r: any) => num(r.value_cr), cell: (r: any) => (
                <span className="tnum font-mono text-[11px] text-mark-2">
                  {num(r.value_cr) === null ? DASH : 'Rs ' + num(r.value_cr)!.toFixed(0) + ' Cr'}
                </span>
              ) },
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}

function DerivativesTab({ sym }: { sym: string }) {
  const { data: fno } = trpc.getFnOSignals.useQuery({ symbol: sym }, { staleTime: 120_000, retry: false });
  const { data: chain } = trpc.getStockFno.useQuery({ symbol: sym }, { staleTime: 120_000, retry: false });
  const f: any = fno ?? {};
  const ms: any = f.marketSentiment ?? {};
  const signals: any[] = Array.isArray(f.signals) ? f.signals : [];

  if (f.success === false) {
    return (
      <Panel dense>
        <p className="px-3.5 py-10 text-center text-[12px] text-mark-3">{sym} is not in the F&amp;O segment.</p>
        <p className="px-3.5 pb-8 text-center text-[11px] leading-relaxed text-mark-4">
          {String(f.error ?? 'No option chain is published for this symbol.')}
        </p>
      </Panel>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Panel eyebrow="POSITIONING" title="Derivatives sentiment">
        <div className="grid grid-cols-2 gap-3">
          <Stat
            label="Put-call ratio"
            value={num(ms.pcr) === null ? DASH : num(ms.pcr)!.toFixed(2)}
            size="lg"
            tone={(num(ms.pcr) ?? 1) > 1.1 ? 'text-up' : 'text-down'}
          />
          <Stat label="Max pain" value={price(ms.maxPain)} size="lg" />
          <Stat label="IV rank" value={num(ms.ivRank) === null ? DASH : num(ms.ivRank)!.toFixed(0)} size="md" />
          <Stat label="IV percentile" value={num(ms.ivPercentile) === null ? DASH : num(ms.ivPercentile)!.toFixed(0)} size="md" />
        </div>
        {ms.oiTrend && (
          <p className="mt-3 border-t border-line pt-3 text-[11px] text-mark-3">
            <span className="text-mark-4">OI trend: </span>
            {String(ms.oiTrend)}
          </p>
        )}
      </Panel>

      <Panel dense eyebrow="SIGNALS" title="F&amp;O signals" className="lg:col-span-2">
        <DataTable
          rows={signals}
          getKey={(r: any, i: number) => (r.type ?? r.signal ?? 'sig') + '-' + i}
          dense
          maxHeight="320px"
          emptyLabel="No derivatives signals for this symbol"
          columns={[
            { key: 't', header: 'Signal', sort: (r: any) => r.type ?? r.signal, cell: (r: any) => (
              <span className="font-mono text-[11px] text-mark-2">{r.type ?? r.signal ?? DASH}</span>
            ) },
            { key: 's', header: 'Strength', sort: (r: any) => r.strength, cell: (r: any) => (
              <Chip tone={r.strength === 'HIGH' ? 'up' : r.strength === 'WATCH' ? 'warn' : 'neutral'}>
                {r.strength ?? DASH}
              </Chip>
            ) },
            { key: 'd', header: 'Detail', cell: (r: any) => (
              <span className="block max-w-[420px] truncate text-[10px] text-mark-3" title={r.detail}>{r.detail ?? DASH}</span>
            ) },
          ]}
        />
      </Panel>

      <Panel dense eyebrow="CHAIN" title="Option chain" className="lg:col-span-3">
        <OptionChainView data={chain} />
      </Panel>
    </div>
  );
}

function OptionChainView({ data }: { data: any }) {
  const rows: any[] = useMemo(() => {
    const d: any = data;
    const list = d?.data?.data ?? d?.data?.chain ?? d?.data ?? d?.chain ?? null;
    if (!Array.isArray(list)) return [];
    return list
      .map((r: any) => ({
        strike: num(r.strikePrice ?? r.strike),
        callOi: num(r.callOI ?? r.call?.oi),
        putOi: num(r.putOI ?? r.put?.oi),
        callChg: num(r.callChangeinOpenInterest ?? r.call?.chgOi),
        putChg: num(r.putChangeinOpenInterest ?? r.put?.chgOi),
        iv: num(r.impliedVolatility ?? r.iv),
      }))
      .filter((r: any) => r.strike !== null)
      .sort((a: any, b: any) => (a.strike as number) - (b.strike as number));
  }, [data]);

  if (rows.length === 0) {
    return <p className="px-3.5 py-8 text-center text-[11px] text-mark-4">No option chain published for this symbol today.</p>;
  }

  const maxOi = Math.max(1, ...rows.flatMap((r: any) => [r.callOi ?? 0, r.putOi ?? 0]));

  return (
    <DataTable
      rows={rows}
      getKey={(r: any) => String(r.strike)}
      dense
      maxHeight="380px"
      columns={[
        { key: 'coi', header: 'Call OI', align: 'right' as const, sort: (r: any) => r.callOi, cell: (r: any) => (
          <div className="flex items-center justify-end gap-2">
            <div className="w-14"><Meter value={r.callOi} max={maxOi} height="h-1" tone="bg-up/50" /></div>
            <span className="tnum w-12 font-mono text-[10px] text-up">{n0(r.callOi)}</span>
          </div>
        ) },
        { key: 'cchg', header: 'Call dOI', align: 'right' as const, hideBelow: 'md' as const, sort: (r: any) => r.callChg, cell: (r: any) => (
          <span className={cn('tnum font-mono text-[10px]', (r.callChg ?? 0) >= 0 ? 'text-up' : 'text-down')}>{n0(r.callChg)}</span>
        ) },
        { key: 'strike', header: 'Strike', align: 'center' as const, sort: (r: any) => r.strike, cell: (r: any) => (
          <span className="tnum font-mono text-[12px] font-semibold text-mark">{price(r.strike)}</span>
        ) },
        { key: 'pchg', header: 'Put dOI', align: 'right' as const, hideBelow: 'md' as const, sort: (r: any) => r.putChg, cell: (r: any) => (
          <span className={cn('tnum font-mono text-[10px]', (r.putChg ?? 0) >= 0 ? 'text-down' : 'text-up')}>{n0(r.putChg)}</span>
        ) },
        { key: 'poi', header: 'Put OI', align: 'right' as const, sort: (r: any) => r.putOi, cell: (r: any) => (
          <div className="flex items-center gap-2">
            <span className="tnum w-12 font-mono text-[10px] text-down">{n0(r.putOi)}</span>
            <div className="w-14"><Meter value={r.putOi} max={maxOi} height="h-1" tone="bg-down/50" /></div>
          </div>
        ) },
        { key: 'iv', header: 'IV', align: 'right' as const, hideBelow: 'lg' as const, sort: (r: any) => r.iv, cell: (r: any) => (
          <span className="tnum font-mono text-[10px] text-mark-3">{r.iv === null ? DASH : r.iv.toFixed(1) + '%'}</span>
        ) },
      ]}
    />
  );
}

function NewsTab({ sym }: { sym: string }) {
  const { data } = trpc.getNewsItems.useQuery(
    { limit: 100, category: 'ALL', sentiment: 'ALL', sourceType: 'ALL', hours: 168 },
    { staleTime: 5 * 60_000 },
  );
  const { data: concall } = trpc.getConcallTakeaways.useQuery({ limit: 40 }, { staleTime: 6 * 3600_000 });

  const rows: any[] = useMemo(() => {
    const list: any[] = Array.isArray(data) ? data : [];
    return list.filter((n) => {
      const syms: string[] = parseJson<string[]>(n.symbols_json, []);
      return syms.some((x) => String(x).toUpperCase() === sym);
    });
  }, [data]);

  const calls: any[] = useMemo(() => {
    const list: any[] = Array.isArray(concall) ? concall : [];
    return list.filter((c) => String(c.symbol).toUpperCase() === sym);
  }, [concall]);

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Panel dense eyebrow="WIRE" title={'News mentioning ' + sym} className="lg:col-span-2">
        {rows.length === 0 ? (
          <p className="px-3.5 py-10 text-center text-[11px] leading-relaxed text-mark-4">
            No articles mapped to {sym} in the last 7 days. The mapper only tags a story when the symbol is
            extracted from the text, so a genuine event with no symbol reference will not appear here.
          </p>
        ) : (
          <ul className="tala-scroll max-h-[520px] overflow-y-auto">
            {rows.map((n, i) => (
              <li key={n.id ?? i} className="border-b border-line/50 px-3.5 py-2.5 last:border-0">
                <a href={n.url} target="_blank" rel="noreferrer noopener" className="group block">
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        'mt-1 h-3.5 w-0.5 shrink-0 rounded-full',
                        n.sentiment === 'BULLISH' ? 'bg-up' : n.sentiment === 'BEARISH' ? 'bg-down' : 'bg-line-3',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] leading-snug text-mark-2 group-hover:text-mark">{n.title}</p>
                      {n.summary && (
                        <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-mark-4">{n.summary}</p>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 text-[9px] text-mark-4">
                        <span className="font-mono">{ago(n.published_at)}</span>
                        <span>{n.source}</span>
                        {n.impact === 'HIGH' && <Chip tone="warn">HIGH</Chip>}
                      </div>
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel dense eyebrow="CALL" title="Concall takeaways">
        {calls.length === 0 ? (
          <p className="px-3.5 py-10 text-center text-[11px] text-mark-4">
            No recent concall transcript summaries for {sym}.
          </p>
        ) : (
          <ul className="tala-scroll max-h-[520px] overflow-y-auto">
            {calls.map((c, i) => (
              <li key={i} className="border-b border-line/50 px-3.5 py-2.5 last:border-0">
                <div className="mb-1 flex items-center gap-2">
                  <Chip tone="info">{c.quarter + ' ' + c.fiscal_year}</Chip>
                  <span className="font-mono text-[9px] text-mark-4">{c.announcement_date}</span>
                </div>
                <p className="line-clamp-2 text-[11px] leading-snug text-mark-2">{stripMarkdown(c.key_takeaway)}</p>
                <p className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-mark-4">{stripMarkdown(c.tone_assessment)}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
