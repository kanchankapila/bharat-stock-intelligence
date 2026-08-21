import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft, ArrowUpRight, ArrowDownRight, TrendingUp, TrendingDown,
  ChevronLeft, ChevronRight, Search, Users, BarChart2, Briefcase,
  RefreshCw, Star, AlertCircle, ChevronDown, ChevronUp,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';

// ─── Quarter helpers ──────────────────────────────────────────────────────────
function getLatestCompletedQuarter(): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  if (month <= 3) return `${year - 1}12`;
  if (month <= 6) return `${year}03`;
  if (month <= 9) return `${year}06`;
  return `${year}09`;
}

function generateQuarters(count = 8): string[] {
  const quarters: string[] = [];
  let q = getLatestCompletedQuarter();
  for (let i = 0; i < count; i++) {
    quarters.push(q);
    q = prevQuarter(q);
  }
  return quarters;
}

function prevQuarter(q: string): string {
  const year = parseInt(q.slice(0, 4));
  const month = parseInt(q.slice(4));
  if (month === 3) return `${year - 1}12`;
  if (month === 6) return `${year}03`;
  if (month === 9) return `${year}06`;
  return `${year}09`;
}

function quarterLabel(q: string): string {
  const year = parseInt(q.slice(0, 4));
  const month = parseInt(q.slice(4));
  const qNum = month === 3 ? 'Q1' : month === 6 ? 'Q2' : month === 9 ? 'Q3' : 'Q4';
  return `${qNum} ${year}`;
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function fmtCr(val: number | string | null | undefined): string {
  const n = Number(val);
  if (!n || isNaN(n)) return '—';
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function fmtQty(val: number | string | null | undefined): string {
  const n = Number(val);
  if (!n || isNaN(n)) return '—';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-IN');
}

function fmtPct(val: number | string | null | undefined): string {
  const n = Number(val);
  if (isNaN(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

// ─── SuperstarCard ────────────────────────────────────────────────────────────
const SuperstarCard: React.FC<{
  star: any;
  selected: boolean;
  onClick: () => void;
}> = ({ star, selected, onClick }) => {
  const name: string = star.investor_name || star.name || star.slug || '';
  const image: string = star.image || star.investor_image || '';
  const stockCount: number = star.no_of_stocks || star.stock_count || 0;
  const portfolioVal: string = fmtCr(star.portfolio_value || star.total_value);
  const netWorth: string = fmtCr(star.net_worth);

  const initials = name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <motion.button
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      className={cn(
        'w-full text-left rounded-xl border transition-all duration-200 overflow-hidden group',
        selected
          ? 'border-indigo-500/60 bg-indigo-950/40 shadow-[0_0_24px_rgba(99,102,241,0.15)]'
          : 'border-white/[0.06] bg-slate-900/60 hover:border-white/[0.12] hover:glass'
      )}
    >
      <div className="p-4">
        {/* Avatar */}
        <div className="flex items-center gap-3 mb-3">
          {image ? (
            <img
              src={image}
              alt={name}
              className="w-11 h-11 rounded-full object-cover border border-white/10 bg-slate-800 flex-shrink-0"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className="w-11 h-11 rounded-full flex items-center justify-center bg-gradient-to-br from-indigo-600 to-violet-700 text-white text-sm font-black flex-shrink-0">
              {initials}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-slate-100 font-bold text-sm leading-tight truncate">{name}</div>
            {star.category && (
              <div className="text-[10px] text-indigo-400 font-display uppercase tracking-widest font-bold mt-0.5">{star.category}</div>
            )}
          </div>
          {selected && (
            <div className="ml-auto">
              <Star className="w-3.5 h-3.5 text-indigo-400 fill-indigo-400" />
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-slate-950/60 rounded-lg px-2.5 py-2 border border-white/[0.04]">
            <div className="text-[9.5px] text-slate-400 font-display uppercase tracking-widest font-bold mb-0.5">Stocks</div>
            <div className="text-white font-black text-sm tabular-nums">{stockCount || '—'}</div>
          </div>
          <div className="bg-slate-950/60 rounded-lg px-2.5 py-2 border border-white/[0.04]">
            <div className="text-[9.5px] text-slate-400 font-display uppercase tracking-widest font-bold mb-0.5">Portfolio</div>
            <div className="text-emerald-400 font-black text-xs tabular-nums truncate">{portfolioVal}</div>
          </div>
        </div>

        {netWorth && netWorth !== '—' && (
          <div className="mt-2 flex justify-between text-[10px]">
            <span className="text-slate-400 font-bold font-display uppercase tracking-wider">Net Worth</span>
            <span className="text-slate-400 font-bold">{netWorth}</span>
          </div>
        )}
      </div>

      {/* Bottom accent line */}
      <div className={cn(
        'h-0.5 w-full transition-all',
        selected ? 'bg-gradient-to-r from-indigo-500 to-violet-500' : 'bg-transparent group-hover:bg-white/[0.04]'
      )} />
    </motion.button>
  );
};

// ─── HoldingRow ───────────────────────────────────────────────────────────────
const HoldingRow: React.FC<{ holding: any; rank: number }> = ({ holding, rank }) => {
  const [expanded, setExpanded] = useState(false);

  const symbol: string    = holding.symbol || holding.stock_symbol || holding.ticker || '';
  const name: string      = holding.company_name || holding.stock_name || holding.name || symbol;
  const qty: number       = Number(holding.total_quantity ?? holding.quantity ?? 0);
  const value: number     = Number(holding.total_value ?? holding.value ?? 0);
  const pct: number       = Number(holding.percentage_change ?? holding.change_pct ?? 0);
  const portPct: number   = Number(holding.portfolio_percentage ?? holding.port_pct ?? 0);
  const prevQty: number   = Number(holding.previous_quantity ?? holding.prev_qty ?? 0);
  const qtyChange: number = qty - prevQty;
  const isNew: boolean    = holding.is_new_buy ?? (prevQty === 0 && qty > 0);
  const isExited: boolean = holding.exited ?? false;
  const sector: string    = holding.sector || '';

  const priceChange = Number(holding.price_change ?? holding.change ?? 0);
  const priceChangePct = Number(holding.price_change_pct ?? holding.change_percent ?? 0);

  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: rank * 0.02 }}
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'border-b border-white/[0.04] cursor-pointer transition-colors group',
          isNew ? 'bg-emerald-500/[0.03]' : isExited ? 'bg-rose-500/[0.03]' : 'hover:bg-white/[0.02]'
        )}
      >
        {/* Rank */}
        <td className="py-3 pl-4 pr-2 w-10">
          <span className="text-[10px] text-slate-300 font-bold tabular-nums">{rank}</span>
        </td>

        {/* Stock */}
        <td className="py-3 pr-3">
          <div className="flex items-center gap-2">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-black text-white tracking-tight uppercase">{symbol}</span>
                {isNew && (
                  <span className="text-[7px] font-black bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 rounded px-1 py-px tracking-wider">NEW</span>
                )}
                {isExited && (
                  <span className="text-[7px] font-black bg-rose-500/15 text-rose-400 border border-rose-500/20 rounded px-1 py-px tracking-wider">EXITED</span>
                )}
              </div>
              <div className="text-[10px] text-slate-400 truncate max-w-[160px]">{name}</div>
            </div>
          </div>
        </td>

        {/* Sector */}
        <td className="py-3 pr-3 hidden lg:table-cell">
          {sector && (
            <span className="text-[10px] text-slate-400 bg-slate-800/60 px-2 py-0.5 rounded font-display uppercase tracking-wider font-bold">
              {sector}
            </span>
          )}
        </td>

        {/* Quantity */}
        <td className="py-3 pr-3 text-right">
          <div className="text-xs font-bold text-slate-100 tabular-nums">{fmtQty(qty)}</div>
          {qtyChange !== 0 && prevQty > 0 && (
            <div className={cn(
              'text-[10px] font-bold tabular-nums flex items-center justify-end gap-0.5',
              qtyChange > 0 ? 'text-emerald-400' : 'text-rose-400'
            )}>
              {qtyChange > 0 ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
              {fmtQty(Math.abs(qtyChange))}
            </div>
          )}
        </td>

        {/* Value */}
        <td className="py-3 pr-3 text-right">
          <div className="text-xs font-bold text-slate-100 tabular-nums">{fmtCr(value)}</div>
        </td>

        {/* Portfolio % */}
        <td className="py-3 pr-3 text-right hidden md:table-cell">
          {portPct > 0 ? (
            <div className="flex items-center justify-end gap-2">
              <div className="w-16 h-1 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full"
                  style={{ width: `${Math.min(portPct * 3, 100)}%` }}
                />
              </div>
              <span className="text-[10px] font-bold text-slate-400 tabular-nums w-8 text-right">{portPct.toFixed(1)}%</span>
            </div>
          ) : <span className="text-slate-300">—</span>}
        </td>

        {/* Price change */}
        <td className="py-3 pr-4 text-right">
          {priceChangePct !== 0 ? (
            <span className={cn(
              'text-xs font-bold tabular-nums flex items-center justify-end gap-0.5',
              priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
            )}>
              {priceChangePct >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              {fmtPct(priceChangePct)}
            </span>
          ) : (
            pct !== 0 ? (
              <span className={cn(
                'text-xs font-bold tabular-nums',
                pct >= 0 ? 'text-emerald-400' : 'text-rose-400'
              )}>
                {fmtPct(pct)}
              </span>
            ) : <span className="text-slate-300">—</span>
          )}
        </td>

        {/* Expand toggle */}
        <td className="py-3 pr-3 text-right w-8">
          {expanded
            ? <ChevronUp className="w-3 h-3 text-slate-400" />
            : <ChevronDown className="w-3 h-3 text-slate-300 group-hover:text-slate-400" />}
        </td>
      </motion.tr>

      {/* Expanded detail row */}
      <AnimatePresence>
        {expanded && (
          <tr>
            <td colSpan={8} className="p-0">
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="px-6 py-3 bg-slate-950/60 border-b border-white/[0.04] grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: 'CMP', value: holding.current_price ? `₹${Number(holding.current_price).toLocaleString('en-IN')}` : '—' },
                    { label: 'Avg Cost', value: holding.avg_price ? `₹${Number(holding.avg_price).toLocaleString('en-IN')}` : '—' },
                    { label: 'Prev Qty', value: fmtQty(prevQty) || '—' },
                    { label: 'Total Value', value: fmtCr(value) },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div className="text-[9.5px] text-slate-400 font-display uppercase tracking-widest font-bold mb-1">{label}</div>
                      <div className="text-xs font-bold text-slate-300">{value}</div>
                    </div>
                  ))}
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
};

// ─── PortfolioDetail ──────────────────────────────────────────────────────────
const PortfolioDetail: React.FC<{
  star: any;
  quarter: string;
  onBack: () => void;
}> = ({ star, quarter, onBack }) => {
  const [sortField, setSortField] = useState<'total_quantity' | 'total_value' | 'portfolio_percentage' | 'percentage_change'>('total_quantity');
  const [sortAsc, setSortAsc] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'new' | 'increased' | 'decreased'>('all');

  const slug: string = star.slug || star.investor_slug || '';
  const name: string = star.investor_name || star.name || slug;
  const image: string = star.image || star.investor_image || '';

  const { data, isLoading, error } = trpc.getSuperstarPortfolio.useQuery(
    { slug, quarter },
    { staleTime: 1800_000 }
  );

  const holdings: any[] = useMemo(() => {
    const raw = Array.isArray(data)
      ? data
      : (data as any)?.results ?? (data as any)?.data ?? (data as any)?.stocks ?? [];

    return raw.filter(Boolean);
  }, [data]);

  const filtered = useMemo(() => {
    let h = [...holdings];

    if (search.trim()) {
      const q = search.toLowerCase();
      h = h.filter(s =>
        (s.symbol || '').toLowerCase().includes(q) ||
        (s.company_name || s.stock_name || '').toLowerCase().includes(q)
      );
    }

    if (filter === 'new') h = h.filter(s => s.is_new_buy || Number(s.previous_quantity ?? -1) === 0);
    if (filter === 'increased') h = h.filter(s => Number(s.total_quantity ?? 0) > Number(s.previous_quantity ?? 0));
    if (filter === 'decreased') h = h.filter(s => Number(s.total_quantity ?? 0) < Number(s.previous_quantity ?? 0));

    h.sort((a, b) => {
      const av = Number(a[sortField] ?? 0);
      const bv = Number(b[sortField] ?? 0);
      return sortAsc ? av - bv : bv - av;
    });

    return h;
  }, [holdings, search, filter, sortField, sortAsc]);

  const totalValue = useMemo(() =>
    holdings.reduce((acc, h) => acc + Number(h.total_value ?? 0), 0), [holdings]);
  const newBuys = holdings.filter(h => h.is_new_buy || Number(h.previous_quantity ?? -1) === 0).length;

  const initials = name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

  const SortTh: React.FC<{ field: typeof sortField; children: React.ReactNode }> = ({ field, children }) => (
    <th
      onClick={() => { if (sortField === field) setSortAsc(!sortAsc); else { setSortField(field); setSortAsc(false); } }}
      className="py-2 pr-3 text-right text-[10px] font-bold text-slate-400 font-display uppercase tracking-widest cursor-pointer hover:text-indigo-600 transition-colors select-none"
    >
      <span className="flex items-center justify-end gap-1">
        {children}
        {sortField === field ? (
          sortAsc ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />
        ) : null}
      </span>
    </th>
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={onBack}
          className="p-2 rounded-xl glass border border-white/[0.06] text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-3">
          {image ? (
            <img
              src={image}
              alt={name}
              className="w-12 h-12 rounded-full object-cover border border-white/10 bg-slate-800"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className="w-12 h-12 rounded-full flex items-center justify-center bg-gradient-to-br from-indigo-600 to-violet-700 text-white font-black">
              {initials}
            </div>
          )}
          <div>
            <h2 className="text-xl font-black text-white tracking-tight">{name}</h2>
            {star.category && (
              <div className="text-[10px] text-indigo-400 font-bold font-display uppercase tracking-widest">{star.category}</div>
            )}
          </div>
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Holdings', value: String(holdings.length), icon: <Briefcase className="w-3 h-3" /> },
          { label: 'Portfolio Value', value: fmtCr(totalValue), icon: <BarChart2 className="w-3 h-3" />, color: 'text-emerald-400' },
          { label: 'New Buys', value: String(newBuys), icon: <TrendingUp className="w-3 h-3" />, color: 'text-sky-400' },
          { label: 'Quarter', value: quarterLabel(quarter), icon: <Star className="w-3 h-3" /> },
        ].map(({ label, value, icon, color }) => (
          <div key={label} className="v1-card px-4 py-3">
            <div className="v1-data-label flex items-center gap-1.5 mb-1">
              {icon}{label}
            </div>
            <div className={cn('v1-data-value tabular-nums', color ?? 'text-white')}>{value}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search symbol or company…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-slate-900/60 border border-white/[0.07] rounded-xl py-2 pl-9 pr-4 text-sm text-white placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 focus:border-indigo-500/30"
          />
        </div>

        <div className="flex gap-1.5">
          {(['all', 'new', 'increased', 'decreased'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-[10px] font-black font-display uppercase tracking-wider border transition-all',
                filter === f
                  ? f === 'new' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                    : f === 'increased' ? 'bg-sky-500/15 border-sky-500/30 text-sky-400'
                    : f === 'decreased' ? 'bg-rose-500/15 border-rose-500/30 text-rose-400'
                    : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                  : 'glass border-white/[0.06] text-slate-400 hover:text-white'
              )}
            >
              {f === 'all' ? 'All' : f === 'new' ? '🟢 New' : f === 'increased' ? '↑ Added' : '↓ Trimmed'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <RefreshCw className="w-6 h-6 text-indigo-500 animate-spin" />
          <p className="text-slate-400 text-xs font-bold font-display uppercase tracking-widest">Loading portfolio…</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <AlertCircle className="w-8 h-8 text-rose-500/40" />
          <p className="text-slate-400 text-xs font-bold font-display uppercase tracking-widest">Failed to load portfolio data</p>
          <p className="text-slate-300 text-[10px]">The API may require authentication or has rate-limited the request.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Briefcase className="w-8 h-8 text-slate-200" />
          <p className="text-slate-400 text-xs font-bold font-display uppercase tracking-widest">
            {holdings.length === 0 ? 'No holdings found for this quarter' : 'No results match your filter'}
          </p>
        </div>
      ) : (
        <div className="v1-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06] bg-slate-950/40">
                  <th className="py-3 pl-4 pr-2 text-left text-[10px] font-bold text-slate-400 font-display uppercase tracking-widest w-10">#</th>
                  <th className="py-3 pr-3 text-left text-[10px] font-bold text-slate-400 font-display uppercase tracking-widest">Stock</th>
                  <th className="py-3 pr-3 text-left text-[10px] font-bold text-slate-400 font-display uppercase tracking-widest hidden lg:table-cell">Sector</th>
                  <SortTh field="total_quantity">Quantity</SortTh>
                  <SortTh field="total_value">Value</SortTh>
                  <SortTh field="portfolio_percentage">Port %</SortTh>
                  <SortTh field="percentage_change">Change</SortTh>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((h, i) => (
                  <HoldingRow key={h.symbol || i} holding={h} rank={i + 1} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 border-t border-white/[0.04] flex items-center justify-between">
            <span className="text-[10px] text-slate-400 font-bold font-display uppercase tracking-widest">
              {filtered.length} of {holdings.length} holdings · {quarterLabel(quarter)}
            </span>
            <span className="text-[10px] text-slate-400 font-bold font-display uppercase tracking-widest">
              Total: <span className="text-emerald-400">{fmtCr(totalValue)}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main page ─────────────────────────────────────────────────────────────────
const SuperstarPortfolio: React.FC = () => {
  const [quarter, setQuarter] = useState(getLatestCompletedQuarter());
  const [selectedStar, setSelectedStar] = useState<any | null>(null);
  const [search, setSearch] = useState('');
  const [showQPicker, setShowQPicker] = useState(false);
  const quarters = useMemo(() => generateQuarters(12), []);

  const { data: listData, isLoading, error, refetch } = trpc.getSuperstarList.useQuery(undefined, {
    staleTime: 3600_000,
  });

  const superstars: any[] = useMemo(() => {
    if (!listData) return [];
    const raw = Array.isArray(listData)
      ? listData
      : (listData as any)?.results ?? (listData as any)?.data ?? [];
    return raw.filter(Boolean);
  }, [listData]);

  const filtered = useMemo(() => {
    if (!search.trim()) return superstars;
    const q = search.toLowerCase();
    return superstars.filter(s =>
      (s.investor_name || s.name || s.slug || '').toLowerCase().includes(q)
    );
  }, [superstars, search]);

  if (selectedStar) {
    return (
      <div className="p-4 md:p-6 max-w-7xl mx-auto">
        {/* Quarter selector */}
        <div className="flex items-center justify-end gap-2 mb-4">
          <span className="text-[10px] text-slate-400 font-bold font-display uppercase tracking-widest">Quarter:</span>
          <div className="relative">
            <button
              onClick={() => setShowQPicker(!showQPicker)}
              className="flex items-center gap-2 px-3 py-1.5 glass border border-white/[0.08] rounded-lg text-xs font-bold text-slate-100 hover:border-indigo-500/40 transition-colors"
            >
              {quarterLabel(quarter)}
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>
            <AnimatePresence>
              {showQPicker && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  className="absolute right-0 top-full mt-1 glass border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl z-50 min-w-[120px]"
                >
                  {quarters.map(q => (
                    <button
                      key={q}
                      onClick={() => { setQuarter(q); setShowQPicker(false); }}
                      className={cn(
                        'w-full px-4 py-2 text-left text-xs font-bold transition-colors',
                        q === quarter ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                      )}
                    >
                      {quarterLabel(q)}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <PortfolioDetail star={selectedStar} quarter={quarter} onBack={() => setSelectedStar(null)} />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">

      {/* Page header */}
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
              <Users className="w-3.5 h-3.5 text-white" />
            </div>
            <h1 className="v1-title-page">Superstar Portfolio</h1>
          </div>
          <p className="text-slate-400 text-xs font-medium">
            Track India's legendary investors · Powered by TradeBrains · {quarterLabel(quarter)}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Quarter picker */}
          <div className="relative">
            <button
              onClick={() => setShowQPicker(!showQPicker)}
              className="flex items-center gap-2 px-4 py-2 glass border border-white/[0.08] rounded-xl text-sm font-bold text-slate-100 hover:border-indigo-500/40 transition-colors"
            >
              <span className="text-[10px] text-slate-400 font-bold font-display uppercase tracking-widest">Quarter</span>
              {quarterLabel(quarter)}
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>
            <AnimatePresence>
              {showQPicker && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  className="absolute right-0 top-full mt-1 glass border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl z-50 min-w-[130px]"
                >
                  {quarters.map(q => (
                    <button
                      key={q}
                      onClick={() => { setQuarter(q); setShowQPicker(false); }}
                      className={cn(
                        'w-full px-4 py-2.5 text-left text-xs font-bold transition-colors',
                        q === quarter ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                      )}
                    >
                      {quarterLabel(q)}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button
            onClick={() => refetch()}
            className="p-2 glass border border-white/[0.06] rounded-xl text-slate-400 hover:text-white transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search investor name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full max-w-sm bg-slate-900/60 border border-white/[0.07] rounded-xl py-2.5 pl-11 pr-4 text-sm text-white placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 focus:border-indigo-500/30"
        />
      </div>

      {/* States */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
          <RefreshCw className="w-7 h-7 text-indigo-500 animate-spin" />
          <p className="text-slate-400 text-xs font-bold font-display uppercase tracking-widest">Fetching superstar list…</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
          <AlertCircle className="w-10 h-10 text-rose-500/40" />
          <p className="text-slate-400 text-sm font-bold">Could not load data from TradeBrains</p>
          <p className="text-slate-400 text-[10px] max-w-xs text-center">
            The API may require a session cookie from the browser. Try opening the server with proxy headers or logging in to portal.tradebrains.in first.
          </p>
          <button
            onClick={() => refetch()}
            className="mt-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 gap-3">
          <Users className="w-10 h-10 text-slate-200" />
          <p className="text-slate-400 text-xs font-bold font-display uppercase tracking-widest">
            {superstars.length === 0 ? 'No superstars found' : 'No results match your search'}
          </p>
        </div>
      ) : (
        <>
          <div className="text-[10px] text-slate-400 font-bold font-display uppercase tracking-widest mb-4">
            {filtered.length} investor{filtered.length !== 1 ? 's' : ''} · click to view portfolio
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {filtered.map((star, i) => (
              <motion.div
                key={star.slug || star.id || i}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
              >
                <SuperstarCard
                  star={star}
                  selected={selectedStar?.slug === star.slug}
                  onClick={() => setSelectedStar(star)}
                />
              </motion.div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default SuperstarPortfolio;
