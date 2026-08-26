import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import './concept.css';

/* ── deterministic PRNG — every visit draws the exact same "market" ────── */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walk(seed: number, points: number, drift: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  let v = 50;
  for (let i = 0; i < points; i++) {
    v += (rnd() - 0.48) * 11 + drift;
    v = Math.max(8, Math.min(92, v));
    out.push(v);
  }
  return out;
}

interface Pt { readonly x: number; readonly y: number }

function project(vals: number[], w: number, h: number): Pt[] {
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = max - min || 1;
  const stepX = (w - 8) / (vals.length - 1);
  return vals.map((v, i) => ({
    x: 4 + i * stepX,
    y: 4 + (1 - (v - min) / span) * (h - 8),
  }));
}

function linePath(pts: Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

function areaPath(pts: Pt[], h: number): string {
  const last = pts[pts.length - 1];
  return `${linePath(pts)} L${last.x.toFixed(1)} ${h - 2} L4 ${h - 2} Z`;
}

/* compact table-row sparkline (86x26 viewBox) */
function miniPath(seed: number, chg: number): string {
  const drift = Math.abs(chg) < 0.05 ? 0 : chg > 0 ? 0.9 : -0.9;
  const pts = project(walk(seed, 26, drift), 86, 26);
  return linePath(pts);
}

/* ── formatting — Indian digit grouping throughout (₹19,98,000 Cr) ─────── */
const nfPrice = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfInt = new Intl.NumberFormat('en-IN');
const rupees = (n: number): string => `\u20B9${nfPrice.format(n)}`;
const crores = (n: number): string => `\u20B9${nfInt.format(n)} Cr`;
const signed = (n: number, digits = 2): string => `${n >= 0 ? '+' : '\u2212'}${Math.abs(n).toFixed(digits)}`;
const pctStr = (n: number): string => `${signed(n)}%`;
const arrow = (n: number): string => (n >= 0 ? '\u25B2' : '\u25BC');

type Tone = 'up' | 'dn' | 'nt';
type Verdict = 'ACCUMULATE' | 'HOLD' | 'BOOK PROFIT' | 'AVOID';

const VERDICT_COLOR: Record<Verdict, string> = {
  'ACCUMULATE': 'var(--cl-green)',
  'HOLD': 'var(--cl-gold)',
  'BOOK PROFIT': 'var(--cl-saffron-dk)',
  'AVOID': 'var(--cl-red)',
};

interface StockRow {
  readonly sym: string;
  readonly name: string;
  readonly sector: string;
  readonly price: number;
  readonly chg: number;
  readonly capCr: number;
  readonly verdict: Verdict;
  readonly seed: number;
}

const STOCKS: readonly StockRow[] = [
  { sym: 'RELIANCE',   name: 'Reliance Industries',  sector: 'Energy',        price: 2947.35,  chg:  1.86, capCr: 1998000, verdict: 'ACCUMULATE',  seed: 101 },
  { sym: 'HDFCBANK',   name: 'HDFC Bank',            sector: 'Financials',    price: 1712.60,  chg:  0.74, capCr: 1305000, verdict: 'ACCUMULATE',  seed: 102 },
  { sym: 'ICICIBANK',  name: 'ICICI Bank',           sector: 'Financials',    price: 1268.45,  chg:  1.32, capCr:  892000, verdict: 'ACCUMULATE',  seed: 103 },
  { sym: 'TCS',        name: 'Tata Consultancy',     sector: 'IT',            price: 4102.15,  chg: -0.62, capCr: 1482000, verdict: 'BOOK PROFIT', seed: 104 },
  { sym: 'INFY',       name: 'Infosys',              sector: 'IT',            price: 1845.30,  chg: -1.14, capCr:  765000, verdict: 'HOLD',        seed: 105 },
  { sym: 'SBIN',       name: 'State Bank of India',  sector: 'PSU Bank',      price:  824.90,  chg:  2.47, capCr:  736000, verdict: 'ACCUMULATE',  seed: 106 },
  { sym: 'BHARTIARTL', name: 'Bharti Airtel',        sector: 'Telecom',       price: 1587.20,  chg:  0.58, capCr:  941000, verdict: 'HOLD',        seed: 107 },
  { sym: 'ITC',        name: 'ITC',                  sector: 'FMCG',          price:  512.75,  chg: -0.38, capCr:  642000, verdict: 'HOLD',        seed: 108 },
  { sym: 'LT',         name: 'Larsen & Toubro',      sector: 'Infra',         price: 3568.10,  chg:  1.94, capCr:  489000, verdict: 'ACCUMULATE',  seed: 109 },
  { sym: 'TATAMOTORS', name: 'Tata Motors',          sector: 'Auto',          price:  985.40,  chg: -2.08, capCr:  363000, verdict: 'AVOID',       seed: 110 },
  { sym: 'MARUTI',     name: 'Maruti Suzuki',        sector: 'Auto',          price: 12480.55, chg:  0.42, capCr:  392000, verdict: 'HOLD',        seed: 111 },
  { sym: 'TITAN',      name: 'Titan Company',        sector: 'Retail',        price: 3415.80,  chg: -1.47, capCr:  303000, verdict: 'BOOK PROFIT', seed: 112 },
  { sym: 'ADANIENT',   name: 'Adani Enterprises',    sector: 'Conglomerate',  price: 3120.65,  chg:  3.12, capCr:  357000, verdict: 'BOOK PROFIT', seed: 113 },
  { sym: 'CANBK',      name: 'Canara Bank',          sector: 'PSU Bank',      price:  104.85,  chg:  3.86, capCr:   95000, verdict: 'ACCUMULATE',  seed: 114 },
];

interface SectorCell { readonly name: string; readonly chg: number }

const SECTORS: readonly SectorCell[] = [
  { name: 'PSU BANK', chg: 2.41 }, { name: 'REALTY', chg: 1.87 }, { name: 'AUTO', chg: 1.12 },
  { name: 'METAL', chg: 0.84 }, { name: 'ENERGY', chg: 0.62 }, { name: 'FMCG', chg: 0.21 },
  { name: 'FINANCIALS', chg: -0.02 }, { name: 'IT', chg: -0.34 }, { name: 'PHARMA', chg: -0.71 },
  { name: 'MEDIA', chg: -1.63 },
];

interface WireEntry { readonly tag: string; readonly tone: Tone; readonly lead: string; readonly rest: string; readonly val: string }

const WIRE: readonly WireEntry[] = [
  { tag: 'BULK DEAL',  tone: 'up', lead: 'Quant Mutual Fund',  rest: ' bought ',        val: '+\u20B9214 Cr \u00B7 1.9% equity' },
  { tag: 'BLOCK DEAL', tone: 'up', lead: 'SBI Mutual Fund',    rest: ' added ',         val: '+\u20B9132 Cr @ \u20B97,240' },
  { tag: 'INSIDER',    tone: 'dn', lead: 'Promoter \u2014 Kalyan J.', rest: ' sold ',   val: '\u2212\u20B948 Cr \u00B7 0.4% holding' },
  { tag: 'F&O',        tone: 'nt', lead: 'Foreign desk',       rest: ' unwound shorts ', val: 'OI \u221218% \u00B7 premium +31%' },
  { tag: 'DELIVERY',   tone: 'up', lead: 'IRFC',               rest: ' delivery spike',  val: '4.1\u00D7 20-day average' },
];

const TAPE: ReadonlyArray<{ readonly sym: string; readonly chg: number }> = [
  { sym: 'NIFTY 50', chg: 0.68 }, { sym: 'SENSEX', chg: 0.59 }, { sym: 'BANK NIFTY', chg: 0.91 },
  { sym: 'NIFTY MIDCAP', chg: 1.24 }, { sym: 'INDIA VIX', chg: -4.18 },
  ...STOCKS.map((s) => ({ sym: s.sym, chg: s.chg })),
];

const DATELINE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
}).format(new Date());

