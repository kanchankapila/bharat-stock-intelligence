import React, { useMemo, useState } from 'react';
import { BarChart3, BriefcaseBusiness, CalendarClock, Database, Layers3, Radio, ShieldCheck, Waves, Workflow } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '../lib/trpc';
import { MarketPulsePage } from './pages/MarketPulsePage';
import { PortfolioDeskPage } from './pages/PortfolioDeskPage';
import { ScreenerLabPage } from './pages/ScreenerLabPage';
import { SignalReviewPage } from './pages/SignalReviewPage';
import { RiskDeskPage } from './pages/RiskDeskPage';
import { OptionsDeskPage } from './pages/OptionsDeskPage';
import { WorkstationPage } from './pages/WorkstationPage';
import { StockIntelligenceDeskPage } from './pages/StockIntelligenceDeskPage';
import { EarningsPulseDeskPage } from './pages/EarningsPulseDeskPage';
import { PreMarketBriefingDeskPage } from './pages/PreMarketBriefingDeskPage';
import { MacroRegimeDeskPage } from './pages/MacroRegimeDeskPage';
import { InstitutionalFlowDeskPage } from './pages/InstitutionalFlowDeskPage';
import './v5.css';
import type { StockTab } from './pages/StockIntelligenceDeskPage';

type DeskKey = 'pulse' | 'briefing' | 'macro-regime' | 'institutional-flow' | 'portfolio' | 'screener' | 'signals' | 'risk' | 'options' | 'workstation' | 'stock-intel' | 'earnings';

const NAV_ITEMS: { key: DeskKey; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'pulse', label: 'Market Pulse', hint: 'Macro + tape + activity', icon: BarChart3 },
  { key: 'briefing', label: 'Pre-Market Briefing', hint: 'Overnight setup', icon: CalendarClock },
  { key: 'macro-regime', label: 'Macro Regime', hint: 'Regime + flows + risk tape', icon: ShieldCheck },
  { key: 'institutional-flow', label: 'Institutional Flows', hint: 'FII/DII flow trends', icon: Database },
  { key: 'portfolio', label: 'Portfolio Desk', hint: 'Allocation sandbox', icon: BriefcaseBusiness },
  { key: 'screener', label: 'Screener Lab', hint: 'Confluence universe', icon: Layers3 },
  { key: 'earnings', label: 'Earnings Pulse', hint: 'Results + shockers', icon: CalendarClock },
  { key: 'signals', label: 'Signal Review', hint: 'Live signal quality', icon: Radio },
  { key: 'risk', label: 'Risk Desk', hint: 'Regime + factor risk', icon: ShieldCheck },
  { key: 'options', label: 'Options Desk', hint: 'PCR + max pain + OI', icon: Waves },
  { key: 'stock-intel', label: 'Stock Intelligence', hint: 'Dedicated stock research', icon: Layers3 },
  { key: 'workstation', label: 'Stock Workstation', hint: 'Symbol deep dive', icon: Workflow },
];

