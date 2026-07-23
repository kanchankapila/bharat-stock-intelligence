import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, ArrowRight, TrendingUp, TrendingDown } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';

// Compact teaser of the full Earnings & Results page (src/components/EarningsPage.tsx) — same
// getEarnings() aggregate, so the two never disagree.
export const EarningsPulseWidget: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const navigate = useNavigate();
  const { data, isLoading } = trpc.getEarnings.useQuery({});

  const dash = data?.dashboard?.data;
  const list: any[] = data?.earningsData?.data?.list ?? [];
  const shockers: any[] = data?.priceShockers?.data?.list ?? [];

  return (
    <Card
      title="Earnings & Results Today"
      icon={CalendarClock}
      onClick={() => navigate('/earnings')}
      action={<ArrowRight className="w-3.5 h-3.5 text-slate-500" />}
    >
      {isLoading ? (
        <div className="text-xs text-slate-500">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="glass rounded-xl p-2 text-center">
              <div className="text-lg font-black font-mono text-slate-100">{dash?.totalResults ?? '—'}</div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest">Declared</div>
            </div>
            <div className="glass rounded-xl p-2 text-center">
              <div className="text-lg font-black font-mono text-emerald-400">{dash?.beat ?? '—'}</div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest">Beat</div>
            </div>
            <div className="glass rounded-xl p-2 text-center">
              <div className="text-lg font-black font-mono text-rose-400">{dash?.miss ?? '—'}</div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest">Miss</div>
            </div>
          </div>

          {list.length === 0 && shockers.length === 0 ? (
            <div className="text-[11px] text-slate-500">No results declared yet today.</div>
          ) : (
            <div className="space-y-1.5">
              {list.slice(0, 3).map((item: any, i: number) => (
                <button
                  key={i}
                  onClick={() => item.symbol && onSelectStock?.(item.symbol)}
                  className="w-full flex items-center justify-between text-[11px] text-slate-300 hover:text-white truncate"
                >
                  <span className="truncate">{item.companyName || item.companyShortName || item.symbol || 'Unknown'}</span>
                  {item.netProfitGrowth != null && (
                    <span className={cn('flex items-center gap-1 font-mono shrink-0 ml-2', item.netProfitGrowth >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {item.netProfitGrowth >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Number(item.netProfitGrowth).toFixed(1)}%
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
};

export default EarningsPulseWidget;
