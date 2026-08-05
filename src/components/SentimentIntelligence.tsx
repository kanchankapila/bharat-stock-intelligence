import React, { useState, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import {
  TrendingUp, TrendingDown, Minus, RefreshCw, Loader2,
  Globe, Newspaper, AlertCircle, BarChart2, Zap,
  Building2, ShoppingBag, Activity, ChevronRight
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { cn } from '../lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

type NewsCategory = 'ALL' | 'EARNINGS' | 'ORDER_WIN' | 'BUYBACK' | 'POLICY' | 'IPO' | 'GLOBAL' | 'SECTOR' | 'GENERAL';
type NewsSentiment = 'ALL' | 'BULLISH' | 'BEARISH' | 'NEUTRAL';
type SourceType    = 'ALL' | 'INDIAN' | 'GLOBAL';

interface NewsItem {
  id: string; title: string; summary: string; source: string;
  source_type: 'INDIAN' | 'GLOBAL'; url: string; published_at: string | null;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; sentiment_score: number;
  impact: 'HIGH' | 'MEDIUM' | 'LOW'; category: NewsCategory;
  symbols_json: string; sector: string | null;
}

interface Snapshot {
  overall_score: number; overall_label: string;
  bullish_count: number; bearish_count: number; neutral_count: number;
  high_impact_count: number; nifty_bias: string;
  nifty_support: number | null; nifty_resistance: number | null; nifty_last_close: number | null;
  global_cue: string; global_score: number; key_themes_json: string;
  source_count: number; snapshot_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreLabel(score: number) {
  if (score >= 50)  return { label: 'Extreme Greed', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' };
  if (score >= 20)  return { label: 'Greed',         color: 'text-lime-400',    bg: 'bg-lime-500/10 border-lime-500/30' };
  if (score <= -50) return { label: 'Extreme Fear',  color: 'text-rose-400',    bg: 'bg-rose-500/10 border-rose-500/30' };
  if (score <= -20) return { label: 'Fear',          color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/30' };
  return { label: 'Neutral', color: 'text-slate-300', bg: 'bg-slate-9000/10 border-slate-500/30' };
}

function impactColor(impact: string) {
  return impact === 'HIGH' ? 'text-rose-400 bg-rose-500/10 border-rose-500/30'
       : impact === 'MEDIUM' ? 'text-amber-400 bg-amber-500/10 border-amber-500/30'
       : 'text-slate-400 bg-slate-9000/10 border-slate-800/30';
}

function sentimentBadge(s: string) {
  return s === 'BULLISH' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
       : s === 'BEARISH' ? 'text-rose-400 bg-rose-500/10 border-rose-500/30'
       : 'text-slate-400 bg-slate-9000/10 border-slate-800/30';
}

function categoryColor(c: string): string {
  const map: Record<string, string> = {
    EARNINGS: 'text-violet-400 bg-violet-500/10 border-violet-500/30',
    ORDER_WIN:'text-sky-400 bg-sky-500/10 border-sky-500/30',
    BUYBACK:  'text-amber-400 bg-amber-500/10 border-amber-500/30',
    POLICY:   'text-indigo-400 bg-indigo-500/10 border-indigo-500/30',
    IPO:      'text-pink-400 bg-pink-500/10 border-pink-500/30',
    GLOBAL:   'text-teal-400 bg-teal-500/10 border-teal-500/30',
    SECTOR:   'text-orange-400 bg-orange-500/10 border-orange-500/30',
    GENERAL:  'text-slate-400 bg-slate-9000/10 border-slate-800/30',
  };
  return map[c] ?? map.GENERAL;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Sentiment Gauge (SVG arc) ────────────────────────────────────────────────

function SentimentGauge({ score }: { score: number }) {
  const clampedScore = Math.max(-100, Math.min(100, score));
  const { label, color } = scoreLabel(clampedScore);

  // Map -100…+100 → 0…180 degrees for a half-circle arc
  const angle = ((clampedScore + 100) / 200) * 180;
  const rad   = (angle - 90) * (Math.PI / 180);
  const cx = 100, cy = 95, r = 70;
  const needleX = cx + r * Math.cos(rad);
  const needleY = cy + r * Math.sin(rad);

  const zones = [
    { label: 'Extreme Fear', startDeg: 0,   endDeg: 36,  color: '#ef4444' },
    { label: 'Fear',         startDeg: 36,  endDeg: 72,  color: '#f97316' },
    { label: 'Neutral',      startDeg: 72,  endDeg: 108, color: '#94a3b8' },
    { label: 'Greed',        startDeg: 108, endDeg: 144, color: '#84cc16' },
    { label: 'Extreme Greed',startDeg: 144, endDeg: 180, color: '#22c55e' },
  ];

  function arcPath(startDeg: number, endDeg: number, outerR: number, innerR: number) {
    const toRad = (d: number) => ((d - 90) * Math.PI) / 180;
    const s = toRad(startDeg), e = toRad(endDeg);
    const x1 = cx + outerR * Math.cos(s), y1 = cy + outerR * Math.sin(s);
    const x2 = cx + outerR * Math.cos(e), y2 = cy + outerR * Math.sin(e);
    const x3 = cx + innerR * Math.cos(e), y3 = cy + innerR * Math.sin(e);
    const x4 = cx + innerR * Math.cos(s), y4 = cy + innerR * Math.sin(s);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 ${large} 0 ${x4} ${y4} Z`;
  }

  return (
    <div className="flex flex-col items-center">
      <svg width="200" height="115" viewBox="0 0 200 115">
        {zones.map(z => (
          <path key={z.label} d={arcPath(z.startDeg, z.endDeg, 90, 60)} fill={z.color} opacity={0.25} />
        ))}
        {zones.map(z => (
          <path key={z.label + 'b'} d={arcPath(z.startDeg, z.endDeg, 90, 88)} fill={z.color} opacity={0.5} />
        ))}
        {/* Needle */}
        <line x1={cx} y1={cy} x2={needleX} y2={needleY} stroke="white" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="5" fill="white" />
      </svg>
      <div className={cn('text-3xl font-black tabular-nums', color)}>{clampedScore > 0 ? '+' : ''}{clampedScore.toFixed(0)}</div>
      <div className={cn('text-sm font-bold mt-0.5', color)}>{label}</div>
    </div>
  );
}

// ─── News Card ────────────────────────────────────────────────────────────────

function NewsCard({ item, onSelectStock }: { item: NewsItem; onSelectStock: (s: string) => void }) {
  const symbols: string[] = useMemo(() => {
    try { return JSON.parse(item.symbols_json ?? '[]'); } catch { return []; }
  }, [item.symbols_json]);

  return (
    <div className={cn('rounded-xl border p-3 space-y-2 transition-all hover:border-slate-600',
      item.impact === 'HIGH' ? 'border-slate-800/30 bg-slate-900/60' : 'border-slate-800/50/60 bg-slate-950/20'
    )}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <a href={item.url} target="_blank" rel="noopener noreferrer"
            className="text-sm font-semibold text-white hover:text-indigo-300 transition-colors leading-snug line-clamp-2">
            {item.title}
          </a>
          {item.summary && (
            <p className="text-xs text-slate-400 mt-1 line-clamp-2">{item.summary}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={cn('text-[10px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wider', impactColor(item.impact))}>
            {item.impact}
          </span>
          <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded border', sentimentBadge(item.sentiment))}>
            {item.sentiment === 'BULLISH' ? '▲' : item.sentiment === 'BEARISH' ? '▼' : '—'} {item.sentiment}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded border', categoryColor(item.category))}>
          {item.category.replace('_', ' ')}
        </span>
        {item.sector && (
          <span className="text-[10px] text-slate-400 font-bold">{item.sector}</span>
        )}
        {symbols.slice(0, 3).map(sym => (
          <button key={sym} onClick={() => onSelectStock(sym)}
            className="text-[10px] font-black text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded transition-colors">
            {sym}
          </button>
        ))}
        <span className="text-[10px] text-slate-400 ml-auto">{item.source}{item.published_at ? ` · ${timeAgo(item.published_at)}` : ''}</span>
      </div>
    </div>
  );
}

// ─── Sentiment Timeline Chart ─────────────────────────────────────────────────

function SentimentTimeline({ history }: { history: Snapshot[] }) {
  if (history.length < 2) return null;

  const data = history.map(h => ({
    time: new Date(h.snapshot_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    score: Math.round(h.overall_score),
    bullish: h.bullish_count,
    bearish: h.bearish_count,
  }));

  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-950/30 p-4">
      <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Sentiment Timeline (24h)</p>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={data}>
          <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis domain={[-100, 100]} tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} width={28} />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
            labelStyle={{ color: '#94a3b8' }}
            formatter={(v: number) => [v > 0 ? `+${v}` : `${v}`, 'Score']}
          />
          <ReferenceLine y={0} stroke="#334155" strokeDasharray="3 3" />
          <ReferenceLine y={20}  stroke="#22c55e" strokeDasharray="2 2" opacity={0.3} />
          <ReferenceLine y={-20} stroke="#ef4444" strokeDasharray="2 2" opacity={0.3} />
          <Line
            type="monotone" dataKey="score"
            stroke="url(#sentimentGrad)" strokeWidth={2} dot={false}
          />
          <defs>
            <linearGradient id="sentimentGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#6366f1" />
              <stop offset="100%" stopColor="#22c55e" />
            </linearGradient>
          </defs>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Sector Sentiment Grid ────────────────────────────────────────────────────

function SectorSentimentGrid({ data }: {
  data: { sector: string; bullish: number; bearish: number; neutral: number; netScore: number }[]
}) {
  if (data.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-950/30 p-4">
      <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Sector Sentiment (8h)</p>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {data.slice(0, 12).map(s => {
          const total = s.bullish + s.bearish + s.neutral;
          const bullPct = total > 0 ? (s.bullish / total) * 100 : 0;
          const bearPct = total > 0 ? (s.bearish / total) * 100 : 0;
          const bias = s.netScore > 0 ? 'BULLISH' : s.netScore < 0 ? 'BEARISH' : 'NEUTRAL';
          return (
            <div key={s.sector} className={cn('rounded-lg border p-2',
              bias === 'BULLISH' ? 'border-emerald-500/20 bg-emerald-500/5'
              : bias === 'BEARISH' ? 'border-rose-500/20 bg-rose-500/5'
              : 'border-slate-800/50 bg-slate-950/20'
            )}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-bold text-slate-100 truncate">{s.sector}</span>
                <span className={cn('text-[10px] font-black',
                  bias === 'BULLISH' ? 'text-emerald-400' : bias === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'
                )}>
                  {bias === 'BULLISH' ? '▲' : bias === 'BEARISH' ? '▼' : '—'}
                  {Math.abs(s.netScore)}
                </span>
              </div>
              {/* Stacked bar */}
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden flex">
                <div className="bg-emerald-500 h-full" style={{ width: `${bullPct}%` }} />
                <div className="bg-rose-500 h-full"    style={{ width: `${bearPct}%` }} />
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[9.5px] text-emerald-400">{s.bullish}▲</span>
                <span className="text-[9.5px] text-slate-400">{s.neutral}—</span>
                <span className="text-[9.5px] text-rose-400">{s.bearish}▼</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Global Market Card ───────────────────────────────────────────────────────

function GlobalCueCard({ snapshot }: { snapshot: Snapshot }) {
  const { data: globalData } = trpc.getGlobalMarketData.useQuery(undefined, { refetchInterval: 5 * 60 * 1000 });

  const cueColor = snapshot.global_cue === 'Positive' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                 : snapshot.global_cue === 'Negative' ? 'text-rose-400 border-rose-500/30 bg-rose-500/10'
                 : 'text-amber-400 border-amber-500/30 bg-amber-500/10';

  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-950/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
          <Globe className="w-3.5 h-3.5" /> Global Cues
        </p>
        <span className={cn('text-xs font-black px-2 py-0.5 rounded-full border', cueColor)}>
          {snapshot.global_cue === 'Positive' ? '▲' : snapshot.global_cue === 'Negative' ? '▼' : '↔'} {snapshot.global_cue}
        </span>
      </div>

      {globalData && globalData.length > 0 ? (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {globalData.filter(d => !d.country?.toLowerCase().includes('india')).slice(0, 6).map(d => {
            const chg = parseFloat(d.change_per?.replace('%','') ?? '0');
            const pos = chg >= 0;
            return (
              <div key={d.symbol} className="bg-slate-800/40 rounded-lg p-2">
                <div className="text-[10px] text-slate-400 font-bold uppercase">{d.country}</div>
                <div className="text-xs font-bold text-slate-100 mt-0.5 tabular-nums">{d.current_price}</div>
                <div className={cn('text-[10px] font-bold', pos ? 'text-emerald-400' : 'text-rose-400')}>
                  {pos ? '▲' : '▼'} {Math.abs(chg).toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-400">Loading global market data…</p>
      )}

      <div className="text-[10px] text-slate-400">
        Avg global change: <span className={snapshot.global_score >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
          {snapshot.global_score >= 0 ? '+' : ''}{snapshot.global_score.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

// ─── Nifty Range Card ─────────────────────────────────────────────────────────

function NiftyRangeCard({ snapshot }: { snapshot: Snapshot }) {
  const biasColor = snapshot.nifty_bias === 'Bullish' ? 'text-emerald-400'
                  : snapshot.nifty_bias === 'Bearish' ? 'text-rose-400' : 'text-amber-400';
  const biasIcon  = snapshot.nifty_bias === 'Bullish' ? <TrendingUp className="w-4 h-4" />
                  : snapshot.nifty_bias === 'Bearish' ? <TrendingDown className="w-4 h-4" /> : <Minus className="w-4 h-4" />;

  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-950/30 p-4">
      <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
        <Activity className="w-3.5 h-3.5" /> Nifty Outlook (News-Driven)
      </p>
      <div className="flex items-center gap-3 mb-4">
        <span className={cn('flex items-center gap-1.5 text-lg font-black', biasColor)}>
          {biasIcon} {snapshot.nifty_bias}
        </span>
        {snapshot.nifty_last_close && (
          <span className="text-sm text-slate-400 font-bold">
            Last: <span className="text-white">{snapshot.nifty_last_close.toLocaleString('en-IN')}</span>
          </span>
        )}
      </div>

      {snapshot.nifty_support && snapshot.nifty_resistance && (
        <div className="space-y-2">
          {/* Visual range bar */}
          <div className="relative h-6 bg-slate-800 rounded-lg overflow-hidden">
            <div className="absolute inset-y-0 left-[10%] right-[10%] bg-gradient-to-r from-rose-500/20 via-emerald-500/20 to-emerald-500/30 rounded" />
            {snapshot.nifty_last_close && snapshot.nifty_support && snapshot.nifty_resistance && (
              <div className="absolute inset-y-0 w-0.5 bg-white"
                style={{
                  left: `${Math.max(10, Math.min(90, 10 + ((snapshot.nifty_last_close - snapshot.nifty_support) / (snapshot.nifty_resistance - snapshot.nifty_support)) * 80))}%`
                }} />
            )}
          </div>
          <div className="flex justify-between text-xs">
            <div className="text-center">
              <div className="text-[10px] text-slate-400 font-bold uppercase">Support</div>
              <div className="font-black text-rose-400">{snapshot.nifty_support.toLocaleString('en-IN')}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-slate-400 font-bold uppercase">Resistance</div>
              <div className="font-black text-emerald-400">{snapshot.nifty_resistance.toLocaleString('en-IN')}</div>
            </div>
          </div>
        </div>
      )}

      <p className="text-[10px] text-slate-400 mt-3">
        Range derived from news sentiment score ({snapshot.overall_score > 0 ? '+' : ''}{snapshot.overall_score.toFixed(0)}) + global cue ({snapshot.global_cue}). Not a price forecast — DYOR.
      </p>
    </div>
  );
}

// ─── Corporate Events Panel ───────────────────────────────────────────────────

function CorporateEventsPanel({ onSelectStock }: { onSelectStock: (s: string) => void }) {
  const { data: events } = trpc.getCorporateEventNews.useQuery(undefined, { refetchInterval: 15 * 60 * 1000 });

  const categoryIcons: Record<string, React.ReactNode> = {
    EARNINGS:  <BarChart2 className="w-3 h-3" />,
    ORDER_WIN: <ChevronRight className="w-3 h-3" />,
    BUYBACK:   <ShoppingBag className="w-3 h-3" />,
    IPO:       <Zap className="w-3 h-3" />,
  };

  if (!events || events.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-950/30 p-4 space-y-3">
      <p className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
        <Building2 className="w-3.5 h-3.5" /> Corporate Events (24h)
      </p>
      <div className="space-y-2">
        {events.slice(0, 10).map(e => {
          const symbols: string[] = (() => { try { return JSON.parse(e.symbols_json ?? '[]'); } catch { return []; } })();
          return (
            <div key={e.id} className={cn('flex items-start gap-3 rounded-lg px-3 py-2 border', categoryColor(e.category as string))}>
              <span className="shrink-0 mt-0.5">{categoryIcons[e.category as string] ?? <Newspaper className="w-3 h-3" />}</span>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-semibold text-white line-clamp-2">{e.title}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-slate-400">{e.source}</span>
                  {symbols.slice(0, 2).map(sym => (
                    <button key={sym} onClick={() => onSelectStock(sym)}
                      className="text-[10px] font-black text-indigo-400 hover:text-indigo-300">
                      {sym} →
                    </button>
                  ))}
                </div>
              </div>
              <span className={cn('text-[10px] font-bold shrink-0', sentimentBadge(e.sentiment))}>
                {e.sentiment === 'BULLISH' ? '▲' : e.sentiment === 'BEARISH' ? '▼' : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const NEWS_TABS: { key: NewsCategory | 'ALL'; label: string }[] = [
  { key: 'ALL',       label: 'All' },
  { key: 'EARNINGS',  label: 'Earnings' },
  { key: 'ORDER_WIN', label: 'Orders & Deals' },
  { key: 'BUYBACK',   label: 'Buyback' },
  { key: 'POLICY',    label: 'Policy & Macro' },
  { key: 'GLOBAL',    label: 'Global' },
  { key: 'IPO',       label: 'IPO' },
];

export function SentimentIntelligence({ onSelectStock }: { onSelectStock: (symbol: string) => void }) {
  const [newsTab, setNewsTab]       = useState<NewsCategory | 'ALL'>('ALL');
  const [sourceFilter, setSource]   = useState<SourceType>('ALL');
  const [sentFilter, setSentFilter] = useState<NewsSentiment>('ALL');

  const { data: sentimentData, isLoading: sentLoading, refetch: refetchSent } =
    trpc.getMarketSentiment.useQuery({ historyHours: 24 }, { refetchInterval: 30 * 1000 });

  const { data: newsData, isLoading: newsLoading, refetch: refetchNews } =
    trpc.getNewsItems.useQuery(
      { limit: 80, category: newsTab, sentiment: sentFilter, sourceType: sourceFilter, hours: 8 },
      { refetchInterval: 30 * 1000 }
    );

  const { data: sectorSentiment } = trpc.getSectorNewsSentiment.useQuery(
    undefined, { refetchInterval: 30 * 1000 }
  );

  const refresh = trpc.refreshNewsSentiment.useMutation({
    onSuccess: () => { refetchSent(); refetchNews(); }
  });

  const snapshot = sentimentData?.latest as Snapshot | null | undefined;
  const history  = (sentimentData?.history ?? []) as Snapshot[];
  const newsItems = (newsData ?? []) as NewsItem[];

  const themes: string[] = useMemo(() => {
    try { return JSON.parse(snapshot?.key_themes_json ?? '[]'); } catch { return []; }
  }, [snapshot?.key_themes_json]);

  return (
    <div className="p-4 md:p-6 space-y-5">

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black text-white tracking-tight flex items-center gap-2">
            <Newspaper className="w-6 h-6 text-indigo-400" />
            Market Sentiment Intelligence
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            Live news from 16+ sources · Refreshes every 30 seconds · Earnings, orders, policy, global cues
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {refresh.isPending && (
            <div className="flex items-center gap-2 text-xs text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 rounded-xl px-3 py-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Refreshing…
            </div>
          )}
          <button onClick={() => { refetchSent(); refetchNews(); }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold bg-slate-800 border border-slate-800/30 text-slate-400 hover:text-white transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:text-indigo-100 disabled:opacity-50 transition-colors">
            <Zap className="w-4 h-4" />
            Force Refresh
          </button>
        </div>
      </div>

      {sentLoading && !snapshot && (
        <div className="flex items-center justify-center py-20 gap-3 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading sentiment data…</span>
        </div>
      )}

      {!sentLoading && !snapshot && (
        <div className="flex flex-col items-center py-16 gap-4 text-center">
          <AlertCircle className="w-12 h-12 text-slate-300" />
          <p className="text-slate-100 font-bold">No sentiment data yet</p>
          <p className="text-slate-400 text-sm max-w-sm">
            The sentiment engine fetches news automatically every 30 seconds. Click "Force Refresh" to run it now.
          </p>
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-50">
            {refresh.isPending ? 'Running…' : 'Run Now'}
          </button>
        </div>
      )}

      {snapshot && (
        <>
          {/* Top stats row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

            {/* Sentiment Gauge */}
            <div className="rounded-2xl border border-slate-800/50 bg-slate-900/40 p-4 flex flex-col items-center gap-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Market Mood</p>
              <SentimentGauge score={snapshot.overall_score} />
              <div className="grid grid-cols-3 gap-3 w-full mt-1">
                <div className="text-center">
                  <div className="text-[10px] text-emerald-500 font-bold uppercase">Bullish</div>
                  <div className="text-lg font-black text-emerald-400">{snapshot.bullish_count}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Neutral</div>
                  <div className="text-lg font-black text-slate-400">{snapshot.neutral_count}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-rose-500 font-bold uppercase">Bearish</div>
                  <div className="text-lg font-black text-rose-400">{snapshot.bearish_count}</div>
                </div>
              </div>
              {snapshot.high_impact_count > 0 && (
                <div className="flex items-center gap-1.5 text-[10px] text-amber-400 font-bold bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1 w-full justify-center">
                  <AlertCircle className="w-3 h-3" />
                  {snapshot.high_impact_count} high-impact news today
                </div>
              )}
            </div>

            {/* Nifty Range */}
            <NiftyRangeCard snapshot={snapshot} />

            {/* Global Cues */}
            <GlobalCueCard snapshot={snapshot} />
          </div>

          {/* Key Themes */}
          {themes.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Today's Themes:</span>
              {themes.map(t => (
                <span key={t} className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', categoryColor(t as string))}>
                  {t.replace('_', ' ')}
                </span>
              ))}
              <span className="text-[10px] text-slate-400 ml-auto">
                Based on {snapshot.source_count} articles ·{' '}
                {snapshot.snapshot_at && timeAgo(snapshot.snapshot_at)}
              </span>
            </div>
          )}

          {/* Sentiment Timeline */}
          <SentimentTimeline history={history} />

          {/* Sector Sentiment */}
          {sectorSentiment && sectorSentiment.length > 0 && (
            <SectorSentimentGrid data={sectorSentiment as { sector: string; bullish: number; bearish: number; neutral: number; netScore: number }[]} />
          )}

          {/* Corporate Events */}
          <CorporateEventsPanel onSelectStock={onSelectStock} />

          {/* News Feed */}
          <div className="space-y-3">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-none">
                {NEWS_TABS.map(tab => (
                  <button key={tab.key} onClick={() => setNewsTab(tab.key)}
                    className={cn('px-3 py-1.5 rounded-lg text-xs font-bold border whitespace-nowrap transition-colors',
                      newsTab === tab.key
                        ? 'bg-indigo-600 border-indigo-500 text-white'
                        : 'bg-slate-800 border-slate-800/30 text-slate-400 hover:text-white'
                    )}>
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Source + sentiment filters */}
              <div className="flex items-center gap-2 ml-auto shrink-0">
                {(['ALL', 'INDIAN', 'GLOBAL'] as SourceType[]).map(s => (
                  <button key={s} onClick={() => setSource(s)}
                    className={cn('px-2 py-1 rounded text-[10px] font-bold border transition-colors',
                      sourceFilter === s ? 'bg-slate-700 border-slate-600 text-white' : 'border-slate-800/50 text-slate-400 hover:text-white'
                    )}>
                    {s === 'ALL' ? '🌐 All' : s === 'INDIAN' ? '🇮🇳 India' : '🌍 Global'}
                  </button>
                ))}
                <div className="w-px h-4 bg-slate-700" />
                {(['ALL', 'BULLISH', 'BEARISH'] as NewsSentiment[]).map(s => (
                  <button key={s} onClick={() => setSentFilter(s)}
                    className={cn('px-2 py-1 rounded text-[10px] font-bold border transition-colors',
                      sentFilter === s ? 'bg-slate-700 border-slate-600 text-white' : 'border-slate-800/50 text-slate-400 hover:text-white'
                    )}>
                    {s === 'ALL' ? 'All' : s === 'BULLISH' ? '▲ Bull' : '▼ Bear'}
                  </button>
                ))}
              </div>
            </div>

            {newsLoading && newsItems.length === 0 && (
              <div className="flex items-center justify-center py-12 gap-3 text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading news…</span>
              </div>
            )}

            {!newsLoading && newsItems.length === 0 && (
              <div className="text-center py-12 text-slate-400 text-sm">
                No news matching current filters in the last 8 hours.
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {newsItems.slice(0, 40).map(item => (
                <NewsCard key={item.id} item={item} onSelectStock={onSelectStock} />
              ))}
            </div>
          </div>

          <p className="text-[10px] text-slate-300 text-center">
            ⚠️ News sentiment is AI-assisted keyword analysis and may contain errors. Not SEBI-registered investment advice. Always verify from primary sources.
          </p>
        </>
      )}
    </div>
  );
}
