import React from 'react';
import { Landmark } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';

// Ranked institutional (bulk/block) buy/sell feed -- MoneyControl's topInvestor deals endpoint,
// via institutional_deals_fetcher.py -> institutional_deal_signals. Distinct from the existing
// getDeals (live, no history, all deal types unranked): this is a persisted, freshness-monitored,
// counterparty-named trend, previously fetched but never rendered anywhere.
export const InstitutionalDealFeed: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data, isLoading } = trpc.getInstitutionalDealHistory.useQuery({ days: 14 }, { refetchInterval: 15 * 60_000 });
  const deals = (data ?? []).slice(0, 8);

  return (
    <Card title="Institutional Deal Signals" icon={Landmark}>
      {isLoading ? (
        <div className="text-xs text-slate-500 py-6 text-center animate-pulse">Loading deal flow…</div>
      ) : deals.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">No institutional deals in the last 14 days.</div>
      ) : (
        <div className="space-y-1.5">
          {deals.map((d: any, i: number) => (
            <button
              key={`${d.symbol}-${d.deal_date}-${i}`}
              onClick={() => onSelectStock?.(d.symbol)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 hover:border-slate-700 transition-colors text-left"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-100">{d.symbol}</span>
                  <span className={cn(
                    'text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wide',
                    d.action === 'buy' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400',
                  )}>
                    {d.action}
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 truncate">{d.counterparty ?? 'Unknown counterparty'}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs font-mono font-bold text-slate-200">
                  ₹{Number(d.deal_value_cr_1w ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr
                </div>
                <div className="text-[9px] text-slate-500">{d.deal_date} · 1W</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
};

export default InstitutionalDealFeed;
