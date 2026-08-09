import React, { useMemo } from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { Activity, BarChart3, Clock, ShieldCheck, AlertTriangle, Zap } from 'lucide-react';
import { Card } from './MCCommon';
import { marketHoursRefetchInterval } from '../lib/timeFormat';

interface IndexFnoOverviewProps {
  symbol: string;
}

function toFnoSymbol(symbol: string) {
  const s = symbol.toUpperCase();
  if (s === 'NIFTY 50' || s === 'NIFTY50') return 'NIFTY';
  if (s === 'NIFTY BANK' || s === 'BANKNIFTY') return 'BANKNIFTY';
  if (s === 'NIFTY FIN SERVICE' || s === 'FINNIFTY') return 'FINNIFTY';
  if (s === 'NIFTY MIDCAP SELECT' || s === 'MIDCPNIFTY') return 'MIDCPNIFTY';
  return s;
}

// ── Option row index positions (Trendlyne Phoenix API) ─────────────────────
// [0]=stock, [1]=type, [2]=strike, [3]=ltp, [4]=dayChg%,
// [5]=vol, [6]=volChg%, [7]=ttv, [8]=oi, [9]=oiChg(abs),
// [10]=oiChg%, [11]=iv, [12]=ivChg%, [13]=spot,
// [14]=delta, [15]=gamma, [16]=rho, [17]=theta, [18]=vega, [19]=buildup

// ── Futures row index positions ─────────────────────────────────────────────
// [0]=stock, [1]=ltp, [2]=dayChg%?, [3]=vol, [4]=volChg%?,
// [5]=ttv, [6]=oi?, ... varies; use headers dynamically

function getOptNum(row: any[], idx: number): number | null {
  const v = row[idx];
  return typeof v === 'number' ? v : null;
}

function getBuildup(row: any[]): string | null {
  const last = row[row.length - 1];
  return typeof last === 'string' ? last : null;
}

// ── PCR & Key Level Analysis ───────────────────────────────────────────────
interface OIAnalysis {
  pcr: number;
  callTotalOI: number;
  putTotalOI: number;
  maxCallStrike: number | null;
  maxCallOI: number;
  maxPutStrike: number | null;
  maxPutOI: number;
  avgCallIV: number | null;
  avgPutIV: number | null;
  ivSkew: number | null;
  callBuildupDist: Record<string, number>;
  putBuildupDist: Record<string, number>;
  top3Calls: { strike: number; oi: number; ltp: number; iv: number | null; buildup: string | null }[];
  top3Puts: { strike: number; oi: number; ltp: number; iv: number | null; buildup: string | null }[];
}

function analyseOI(callRows: any[][], putRows: any[][]): OIAnalysis {
  const callOIs = callRows.map(r => ({ strike: getOptNum(r, 2) ?? 0, oi: getOptNum(r, 8) ?? 0, ltp: getOptNum(r, 3) ?? 0, iv: getOptNum(r, 11), buildup: getBuildup(r) }));
  const putOIs  = putRows.map(r  => ({ strike: getOptNum(r, 2) ?? 0, oi: getOptNum(r, 8) ?? 0, ltp: getOptNum(r, 3) ?? 0, iv: getOptNum(r, 11), buildup: getBuildup(r) }));

  const callTotalOI = callOIs.reduce((s, r) => s + r.oi, 0);
  const putTotalOI  = putOIs.reduce((s, r)  => s + r.oi, 0);
  const pcr = callTotalOI > 0 ? putTotalOI / callTotalOI : 0;

  const topCall = callOIs.sort((a, b) => b.oi - a.oi)[0] || null;
  const topPut  = putOIs.sort((a, b)  => b.oi - a.oi)[0] || null;

  const callIVs = callOIs.map(r => r.iv).filter((v): v is number => v != null);
  const putIVs  = putOIs.map(r  => r.iv).filter((v): v is number => v != null);
  const avgCallIV = callIVs.length ? callIVs.reduce((a, b) => a + b, 0) / callIVs.length : null;
  const avgPutIV  = putIVs.length  ? putIVs.reduce((a, b)  => a + b, 0) / putIVs.length  : null;
  const ivSkew = avgCallIV != null && avgPutIV != null ? avgPutIV - avgCallIV : null;

  const countBuildup = (rows: typeof callOIs) => {
    const dist: Record<string, number> = {};
    rows.forEach(r => { if (r.buildup) dist[r.buildup] = (dist[r.buildup] || 0) + 1; });
    return dist;
  };

  const top3Calls = [...callOIs].sort((a, b) => b.oi - a.oi).slice(0, 3);
  const top3Puts  = [...putOIs].sort((a, b)  => b.oi - a.oi).slice(0, 3);

  return {
    pcr, callTotalOI, putTotalOI,
    maxCallStrike: topCall?.strike ?? null, maxCallOI: topCall?.oi ?? 0,
    maxPutStrike:  topPut?.strike  ?? null, maxPutOI:  topPut?.oi  ?? 0,
    avgCallIV, avgPutIV, ivSkew,
    callBuildupDist: countBuildup(callOIs),
    putBuildupDist:  countBuildup(putOIs),
    top3Calls, top3Puts,
  };
}

