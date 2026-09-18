import React from 'react';
import { Newspaper, RefreshCw, ExternalLink, Search, Globe } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { safeNewsUrl, decodeHtmlEntities, stripHtmlToText } from '../lib/intelligenceDisplay';
import { V1PageFrame } from './v1/V1PageFrame';
import { MetricTile } from './MetricTile';
import { DataHealthChip } from './DataHealthChip';
import { QueryError } from './IntelligenceQueryError';
import { DataTable, type Column } from './DataTable';
import { TabBar, type TabItem } from './TabBar';
import { MarketMoodGauge } from './MarketMoodGauge';

const NEWS_TABS: TabItem[] = [
  { id: 'headlines', label: 'Headlines', icon: Newspaper },
  { id: 'sector', label: 'Sector Sentiment', icon: Globe },
  { id: 'mood', label: 'Market Mood' },
];

type SectorRow = { sector: string; bullish: number; bearish: number; neutral: number; netScore: number };

function SectorSentimentTab() {
  const query = trpc.getSectorNewsSentiment.useQuery(undefined, { staleTime: 300_000 });
  const rows = (Array.isArray(query.data) ? query.data : []) as SectorRow[];
  const columns: Column<SectorRow>[] = [
    { key: 'sector', label: 'Sector' },
    { key: 'bullish', label: 'Bullish', sortable: true },
    { key: 'neutral', label: 'Neutral', sortable: true },
    { key: 'bearish', label: 'Bearish', sortable: true },
    { key: 'netScore', label: 'Net', sortable: true, render: (r) => (
      <span className={r.netScore > 0 ? 'text-emerald-300' : r.netScore < 0 ? 'text-rose-300' : 'text-slate-400'}>
        {r.netScore > 0 ? `+${r.netScore}` : r.netScore}
      </span>
    ) },
  ];
  return (
    <div className="space-y-4">
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      {query.isLoading ? (
        <p role="status" className="py-12 text-center text-slate-400">Loading sector sentiment…</p>
      ) : rows.length === 0 ? (
        <p role="status" className="py-12 text-center text-slate-400">No sector-tagged headlines in the last 8 hours.</p>
      ) : (
        <DataTable data={rows} columns={columns} rowKey={(r) => r.sector} emptyMessage="No sector-tagged headlines." />
      )}
      <p className="bsi-intel-note">Counts are sector-tagged headlines from the last 8 hours; net = bullish − bearish, sorted by absolute net. A thin sample is a thin sample — no smoothing is applied.</p>
    </div>
  );
}

function MarketMoodTab() {
  return (
    <div className="space-y-4">
      <div className="bsi-kpi max-w-sm"><MarketMoodGauge /></div>
      <p className="bsi-intel-note">Tickertape's Market Mood Index (fear/greed, 0–100), fetched daily into macro_asset_prices and already consumed by the ML macro features and regime detector. A context gauge — explicitly not a trading signal on its own.</p>
    </div>
  );
}