const iv = (n: number): CSSProperties => ({ '--i': n }) as CSSProperties;

/* ── SVG building blocks ──────────────────────────────────────────────── */

const toneOf = (chg: number, inverse = false): Tone => {
  const eff = inverse ? -chg : chg;
  return Math.abs(eff) < 0.05 ? 'nt' : eff > 0 ? 'up' : 'dn';
};

const TONE_COLOR: Record<Tone, string> = {
  up: 'var(--cl-green)',
  dn: 'var(--cl-red)',
  nt: 'var(--cl-gold)',
};

interface SparkProps { readonly seed: number; readonly tone: Tone }

function Sparkline({ seed, tone }: SparkProps) {
  const pts = useMemo(() => project(walk(seed, 34, tone === 'up' ? 0.9 : tone === 'dn' ? -0.9 : 0), 120, 44), [seed, tone]);
  const color = TONE_COLOR[tone];
  const last = pts[pts.length - 1];
  return (
    <svg viewBox="0 0 120 44" aria-hidden="true">
      <path d={areaPath(pts, 44)} fill={color} opacity={0.09} />
      <path d={linePath(pts)} stroke={color} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last.x} cy={last.y} r={2.1} fill={color} />
    </svg>
  );
}

interface BigProps { readonly seed: number; readonly drift: number }

