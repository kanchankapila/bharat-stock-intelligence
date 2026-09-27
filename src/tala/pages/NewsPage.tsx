import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ago, DASH, n0, num, parseJson } from '../lib/format';
import { Chip, Panel, SymbolLink } from '../components/Primitives';
import { BarRow } from '../components/Charts';

const CATEGORIES = ['ALL', 'EARNINGS', 'ORDER_WIN', 'BUYBACK', 'POLICY', 'IPO', 'GLOBAL', 'SECTOR', 'GENERAL'] as const;
const SENTIMENTS = ['ALL', 'BULLISH', 'BEARISH', 'NEUTRAL'] as const;
const HOURS = [6, 12, 24, 48] as const;

/** Colour carries the read; the headline carries the fact. */
function SentimentStripe({ sentiment }: { sentiment: unknown }) {
  return (
    <span
      className={cn(
        'mt-1 h-3.5 w-0.5 shrink-0 rounded-full',
        sentiment === 'BULLISH' ? 'bg-up' : sentiment === 'BEARISH' ? 'bg-down' : 'bg-line-3',
      )}
    />
  );
}

/**
 * The news desk: a filterable wire, plus the two roll-ups that actually change a
 * decision — sector-level sentiment balance and the corporate-event stream.
 *
 * Sentiment is FinBERT-classified upstream and is always shown as a classification
 * with its score beside a readable headline, never as a naked percentage: a reader
 * shown "0.72 bullish" weights it far more heavily than one shown "BULLISH +0.72"
 * alongside the story that produced it.
 */