export default function NewsIntelligenceHub() {
  const [sentiment, setSentiment] = React.useState<'ALL' | 'BULLISH' | 'BEARISH' | 'NEUTRAL'>('ALL');
  const [sourceType, setSourceType] = React.useState<'ALL' | 'INDIAN' | 'GLOBAL'>('ALL');
  const [hours, setHours] = React.useState(24);
  const [search, setSearch] = React.useState('');
  const [tab, setTab] = React.useState('headlines');
  const query = trpc.getNewsItems.useQuery({ limit: 200, category: 'ALL', sentiment, sourceType, hours }, { staleTime: 300_000 });
  const rows = (query.data ?? []).filter(row => `${row.title} ${row.summary ?? ''} ${row.source}`.toLowerCase().includes(search.trim().toLowerCase()));
  const latest = rows.reduce<string | null>((date, row) => !date || new Date(row.fetched_at) > new Date(date) ? row.fetched_at : date, null);
  return <V1PageFrame title="News Intelligence" kicker="MARKET WIRE / CONTEXT BEFORE CONVICTION">
    <div className="bsi-intel-hero"><div><span className="bsi-intel-eyebrow">02 / THE MARKET WIRE</span><h2 className="font-display text-2xl sm:text-3xl mt-2">Read the context. Not just the move.</h2><p className="bsi-intel-note mt-2">Source-linked headlines with stored sentiment and impact labels.</p></div><Newspaper size={44} className="text-amber-400 shrink-0" aria-hidden="true" /></div>
    <TabBar tabs={NEWS_TABS} active={tab} onChange={setTab} />
    {tab === 'headlines' && (<>
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      <MetricTile label="Matching headlines" value={rows.length} loading={query.isLoading} icon={<Newspaper size={16} />} />
      <MetricTile label="Bullish labels" value={rows.filter(row => row.sentiment === 'BULLISH').length} direction="up" loading={query.isLoading} />
      <MetricTile label="Bearish labels" value={rows.filter(row => row.sentiment === 'BEARISH').length} direction="down" loading={query.isLoading} />
      <MetricTile label="High impact labels" value={rows.filter(row => row.impact === 'HIGH').length} loading={query.isLoading} />
    </div>
    <div className="bsi-intel-panel space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="bsi-intel-note flex-1 min-w-40">Search loaded headlines<div className="relative mt-1"><Search size={14} className="absolute left-3 top-3" aria-hidden="true" /><input className="bsi-control w-full pl-9" value={search} onChange={e => setSearch(e.target.value)} placeholder="Company, headline or source" /></div></label>
        <label className="bsi-intel-note">Sentiment<select className="bsi-control block mt-1" value={sentiment} onChange={e => setSentiment(e.target.value as typeof sentiment)}>{['ALL', 'BULLISH', 'BEARISH', 'NEUTRAL'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="bsi-intel-note">Coverage<select className="bsi-control block mt-1" value={sourceType} onChange={e => setSourceType(e.target.value as typeof sourceType)}>{['ALL', 'INDIAN', 'GLOBAL'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="bsi-intel-note">Window<select className="bsi-control block mt-1" value={hours} onChange={e => setHours(Number(e.target.value))}>{[8, 24, 72].map(value => <option key={value} value={value}>{value} hours</option>)}</select></label>
        <button type="button" className="bsi-action" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={14} />{query.isFetching ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <div className="flex flex-wrap justify-between gap-2"><p className="bsi-intel-note">Counts describe this filtered sample (maximum 200), not the entire market.</p><DataHealthChip lastUpdated={latest} staleThresholdMinutes={240} /></div>
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      {query.isLoading ? <p role="status" className="py-12 text-center text-slate-400">Loading market wire…</p> : rows.length === 0 ? <p role="status" className="py-12 text-center text-slate-400">No headlines match these filters. Try a wider window or clear your search.</p> : <div className="grid gap-4 lg:grid-cols-2">{rows.map(row => {
        const url = safeNewsUrl(row.url);
        return <article key={row.id} className="bsi-news-card"><div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-wider"><span className="text-amber-300">{row.source}</span><span className="text-slate-400">{row.category} / {row.source_type}</span></div><h3 className="font-display text-base leading-relaxed mt-3">{url ? <a href={url} target="_blank" rel="noopener noreferrer" className="hover:text-amber-300">{decodeHtmlEntities(row.title)}<ExternalLink size={12} className="inline ml-2" aria-label="Opens in new tab" /></a> : decodeHtmlEntities(row.title)}</h3><p className="bsi-intel-note mt-2 line-clamp-3">{stripHtmlToText(row.summary)}</p><div className="flex flex-wrap justify-between gap-2 mt-4 text-xs"><span className={row.sentiment === 'BULLISH' ? 'text-emerald-300' : row.sentiment === 'BEARISH' ? 'text-rose-300' : 'text-slate-400'}>{row.sentiment} · {row.impact} impact</span><time dateTime={row.published_at} className="text-slate-400">{new Date(row.published_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</time></div></article>;
      })}</div>}
    </div>
    </>)}
    {tab === 'sector' && (
      <section role="tabpanel" aria-label="Sector Sentiment" className="bsi-intel-panel min-w-0">
        <SectorSentimentTab />
      </section>
    )}
    {tab === 'mood' && (
      <section role="tabpanel" aria-label="Market Mood" className="bsi-intel-panel min-w-0">
        <MarketMoodTab />
      </section>
    )}
    <p className="bsi-intel-note">Automated sentiment labels may be wrong. Read the original source before acting. NOT FINANCIAL ADVICE.</p>
  </V1PageFrame>;
}