// ── PCR Gauge ──────────────────────────────────────────────────────────────
const PCRGauge: React.FC<{ pcr: number }> = ({ pcr }) => {
  // PCR > 1.3 = very bullish (contrarian), 0.7–1.3 = neutral, < 0.7 = bearish
  const clampedPct = Math.min(100, Math.max(0, ((pcr - 0.5) / 1.5) * 100));
  const interpretation =
    pcr > 1.5 ? { label: 'Extreme Bullish', sub: 'Oversold — reversal likely', color: 'text-emerald-400', bar: 'bg-emerald-500' } :
    pcr > 1.3 ? { label: 'Bullish',          sub: 'Put writers dominate',       color: 'text-emerald-400', bar: 'bg-emerald-500' } :
    pcr > 1.0 ? { label: 'Slightly Bullish', sub: 'Puts > Calls — mild bias',  color: 'text-yellow-400', bar: 'bg-yellow-500'  } :
    pcr > 0.8 ? { label: 'Neutral',           sub: 'Balanced positioning',       color: 'text-slate-300',  bar: 'bg-slate-500'   } :
    pcr > 0.6 ? { label: 'Slightly Bearish', sub: 'Calls > Puts — cautious',   color: 'text-amber-400',  bar: 'bg-amber-500'   } :
                { label: 'Bearish',           sub: 'Call writers in control',    color: 'text-rose-400',   bar: 'bg-rose-500'    };

  return (
    <div className="p-5 glass-strong border border-slate-800/50 rounded-2xl">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Put-Call Ratio (PCR)</p>
          <p className={cn("text-3xl font-black tabular-nums italic mt-1", interpretation.color)}>{pcr.toFixed(2)}</p>
        </div>
        <div className="text-right">
          <p className={cn("text-[10px] font-black uppercase italic", interpretation.color)}>{interpretation.label}</p>
          <p className="text-[10px] text-slate-400 font-bold mt-0.5">{interpretation.sub}</p>
        </div>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", interpretation.bar)} style={{ width: `${clampedPct}%` }} />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[9.5px] font-bold text-rose-500">0.5 Bearish</span>
        <span className="text-[9.5px] font-bold text-slate-400">1.0 Neutral</span>
        <span className="text-[9.5px] font-bold text-emerald-500">2.0 Bullish</span>
      </div>
    </div>
  );
};

// ── IV Skew Widget ──────────────────────────────────────────────────────────
const IVSkewWidget: React.FC<{ callIV: number | null; putIV: number | null; skew: number | null }> = ({ callIV, putIV, skew }) => (
  <div className="p-5 glass-strong border border-slate-800/50 rounded-2xl">
    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">IV Skew (Put IV − Call IV)</p>
    <div className="flex gap-6">
      <div>
        <p className="text-[9.5px] font-bold text-emerald-500 uppercase mb-1">Call IV (avg)</p>
        <p className="text-xl font-black text-emerald-400 tabular-nums italic">{callIV != null ? `${callIV.toFixed(1)}%` : '—'}</p>
      </div>
      <div className="w-px bg-slate-800" />
      <div>
        <p className="text-[9.5px] font-bold text-rose-500 uppercase mb-1">Put IV (avg)</p>
        <p className="text-xl font-black text-rose-400 tabular-nums italic">{putIV != null ? `${putIV.toFixed(1)}%` : '—'}</p>
      </div>
      <div className="w-px bg-slate-800" />
      <div>
        <p className="text-[9.5px] font-bold text-amber-500 uppercase mb-1">Skew</p>
        <p className={cn("text-xl font-black tabular-nums italic", skew != null && skew > 0 ? 'text-amber-400' : 'text-sky-400')}>
          {skew != null ? `${skew >= 0 ? '+' : ''}${skew.toFixed(1)}%` : '—'}
        </p>
      </div>
    </div>
    {skew != null && (
      <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase tracking-widest">
        {skew > 3 ? '→ Elevated put premium — hedging demand / fear' :
         skew < -3 ? '→ Calls costlier — aggressive upside bets placed' :
         '→ Balanced skew — no extreme directional bias'}
      </p>
    )}
  </div>
);