function BigChart({ seed, drift }: BigProps) {
  const W = 660;
  const H = 290;
  const up = drift >= 0;
  const stroke = up ? 'var(--cl-green)' : 'var(--cl-red)';
  const { line, area, last } = useMemo(() => {
    const pts = project(walk(seed, 130, drift), W, H);
    return { line: linePath(pts), area: areaPath(pts, H), last: pts[pts.length - 1] };
  }, [seed, drift]);
  return (
    <svg className="cl-bigchart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Simulated intraday index chart">
      <defs>
        <linearGradient id="clGradHero" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={up ? '#0d7a4d' : '#bf2121'} stopOpacity={0.22} />
          <stop offset="100%" stopColor={up ? '#0d7a4d' : '#bf2121'} stopOpacity={0} />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--cl-rule)" strokeDasharray="2 6" />
      ))}
      <path d={area} fill="url(#clGradHero)" style={{ animation: 'cl-fadein .9s ease both .35s' }} />
      <path
        d={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
        strokeDasharray={2400} style={{ strokeDashoffset: 0, animation: 'cl-draw 1.6s cubic-bezier(.3,.6,.2,1) both' }}
      />
      <circle cx={last.x} cy={last.y} r={9} fill={stroke} opacity={0.18} className="cl-dot-pulse" />
      <circle cx={last.x} cy={last.y} r={3} fill={stroke} />
    </svg>
  );
}

/* ── derived market data (deterministic) ─────────────────────────────── */

interface IdxDef { readonly name: string; readonly base: number; readonly chg: number; readonly seed: number; readonly inverse?: boolean }

const INDICES: readonly IdxDef[] = [
  { name: 'NIFTY 50',   base: 24712.40, chg:  0.68, seed: 11 },
  { name: 'SENSEX',     base: 81246.15, chg:  0.59, seed: 12 },
  { name: 'BANK NIFTY', base: 52188.90, chg:  0.91, seed: 13 },
  { name: 'INDIA VIX',  base:     13.42, chg: -4.18, seed: 14, inverse: true },
];

const NIFTY_WALK = walk(7, 130, 0.35);
const NIFTY_LAST = 23800 + (NIFTY_WALK[NIFTY_WALK.length - 1] - 50) * 38;
const NIFTY_CHG = (NIFTY_WALK[NIFTY_WALK.length - 1] - NIFTY_WALK[0]) * 0.055;

/* ── page sections ────────────────────────────────────────────────────── */

function TopBar({ clock }: { readonly clock: string }) {
  return (
    <div className="cl-wrap">
      <div className="cl-topbar">
        <span className="cl-live"><span className="cl-live-dot" />SIMULATED FEED</span>
        <span>DESIGN CONCEPT &middot; NOT A TRADING SURFACE</span>
        <span className="cl-stamp">CONCEPT PROOF v1</span>
        <span>IST {clock}</span>
      </div>
    </div>
  );
}

