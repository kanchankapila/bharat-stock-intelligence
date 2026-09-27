import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

/**
 * Command-palette stock search (Ctrl/⌘+K).
 *
 * Backed by the platform's own NSE master rather than a hardcoded list, so a
 * newly-listed symbol is findable the day it syncs.
 */
export function SymbolSearch() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
      // rAF so the input exists and is laid out before we focus it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // No input — the procedure ignores it and returns the full NSE master, so the
  // whole list is fetched once per session and filtered client-side (⌘K keystroke
  // latency has to be zero; a round-trip per character would not be).
  const { data } = trpc.getAllNSEStocks.useQuery(undefined, {
    enabled: open,
    staleTime: 30 * 60_000,
  });
  const stocks: any[] = (data as any)?.stocks ?? [];

  const results = stocks
    .filter((s) => {
      if (!q.trim() || s?.status === 'DELISTED') return false;
      const t = q.trim().toUpperCase();
      return String(s.symbol ?? '').toUpperCase().includes(t) || String(s.name ?? '').toUpperCase().includes(t);
    })
    // Symbol-prefix matches first, then name matches. Someone typing "RE" wants
    // RELIANCE before REALTECH, and a plain substring sort gets that backwards.
    .sort((a, b) => {
      const t = q.trim().toUpperCase();
      const ap = String(a.symbol ?? '').toUpperCase().startsWith(t) ? 0 : 1;
      const bp = String(b.symbol ?? '').toUpperCase().startsWith(t) ? 0 : 1;
      return ap - bp || String(a.symbol).localeCompare(String(b.symbol));
    })
    .slice(0, 40);

  const go = (symbol: string) => {
    setOpen(false);
    navigate(`/tala/stock/${encodeURIComponent(symbol)}`);
  };


  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(true)}
        className="flex h-7 items-center gap-1.5 rounded border border-line-2 bg-white/[0.03] px-2 text-mark-3 transition-colors hover:border-line-3 hover:text-mark-2"
        aria-label="Search stocks (Ctrl+K)"
      >
        <Search size={11} />
        <span className="hidden font-mono text-[10px] lg:inline">Search</span>
        <kbd className="hidden rounded border border-line-2 px-1 font-mono text-[9px] lg:inline">⌘K</kbd>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-50 bg-ink-950/70 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <div className="fixed top-[14vh] left-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-line-3 bg-ink-850 shadow-2xl shadow-black/60">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <Search size={14} className="shrink-0 text-marigold" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCursor((c) => Math.min(c + 1, results.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCursor((c) => Math.max(c - 1, 0));
                  } else if (e.key === 'Enter' && results[cursor]) {
                    e.preventDefault();
                    go(results[cursor].symbol);
                  }
                }}
                placeholder="Search 2,000+ NSE symbols or company names…"
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-mark placeholder:text-mark-4 focus:outline-none"
              />
              <kbd className="shrink-0 rounded border border-line-2 px-1 font-mono text-[9px] text-mark-4">ESC</kbd>
            </div>

            <div className="tala-scroll max-h-[46vh] overflow-y-auto">
              {!q.trim() ? (
                <p className="px-3 py-6 text-center text-[11px] text-mark-4">
                  Type a ticker (RELIANCE) or a company name to open the full stock desk.
                </p>
              ) : results.length === 0 ? (
                <p className="px-3 py-6 text-center text-[11px] text-mark-4">
                  No symbol matches “{q}” in the NSE master.
                </p>
              ) : (
                results.map((s: any, i: number) => (
                  <button
                    key={s.symbol}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(s.symbol)}
                    className={cn(
                      'flex w-full items-center gap-3 border-b border-line/50 px-3 py-2 text-left transition-colors',
                      i === cursor ? 'bg-marigold/[0.08]' : 'hover:bg-white/[0.03]',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="tnum font-mono text-[12px] font-semibold text-marigold">{s.symbol}</span>
                        <span className="truncate text-[11px] text-mark-2">{s.name}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-mark-4">
                        {s.sector && <span>{s.sector}</span>}
                        {s.industry && s.industry !== s.sector && <span>· {s.industry}</span>}
                      </div>
                    </div>
                    {i === cursor && <CornerDownLeft size={12} className="shrink-0 text-mark-4" />}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