// ── Key Strike Row ──────────────────────────────────────────────────────────
const StrikeRow: React.FC<{
  strike: number; oi: number; ltp: number; iv: number | null;
  buildup: string | null; type: 'CE' | 'PE'; rank: number
}> = ({ strike, oi, ltp, iv, buildup, type, rank }) => {
  const buildupColors: Record<string, string> = {
    'Long Build Up':  'text-emerald-400',
    'Short Build Up': 'text-rose-400',
    'Short Covering': 'text-sky-400',
    'Long Unwinding': 'text-amber-400',
  };
  return (
    <div className={cn("flex items-center justify-between p-3 rounded-xl border transition-all",
      rank === 0 ? (type === 'CE' ? 'bg-rose-500/5 border-rose-500/20' : 'bg-emerald-500/5 border-emerald-500/20')
                : 'glass-strong border-slate-800/30')}>
      <div className="flex items-center gap-2.5">
        <span className={cn("text-[10px] font-black w-4 text-center", rank === 0 ? (type === 'CE' ? 'text-rose-400' : 'text-emerald-400') : 'text-slate-400')}>
          #{rank + 1}
        </span>
        <div>
          <div className="flex items-center gap-1.5">
            <span className={cn("text-[9.5px] font-black px-1.5 py-0.5 rounded uppercase",
              type === 'CE' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400')}>
              {type}
            </span>
            <span className="text-xs font-black text-white italic">₹{strike.toLocaleString('en-IN')}</span>
            {rank === 0 && (
              <span className={cn("text-[7px] font-black uppercase px-1 py-0.5 rounded",
                type === 'CE' ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400')}>
                {type === 'CE' ? 'Resistance' : 'Support'}
              </span>
            )}
          </div>
          {buildup && (
            <p className={cn("text-[9.5px] font-bold mt-0.5", buildupColors[buildup] || 'text-slate-400')}>{buildup}</p>
          )}
        </div>
      </div>
      <div className="text-right">
        <p className="text-[11px] font-black text-white tabular-nums">₹{ltp.toLocaleString('en-IN', { maximumFractionDigits: 1 })}</p>
        <div className="flex gap-2 justify-end mt-0.5">
          <span className="text-[9.5px] font-bold text-slate-400">OI: {oi >= 1e6 ? `${(oi / 1e6).toFixed(1)}M` : `${(oi / 1000).toFixed(0)}K`}</span>
          {iv != null && <span className="text-[9.5px] font-bold text-amber-500">IV: {iv.toFixed(1)}%</span>}
        </div>
      </div>
    </div>
  );
};

// ── Main Component ──────────────────────────────────────────────────────────
const IndexFnoOverview: React.FC<IndexFnoOverviewProps> = ({ symbol }) => {
  const fnoSymbol = toFnoSymbol(symbol);

  const { data: futData,  isLoading: lFut }  = trpc.getTrendlyneFnoScanners.useQuery({ mtype: 'futures', screenType: 'most-active-contract', instType: 'index' }, { refetchInterval: marketHoursRefetchInterval(10000) });
  const { data: callData, isLoading: lCall } = trpc.getTrendlyneFnoScanners.useQuery({ mtype: 'options', screenType: 'oi-gainers-call',     instType: 'index' }, { refetchInterval: marketHoursRefetchInterval(10000) });
  const { data: putData,  isLoading: lPut }  = trpc.getTrendlyneFnoScanners.useQuery({ mtype: 'options', screenType: 'oi-gainers-put',      instType: 'index' }, { refetchInterval: marketHoursRefetchInterval(10000) });

  const futRows  = useMemo(() => (futData?.tableData  || []).filter((r: any[]) => r[0]?.name === fnoSymbol), [futData, fnoSymbol]);
  const callRows = useMemo(() => (callData?.tableData || []).filter((r: any[]) => r[0]?.name === fnoSymbol), [callData, fnoSymbol]);
  const putRows  = useMemo(() => (putData?.tableData  || []).filter((r: any[]) => r[0]?.name === fnoSymbol), [putData, fnoSymbol]);

  const analysis = useMemo(() => callRows.length || putRows.length ? analyseOI(callRows, putRows) : null, [callRows, putRows]);

  if (lFut || lCall || lPut) return <div className="h-64 glass/50 animate-pulse rounded-3xl" />;

  if (!analysis && !futRows.length) {
    return (
      <div className="p-8 text-center bg-slate-950/30 border border-slate-800/30 rounded-3xl">
        <AlertTriangle className="w-6 h-6 text-slate-300 mx-auto mb-3" />
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">No F&O data available for {fnoSymbol}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* PCR + IV Skew row */}
      {analysis && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <PCRGauge pcr={analysis.pcr} />
          <IVSkewWidget callIV={analysis.avgCallIV} putIV={analysis.avgPutIV} skew={analysis.ivSkew} />
        </div>
      )}

      {/* Key strikes: resistance + support */}
      {analysis && (analysis.top3Calls.length > 0 || analysis.top3Puts.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card title={`${fnoSymbol} — Call OI (Resistance Zones)`} icon={AlertTriangle}>
            <div className="space-y-2 pt-2">
              {analysis.top3Calls.length === 0 ? (
                <p className="text-[10px] font-black text-slate-400 uppercase text-center py-4">No call data</p>
              ) : analysis.top3Calls.map((c, i) => (
                <StrikeRow key={c.strike} strike={c.strike} oi={c.oi} ltp={c.ltp} iv={c.iv} buildup={c.buildup} type="CE" rank={i} />
              ))}
              {analysis.top3Calls[0] && (
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest pt-1">
                  Max call OI at ₹{analysis.top3Calls[0].strike.toLocaleString('en-IN')} — writers defending this level. Breakout above = short-squeeze rally.
                </p>
              )}
            </div>
          </Card>

          <Card title={`${fnoSymbol} — Put OI (Support Zones)`} icon={ShieldCheck}>
            <div className="space-y-2 pt-2">
              {analysis.top3Puts.length === 0 ? (
                <p className="text-[10px] font-black text-slate-400 uppercase text-center py-4">No put data</p>
              ) : analysis.top3Puts.map((p, i) => (
                <StrikeRow key={p.strike} strike={p.strike} oi={p.oi} ltp={p.ltp} iv={p.iv} buildup={p.buildup} type="PE" rank={i} />
              ))}
              {analysis.top3Puts[0] && (
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest pt-1">
                  Max put OI at ₹{analysis.top3Puts[0].strike.toLocaleString('en-IN')} — put writers providing a strong floor. Break below = delta hedging cascade.
                </p>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Futures contracts */}
      {futRows.length > 0 && (
        <Card title={`${fnoSymbol} Active Futures`} icon={Activity}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
            {futRows.slice(0, 3).map((row: any[], idx: number) => {
              const cb = row[0]?.callbackinfo || {};
              const expiry = cb.expiry || '';
              // Use first numeric values after stock object
              const ltp    = typeof row[1] === 'number' ? row[1] : null;
              const dayChg = typeof row[2] === 'number' ? row[2] : (typeof row[3] === 'number' ? row[3] : null);
              // Find OI — scan for the largest number > 1000 that isn't TTV
              const oi     = typeof row[6] === 'number' ? row[6] : (typeof row[7] === 'number' ? row[7] : null);
              const oiChg  = typeof row[7] === 'number' && oi === row[6] ? row[7] : (typeof row[8] === 'number' ? row[8] : null);
              const buildup = getBuildup(row);
              const buildupColors: Record<string, string> = {
                'Long Build Up': 'text-emerald-400', 'Short Build Up': 'text-rose-400',
                'Short Covering': 'text-sky-400', 'Long Unwinding': 'text-amber-400',
              };
              return (
                <div key={idx} className="p-4 glass-strong border border-slate-800/50 rounded-2xl hover:border-blue-500/30 transition-all">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-3 h-3 text-slate-400" />
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{expiry || `Contract ${idx + 1}`}</span>
                  </div>
                  <p className="text-2xl font-black text-white tabular-nums italic leading-none">
                    {ltp != null ? `₹${ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                  </p>
                  <div className="flex items-center justify-between mt-2">
                    {dayChg != null && (
                      <span className={cn("text-sm font-black italic", dayChg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {dayChg >= 0 ? '+' : ''}{dayChg.toFixed(2)}%
                      </span>
                    )}
                    {oiChg != null && (
                      <span className={cn("text-[10px] font-black uppercase tracking-widest", oiChg >= 0 ? 'text-emerald-500' : 'text-rose-500')}>
                        OI {oiChg >= 0 ? '+' : ''}{oiChg.toFixed(1)}%
                      </span>
                    )}
                  </div>
                  {buildup && (
                    <p className={cn("text-[9.5px] font-black uppercase tracking-widest mt-2", buildupColors[buildup] || 'text-slate-400')}>
                      ● {buildup}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* OI flow summary */}
      {analysis && (
        <div className="p-5 bg-slate-900/40 border border-slate-800/30 rounded-3xl">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <h4 className="text-[10px] font-black text-amber-400 uppercase tracking-widest italic">OI Intelligence Summary — {fnoSymbol}</h4>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-[9.5px] font-bold text-slate-400 uppercase">Total Call OI</p>
              <p className="text-sm font-black text-emerald-400 tabular-nums italic">
                {analysis.callTotalOI >= 1e6 ? `${(analysis.callTotalOI / 1e6).toFixed(2)}M` : `${(analysis.callTotalOI / 1000).toFixed(0)}K`}
              </p>
            </div>
            <div>
              <p className="text-[9.5px] font-bold text-slate-400 uppercase">Total Put OI</p>
              <p className="text-sm font-black text-rose-400 tabular-nums italic">
                {analysis.putTotalOI >= 1e6 ? `${(analysis.putTotalOI / 1e6).toFixed(2)}M` : `${(analysis.putTotalOI / 1000).toFixed(0)}K`}
              </p>
            </div>
            <div>
              <p className="text-[9.5px] font-bold text-slate-400 uppercase">Key Resistance</p>
              <p className="text-sm font-black text-white tabular-nums italic">
                {analysis.maxCallStrike != null ? `₹${analysis.maxCallStrike.toLocaleString('en-IN')}` : '—'}
              </p>
            </div>
            <div>
              <p className="text-[9.5px] font-bold text-slate-400 uppercase">Key Support</p>
              <p className="text-sm font-black text-white tabular-nums italic">
                {analysis.maxPutStrike != null ? `₹${analysis.maxPutStrike.toLocaleString('en-IN')}` : '—'}
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            {/* OI bar: put vs call */}
            <div className="flex items-center gap-2">
              <span className="text-[9.5px] font-black text-rose-400 w-8">PUT</span>
              <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden flex flex-row-reverse">
                <div className="h-full bg-rose-500 rounded-full transition-all"
                  style={{ width: `${analysis.putTotalOI / Math.max(analysis.callTotalOI + analysis.putTotalOI, 1) * 100}%` }} />
              </div>
              <span className="text-[9.5px] font-bold text-slate-400 w-12 text-right">
                {(analysis.putTotalOI / Math.max(analysis.callTotalOI + analysis.putTotalOI, 1) * 100).toFixed(0)}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9.5px] font-black text-emerald-400 w-8">CALL</span>
              <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{ width: `${analysis.callTotalOI / Math.max(analysis.callTotalOI + analysis.putTotalOI, 1) * 100}%` }} />
              </div>
              <span className="text-[9.5px] font-bold text-slate-400 w-12 text-right">
                {(analysis.callTotalOI / Math.max(analysis.callTotalOI + analysis.putTotalOI, 1) * 100).toFixed(0)}%
              </span>
            </div>
          </div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-3">
            {analysis.pcr > 1.2
              ? `PCR of ${analysis.pcr.toFixed(2)} indicates put-heavy positioning — market views current levels as support. Options traders are net bullish via put writing.`
              : analysis.pcr < 0.8
              ? `PCR of ${analysis.pcr.toFixed(2)} indicates call-heavy positioning — participants hedging upside risk or expressing bearish views via call buying.`
              : `PCR of ${analysis.pcr.toFixed(2)} reflects balanced positioning — no dominant directional bias detected at current levels.`}
          </p>
        </div>
      )}
    </div>
  );
};

export default IndexFnoOverview;
