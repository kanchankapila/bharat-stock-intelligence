import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { auth, authActions } from '../lib/trpcFire';
import { cn } from '../lib/utils';
import { DASH, n0, num, pct, price, rupees } from '../lib/format';
import { Panel, Stat, SymbolLink } from '../components/Primitives';
import { DataTable } from '../components/DataTable';

const TABS = [
  { k: 'holdings', label: 'Equity holdings' },
  { k: 'mf', label: 'Mutual funds' },
] as const;

/**
 * The book. Both procedures here are `protectedProcedure` — the uid is derived
 * from the verified Firebase token and never accepted from the client, so there
 * is genuinely no unauthenticated read. That makes the signed-out state a real
 * state rather than an error, so it renders as a sign-in prompt and the rest of
 * the desk stays usable without an account.
 */
export default function PortfolioPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['k']>('holdings');
  const user = auth.currentUser;

  return (
    <div className="tala-rise space-y-3 p-3">
      <Panel accent eyebrow="BOOK" title="Your positions">
        <div className="flex flex-wrap items-center gap-2">
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
          {user && (
            <span className="ml-auto font-mono text-[10px] text-mark-4">
              signed in as {user.email ?? user.uid.slice(0, 10)}
            </span>
          )}
        </div>
      </Panel>

      {!user ? (
        <Panel dense>
          <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
            <LogIn size={20} className="text-mark-4" />
            <p className="text-[13px] font-semibold text-mark-2">Sign in to see your book</p>
            <p className="max-w-md text-[11px] leading-relaxed text-mark-4">
              Holdings, mutual-fund positions and price alerts are stored per user and require a verified
              Firebase session. Everything else on this desk works without one.
            </p>
            <button
              onClick={() => void authActions.signInWithGoogle()}
              className="rounded border border-marigold/40 bg-marigold/10 px-3 py-1.5 font-mono text-[11px] text-marigold transition-colors hover:bg-marigold/20"
            >
              Continue with Google
            </button>
          </div>
        </Panel>
      ) : tab === 'holdings' ? (
        <Holdings />
      ) : (
        <MutualFunds />
      )}
    </div>
  );
}

/** Portfolio rows arrive under a few different column spellings depending on which
 *  writer populated them; these accessors pick the first real one so a renamed
 *  column renders an em dash rather than a wrong number. */
const qty = (r: any) => num(r.quantity);
const avgPx = (r: any) => num(r.avgPrice) ?? num(r.averagePrice);
const ltp = (r: any) => num(r.ltp) ?? num(r.currentPrice);
const invested = (r: any) => num(r.investedAmount) ?? num(r.invested) ?? 0;
const value = (r: any) => num(r.currentValue) ?? (qty(r) ?? 0) * (ltp(r) ?? 0);
const pnl = (r: any) => num(r.pnl) ?? num(r.unrealisedPnl);
const pnlPct = (r: any) => num(r.pnlPercent) ?? num(r.pnlPercentValue);

