import { useMemo } from 'react';
import { Globe2, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';

type MacroTile = {
  symbol: string;
  label: string;
  group: string;
  unit?: string;
  date: string | null;
  close: number | null;
  ret1d: number | null;
  ret5d: number | null;
};

function trendIcon(n: number | null | undefined) {
  if (n == null) return Minus;
  return n > 0.05 ? TrendingUp : n < -0.05 ? TrendingDown : Minus;
}

function trendClass(n: number | null | undefined) {
  if (n == null) return 'text-[var(--v5-muted)]';
  return n > 0.05 ? 'text-[var(--v5-positive)]' : n < -0.05 ? 'text-[var(--v5-negative)]' : 'text-[var(--v5-muted)]';
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${fmtFixed(v, 2)}%`;
}

function buildBriefing(bySymbol: Record<string, MacroTile>) {
  const us = ['SP500', 'NASDAQ', 'DOW'].map((k) => bySymbol[k]?.ret1d).filter((x): x is number => x != null);
  const asia = ['NIKKEI', 'HANGSENG'].map((k) => bySymbol[k]?.ret1d).filter((x): x is number => x != null);
  const gift = bySymbol['GIFT_NIFTY'];
  const vix = bySymbol['INDIAVIX'];
  const fii = bySymbol['FII_NET_TODAY'];
  const dii = bySymbol['DII_NET_TODAY'];

  const lines: string[] = [];

  if (us.length) {
    const avg = us.reduce((a, b) => a + b, 0) / us.length;
    lines.push(`US close tone is ${avg > 0 ? 'positive' : avg < 0 ? 'negative' : 'neutral'} (avg ${fmtPct(avg)}).`);
  }

  if (asia.length) {
    const avg = asia.reduce((a, b) => a + b, 0) / asia.length;
    lines.push(`Asia open tone is ${avg > 0 ? 'positive' : avg < 0 ? 'negative' : 'mixed'} (avg ${fmtPct(avg)}).`);
  }

  if (gift?.ret1d != null) {
    lines.push(`GIFT Nifty implies ${gift.ret1d > 0.1 ? 'gap-up' : gift.ret1d < -0.1 ? 'gap-down' : 'flat'} start (${fmtPct(gift.ret1d)}).`);
  }

  if (fii?.close != null || dii?.close != null) {
    const fiiText = fii?.close == null ? 'n/a' : `${fii.close >= 0 ? '+' : ''}${fmtFixed(fii.close, 0)}Cr`;
    const diiText = dii?.close == null ? 'n/a' : `${dii.close >= 0 ? '+' : ''}${fmtFixed(dii.close, 0)}Cr`;
    lines.push(`Flow backdrop: FII ${fiiText}, DII ${diiText}.`);
  }

  if (vix?.close != null) {
    lines.push(`India VIX at ${fmtFixed(vix.close, 2)}${vix.ret1d != null ? ` (${fmtPct(vix.ret1d)})` : ''}.`);
  }

  if (!lines.length) lines.push('Macro snapshot is not available for this session yet.');

  return lines;
}

export function PreMarketBriefingDeskPage() {
  const macroQ = trpc.getMacroSnapshot.useQuery(undefined, {
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

  const tiles = (macroQ.data ?? []) as MacroTile[];

  const bySymbol = useMemo(() => {
    const m: Record<string, MacroTile> = {};
    tiles.forEach((t) => {
      m[t.symbol] = t;
    });
    return m;
  }, [tiles]);

  const briefing = useMemo(() => buildBriefing(bySymbol), [bySymbol]);

  const gift = bySymbol['GIFT_NIFTY'];
  const vix = bySymbol['INDIAVIX'];
  const fii = bySymbol['FII_NET_TODAY'];
  const dii = bySymbol['DII_NET_TODAY'];

  const kpis = [
    { label: 'GIFT Nifty', value: gift?.close == null ? '—' : fmtFixed(gift.close, 2) },
    { label: 'Gift 1D', value: fmtPct(gift?.ret1d), tone: gift?.ret1d != null && gift.ret1d > 0 ? 'positive' as const : gift?.ret1d != null && gift.ret1d < 0 ? 'negative' as const : 'neutral' as const },
    { label: 'India VIX', value: vix?.close == null ? '—' : fmtFixed(vix.close, 2) },
    { label: 'Macro Tiles', value: String(tiles.length) },
  ];

  const flowBars = [
    { label: 'FII Net', value: fii?.close ?? null, colorClass: (fii?.close ?? 0) >= 0 ? 'v5-mini-fill-teal' : 'v5-mini-fill-rose' },
    { label: 'DII Net', value: dii?.close ?? null, colorClass: (dii?.close ?? 0) >= 0 ? 'v5-mini-fill-teal' : 'v5-mini-fill-rose' },
  ];

  const marketTiles = tiles.filter((t) => ['Pre-Open', 'Global Indices', 'Volatility', 'FX', 'Commodities', 'Flows'].includes(s(t.group)));

  const tileInsights = [
    `Macro panel has ${marketTiles.length} live tiles in the current snapshot.`,
    gift?.ret1d == null ? 'GIFT direction unavailable.' : `GIFT move: ${fmtPct(gift.ret1d)}.`,
    vix?.close == null ? 'VIX level unavailable.' : `India VIX at ${fmtFixed(vix.close, 2)} guides risk sizing tone.`,
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip title="Pre-Market Decision Summary" items={briefing.slice(0, 3)} />
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-5">
        <div className="mb-3 flex items-center gap-2">
          <Globe2 className="h-4 w-4 text-[var(--v5-positive)]" />
          <h2 className="v5-title text-lg font-semibold">Briefing Notes</h2>
        </div>

        <div className="mb-3 grid gap-3">
          <V5MiniBarChart title="Institutional Flow Snapshot" items={flowBars} />
          <V5InsightPanel title="Macro Insights" insights={tileInsights} />
        </div>

        <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Narrative</div>
          <div className="space-y-1.5">
            {briefing.map((line, i) => (
              <div key={`${i}-${line}`} className="rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] px-2 py-1.5 text-xs text-[var(--v5-ink-soft)]">
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-7">
        <h3 className="v5-title mb-3 text-base font-semibold">Macro Tape Tiles</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {marketTiles.map((t) => {
            const Icon = trendIcon(t.ret1d);
            return (
              <div key={t.symbol} className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">{s(t.label, t.symbol)}</div>
                <div className="mt-1 text-lg font-bold text-[var(--v5-ink)]">
                  {t.close == null ? '—' : fmtFixed(t.close, 2)}{t.unit ? ` ${t.unit}` : ''}
                </div>
                <div className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold ${trendClass(t.ret1d)}`}>
                  <Icon className="h-3.5 w-3.5" /> {fmtPct(t.ret1d)}
                </div>
                <div className="mt-0.5 text-[10px] text-[var(--v5-muted)]">5D: {fmtPct(t.ret5d)}</div>
              </div>
            );
          })}
          {!marketTiles.length && <p className="text-sm text-[var(--v5-muted)]">No macro tiles available in the current snapshot.</p>}
        </div>
      </div>
    </section>
  );
}
