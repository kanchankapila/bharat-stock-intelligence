import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  CandlestickChart,
  Compass,
  Gauge,
  LayoutDashboard,
  LineChart,
  Newspaper,
  Radar,
  ShieldCheck,
  Target,
  Wallet,
} from 'lucide-react';
import { trpc } from './lib/trpc';
import TalaRoutes from './TalaRoutes';
import { cn } from './lib/utils';
import { clockIST, num, pct, price } from './lib/format';
import { readRegime } from './lib/insight';
import { SymbolSearch } from './components/SymbolSearch';

const NAV = [
  { to: '/tala', label: 'Desk', icon: LayoutDashboard, end: true },
  { to: '/tala/picks', label: 'Picks', icon: Target, end: false },
  { to: '/tala/screeners', label: 'Screeners', icon: Radar, end: false },
  { to: '/tala/market', label: 'Market', icon: CandlestickChart, end: false },
  { to: '/tala/indices', label: 'Indices', icon: LineChart, end: false },
  { to: '/tala/news', label: 'News', icon: Newspaper, end: false },
  { to: '/tala/edge', label: 'Edge', icon: Gauge, end: false },
  { to: '/tala/book', label: 'Book', icon: Wallet, end: false },
] as const;

/** NSE cash session, IST. Drives the market-status pill — a trader needs to know at
 *  a glance whether what they are reading is a live price or yesterday's close. */
export function marketPhase(d = new Date()): { label: string; live: boolean; tone: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday');
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  if (day === 'Sat' || day === 'Sun') return { label: 'Weekend', live: false, tone: 'text-mark-3' };
  // NSE cash session: pre-open 09:00-09:15 (540-555), continuous market 09:15-15:30 (555-930),
  // closing session 15:30-15:40 (930-940). AF-20260927-04: the old boundaries (565/620/900/920)
  // marked most of the trading day "Closed".
  if (mins >= 540 && mins < 555) return { label: 'Pre-open', live: true, tone: 'text-warn' };
  if (mins >= 555 && mins < 930) return { label: 'Open', live: true, tone: 'text-up' };
  if (mins >= 930 && mins < 940) return { label: 'Post-close', live: true, tone: 'text-warn' };
  return { label: 'After hours', live: false, tone: 'text-mark-3' };
}

function MarketClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const phase = marketPhase(now);
  return (
    <div className="flex items-center gap-2">
      <span className="tnum font-mono text-[12px] text-mark-2">{clockIST(now)}</span>
      <span className="font-mono text-[9px] text-mark-4">IST</span>
      <span className="flex items-center gap-1.5 border-l border-line pl-2.5">
        <span className={cn('size-1.5 rounded-full', phase.live ? 'tala-live-dot bg-up' : 'bg-mark-4')} />
        <span className={cn('font-mono text-[9px] tracking-[0.14em] uppercase', phase.tone)}>{phase.label}</span>
      </span>
    </div>
  );
}

/** Index tape, always visible. A trader who has to scroll to find out what the
 *  market is doing will make decisions on stale context. */
function IndexTape() {
  const { data } = trpc.getMarketOverview.useQuery(undefined, { staleTime: 30_000, refetchInterval: 30_000 });
  const items = useMemo(() => {
    if (!data) return [];
    const d: any = data;
    return [
      { label: 'NIFTY 50', d: d.nifty50 },
      { label: 'BANKNIFTY', d: d.bankNifty },
      { label: 'SENSEX', d: d.sensex },
    ].filter((x) => x.d && x.d.value !== null && x.d.value !== undefined);
  }, [data]);

  if (!items.length) return <div className="h-4" />;

  return (
    <div className="tala-scroll flex items-center gap-4 overflow-x-auto">
      {items.map(({ label, d }: any) => (
        <div key={label} className="flex shrink-0 items-baseline gap-1.5">
          <span className="font-mono text-[9px] tracking-[0.14em] text-mark-4">{label}</span>
          <span className="tnum font-mono text-[11px] text-mark-2">{price(d.value)}</span>
          <span className={cn('tnum font-mono text-[10px]', num(d.changePct) >= 0 ? 'text-up' : 'text-down')}>
            {pct(d.changePct)}
          </span>
        </div>
      ))}
    </div>
  );
}