function Tape() {
  const group = (
    <span className="cl-tape-group">
      {TAPE.map((t) => {
        const tone = toneOf(t.chg);
        return (
          <span key={t.sym} className="cl-tape-item">
            <b>{t.sym}</b>
            <span className={`cl-${tone}`}>{arrow(t.chg)} {pctStr(t.chg)}</span>
          </span>
        );
      })}
    </span>
  );
  return (
    <div className="cl-tape" aria-hidden="true">
      <div className="cl-tape-track">{group}{group}</div>
    </div>
  );
}

function Masthead() {
  return (
    <header className="cl-masthead">
      <p className="cl-mast-kicker">The Daily Market Broadsheet &middot; Est. MMXXVI</p>
      <h1 className="cl-mast-title">The Dalal Street <em>Ledger</em></h1>
      <p className="cl-mast-sub">Capital. Conviction. Context.</p>
      <p className="cl-mast-meta"><span>{DATELINE}</span><span>&middot;</span><span>Mumbai &mdash; EDITION NO. 001</span><span>&middot;</span><span>ALL FIGURES SIMULATED</span></p>
      <div className="cl-mast-cta">
        <a href="#the-ledger" className="cl-btn cl-btn-solid">Read the Ledger</a>
        <a href="#the-wire" className="cl-btn cl-btn-ghost">The Wire</a>
      </div>
    </header>
  );
}

