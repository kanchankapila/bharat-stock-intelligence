import { useState, useCallback, useRef } from 'react';
import {
  Upload, TrendingUp, TrendingDown, FileText, X, AlertTriangle,
  CheckCircle, Info, ChevronDown, ChevronUp, Wallet, ArrowDownLeft,
  ArrowUpRight, Receipt, BarChart2, Target,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

type CSVType = 'transaction' | 'gain_loss' | 'ledger' | 'unknown';

interface UploadedFile { name: string; type: CSVType; fy: string; content: string; }

interface TransactionRow {
  tradeDate: string; securityName: string; transactionType: string;
  quantity: number; marketRate: number; total: number;
  gst: number; brokerage: number; misc: number;
  totalCharges: number; sttCtt: number; fy: string;
}

interface GainLossRow {
  scriptName: string; buyAmt: number; sellAmt: number;
  intraday: number; shortTerm: number; longTerm: number; totalPL: number;
  gst: number; brokerage: number; misc: number; sttCtt: number;
  totalCharges: number; netPL: number; grossPL: number; fy: string;
}

interface LedgerRow {
  date: string; transType: string; narration: string;
  debit: number; credit: number; fy: string;
}

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(content: string): string[][] {
  const clean = content.replace(/^﻿/, '').replace(/\r/g, '');
  return clean.split('\n')
    .map(parseCSVLine)
    .filter(r => r.some(c => c !== ''));
}

function extractFY(filename: string): string {
  const m = filename.match(/(\d{4})\d{4}_(\d{4})\d{4}/);
  if (m) return `FY ${m[1]}-${m[2].slice(2)}`;
  return 'Unknown FY';
}

function detectType(content: string, filename: string): CSVType {
  const f = filename.toLowerCase();
  if (f.includes('transaction')) return 'transaction';
  if (f.includes('gain_loss') || f.includes('gain-loss')) return 'gain_loss';
  if (f.includes('ledger')) return 'ledger';
  if (content.includes('Trade Date') && content.includes('Transaction Type')) return 'transaction';
  if (content.includes('Buy Amt') && content.includes('Net P&L')) return 'gain_loss';
  if (content.includes('Trans. Type') && content.includes('Net Balance')) return 'ledger';
  return 'unknown';
}

function n(s: string): number {
  const v = parseFloat((s || '').replace(/,/g, '').trim());
  return isNaN(v) ? 0 : v;
}

function parseTransactions(content: string, fy: string): TransactionRow[] {
  const rows = parseCSV(content);
  const hIdx = rows.findIndex(r => r[0]?.includes('Trade Date'));
  if (hIdx < 0) return [];
  return rows.slice(hIdx + 1).map(r => ({
    tradeDate: r[0], securityName: r[3], transactionType: r[7],
    quantity: n(r[8]), marketRate: n(r[9]), total: n(r[10]),
    gst: n(r[11]), brokerage: n(r[12]), misc: n(r[13]),
    totalCharges: n(r[14]), sttCtt: n(r[15]), fy,
  })).filter(r => r.securityName);
}

function parseGainLoss(content: string, fy: string): GainLossRow[] {
  const rows = parseCSV(content);
  const hIdx = rows.findIndex(r => r[0]?.includes('Script Name'));
  if (hIdx < 0) return [];
  const data: GainLossRow[] = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || r[0] === 'Equity' || r[0].startsWith('Disclaimer')) continue;
    if (r.length < 16) continue;
    data.push({
      scriptName: r[0], buyAmt: n(r[4]), sellAmt: n(r[5]),
      intraday: n(r[6]), shortTerm: n(r[7]), longTerm: n(r[8]), totalPL: n(r[9]),
      gst: n(r[10]), brokerage: n(r[11]), misc: n(r[12]), sttCtt: n(r[13]),
      totalCharges: n(r[14]), netPL: n(r[15]), grossPL: n(r[16] ?? r[15]), fy,
    });
  }
  return data;
}