export default function NewsPage() {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('ALL');
  const [sentiment, setSentiment] = useState<(typeof SENTIMENTS)[number]>('ALL');
  const [hours, setHours] = useState<number>(24);

  const { data, isLoading, error, refetch } = trpc.getNewsItems.useQuery(
    { limit: 120, category, sentiment, sourceType: 'ALL', hours },
    { staleTime: 120_000, refetchInterval: 300_000 },
  );
  const { data: sectorSent } = trpc.getSectorNewsSentiment.useQuery(undefined, { staleTime: 5 * 60_000 });
  const { data: events } = trpc.getCorporateEventNews.useQuery(undefined, { staleTime: 5 * 60_000 });
  const { data: marketSent } = trpc.getMarketSentiment.useQuery({ historyHours: 24 }, { staleTime: 120_000 });

  const rows: any[] = Array.isArray(data) ? data : [];
  const sectorRows: any[] = useMemo(
    () =>
      [...(Array.isArray(sectorSent) ? sectorSent : [])].sort(
        (a, b) => (num(b.netScore) ?? 0) - (num(a.netScore) ?? 0),
      ),
    [sectorSent],
  );
  const eventRows: any[] = useMemo(() => (Array.isArray(events) ? events : []).slice(0, 40), [events]);
  const maxNet = Math.max(1, ...sectorRows.map((s) => Math.abs(num(s.netScore) ?? 0)));

  const latest = (marketSent as any)?.latest;
  const hist: any[] = (marketSent as any)?.history ?? [];
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <div className="tala-rise space-y-3 p-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel accent eyebrow="SENTIMENT" title="News tone by sector" dense>
          <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
            Bullish minus bearish article count per sector across the feed window. This measures press tone,
            not price action — a sector can be heavily covered and still be going nowhere.
          </p>
          {sectorRows.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-[11px] text-mark-4">No sector sentiment computed.</p>
          ) : (
            <div className="space-y-0.5 p-3.5">
              {sectorRows.map((s) => {
                const net = num(s.netScore) ?? 0;
                return (
                  <BarRow
                    key={s.sector}
                    label={s.sector}
                    value={Math.abs(net)}
                    max={maxNet}
                    tone={net >= 0 ? 'bg-up/70' : 'bg-down/60'}
                    right={`${net > 0 ? '+' : ''}${net}`}
                    sub={n0((num(s.bullish) ?? 0) + (num(s.bearish) ?? 0))}
                  />
                );
              })}
            </div>
          )}
        </Panel>

        <Panel eyebrow="MIX" title="Overall tone" dense>
          <div className="p-3.5">
            <div className="flex items-baseline justify-between">
              <span className="tnum font-mono text-[32px] leading-none font-bold text-mark">
                {num(latest?.overall_score)?.toFixed(0) ?? DASH}
              </span>
              <Chip
                tone={
                  (num(latest?.overall_score) ?? 50) > 55
                    ? 'up'
                    : (num(latest?.overall_score) ?? 50) < 45
                      ? 'down'
                      : 'warn'
                }
              >
                {latest?.overall_label ?? '-'}
              </Chip>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
              <Cell label="Bullish" value={n0(latest?.bullish_count)} tone="text-up" />
              <Cell label="Neutral" value={n0(latest?.neutral_count)} tone="text-mark-2" />
              <Cell label="Bearish" value={n0(latest?.bearish_count)} tone="text-down" />
            </div>
            {hist.length > 1 && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="mb-1.5 text-[9px] tracking-[0.16em] text-mark-4 uppercase">24h trend</div>
                <svg viewBox="0 0 300 44" preserveAspectRatio="none" className="h-11 w-full">
                  <polyline
                    fill="none"
                    stroke="var(--color-marigold)"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                    points={hist
                      .map((h: any, i: number) => {
                        const v = num(h.overall_score) ?? 50;
                        return (i / Math.max(1, hist.length - 1)) * 300 + ',' + (44 - (v / 100) * 44);
                      })
                      .join(' ')}
                  />
                </svg>
                <div className="mt-1 flex justify-between font-mono text-[9px] text-mark-4">
                  <span>{ago(hist[0]?.snapshot_at)}</span>
                  <span>now</span>
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel dense eyebrow="EVENTS" title="Corporate events">
          {eventRows.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-[11px] text-mark-4">
              No corporate-event news in the window.
            </p>
          ) : (
            <ul className="tala-scroll max-h-[330px] overflow-y-auto">
              {eventRows.map((n, i) => (
                <li key={n.id ?? i} className="border-b border-line/50 px-3.5 py-2 last:border-0">
                  <a href={n.url} target="_blank" rel="noreferrer noopener" className="group block">
                    <div className="flex items-start gap-2">
                      <SentimentStripe sentiment={n.sentiment} />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-[11px] leading-snug text-mark-2 group-hover:text-mark">
                          {n.title}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[9px] text-mark-4">
                          <span className="font-mono">{ago(n.published_at)}</span>
                          {n.category && <span>{n.category}</span>}
                          <SymbolTags raw={n.symbols_json} />
                        </div>
                      </div>
                      <ExternalLink size={10} className="mt-0.5 shrink-0 text-mark-4 opacity-0 group-hover:opacity-100" />
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel dense eyebrow="WIRE" title="Full news feed">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-ink-900/40 px-3.5 py-2.5">
          <div className="flex flex-wrap gap-0.5">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[9px] tracking-wide uppercase transition-colors',
                  category === c ? 'bg-marigold/15 text-marigold' : 'text-mark-4 hover:text-mark-2',
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="h-3 w-px bg-line" />
          <div className="flex gap-0.5">
            {SENTIMENTS.map((s) => (
              <button
                key={s}
                onClick={() => setSentiment(s)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[9px] tracking-wide uppercase transition-colors',
                  sentiment === s ? 'bg-white/[0.08] text-mark' : 'text-mark-4 hover:text-mark-2',
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-0.5">
            {HOURS.map((h) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors',
                  hours === h ? 'bg-white/[0.08] text-mark' : 'text-mark-4 hover:text-mark-2',
                )}
              >
                {h}h
              </button>
            ))}
          </div>
        </div>

        <Feed rows={rows} isLoading={isLoading} error={error} onRetry={retry} />
      </Panel>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] tracking-[0.12em] text-mark-4 uppercase">{label}</div>
      <div className={cn('tnum font-mono text-[14px]', tone)}>{value}</div>
    </div>
  );
}

/** Only renders when the mapper actually extracted symbols; most articles carry an
 *  empty list, and showing an empty tag row for those would be pure noise. */
function SymbolTags({ raw }: { raw: unknown }) {
  const syms: string[] = parseJson<string[]>(raw, []);
  if (!syms.length) return null;
  return (
    <span className="flex gap-1">
      {syms.slice(0, 3).map((s) => (
        <SymbolLink key={s} symbol={s} className="text-[9px]" />
      ))}
    </span>
  );
}

function Feed({
  rows,
  isLoading,
  error,
  onRetry,
}: {
  rows: any[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error)
    return (
      <div className="px-3.5 py-4 text-[11px] text-down">
        News feed unavailable - {String((error as any)?.message ?? '').slice(0, 120)}
        <button onClick={onRetry} className="ml-2 rounded border border-line-2 px-1.5 py-0.5 font-mono text-[9px]">
          RETRY
        </button>
      </div>
    );
  if (isLoading && !rows.length)
    return (
      <div className="space-y-2 p-3.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="tala-live-dot h-8 rounded bg-white/[0.05]" />
        ))}
      </div>
    );
  if (!rows.length)
    return <p className="px-3.5 py-8 text-center text-[11px] text-mark-4">No articles match these filters.</p>;

  return (
    <ul className="tala-scroll max-h-[calc(100vh-380px)] overflow-y-auto">
      {rows.map((n, i) => (
        <li
          key={n.id ?? i}
          className="tala-rise border-b border-line/50 px-3.5 py-2.5 last:border-0 hover:bg-white/[0.02]"
          style={{ animationDelay: Math.min(i, 20) * 12 + 'ms' }}
        >
          <a href={n.url} target="_blank" rel="noreferrer noopener" className="group flex items-start gap-3">
            <SentimentStripe sentiment={n.sentiment} />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] leading-snug text-mark-2 transition-colors group-hover:text-mark">{n.title}</p>
              {n.summary && <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-mark-4">{n.summary}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[9px] text-mark-4">
                <span className="font-mono">{ago(n.published_at)}</span>
                <span className="truncate">{n.source}</span>
                {n.sector && <span>{n.sector}</span>}
                {n.impact === 'HIGH' && <Chip tone="warn">HIGH IMPACT</Chip>}
                {n.sentiment && n.sentiment !== 'NEUTRAL' && (
                  <Chip tone={n.sentiment === 'BULLISH' ? 'up' : 'down'}>
                    {n.sentiment}
                    {num(n.sentiment_score) !== null
                      ? ' ' + (n.sentiment_score > 0 ? '+' + n.sentiment_score : n.sentiment_score)
                      : ''}
                  </Chip>
                )}
                <SymbolTags raw={n.symbols_json} />
              </div>
            </div>
            <ExternalLink size={11} className="mt-1 shrink-0 text-mark-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </a>
        </li>
      ))}
    </ul>
  );
}