function IndexCards() {
  return (
    <div className="cl-cards4">
      {INDICES.map((idx, i) => {
        const tone = toneOf(idx.chg, idx.inverse);
        const value = idx.base * (1 + idx.chg / 100);
        return (
          <article key={idx.name} className="cl-card" style={iv(i)}>
            <div className="cl-card-name"><span>{idx.name}</span><span className="cl-card-tag">{idx.name === 'INDIA VIX' ? 'FEAR GAUGE' : ''}</span></div>
            <div className="cl-card-spark"><Sparkline seed={idx.seed} tone={tone} /></div>
            <div className="cl-card-val">
              {idx.base >= 1000 ? nfInt.format(Math.round(value)) : value.toFixed(2)}
              <span className={`cl-card-chg cl-${tone}`}>{arrow(idx.chg)} {pctStr(idx.chg)}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function HeroSection() {
  return (
    <section className="cl-section" id="markets">
      <IndexCards />
      <div className="cl-hero-grid" style={{ marginTop: 34 }}>
        <div className="cl-bigchart-box">
          <span className="cl-chart-tag">NIFTY 50 &middot; INTRADAY &middot; SIMULATED</span>
          <BigChart seed={7} drift={0.35} />
        </div>
        <div>
          <h2 className="cl-hero-quote">
            &ldquo;Breadth does the talking on a day the <em>PSU banks</em> decided to move the tape &mdash; midcaps ran, the VIX folded, and the bears stayed out in the rain.&rdquo;
          </h2>
      <p className="cl-byline">The Desk &middot; Markets Close</p>
          <div className="cl-hero-rule" />
          <ul className="cl-wire-list">
            {WIRE.slice(0, 3).map((w) => (
              <li key={w.tag + w.lead} className="cl-wire-item">
                <span className="cl-wire-tag">{w.tag}</span>
                <span><b>{w.lead}</b>{w.rest}<span className={`cl-${w.tone}`}>{w.val}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ── ledger table ─────────────────────────────────────────────────────── */

function LedgerSection() {
  return (
    <section className="cl-section" id="the-ledger">
      <div className="cl-sec-head">
        <span className="cl-sec-no">No. 02</span>
        <h2 className="cl-sec-title">The Ledger</h2>
        <span className="cl-sec-note">14 names &middot; simulated closes</span>
      </div>
      <div className="cl-table-wrap">
        <table className="cl-table">
          <thead className="cl-thead">
            <tr>
              <th>Stock</th>
              <th>Sector</th>
              <th>Close</th>
              <th>Chg %</th>
              <th>Trend</th>
              <th>Mkt Cap</th>
              <th>Desk Verdict</th>
            </tr>
          </thead>
          <tbody className="cl-tbody">
            {STOCKS.map((s, i) => {
              const tone = toneOf(s.chg);
              return (
                <tr key={s.sym} style={iv(i)}>
                  <td><span className="cl-sym">{s.sym}<span className="cl-sym-sub">{s.name}</span></span></td>
                  <td className="cl-sector-cell">{s.sector}</td>
                  <td className="cl-num">{rupees(s.price)}</td>
                  <td className={`cl-num cl-${tone}`}>{arrow(s.chg)} {pctStr(s.chg)}</td>
                  <td><svg width="86" height="26" viewBox="0 0 86 26" aria-hidden="true"><path d={miniPath(s.seed, s.chg)} className="cl-mini" stroke={TONE_COLOR[tone]} /></svg></td>
                  <td className="cl-num">{crores(s.capCr)}</td>
                  <td><span className="cl-verdict" style={{ color: VERDICT_COLOR[s.verdict] }}>{s.verdict}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── the wire / sectors / colophon / page ─────────────────────────────── */

function WireSection() {
  return (
    <section className="cl-section" id="the-wire">
      <div className="cl-wire-grid">
        <div>
          <div className="cl-sec-head">
            <span className="cl-sec-no">No. 03</span>
            <h2 className="cl-sec-title">The Wire</h2>
          </div>
          <ul className="cl-wire-list cl-reveal">
            {WIRE.map((w) => (
              <li key={w.tag + w.lead} className="cl-wire-item">
                <span className="cl-wire-tag">{w.tag}</span>
                <span><b>{w.lead}</b>{w.rest}<span className={`cl-${w.tone}`}>{w.val}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <aside>
          <div className="cl-sec-head">
            <span className="cl-sec-no">No. 04</span>
            <h2 className="cl-sec-title">Sectors</h2>
            <span className="cl-sec-note">1D &middot; simulated</span>
          </div>
          <div className="cl-sector-grid cl-reveal">
            {SECTORS.map((s, i) => {
              const t = Math.min(1, Math.abs(s.chg) / 2.5);
              const bg = s.chg >= 0
                ? `rgba(13, 122, 77, ${(0.14 + t * 0.72).toFixed(2)})`
                : `rgba(191, 33, 33, ${(0.14 + t * 0.72).toFixed(2)})`;
              return (
                <div key={s.name} className="cl-cell" style={{ ...iv(i), background: bg }}>
                  <span className="cl-cell-name">{s.name}</span>
                  <span className="cl-cell-val">{arrow(s.chg)} {pctStr(s.chg)}</span>
                </div>
              );
            })}
          </div>
          <p className="cl-sector-foot">Depth of shade encodes move size; colour encodes direction.</p>
        </aside>
      </div>
    </section>
  );
}

function Colophon() {
  return (
    <footer className="cl-colophon cl-wrap">
      <span className="cl-colophon-brand">The Dalal Street Ledger</span>
      <p className="cl-colophon-note">
        <b>Design concept only.</b> Every price, deal, verdict and chart on this page is
        generated deterministically in your browser &mdash; no market feed, no backend, no advice.
        A proposal for a warmer, more editorial direction for Bharat Stock Intelligence.
      </p>
      <a href="#markets" className="cl-btn cl-btn-ghost">Back to top &uarr;</a>
    </footer>
  );
}

function useIstClock(): string {
  const [clock, setClock] = useState('--:--:--');
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const tick = () => setClock(fmt.format(new Date()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  return clock;
}

/** Adds .is-in when the element scrolls into view (one-shot, cheap, no deps). */
function useScrollReveal(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const rootEl = ref.current;
    if (!rootEl || typeof IntersectionObserver === 'undefined') return;
    const targets = rootEl.querySelectorAll('.cl-reveal');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      }
    }, { threshold: 0.18 });
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);
  return ref;
}

export default function ConceptLedger() {
  const clock = useIstClock();
  const ref = useScrollReveal();
  return (
    <div className="concept-root" ref={ref}>
      <TopBar clock={clock} />
      <Tape />
      <Masthead />
      <main className="cl-wrap">
        <HeroSection />
        <LedgerSection />
        <WireSection />
      </main>
      <Colophon />
    </div>
  );
}

