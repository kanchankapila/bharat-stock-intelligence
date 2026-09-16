import React from 'react';
import { Mic2 } from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { Card } from '../../../components/Card';
import { cn } from '../../../lib/utils';

// AI-generated earnings-call tone/takeaway feed -- investsights_concall_fetcher.py ->
// concall_takeaways. The only unstructured-text signal in the platform right now; stored
// verbatim, never scored into a number (see the fetcher's own docstring on why -- an
// unvalidated keyword score on third-party AI prose is a guess, not a feature).
const toneColor = (tone: string | null) => {
  const t = (tone ?? '').toLowerCase();
  if (t.includes('positive') || t.includes('bullish') || t.includes('strong')) return 'text-emerald-400';
  if (t.includes('negative') || t.includes('bearish') || t.includes('weak') || t.includes('cautious')) return 'text-rose-400';
  return 'text-slate-400';
};

export const ConcallTakeawaysWidget: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data, isLoading } = trpc.getConcallTakeaways.useQuery({ limit: 8 }, { refetchInterval: 30 * 60_000 });
  const takeaways = data ?? [];

  return (
    <Card title="Earnings Call Takeaways" icon={Mic2}>
      {isLoading ? (
        <div className="text-xs text-slate-500 py-6 text-center animate-pulse">Loading takeaways…</div>
      ) : takeaways.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">No concall takeaways yet.</div>
      ) : (
        <div className="space-y-2.5">
          {takeaways.map((t: any, i: number) => (
            <div
              key={`${t.symbol}-${t.quarter}-${i}`}
              onClick={() => onSelectStock?.(t.symbol)}
              className="p-3 rounded-xl border border-slate-800 bg-slate-950 hover:border-slate-700 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs font-bold text-slate-100">{t.symbol}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[9px] text-slate-500">{t.quarter} FY{t.fiscal_year}</span>
                  {t.tone_assessment && (
                    <span className={cn('text-[9px] font-black uppercase tracking-wide', toneColor(t.tone_assessment))}>{t.tone_assessment}</span>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-2">{t.key_takeaway}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

export default ConcallTakeawaysWidget;
