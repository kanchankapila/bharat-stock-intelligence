import { relativeFromNow } from '../lib/timeFormat';

/** One-line provenance for a data page: where the numbers come from and how old they are. */
export function AsOfLine({ source, fetchedAt, dataDate, className }: {
  source: string; fetchedAt: number | null | undefined; dataDate?: string | null; className?: string;
}) {
  return (
    <p className={className ?? 'text-[10px] text-slate-500'}>
      Source: {source}
      {dataDate ? ` · data ${String(dataDate).slice(0, 10)}` : ''}
      {' · '}{fetchedAt ? `fetched ${relativeFromNow(fetchedAt)}` : 'not fetched yet'}
    </p>
  );
}
