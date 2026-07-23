import React, { useMemo } from 'react';
import { Globe2, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';

interface MacroTile {
  symbol: string;
  label: string;
  group: string;
  unit: string;
  date: string;
  close: number | null;
  ret1d: number | null;
  ret5d: number | null;
}

function fmtPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function trendIcon(n: number | null | undefined) {
  if (n == null) return Minus;
  return n > 0.05 ? TrendingUp : n < -0.05 ? TrendingDown : Minus;
}

function trendColor(n: number | null | undefined) {
  if (n == null) return 'text-slate-400';
  return n > 0.05 ? 'text-emerald-400' : n < -0.05 ? 'text-rose-400' : 'text-slate-400';
}

// Deterministic, rule-based read of the overnight macro tape — every sentence traces directly
// to a fetched tile's ret1d value, nothing is inferred or fabricated. This is the "what an
// analyst reads before the bell" synthesis; it never invents a number that isn't in `tiles`.
function buildBriefing(tiles: Record<string, MacroTile>): string[] {
  const lines: string[] = [];
  const us = ['SP500', 'NASDAQ', 'DOW'].map(s => tiles[s]?.ret1d).filter((v): v is number => v != null);
  const asia = ['NIKKEI', 'HANGSENG'].map(s => tiles[s]?.ret1d).filter((v): v is number => v != null);
  const gift = tiles['GIFT_NIFTY'];
  const vix = tiles['INDIAVIX'];
  const fii = tiles['FII_NET_TODAY'];
  const dii = tiles['DII_NET_TODAY'];
  const usdinr = tiles['USDINR'];
  const crude = tiles['CRUDE'] ?? tiles['BRENT'];
  const gold = tiles['GOLD'];

  if (us.length) {
    const avg = us.reduce((a, b) => a + b, 0) / us.length;
    lines.push(`US markets closed ${avg > 0 ? 'higher' : avg < 0 ? 'lower' : 'flat'} overnight (avg ${fmtPct(avg)} across S&P/Nasdaq/Dow).`);
  }
  if (asia.length) {
    const avg = asia.reduce((a, b) => a + b, 0) / asia.length;
    lines.push(`Asian peers are trading ${avg > 0 ? 'positive' : avg < 0 ? 'negative' : 'mixed'} this morning (avg ${fmtPct(avg)}).`);
  }
  if (gift?.ret1d != null) {
    lines.push(`GIFT Nifty implies a ${gift.ret1d > 0.1 ? 'gap-up' : gift.ret1d < -0.1 ? 'gap-down' : 'flat'} open for Nifty (${fmtPct(gift.ret1d)}).`);
  }
  if (fii?.close != null || dii?.close != null) {
    const fiiSign = fii?.close != null ? (fii.close >= 0 ? 'net buyers' : 'net sellers') : null;
    const diiSign = dii?.close != null ? (dii.close >= 0 ? 'net buyers' : 'net sellers') : null;
    if (fiiSign && diiSign) {
      lines.push(`FIIs were ${fiiSign} (₹${Math.abs(fii!.close).toFixed(0)} Cr) while DIIs were ${diiSign} (₹${Math.abs(dii!.close).toFixed(0)} Cr) in the last session.`);
    }
  }
  if (vix?.close != null) {
    lines.push(`India VIX at ${vix.close.toFixed(2)}${vix.ret1d != null ? ` (${fmtPct(vix.ret1d)})` : ''} — ${vix.close >= 18 ? 'elevated, expect wider intraday swings' : vix.close <= 12 ? 'compressed, low hedging cost' : 'in a normal range'}.`);
  }
  if (usdinr?.close != null) {
    lines.push(`USD/INR ${usdinr.close.toFixed(2)}${usdinr.ret1d != null ? ` (${fmtPct(usdinr.ret1d)})` : ''}.`);
  }
  if (crude?.close != null) {
    lines.push(`Crude ${crude.close.toFixed(1)}${crude.ret1d != null ? ` (${fmtPct(crude.ret1d)})` : ''} — a move here is a direct input cost/inflation read-through.`);
  }
  if (gold?.ret1d != null && Math.abs(gold.ret1d) > 0.5) {
    lines.push(`Gold moved ${fmtPct(gold.ret1d)} — notable risk-sentiment signal.`);
  }
  if (lines.length === 0) lines.push('Macro snapshot not yet available for today.');
  return lines;
}

export const PreMarketBriefing: React.FC = () => {
  const { data, isLoading } = trpc.getMacroSnapshot.useQuery();

  const tiles = useMemo(() => {
    const map: Record<string, MacroTile> = {};
    (data ?? []).forEach((t: MacroTile) => { map[t.symbol] = t; });
    return map;
  }, [data]);

  const briefing = useMemo(() => buildBriefing(tiles), [tiles]);

  const displayTiles = [
    'GIFT_NIFTY', 'SP500', 'NASDAQ', 'DOW', 'NIKKEI', 'HANGSENG',
    'INDIAVIX', 'USDINR', 'DXY', 'CRUDE', 'BRENT', 'GOLD',
  ].map(sym => tiles[sym]).filter(Boolean);

  return (
    <Card title="Pre-Market Briefing" icon={Globe2}>
      {isLoading ? (
        <div className="text-xs text-slate-500">Loading macro tape…</div>
      ) : (
        <>
          <ul className="space-y-1.5 mb-4">
            {briefing.map((line, i) => (
              <li key={i} className="text-[12px] text-slate-300 leading-snug flex gap-2">
                <span className="text-indigo-400 shrink-0">›</span>
                {line}
              </li>
            ))}
          </ul>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {displayTiles.map((t) => {
              const Icon = trendIcon(t.ret1d);
              return (
                <div key={t.symbol} className="glass rounded-xl p-2.5">
                  <div className="text-[9px] text-slate-500 uppercase tracking-widest truncate">{t.label || t.symbol}</div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-sm font-mono font-bold text-slate-100">
                      {t.close != null ? t.close.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
                    </span>
                    <span className={cn('flex items-center gap-0.5 text-[11px] font-mono font-bold', trendColor(t.ret1d))}>
                      <Icon className="w-3 h-3" />
                      {fmtPct(t.ret1d)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
};

export default PreMarketBriefing;