function RegimePill() {
  const { data } = trpc.getRegimeSummary.useQuery(undefined, { staleTime: 120_000, refetchInterval: 300_000 });
  const r: any = (data as any)?.current;
  if (!r) return null;
  const read = readRegime(r.regime, r.regime_prob);
  const tone =
    read.tone === 'up' ? 'text-up border-up/30 bg-up/[0.07]'
      : read.tone === 'down' ? 'text-down border-down/30 bg-down/[0.07]'
        : read.tone === 'warn' ? 'text-warn border-warn/30 bg-warn/[0.07]'
          : 'text-mark-2 border-line-2 bg-white/[0.03]';
  return (
    <div className={cn('flex items-center gap-2 rounded border px-2 py-1', tone)} title={read.stance}>
      <Activity size={11} />
      <span className="font-mono text-[10px] font-bold tracking-[0.12em]">{read.name}</span>
      <span className="tnum font-mono text-[9px] opacity-70">{(read.confidence * 100).toFixed(0)}%</span>
    </div>
  );
}

/** Data-health pill. This app's dominant failure mode is a failed query rendering
 *  identically to a loading one (documented in main.tsx), so the desk surfaces the
 *  monitored-job state in the chrome rather than only in a dev console. */
function DataHealthPill() {
  const { data } = trpc.getSystemStatus.useQuery(undefined, { staleTime: 60_000, refetchInterval: 120_000 });
  const rows: any[] = Array.isArray(data) ? data : [];
  if (!rows.length) return null;
  const bad = rows.filter((r) => {
    const h = String(r?.health ?? r?.status ?? '').toUpperCase();
    return h === 'STALE' || h === 'FAILED' || h === 'ERROR' || h === 'DOWN';
  }).length;
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[9px] tracking-[0.1em] uppercase',
        bad ? 'border-warn/30 bg-warn/[0.06] text-warn' : 'border-line-2 bg-white/[0.03] text-mark-3',
      )}
      title={rows.length + ' monitored jobs - ' + bad + ' reporting stale or failed'}
    >
      <ShieldCheck size={11} />
      {bad ? bad + ' stale' : rows.length + ' jobs ok'}
    </div>
  );
}

export default function TalaApp() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-ink-900 text-mark">
      <header className="flex h-11 shrink-0 items-center gap-4 border-b border-line bg-ink-950/80 px-3 backdrop-blur">
        <button onClick={() => navigate('/tala')} className="flex shrink-0 items-center gap-2" aria-label="Tala home">
          <span className="grid size-6 place-items-center rounded-sm bg-marigold font-display text-[13px] leading-none font-extrabold text-ink-950">
            à¤¤
          </span>
          <span className="font-display text-[14px] font-extrabold tracking-[0.22em] text-mark">TALA</span>
        </button>

        <div className="hidden h-4 w-px bg-line md:block" />
        <div className="hidden min-w-0 flex-1 md:block">
          <IndexTape />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <RegimePill />
          <DataHealthPill />
          <div className="hidden lg:block">
            <MarketClock />
          </div>
          <SymbolSearch />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-14 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-ink-950/50 py-2">
          {NAV.map(({ to, label, icon: Icon, end }) => {
            const active = end ? location.pathname === to : location.pathname.startsWith(to);
            return (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={label}
                className={cn(
                  'relative grid size-9 place-items-center rounded transition-colors',
                  active ? 'bg-marigold/12 text-marigold' : 'text-mark-4 hover:bg-white/[0.04] hover:text-mark-2',
                )}
              >
                {active && <span className="absolute top-1/2 -left-[13px] h-5 w-0.5 -translate-y-1/2 bg-marigold" />}
                <Icon size={15} strokeWidth={active ? 2.2 : 1.7} />
              </NavLink>
            );
          })}

          <div className="mt-auto flex flex-col items-center gap-2">
            <button
              onClick={() => navigate('/')}
              title="Back to the legacy app"
              className="grid size-9 place-items-center rounded text-mark-4 transition-colors hover:bg-white/[0.04] hover:text-mark-2"
            >
              <Compass size={15} strokeWidth={1.7} />
            </button>
          </div>
        </nav>

        <main key={location.pathname} className="tala-scroll min-w-0 flex-1 overflow-y-auto">
          <TalaRoutes />
        </main>
      </div>
    </div>
  );
}