function Holdings() {
  const { data, isLoading, error, refetch } = trpc.getPortfolioHoldings.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const insights: any = trpc.getPortfolioInsights.useQuery(undefined, { staleTime: 5 * 60_000 }).data;
  const rows: any[] = Array.isArray(data) ? data : [];

  const investedTotal = rows.reduce((s, r) => s + invested(r), 0);
  const currentTotal = rows.reduce((s, r) => s + value(r), 0);
  const pnlTotal = currentTotal - investedTotal;
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Panel dense>
          <Stat label="Positions" value={n0(rows.length)} size="lg" />
        </Panel>
        <Panel dense>
          <Stat label="Invested" value={rupees(investedTotal)} size="lg" />
        </Panel>
        <Panel dense>
          <Stat label="Current" value={rupees(currentTotal)} size="lg" />
        </Panel>
        <Panel dense>
          <Stat
            label="Unrealised P&L"
            value={rupees(pnlTotal)}
            size="lg"
            tone={pnlTotal >= 0 ? 'text-up' : 'text-down'}
            sub={investedTotal ? pct((pnlTotal / investedTotal) * 100) : undefined}
          />
        </Panel>
      </div>

      {insights && (
        <Panel eyebrow="READ" title="What the platform sees in your book">
          <p className="text-[11px] leading-relaxed text-mark-3">
            {String(insights?.summary ?? insights?.insight ?? JSON.stringify(insights)).slice(0, 700)}
          </p>
        </Panel>
      )}

      <Panel dense eyebrow="POSITIONS" title="Holdings">
        <DataTable
          rows={rows}
          getKey={(r: any, i: number) => r.symbol + '-' + (r.id ?? i)}
          isLoading={isLoading}
          error={error}
          onRetry={retry}
          dense
          maxHeight="calc(100vh - 420px)"
          initialSort={{ key: 'value', dir: 'desc' }}
          emptyLabel="No open positions"
          emptyHint="Positions you add will appear here with live valuation and P&L."
          columns={[
            { key: 'symbol', header: 'Symbol', sort: (r: any) => r.symbol, cell: (r: any) => <SymbolLink symbol={r.symbol} /> },
            { key: 'qty', header: 'Qty', align: 'right' as const, sort: qty, cell: (r: any) => (
              <span className="tnum font-mono">{n0(r.quantity)}</span>
            ) },
            { key: 'avg', header: 'Avg', align: 'right' as const, sort: avgPx, cell: (r: any) => (
              <span className="tnum font-mono text-mark-2">{price(r.avgPrice ?? r.averagePrice)}</span>
            ) },
            { key: 'ltp', header: 'LTP', align: 'right' as const, sort: ltp, cell: (r: any) => (
              <span className="tnum font-mono">{price(r.ltp ?? r.currentPrice)}</span>
            ) },
            { key: 'value', header: 'Value', align: 'right' as const, sort: value, cell: (r: any) => (
              <span className="tnum font-mono">{rupees(value(r))}</span>
            ) },
            {
              key: 'pnl',
              header: 'P&L',
              align: 'right' as const,
              sort: pnl,
              cell: (r: any) => {
                const v = pnl(r);
                return <span className={cn('tnum font-mono font-semibold', (v ?? 0) >= 0 ? 'text-up' : 'text-down')}>{rupees(v)}</span>;
              },
            },
            {
              key: 'pnlpct',
              header: 'P&L %',
              align: 'right' as const,
              sort: pnlPct,
              cell: (r: any) => {
                const v = pnlPct(r);
                return <span className={cn('tnum font-mono', (v ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(v)}</span>;
              },
            },
            { key: 'sector', header: 'Sector', hideBelow: 'lg' as const, sort: (r: any) => r.sector ?? '', cell: (r: any) => (
              <span className="text-[10px] text-mark-3">{r.sector ?? DASH}</span>
            ) },
          ]}
        />
      </Panel>
    </div>
  );
}

function MutualFunds() {
  const { data, isLoading, error, refetch } = trpc.getMfHoldings.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const rows: any[] = Array.isArray(data) ? data : [];
  const investedTotal = rows.reduce((s, r) => s + (num(r.investedAmount) ?? num(r.invested) ?? 0), 0);
  const currentTotal = rows.reduce((s, r) => s + (num(r.currentValue) ?? 0), 0);
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Panel dense>
          <Stat label="Funds" value={n0(rows.length)} size="lg" />
        </Panel>
        <Panel dense>
          <Stat label="Invested" value={rupees(investedTotal)} size="lg" />
        </Panel>
        <Panel dense>
          <Stat
            label="Current"
            value={rupees(currentTotal)}
            size="lg"
            tone={currentTotal - investedTotal >= 0 ? 'text-up' : 'text-down'}
            sub={investedTotal ? pct(((currentTotal - investedTotal) / investedTotal) * 100) : undefined}
          />
        </Panel>
      </div>

      <Panel dense eyebrow="POSITIONS" title="Mutual funds">
        <DataTable
          rows={rows}
          getKey={(r: any, i: number) => (r.fundName ?? r.schemeName ?? r.symbol ?? 'fund') + '-' + (r.id ?? i)}
          isLoading={isLoading}
          error={error}
          onRetry={retry}
          dense
          maxHeight="calc(100vh - 360px)"
          emptyLabel="No mutual-fund positions"
          columns={[
            {
              key: 'fund',
              header: 'Fund',
              sort: (r: any) => r.fundName ?? r.schemeName ?? '',
              cell: (r: any) => (
                <span className="block max-w-[360px] truncate text-[12px] text-mark">
                  {r.fundName ?? r.schemeName ?? r.symbol ?? DASH}
                </span>
              ),
            },
            { key: 'nav', header: 'NAV', align: 'right' as const, sort: (r: any) => num(r.nav), cell: (r: any) => (
              <span className="tnum font-mono">{price(r.nav, 3)}</span>
            ) },
            { key: 'units', header: 'Units', align: 'right' as const, hideBelow: 'md' as const, sort: (r: any) => num(r.units), cell: (r: any) => (
              <span className="tnum font-mono text-mark-3">{n0(r.units, 3)}</span>
            ) },
            { key: 'value', header: 'Value', align: 'right' as const, sort: (r: any) => num(r.currentValue), cell: (r: any) => (
              <span className="tnum font-mono">{rupees(r.currentValue)}</span>
            ) },
            {
              key: 'ret',
              header: 'Return',
              align: 'right' as const,
              sort: (r: any) => num(r.returnPercent),
              cell: (r: any) => {
                const v = num(r.returnPercent);
                return <span className={cn('tnum font-mono font-semibold', (v ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(v)}</span>;
              },
            },
            { key: 'cat', header: 'Category', hideBelow: 'lg' as const, sort: (r: any) => r.category ?? '', cell: (r: any) => (
              <span className="text-[10px] text-mark-3">{r.category ?? DASH}</span>
            ) },
          ]}
        />
      </Panel>
    </div>
  );
}
