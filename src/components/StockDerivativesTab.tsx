import React from 'react';
import { Gauge, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { QueryError } from './IntelligenceQueryError';
import { MetricTile } from './MetricTile';
import { DataHealthChip } from './DataHealthChip';
import { cn } from '../lib/utils';

// getFnoOptionChainSummary (fno.router -> fnoService) returns a strongly-typed FnoChainSummary
// straight from Trendlyne's smartoptions chain: PCR, max pain, ATM, aggregate OI, average IV per
// side, the IV skew between them, and the three largest call/put strikes by open interest.
// Everything on this tab is that one payload -- no derived scores.
type ChainLeg = { strike: number; oi: number; ltp: number; iv: number | null; buildup: string | null };

interface ChainSummary {
  symbol: string;
  expiry: string;
  spot: number | null;
  pcr: number | null;
  pcrVolume: number | null;
  maxPain: number | null;
  atm: number | null;
  callTotalOI: number;
  putTotalOI: number;
  avgCallIV: number | null;
  avgPutIV: number | null;
  ivSkew: number | null;
  top3Calls: ChainLeg[];
  top3Puts: ChainLeg[];
}

function fmtOI(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  return v.toLocaleString('en-IN');
}

// OI ladder: the three strikes with the most open interest act as the nearest structural
// resistance (calls) and support (puts). Bars are scaled against the largest leg so the two
// sides are directly comparable.
function OiLadder({ legs, side, max }: { legs: ChainLeg[]; side: 'call' | 'put'; max: number }) {
  if (legs.length === 0) {
    return <p className="bsi-intel-note">No strikes reported on the {side} side.</p>;
  }
  return (
    <ul className="space-y-2.5">
      {legs.map(leg => {
        const width = max > 0 ? Math.max(4, (leg.oi / max) * 100) : 4;
        return (
          <li key={`${side}-${leg.strike}`}>
            <div className="mb-1 flex items-center justify-between gap-3 text-[11px]">
              <span className="font-mono text-white">{leg.strike.toLocaleString('en-IN')}</span>
              <span className="text-slate-400">
                {fmtOI(leg.oi)} OI
                {leg.iv != null && ` · IV ${leg.iv.toFixed(1)}`}
                {leg.buildup && ` · ${leg.buildup}`}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
              <div
                className={cn('h-full rounded-full', side === 'call' ? 'bg-[var(--bsi-down)]' : 'bg-[var(--bsi-up)]')}
                style={{ width: `${width}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function StockDerivativesTab({ symbol }: { symbol: string }) {
  const expiries = trpc.getFnoAvailableExpiries.useQuery({ symbol }, { staleTime: 3_600_000 });
  const [expiry, setExpiry] = React.useState<string | undefined>(undefined);

  const summary = trpc.getFnoOptionChainSummary.useQuery(
    expiry ? { symbol, expiry } : { symbol },
    { staleTime: 120_000 },
  );

  const data = (summary.data ?? null) as ChainSummary | null;
  const maxLegOi = data
    ? Math.max(0, ...data.top3Calls.map(l => l.oi), ...data.top3Puts.map(l => l.oi))
    : 0;

  const maxPainDistance = data?.maxPain != null && data?.spot != null && data.spot > 0
    ? ((data.maxPain - data.spot) / data.spot) * 100
    : null;

  // Same thresholds the service itself applies when it labels overall sentiment.
  const pcrRead = data?.pcr == null
    ? null
    : data.pcr > 1.2
      ? { label: 'Put-heavy (bullish tilt)', direction: 'up' as const }
      : data.pcr < 0.7
        ? { label: 'Call-heavy (bearish tilt)', direction: 'down' as const }
        : { label: 'Balanced', direction: 'neutral' as const };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="bsi-intel-note">
          Expiry horizon
          <select
            className="bsi-control block mt-2"
            value={expiry ?? ''}
            onChange={e => setExpiry(e.target.value || undefined)}
          >
            <option value="">Nearest expiry{data?.expiry ? ` (${data.expiry})` : ''}</option>
            {(expiries.data ?? []).map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-3">
          <DataHealthChip lastUpdated={summary.dataUpdatedAt ? new Date(summary.dataUpdatedAt).toISOString() : null} staleThresholdMinutes={15} />
          <button type="button" onClick={() => void summary.refetch()} disabled={summary.isFetching} className="bsi-action">
            <RefreshCw className={cn('w-3.5 h-3.5', summary.isFetching && 'animate-spin')} />
            {summary.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {summary.isError && <QueryError retry={() => void summary.refetch()} />}

      {!summary.isLoading && !data && !summary.isError && (
        <div className="bsi-intel-panel py-10 text-center">
          <Gauge className="mx-auto mb-3 text-amber-400" />
          <h3 className="font-display">No option chain for {symbol}</h3>
          <p className="bsi-intel-note mt-2">
            The derivatives feed returned nothing for this symbol and expiry. Securities outside the F&amp;O list have no chain at all — that is an absence, not a flat market.
          </p>
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile label="Spot" value={data.spot != null ? data.spot.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'} />
            <MetricTile label="ATM strike" value={data.atm != null ? data.atm.toLocaleString('en-IN') : '—'} />
            <MetricTile label="Put/call ratio" value={data.pcr != null ? data.pcr.toFixed(3) : '—'} direction={pcrRead?.direction} />
            <MetricTile label="Max pain" value={data.maxPain != null ? data.maxPain.toLocaleString('en-IN') : '—'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="bsi-intel-panel">
              <h3 className="font-display mb-3 flex items-center gap-2 text-[var(--bsi-down)]">
                <TrendingUp className="w-4 h-4" />Call OI walls (resistance)
              </h3>
              <OiLadder legs={data.top3Calls} side="call" max={maxLegOi} />
            </div>
            <div className="bsi-intel-panel">
              <h3 className="font-display mb-3 flex items-center gap-2 text-[var(--bsi-up)]">
                <TrendingDown className="w-4 h-4" />Put OI walls (support)
              </h3>
              <OiLadder legs={data.top3Puts} side="put" max={maxLegOi} />
            </div>
          </div>

          <div className="bsi-intel-panel">
            <h3 className="font-display mb-3">Positioning read</h3>
            <ul className="space-y-3 text-xs">
              <li className="flex items-start justify-between gap-4">
                <span className="text-slate-400">Put/call ratio (OI)</span>
                <span className="text-right text-slate-200">
                  <span className="font-mono text-white">{data.pcr != null ? data.pcr.toFixed(3) : '—'}</span>
                  {pcrRead && <span className="block text-[11px] text-slate-400">{pcrRead.label}</span>}
                </span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-slate-400">Put/call ratio (volume)</span>
                <span className="font-mono text-white">{data.pcrVolume != null ? data.pcrVolume.toFixed(3) : '—'}</span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-slate-400">Total call OI</span>
                <span className="font-mono text-[var(--bsi-down)]">{fmtOI(data.callTotalOI)}</span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-slate-400">Total put OI</span>
                <span className="font-mono text-[var(--bsi-up)]">{fmtOI(data.putTotalOI)}</span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-slate-400">Average IV (call / put)</span>
                <span className="font-mono text-white">
                  {data.avgCallIV != null ? data.avgCallIV.toFixed(1) : '—'} / {data.avgPutIV != null ? data.avgPutIV.toFixed(1) : '—'}
                </span>
              </li>
              {data.ivSkew != null && (
                <li className="flex items-start justify-between gap-4">
                  <span className="text-slate-400">IV skew</span>
                  <span className="text-right">
                    <span className="font-mono text-white">{data.ivSkew.toFixed(2)}</span>
                    <span className="block text-[11px] text-slate-400">
                      {data.ivSkew > 0
                        ? 'Calls priced above puts — upside demand or hedging against a squeeze.'
                        : data.ivSkew < 0
                          ? 'Puts priced above calls — downside protection is the more expensive side.'
                          : 'Both sides priced evenly.'}
                    </span>
                  </span>
                </li>
              )}
              {maxPainDistance != null && (
                <li className="flex items-start justify-between gap-4">
                  <span className="text-slate-400">Max pain vs spot</span>
                  <span className="text-right">
                    <span className={cn('font-mono', maxPainDistance >= 0 ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]')}>
                      {maxPainDistance >= 0 ? '+' : ''}{maxPainDistance.toFixed(2)}%
                    </span>
                    <span className="block text-[11px] text-slate-400">
                      {Math.abs(maxPainDistance) < 0.5
                        ? 'Spot already sits on the max-pain strike, so the pinning pull is spent.'
                        : maxPainDistance > 0
                          ? 'Max pain sits above spot — expiry gravity points upward.'
                          : 'Max pain sits below spot — expiry gravity points downward.'}
                    </span>
                  </span>
                </li>
              )}
            </ul>
            <p className="bsi-intel-note mt-4">
              Max pain is the strike where the most option value expires worthless — a description of the current open-interest distribution, not a forecast the market is obliged to honour. PCR thresholds follow this platform's own service (above 1.2 put-heavy, below 0.7 call-heavy).
            </p>
          </div>
        </>
      )}

      <p className="bsi-intel-note">Derivatives positioning decays with the expiry and is not investment advice. NOT FINANCIAL ADVICE.</p>
    </div>
  );
}
