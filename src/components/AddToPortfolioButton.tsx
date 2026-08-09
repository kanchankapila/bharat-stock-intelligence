import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, Briefcase, Check } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

interface AddToPortfolioButtonProps {
  symbol: string;
  /** Prefills the buy-price field -- pass the row's current/last price if the card already has it. */
  currentPrice?: number | null;
  userId?: string | null;
  className?: string;
  /** Icon-only compact circular button (movers/watchlist rows) vs a small labeled pill (stock header). */
  variant?: 'icon' | 'pill';
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Reusable "+" add-to-portfolio control -- drop this next to any stock card. Opens a small
 * quantity/buy-price/buy-date form and calls portfolioRouter's addPortfolioHolding. Portable by
 * design (self-contained modal, only needs `symbol`) so wiring it into more surfaces beyond the
 * initial set (movers, top picks, watchlist, stock header) is a one-line addition.
 */
export const AddToPortfolioButton: React.FC<AddToPortfolioButtonProps> = ({
  symbol,
  currentPrice,
  userId,
  className,
  variant = 'icon',
}) => {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState('');
  const [buyPrice, setBuyPrice] = useState(currentPrice != null ? String(currentPrice) : '');
  const [buyDate, setBuyDate] = useState(todayISO());
  const [justAdded, setJustAdded] = useState(false);

  const utils = trpc.useContext();
  const addHolding = trpc.addPortfolioHolding.useMutation({
    onSuccess: () => {
      utils.getPortfolioHoldings.invalidate();
      utils.getPortfolioInsights.invalidate();
      setJustAdded(true);
      setTimeout(() => { setOpen(false); setJustAdded(false); setQuantity(''); }, 700);
    },
  });

  const openModal = (e: React.MouseEvent) => {
    e.stopPropagation();
    setBuyPrice(currentPrice != null ? String(currentPrice) : '');
    setBuyDate(todayISO());
    setOpen(true);
  };

  const submit = () => {
    const qty = parseFloat(quantity);
    const price = parseFloat(buyPrice);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0 || !buyDate) return;
    addHolding.mutate({ symbol, quantity: qty, buyPrice: price, buyDate });
  };

  const buttonNode = variant === 'pill' ? (
    <button
      onClick={openModal}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors',
        'bg-indigo-500/10 border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20',
        className,
      )}
      title="Add to portfolio"
    >
      <Briefcase className="w-3 h-3" /> Add to Portfolio
    </button>
  ) : (
    <button
      onClick={openModal}
      className={cn(
        'flex items-center justify-center w-5 h-5 rounded-full shrink-0 transition-colors',
        'bg-slate-800/80 text-slate-400 hover:bg-indigo-500 hover:text-white',
        className,
      )}
      title="Add to portfolio"
      aria-label={`Add ${symbol} to portfolio`}
    >
      <Plus className="w-3 h-3" />
    </button>
  );

  return (
    <>
      {buttonNode}
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-indigo-400" />
                  <h3 className="text-sm font-bold text-slate-100">Add {symbol} to Portfolio</h3>
                </div>
                <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {!userId ? (
                <div className="p-5 text-xs text-slate-500 font-mono">Sign in to track holdings in your portfolio.</div>
              ) : (
                <div className="p-5 space-y-3">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Quantity</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      placeholder="e.g. 10"
                      className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-sm font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Buy Price (₹)</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={buyPrice}
                      onChange={(e) => setBuyPrice(e.target.value)}
                      placeholder="Price per share"
                      className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-sm font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Buy Date</label>
                    <input
                      type="date"
                      value={buyDate}
                      max={todayISO()}
                      onChange={(e) => setBuyDate(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-sm font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  {quantity && buyPrice && Number.isFinite(parseFloat(quantity)) && Number.isFinite(parseFloat(buyPrice)) && (
                    <p className="text-[11px] text-slate-500 font-mono">
                      Total invested: ₹{(parseFloat(quantity) * parseFloat(buyPrice)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </p>
                  )}
                  <button
                    onClick={submit}
                    disabled={addHolding.isPending || justAdded}
                    className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-bold rounded-lg py-2.5 transition-colors"
                  >
                    {justAdded ? (<><Check className="w-4 h-4" /> Added</>) : addHolding.isPending ? 'Adding…' : 'Add to Portfolio'}
                  </button>
                  {addHolding.isError && (
                    <p className="text-[11px] text-rose-400">{addHolding.error?.message || 'Failed to add holding.'}</p>
                  )}
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
};

export default AddToPortfolioButton;
