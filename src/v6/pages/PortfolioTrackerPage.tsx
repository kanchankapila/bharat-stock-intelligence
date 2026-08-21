import React, { useMemo, useState } from 'react';
import {
  Search, Plus, X, Briefcase, PiggyBank, TrendingUp, TrendingDown,
  ArrowUpRight, ArrowDownRight, Trash2, RotateCcw, Pencil, Wallet,
} from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';

type AssetTab = 'stocks' | 'mf';

function fmtINR(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}
function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits });
}
function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function toneClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'text-[var(--v6-muted)]';
  return n >= 0 ? 'text-[var(--v6-positive)]' : 'text-[var(--v6-negative)]';
}
// Same null-safety as toneClass(), for KpiCard's tone enum -- an undefined/errored `totals` must
// render neutral, not a false "up" (see AF-20260818-32: `(n ?? 0) >= 0` always reads as "up").
function pnlTone(n: number | null | undefined): 'up' | 'down' | 'neutral' {
  if (n == null || !Number.isFinite(n)) return 'neutral';
  return n >= 0 ? 'up' : 'down';
}

// ─── Shared bits ────────────────────────────────────────────────────────────

const KpiCard: React.FC<{ label: string; value: string; sub?: string; tone?: 'up' | 'down' | 'neutral' }> = ({ label, value, sub, tone = 'neutral' }) => (
  <div className="glass rounded-xl px-4 py-3 border border-[var(--v6-border)]">
    <p className="text-[10px] font-bold text-[var(--v6-faint)] uppercase tracking-widest mb-1">{label}</p>
    <p className={cn(
      'text-lg font-bold font-mono',
      tone === 'up' ? 'text-[var(--v6-positive)]' : tone === 'down' ? 'text-[var(--v6-negative)]' : 'text-[var(--v6-ink)]',
    )}>{value}</p>
    {sub && <p className="text-[10px] text-[var(--v6-faint)] mt-0.5">{sub}</p>}
  </div>
);

