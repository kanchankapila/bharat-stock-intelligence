import React, { useMemo, useState } from 'react';
import { Bell, CheckCircle2, AlertTriangle, RefreshCw, Search, Clock, TrendingUp, Target, ShieldAlert } from 'lucide-react';
import { trpc } from '../lib/trpc';

const FONT_FAMILY_DISPLAY = "'Archivo', sans-serif";
const FONT_FAMILY_MONO = "'IBM Plex Mono', monospace";

const amber = '#f97316';
const emerald = '#22c55e';
const rose = '#ef4444';
const hold = '#eab308';

const KpiChip: React.FC<{
  label: string;
  value: string;
  sub?: string;
  up?: boolean | null;
  accent?: string;
  icon?: React.ReactNode;
}> = ({ label, value, sub, up, accent = amber, icon }) => (
  <div
    className="glass shadow-[0_4px_20px_rgba(0,0,0,0.02)] border border-slate-800/50 border-t-2"
    style={{
      flex: 1,
      minWidth: 180,
      borderTopColor: accent,
      borderRadius: 10,
      padding: '12px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}
  >
    <div
      className="flex items-center gap-1.5"
      style={{
        fontFamily: FONT_FAMILY_DISPLAY,
        fontSize: 9,
        color: '#64748b',
        letterSpacing: 3,
        textTransform: 'uppercase',
      }}
    >
      {icon}
      {label}
    </div>
    <div style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 18, fontWeight: 700, color: '#f8fafc', letterSpacing: -0.5 }}>
      {value}
    </div>
    {sub !== undefined && (
      <div
        style={{
          fontFamily: FONT_FAMILY_MONO,
          fontSize: 10,
          color: up === true ? emerald : up === false ? rose : '#64748b',
        }}
      >
        {sub}
      </div>
    )}
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      fontFamily: FONT_FAMILY_DISPLAY,
      fontSize: 9,
      fontWeight: 700,
      color: '#64748b',
      letterSpacing: 4,
      textTransform: 'uppercase',
      marginBottom: 10,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}
  >
    <span style={{ display: 'inline-block', width: 16, height: 1, background: '#64748b' }} />
    {children}
    <span style={{ display: 'inline-block', flex: 1, height: 1, background: 'rgba(255,255,255,0.04)' }} />
  </div>
);

