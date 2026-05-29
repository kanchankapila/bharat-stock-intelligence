import { useState, useCallback, useRef } from 'react';
import {
  Upload, TrendingUp, TrendingDown, FileText, X, AlertTriangle,
  CheckCircle, Info, Wallet, ArrowUpRight, Receipt,
  BarChart2, Target, RefreshCw, ChevronDown, ChevronUp,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type CSVType = 'transaction' | 'gain_loss' | 'ledger' | 'unknown';

interface UploadedFile { name: string; type: CSVType; fy: string; content: string; }

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
  // strip BOM (both literal escape and actual UTF-8 BOM)
  const clean = raw.replace(/^﻿/, '').replace(/\r/g, '');
  return clean.split('\n')
    .map(parseLine)
    .filter(r => r.some(c => c.replace(/"/g, '').trim() !== ''));
}

function num(s: string | undefined): number {
  if (!s) return 0;
  const v = parseFloat(s.replace(/,/g, '').replace(/"/g, '').trim());
  return isNaN(v) ? 0 : v;
}

function extractFY(filename: string): string {
  const m = filename.match(/(\d{4})\d{4}_(\d{4})\d{4}/);
  if (m) return `FY ${m[1]}-${m[2].slice(2)}`;
  return 'Unknown FY';
}

function detectType(content: string, filename: string): CSVType {
  const f = filename.toLowerCase();
  if (f.startsWith('ledger') || f.includes('_ledger') || f.includes('ledger_'))  return 'ledger';
  if (f.startsWith('transaction') || f.includes('transaction_statement'))         return 'transaction';
  if (f.startsWith('gain') || f.includes('gain_loss') || f.includes('gain-loss')) return 'gain_loss';
  // Fallback: header sniff
  if (content.includes('Trans. Type') || content.includes('Trans.Type') || content.includes('Net Balance')) return 'ledger';
  if (content.includes('Trade Date') && content.includes('Transaction Type'))      return 'transaction';
  if (content.includes('Buy Amt') || content.includes('Net P&L'))                  return 'gain_loss';
  return 'unknown';
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseTxns(raw: string, fy: string): TxnRow[] {
  const rows = parseCSV(raw);
  const hi   = rows.findIndex(r => r[0]?.replace(/"/g,'').trim().includes('Trade Date'));
  if (hi < 0) return [];
  return rows.slice(hi + 1).map(r => ({
    tradeDate: r[0], securityName: r[3], transactionType: r[7],
    quantity: num(r[8]), marketRate: num(r[9]), total: num(r[10]),
    gst: num(r[11]), brokerage: num(r[12]), misc: num(r[13]),
    totalCharges: num(r[14]), sttCtt: num(r[15]), fy,
  })).filter(r => r.securityName && (r.transactionType === 'Buy' || r.transactionType === 'Sell'));
}

function parseGL(raw: string, fy: string): GLRow[] {
  const rows = parseCSV(raw);
  const hi   = rows.findIndex(r => r[0]?.replace(/"/g,'').trim().includes('Script Name'));
  if (hi < 0) return [];
  const out: GLRow[] = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0]?.replace(/"/g,'').trim();
    if (!name || name === 'Equity' || name === 'Script Name' || name.startsWith('Disclaimer') || name.startsWith('Gain amount')) continue;
    if (r.length < 15) continue;
    out.push({
      scriptName: name, buyAmt: num(r[4]), sellAmt: num(r[5]),
      intraday: num(r[6]), shortTerm: num(r[7]), longTerm: num(r[8]), totalPL: num(r[9]),
      gst: num(r[10]), brokerage: num(r[11]), misc: num(r[12]), sttCtt: num(r[13]),
      totalCharges: num(r[14]), netPL: num(r[15]), grossPL: num(r[16] ?? r[15]), fy,
    });
  }
  return out;
}

function parseLedger(raw: string, fy: string): LRow[] {
  const rows = parseCSV(raw);
  const hi   = rows.findIndex(r => {
    const f = r[0]?.replace(/"/g,'').trim();
    return f === 'Date' || f?.startsWith('Date');
  });
  if (hi < 0) return [];
  return rows.slice(hi + 1).map(r => ({
    date: r[0]?.replace(/"/g,'').trim() ?? '',
    transType: r[2]?.replace(/"/g,'').trim() ?? '',
    narration: r[3]?.replace(/"/g,'').trim() ?? '',
    debit:      num(r[4]),
    credit:     num(r[5]),
    netBalance: num(r[6]),
    fy,
  })).filter(r => r.date && r.date.match(/\d{2}\/\d{2}\/\d{4}/));
}

// ─── Ledger categorisation ────────────────────────────────────────────────────

const isDeposit    = (l: LRow) => (l.transType === 'RECEIPT') && l.credit > 0;
const isWithdrawal = (l: LRow) => (l.transType === 'PAYMENT' || l.transType === 'Withdrawal') && l.debit > 0;
const isBillCredit = (l: LRow) => l.transType === 'BILL' && l.credit > 0;
const isBillDebit  = (l: LRow) => l.transType === 'BILL' && l.debit > 0;
const isDPCharge   = (l: LRow) => l.narration.toUpperCase().includes('DP CHGS') || l.narration.toUpperCase().includes('DP TRANSACTION');
const isAuction    = (l: LRow) => l.narration.toUpperCase().includes('AUC INT');
const isInterest   = (l: LRow) => l.narration.toUpperCase().includes('IC - INTEREST');

// ─── INR formatter ────────────────────────────────────────────────────────────

const INR = (v: number, opts?: { abs?: boolean; sign?: boolean }) => {
  const abs = opts?.abs ? Math.abs(v) : v;
  const str = Math.abs(abs).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const prefix = opts?.sign && v > 0 ? '+' : v < 0 ? '-' : '';
  return `${prefix}₹${str}`;
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function Card({ label, value, sub, color, icon: Icon, highlight }: {
  label: string; value: string; sub?: string;
  color: string; icon: any; highlight?: boolean;
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

function Row({ label, value, color = 'text-slate-200', bold = false, indent = false, divider = false }: {
  label: string; value: string; color?: string; bold?: boolean; indent?: boolean; divider?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between py-2 text-sm
      ${divider ? 'border-t border-slate-700 mt-1 pt-3' : 'border-b border-slate-800/50'}`}>
      <span className={`${indent ? 'pl-4 text-slate-400' : bold ? 'font-bold text-white' : 'text-slate-300'}`}>{label}</span>
      <span className={`font-mono ${bold ? 'font-black text-base' : 'font-medium'} ${color}`}>{value}</span>
    </div>
  );
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const w = max === 0 ? 0 : Math.min(100, (Math.abs(value) / max) * 100);
  return (
    <div className="h-2 rounded bg-slate-700 flex-1">
      <div className={`h-full rounded ${color}`} style={{ width: `${w}%` }} />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const [files, setFiles]     = useState<UploadedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab]         = useState<'cashflow' | 'pnl' | 'stocks' | 'charges' | 'behavior'>('cashflow');
  const [expandedYear, setExpandedYear] = useState<string | null>(null);
  const fileRef               = useRef<HTMLInputElement>(null);

  // Parsed data
  const txns   = files.filter(f => f.type === 'transaction').flatMap(f => parseTxns(f.content, f.fy));
  const gl     = files.filter(f => f.type === 'gain_loss').flatMap(f => parseGL(f.content, f.fy));
  const ledger = files.filter(f => f.type === 'ledger').flatMap(f => parseLedger(f.content, f.fy));

  const hasData = gl.length > 0 || txns.length > 0 || ledger.length > 0;

  const processFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;
    Array.from(incoming).forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        const content = (e.target?.result as string) ?? '';
        const type    = detectType(content, file.name);
        const fy      = extractFY(file.name);
        setFiles(prev => prev.some(p => p.name === file.name) ? prev : [...prev, { name: file.name, type, fy, content }]);
      };
      reader.readAsText(file, 'utf-8');
    });
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    processFiles(e.dataTransfer.files);
  }, [processFiles]);

  // ── Ledger aggregates ──
  const totalDeposited  = ledger.filter(isDeposit).reduce((s, l) => s + l.credit, 0);
  const totalWithdrawn  = ledger.filter(isWithdrawal).reduce((s, l) => s + l.debit, 0);
  const billCredits     = ledger.filter(isBillCredit).reduce((s, l) => s + l.credit, 0);
  const billDebits      = ledger.filter(isBillDebit).reduce((s, l) => s + l.debit, 0);
  const totalDP         = ledger.filter(isDPCharge).reduce((s, l) => s + l.debit, 0);
  const totalAuction    = ledger.filter(isAuction).reduce((s, l) => s + l.debit, 0);
  const totalInterest   = ledger.filter(isInterest).reduce((s, l) => s + l.debit, 0);
  const jvDebits        = ledger.filter(l => l.transType === 'JV' && !isDPCharge(l) && !isAuction(l) && !isInterest(l)).reduce((s, l) => s + l.debit, 0);
  const jvCredits       = ledger.filter(l => l.transType === 'JV' && l.credit > 0 && !isAuction(l)).reduce((s, l) => s + l.credit, 0);
  const openingBal      = (() => { const r = ledger.find(l => l.transType === 'OPBAL'); return r ? (r.credit - r.debit) : 0; })();
  const closingBal      = ledger.length > 0 ? ledger[0].netBalance : 0; // first row after sort (latest)

  // ── Transaction aggregates ──
  const buyTxns  = txns.filter(t => t.transactionType === 'Buy');
  const sellTxns = txns.filter(t => t.transactionType === 'Sell');
  const totalBuy         = buyTxns.reduce((s, t) => s + t.total, 0);
  const totalSell        = sellTxns.reduce((s, t) => s + t.total, 0);
  const totalBrokerage   = txns.reduce((s, t) => s + t.brokerage, 0);
  const totalGST         = txns.reduce((s, t) => s + t.gst, 0);
  const totalSTT         = txns.reduce((s, t) => s + t.sttCtt, 0);
  const totalMisc        = txns.reduce((s, t) => s + t.misc, 0);
  const totalTxnCharges  = txns.reduce((s, t) => s + t.totalCharges, 0);

  // ── G&L aggregates ──
  const totalNetPL   = gl.reduce((s, g) => s + g.netPL, 0);
  const totalGrossPL = gl.reduce((s, g) => s + g.grossPL, 0);
  const totalGLCharges = gl.reduce((s, g) => s + g.totalCharges + g.sttCtt, 0);

  // ── Reconciliation ──
  // Net cash return = money you actually got back - money you put in
  const netCashReturn = totalWithdrawn - totalDeposited;
  // Total all-in charges including hidden
  const totalAllCharges = (totalTxnCharges || totalGLCharges) + totalDP + totalAuction + totalInterest;

  // Year-wise P&L
  const fyMap = new Map<string, GLRow[]>();
  for (const g of gl) { const a = fyMap.get(g.fy) ?? []; a.push(g); fyMap.set(g.fy, a); }
  const yearwise = Array.from(fyMap.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([fy, rows]) => ({
    fy,
    netPL:   rows.reduce((s, g) => s + g.netPL, 0),
    charges: rows.reduce((s, g) => s + g.totalCharges + g.sttCtt, 0),
    stocks:  rows,
  }));

  const maxAbsPL = Math.max(1, ...yearwise.map(y => Math.abs(y.netPL)));
  const sortedStocks = [...gl].sort((a, b) => b.netPL - a.netPL);
  const winners = sortedStocks.filter(g => g.netPL > 0).slice(0, 5);
  const losers  = [...sortedStocks].reverse().filter(g => g.netPL < 0).slice(0, 5);

  // Stock-level from transactions (match buy/sell per stock name)
  const stockMap = new Map<string, { buys: TxnRow[]; sells: TxnRow[] }>();
  for (const t of txns) {
    const e = stockMap.get(t.securityName) ?? { buys: [], sells: [] };
    if (t.transactionType === 'Buy') e.buys.push(t); else e.sells.push(t);
    stockMap.set(t.securityName, e);
  }

  // Behaviors
  const behaviors: { title: string; body: string; severity: 'warn' | 'info' | 'ok' }[] = [];

  if (gl.length > 0) {
    const topStock = sortedStocks[0];
    if (topStock && totalGrossPL > 0) {
      const conc = (topStock.grossPL / totalGrossPL) * 100;
      if (conc > 60) behaviors.push({ severity: 'warn', title: 'Extreme Concentration Risk', body: `${conc.toFixed(0)}% of all profit from ${topStock.scriptName} alone. If this trade had failed, the portfolio would be deeply negative.` });
    }
    const bigLTLosers = gl.filter(g => g.longTerm < -3000);
    if (bigLTLosers.length > 0) behaviors.push({ severity: 'warn', title: 'No Stop-Loss on Long-Term Positions', body: `${bigLTLosers.map(g => g.scriptName).join(', ')} held >1 year at significant losses. Stop-loss was never triggered.` });
    const pennyGL = gl.filter(g => g.buyAmt > 0 && (g.sellAmt + g.netPL) / g.buyAmt < 0.2 && g.buyAmt > 1000);
    if (pennyGL.length > 0) behaviors.push({ severity: 'warn', title: 'Near-Total Capital Loss', body: `${pennyGL.map(g => g.scriptName).join(', ')} — lost >80% of invested capital. These were structurally failing companies.` });
  }
  if (txns.length > 0) {
    const pennyTxns = buyTxns.filter(t => t.marketRate > 0 && t.marketRate < 10);
    const pennyVal  = pennyTxns.reduce((s, t) => s + t.total, 0);
    if (pennyVal > 1000) behaviors.push({ severity: 'warn', title: 'High Penny-Stock Allocation', body: `${INR(pennyVal)} bought in sub-₹10 stocks (${txns.length > 0 ? ((pennyVal / totalBuy) * 100).toFixed(0) : 0}% of buy value). High variance — one miss can wipe multiple wins.` });

    // Averaging down: stock with 3+ buys at declining prices
    const avgDown: string[] = [];
    for (const [name, { buys }] of stockMap.entries()) {
      if (buys.length >= 3) {
        const prices = buys.map(b => b.marketRate).filter(p => p > 0);
        if (prices[prices.length - 1] < prices[0] * 0.7) avgDown.push(name);
      }
    }
    if (avgDown.length > 0) behaviors.push({ severity: 'info', title: 'Averaging Down Detected', body: `${avgDown.slice(0, 4).join(', ')}: bought repeatedly at lower prices. Can work in recoveries; dangerous in structural declines.` });
  }
  if (totalAuction > 0) behaviors.push({ severity: 'warn', title: 'Auction Penalty Incurred', body: `${INR(totalAuction)} lost to exchange auction (short delivery). Likely caused by mixing platforms (Kotak + Smallcase) for the same settlement date. Use one platform per stock.` });
  if (totalDP > 0) behaviors.push({ severity: 'info', title: 'Ongoing DP Charges on Dormant Positions', body: `${INR(totalDP)} paid in demat maintenance charges including dormant years. Holding losing positions has a monthly cost even without trading.` });
  if (behaviors.length === 0 && hasData) behaviors.push({ severity: 'ok', title: 'No critical patterns detected', body: 'Upload more files for deeper analysis.' });

  const typeLabel: Record<CSVType, string> = { transaction: 'Transactions', gain_loss: 'Gain / Loss', ledger: 'Ledger', unknown: '⚠ Unknown' };
  const typeColor: Record<CSVType, string> = { transaction: 'text-blue-400', gain_loss: 'text-emerald-400', ledger: 'text-amber-400', unknown: 'text-red-400' };

  return (
    <div className="min-h-screen bg-slate-950 p-4 md:p-6 space-y-5">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-indigo-900/40 rounded-lg"><BarChart2 className="w-5 h-5 text-indigo-400" /></div>
        <div>
          <h1 className="text-lg font-bold text-white">My Trading Profile</h1>
          <p className="text-xs text-slate-400">Upload Kotak CSVs — Transaction Statement, Gain/Loss, and Ledger files</p>
        </div>
      </div>

      {/* Upload zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all
          ${dragOver ? 'border-indigo-500 bg-indigo-950/30' : 'border-slate-700 hover:border-slate-500 bg-slate-900/30'}`}
      >
        <Upload className="w-8 h-8 text-slate-500 mx-auto mb-3" />
        <p className="text-slate-300 font-semibold">Drop multiple CSV files or click to browse</p>
        <div className="flex justify-center gap-6 mt-3 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="text-blue-400">●</span> Transaction_Statement_*.csv</span>
          <span className="flex items-center gap-1"><span className="text-emerald-400">●</span> Gain_Loss_*.csv</span>
          <span className="flex items-center gap-1"><span className="text-amber-400">●</span> Ledger_*.csv</span>
        </div>
        <input ref={fileRef} type="file" multiple accept=".csv" className="hidden"
          onChange={e => processFiles(e.target.files)} />
      </div>

      {/* File chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map(f => (
            <div key={f.name} className="flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5">
              <FileText className="w-3 h-3 text-slate-500" />
              <div>
                <span className={`text-[11px] font-bold ${typeColor[f.type]}`}>[{typeLabel[f.type]}]</span>
                <span className="text-xs text-slate-300 ml-1.5">{f.fy}</span>
              </div>
              <button onClick={() => setFiles(p => p.filter(x => x.name !== f.name))}
                className="text-slate-600 hover:text-red-400 ml-1"><X className="w-3 h-3" /></button>
            </div>
          ))}
          <button onClick={() => setFiles([])} className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-400 ml-1">
            <RefreshCw className="w-3 h-3" /> Clear all
          </button>
        </div>
      )}

      {/* Empty state */}
      {!hasData && files.length === 0 && (
        <div className="rounded-xl bg-slate-900/40 border border-slate-800 p-8 text-center">
          <Info className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400 font-semibold mb-2">How to download from Kotak</p>
          <ol className="text-slate-500 text-sm space-y-1 text-left max-w-md mx-auto">
            <li>1. Login → <b className="text-slate-400">Reports</b> → <b className="text-slate-400">Transaction Statement</b> → Download CSV (all years)</li>
            <li>2. Reports → <b className="text-slate-400">Gain & Loss</b> → Download CSV (all years)</li>
            <li>3. Reports → <b className="text-slate-400">Ledger</b> → Download CSV (all years)</li>
            <li>4. Upload all files together above</li>
          </ol>
        </div>
      )}

      {/* Unknown file warning */}
      {files.some(f => f.type === 'unknown') && (
        <div className="rounded-xl bg-red-950/20 border border-red-900 p-3 flex items-center gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <span className="text-red-300">Some files couldn't be identified. Rename them to start with Transaction_, Gain_Loss_, or Ledger_ and re-upload.</span>
        </div>
      )}

      {hasData && (
        <>
          {/* ── Summary Cards ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card
              label="Net P&L (Realized)"
              value={INR(totalNetPL, { sign: true })}
              sub={gl.length > 0 ? `from ${gl.length} stock positions across ${yearwise.length} FYs` : 'Upload Gain/Loss CSVs for P&L'}
              color={totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'}
              icon={totalNetPL >= 0 ? TrendingUp : TrendingDown}
              highlight
            />
            <Card
              label="Capital Deployed (Buys)"
              value={INR(totalBuy || gl.reduce((s,g) => s+g.buyAmt, 0))}
              sub={`${buyTxns.length || '-'} buy transactions`}
              color="text-blue-400"
              icon={ArrowUpRight}
            />
            <Card
              label="Cash Deposited → Kotak"
              value={totalDeposited > 0 ? INR(totalDeposited) : 'Upload Ledger'}
              sub={totalWithdrawn > 0 ? `Withdrawn: ${INR(totalWithdrawn)}` : 'Add Ledger CSVs for cash flow'}
              color="text-purple-400"
              icon={Wallet}
            />
            <Card
              label="Total Charges & Taxes"
              value={INR(totalAllCharges || totalGLCharges)}
              sub="Brokerage + STT + GST + DP + penalties"
              color="text-amber-400"
              icon={Receipt}
            />
          </div>

          {/* ── Net Cash Return (if ledger present) ── */}
          {ledger.length > 0 && (
            <div className={`rounded-xl border p-4 ${netCashReturn >= 0 ? 'bg-emerald-950/20 border-emerald-900/50' : 'bg-red-950/20 border-red-900/50'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                    Net Cash Return (Bank → Bank)
                  </div>
                  <div className={`text-3xl font-black ${netCashReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {INR(netCashReturn, { sign: true })}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Withdrew {INR(totalWithdrawn)} − Deposited {INR(totalDeposited)} = actual money gained/lost from your bank's perspective
                  </div>
                </div>
                <div className="text-right">
                  {netCashReturn >= 0
                    ? <CheckCircle className="w-10 h-10 text-emerald-600" />
                    : <AlertTriangle className="w-10 h-10 text-red-600" />}
                </div>
              </div>
            </div>
          )}

          {/* ── Tabs ── */}
          <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 overflow-x-auto">
            {([
              ['cashflow', 'Cash Flow Statement'],
              ['pnl',      'P&L by Year'],
              ['stocks',   'Stock-wise'],
              ['charges',  'Charges Breakdown'],
              ['behavior', 'Insights'],
            ] as [typeof tab, string][]).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors
                  ${tab === id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* TAB: CASH FLOW STATEMENT (CA-style)                              */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          {tab === 'cashflow' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Cash Flow from Ledger */}
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-purple-400" /> Cash Flow Statement (Ledger)
                </h3>
                {ledger.length > 0 ? (
                  <div className="space-y-0">
                    <Row label="Opening Balance" value={INR(openingBal, { sign: true })} color={openingBal >= 0 ? 'text-slate-300' : 'text-slate-300'} />
                    <Row label="+ Cash deposited from bank" value={INR(totalDeposited)} color="text-blue-400" indent />
                    <Row label="+ Sell settlements (BILL credits)" value={INR(billCredits)} color="text-emerald-400" indent />
                    <Row label="+ Other JV credits (reversals etc.)" value={INR(jvCredits)} color="text-emerald-300" indent />
                    <Row label="− Buy settlements (BILL debits)" value={`-${INR(billDebits)}`} color="text-slate-400" indent />
                    <Row label="− DP charges" value={`-${INR(totalDP)}`} color="text-orange-400" indent />
                    <Row label="− Auction penalties" value={`-${INR(totalAuction)}`} color="text-red-400" indent />
                    <Row label="− Debit interest" value={`-${INR(totalInterest)}`} color="text-red-400" indent />
                    <Row label="− Other JV debits" value={`-${INR(jvDebits)}`} color="text-slate-400" indent />
                    <Row label="− Withdrawn to bank" value={`-${INR(totalWithdrawn)}`} color="text-red-400" indent />
                    <Row label="Closing Balance" value={INR(closingBal, { sign: true })} color="text-white" bold divider />
                    <div className={`mt-3 text-xs px-2 py-1.5 rounded ${netCashReturn >= 0 ? 'bg-emerald-900/20 text-emerald-400' : 'bg-red-900/20 text-red-400'}`}>
                      Net cash returned to bank: <strong>{INR(netCashReturn, { sign: true })}</strong>
                    </div>
                  </div>
                ) : (
                  <p className="text-slate-500 text-sm">Upload Ledger CSVs to see full cash flow statement</p>
                )}
              </div>

              {/* P&L Waterfall */}
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-400" /> P&L Waterfall
                </h3>
                {gl.length > 0 || txns.length > 0 ? (
                  <div className="space-y-0">
                    {txns.length > 0 && <Row label="Total Buy Value" value={INR(totalBuy)} color="text-blue-400" />}
                    {txns.length > 0 && <Row label="Total Sell Value" value={INR(totalSell)} color="text-emerald-400" />}
                    {gl.length > 0 && <Row label="Gross P&L (Sell − Buy)" value={INR(totalGrossPL, { sign: true })} color={totalGrossPL >= 0 ? 'text-emerald-400' : 'text-red-400'} />}
                    {(totalTxnCharges > 0 || totalGLCharges > 0) && (
                      <Row label="− Exchange charges (brokerage+STT+GST+misc)" value={`-${INR(totalTxnCharges || totalGLCharges)}`} color="text-orange-400" indent />
                    )}
                    {gl.length > 0 && <Row label="Net P&L (post exchange charges)" value={INR(totalNetPL, { sign: true })} color={totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'} />}
                    {totalDP > 0    && <Row label="− DP charges (demat)" value={`-${INR(totalDP)}`} color="text-orange-400" indent />}
                    {totalAuction > 0 && <Row label="− Auction penalties" value={`-${INR(totalAuction)}`} color="text-red-400" indent />}
                    {totalInterest > 0 && <Row label="− Debit interest" value={`-${INR(totalInterest)}`} color="text-red-400" indent />}
                    <Row
                      label="True Net P&L (all costs deducted)"
                      value={INR(totalNetPL - totalDP - totalAuction - totalInterest, { sign: true })}
                      color={(totalNetPL - totalDP - totalAuction - totalInterest) >= 0 ? 'text-emerald-400' : 'text-red-400'}
                      bold divider
                    />
                  </div>
                ) : (
                  <p className="text-slate-500 text-sm">Upload Transaction or Gain/Loss CSVs</p>
                )}

                {/* Reconciliation check */}
                {ledger.length > 0 && gl.length > 0 && (
                  <div className="mt-4 p-3 rounded-lg bg-slate-800 border border-slate-700">
                    <div className="text-xs font-bold text-slate-400 uppercase mb-2 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Reconciliation Check
                    </div>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">G&L Net P&L</span>
                        <span className={`font-mono ${totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{INR(totalNetPL, { sign: true })}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Ledger net cash return</span>
                        <span className={`font-mono ${netCashReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{INR(netCashReturn, { sign: true })}</span>
                      </div>
                      <div className="flex justify-between border-t border-slate-700 pt-1 mt-1">
                        <span className="text-slate-400">Difference (unrealized + timing)</span>
                        <span className="font-mono text-amber-400">{INR(totalNetPL - netCashReturn, { sign: true })}</span>
                      </div>
                      <p className="text-slate-600 mt-1">Difference = unrealized holdings + timing of settlements</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* TAB: P&L BY YEAR                                                 */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          {tab === 'pnl' && (
            <div className="space-y-3">
              {/* Mini bar chart */}
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <h3 className="text-sm font-bold text-slate-300 mb-4">Year-wise Net P&L</h3>
                <div className="space-y-3">
                  {yearwise.map(y => (
                    <div key={y.fy} className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-24 flex-shrink-0">{y.fy}</span>
                      <MiniBar value={y.netPL} max={maxAbsPL} color={y.netPL >= 0 ? 'bg-emerald-500' : 'bg-red-500'} />
                      <span className={`text-xs font-bold font-mono w-28 text-right flex-shrink-0 ${y.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {INR(y.netPL, { sign: true })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Expandable year table */}
              {yearwise.map(y => (
                <div key={y.fy} className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
                  <button
                    onClick={() => setExpandedYear(expandedYear === y.fy ? null : y.fy)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-white">{y.fy}</span>
                      <span className="text-slate-500 text-sm">{y.stocks.length} stocks</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className={`font-black font-mono ${y.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {INR(y.netPL, { sign: true })}
                        </div>
                        <div className="text-xs text-orange-400">charges: -{INR(y.charges)}</div>
                      </div>
                      {expandedYear === y.fy ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                    </div>
                  </button>
                  {expandedYear === y.fy && (
                    <div className="border-t border-slate-800 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-slate-800">
                            {['Stock', 'Buy ₹', 'Sell ₹', 'STCG', 'LTCG', 'Intraday', 'Charges', 'Net P&L', 'Return %'].map(h => (
                              <th key={h} className="text-left px-3 py-2 text-slate-500 font-semibold whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[...y.stocks].sort((a, b) => b.netPL - a.netPL).map(s => {
                            const ret = s.buyAmt > 0 ? (s.netPL / s.buyAmt) * 100 : 0;
                            return (
                              <tr key={s.scriptName} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                                <td className="px-3 py-2 font-medium text-white whitespace-nowrap">{s.scriptName}</td>
                                <td className="px-3 py-2 text-slate-400 font-mono">{INR(s.buyAmt)}</td>
                                <td className="px-3 py-2 text-slate-400 font-mono">{INR(s.sellAmt)}</td>
                                <td className={`px-3 py-2 font-mono ${s.shortTerm !== 0 ? (s.shortTerm > 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-600'}`}>
                                  {s.shortTerm !== 0 ? INR(s.shortTerm, { sign: true }) : '—'}
                                </td>
                                <td className={`px-3 py-2 font-mono ${s.longTerm !== 0 ? (s.longTerm > 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-600'}`}>
                                  {s.longTerm !== 0 ? INR(s.longTerm, { sign: true }) : '—'}
                                </td>
                                <td className={`px-3 py-2 font-mono ${s.intraday !== 0 ? (s.intraday > 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-600'}`}>
                                  {s.intraday !== 0 ? INR(s.intraday, { sign: true }) : '—'}
                                </td>
                                <td className="px-3 py-2 text-orange-400 font-mono">-{INR(s.totalCharges + s.sttCtt)}</td>
                                <td className={`px-3 py-2 font-bold font-mono ${s.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {INR(s.netPL, { sign: true })}
                                </td>
                                <td className={`px-3 py-2 font-mono ${ret >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {ret >= 0 ? '+' : ''}{ret.toFixed(1)}%
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-slate-800/50">
                            <td className="px-3 py-2 font-bold text-white">Total</td>
                            <td className="px-3 py-2 text-blue-400 font-mono font-bold">{INR(y.stocks.reduce((s,g)=>s+g.buyAmt,0))}</td>
                            <td className="px-3 py-2 text-emerald-400 font-mono font-bold">{INR(y.stocks.reduce((s,g)=>s+g.sellAmt,0))}</td>
                            <td className="px-3 py-2 text-slate-300 font-mono font-bold">{INR(y.stocks.reduce((s,g)=>s+g.shortTerm,0), { sign: true })}</td>
                            <td className="px-3 py-2 text-slate-300 font-mono font-bold">{INR(y.stocks.reduce((s,g)=>s+g.longTerm,0), { sign: true })}</td>
                            <td className="px-3 py-2 text-slate-300 font-mono">{INR(y.stocks.reduce((s,g)=>s+g.intraday,0), { sign: true })}</td>
                            <td className="px-3 py-2 text-orange-400 font-mono font-bold">-{INR(y.charges)}</td>
                            <td className={`px-3 py-2 font-black font-mono text-sm ${y.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {INR(y.netPL, { sign: true })}
                            </td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              ))}

              {/* Grand total */}
              {yearwise.length > 1 && (
                <div className="rounded-xl bg-indigo-950/30 border border-indigo-800 p-4 flex items-center justify-between">
                  <div>
                    <div className="text-sm text-slate-400">All Years Combined — Net P&L</div>
                    <div className="text-xs text-slate-500">{gl.length} positions, {yearwise.length} financial years</div>
                  </div>
                  <div className="text-right">
                    <div className={`text-3xl font-black ${totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {INR(totalNetPL, { sign: true })}
                    </div>
                    <div className="text-xs text-orange-400">charges: -{INR(totalGLCharges)}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* TAB: STOCK-WISE                                                  */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          {tab === 'stocks' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Winners */}
                <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                  <h3 className="text-sm font-bold text-emerald-400 mb-3">🏆 Top Winners</h3>
                  {winners.map(g => (
                    <div key={g.scriptName + g.fy} className="flex items-center justify-between py-2 border-b border-slate-800/50">
                      <div>
                        <div className="text-sm font-medium text-white">{g.scriptName}</div>
                        <div className="text-xs text-slate-500">{g.fy} · {INR(g.buyAmt)} invested</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-bold text-emerald-400 font-mono">{INR(g.netPL, { sign: true })}</div>
                        <div className="text-xs text-emerald-600">+{g.buyAmt > 0 ? ((g.netPL / g.buyAmt) * 100).toFixed(1) : '∞'}%</div>
                      </div>
                    </div>
                  ))}
                </div>
                {/* Losers */}
                <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                  <h3 className="text-sm font-bold text-red-400 mb-3">📉 Biggest Losses</h3>
                  {losers.map(g => (
                    <div key={g.scriptName + g.fy} className="flex items-center justify-between py-2 border-b border-slate-800/50">
                      <div>
                        <div className="text-sm font-medium text-white">{g.scriptName}</div>
                        <div className="text-xs text-slate-500">{g.fy} · {INR(g.buyAmt)} invested</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-bold text-red-400 font-mono">{INR(g.netPL, { sign: true })}</div>
                        <div className="text-xs text-red-600">{g.buyAmt > 0 ? ((g.netPL / g.buyAmt) * 100).toFixed(1) : '−'}%</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Full stock table */}
              <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800">
                  <span className="text-sm font-bold text-slate-300">All Realized Positions ({gl.length})</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-800">
                        {['Stock', 'FY', 'Buy ₹', 'Sell ₹', 'STCG', 'LTCG', 'Charges', 'Net P&L', 'ROI'].map(h => (
                          <th key={h} className="text-left px-4 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedStocks.map((s, i) => {
                        const ret = s.buyAmt > 0 ? (s.netPL / s.buyAmt) * 100 : 0;
                        return (
                          <tr key={`${s.scriptName}${s.fy}`} className={`border-b border-slate-800/50 ${i % 2 ? 'bg-slate-800/10' : ''}`}>
                            <td className="px-4 py-2 font-medium text-white whitespace-nowrap">{s.scriptName}</td>
                            <td className="px-4 py-2 text-slate-500">{s.fy}</td>
                            <td className="px-4 py-2 text-blue-400 font-mono">{INR(s.buyAmt)}</td>
                            <td className="px-4 py-2 text-slate-300 font-mono">{INR(s.sellAmt)}</td>
                            <td className={`px-4 py-2 font-mono ${s.shortTerm > 0 ? 'text-emerald-400' : s.shortTerm < 0 ? 'text-red-400' : 'text-slate-600'}`}>
                              {s.shortTerm !== 0 ? INR(s.shortTerm, { sign: true }) : '—'}
                            </td>
                            <td className={`px-4 py-2 font-mono ${s.longTerm > 0 ? 'text-emerald-400' : s.longTerm < 0 ? 'text-red-400' : 'text-slate-600'}`}>
                              {s.longTerm !== 0 ? INR(s.longTerm, { sign: true }) : '—'}
                            </td>
                            <td className="px-4 py-2 text-orange-400 font-mono">-{INR(s.totalCharges + s.sttCtt)}</td>
                            <td className={`px-4 py-2 font-bold font-mono ${s.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {INR(s.netPL, { sign: true })}
                            </td>
                            <td className={`px-4 py-2 font-mono ${ret >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {ret >= 0 ? '+' : ''}{ret.toFixed(1)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* TAB: CHARGES BREAKDOWN                                           */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          {tab === 'charges' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  { label: 'Brokerage',          v: totalBrokerage || gl.reduce((s,g)=>s+g.brokerage,0), desc: '₹21/order or % — paid per trade' },
                  { label: 'STT / CTT',           v: totalSTT || gl.reduce((s,g)=>s+g.sttCtt,0), desc: 'Securities Transaction Tax (govt levy)' },
                  { label: 'GST on Brokerage',    v: totalGST || gl.reduce((s,g)=>s+g.gst,0), desc: '18% of brokerage amount' },
                  { label: 'Misc / Exchange',     v: totalMisc || gl.reduce((s,g)=>s+g.misc,0), desc: 'SEBI fee, stamp duty, clearing charges' },
                  { label: 'DP Charges',          v: totalDP, desc: 'Demat maintenance — paid monthly even dormant' },
                  { label: 'Auction Penalties',   v: totalAuction, desc: 'Short delivery auction charge (preventable)' },
                  { label: 'Debit Interest',      v: totalInterest, desc: 'Interest when account goes negative' },
                ].filter(c => c.v > 0).map(c => (
                  <div key={c.label} className="rounded-xl bg-slate-900 border border-slate-800 p-3">
                    <div className="text-xs text-slate-500 mb-1">{c.label}</div>
                    <div className="text-xl font-black text-amber-400">{INR(c.v)}</div>
                    <div className="text-[10px] text-slate-600 mt-1">{c.desc}</div>
                  </div>
                ))}
              </div>

              {/* Impact statement */}
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <h3 className="text-sm font-bold text-slate-300 mb-3">Charge Impact on P&L</h3>
                <div className="space-y-0">
                  {totalGrossPL !== 0 && <Row label="Gross P&L (before any charges)" value={INR(totalGrossPL, { sign: true })} color={totalGrossPL >= 0 ? 'text-emerald-400' : 'text-red-400'} />}
                  {(totalTxnCharges || totalGLCharges) > 0 && <Row label="− Exchange charges" value={`-${INR(totalTxnCharges || totalGLCharges)}`} color="text-orange-400" indent />}
                  {totalNetPL !== 0 && <Row label="Net P&L (exchange charges deducted)" value={INR(totalNetPL, { sign: true })} color={totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'} />}
                  {totalDP > 0       && <Row label="− DP charges (demat)" value={`-${INR(totalDP)}`} color="text-orange-400" indent />}
                  {totalAuction > 0  && <Row label="− Auction penalties (avoidable)" value={`-${INR(totalAuction)}`} color="text-red-400" indent />}
                  {totalInterest > 0 && <Row label="− Debit interest" value={`-${INR(totalInterest)}`} color="text-red-400" indent />}
                  <Row
                    label="True Net P&L (all costs)"
                    value={INR(totalNetPL - totalDP - totalAuction - totalInterest, { sign: true })}
                    color={(totalNetPL - totalDP - totalAuction - totalInterest) >= 0 ? 'text-emerald-400' : 'text-red-400'}
                    bold divider
                  />
                </div>
                <div className="mt-3 text-xs text-slate-500">
                  Charges as % of buy value: <span className="text-amber-400">
                    {totalBuy > 0 ? (((totalTxnCharges || totalGLCharges) / totalBuy) * 100).toFixed(2) : '—'}%
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* TAB: INSIGHTS                                                    */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          {tab === 'behavior' && (
            <div className="space-y-4">
              {/* Detected patterns */}
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Target className="w-4 h-4 text-indigo-400" />
                  <h3 className="text-sm font-bold text-slate-300">Auto-Detected Patterns</h3>
                </div>
                <div className="space-y-3">
                  {behaviors.map((b, i) => (
                    <div key={i} className={`rounded-lg p-3 border ${
                      b.severity === 'warn' ? 'bg-amber-950/20 border-amber-900/50' :
                      b.severity === 'ok'   ? 'bg-emerald-950/20 border-emerald-900/50' :
                      'bg-slate-800 border-slate-700'}`}>
                      <div className="flex items-start gap-2">
                        {b.severity === 'warn' ? <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" /> :
                         b.severity === 'ok'   ? <CheckCircle className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" /> :
                                                 <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />}
                        <div>
                          <div className="text-sm font-semibold text-white">{b.title}</div>
                          <div className="text-xs text-slate-400 mt-0.5">{b.body}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Fixed lessons */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { emoji: '✅', title: 'What works', color: 'border-emerald-900/50', items: [
                    'COVID crash recovery timing was excellent',
                    'Catching growth stories early (Adani Green at ₹85)',
                    'Patience on high-conviction plays (Alok Industries)',
                    'Avoiding intraday — delivery-only keeps stress low',
                  ]},
                  { emoji: '❌', title: "What doesn't work", color: 'border-red-900/50', items: [
                    'No stop-loss — Future Consumer held to near-zero',
                    'Averaging down on structurally broken companies',
                    'Mixing platforms (Kotak + Smallcase) on same stock',
                    'Holding dormant losers while paying monthly DP charges',
                  ]},
                  { emoji: '📏', title: 'Rules to adopt', color: 'border-indigo-900/50', items: [
                    'Set exit price before every entry',
                    'Max 20% capital in stocks below ₹10',
                    'No more than 2 averages on any single stock',
                    'Single platform per stock (avoid T+2 conflicts)',
                    'Quarterly review — exit positions with <−30% and no thesis',
                  ]},
                ].map(s => (
                  <div key={s.title} className={`rounded-xl bg-slate-900 border ${s.color} p-4`}>
                    <div className="font-semibold text-white mb-3">{s.emoji} {s.title}</div>
                    <ul className="space-y-1.5">
                      {s.items.map((item, i) => (
                        <li key={i} className="text-xs text-slate-400 flex items-start gap-2">
                          <span className="text-slate-600 flex-shrink-0 mt-0.5">·</span>{item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
