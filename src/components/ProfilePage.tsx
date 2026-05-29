import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Upload, TrendingUp, TrendingDown, FileText, AlertTriangle,
  CheckCircle, Info, Wallet, ArrowUpRight, Receipt,
  BarChart2, Target, RefreshCw, ChevronDown, ChevronUp, User, Trash2,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type CSVType = 'transaction' | 'gain_loss' | 'ledger' | 'unknown';

interface FileMeta { name: string; type: CSVType; fy: string; }

interface TxnRow {
  tradeDate: string; securityName: string; transactionType: string;
  quantity: number; marketRate: number; total: number;
  gst: number; brokerage: number; misc: number; totalCharges: number; sttCtt: number;
  fy: string;
}
interface GLRow {
  scriptName: string; buyAmt: number; sellAmt: number;
  intraday: number; shortTerm: number; longTerm: number; totalPL: number;
  gst: number; brokerage: number; misc: number; sttCtt: number;
  totalCharges: number; netPL: number; grossPL: number; fy: string;
}
interface LRow {
  date: string; transType: string; narration: string;
  debit: number; credit: number; netBalance: number; fy: string;
}

interface ClientProfile {
  clientId: string;
  clientName: string;
  files: FileMeta[];
  txns: TxnRow[];
  gl: GLRow[];
  ledger: LRow[];
  lastUpdated: string;
}

const LS_KEY = 'bsi_trading_profiles_v2';

// ─── CSV Utilities ────────────────────────────────────────────────────────────

function parseLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSV(raw: string): string[][] {
  const clean = raw.replace(/﻿/g, '').replace(/\r/g, '');
  return clean.split('\n')
    .map(parseLine)
    .filter(r => r.some(c => c.replace(/"/g, '').trim() !== ''));
}

function num(s?: string): number {
  if (!s) return 0;
  const v = parseFloat(s.replace(/,/g, '').replace(/"/g, '').trim());
  return isNaN(v) ? 0 : v;
}

function extractFY(filename: string): string {
  const m = filename.match(/(\d{4})\d{4}_(\d{4})\d{4}/);
  if (m) return `FY ${m[1]}-${m[2].slice(2)}`;
  return 'Unknown FY';
}

function extractClientId(filename: string): string {
  const base  = filename.replace(/\.csv$/i, '');
  const parts = base.split('_');
  // Find the first part that's alphanumeric, 3-8 chars, not a date (8 digits), not type keyword
  const skip = new Set(['transaction', 'statement', 'gain', 'loss', 'ledger', 'val', 'brval']);
  for (const p of parts) {
    if (p.length >= 3 && p.length <= 8 && !/^\d{6,}$/.test(p) && !skip.has(p.toLowerCase())) {
      return p.toUpperCase();
    }
  }
  return 'DEFAULT';
}

function detectType(content: string, filename: string): CSVType {
  const f = filename.toLowerCase().replace(/\.csv$/, '');
  const parts = f.split('_');
  if (parts[0] === 'ledger')      return 'ledger';
  if (parts[0] === 'transaction') return 'transaction';
  if (parts[0] === 'gain')        return 'gain_loss';
  if (content.includes('Trans. Type') && content.includes('Net Balance')) return 'ledger';
  if (content.includes('Trade Date') && content.includes('Transaction Type')) return 'transaction';
  if (content.includes('Buy Amt')   || content.includes('Net P&L'))          return 'gain_loss';
  return 'unknown';
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseTxns(raw: string, fy: string): TxnRow[] {
  const rows = parseCSV(raw);
  const hi   = rows.findIndex(r => r[0]?.replace(/"/g, '').trim().includes('Trade Date'));
  if (hi < 0) return [];
  return rows.slice(hi + 1).map(r => ({
    tradeDate: r[0], securityName: r[3], transactionType: r[7],
    quantity: num(r[8]), marketRate: num(r[9]), total: num(r[10]),
    gst: num(r[11]), brokerage: num(r[12]), misc: num(r[13]),
    totalCharges: num(r[14]), sttCtt: num(r[15]), fy,
  })).filter(r => r.securityName && (r.transactionType === 'Buy' || r.transactionType === 'Sell'));
}

function parseGL(raw: string, fy: string): { rows: GLRow[]; clientName: string; clientId: string } {
  const rows = parseCSV(raw);
  // Extract client name/code from header rows
  let clientName = '', clientId = '';
  for (const r of rows.slice(0, 5)) {
    if (r[0]?.includes('Client Name')) clientName = r[1]?.trim() ?? '';
    if (r[0]?.includes('Client Code')) clientId   = r[1]?.trim() ?? '';
  }
  const hi = rows.findIndex(r => r[0]?.replace(/"/g, '').trim().includes('Script Name'));
  if (hi < 0) return { rows: [], clientName, clientId };
  const out: GLRow[] = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r    = rows[i];
    const name = r[0]?.replace(/"/g, '').trim();
    if (!name || name === 'Equity' || name === 'Script Name' || name.startsWith('Disclaimer') || name.startsWith('Gain amount')) continue;
    if (r.length < 15) continue;
    out.push({
      scriptName: name, buyAmt: num(r[4]), sellAmt: num(r[5]),
      intraday: num(r[6]), shortTerm: num(r[7]), longTerm: num(r[8]), totalPL: num(r[9]),
      gst: num(r[10]), brokerage: num(r[11]), misc: num(r[12]), sttCtt: num(r[13]),
      totalCharges: num(r[14]), netPL: num(r[15]), grossPL: num(r[16] ?? r[15]), fy,
    });
  }
  return { rows: out, clientName, clientId };
}

function parseLedger(raw: string, fy: string): LRow[] {
  const rows = parseCSV(raw);
  const hi   = rows.findIndex(r => r[0]?.replace(/"/g, '').trim() === 'Date');
  if (hi < 0) return [];
  return rows.slice(hi + 1).map(r => ({
    date:       r[0]?.replace(/"/g, '').trim() ?? '',
    transType:  r[2]?.replace(/"/g, '').trim() ?? '',
    narration:  r[3]?.replace(/"/g, '').trim() ?? '',
    debit:      num(r[4]),
    credit:     num(r[5]),
    netBalance: num(r[6]),
    fy,
  })).filter(r => /\d{2}\/\d{2}\/\d{4}/.test(r.date));
}

// ─── Ledger entry categorisation (CA-level) ───────────────────────────────────
//
// Ledger entry types:
//   OPBAL     – opening balance carry-forward
//   Others    – year-boundary balance transfer
//   RECEIPT   – cash deposited from your bank into Kotak
//   PAYMENT   – cash withdrawn from Kotak to your bank
//   Withdrawal– cash returned by exchange (SEBI mandate)
//   BILL      – stock trade settlement (credit = sell proceeds, debit = buy cost)
//               Sub-type "OTHER CHARGES" prefix = tiny exchange levies (< ₹50)
//   JV        – journal vouchers: DP charges, interest, auction, blocked amounts
//
// JV sub-types (identified by narration):
//   DP CHGS / DP TRANSACTION → demat maintenance charges (monthly fixed fee)
//   IC - INTEREST             → debit interest (when account goes negative)
//   AUC INT                   → auction penalty (actual cost of short delivery)
//   SHORT 150%                → blocked deposit for short delivery (TEMPORARY – reversed)
//   SHORT REV 150%            → reversal of the above block (nets to zero with SHORT 150%)
//
// IMPORTANT: SHORT 150% and SHORT REV 150% entries cancel each other → net zero.
// They must be EXCLUDED from all charge totals to avoid double-counting.

const isDeposit     = (l: LRow) => l.transType === 'RECEIPT' && l.credit > 0;
const isWithdrawal  = (l: LRow) => (l.transType === 'PAYMENT' || l.transType === 'Withdrawal') && l.debit > 0;
// Sell settlement: BILL credit (gross sell proceeds before netting)
const isBillCredit  = (l: LRow) => l.transType === 'BILL' && l.credit > 0 && !l.narration.startsWith('OTHER CHARGES');
// Buy settlement: BILL debit (gross buy cost after netting)
const isBillDebit   = (l: LRow) => l.transType === 'BILL' && l.debit > 0 && !l.narration.startsWith('OTHER CHARGES');
// Tiny exchange levies bundled inside BILL settlements
const isBillLevy    = (l: LRow) => l.transType === 'BILL' && l.narration.startsWith('OTHER CHARGES');
// DP charges — MUST be JV + debit + DP in narration (NOT BILL)
const isDPCharge    = (l: LRow) => l.transType === 'JV' && l.debit > 0 &&
  (l.narration.toUpperCase().includes('DP CHGS') || l.narration.toUpperCase().includes('DP TRANSACTION'));
// Auction penalty — MUST be JV + debit + AUC INT (NOT the SHORT 150% block)
const isAuction     = (l: LRow) => l.transType === 'JV' && l.debit > 0 && l.narration.toUpperCase().includes('AUC INT');
// Debit interest — MUST be JV + debit + IC - INTEREST
const isInterest    = (l: LRow) => l.transType === 'JV' && l.debit > 0 && l.narration.toUpperCase().includes('IC - INTEREST');
// SHORT 150% block — temporary, reversed by SHORT REV — exclude from totals
const isShortBlock  = (l: LRow) => l.transType === 'JV' && l.narration.toUpperCase().includes('SHORT 150%') && !l.narration.toUpperCase().includes('SHORT REV');
const isShortRev    = (l: LRow) => l.transType === 'JV' && l.narration.toUpperCase().includes('SHORT REV');
// Any remaining JV debits/credits not matching the above (miscellaneous adjustments)
const isOtherJVDebit  = (l: LRow) => l.transType === 'JV' && l.debit > 0 && !isDPCharge(l) && !isAuction(l) && !isInterest(l) && !isShortBlock(l);
const isOtherJVCredit = (l: LRow) => l.transType === 'JV' && l.credit > 0 && !isShortRev(l);

// ─── INR formatter ────────────────────────────────────────────────────────────

const INR = (v: number, opts?: { sign?: boolean; abs?: boolean }) => {
  const abs = opts?.abs ? Math.abs(v) : v;
  const str = Math.abs(abs).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const sign = opts?.sign && v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}₹${str}`;
};

// ─── Small UI components ──────────────────────────────────────────────────────

function Card({ label, value, sub, color, icon: Icon, highlight }: {
  label: string; value: string; sub?: string; color: string; icon: any; highlight?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-2 ${highlight ? 'bg-indigo-950/30 border-indigo-800' : 'bg-slate-900 border-slate-800'}`}>
      <div className="flex items-center gap-1.5 text-slate-400 text-[11px] font-semibold uppercase tracking-wider">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className={`text-2xl font-black ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function LRow_({ label, value, color = 'text-slate-200', bold = false, indent = false, divider = false }: {
  label: string; value: string; color?: string; bold?: boolean; indent?: boolean; divider?: boolean;
}) {
  return (
    <div className={`flex justify-between py-2 text-sm ${divider ? 'border-t border-slate-700 mt-1 pt-3' : 'border-b border-slate-800/50'}`}>
      <span className={`${indent ? 'pl-4 text-slate-400' : bold ? 'font-bold text-white' : 'text-slate-300'}`}>{label}</span>
      <span className={`font-mono ${bold ? 'font-black text-base' : 'font-medium'} ${color}`}>{value}</span>
    </div>
  );
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const w = max === 0 ? 0 : Math.min(100, (Math.abs(value) / max) * 100);
  return <div className="h-2 rounded bg-slate-700 flex-1"><div className={`h-full rounded ${color}`} style={{ width: `${w}%` }} /></div>;
}

// ─── Analytics for a single client ───────────────────────────────────────────

function ClientAnalytics({ profile }: { profile: ClientProfile }) {
  const { txns, gl, ledger } = profile;
  const [tab, setTab]           = useState<'cashflow' | 'pnl' | 'stocks' | 'charges' | 'behavior'>('cashflow');
  const [expandedYear, setExpY] = useState<string | null>(null);

  // ── Ledger aggregates (CA-precise categorisation) ──
  const totalDeposited  = ledger.filter(isDeposit).reduce((s, l) => s + l.credit, 0);
  const totalWithdrawn  = ledger.filter(isWithdrawal).reduce((s, l) => s + l.debit, 0);
  const billCredits     = ledger.filter(isBillCredit).reduce((s, l) => s + l.credit, 0);
  const billDebits      = ledger.filter(isBillDebit).reduce((s, l) => s + l.debit, 0);
  const billLevies      = ledger.filter(isBillLevy).reduce((s, l) => s + l.debit, 0);
  // JV sub-totals — each filter REQUIRES transType=JV to prevent BILL bleed-through
  const totalDP         = ledger.filter(isDPCharge).reduce((s, l) => s + l.debit, 0);
  const totalAuction    = ledger.filter(isAuction).reduce((s, l) => s + l.debit, 0);
  const totalInterest   = ledger.filter(isInterest).reduce((s, l) => s + l.debit, 0);
  // SHORT 150% block and its reversal net to zero — exclude from totals
  const shortBlocked    = ledger.filter(isShortBlock).reduce((s, l) => s + l.debit, 0);
  const shortReversed   = ledger.filter(isShortRev).reduce((s, l) => s + l.credit, 0);
  const otherJVDebits   = ledger.filter(isOtherJVDebit).reduce((s, l) => s + l.debit, 0);
  const otherJVCredits  = ledger.filter(isOtherJVCredit).reduce((s, l) => s + l.credit, 0);
  const openingBal      = (() => { const r = [...ledger].sort((a, b) => a.date.localeCompare(b.date)).find(l => l.transType === 'OPBAL'); return r ? (r.credit - r.debit) : 0; })();
  const closingBal      = ledger.length > 0 ? ledger[0].netBalance : 0;
  const netCashReturn   = totalWithdrawn - totalDeposited;

  // Transactions
  const buyTxns        = txns.filter(t => t.transactionType === 'Buy');
  const totalBuy       = buyTxns.reduce((s, t) => s + t.total, 0);
  const totalSell      = txns.filter(t => t.transactionType === 'Sell').reduce((s, t) => s + t.total, 0);
  const totalBrokerage = txns.reduce((s, t) => s + t.brokerage, 0);
  const totalGST       = txns.reduce((s, t) => s + t.gst, 0);
  const totalSTT       = txns.reduce((s, t) => s + t.sttCtt, 0);
  const totalMisc      = txns.reduce((s, t) => s + t.misc, 0);
  const totalTxnChg    = txns.reduce((s, t) => s + t.totalCharges, 0);

  // G&L
  const totalNetPL     = gl.reduce((s, g) => s + g.netPL, 0);
  const totalGrossPL   = gl.reduce((s, g) => s + g.grossPL, 0);
  const totalGLChg     = gl.reduce((s, g) => s + g.totalCharges + g.sttCtt, 0);
  const totalAllChg    = (totalTxnChg || totalGLChg) + totalDP + totalAuction + totalInterest;

  // Year-wise
  const fyMap = new Map<string, GLRow[]>();
  for (const g of gl) { const a = fyMap.get(g.fy) ?? []; a.push(g); fyMap.set(g.fy, a); }
  const yearwise = Array.from(fyMap.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([fy, rows]) => ({
    fy, netPL: rows.reduce((s, g) => s + g.netPL, 0),
    charges: rows.reduce((s, g) => s + g.totalCharges + g.sttCtt, 0), stocks: rows,
  }));
  const maxAbsPL    = Math.max(1, ...yearwise.map(y => Math.abs(y.netPL)));
  const sortedStocks = [...gl].sort((a, b) => b.netPL - a.netPL);
  const winners = sortedStocks.filter(g => g.netPL > 0).slice(0, 5);
  const losers  = [...sortedStocks].reverse().filter(g => g.netPL < 0).slice(0, 5);

  // Behaviors
  type Sev = 'warn' | 'info' | 'ok';
  const behaviors: { title: string; body: string; severity: Sev }[] = [];
  if (gl.length > 0) {
    const top = sortedStocks[0];
    if (top && totalGrossPL > 0 && (top.grossPL / totalGrossPL) * 100 > 60)
      behaviors.push({ severity: 'warn', title: 'Concentration Risk', body: `${((top.grossPL / totalGrossPL) * 100).toFixed(0)}% of profit from ${top.scriptName} alone.` });
    const bigLT = gl.filter(g => g.longTerm < -3000);
    if (bigLT.length > 0) behaviors.push({ severity: 'warn', title: 'No Stop-Loss on Long-Term Losses', body: `${bigLT.map(g => g.scriptName).join(', ')} held >1yr at significant loss.` });
    const wipeout = gl.filter(g => g.buyAmt > 1000 && g.sellAmt < g.buyAmt * 0.2);
    if (wipeout.length > 0) behaviors.push({ severity: 'warn', title: 'Near-Total Capital Loss', body: `${wipeout.map(g => g.scriptName).join(', ')} — lost >80% of invested capital.` });
  }
  if (txns.length > 0) {
    const pennyVal = buyTxns.filter(t => t.marketRate > 0 && t.marketRate < 10).reduce((s, t) => s + t.total, 0);
    if (pennyVal > 5000) behaviors.push({ severity: 'warn', title: 'High Penny-Stock Exposure', body: `${INR(pennyVal)} (${totalBuy > 0 ? ((pennyVal / totalBuy) * 100).toFixed(0) : 0}% of buys) in sub-₹10 stocks.` });
    const stockBuys = new Map<string, number[]>();
    for (const t of buyTxns) { const a = stockBuys.get(t.securityName) ?? []; a.push(t.marketRate); stockBuys.set(t.securityName, a); }
    const avgDown: string[] = [];
    for (const [name, prices] of stockBuys) if (prices.length >= 3 && prices[prices.length - 1] < prices[0] * 0.7) avgDown.push(name);
    if (avgDown.length > 0) behaviors.push({ severity: 'info', title: 'Averaging Down Detected', body: `${avgDown.join(', ')}: multiple buys at declining prices.` });
  }
  if (totalAuction > 0) behaviors.push({ severity: 'warn', title: 'Auction Penalty', body: `${INR(totalAuction)} lost to exchange auction — likely mixed platform (Kotak + Smallcase) on same settlement date.` });
  if (totalDP > 0) behaviors.push({ severity: 'info', title: 'DP Charges on Dormant Holdings', body: `${INR(totalDP)} paid for demat maintenance including periods with no trades.` });
  if (behaviors.length === 0) behaviors.push({ severity: 'ok', title: 'No critical patterns detected', body: 'Upload more files for deeper analysis.' });

  const hasGL = gl.length > 0, hasTxn = txns.length > 0, hasLedger = ledger.length > 0;

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label="Net P&L (Realized)" value={INR(totalNetPL, { sign: true })} sub={`${gl.length} positions · ${yearwise.length} FYs`} color={totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'} icon={totalNetPL >= 0 ? TrendingUp : TrendingDown} highlight />
        <Card label="Total Buy Value" value={INR(totalBuy || gl.reduce((s,g)=>s+g.buyAmt,0))} sub={`${buyTxns.length || '—'} buy transactions`} color="text-blue-400" icon={ArrowUpRight} />
        <Card label="Cash Deposited" value={totalDeposited > 0 ? INR(totalDeposited) : 'No ledger'} sub={totalWithdrawn > 0 ? `Withdrawn: ${INR(totalWithdrawn)}` : 'Upload Ledger CSVs'} color="text-purple-400" icon={Wallet} />
        <Card label="Total Charges" value={INR(totalAllChg || totalGLChg)} sub="Brokerage + STT + GST + DP + penalties" color="text-amber-400" icon={Receipt} />
      </div>

      {/* Net cash return banner */}
      {hasLedger && (
        <div className={`rounded-xl border p-4 ${netCashReturn >= 0 ? 'bg-emerald-950/20 border-emerald-900/50' : 'bg-red-950/20 border-red-900/50'}`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">Net Cash Return (Bank → Kotak → Bank)</div>
              <div className={`text-3xl font-black ${netCashReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{INR(netCashReturn, { sign: true })}</div>
              <div className="text-xs text-slate-500 mt-1">Withdrew {INR(totalWithdrawn)} − Deposited {INR(totalDeposited)} from your bank account</div>
            </div>
            {netCashReturn >= 0 ? <CheckCircle className="w-10 h-10 text-emerald-700" /> : <AlertTriangle className="w-10 h-10 text-red-700" />}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 overflow-x-auto">
        {([['cashflow','Cash Flow'], ['pnl','P&L by Year'], ['stocks','Stock-wise'], ['charges','Charges'], ['behavior','Insights']] as [typeof tab, string][]).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${tab === id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>{label}</button>
        ))}
      </div>

      {/* ── CASH FLOW ── */}
      {tab === 'cashflow' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
            <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2"><Wallet className="w-4 h-4 text-purple-400" /> Cash Flow Statement</h3>
            {hasLedger ? (
              <div className="space-y-0">
                <LRow_ label="Opening Balance" value={INR(openingBal, { sign: true })} />
                <LRow_ label="+ Cash deposited from bank (RECEIPT)" value={INR(totalDeposited)} color="text-blue-400" indent />
                <LRow_ label="+ Stock sale settlements (BILL credits)" value={INR(billCredits)} color="text-emerald-400" indent />
                {otherJVCredits > 0 && <LRow_ label="+ Other JV credits (misc adjustments)" value={INR(otherJVCredits)} color="text-emerald-300" indent />}
                <LRow_ label="− Stock purchase settlements (BILL debits)" value={`-${INR(billDebits)}`} color="text-slate-400" indent />
                {billLevies > 0    && <LRow_ label="− Exchange levies (BILL other charges)" value={`-${INR(billLevies)}`} color="text-orange-300" indent />}
                {totalDP > 0       && <LRow_ label="− DP / demat charges (JV)" value={`-${INR(totalDP)}`} color="text-orange-400" indent />}
                {totalAuction > 0  && <LRow_ label="− Auction penalty — AUC INT (JV)" value={`-${INR(totalAuction)}`} color="text-red-400" indent />}
                {totalInterest > 0 && <LRow_ label="− Debit interest (JV)" value={`-${INR(totalInterest)}`} color="text-red-400" indent />}
                {otherJVDebits > 0 && <LRow_ label="− Other JV debits (misc adjustments)" value={`-${INR(otherJVDebits)}`} color="text-slate-400" indent />}
                {shortBlocked > 0  && <LRow_ label="  SHORT 150% block (JV) — reversed below" value={`-${INR(shortBlocked)}`} color="text-slate-600" indent />}
                {shortReversed > 0 && <LRow_ label="  SHORT REV 150% (JV) — nets zero with above" value={INR(shortReversed)} color="text-slate-600" indent />}
                <LRow_ label="− Withdrawn to bank (PAYMENT / Withdrawal)" value={`-${INR(totalWithdrawn)}`} color="text-red-400" indent />
                <LRow_ label="Closing Balance" value={INR(closingBal, { sign: true })} color="text-white" bold divider />
                {shortBlocked > 0 && (
                  <div className="mt-2 text-[10px] text-slate-600 px-1">
                    ✓ SHORT 150% ({INR(shortBlocked)}) and SHORT REV ({INR(shortReversed)}) cancel out — net zero impact
                  </div>
                )}
              </div>
            ) : <p className="text-slate-500 text-sm">Upload Ledger CSVs to see full cash flow</p>}
          </div>

          <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
            <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" /> P&L Waterfall</h3>
            <div className="space-y-0">
              {hasTxn && <LRow_ label="Total Buy Value" value={INR(totalBuy)} color="text-blue-400" />}
              {hasTxn && <LRow_ label="Total Sell Value" value={INR(totalSell)} color="text-emerald-400" />}
              {hasGL  && <LRow_ label="Gross P&L" value={INR(totalGrossPL, { sign: true })} color={totalGrossPL >= 0 ? 'text-emerald-400' : 'text-red-400'} />}
              {(totalTxnChg || totalGLChg) > 0 && <LRow_ label="− Exchange charges (brokerage+STT+GST+misc)" value={`-${INR(totalTxnChg || totalGLChg)}`} color="text-orange-400" indent />}
              {hasGL  && <LRow_ label="Net P&L (post exchange charges)" value={INR(totalNetPL, { sign: true })} color={totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'} />}
              {totalDP > 0       && <LRow_ label="− DP charges" value={`-${INR(totalDP)}`} color="text-orange-400" indent />}
              {totalAuction > 0  && <LRow_ label="− Auction penalties (avoidable)" value={`-${INR(totalAuction)}`} color="text-red-400" indent />}
              {totalInterest > 0 && <LRow_ label="− Debit interest" value={`-${INR(totalInterest)}`} color="text-red-400" indent />}
              <LRow_ label="True Net P&L (all costs)" value={INR(totalNetPL - totalDP - totalAuction - totalInterest, { sign: true })} color={(totalNetPL - totalDP - totalAuction - totalInterest) >= 0 ? 'text-emerald-400' : 'text-red-400'} bold divider />
            </div>

            {hasLedger && hasGL && (
              <div className="mt-4 p-3 rounded-lg bg-slate-800 border border-slate-700 text-xs space-y-1">
                <div className="font-bold text-slate-400 uppercase mb-2 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Reconciliation</div>
                <div className="flex justify-between"><span className="text-slate-400">G&L Net P&L</span><span className={`font-mono ${totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{INR(totalNetPL, { sign: true })}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Ledger net cash return</span><span className={`font-mono ${netCashReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{INR(netCashReturn, { sign: true })}</span></div>
                <div className="flex justify-between border-t border-slate-700 pt-1"><span className="text-slate-400">Difference (unrealized + timing)</span><span className="font-mono text-amber-400">{INR(totalNetPL - netCashReturn, { sign: true })}</span></div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── P&L BY YEAR ── */}
      {tab === 'pnl' && (
        <div className="space-y-3">
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
            <h3 className="text-sm font-bold text-slate-300 mb-4">Year-wise Net P&L</h3>
            <div className="space-y-3">
              {yearwise.map(y => (
                <div key={y.fy} className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-24 flex-shrink-0">{y.fy}</span>
                  <MiniBar value={y.netPL} max={maxAbsPL} color={y.netPL >= 0 ? 'bg-emerald-500' : 'bg-red-500'} />
                  <span className={`text-xs font-bold font-mono w-28 text-right flex-shrink-0 ${y.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{INR(y.netPL, { sign: true })}</span>
                </div>
              ))}
            </div>
          </div>
          {yearwise.map(y => (
            <div key={y.fy} className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
              <button onClick={() => setExpY(expandedYear === y.fy ? null : y.fy)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/50 transition-colors">
                <div className="flex items-center gap-3">
                  <span className="font-bold text-white">{y.fy}</span>
                  <span className="text-slate-500 text-sm">{y.stocks.length} stocks</span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className={`font-black font-mono ${y.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{INR(y.netPL, { sign: true })}</div>
                    <div className="text-xs text-orange-400">charges: -{INR(y.charges)}</div>
                  </div>
                  {expandedYear === y.fy ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                </div>
              </button>
              {expandedYear === y.fy && (
                <div className="border-t border-slate-800 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-slate-800">{['Stock','Buy ₹','Sell ₹','STCG','LTCG','Charges','Net P&L','ROI'].map(h => <th key={h} className="text-left px-3 py-2 text-slate-500 font-semibold whitespace-nowrap">{h}</th>)}</tr></thead>
                    <tbody>
                      {[...y.stocks].sort((a,b)=>b.netPL-a.netPL).map(s => {
                        const ret = s.buyAmt > 0 ? (s.netPL/s.buyAmt)*100 : 0;
                        return (
                          <tr key={s.scriptName} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                            <td className="px-3 py-2 font-medium text-white whitespace-nowrap">{s.scriptName}</td>
                            <td className="px-3 py-2 text-blue-400 font-mono">{INR(s.buyAmt)}</td>
                            <td className="px-3 py-2 text-slate-300 font-mono">{INR(s.sellAmt)}</td>
                            <td className={`px-3 py-2 font-mono ${s.shortTerm>0?'text-emerald-400':s.shortTerm<0?'text-red-400':'text-slate-600'}`}>{s.shortTerm!==0?INR(s.shortTerm,{sign:true}):'—'}</td>
                            <td className={`px-3 py-2 font-mono ${s.longTerm>0?'text-emerald-400':s.longTerm<0?'text-red-400':'text-slate-600'}`}>{s.longTerm!==0?INR(s.longTerm,{sign:true}):'—'}</td>
                            <td className="px-3 py-2 text-orange-400 font-mono">-{INR(s.totalCharges+s.sttCtt)}</td>
                            <td className={`px-3 py-2 font-bold font-mono ${s.netPL>=0?'text-emerald-400':'text-red-400'}`}>{INR(s.netPL,{sign:true})}</td>
                            <td className={`px-3 py-2 font-mono ${ret>=0?'text-emerald-400':'text-red-400'}`}>{ret>=0?'+':''}{ret.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot><tr className="bg-slate-800/50">
                      <td className="px-3 py-2 font-bold text-white">Total</td>
                      <td className="px-3 py-2 text-blue-400 font-mono font-bold">{INR(y.stocks.reduce((s,g)=>s+g.buyAmt,0))}</td>
                      <td className="px-3 py-2 text-emerald-400 font-mono font-bold">{INR(y.stocks.reduce((s,g)=>s+g.sellAmt,0))}</td>
                      <td className="px-3 py-2 font-mono font-bold text-slate-300">{INR(y.stocks.reduce((s,g)=>s+g.shortTerm,0),{sign:true})}</td>
                      <td className="px-3 py-2 font-mono font-bold text-slate-300">{INR(y.stocks.reduce((s,g)=>s+g.longTerm,0),{sign:true})}</td>
                      <td className="px-3 py-2 text-orange-400 font-mono font-bold">-{INR(y.charges)}</td>
                      <td className={`px-3 py-2 font-black font-mono text-sm ${y.netPL>=0?'text-emerald-400':'text-red-400'}`}>{INR(y.netPL,{sign:true})}</td>
                      <td />
                    </tr></tfoot>
                  </table>
                </div>
              )}
            </div>
          ))}
          {yearwise.length > 1 && (
            <div className="rounded-xl bg-indigo-950/30 border border-indigo-800 p-4 flex items-center justify-between">
              <div><div className="text-sm text-slate-400">All Years Combined</div><div className="text-xs text-slate-500">{gl.length} positions · {yearwise.length} FYs</div></div>
              <div className="text-right">
                <div className={`text-3xl font-black ${totalNetPL>=0?'text-emerald-400':'text-red-400'}`}>{INR(totalNetPL,{sign:true})}</div>
                <div className="text-xs text-orange-400">charges: -{INR(totalGLChg)}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── STOCKS ── */}
      {tab === 'stocks' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
              <h3 className="text-sm font-bold text-emerald-400 mb-3">🏆 Top Winners</h3>
              {winners.map(g => (
                <div key={g.scriptName+g.fy} className="flex items-center justify-between py-2 border-b border-slate-800/50">
                  <div><div className="text-sm font-medium text-white">{g.scriptName}</div><div className="text-xs text-slate-500">{g.fy} · {INR(g.buyAmt)} invested</div></div>
                  <div className="text-right"><div className="text-sm font-bold text-emerald-400 font-mono">{INR(g.netPL,{sign:true})}</div><div className="text-xs text-emerald-600">+{g.buyAmt>0?((g.netPL/g.buyAmt)*100).toFixed(1):'∞'}%</div></div>
                </div>
              ))}
            </div>
            <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
              <h3 className="text-sm font-bold text-red-400 mb-3">📉 Biggest Losses</h3>
              {losers.map(g => (
                <div key={g.scriptName+g.fy} className="flex items-center justify-between py-2 border-b border-slate-800/50">
                  <div><div className="text-sm font-medium text-white">{g.scriptName}</div><div className="text-xs text-slate-500">{g.fy} · {INR(g.buyAmt)} invested</div></div>
                  <div className="text-right"><div className="text-sm font-bold text-red-400 font-mono">{INR(g.netPL,{sign:true})}</div><div className="text-xs text-red-600">{g.buyAmt>0?((g.netPL/g.buyAmt)*100).toFixed(1):'—'}%</div></div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800"><span className="text-sm font-bold text-slate-300">All Positions ({gl.length})</span></div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-slate-800">{['Stock','FY','Buy ₹','Sell ₹','STCG','LTCG','Charges','Net P&L','ROI'].map(h=><th key={h} className="text-left px-4 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody>
                  {sortedStocks.map((s,i) => {
                    const ret = s.buyAmt > 0 ? (s.netPL/s.buyAmt)*100 : 0;
                    return (
                      <tr key={s.scriptName+s.fy} className={`border-b border-slate-800/50 ${i%2?'bg-slate-800/10':''}`}>
                        <td className="px-4 py-2 font-medium text-white whitespace-nowrap">{s.scriptName}</td>
                        <td className="px-4 py-2 text-slate-500">{s.fy}</td>
                        <td className="px-4 py-2 text-blue-400 font-mono">{INR(s.buyAmt)}</td>
                        <td className="px-4 py-2 text-slate-300 font-mono">{INR(s.sellAmt)}</td>
                        <td className={`px-4 py-2 font-mono ${s.shortTerm>0?'text-emerald-400':s.shortTerm<0?'text-red-400':'text-slate-600'}`}>{s.shortTerm!==0?INR(s.shortTerm,{sign:true}):'—'}</td>
                        <td className={`px-4 py-2 font-mono ${s.longTerm>0?'text-emerald-400':s.longTerm<0?'text-red-400':'text-slate-600'}`}>{s.longTerm!==0?INR(s.longTerm,{sign:true}):'—'}</td>
                        <td className="px-4 py-2 text-orange-400 font-mono">-{INR(s.totalCharges+s.sttCtt)}</td>
                        <td className={`px-4 py-2 font-bold font-mono ${s.netPL>=0?'text-emerald-400':'text-red-400'}`}>{INR(s.netPL,{sign:true})}</td>
                        <td className={`px-4 py-2 font-mono ${ret>=0?'text-emerald-400':'text-red-400'}`}>{ret>=0?'+':''}{ret.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── CHARGES ── */}
      {tab === 'charges' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[
              { label: 'Brokerage', v: totalBrokerage || gl.reduce((s,g)=>s+g.brokerage,0), desc: '₹21/order or % of value' },
              { label: 'STT / CTT', v: totalSTT || gl.reduce((s,g)=>s+g.sttCtt,0), desc: 'Securities Transaction Tax' },
              { label: 'GST on Brokerage', v: totalGST || gl.reduce((s,g)=>s+g.gst,0), desc: '18% of brokerage' },
              { label: 'Misc / Exchange', v: totalMisc || gl.reduce((s,g)=>s+g.misc,0), desc: 'SEBI fee, stamp duty, clearing' },
              { label: 'DP Charges', v: totalDP, desc: 'Demat maintenance (monthly)' },
              { label: 'Auction Penalties', v: totalAuction, desc: 'Short delivery — avoidable' },
              { label: 'Debit Interest', v: totalInterest, desc: 'Charged when balance negative' },
            ].filter(c=>c.v>0).map(c => (
              <div key={c.label} className="rounded-xl bg-slate-900 border border-slate-800 p-3">
                <div className="text-xs text-slate-500 mb-1">{c.label}</div>
                <div className="text-xl font-black text-amber-400">{INR(c.v)}</div>
                <div className="text-[10px] text-slate-600 mt-1">{c.desc}</div>
              </div>
            ))}
          </div>
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
            <h3 className="text-sm font-bold text-slate-300 mb-3">Charge Impact on P&L</h3>
            <div className="space-y-0">
              {totalGrossPL!==0 && <LRow_ label="Gross P&L (before charges)" value={INR(totalGrossPL,{sign:true})} color={totalGrossPL>=0?'text-emerald-400':'text-red-400'} />}
              {(totalTxnChg||totalGLChg)>0 && <LRow_ label="− Exchange charges" value={`-${INR(totalTxnChg||totalGLChg)}`} color="text-orange-400" indent />}
              {totalNetPL!==0 && <LRow_ label="Net P&L (after exchange charges)" value={INR(totalNetPL,{sign:true})} color={totalNetPL>=0?'text-emerald-400':'text-red-400'} />}
              {totalDP>0 && <LRow_ label="− DP charges" value={`-${INR(totalDP)}`} color="text-orange-400" indent />}
              {totalAuction>0 && <LRow_ label="− Auction penalties" value={`-${INR(totalAuction)}`} color="text-red-400" indent />}
              {totalInterest>0 && <LRow_ label="− Debit interest" value={`-${INR(totalInterest)}`} color="text-red-400" indent />}
              <LRow_ label="True Net P&L (all costs)" value={INR(totalNetPL-totalDP-totalAuction-totalInterest,{sign:true})} color={(totalNetPL-totalDP-totalAuction-totalInterest)>=0?'text-emerald-400':'text-red-400'} bold divider />
            </div>
          </div>
        </div>
      )}

      {/* ── BEHAVIOR ── */}
      {tab === 'behavior' && (
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
            <div className="flex items-center gap-2 mb-4"><Target className="w-4 h-4 text-indigo-400" /><h3 className="text-sm font-bold text-slate-300">Auto-Detected Patterns</h3></div>
            <div className="space-y-3">
              {behaviors.map((b,i) => (
                <div key={i} className={`rounded-lg p-3 border ${b.severity==='warn'?'bg-amber-950/20 border-amber-900/50':b.severity==='ok'?'bg-emerald-950/20 border-emerald-900/50':'bg-slate-800 border-slate-700'}`}>
                  <div className="flex items-start gap-2">
                    {b.severity==='warn'?<AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0"/>:b.severity==='ok'?<CheckCircle className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0"/>:<Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0"/>}
                    <div><div className="text-sm font-semibold text-white">{b.title}</div><div className="text-xs text-slate-400 mt-0.5">{b.body}</div></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { emoji:'✅', title:'What works', color:'border-emerald-900/50', items:['COVID crash recovery timing','Early entry in growth stories (Adani Green at ₹85)','Patience on high-conviction plays','Delivery-only — avoids intraday noise'] },
              { emoji:'❌', title:"Doesn't work",  color:'border-red-900/50',     items:['No stop-loss — positions held to near-zero','Averaging down on structurally broken cos.','Mixing platforms (Kotak + Smallcase) on same stock','Holding dormant losers while paying DP charges'] },
              { emoji:'📏', title:'Rules to adopt', color:'border-indigo-900/50', items:['Set exit price before every entry','Max 20% capital in sub-₹10 stocks','Max 2 averages on any single position','One platform per stock (T+2 discipline)','Quarterly review — exit −30% with no thesis'] },
            ].map(s => (
              <div key={s.title} className={`rounded-xl bg-slate-900 border ${s.color} p-4`}>
                <div className="font-semibold text-white mb-3">{s.emoji} {s.title}</div>
                <ul className="space-y-1.5">{s.items.map((item,i) => <li key={i} className="text-xs text-slate-400 flex items-start gap-2"><span className="text-slate-600 flex-shrink-0 mt-0.5">·</span>{item}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const [clients, setClients]       = useState<Map<string, ClientProfile>>(new Map());
  const [activeClient, setActive]   = useState<string>('');
  const [dragOver, setDragOver]     = useState(false);
  const [uploading, setUploading]   = useState(false);
  const fileRef                     = useRef<HTMLInputElement>(null);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const entries: [string, ClientProfile][] = JSON.parse(raw);
        const map = new Map(entries);
        setClients(map);
        if (map.size > 0) setActive(map.keys().next().value as string);
      }
    } catch { /* ignore corrupt data */ }
  }, []);

  // Save to localStorage whenever clients change
  useEffect(() => {
    if (clients.size === 0) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify([...clients.entries()]));
    } catch (e: any) {
      // Storage quota exceeded — try clearing old data
      if (e.name === 'QuotaExceededError') {
        console.warn('[Profile] localStorage quota exceeded — clearing old profile data');
        localStorage.removeItem(LS_KEY);
      }
    }
  }, [clients]);

  const processFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;
    setUploading(true);
    const promises = Array.from(incoming).map(file => new Promise<void>(resolve => {
      const reader = new FileReader();
      reader.onload = e => {
        const content = (e.target?.result as string) ?? '';
        const type    = detectType(content, file.name);
        const fy      = extractFY(file.name);
        const clientId = extractClientId(file.name);

        setClients(prev => {
          const next = new Map(prev);
          const existing: ClientProfile = next.get(clientId) ?? {
            clientId, clientName: '', files: [], txns: [], gl: [], ledger: [],
            lastUpdated: new Date().toISOString(),
          };
          // Skip if file already loaded
          if (existing.files.some(f => f.name === file.name)) { resolve(); return prev; }

          let clientName = existing.clientName;
          if (type === 'transaction') {
            const newTxns = parseTxns(content, fy);
            existing.txns = [...existing.txns, ...newTxns];
          } else if (type === 'gain_loss') {
            const { rows, clientName: cn } = parseGL(content, fy);
            if (cn) clientName = cn;
            existing.gl = [...existing.gl, ...rows];
            // If G&L reveals a different/canonical clientId, could remap — skip for simplicity
          } else if (type === 'ledger') {
            const rows = parseLedger(content, fy);
            existing.ledger = [...existing.ledger, ...rows];
          }

          existing.clientName   = clientName;
          existing.files        = [...existing.files, { name: file.name, type, fy }];
          existing.lastUpdated  = new Date().toISOString();
          next.set(clientId, existing);

          // Set active to first uploaded client
          resolve();
          return next;
        });
      };
      reader.readAsText(file, 'utf-8');
    }));
    Promise.all(promises).then(() => {
      setUploading(false);
      setClients(prev => {
        // After all files processed, ensure active client is set
        if (prev.size > 0 && !prev.has(activeClient)) {
          setActive(prev.keys().next().value as string);
        }
        return prev;
      });
    });
  }, [activeClient]);

  const deleteClient = (clientId: string) => {
    setClients(prev => { const next = new Map(prev); next.delete(clientId); return next; });
    if (activeClient === clientId) setActive('');
  };

const onDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(false); processFiles(e.dataTransfer.files); }, [processFiles]);

  const clientList = Array.from(clients.values()).sort((a, b) => a.clientId.localeCompare(b.clientId));
  const active     = clients.get(activeClient);

  const typeColor: Record<CSVType, string> = { transaction: 'text-blue-400', gain_loss: 'text-emerald-400', ledger: 'text-amber-400', unknown: 'text-red-400' };
  const typeLabel: Record<CSVType, string> = { transaction: 'Transactions', gain_loss: 'Gain/Loss', ledger: 'Ledger', unknown: '⚠ Unknown' };

  return (
    <div className="min-h-screen bg-slate-950 p-4 md:p-6 space-y-5">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-indigo-900/40 rounded-lg"><BarChart2 className="w-5 h-5 text-indigo-400" /></div>
        <div>
          <h1 className="text-lg font-bold text-white">Trading Profile</h1>
          <p className="text-xs text-slate-400">Upload Kotak CSVs — data saved locally, multi-client supported</p>
        </div>
      </div>

      {/* Upload zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all
          ${dragOver ? 'border-indigo-500 bg-indigo-950/30' : 'border-slate-700 hover:border-slate-500 bg-slate-900/30'}`}
      >
        {uploading
          ? <RefreshCw className="w-6 h-6 text-indigo-400 mx-auto mb-2 animate-spin" />
          : <Upload className="w-6 h-6 text-slate-500 mx-auto mb-2" />}
        <p className="text-slate-300 font-semibold text-sm">{uploading ? 'Processing...' : 'Drop CSVs here or click to browse'}</p>
        <div className="flex justify-center gap-4 mt-2 text-[11px] text-slate-500">
          <span><span className="text-blue-400">●</span> Transaction_Statement_*.csv</span>
          <span><span className="text-emerald-400">●</span> Gain_Loss_*.csv</span>
          <span><span className="text-amber-400">●</span> Ledger_*.csv</span>
        </div>
        <p className="text-[10px] text-slate-600 mt-1">Client ID auto-detected from filename · Data saved to browser storage</p>
        <input ref={fileRef} type="file" multiple accept=".csv" className="hidden" onChange={e => processFiles(e.target.files)} />
      </div>

      {/* Empty state */}
      {clients.size === 0 && (
        <div className="rounded-xl bg-slate-900/40 border border-slate-800 p-8 text-center">
          <Info className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400 font-semibold mb-2">How to get your Kotak CSVs</p>
          <ol className="text-slate-500 text-sm space-y-1 text-left max-w-md mx-auto">
            <li>1. Kotak Neo → <b className="text-slate-400">Reports</b> → Transaction Statement → CSV</li>
            <li>2. Reports → Gain &amp; Loss → CSV (one per financial year)</li>
            <li>3. Reports → Ledger → CSV (one per financial year)</li>
            <li>4. Upload all together — client IDs auto-detected from filename</li>
          </ol>
        </div>
      )}

      {/* ── Client Tabs ── */}
      {clients.size > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {clientList.map(c => (
            <button key={c.clientId} onClick={() => setActive(c.clientId)}
              className={`flex items-center gap-2 flex-shrink-0 px-4 py-2 rounded-xl border text-sm font-semibold transition-all
                ${activeClient === c.clientId ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-500'}`}>
              <User className="w-3.5 h-3.5" />
              <span>{c.clientName || c.clientId}</span>
              {c.clientName && <span className="text-[10px] opacity-60">({c.clientId})</span>}
              <span className="text-[10px] opacity-50">{c.files.length} files</span>
            </button>
          ))}
          {clients.size > 1 && (
            <div className={`flex items-center gap-2 flex-shrink-0 px-4 py-2 rounded-xl border text-sm font-semibold cursor-pointer transition-all
              ${activeClient === '__combined__' ? 'bg-purple-600 border-purple-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-500'}`}
              onClick={() => setActive('__combined__')}>
              <BarChart2 className="w-3.5 h-3.5" /> All Clients
            </div>
          )}
        </div>
      )}

      {/* ── Active client files ── */}
      {active && (
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <FileText className="w-3.5 h-3.5" />
              {active.clientName ? `${active.clientName} (${active.clientId})` : active.clientId} — {active.files.length} file{active.files.length !== 1 ? 's' : ''}
              <span className="text-slate-600 font-normal normal-case">· saved {new Date(active.lastUpdated).toLocaleDateString('en-IN')}</span>
            </h3>
            <button onClick={() => deleteClient(active.clientId)}
              className="flex items-center gap-1 text-xs text-red-500 hover:text-red-400 transition-colors">
              <Trash2 className="w-3 h-3" /> Delete client
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {active.files.map(f => (
              <div key={f.name} className="flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5">
                <span className={`text-[11px] font-bold ${typeColor[f.type]}`}>[{typeLabel[f.type]}]</span>
                <span className="text-xs text-slate-300">{f.fy}</span>
                <span className="text-[10px] text-slate-600 max-w-[120px] truncate">{f.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Combined view ── */}
      {activeClient === '__combined__' && clients.size > 1 && (() => {
        const combined: ClientProfile = {
          clientId: '__combined__', clientName: 'All Clients',
          files: [], lastUpdated: '',
          txns:   clientList.flatMap(c => c.txns),
          gl:     clientList.flatMap(c => c.gl),
          ledger: clientList.flatMap(c => c.ledger),
        };
        return <ClientAnalytics profile={combined} />;
      })()}

      {/* ── Single client analytics ── */}
      {active && activeClient !== '__combined__' && <ClientAnalytics profile={active} />}
    </div>
  );
}