const StockSymbolSearch: React.FC<{ onSelect: (symbol: string, name?: string) => void }> = ({ onSelect }) => {
  const [q, setQ] = useState('');
  const { data } = trpc.searchNSEStocks.useQuery({ query: q }, { enabled: q.length >= 1 });
  const results = data?.stocks ?? [];
  return (
    <div className="relative">
      <div className="flex items-center gap-2 bg-[var(--v6-bg)] border border-[var(--v6-border)] rounded-lg px-3 py-2">
        <Search className="w-3.5 h-3.5 text-[var(--v6-faint)] shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search stock symbol or name…"
          className="bg-transparent outline-none text-xs text-[var(--v6-ink)] placeholder:text-[var(--v6-faint)] w-full"
        />
      </div>
      {q.length >= 1 && results.length > 0 && (
        <div className="absolute z-30 mt-1 w-full max-h-60 overflow-y-auto bg-[var(--v6-bg-band)] border border-[var(--v6-border)] rounded-lg terminal-scrollbar">
          {results.map((s: any) => (
            <button
              key={s.symbol}
              onClick={() => { onSelect(s.symbol, s.name); setQ(''); }}
              className="w-full text-left px-3 py-2 text-xs text-[var(--v6-ink-soft)] hover:bg-[var(--v6-accent-soft)] hover:text-white flex justify-between"
            >
              <span className="font-bold">{s.symbol}</span>
              <span className="text-[var(--v6-faint)] truncate ml-2">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <label className="block text-[10px] font-bold text-[var(--v6-faint)] uppercase tracking-wider mb-1">{children}</label>
);
const inputCls = 'w-full bg-[var(--v6-bg)] border border-[var(--v6-border)] text-[var(--v6-ink)] text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--v6-accent)]';

// ─── Add Stock form ─────────────────────────────────────────────────────────

const AddStockForm: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [buyPrice, setBuyPrice] = useState('');
  const [buyDate, setBuyDate] = useState(todayISO());
  const [notes, setNotes] = useState('');

  const utils = trpc.useContext();
  const add = trpc.addPortfolioHolding.useMutation({
    onSuccess: () => { utils.getPortfolioInsights.invalidate(); onDone(); },
  });

  const canSubmit = symbol && Number(quantity) > 0 && Number(buyPrice) > 0 && buyDate;

  return (
    <div className="p-4 bg-[var(--v6-bg)] border border-[var(--v6-border)] rounded-xl space-y-3">
      <div>
        <FieldLabel>Stock</FieldLabel>
        <StockSymbolSearch onSelect={(s) => setSymbol(s)} />
        {symbol && <p className="text-[11px] text-[var(--v6-accent-ink)] font-bold mt-1">{symbol}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Quantity</FieldLabel>
          <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls} placeholder="e.g. 10" />
        </div>
        <div>
          <FieldLabel>Buy Price (₹)</FieldLabel>
          <input type="number" min="0" step="any" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)} className={inputCls} placeholder="Per share" />
        </div>
      </div>
      <div>
        <FieldLabel>Buy Date</FieldLabel>
        <input type="date" value={buyDate} max={todayISO()} onChange={(e) => setBuyDate(e.target.value)} className={inputCls} />
      </div>
      <div>
        <FieldLabel>Notes (optional)</FieldLabel>
        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} placeholder="Why this position?" />
      </div>
      <button
        disabled={!canSubmit || add.isPending}
        onClick={() => add.mutate({ symbol, quantity: Number(quantity), buyPrice: Number(buyPrice), buyDate, notes: notes || undefined })}
        className="w-full bg-[var(--v6-accent)] hover:bg-[var(--v6-accent)] disabled:opacity-50 text-white text-xs font-bold rounded-lg py-2.5 transition-colors"
      >
        {add.isPending ? 'Adding…' : 'Add Holding'}
      </button>
      {add.isError && <p className="text-[11px] text-[var(--v6-negative)]">{add.error?.message}</p>}
    </div>
  );
};

// ─── Sell (close) modal for a stock lot ────────────────────────────────────

const SellStockPanel: React.FC<{ holding: any; onDone: () => void; onCancel: () => void }> = ({ holding, onDone, onCancel }) => {
  const [sellPrice, setSellPrice] = useState(holding.currentPrice != null ? String(holding.currentPrice) : '');
  const [sellDate, setSellDate] = useState(todayISO());
  const [sellQty, setSellQty] = useState(String(holding.quantity));

  const utils = trpc.useContext();
  const close = trpc.closePortfolioHolding.useMutation({
    onSuccess: () => { utils.getPortfolioInsights.invalidate(); onDone(); },
  });

  return (
    <div className="mt-2 p-3 bg-[var(--v6-bg)] border border-[var(--v6-accent)] rounded-lg space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <FieldLabel>Sell Qty</FieldLabel>
          <input type="number" min="0" max={holding.quantity} step="any" value={sellQty} onChange={(e) => setSellQty(e.target.value)} className={inputCls} />
        </div>
        <div>
          <FieldLabel>Sell Price</FieldLabel>
          <input type="number" min="0" step="any" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} className={inputCls} />
        </div>
        <div>
          <FieldLabel>Sell Date</FieldLabel>
          <input type="date" value={sellDate} max={todayISO()} onChange={(e) => setSellDate(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          disabled={close.isPending || !(Number(sellPrice) > 0) || !(Number(sellQty) > 0)}
          onClick={() => close.mutate({ id: holding.id, sellPrice: Number(sellPrice), sellDate, quantity: Number(sellQty) === holding.quantity ? undefined : Number(sellQty) })}
          className="flex-1 bg-[var(--v6-negative)] hover:bg-[var(--v6-negative)] disabled:opacity-50 text-white text-xs font-bold rounded-lg py-2"
        >
          {close.isPending ? 'Selling…' : 'Confirm Sell'}
        </button>
        <button onClick={onCancel} className="px-3 text-xs text-[var(--v6-muted)] hover:text-[var(--v6-ink)]">Cancel</button>
      </div>
      {close.isError && <p className="text-[11px] text-[var(--v6-negative)]">{close.error?.message}</p>}
    </div>
  );
};

// ─── Stocks tab ─────────────────────────────────────────────────────────────

const StocksTab: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [sellingId, setSellingId] = useState<number | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const utils = trpc.useContext();
  const { data, isLoading } = trpc.getPortfolioInsights.useQuery(undefined, { refetchInterval: 60_000 });
  const del = trpc.deletePortfolioHolding.useMutation({ onSuccess: () => utils.getPortfolioInsights.invalidate() });
  const reopen = trpc.reopenPortfolioHolding.useMutation({ onSuccess: () => utils.getPortfolioInsights.invalidate() });

  const totals = data?.totals;
  const open = data?.openHoldings ?? [];
  const closed = data?.closedHoldings ?? [];
  const bySector = data?.bySector ?? [];

  if (isLoading) return <p className="text-xs text-[var(--v6-faint)] font-mono">Loading portfolio…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Invested" value={fmtINR(totals?.investedOpen)} />
        <KpiCard label="Current Value" value={fmtINR(totals?.currentValue)} />
        <KpiCard label="Unrealized P&L" value={`${fmtINR(totals?.unrealizedPnl)} (${fmtPct(totals?.unrealizedPnlPct)})`} tone={pnlTone(totals?.unrealizedPnl)} />
        <KpiCard label="Realized P&L" value={`${fmtINR(totals?.realizedPnl)} (${fmtPct(totals?.realizedPnlPct)})`} tone={pnlTone(totals?.realizedPnl)} />
        <KpiCard label="Positions" value={`${totals?.openPositions ?? 0} open`} sub={`${totals?.closedPositions ?? 0} closed`} />
      </div>

      {(data?.bestPerformer || data?.worstPerformer) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {data.bestPerformer && (
            <div className="glass rounded-xl px-4 py-3 border border-[var(--v6-positive)] flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold text-[var(--v6-positive)] uppercase tracking-widest mb-0.5">Best Performer</p>
                <p className="text-sm font-bold text-[var(--v6-ink)]">{data.bestPerformer.symbol}</p>
              </div>
              <p className="text-sm font-mono font-bold text-[var(--v6-positive)]">{fmtPct(data.bestPerformer.pnlPct)}</p>
            </div>
          )}
          {data.worstPerformer && (
            <div className="glass rounded-xl px-4 py-3 border border-[var(--v6-negative)] flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold text-[var(--v6-negative)] uppercase tracking-widest mb-0.5">Worst Performer</p>
                <p className="text-sm font-bold text-[var(--v6-ink)]">{data.worstPerformer.symbol}</p>
              </div>
              <p className="text-sm font-mono font-bold text-[var(--v6-negative)]">{fmtPct(data.worstPerformer.pnlPct)}</p>
            </div>
          )}
        </div>
      )}

      {bySector.length > 0 && (
        <Card title="Sector Allocation" icon={PiggyBank}>
          <div className="space-y-2">
            {bySector.slice(0, 8).map((s: any) => (
              <div key={s.sector} className="flex items-center gap-3">
                <span className="text-[11px] text-[var(--v6-muted)] w-32 shrink-0 truncate">{s.sector}</span>
                <div className="flex-1 v6-bar-track" style={{ height: 8 }}>
                  <div className="v6-bar-fill" style={{ width: `${Math.min(100, s.pct)}%` }} />
                </div>
                <span className="text-[11px] font-mono text-[var(--v6-muted)] w-14 text-right">{s.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title={`Open Holdings (${open.length})`}
        icon={Briefcase}
        action={
          <button onClick={() => setShowAdd((v) => !v)} className="flex items-center gap-1 text-[11px] font-bold text-[var(--v6-accent-ink)] hover:text-[var(--v6-accent-ink)]">
            <Plus className="w-3.5 h-3.5" /> {showAdd ? 'Close' : 'Add Stock'}
          </button>
        }
      >
        {showAdd && <div className="mb-4"><AddStockForm onDone={() => setShowAdd(false)} /></div>}
        {open.length === 0 ? (
          <p className="text-xs text-[var(--v6-faint)] font-mono">No open positions yet — add your first stock above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-[var(--v6-faint)] uppercase tracking-wider border-b border-[var(--v6-border)]">
                  <th className="text-left py-2 pr-3">Symbol</th>
                  <th className="text-right py-2 px-3">Qty</th>
                  <th className="text-right py-2 px-3">Buy Price</th>
                  <th className="text-right py-2 px-3">Buy Date</th>
                  <th className="text-right py-2 px-3">Current</th>
                  <th className="text-right py-2 px-3">Value</th>
                  <th className="text-right py-2 px-3">P&L</th>
                  <th className="text-right py-2 pl-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {open.map((h: any) => (
                  <React.Fragment key={h.id}>
                    <tr className="border-b border-[var(--v6-border)] hover:bg-[var(--v6-bg-band)]">
                      <td className="py-2.5 pr-3">
                        <button onClick={() => onSelectStock?.(h.symbol)} className="font-bold text-[var(--v6-ink)] hover:text-[var(--v6-accent-ink)]">{h.symbol}</button>
                        {h.sector && <p className="text-[10px] text-[var(--v6-faint)]">{h.sector}</p>}
                      </td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-ink-soft)]">{fmtNum(h.quantity)}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-ink-soft)]">{fmtINR(h.buyPrice, 2)}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-faint)]">{h.buyDate}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-ink-soft)]">{h.currentPrice != null ? fmtINR(h.currentPrice, 2) : '—'}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-ink)]">{fmtINR(h.currentValue)}</td>
                      <td className={cn('text-right py-2.5 px-3 font-mono font-bold', toneClass(h.pnl))}>
                        {fmtINR(h.pnl)} <span className="text-[10px] opacity-80">({fmtPct(h.pnlPct)})</span>
                      </td>
                      <td className="text-right py-2.5 pl-3">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => setSellingId(sellingId === h.id ? null : h.id)} className="text-[11px] font-bold text-[var(--v6-highlight)] hover:text-[var(--v6-highlight)]">Sell</button>
                          <button onClick={() => del.mutate({ id: h.id })} className="text-[var(--v6-faint)] hover:text-[var(--v6-negative)]"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                    {sellingId === h.id && (
                      <tr>
                        <td colSpan={8} className="pb-3">
                          <SellStockPanel holding={h} onDone={() => setSellingId(null)} onCancel={() => setSellingId(null)} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {closed.length > 0 && (
        <Card
          title={`Closed Positions (${closed.length})`}
          icon={Wallet}
          action={<button onClick={() => setShowClosed((v) => !v)} className="text-[11px] font-bold text-[var(--v6-muted)] hover:text-[var(--v6-ink)]">{showClosed ? 'Hide' : 'Show'}</button>}
        >
          {showClosed && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-[var(--v6-faint)] uppercase tracking-wider border-b border-[var(--v6-border)]">
                    <th className="text-left py-2 pr-3">Symbol</th>
                    <th className="text-right py-2 px-3">Qty</th>
                    <th className="text-right py-2 px-3">Buy → Sell</th>
                    <th className="text-right py-2 px-3">Dates</th>
                    <th className="text-right py-2 px-3">Realized P&L</th>
                    <th className="text-right py-2 pl-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((h: any) => (
                    <tr key={h.id} className="border-b border-[var(--v6-border)]">
                      <td className="py-2.5 pr-3 font-bold text-[var(--v6-ink-soft)]">{h.symbol}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-muted)]">{fmtNum(h.quantity)}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-muted)]">{fmtINR(h.buyPrice, 2)} → {fmtINR(h.sellPrice, 2)}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-faint)] text-[10px]">{h.buyDate} → {h.sellDate}</td>
                      <td className={cn('text-right py-2.5 px-3 font-mono font-bold', toneClass(h.pnl))}>{fmtINR(h.pnl)} ({fmtPct(h.pnlPct)})</td>
                      <td className="text-right py-2.5 pl-3">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => reopen.mutate({ id: h.id })} title="Reopen" className="text-[var(--v6-faint)] hover:text-[var(--v6-accent-ink)]"><RotateCcw className="w-3.5 h-3.5" /></button>
                          <button onClick={() => del.mutate({ id: h.id })} title="Delete" className="text-[var(--v6-faint)] hover:text-[var(--v6-negative)]"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

// ─── Mutual Funds tab ───────────────────────────────────────────────────────

const AddMfForm: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [schemeName, setSchemeName] = useState('');
  const [folioNumber, setFolioNumber] = useState('');
  const [category, setCategory] = useState('');
  const [units, setUnits] = useState('');
  const [buyNav, setBuyNav] = useState('');
  const [buyDate, setBuyDate] = useState(todayISO());

  const utils = trpc.useContext();
  const add = trpc.addMfHolding.useMutation({ onSuccess: () => { utils.getMfInsights.invalidate(); onDone(); } });
  const canSubmit = schemeName && Number(units) > 0 && Number(buyNav) > 0 && buyDate;

  return (
    <div className="p-4 bg-[var(--v6-bg)] border border-[var(--v6-border)] rounded-xl space-y-3">
      <div>
        <FieldLabel>Scheme Name</FieldLabel>
        <input type="text" value={schemeName} onChange={(e) => setSchemeName(e.target.value)} className={inputCls} placeholder="e.g. Parag Parikh Flexi Cap Fund" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Category</FieldLabel>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
            <option value="">Select…</option>
            <option>Large Cap</option><option>Mid Cap</option><option>Small Cap</option>
            <option>Flexi Cap</option><option>Multi Cap</option><option>ELSS</option>
            <option>Debt</option><option>Hybrid</option><option>Index</option><option>Sectoral/Thematic</option>
          </select>
        </div>
        <div>
          <FieldLabel>Folio Number (optional)</FieldLabel>
          <input type="text" value={folioNumber} onChange={(e) => setFolioNumber(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Units</FieldLabel>
          <input type="number" min="0" step="any" value={units} onChange={(e) => setUnits(e.target.value)} className={inputCls} />
        </div>
        <div>
          <FieldLabel>Buy NAV (₹)</FieldLabel>
          <input type="number" min="0" step="any" value={buyNav} onChange={(e) => setBuyNav(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div>
        <FieldLabel>Buy Date</FieldLabel>
        <input type="date" value={buyDate} max={todayISO()} onChange={(e) => setBuyDate(e.target.value)} className={inputCls} />
      </div>
      <button
        disabled={!canSubmit || add.isPending}
        onClick={() => add.mutate({ schemeName, folioNumber: folioNumber || undefined, category: category || undefined, units: Number(units), buyNav: Number(buyNav), buyDate })}
        className="w-full bg-[var(--v6-accent)] hover:bg-[var(--v6-accent)] disabled:opacity-50 text-white text-xs font-bold rounded-lg py-2.5 transition-colors"
      >
        {add.isPending ? 'Adding…' : 'Add Mutual Fund'}
      </button>
      {add.isError && <p className="text-[11px] text-[var(--v6-negative)]">{add.error?.message}</p>}
    </div>
  );
};

const UpdateNavInline: React.FC<{ holding: any; onDone: () => void }> = ({ holding, onDone }) => {
  const [nav, setNav] = useState(holding.currentNav != null ? String(holding.currentNav) : '');
  const utils = trpc.useContext();
  const update = trpc.updateMfHolding.useMutation({ onSuccess: () => { utils.getMfInsights.invalidate(); onDone(); } });
  return (
    <div className="flex items-center gap-1.5">
      <input type="number" min="0" step="any" value={nav} onChange={(e) => setNav(e.target.value)} className="w-20 bg-[var(--v6-bg)] border border-[var(--v6-border)] text-[var(--v6-ink)] text-[11px] font-mono rounded px-2 py-1" />
      <button
        disabled={update.isPending || !(Number(nav) > 0)}
        onClick={() => update.mutate({ id: holding.id, currentNav: Number(nav) })}
        className="text-[10px] font-bold text-[var(--v6-accent-ink)] hover:text-[var(--v6-accent-ink)]"
      >Save</button>
    </div>
  );
};

const CloseMfPanel: React.FC<{ holding: any; onDone: () => void; onCancel: () => void }> = ({ holding, onDone, onCancel }) => {
  const [sellNav, setSellNav] = useState(holding.currentNav != null ? String(holding.currentNav) : '');
  const [sellDate, setSellDate] = useState(todayISO());
  const utils = trpc.useContext();
  const close = trpc.closeMfHolding.useMutation({ onSuccess: () => { utils.getMfInsights.invalidate(); onDone(); } });
  return (
    <div className="mt-2 p-3 bg-[var(--v6-bg)] border border-[var(--v6-accent)] rounded-lg space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <FieldLabel>Redemption NAV</FieldLabel>
          <input type="number" min="0" step="any" value={sellNav} onChange={(e) => setSellNav(e.target.value)} className={inputCls} />
        </div>
        <div>
          <FieldLabel>Redeem Date</FieldLabel>
          <input type="date" value={sellDate} max={todayISO()} onChange={(e) => setSellDate(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          disabled={close.isPending || !(Number(sellNav) > 0)}
          onClick={() => close.mutate({ id: holding.id, sellNav: Number(sellNav), sellDate })}
          className="flex-1 bg-[var(--v6-negative)] hover:bg-[var(--v6-negative)] disabled:opacity-50 text-white text-xs font-bold rounded-lg py-2"
        >{close.isPending ? 'Redeeming…' : 'Confirm Redemption'}</button>
        <button onClick={onCancel} className="px-3 text-xs text-[var(--v6-muted)] hover:text-[var(--v6-ink)]">Cancel</button>
      </div>
    </div>
  );
};

const MfTab: React.FC = () => {
  const [showAdd, setShowAdd] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const utils = trpc.useContext();
  const { data, isLoading } = trpc.getMfInsights.useQuery(undefined, { refetchInterval: 300_000 });
  const del = trpc.deleteMfHolding.useMutation({ onSuccess: () => utils.getMfInsights.invalidate() });
  const reopen = trpc.reopenMfHolding.useMutation({ onSuccess: () => utils.getMfInsights.invalidate() });

  const totals = data?.totals;
  const open = data?.openHoldings ?? [];
  const closed = data?.closedHoldings ?? [];
  const byCategory = data?.byCategory ?? [];

  if (isLoading) return <p className="text-xs text-[var(--v6-faint)] font-mono">Loading mutual fund portfolio…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Invested" value={fmtINR(totals?.investedOpen)} />
        <KpiCard label="Current Value" value={fmtINR(totals?.currentValue)} />
        <KpiCard label="Unrealized P&L" value={`${fmtINR(totals?.unrealizedPnl)} (${fmtPct(totals?.unrealizedPnlPct)})`} tone={pnlTone(totals?.unrealizedPnl)} />
        <KpiCard label="Realized P&L" value={`${fmtINR(totals?.realizedPnl)} (${fmtPct(totals?.realizedPnlPct)})`} tone={pnlTone(totals?.realizedPnl)} />
        <KpiCard label="Holdings" value={`${totals?.openPositions ?? 0} open`} sub={`${totals?.closedPositions ?? 0} redeemed`} />
      </div>

      {byCategory.length > 0 && (
        <Card title="Category Allocation" icon={PiggyBank}>
          <div className="space-y-2">
            {byCategory.map((c: any) => (
              <div key={c.category} className="flex items-center gap-3">
                <span className="text-[11px] text-[var(--v6-muted)] w-32 shrink-0 truncate">{c.category}</span>
                <div className="flex-1 v6-bar-track" style={{ height: 8 }}>
                  <div className="v6-bar-fill" style={{ width: `${Math.min(100, c.pct)}%`, background: '#a78bfa' }} />
                </div>
                <span className="text-[11px] font-mono text-[var(--v6-muted)] w-14 text-right">{c.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title={`Active Funds (${open.length})`}
        icon={PiggyBank}
        action={
          <button onClick={() => setShowAdd((v) => !v)} className="flex items-center gap-1 text-[11px] font-bold text-[var(--v6-accent-ink)] hover:text-[var(--v6-accent-ink)]">
            <Plus className="w-3.5 h-3.5" /> {showAdd ? 'Close' : 'Add Fund'}
          </button>
        }
      >
        {showAdd && <div className="mb-4"><AddMfForm onDone={() => setShowAdd(false)} /></div>}
        {open.length === 0 ? (
          <p className="text-xs text-[var(--v6-faint)] font-mono">
            No mutual funds tracked yet — add one above. NAV updates are entered manually; there's no live AMFI feed wired in yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-[var(--v6-faint)] uppercase tracking-wider border-b border-[var(--v6-border)]">
                  <th className="text-left py-2 pr-3">Scheme</th>
                  <th className="text-right py-2 px-3">Units</th>
                  <th className="text-right py-2 px-3">Buy NAV</th>
                  <th className="text-right py-2 px-3">Current NAV</th>
                  <th className="text-right py-2 px-3">Value</th>
                  <th className="text-right py-2 px-3">P&L</th>
                  <th className="text-right py-2 pl-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {open.map((h: any) => (
                  <React.Fragment key={h.id}>
                    <tr className="border-b border-[var(--v6-border)] hover:bg-[var(--v6-bg-band)]">
                      <td className="py-2.5 pr-3">
                        <p className="font-bold text-[var(--v6-ink)]">{h.schemeName}</p>
                        {h.category && <p className="text-[10px] text-[var(--v6-faint)]">{h.category}{h.folioNumber ? ` · Folio ${h.folioNumber}` : ''}</p>}
                      </td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-ink-soft)]">{fmtNum(h.units, 3)}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-ink-soft)]">{fmtINR(h.buyNav, 2)}</td>
                      <td className="text-right py-2.5 px-3"><UpdateNavInline holding={h} onDone={() => {}} /></td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-ink)]">{fmtINR(h.currentValue)}</td>
                      <td className={cn('text-right py-2.5 px-3 font-mono font-bold', toneClass(h.pnl))}>{fmtINR(h.pnl)} <span className="text-[10px] opacity-80">({fmtPct(h.pnlPct)})</span></td>
                      <td className="text-right py-2.5 pl-3">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => setClosingId(closingId === h.id ? null : h.id)} className="text-[11px] font-bold text-[var(--v6-highlight)] hover:text-[var(--v6-highlight)]">Redeem</button>
                          <button onClick={() => del.mutate({ id: h.id })} className="text-[var(--v6-faint)] hover:text-[var(--v6-negative)]"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                    {closingId === h.id && (
                      <tr><td colSpan={7} className="pb-3"><CloseMfPanel holding={h} onDone={() => setClosingId(null)} onCancel={() => setClosingId(null)} /></td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {closed.length > 0 && (
        <Card
          title={`Redeemed (${closed.length})`}
          icon={Wallet}
          action={<button onClick={() => setShowClosed((v) => !v)} className="text-[11px] font-bold text-[var(--v6-muted)] hover:text-[var(--v6-ink)]">{showClosed ? 'Hide' : 'Show'}</button>}
        >
          {showClosed && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-[var(--v6-faint)] uppercase tracking-wider border-b border-[var(--v6-border)]">
                    <th className="text-left py-2 pr-3">Scheme</th>
                    <th className="text-right py-2 px-3">Units</th>
                    <th className="text-right py-2 px-3">NAV Buy → Redeem</th>
                    <th className="text-right py-2 px-3">Realized P&L</th>
                    <th className="text-right py-2 pl-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((h: any) => (
                    <tr key={h.id} className="border-b border-[var(--v6-border)]">
                      <td className="py-2.5 pr-3 font-bold text-[var(--v6-ink-soft)]">{h.schemeName}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-muted)]">{fmtNum(h.units, 3)}</td>
                      <td className="text-right py-2.5 px-3 font-mono text-[var(--v6-muted)]">{fmtINR(h.buyNav, 2)} → {fmtINR(h.sellNav, 2)}</td>
                      <td className={cn('text-right py-2.5 px-3 font-mono font-bold', toneClass(h.pnl))}>{fmtINR(h.pnl)} ({fmtPct(h.pnlPct)})</td>
                      <td className="text-right py-2.5 pl-3">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => reopen.mutate({ id: h.id })} title="Reopen" className="text-[var(--v6-faint)] hover:text-[var(--v6-accent-ink)]"><RotateCcw className="w-3.5 h-3.5" /></button>
                          <button onClick={() => del.mutate({ id: h.id })} title="Delete" className="text-[var(--v6-faint)] hover:text-[var(--v6-negative)]"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

// ─── Page ───────────────────────────────────────────────────────────────────

export const PortfolioTrackerPage: React.FC<{ userId?: string | null; onSelectStock?: (symbol: string) => void }> = ({ userId, onSelectStock }) => {
  const [tab, setTab] = useState<AssetTab>('stocks');

  if (!userId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center gap-5">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.2)' }}>
          <Briefcase className="w-8 h-8 text-[var(--v6-accent-ink)]" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-[var(--v6-ink)]">Portfolio Tracker</h2>
          <p className="text-sm text-[var(--v6-muted)] max-w-xs">Track your stocks and mutual funds with live P&L, sector allocation, and performance analytics.</p>
        </div>
        <div className="flex flex-col gap-2 text-left text-xs text-[var(--v6-faint)] bg-[var(--v6-bg-band)] border border-[var(--v6-border)] rounded-xl p-4 max-w-xs w-full">
          <div className="flex items-center gap-2"><span className="text-[var(--v6-positive)] font-bold">✓</span> Live unrealized P&amp;L</div>
          <div className="flex items-center gap-2"><span className="text-[var(--v6-positive)] font-bold">✓</span> Realized gain/loss history</div>
          <div className="flex items-center gap-2"><span className="text-[var(--v6-positive)] font-bold">✓</span> Sector allocation breakdown</div>
          <div className="flex items-center gap-2"><span className="text-[var(--v6-positive)] font-bold">✓</span> Best &amp; worst performers</div>
        </div>
        <p className="text-xs text-[var(--v6-faint)]">Sign in with Google to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="v1-title-page">Portfolio</h1>
          <p className="text-[11px] text-slate-400 mt-1">Track positions, P&amp;L, and sector allocation</p>
        </div>
        <div className="flex gap-1 p-0.5 bg-[var(--v6-bg-band)] rounded-xl">
          <button
            onClick={() => setTab('stocks')}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors', tab === 'stocks' ? 'bg-[var(--v6-accent)] text-white' : 'text-[var(--v6-muted)] hover:text-[var(--v6-ink)]')}
          ><Briefcase className="w-3.5 h-3.5" /> Stocks</button>
          <button
            onClick={() => setTab('mf')}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors', tab === 'mf' ? 'bg-[var(--v6-accent)] text-white' : 'text-[var(--v6-muted)] hover:text-[var(--v6-ink)]')}
          ><PiggyBank className="w-3.5 h-3.5" /> MF</button>
        </div>
      </div>

      {tab === 'stocks' ? <StocksTab onSelectStock={onSelectStock} /> : <MfTab />}
    </div>
  );
};

export default PortfolioTrackerPage;