function formatIstDateTime(raw: string | null | undefined): string {
  if (!raw) return '—';
  const d = new Date(raw.includes('T') || raw.includes('+') || raw.endsWith('Z') ? raw : `${raw}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return raw;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `₹${v.toFixed(2)}`;
}

interface TelegramAlertsPageProps {
  onSelectStock?: (symbol: string) => void;
}

export const TelegramAlertsPage: React.FC<TelegramAlertsPageProps> = ({ onSelectStock }) => {
  const [days, setDays] = useState<number>(7);
  const [outcomeFilter, setOutcomeFilter] = useState<'ALL' | 'TARGET' | 'STOP' | 'BOTH'>('ALL');
  const [search, setSearch] = useState('');

  const { data, isLoading, isFetching, refetch } = trpc.getTelegram15mAlertFeed.useQuery(
    { days, outcomeFilter, limit: 250 },
    { refetchInterval: 60_000 },
  );

  const summary = data?.summary;
  const filteredAlerts = useMemo(() => {
    const rows = data?.alerts ?? [];
    const q = search.trim().toUpperCase();
    if (!q) return rows;
    return rows.filter((r) => r.symbol.toUpperCase().includes(q));
  }, [data?.alerts, search]);

  const targetShare = useMemo(() => {
    if (!summary) return 0;
    const decided = summary.targetHits + summary.stopHits;
    return decided > 0 ? (summary.targetHits / decided) * 100 : 0;
  }, [summary]);

  return (
    <div style={{ padding: '12px 16px', background: 'transparent', minHeight: '100vh' }}>
      {/* Header */}
      <div
        className="glass border border-slate-800/50 border-t-2 mb-3 flex flex-wrap items-center justify-between gap-3"
        style={{ borderTopColor: amber, borderRadius: 10, padding: '14px 16px' }}
      >
        <div>
          <div
            className="flex items-center gap-2"
            style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 10, color: amber, letterSpacing: 3, textTransform: 'uppercase' }}
          >
            <Bell size={12} />
            15-MINUTE TELEGRAM ALERTS MONITOR
          </div>
          <h1 style={{ fontFamily: FONT_FAMILY_DISPLAY, fontSize: 18, fontWeight: 700, color: '#f8fafc', marginTop: 2 }}>
            Target &amp; Stop-Loss Hit Tracker
          </h1>
          <p style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
            Tracks every 15-min intraday alert from recommendation generation through target reached or stop loss hit.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-900/70 border border-slate-800 rounded-lg p-1">
            {[
              { label: 'Today', val: 1 },
              { label: '7D', val: 7 },
              { label: '30D', val: 30 },
              { label: 'All', val: 0 },
            ].map((opt) => (
              <button
                key={opt.val}
                onClick={() => setDays(opt.val)}
                style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 11 }}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  days === opt.val ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => refetch()}
            disabled={isFetching}
            style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 11 }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/70 border border-slate-800 text-slate-300 hover:text-white hover:border-slate-700 transition-colors"
          >
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Chips */}
      <div className="flex flex-wrap gap-2 mb-3">
        <KpiChip
          label={days === 0 ? 'Overall Success %' : `${days}D Success %`}
          value={summary?.successPct != null ? `${summary.successPct.toFixed(1)}%` : '—'}
          sub={summary ? `${summary.targetHits} target · ${summary.stopHits} stop (${summary.bothHits} both)` : 'Loading…'}
          up={summary?.successPct != null ? summary.successPct >= 50 : null}
          accent={summary?.successPct != null && summary.successPct >= 50 ? emerald : amber}
          icon={<TrendingUp size={9} />}
        />
        <KpiChip
          label="Today's 15m Success %"
          value={summary?.todaySuccessPct != null ? `${summary.todaySuccessPct.toFixed(1)}%` : '—'}
          sub={summary ? `${summary.todayTargetHits} target · ${summary.todayStopHits} stop today` : 'Loading…'}
          up={summary?.todaySuccessPct != null ? summary.todaySuccessPct >= 50 : null}
          accent={summary?.todaySuccessPct != null && summary.todaySuccessPct >= 50 ? emerald : rose}
          icon={<Clock size={9} />}
        />
        <KpiChip
          label="Target Reached"
          value={summary ? String(summary.targetHits) : '—'}
          sub="Clean target_1 hits"
          up={true}
          accent={emerald}
          icon={<Target size={9} />}
        />
        <KpiChip
          label="Stop Loss Hit"
          value={summary ? String(summary.stopHits) : '—'}
          sub={summary && summary.bothHits > 0 ? `+ ${summary.bothHits} touched both` : 'Clean stop hits'}
          up={false}
          accent={rose}
          icon={<ShieldAlert size={9} />}
        />
      </div>

      {/* Success % Visual Bar */}
      <div
        className="glass border border-slate-800/50 mb-3"
        style={{ borderRadius: 10, padding: '12px 16px' }}
      >
        <div className="flex items-center justify-between mb-1.5" style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 11 }}>
          <span style={{ color: emerald }}>
            TARGET REACHED: {summary?.targetHits ?? 0} ({targetShare.toFixed(1)}%)
          </span>
          <span style={{ color: '#94a3b8' }}>
            DECIDED ALERTS: {(summary?.targetHits ?? 0) + (summary?.stopHits ?? 0)}
          </span>
          <span style={{ color: rose }}>
            STOP HIT: {summary?.stopHits ?? 0} ({(100 - targetShare).toFixed(1)}%)
          </span>
        </div>
        <div className="w-full h-2.5 rounded-full overflow-hidden flex bg-slate-900 border border-slate-800">
          <div
            style={{ width: `${targetShare}%`, background: emerald, transition: 'width 0.4s ease' }}
          />
          <div
            style={{ width: `${Math.max(0, 100 - targetShare)}%`, background: rose, transition: 'width 0.4s ease' }}
          />
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-3 [&>*]:min-w-0">
        {/* Left: Alerted Recommendations Table */}
        <div
          className="glass border border-slate-800/50 border-t-2"
          style={{ borderTopColor: emerald, borderRadius: 10, padding: '14px 16px' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <SectionLabel>Alerted Recommendations (15-min Bars)</SectionLabel>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 bg-slate-900/70 border border-slate-800 rounded-lg p-1">
                {(['ALL', 'TARGET', 'STOP', 'BOTH'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setOutcomeFilter(f)}
                    style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 10 }}
                    className={`px-2 py-0.5 rounded transition-colors ${
                      outcomeFilter === f ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {f === 'ALL' ? 'All' : f === 'TARGET' ? 'Target' : f === 'STOP' ? 'Stop' : 'Both'}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-2 text-slate-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter symbol..."
                  style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 11 }}
                  className="pl-7 pr-2.5 py-1 rounded-lg bg-slate-900/70 border border-slate-800 text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-orange-500/50 w-36"
                />
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="py-12 text-center text-slate-400" style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 12 }}>
              Loading 15-minute Telegram alert history…
            </div>
          ) : filteredAlerts.length === 0 ? (
            <div className="py-12 text-center text-slate-500" style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 12 }}>
              No 15-minute target or stop-loss alerts found for this filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse" style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 11 }}>
                <thead>
                  <tr className="border-b border-slate-800/80 text-slate-500" style={{ fontSize: 10 }}>
                    <th className="py-2 pr-3">STOCK</th>
                    <th className="py-2 pr-3">REC GENERATED (IST)</th>
                    <th className="py-2 pr-3">HIT TIME (IST)</th>
                    <th className="py-2 pr-3">RESULT</th>
                    <th className="py-2 pr-3 text-right">ENTRY</th>
                    <th className="py-2 pr-3 text-right">EFF. STOP</th>
                    <th className="py-2 text-right">TARGET</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAlerts.map((r) => {
                    const effectiveStop = r.trailingStop ?? r.stopLoss;
                    const badgeColor = r.hitKind === 'TARGET' ? emerald : r.hitKind === 'STOP' ? rose : hold;
                    const badgeBg =
                      r.hitKind === 'TARGET'
                        ? 'rgba(34,197,94,0.12)'
                        : r.hitKind === 'STOP'
                        ? 'rgba(239,68,68,0.12)'
                        : 'rgba(234,179,8,0.12)';
                    const badgeText =
                      r.hitKind === 'TARGET' ? 'TARGET REACHED' : r.hitKind === 'STOP' ? 'STOP LOSS HIT' : 'BOTH TOUCHED';

                    return (
                      <tr
                        key={r.id}
                        className="border-b border-slate-800/40 hover:bg-slate-800/25 transition-colors"
                      >
                        <td className="py-2.5 pr-3">
                          <button
                            onClick={() => onSelectStock?.(r.symbol)}
                            className="font-bold text-slate-100 hover:text-orange-400 transition-colors text-left"
                          >
                            {r.symbol}
                          </button>
                          <div className="text-[10px] text-slate-500">
                            {r.recType} · {r.timeframe ?? 'swing'} · {r.source ?? '—'}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 text-slate-300 whitespace-nowrap">
                          {formatIstDateTime(r.generatedAt)}
                        </td>
                        <td className="py-2.5 pr-3 text-slate-200 whitespace-nowrap">
                          {formatIstDateTime(r.hitAt)}
                        </td>
                        <td className="py-2.5 pr-3 whitespace-nowrap">
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-semibold"
                            style={{ color: badgeColor, background: badgeBg, fontSize: 10 }}
                          >
                            {r.hitKind === 'TARGET' ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}
                            {badgeText}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-right text-slate-300">{fmtPrice(r.entryPrice)}</td>
                        <td className="py-2.5 pr-3 text-right text-rose-400">
                          {fmtPrice(effectiveStop)}
                          {r.trailingStop != null && r.stopLoss != null && r.trailingStop > r.stopLoss && (
                            <span className="block text-[9px] text-slate-500">trail</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right text-emerald-400">{fmtPrice(r.target1)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: Recent 15-min Telegram Dispatch Log */}
        <div
          className="glass border border-slate-800/50 border-t-2"
          style={{ borderTopColor: amber, borderRadius: 10, padding: '14px 16px' }}
        >
          <SectionLabel>Live Telegram Dispatch Feed</SectionLabel>
          <div className="space-y-2.5 max-h-[680px] overflow-y-auto pr-1">
            {(data?.dispatches ?? []).length === 0 ? (
              <div className="text-slate-500 py-8 text-center" style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 11 }}>
                No recent 15-minute Telegram dispatches logged.
              </div>
            ) : (
              (data?.dispatches ?? []).map((d) => (
                <div
                  key={d.id}
                  className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800/70"
                  style={{ fontFamily: FONT_FAMILY_MONO, fontSize: 11 }}
                >
                  <div className="flex items-center justify-between mb-1.5 text-[10px]">
                    <span className="text-orange-400 font-semibold">{formatIstDateTime(d.sent_at)} IST</span>
                    <span className={d.ok ? 'text-emerald-400' : 'text-rose-400'}>
                      {d.ok ? 'DELIVERED' : 'FAILED'}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap text-slate-300 text-[10px] leading-relaxed font-mono">
                    {d.text}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TelegramAlertsPage;
