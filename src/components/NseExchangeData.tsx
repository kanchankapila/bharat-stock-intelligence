import React from 'react';
import { trpc } from '../lib/trpc';
import { formatIST } from '../lib/timeFormat';
import { istDate, safeNewsUrl } from '../lib/intelligenceDisplay';

// Exchange-published data with no score attached. Colours are inherited (opacity only) so the same
// panels read correctly inside both the v1 and v5 card styles.

type PanelProps = { className?: string };

const Panel = ({ title, meta, className, children }: PanelProps & { title: string; meta?: string; children: React.ReactNode }) => (
  <section className={className ?? 'v1-card p-4'}>
    <h3 className="text-sm font-semibold">{title}</h3>
    {meta && <p className="mb-2 text-[11px] opacity-60">{meta}</p>}
    {children}
  </section>
);

const Note = ({ children }: { children: React.ReactNode }) => <p className="text-xs opacity-70">{children}</p>;

const captured = (at: unknown) => (at ? ` · captured ${formatIST(at as string)}` : '');

const stateNote = (q: { isLoading: boolean; isError: boolean }) =>
  q.isLoading ? <Note>Loading…</Note> : q.isError ? <Note>Could not load this data.</Note> : null;

// The list is published for the next trade date, so anything dated before today is no longer current.
const useBanList = () => {
  const q = trpc.getFnoBanList.useQuery(undefined, { staleTime: 900_000 });
  return { q, data: q.data, current: !!q.data?.tradeDate && q.data.tradeDate >= istDate() };
};

export function FnoBanBadge({ symbol }: { symbol: string }) {
  const { data, current } = useBanList();
  if (!current || !data!.symbols.includes(symbol.toUpperCase())) return null;
  return (
    <span
      title={`NSE ban list for trade date ${data!.tradeDate}: no new F&O positions`}
      className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs font-bold text-rose-500"
    >
      F&O ban · {data!.tradeDate}
    </span>
  );
}

export function FnoBanList({ className, onSelectStock }: PanelProps & { onSelectStock?: (symbol: string) => void }) {
  const { q, data, current } = useBanList();
  return (
    <Panel title="F&O ban list" className={className} meta={`Source: NSE${current ? ` · for trade date ${data!.tradeDate}` : ''}${captured(data?.fetchedAt)}`}>
      {stateNote(q) ?? (current ? (
        <>
          <div className="flex flex-wrap gap-2">
            {data!.symbols.map(sym => (
              <button key={sym} type="button" onClick={() => onSelectStock?.(sym)} className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs font-bold text-rose-500">
                {sym}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] opacity-60">No new F&O positions may be opened in these stocks.</p>
        </>
      ) : (
        <Note>
          No current list. {data?.tradeDate ? `The newest stored list is for ${data.tradeDate}; ` : 'Nothing is stored yet; '}
          a day with no banned stocks stores nothing, so check NSE before relying on this.
        </Note>
      ))}
    </Panel>
  );
}

const contracts = (v: number | null, signed = true) =>
  v == null ? '—' : `${signed && v > 0 ? '+' : ''}${v.toLocaleString('en-IN')}`;
const tone = (v: number | null) => (v == null || v === 0 ? '' : v > 0 ? 'text-emerald-500' : 'text-rose-500');

export function ParticipantPositions({ className }: PanelProps) {
  const q = trpc.getParticipantPositions.useQuery(undefined, { staleTime: 900_000 });
  const data = q.data;
  const cell = (v: number | null) => <td className={`px-2 py-1 text-right tabular-nums ${tone(v)}`}>{contracts(v)}</td>;
  return (
    <Panel
      title="Participant-wise F&O open interest"
      className={className}
      meta={`Source: NSE · net long minus short, in contracts${data?.date ? ` · as of ${data.date}, change vs ${data.prevDate ?? '—'}` : ''}${captured(data?.fetchedAt)}`}
    >
      {stateNote(q) ?? (!data?.rows.length ? <Note>No participant data stored.</Note> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="opacity-60">
              <tr>
                {['Participant', 'Index futures', 'Change', 'Long share', 'Stock futures', 'Change', 'Index calls', 'Index puts'].map((h, i) => (
                  <th key={i} className={`px-2 py-1 ${i ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.participant} className="border-t border-slate-500/20">
                  <td className="px-2 py-1 font-semibold">{r.participant}</td>
                  {cell(r.idxFutNet)}
                  {cell(r.idxFutNetChange)}
                  <td className="px-2 py-1 text-right tabular-nums">{r.idxFutLongPct == null ? '—' : `${r.idxFutLongPct}%`}</td>
                  {cell(r.stkFutNet)}
                  {cell(r.stkFutNetChange)}
                  {cell(r.idxCallNet)}
                  {cell(r.idxPutNet)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Panel>
  );
}

export function CompanyAnnouncements({ symbol, className, onSelectStock }: PanelProps & { symbol?: string; onSelectStock?: (symbol: string) => void }) {
  const q = trpc.getCompanyAnnouncements.useQuery({ symbol, limit: 30 }, { staleTime: 900_000 });
  const rows = q.data ?? [];
  const newest = rows.reduce<unknown>((max, r) => (!max || new Date(r.fetched_at) > new Date(max as string) ? r.fetched_at : max), null);
  return (
    <Panel title={symbol ? `NSE filings — ${symbol}` : 'Latest NSE filings'} className={className} meta={`Source: NSE corporate announcements${captured(newest)}`}>
      {stateNote(q) ?? (!rows.length ? <Note>No NSE filings stored{symbol ? ` for ${symbol}` : ''}.</Note> : (
        <ul className="max-h-96 space-y-2 overflow-y-auto">
          {rows.map(r => {
            const url = r.attachment_url ? safeNewsUrl(r.attachment_url) : undefined;
            return (
              <li key={r.seq_id} className="rounded-lg border border-slate-500/20 p-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold">
                    {!symbol && <button type="button" onClick={() => onSelectStock?.(r.symbol)} className="mr-2 text-emerald-500">{r.symbol}</button>}
                    {r.category ?? 'Announcement'}
                  </span>
                  <span className="opacity-60">{formatIST(r.disseminated_at as unknown as string)}</span>
                </div>
                {r.summary && <p className="mt-1 line-clamp-3 text-xs opacity-80">{r.summary}</p>}
                {url && <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[11px] text-emerald-500 hover:underline">View filing →</a>}
              </li>
            );
          })}
        </ul>
      ))}
    </Panel>
  );
}