export default function V5App() {
  const navigate = useNavigate();
  const [page, setPage] = useState<DeskKey>('pulse');
  const [query, setQuery] = useState('');
  const [selectedSymbol, setSelectedSymbol] = useState('RELIANCE');
  const [stockIntelTab, setStockIntelTab] = useState<StockTab>('overview');

  const fiiDiiQ = trpc.getFiiDiiFlow.useQuery(
    { days: 10 },
    { refetchInterval: 5 * 60_000, refetchOnWindowFocus: true },
  );

  const mood = useMemo(() => {
    const entries = fiiDiiQ.data ?? [];
    const latest = Array.isArray(entries) && entries.length ? (entries[0] as any) : null;
    const fiiNet = Number(latest?.fii_net ?? 0);
    const diiNet = Number(latest?.dii_net ?? 0);
    const score = fiiNet + diiNet;
    if (score > 0) return { text: 'Risk-On', color: 'text-teal-700 bg-teal-50 border-teal-200', net: score };
    if (score < 0) return { text: 'Risk-Off', color: 'text-rose-700 bg-rose-50 border-rose-200', net: score };
    return { text: 'Neutral', color: 'text-amber-700 bg-amber-50 border-amber-200', net: score };
  }, [fiiDiiQ.data]);

  const dataStatus = useMemo(() => {
    const entries = fiiDiiQ.data ?? [];
    const latest = Array.isArray(entries) && entries.length ? (entries[0] as any) : null;
    const asOf = latest?.date ?? latest?.as_of_date ?? latest?.dt ?? null;
    const syncedAt = fiiDiiQ.dataUpdatedAt ? new Date(fiiDiiQ.dataUpdatedAt).toLocaleString('en-IN') : '—';
    return {
      asOf: typeof asOf === 'string' && asOf.trim() ? asOf : '—',
      syncedAt,
      rows: Array.isArray(entries) ? entries.length : 0,
      source: 'tRPC live',
    };
  }, [fiiDiiQ.data, fiiDiiQ.dataUpdatedAt]);

  const renderPage = () => {
    if (page === 'pulse') return <MarketPulsePage />;
    if (page === 'briefing') return <PreMarketBriefingDeskPage />;
    if (page === 'macro-regime') return <MacroRegimeDeskPage />;
    if (page === 'institutional-flow') return <InstitutionalFlowDeskPage />;
    if (page === 'portfolio') return <PortfolioDeskPage />;
    if (page === 'screener') return <ScreenerLabPage onSelectSymbol={(sym) => { setSelectedSymbol(sym); setPage('workstation'); }} />;
    if (page === 'earnings') return <EarningsPulseDeskPage onSelectSymbol={(sym) => { setSelectedSymbol(sym); setStockIntelTab('earnings'); setPage('stock-intel'); }} />;
    if (page === 'signals') return <SignalReviewPage onSelectSymbol={(sym) => { setSelectedSymbol(sym); setStockIntelTab('overview'); setPage('stock-intel'); }} />;
    if (page === 'risk') return <RiskDeskPage onSelectSymbol={(sym) => { setSelectedSymbol(sym); setStockIntelTab('overview'); setPage('stock-intel'); }} />;
    if (page === 'options') return <OptionsDeskPage onSelectSymbol={(sym) => { setSelectedSymbol(sym); setStockIntelTab('overview'); setPage('stock-intel'); }} />;
    if (page === 'stock-intel') return <StockIntelligenceDeskPage selectedSymbol={selectedSymbol} setSelectedSymbol={setSelectedSymbol} query={query} setQuery={setQuery} initialTab={stockIntelTab} />;
    return <WorkstationPage selectedSymbol={selectedSymbol} setSelectedSymbol={setSelectedSymbol} query={query} setQuery={setQuery} flowMood={mood.text} />;
  };

  return (
    <div className="v5-root">
      <div className="v5-shell">
        <div className="v5-layout">
          <aside className="v5-card v5-sidebar p-4">
            <div className="mb-4 border-b border-slate-200 pb-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Bharat Stock Intelligence</p>
              <h1 className="v5-title mt-1 text-xl font-bold text-slate-900">V5 Institutional</h1>
              <p className="mt-2 text-xs text-slate-600">Modern execution surface over your existing live quant stack.</p>
              <button
                onClick={() => navigate('/dashboard')}
                className="mt-3 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Back to Classic
              </button>
            </div>

            <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Flow Mood</div>
              <div className="mt-1 flex items-center justify-between">
                <span className={`v5-chip border ${mood.color}`}>{mood.text}</span>
                <span className="text-xs font-semibold text-slate-600">{mood.net.toFixed(0)}</span>
              </div>
            </div>

            <nav className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = page === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => setPage(item.key)}
                    className={`v5-nav-btn ${active ? 'v5-nav-btn-active' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      <span className="font-semibold">{item.label}</span>
                    </div>
                    <span className="text-[11px] text-slate-500">{item.hint}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main className="space-y-4">
            <header className="v5-card p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Institutional Workbench</p>
                  <h2 className="v5-title mt-1 text-2xl font-bold text-slate-900">
                    {NAV_ITEMS.find((x) => x.key === page)?.label}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">Professional frontend layer over existing tRPC + TimescaleDB intelligence engines.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`v5-chip border ${mood.color}`}>{mood.text}</span>
                  <span className="v5-chip">Rows: {dataStatus.rows}</span>
                  <span className="v5-chip">As-of: {dataStatus.asOf}</span>
                </div>
              </div>

              <div className="v5-controlbar mt-4">
                <div className="v5-controlgroup">
                  <span className="v5-control-label"><CalendarClock className="h-3.5 w-3.5" /> As-of</span>
                  <span className="v5-control-pill v5-control-pill-active">{dataStatus.asOf}</span>
                </div>

                <div className="v5-controlgroup">
                  <span className="v5-control-label">Rows</span>
                  <span className="v5-control-pill">{dataStatus.rows}</span>
                </div>

                <div className="v5-controlgroup">
                  <span className="v5-control-label"><Database className="h-3.5 w-3.5" /> Lens</span>
                  <span className="v5-control-pill">{dataStatus.source}</span>
                </div>

                <div className="v5-controlgroup">
                  <span className="v5-control-label">Last Sync</span>
                  <span className="v5-control-pill">{dataStatus.syncedAt}</span>
                </div>

                <button
                  onClick={() => {
                    setPage('workstation');
                    if (!selectedSymbol) setSelectedSymbol('RELIANCE');
                  }}
                  className="v5-control-primary"
                >
                  Open Workstation
                </button>

                <button
                  onClick={() => navigate('/dashboard')}
                  className="v5-control-pill"
                >
                  Back to Classic
                </button>
              </div>
            </header>

            <section className="v5-page-enter">
              {renderPage()}
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
