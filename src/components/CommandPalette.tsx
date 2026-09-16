import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, CornerDownLeft, ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { nseStocksData } from '../data/nseStocks';
import type { MarketData } from '../services/marketService';

interface NavItem { icon: React.ElementType; label: string; id: string; }
interface NavGroup { label: string; items: NavItem[]; }

type PaletteResult =
  | { kind: 'nav'; id: string; label: string; group: string; icon: React.ElementType }
  | { kind: 'stock'; symbol: string; name: string; changePct: number | null };

interface CommandPaletteProps {
  navGroups: NavGroup[];
  onNavigate: (id: string) => void;
  onSelectStock: (symbol: string) => void;
  stocks: MarketData[];
}

// Global keyboard-driven navigation, extending the existing "/" stock-only search to also
// jump to any page by name -- addresses the "clicking through a 40-item sidebar is slow"
// finding from the original UX audit. Cmd+K / Ctrl+K opens it from anywhere in the app.
export const CommandPalette: React.FC<CommandPaletteProps> = ({ navGroups, onNavigate, onSelectStock, stocks }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => { setOpen(false); setQuery(''); setActiveIndex(0); };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isPaletteShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isPaletteShortcut) {
        e.preventDefault();
        setOpen(o => {
          const next = !o;
          if (next) setTimeout(() => inputRef.current?.focus(), 30);
          else { setQuery(''); setActiveIndex(0); }
          return next;
        });
        return;
      }
      if (e.key === 'Escape' && open) { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const stockPriceMap = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of stocks) m.set(s.symbol, s.changePct ?? null);
    return m;
  }, [stocks]);

  const results: PaletteResult[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const navResults: PaletteResult[] = navGroups.flatMap(group =>
      group.items
        .filter(item => q === '' || item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q))
        .map(item => ({ kind: 'nav' as const, id: item.id, label: item.label, group: group.label, icon: item.icon })),
    );

    const stockResults: PaletteResult[] = q.length < 2 ? [] : nseStocksData
      .filter(s => s.symbol?.toLowerCase().includes(q) || s.name?.toLowerCase().includes(q))
      .slice(0, 6)
      .map(s => ({ kind: 'stock' as const, symbol: s.symbol, name: s.name, changePct: stockPriceMap.get(s.symbol) ?? null }));

    // Pages first (most common intent: "get me to a screen"), then stocks -- and cap pages
    // to a sane count once a query narrows things down, so the list doesn't dwarf the stock
    // matches when someone's clearly typing a ticker.
    return [...navResults.slice(0, q ? 8 : 40), ...stockResults];
  }, [query, navGroups, stockPriceMap]);

  useEffect(() => { setActiveIndex(0); }, [query]);

  const select = (r: PaletteResult) => {
    if (r.kind === 'nav') onNavigate(r.id);
    else onSelectStock(r.symbol);
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[activeIndex]) select(results[activeIndex]); }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[12vh]"
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: -10 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-lg mx-4 bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800/60">
              <Search className="w-4 h-4 text-slate-500 shrink-0" />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Jump to a page or search a stock..."
                className="flex-1 bg-transparent text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none"
              />
              <kbd className="text-[9px] font-bold text-slate-500 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5">ESC</kbd>
            </div>

            <div className="max-h-[50vh] overflow-y-auto py-1.5">
              {results.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-slate-500">No matches — try a page name or a stock symbol.</p>
              ) : (
                results.map((r, i) => {
                  const active = i === activeIndex;
                  return (
                    <button
                      key={r.kind === 'nav' ? `nav-${r.id}` : `stock-${r.symbol}`}
                      onClick={() => select(r)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(
                        'w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors',
                        active ? 'bg-indigo-600/20' : 'hover:bg-slate-800/50',
                      )}
                    >
                      {r.kind === 'nav' ? (
                        <>
                          <span className="flex items-center gap-2.5 min-w-0">
                            <r.icon className={cn('w-3.5 h-3.5 shrink-0', active ? 'text-indigo-400' : 'text-slate-500')} />
                            <span className="text-xs font-semibold text-slate-200 truncate">{r.label}</span>
                          </span>
                          <span className="text-[9px] font-bold text-slate-600 font-display uppercase tracking-wider shrink-0">{r.group}</span>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0">
                            <span className="text-xs font-bold text-slate-200">{r.symbol}</span>
                            <span className="text-[10px] text-slate-500 ml-2 truncate">{r.name}</span>
                          </span>
                          <span className={cn('text-[10px] font-bold tabular-nums shrink-0', r.changePct == null ? 'text-slate-500' : r.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                            {r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${r.changePct.toFixed(2)}%`}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-800/60 text-[9px] text-slate-500">
              <span className="flex items-center gap-1"><ArrowUp className="w-2.5 h-2.5" /><ArrowDown className="w-2.5 h-2.5" /> navigate</span>
              <span className="flex items-center gap-1"><CornerDownLeft className="w-2.5 h-2.5" /> select</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default CommandPalette;
