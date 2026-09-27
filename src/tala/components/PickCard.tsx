import { useNavigate } from 'react-router-dom';
import { ShieldAlert, Target, TrendingUp } from 'lucide-react';
import { cn } from '../lib/utils';
import { DASH, num, pct, price, prob } from '../lib/format';
import {
  buildTradePlan,
  classifyAction,
  convictionTone,
  engineBars,
  coverageRead,
  parseReasons,
  riskFlags,
  riskTone,
  type PickRow,
} from '../lib/insight';
import { Chip, Meter, ScoreRing, SymbolLink } from './Primitives';

/**
 * A single actionable idea, rendered as a card rather than a table row.
 *
 * This is the component the whole desk is built around, so it carries the full
 * decision payload in one block: what the engines think, where to enter, where
 * it is invalid, and what would make you not take it. A trader should be able
 * to read one card top-to-bottom and either act or consciously skip.
 */
export function PickCard({ pick, index = 0 }: { pick: PickRow; index?: number }) {
  const navigate = useNavigate();
  const tone = convictionTone(pick.conviction_level);
  const action = classifyAction(pick.classification);
  const plan = buildTradePlan(pick);
  const bars = engineBars(pick);
  const cover = coverageRead(pick);
  const flags = riskFlags(pick);
  const blockers = flags.filter((f) => f.level === 'blocker');
  const reasons = parseReasons(pick.trade_reasoning);
  const live = num(pick.livePrice) ?? num(pick.cmp);

  return (
    <article
      onClick={() => navigate(`/tala/stock/${encodeURIComponent(pick.symbol)}`)}
      className={cn(
        'tala-rise group relative cursor-pointer rounded-lg border border-line bg-ink-850/70 p-3.5',
        'transition-colors hover:border-line-3 hover:bg-ink-800/70',
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      <div className="flex items-start gap-3">
        <ScoreRing value={num(pick.unified_score)} size={58} label="SCORE" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <SymbolLink symbol={pick.symbol} className="text-[14px]" />
            <span
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide',
                action.tone === 'up' ? 'bg-up/12 text-up' : action.tone === 'down' ? 'bg-down/12 text-down' : 'bg-white/[0.06] text-mark-2',
              )}
            >
              {action.action}
            </span>
            <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ring-1', tone.bg, tone.text, tone.ring)}>
              {String(pick.conviction_level ?? '—').replace('_', ' ')}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mark-3">
            <span className="tnum font-mono">
              <span className="text-mark-2">LTP </span>
              <span className="text-mark">{price(live)}</span>
            </span>
            <span className={cn('tnum font-mono', (num(pick.changePercent) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
              {pct(pick.changePercent)}
            </span>
            {pick.sector && <span className="truncate">{pick.sector}</span>}
            {pick.timeframe && <span className="font-mono text-[10px] tracking-wide">{pick.timeframe}</span>}
          </div>
        </div>
      </div>


      {/* Engine decomposition — the parts behind the headline score. */}
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
        {bars
          .filter((b) => b.value !== null)
          .map((b) => (
            <div key={b.key} className="min-w-0">
              <div className="flex items-baseline justify-between gap-1">
                <span className="truncate text-[9px] tracking-[0.12em] text-mark-4 uppercase">{b.label}</span>
                <span className={cn('tnum font-mono text-[10px]', b.lagging ? 'text-warn' : 'text-mark-2')}>
                  {b.value!.toFixed(0)}
                </span>
              </div>
              <Meter
                value={b.value}
                tone={b.lagging ? 'bg-warn/70' : b.value! >= 70 ? 'bg-up/75' : 'bg-marigold/60'}
                height="h-1"
              />
            </div>
          ))}
      </div>

      {/* Trade plan */}
      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-line pt-2.5">
        <Cell
          label="Entry"
          value={plan.entryLow === null ? DASH : `${price(plan.entryLow, 1)}–${price(plan.entryHigh, 1)}`}
        />
        <Cell label="T1" value={price(plan.targets[0]?.value, 1)} tone="text-up" />
        <Cell label="T2" value={price(plan.targets[1]?.value, 1)} tone="text-up" />
        <Cell label="Stop" value={price(plan.stop, 1)} tone="text-down" />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={cn('truncate text-[10px]', plan.inZone ? 'text-up' : plan.aboveZone ? 'text-warn' : 'text-mark-4')}>
          {plan.zoneNote}
        </span>
        <span className="tnum shrink-0 font-mono text-[10px] text-mark-2">
          R:R{' '}
          <span className={num(plan.riskReward) !== null && plan.riskReward! >= 2 ? 'text-up' : 'text-mark-3'}>
            {plan.riskReward === null ? DASH : `${plan.riskReward.toFixed(1)}:1`}
          </span>
        </span>
      </div>

      {/* Probability + coverage — the two honest caveats. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {num(pick.win_probability) !== null && (
          <Chip tone={pick.win_probability! > 0.55 ? 'up' : 'warn'}>
            <TrendingUp size={9} /> {prob(pick.win_probability)} win-prob
          </Chip>
        )}
        <Chip tone={cover.tone === 'up' ? 'up' : cover.tone === 'warn' ? 'warn' : 'neutral'}>{cover.text}</Chip>
        {num(pick.rsi) !== null && (
          <Chip tone={pick.rsi! >= 70 || pick.rsi! <= 30 ? 'warn' : 'neutral'}>RSI {pick.rsi!.toFixed(0)}</Chip>
        )}
        {blockers.length > 0 && (
          <Chip tone="down">
            <ShieldAlert size={9} /> {blockers.length} blocker{blockers.length > 1 ? 's' : ''}
          </Chip>
        )}
      </div>

      {/* Blocker detail is inline rather than behind a hover: a risk the reader has
          to discover by hovering is a risk they will act without. */}
      {blockers.length > 0 && (
        <ul className="mt-2 space-y-1">
          {blockers.map((f) => (
            <li key={f.label} className={cn('rounded border px-2 py-1 text-[10px] leading-snug', riskTone(f.level))}>
              <span className="font-semibold">{f.label}.</span> {f.detail}
            </li>
          ))}
        </ul>
      )}

      {reasons.tags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {reasons.tags.slice(0, 5).map((t, i) => (
            <Chip
              key={`${t.name}-${i}`}
              tone={
                t.sentiment === 'bullish' || t.sentiment === 'positive'
                  ? 'up'
                  : t.sentiment === 'bearish' || t.sentiment === 'negative'
                    ? 'down'
                    : 'neutral'
              }
            >
              {t.name.length > 34 ? `${t.name.slice(0, 33)}…` : t.name}
            </Chip>
          ))}
          {reasons.tags.length > 5 && <Chip tone="neutral">+{reasons.tags.length - 5}</Chip>}
        </div>
      )}
      {reasons.prose && <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-mark-3">{reasons.prose}</p>}

      <div className="pointer-events-none absolute right-3 bottom-3 opacity-0 transition-opacity group-hover:opacity-100">
        <Target size={13} className="text-marigold" />
      </div>
    </article>
  );
}

function Cell({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] tracking-[0.12em] text-mark-4 uppercase">{label}</div>
      <div className={cn('tnum truncate font-mono text-[11px]', tone ?? 'text-mark')}>{value}</div>
    </div>
  );
}