function parseLedger(content: string, fy: string): LedgerRow[] {
  const rows = parseCSV(content);
  const hIdx = rows.findIndex(r => r[0]?.includes('Date'));
  if (hIdx < 0) return [];
  return rows.slice(hIdx + 1).map(r => ({
    date: r[0], transType: r[2], narration: r[3],
    debit: n(r[4]), credit: n(r[5]), fy,
  })).filter(r => r.date && r.date !== 'Date');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const INR = (v: number, abs = false) =>
  `₹${(abs ? Math.abs(v) : v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const pct = (v: number, total: number) =>
  total === 0 ? '0%' : `${((v / total) * 100).toFixed(1)}%`;

// ─── Computed insights ───────────────────────────────────────────────────────

interface Insights {
  // Summary
  totalBuyValue: number; totalSellValue: number;
  totalBrokerage: number; totalGST: number; totalSTT: number;
  totalMisc: number; totalCharges: number;
  totalNetPL: number; totalGrossPL: number;
  // Ledger
  totalDeposited: number; totalWithdrawn: number;
  totalDPCharges: number; totalInterest: number; totalAuction: number;
  // By year
  yearwise: { fy: string; netPL: number; charges: number; stocks: GainLossRow[] }[];
  // Stocks
  allStocks: (GainLossRow & { fyLabel: string })[];
  winners: GainLossRow[]; losers: GainLossRow[];
  // Behavior
  behaviors: string[];
}

function compute(
  txns: TransactionRow[],
  gainLoss: GainLossRow[],
  ledger: LedgerRow[],
): Insights {
  const totalBuyValue   = txns.filter(t => t.transactionType === 'Buy').reduce((s, t) => s + t.total, 0);
  const totalSellValue  = txns.filter(t => t.transactionType === 'Sell').reduce((s, t) => s + t.total, 0);
  const totalBrokerage  = txns.reduce((s, t) => s + t.brokerage, 0);
  const totalGST        = txns.reduce((s, t) => s + t.gst, 0);
  const totalSTT        = txns.reduce((s, t) => s + t.sttCtt, 0);
  const totalMisc       = txns.reduce((s, t) => s + t.misc, 0);
  const totalCharges    = txns.reduce((s, t) => s + t.totalCharges, 0);
  const totalNetPL      = gainLoss.reduce((s, g) => s + g.netPL, 0);
  const totalGrossPL    = gainLoss.reduce((s, g) => s + g.grossPL, 0);

  const totalDeposited  = ledger.filter(l => l.transType === 'RECEIPT').reduce((s, l) => s + l.credit, 0);
  const totalWithdrawn  = ledger.filter(l => l.transType === 'PAYMENT').reduce((s, l) => s + l.debit, 0);
  const totalDPCharges  = ledger.filter(l => l.narration.toUpperCase().includes('DP CHGS')).reduce((s, l) => s + l.debit, 0);
  const totalInterest   = ledger.filter(l => l.narration.toUpperCase().includes('IC - INTEREST')).reduce((s, l) => s + l.debit, 0);
  const totalAuction    = ledger.filter(l => l.narration.toUpperCase().includes('AUC INT')).reduce((s, l) => s + l.debit, 0);

  // Year-wise
  const fyMap = new Map<string, GainLossRow[]>();
  for (const g of gainLoss) {
    const arr = fyMap.get(g.fy) ?? [];
    arr.push(g);
    fyMap.set(g.fy, arr);
  }
  const yearwise = Array.from(fyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fy, stocks]) => ({
      fy,
      netPL: stocks.reduce((s, g) => s + g.netPL, 0),
      charges: stocks.reduce((s, g) => s + g.totalCharges, 0),
      stocks,
    }));

  const allStocks = gainLoss.map(g => ({ ...g, fyLabel: g.fy }));
  const sorted = [...gainLoss].sort((a, b) => b.netPL - a.netPL);
  const winners = sorted.filter(g => g.netPL > 0).slice(0, 5);
  const losers  = [...sorted].reverse().filter(g => g.netPL < 0).slice(0, 5);

  // Behavior detection
  const behaviors: string[] = [];

  // Check for penny stocks (market rate < 10)
  const pennyTrades = txns.filter(t => t.marketRate < 10 && t.marketRate > 0);
  if (pennyTrades.length > 0) {
    const pennyVal = pennyTrades.reduce((s, t) => s + t.total, 0);
    const pennyPct = totalBuyValue > 0 ? (pennyVal / totalBuyValue) * 100 : 0;
    behaviors.push(`Penny stock exposure: ${pennyTrades.length} trades in sub-₹10 stocks (${pennyPct.toFixed(0)}% of buy value). High variance, one miss can wipe multiple wins.`);
  }

  // Averaging down detection
  const stockBuys = new Map<string, number[]>();
  for (const t of txns.filter(x => x.transactionType === 'Buy')) {
    const arr = stockBuys.get(t.securityName) ?? [];
    arr.push(t.marketRate);
    stockBuys.set(t.securityName, arr);
  }
  const avgDown: string[] = [];
  for (const [name, prices] of stockBuys.entries()) {
    if (prices.length >= 3 && prices[prices.length - 1] < prices[0] * 0.8) {
      avgDown.push(name);
    }
  }
  if (avgDown.length > 0) {
    behaviors.push(`Averaging down detected on: ${avgDown.slice(0, 4).join(', ')}. Works in recoveries, dangerous in structural declines.`);
  }

  // No stop-loss: bought and held for loss > 2 years
  const bigLosers = gainLoss.filter(g => g.longTerm < -5000);
  if (bigLosers.length > 0) {
    behaviors.push(`Long-term loss positions (held >1yr, loss >₹5K): ${bigLosers.map(g => g.scriptName).join(', ')}. No stop-loss discipline detected.`);
  }

  // Multi-platform mixing
  if (txns.some(t => t.securityName?.includes('SMALLCASE') || (t as any).orderSource?.includes('SMALLCASE'))) {
    behaviors.push('Mixed platforms (Kotak + Smallcase) on same stocks — can cause T+2 short delivery and auction penalties.');
  }

  // Concentration
  const topStock = sorted[0];
  if (topStock && totalGrossPL > 0) {
    const conc = (topStock.grossPL / totalGrossPL) * 100;
    if (conc > 60) {
      behaviors.push(`${conc.toFixed(0)}% of total profit from single stock (${topStock.scriptName}). Portfolio concentration risk — one bad call would have erased everything.`);
    }
  }

  // Inactivity with holding costs
  if (totalDPCharges > 0 && yearwise.length > 3) {
    behaviors.push(`Paid ${INR(totalDPCharges)} in DP charges including dormant years. Holding loss-making positions has an ongoing monthly cost.`);
  }

  return {
    totalBuyValue, totalSellValue, totalBrokerage, totalGST, totalSTT,
    totalMisc, totalCharges, totalNetPL, totalGrossPL,
    totalDeposited, totalWithdrawn, totalDPCharges, totalInterest, totalAuction,
    yearwise, allStocks, winners, losers, behaviors,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, color, icon: Icon }: {
  label: string; value: string; sub?: string; color: string; icon: any;
}) {
  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-slate-400 text-xs font-semibold uppercase tracking-wide">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className={`text-2xl font-black ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function StockTable({ title, rows, color }: { title: string; rows: GainLossRow[]; color: string }) {
  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
      <h3 className="text-sm font-bold text-slate-300 mb-3">{title}</h3>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <div>
              <div className="text-white font-medium">{r.scriptName}</div>
              <div className="text-slate-500 text-xs">{r.fy}</div>
            </div>
            <div className={`font-bold font-mono ${color}`}>
              {r.netPL >= 0 ? '+' : ''}{INR(r.netPL)}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-slate-500 text-xs">No data</p>}
      </div>
    </div>
  );
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const w = max === 0 ? 0 : Math.min(100, Math.abs(value / max) * 100);
  return (
    <div className="h-1.5 rounded bg-slate-700 overflow-hidden flex-1">
      <div className={`h-full rounded ${color}`} style={{ width: `${w}%` }} />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const [files, setFiles]     = useState<UploadedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab]         = useState<'overview' | 'yearwise' | 'stocks' | 'charges' | 'behavior'>('overview');
  const [expandedBehavior, setExpandedBehavior] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Parsed
  const txns    = files.filter(f => f.type === 'transaction').flatMap(f => parseTransactions(f.content, f.fy));
  const gl      = files.filter(f => f.type === 'gain_loss').flatMap(f => parseGainLoss(f.content, f.fy));
  const ledger  = files.filter(f => f.type === 'ledger').flatMap(f => parseLedger(f.content, f.fy));
  const hasData = gl.length > 0 || txns.length > 0;
  const ins     = hasData ? compute(txns, gl, ledger) : null;

  const processFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;
    Array.from(incoming).forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        const content = e.target?.result as string ?? '';
        const type = detectType(content, file.name);
        const fy   = extractFY(file.name);
        setFiles(prev => {
          if (prev.some(p => p.name === file.name)) return prev;
          return [...prev, { name: file.name, type, fy, content }];
        });
      };
      reader.readAsText(file);
    });
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const removeFile = (name: string) => setFiles(prev => prev.filter(f => f.name !== name));

  const typeColor: Record<CSVType, string> = {
    transaction: 'text-blue-400', gain_loss: 'text-emerald-400',
    ledger: 'text-amber-400', unknown: 'text-slate-400',
  };
  const typeLabel: Record<CSVType, string> = {
    transaction: 'Transactions', gain_loss: 'Gain/Loss',
    ledger: 'Ledger', unknown: 'Unknown',
  };

  const maxAbsPL = ins ? Math.max(...ins.yearwise.map(y => Math.abs(y.netPL))) : 1;

  return (
    <div className="min-h-screen bg-slate-950 p-4 md:p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-indigo-900/40 rounded-lg">
          <BarChart2 className="w-5 h-5 text-indigo-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">My Trading Profile</h1>
          <p className="text-xs text-slate-400">Upload Kotak transaction, gain/loss and ledger CSVs to analyse your portfolio</p>
        </div>
      </div>

      {/* Upload zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
          ${dragOver ? 'border-indigo-500 bg-indigo-950/30' : 'border-slate-700 hover:border-slate-500 bg-slate-900/40'}`}
      >
        <Upload className="w-8 h-8 text-slate-500 mx-auto mb-3" />
        <p className="text-slate-300 font-semibold">Drop CSV files here or click to browse</p>
        <p className="text-slate-500 text-sm mt-1">
          Accepts: Transaction_Statement, Gain_Loss, Ledger CSVs from Kotak Securities
        </p>
        <input ref={fileRef} type="file" multiple accept=".csv" className="hidden"
          onChange={e => processFiles(e.target.files)} />
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
            <FileText className="w-3.5 h-3.5" /> Uploaded Files ({files.length})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {files.map(f => (
              <div key={f.name} className="flex items-center gap-2 bg-slate-800 rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-white truncate">{f.name}</div>
                  <div className={`text-[10px] font-semibold ${typeColor[f.type]}`}>
                    {typeLabel[f.type]} · {f.fy}
                    {f.type === 'unknown' && ' ⚠'}
                  </div>
                </div>
                <button onClick={() => removeFile(f.name)}
                  className="text-slate-500 hover:text-red-400 transition-colors flex-shrink-0">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No data state */}
      {!hasData && files.length > 0 && (
        <div className="rounded-xl bg-amber-900/20 border border-amber-800 p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
          <p className="text-amber-300 text-sm">Files uploaded but no parseable data found. Ensure you have Transaction or Gain/Loss CSVs.</p>
        </div>
      )}

      {ins && (
        <>
          {/* ── Summary Cards ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <SummaryCard
              label="Net P&L"
              value={INR(ins.totalNetPL)}
              sub={ins.totalNetPL >= 0 ? 'Overall profit' : 'Overall loss'}
              color={ins.totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'}
              icon={ins.totalNetPL >= 0 ? TrendingUp : TrendingDown}
            />
            <SummaryCard
              label="Total Invested"
              value={INR(ins.totalBuyValue)}
              sub={`${txns.filter(t => t.transactionType === 'Buy').length} buy transactions`}
              color="text-blue-400"
              icon={ArrowUpRight}
            />
            <SummaryCard
              label="Total Charges"
              value={INR(ins.totalCharges + ins.totalDPCharges + ins.totalAuction + ins.totalInterest)}
              sub="Brokerage + STT + GST + DP + penalties"
              color="text-amber-400"
              icon={Receipt}
            />
            <SummaryCard
              label="Cash Flow"
              value={ins.totalDeposited > 0 ? `${INR(ins.totalDeposited, true)} in` : `${INR(ins.totalBuyValue)} traded`}
              sub={ins.totalWithdrawn > 0 ? `${INR(ins.totalWithdrawn, true)} withdrawn` : `From ${files.filter(f=>f.type==='ledger').length} ledger files`}
              color="text-purple-400"
              icon={Wallet}
            />
          </div>

          {/* ── Gross P&L breakdown ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Gross P&L', value: ins.totalGrossPL, color: 'text-emerald-300' },
              { label: 'Brokerage Paid', value: -ins.totalBrokerage, color: 'text-orange-400' },
              { label: 'STT / CTT Paid', value: -ins.totalSTT, color: 'text-orange-400' },
              { label: 'GST + Misc', value: -(ins.totalGST + ins.totalMisc), color: 'text-orange-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-xl bg-slate-900 border border-slate-800 p-3">
                <div className="text-xs text-slate-500 mb-1">{label}</div>
                <div className={`text-lg font-bold ${color}`}>{value >= 0 ? '+' : ''}{INR(value)}</div>
              </div>
            ))}
          </div>

          {/* Hidden costs row */}
          {(ins.totalDPCharges + ins.totalAuction + ins.totalInterest) > 0 && (
            <div className="rounded-xl bg-red-950/20 border border-red-900/40 p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <span className="text-sm font-bold text-red-300">Hidden Costs Beyond Brokerage</span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'DP Charges (demat maint.)', v: ins.totalDPCharges },
                  { label: 'Auction Penalties', v: ins.totalAuction },
                  { label: 'Debit Interest', v: ins.totalInterest },
                ].map(({ label, v }) => (
                  v > 0 && (
                    <div key={label}>
                      <div className="text-xs text-slate-400">{label}</div>
                      <div className="text-base font-bold text-red-400">-{INR(v)}</div>
                    </div>
                  )
                ))}
              </div>
              <div className="mt-2 pt-2 border-t border-red-900/30 flex items-center justify-between">
                <span className="text-xs text-slate-400">Total hidden costs</span>
                <span className="text-sm font-bold text-red-400">
                  -{INR(ins.totalDPCharges + ins.totalAuction + ins.totalInterest)}
                </span>
              </div>
            </div>
          )}

          {/* ── Tabs ── */}
          <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 overflow-x-auto">
            {(['overview', 'yearwise', 'stocks', 'charges', 'behavior'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-colors
                  ${tab === t ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                {t === 'yearwise' ? 'Year-wise' : t === 'behavior' ? 'Insights' : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* ── Tab: Overview ── */}
          {tab === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <StockTable title="🏆 Top Winners" rows={ins.winners} color="text-emerald-400" />
              <StockTable title="📉 Biggest Losers" rows={ins.losers} color="text-red-400" />

              {/* Year-wise mini chart */}
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 col-span-1 lg:col-span-2">
                <h3 className="text-sm font-bold text-slate-300 mb-4">Year-wise Net P&L</h3>
                <div className="space-y-3">
                  {ins.yearwise.map(y => (
                    <div key={y.fy} className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 w-24 flex-shrink-0">{y.fy}</span>
                      <MiniBar value={y.netPL} max={maxAbsPL} color={y.netPL >= 0 ? 'bg-emerald-500' : 'bg-red-500'} />
                      <span className={`text-xs font-bold w-28 text-right flex-shrink-0 font-mono
                        ${y.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {y.netPL >= 0 ? '+' : ''}{INR(y.netPL)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Tab: Year-wise ── */}
          {tab === 'yearwise' && (
            <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    {['FY', 'Stocks', 'Buy Value', 'Sell Value', 'Gross P&L', 'Charges', 'Net P&L'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-bold text-slate-400 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ins.yearwise.map((y, i) => (
                    <tr key={y.fy} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-800/20'}`}>
                      <td className="px-4 py-3 font-semibold text-white">{y.fy}</td>
                      <td className="px-4 py-3 text-slate-300">{y.stocks.length}</td>
                      <td className="px-4 py-3 text-slate-300 font-mono">
                        {INR(y.stocks.reduce((s, g) => s + g.buyAmt, 0))}
                      </td>
                      <td className="px-4 py-3 text-slate-300 font-mono">
                        {INR(y.stocks.reduce((s, g) => s + g.sellAmt, 0))}
                      </td>
                      <td className={`px-4 py-3 font-mono font-bold ${y.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {INR(y.stocks.reduce((s, g) => s + g.grossPL, 0))}
                      </td>
                      <td className="px-4 py-3 text-orange-400 font-mono">-{INR(y.charges)}</td>
                      <td className={`px-4 py-3 font-mono font-black text-base ${y.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {y.netPL >= 0 ? '+' : ''}{INR(y.netPL)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-indigo-950/30 border-t-2 border-indigo-800">
                    <td className="px-4 py-3 font-black text-white" colSpan={4}>Total</td>
                    <td className={`px-4 py-3 font-mono font-black ${ins.totalGrossPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {INR(ins.totalGrossPL)}
                    </td>
                    <td className="px-4 py-3 text-orange-400 font-mono font-bold">
                      -{INR(ins.yearwise.reduce((s, y) => s + y.charges, 0))}
                    </td>
                    <td className={`px-4 py-3 font-mono font-black text-lg ${ins.totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {ins.totalNetPL >= 0 ? '+' : ''}{INR(ins.totalNetPL)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* ── Tab: Stocks ── */}
          {tab === 'stocks' && (
            <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-300">All Stocks ({ins.allStocks.length})</h3>
                <div className="text-xs text-slate-500">Sorted by Net P&L</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800">
                      {['Stock', 'FY', 'Buy ₹', 'Sell ₹', 'STCG', 'LTCG', 'Charges', 'Net P&L', 'Return'].map(h => (
                        <th key={h} className="text-left px-4 py-2 text-xs font-bold text-slate-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...ins.allStocks].sort((a, b) => b.netPL - a.netPL).map((s, i) => {
                      const ret = s.buyAmt > 0 ? ((s.netPL / s.buyAmt) * 100) : 0;
                      return (
                        <tr key={`${s.scriptName}-${s.fy}`} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-800/20'}`}>
                          <td className="px-4 py-2 font-medium text-white whitespace-nowrap">{s.scriptName}</td>
                          <td className="px-4 py-2 text-slate-500 text-xs">{s.fy}</td>
                          <td className="px-4 py-2 text-slate-300 font-mono text-xs">{INR(s.buyAmt)}</td>
                          <td className="px-4 py-2 text-slate-300 font-mono text-xs">{INR(s.sellAmt)}</td>
                          <td className={`px-4 py-2 font-mono text-xs ${s.shortTerm >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {s.shortTerm !== 0 ? (s.shortTerm >= 0 ? '+' : '') + INR(s.shortTerm) : '—'}
                          </td>
                          <td className={`px-4 py-2 font-mono text-xs ${s.longTerm >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {s.longTerm !== 0 ? (s.longTerm >= 0 ? '+' : '') + INR(s.longTerm) : '—'}
                          </td>
                          <td className="px-4 py-2 text-orange-400 font-mono text-xs">-{INR(s.totalCharges)}</td>
                          <td className={`px-4 py-2 font-mono font-bold ${s.netPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {s.netPL >= 0 ? '+' : ''}{INR(s.netPL)}
                          </td>
                          <td className={`px-4 py-2 font-mono text-xs ${ret >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {ret >= 0 ? '+' : ''}{ret.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Tab: Charges ── */}
          {tab === 'charges' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  { label: 'Brokerage', value: ins.totalBrokerage, pctOf: ins.totalBuyValue, desc: 'Flat ₹21/trade or % of value' },
                  { label: 'STT / CTT', value: ins.totalSTT, pctOf: ins.totalBuyValue, desc: 'Securities Transaction Tax (govt)' },
                  { label: 'GST on Brokerage', value: ins.totalGST, pctOf: ins.totalBrokerage, desc: '18% on brokerage amount' },
                  { label: 'Misc / Exchange Charges', value: ins.totalMisc, pctOf: ins.totalBuyValue, desc: 'SEBI fee, clearing, stamp duty' },
                  { label: 'DP Charges', value: ins.totalDPCharges, pctOf: 0, desc: 'Demat maintenance — paid even when dormant' },
                  { label: 'Auction Penalties', value: ins.totalAuction, pctOf: 0, desc: 'Short delivery auction charges' },
                ].filter(c => c.value > 0).map(c => (
                  <div key={c.label} className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                    <div className="text-xs text-slate-500 mb-1">{c.label}</div>
                    <div className="text-xl font-black text-amber-400">{INR(c.value)}</div>
                    {c.pctOf > 0 && (
                      <div className="text-xs text-slate-500 mt-0.5">{pct(c.value, c.pctOf)} of buy value</div>
                    )}
                    <div className="text-xs text-slate-600 mt-2">{c.desc}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <h3 className="text-sm font-bold text-slate-300 mb-3">Charges Impact on P&L</h3>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Gross P&L (before charges)</span>
                    <span className={`font-bold ${ins.totalGrossPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {ins.totalGrossPL >= 0 ? '+' : ''}{INR(ins.totalGrossPL)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Exchange charges (brokerage + STT + GST + misc)</span>
                    <span className="text-red-400 font-bold">-{INR(ins.totalCharges)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">DP + Auction + Interest</span>
                    <span className="text-red-400 font-bold">-{INR(ins.totalDPCharges + ins.totalAuction + ins.totalInterest)}</span>
                  </div>
                  <div className="border-t border-slate-700 pt-2 flex justify-between">
                    <span className="font-bold text-white">Net P&L (after all costs)</span>
                    <span className={`font-black text-lg ${ins.totalNetPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {ins.totalNetPL >= 0 ? '+' : ''}{INR(ins.totalNetPL)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Ledger cash flow */}
              {ledger.length > 0 && (
                <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                  <h3 className="text-sm font-bold text-slate-300 mb-3">Cash Flow (from Ledger)</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-slate-500">Total Deposited into Kotak</div>
                      <div className="text-xl font-bold text-blue-400">{INR(ins.totalDeposited)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Total Withdrawn from Kotak</div>
                      <div className="text-xl font-bold text-purple-400">{INR(ins.totalWithdrawn)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Net Cash Extracted (profits banked)</div>
                      <div className={`text-xl font-bold ${ins.totalWithdrawn - ins.totalDeposited >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {INR(ins.totalWithdrawn - ins.totalDeposited)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Return on Capital Deployed</div>
                      <div className={`text-xl font-bold ${ins.totalDeposited > 0 && ((ins.totalWithdrawn - ins.totalDeposited) / ins.totalDeposited) * 100 >= 0 ? 'text-emerald-400' : 'text-slate-300'}`}>
                        {ins.totalDeposited > 0
                          ? `${(((ins.totalWithdrawn - ins.totalDeposited) / ins.totalDeposited) * 100).toFixed(1)}%`
                          : 'Upload ledger files'}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Behavior / Insights ── */}
          {tab === 'behavior' && (
            <div className="space-y-4">
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Target className="w-4 h-4 text-indigo-400" />
                  <h3 className="text-sm font-bold text-slate-300">Auto-Detected Trading Patterns</h3>
                </div>
                <div className="space-y-3">
                  {ins.behaviors.map((b, i) => (
                    <div key={i}
                      className="rounded-lg bg-slate-800 border border-slate-700 p-3 cursor-pointer"
                      onClick={() => setExpandedBehavior(expandedBehavior === i ? null : i)}>
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-slate-200">{b}</p>
                      </div>
                    </div>
                  ))}
                  {ins.behaviors.length === 0 && (
                    <div className="flex items-center gap-2 text-slate-500 text-sm">
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                      No concerning patterns detected — upload more files for deeper analysis.
                    </div>
                  )}
                </div>
              </div>

              {/* Key rules */}
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <h3 className="text-sm font-bold text-slate-300 mb-4">Key Lessons from This Portfolio</h3>
                <div className="space-y-3">
                  {[
                    { icon: '✅', title: 'What works', points: [
                      'Macro recovery plays (COVID crash timing was excellent)',
                      'Early entry in growth stories (Adani Green at ₹85-130)',
                      'Patient holding on conviction plays (Alok Industries)',
                    ]},
                    { icon: '❌', title: 'What doesn\'t work', points: [
                      'No stop-loss discipline — Future Consumer held from ₹18 to ₹0.50',
                      'Averaging down on structurally broken companies (not temporary dips)',
                      'Mixing platforms (Kotak + Smallcase) causes T+2 settlement risks',
                      'Paying DP charges on dormant positions in losing stocks',
                    ]},
                    { icon: '📏', title: 'Rules to adopt going forward', points: [
                      'Define exit price before entering every trade',
                      'Max 20% of capital in sub-₹10 stocks',
                      'Never average down more than 2× on any single stock',
                      'Use one platform per stock to avoid settlement confusion',
                      'Review DP holdings quarterly — exit dormant losers',
                    ]},
                  ].map(section => (
                    <div key={section.title} className="rounded-lg bg-slate-800 p-3">
                      <div className="font-semibold text-white mb-2">{section.icon} {section.title}</div>
                      <ul className="space-y-1">
                        {section.points.map((p, i) => (
                          <li key={i} className="text-sm text-slate-400 flex items-start gap-2">
                            <span className="text-slate-600 flex-shrink-0">·</span> {p}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>

              {/* Concentration warning */}
              {ins.yearwise.length > 0 && (() => {
                const fy21 = ins.yearwise.find(y => y.fy.includes('2020-21'));
                if (!fy21) return null;
                const best = [...fy21.stocks].sort((a, b) => b.netPL - a.netPL)[0];
                if (!best) return null;
                const conc = fy21.netPL > 0 ? (best.netPL / fy21.netPL) * 100 : 0;
                if (conc < 50) return null;
                return (
                  <div className="rounded-xl bg-amber-950/30 border border-amber-800 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                      <span className="font-bold text-amber-300 text-sm">Concentration Risk Alert</span>
                    </div>
                    <p className="text-sm text-amber-200">
                      {conc.toFixed(0)}% of {fy21.fy} profit ({INR(best.netPL)}) came from <strong>{best.scriptName}</strong> alone.
                      If that trade had failed, the entire year would have been a loss.
                      Diversification rule: no single stock should contribute &gt;40% of annual P&L.
                    </p>
                  </div>
                );
              })()}
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {files.length === 0 && (
        <div className="rounded-xl bg-slate-900/40 border border-slate-800 p-8 text-center">
          <Info className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400 font-semibold mb-2">How to use this page</p>
          <ol className="text-slate-500 text-sm space-y-1 text-left max-w-md mx-auto">
            <li>1. Log in to Kotak Securities → Reports</li>
            <li>2. Download <strong className="text-slate-400">Transaction Statement</strong> CSVs (all years)</li>
            <li>3. Download <strong className="text-slate-400">Gain & Loss</strong> CSVs (all years)</li>
            <li>4. Download <strong className="text-slate-400">Ledger</strong> CSVs (all years)</li>
            <li>5. Upload all files above — analysis auto-generates</li>
          </ol>
        </div>
      )}
    </div>
  );
}
