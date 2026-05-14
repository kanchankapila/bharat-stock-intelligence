import React from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import stockData from '../data/stocklist';
import {
  TrendingUp, TrendingDown, Activity, Zap, Info, AlertCircle,
  BarChart3, PieChart, Users, Filter, ArrowUpRight, ArrowDownRight,
  CheckCircle2, BrainCircuit
} from 'lucide-react';
import { motion } from 'motion/react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

interface MCStockInfoPanelProps {
  symbol: string;
  scId: string;
  section?: 'all' | 'technical' | 'fundamental' | 'insights';
}

type Timeframe = 'D' | 'W' | 'M';

import { Card, SentimentBadge, ValueDisplay, IndicatorRow } from './MCCommon';

export const MCStockInfoPanel: React.FC<MCStockInfoPanelProps> = ({ symbol, scId, section }) => {
  const [timeframe, setTimeframe] = React.useState<Timeframe>('D');
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = React.useState(false);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.05, rootMargin: '50px' } // Reduced margin to avoid overwhelming background requests
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // Resolve Trendlyne stockid for screener lookups (numeric ID, different from MC scId)
  const stockMapping = stockData.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());
  const trendlyneStockId = stockMapping?.tlid || stockMapping?.stockid || scId;

  // ─── UNIFIED BATCH QUERY ───────────────────────────────────────────
  // Replaces getMcConsolidated, getStockScoreDetail, getStockScreeners, 
  // and multiple getMcTechnical calls with a single high-performance endpoint.
  const { data: unifiedData, isLoading, error } = trpc.getAlphaQuantDetail.useQuery(
    { symbol, timeframe },
    { 
      enabled: isVisible,
      refetchInterval: isVisible ? 60000 : false,
      staleTime: 30000
    }
  );

  // Fetch only necessary secondary timeframes (W/M) for the divergence panel
  // Primary (D) is already part of the mcData
  const { data: techW } = trpc.getMcTechnical.useQuery(
    { symbol, duration: 'W' },
    { enabled: isVisible, staleTime: 300000 }
  );
  const { data: techM } = trpc.getMcTechnical.useQuery(
    { symbol, duration: 'M' },
    { enabled: isVisible, staleTime: 3600000 }
  );

  if (!isVisible && !unifiedData) {

    return (
      <div ref={containerRef} className="h-40 flex items-center justify-center bg-slate-900/10 border border-dashed border-slate-800 rounded-2xl">
        <p className="text-[10px] font-black text-slate-700 uppercase tracking-widest italic">
          Waiting for visibility... {symbol}
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div ref={containerRef} className="space-y-4 animate-pulse">
        <div className="flex gap-2 mb-4">
          {[1,2,3].map(i => <div key={i} className="h-8 w-20 bg-slate-800 rounded-lg" />)}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1,2,3,4,5,6,7,8].map(i => <div key={i} className="h-20 bg-slate-800/50 rounded-2xl" />)}
        </div>
        <div className="h-64 bg-slate-800/30 rounded-2xl" />
      </div>
    );
  }

  if (error || !unifiedData) {
    const stockName = stockData.find(s => s.symbol.toUpperCase() === symbol.toUpperCase())?.name || symbol;
    return (
      <div ref={containerRef} className="p-8 text-center bg-slate-900/30 border border-slate-800 rounded-2xl">
        <AlertCircle className="w-8 h-8 text-rose-500 mx-auto mb-3" />
        <p className="text-sm text-slate-500 font-bold">Failed to load data for {stockName}</p>
        <p className="text-[10px] text-slate-600 mt-1 uppercase tracking-widest">{symbol}</p>
      </div>
    );
  }

  const mc = unifiedData;
  const alphaData = unifiedData.score ? { score: unifiedData.score, factors: unifiedData.factors } : null;
  const mcScreeners = unifiedData.screeners?.moneycontrol || [];
  const tlScreeners = unifiedData.screeners?.trendlyne || [];
  const allScreeners = [...mcScreeners, ...tlScreeners];

  const hasAnyData = mc.technical || mc.equityCash || mc.stockPrice || mc.swot || mc.essentials || mc.mcInsights;
  if (!hasAnyData) {
    const stockName = stockData.find(s => s.symbol.toUpperCase() === symbol.toUpperCase())?.name || symbol;
    return (
      <div ref={containerRef} className="p-8 text-center bg-slate-900/30 border border-slate-800 rounded-2xl">
        <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
        <p className="text-sm text-slate-400 font-bold">No MoneyControl data available for {stockName}</p>
        <p className="text-[10px] text-slate-600 mt-1 uppercase tracking-widest">{symbol} — not mapped to a MoneyControl ID</p>
      </div>
    );
  }

  const tech = mc.technical;
  const techD = tech; // Use the primary timeframe tech for divergence (Daily by default)
  const eq = mc.equityCash;
  const sp = mc.stockPrice;
  const swot = mc.swot;
  const essentials = mc.essentials;
  const classification = mc.mcInsights?.classification;
  const detailedInsights = mc.detailedInsights;
  const pv = mc.priceVolume;
  const ar = mc.analystRating;
  const ef = mc.earningsForecast;
  const pf = mc.priceForecast;
  const consensus = mc.consensus;
  const hm = mc.hitsMisses;
  const fov = mc.financialOverview;
  const valuation = mc.valuation;
  const historicalRating = mc.historicalRating;
  const technicalV2 = mc.technicalV2;
  const technicalRating = mc.technicalRating;

  const currentPrice = eq?.pricecurrent || sp?.lastPrice || tech?.close?.toString() || '—';
  const changePct = eq?.pricepercentchange || sp?.perChange || '—';

  return (
    <div ref={containerRef} className="space-y-6">
      {/* Header with Dual Scoring */}
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 pr-4 border-r border-slate-800">
            <Zap className="w-4 h-4 text-blue-500" />
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">AlphaQuant V2</span>
            {alphaData && (
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-[9px] font-black px-2 py-0.5 rounded uppercase",
                  alphaData.score.score >= 70 ? "bg-blue-500/20 text-blue-400" :
                  alphaData.score.score >= 50 ? "bg-slate-800 text-slate-400" :
                  "bg-rose-500/10 text-rose-500"
                )}>
                  Rank: #{alphaData.score.score.toFixed(1)}
                </span>
                <span className="text-[8px] font-black text-blue-500/60 uppercase">{alphaData.score.classification}</span>
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            <BrainCircuit className="w-4 h-4 text-emerald-500" />
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">MoneyControl</span>
            {classification && (
              <span className={cn(
                "text-[9px] font-black px-2 py-0.5 rounded uppercase",
                classification.stockScore >= 70 ? "bg-emerald-500/10 text-emerald-500" :
                classification.stockScore >= 50 ? "bg-amber-500/10 text-amber-500" :
                "bg-rose-500/10 text-rose-500"
              )}>
                Score: {classification.stockScore}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1 bg-slate-900 rounded-lg p-0.5 border border-slate-800">
          {(['D', 'W', 'M'] as Timeframe[]).map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={cn(
                "px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-widest transition-all",
                timeframe === tf ? "bg-blue-600 text-white shadow-lg" : "text-slate-500 hover:text-white"
              )}
            >
              {tf === 'D' ? 'Daily' : tf === 'W' ? 'Weekly' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>

      {/* AlphaQuant Factor Breakdown */}
      {alphaData && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: 'Technical', value: alphaData.factors.technical, color: 'text-blue-400', icon: Activity },
            { label: 'Fundamental', value: alphaData.factors.fundamental, color: 'text-emerald-400', icon: PieChart },
            { label: 'Momentum', value: alphaData.factors.momentum, color: 'text-purple-400', icon: Zap },
            { label: 'Valuation', value: alphaData.factors.valuation, color: 'text-amber-400', icon: BarChart3 },
            { label: 'Delivery', value: alphaData.factors.delivery, color: 'text-rose-400', icon: Users },
          ].map((factor) => (
            <div key={factor.label} className="bg-slate-950 p-3 rounded-2xl border border-slate-800/50 flex flex-col items-center justify-center text-center group hover:border-slate-700 transition-all">
              <factor.icon className={cn("w-4 h-4 mb-2 opacity-40 group-hover:opacity-100 transition-opacity", factor.color)} />
              <p className="text-[8px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">{factor.label}</p>
              <div className="flex items-center gap-2">
                <span className={cn("text-lg font-black italic", factor.color)}>{factor.value.toFixed(1)}</span>
              </div>
              <div className="w-full h-1 bg-slate-900 rounded-full mt-2 overflow-hidden">
                <div 
                  className={cn("h-full rounded-full transition-all duration-1000", factor.color.replace('text-', 'bg-'))} 
                  style={{ width: `${Math.min(100, factor.value * 10)}%` }} 
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Multi-Timeframe Divergence Panel */}
      {(techD || techW || techM) && (
        <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
            <Activity className="w-3 h-3" /> Multi-Timeframe Signal
          </p>
          <div className="grid grid-cols-3 gap-3">
            {([
              { label: 'Daily', tech: techD },
              { label: 'Weekly', tech: techW },
              { label: 'Monthly', tech: techM },
            ] as const).map(({ label, tech }) => {
              const indication = (tech as any)?.sentiments?.indication || '';
              const bullish = (tech as any)?.sentiments?.totalBullish ?? 0;
              const bearish = (tech as any)?.sentiments?.totalBearish ?? 0;
              const isBull = indication.toLowerCase().includes('bullish');
              const isBear = indication.toLowerCase().includes('bearish');
              return (
                <div key={label} className={cn(
                  "p-3 rounded-xl border text-center",
                  isBull ? "bg-emerald-500/5 border-emerald-500/20" :
                  isBear ? "bg-rose-500/5 border-rose-500/20" : "bg-slate-900 border-slate-800"
                )}>
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</p>
                  {indication ? (
                    <>
                      <p className={cn(
                        "text-[10px] font-black uppercase leading-tight",
                        isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-400"
                      )}>{indication}</p>
                      <div className="flex justify-center gap-2 mt-1.5 text-[8px] font-black">
                        <span className="text-emerald-500">{bullish}B</span>
                        <span className="text-slate-700">/</span>
                        <span className="text-rose-500">{bearish}Be</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-[9px] text-slate-700 italic">Loading…</p>
                  )}
                </div>
              );
            })}
          </div>
          {/* Highlight divergence */}
          {techD && techW && techM && (() => {
            const sD = ((techD as any)?.sentiments?.indication || '').toLowerCase();
            const sW = ((techW as any)?.sentiments?.indication || '').toLowerCase();
            const sM = ((techM as any)?.sentiments?.indication || '').toLowerCase();
            const allSame = sD === sW && sW === sM;
            if (allSame || !sD || !sW || !sM) return null;
            const mBull = sM.includes('bullish'), dBear = sD.includes('bearish');
            return (
              <div className={cn(
                "mt-3 px-3 py-2 rounded-lg text-[9px] font-bold italic",
                mBull && dBear ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
              )}>
                {mBull && dBear
                  ? "⚡ Divergence: Long-term bullish trend with short-term pullback — potential entry zone"
                  : "⚠ Timeframe divergence detected — signals not aligned across D/W/M"}
              </div>
            );
          })()}
        </div>
      )}

      {/* Integrated Screeners Section */}
      {allScreeners && allScreeners.length > 0 && (
        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">
              AlphaQuant Signals ({allScreeners.length})
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {allScreeners.map((screener) => {
              const isBullish = screener.sentiment === 'bullish';
              const isBearish = screener.sentiment === 'bearish';

              return (
                <div
                  key={`${screener.id}-${screener.name}`}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-tight border flex items-center gap-1.5",
                    isBullish
                      ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
                      : isBearish
                      ? "bg-rose-500/15 border-rose-500/30 text-rose-400"
                      : "bg-slate-700/50 border-slate-600/30 text-slate-300"
                  )}
                  title={screener.name}
                >
                  {isBullish ? (
                    <TrendingUp className="w-3 h-3" />
                  ) : isBearish ? (
                    <TrendingDown className="w-3 h-3" />
                  ) : (
                    <Filter className="w-3 h-3" />
                  )}
                  <span className="truncate max-w-xs">{screener.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}


      {/* Price & Key Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <ValueDisplay label="Price" value={`₹${currentPrice}`} sub={changePct ? `${parseFloat(String(changePct)) >= 0 ? '+' : ''}${changePct}%` : undefined}
          color={parseFloat(String(changePct || 0)) >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
        <ValueDisplay label="P/E" value={eq?.PE || sp?.scTtm || essentials?.pe || '—'} sub={`Sector: ${essentials?.sectorPe || eq?.IND_PE || '—'}`} />
        <ValueDisplay label="P/B" value={eq?.PB || essentials?.pb || sp?.priceBook || '—'} />
        <ValueDisplay label="Market Cap" value={essentials?.marketCap || eq?.MKTCAP ? `₹${String(eq?.MKTCAP || essentials?.marketCap || '0').replace(/[^\d.]/g, '')}Cr` : '—'} />
        <ValueDisplay label="Div Yield" value={essentials?.dividendYield ? `${essentials.dividendYield}%` : eq?.DY ? `${eq.DY}%` : '—'} />
        <ValueDisplay label="Face Value" value={essentials?.faceValue || eq?.FV || '—'} />
      </div>

      {/* Classification Summary */}
      {(!section || section === 'all' || section === 'insights') && classification && classification.longDesc && (
        <div className={cn(
          "p-4 rounded-2xl border relative overflow-hidden",
          classification.color === "green" || classification.stockScore >= 70 ? "bg-emerald-500/5 border-emerald-500/20" :
          classification.stockScore >= 50 ? "bg-amber-500/5 border-amber-500/20" :
          "bg-rose-500/5 border-rose-500/20"
        )}>
          <div className="absolute top-0 right-0 p-6 opacity-5">
            <BrainCircuit className="w-20 h-20" />
          </div>
          <div className="relative z-10">
            <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-1 flex items-center gap-2">
              <CheckCircle2 className="w-3 h-3" />
              MC Classification
            </p>
            <p className="text-sm text-slate-300 font-medium italic leading-relaxed">{classification.longDesc}</p>
            <div className="flex items-center gap-3 mt-3">
              <span className="text-[9px] font-black text-slate-500 uppercase">Overall Score</span>
              <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden max-w-xs">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${classification.stockScore}%` }}
                  className={cn("h-full rounded-full", classification.stockScore >= 70 ? "bg-emerald-500" : classification.stockScore >= 50 ? "bg-amber-500" : "bg-rose-500")}
                />
              </div>
              <span className={cn(
                "text-[10px] font-black",
                classification.stockScore >= 70 ? "text-emerald-400" : classification.stockScore >= 50 ? "text-amber-400" : "text-rose-400"
              )}>{classification.stockScore}/100</span>
            </div>
          </div>
        </div>
      )}

      {/* Financial Overview */}
      {fov && (
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl text-center">
            <p className="text-[8px] font-black text-blue-500 uppercase tracking-widest">TTM EPS</p>
            <p className="text-xs font-black text-white italic">{fov.ttmEpsText}</p>
          </div>
          <div className="p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl text-center">
            <p className="text-[8px] font-black text-amber-500 uppercase tracking-widest">TTM PE</p>
            <p className="text-xs font-black text-white italic">{fov.ttmPeText}</p>
          </div>
          <div className="p-3 bg-purple-500/5 border border-purple-500/20 rounded-xl text-center">
            <p className="text-[8px] font-black text-purple-500 uppercase tracking-widest">P/B</p>
            <p className="text-xs font-black text-white italic">{fov.pbText}</p>
          </div>
        </div>
      )}

      {/* MC Essentials Investment Checklist */}
      {essentials?.checklist && (
        <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">MC Investment Checklist</span>
            </div>
            {essentials.passText && (
              <div className="flex items-center gap-3">
                <span className="text-[9px] font-black text-emerald-400">{essentials.passYes} Yes</span>
                <span className="text-[9px] font-black text-rose-400">{essentials.passNo} No</span>
                <span className={cn(
                  "text-[9px] font-black px-2 py-0.5 rounded uppercase",
                  (essentials.passPercent ?? 0) >= 70 ? "bg-emerald-500/10 text-emerald-400" :
                  (essentials.passPercent ?? 0) >= 50 ? "bg-amber-500/10 text-amber-400" : "bg-rose-500/10 text-rose-400"
                )}>{essentials.passText}</span>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {([
              { key: 'financials', label: 'Financials', color: 'text-blue-400' },
              { key: 'industry', label: 'Industry', color: 'text-purple-400' },
              { key: 'ownership', label: 'Ownership', color: 'text-amber-400' },
              { key: 'others', label: 'Others', color: 'text-slate-400' },
            ] as const).map(({ key, label, color }) => {
              const items = essentials.checklist![key];
              if (!items?.length) return null;
              return (
                <div key={key}>
                  <p className={cn("text-[9px] font-black uppercase tracking-widest mb-2", color)}>{label}</p>
                  <div className="space-y-1.5">
                    {items.map((item, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 bg-slate-900/60 rounded-lg">
                        <span className={cn(
                          "text-[9px] font-black mt-0.5 shrink-0 w-3",
                          item.answer ? "text-emerald-400" : "text-rose-400"
                        )}>{item.answer ? "✓" : "✗"}</span>
                        <span className="text-[10px] text-slate-400 font-medium leading-tight">{item.question}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Detailed Insights - Price + Financials + Shareholding */}
      {detailedInsights && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="Price Insights" icon={TrendingUp}>
            <div className="space-y-3 pt-2">
              {detailedInsights.price?.map((p, i) => (
                <div key={i} className="flex items-start gap-2 p-2.5 bg-slate-950 rounded-xl border border-slate-800/50">
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full mt-1.5 shrink-0",
                    p.color === 'positive' ? 'bg-emerald-500' : p.color === 'negative' ? 'bg-rose-500' : 'bg-slate-500'
                  )} />
                  <div className="flex-1">
                    <p className="text-[11px] text-slate-300 font-medium leading-relaxed">{p.shortDesc}</p>
                    {p.linktext && (
                      <a href={p.linkurl} target="_blank" rel="noopener noreferrer" className="text-[9px] font-black text-blue-500 hover:text-blue-400 uppercase tracking-widest mt-1 inline-block">
                        {p.linktext} →
                      </a>
                    )}
                  </div>
                </div>
              ))}
              {detailedInsights.financials?.cagr && (
                <div className="mt-3 p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">CAGR Growth</p>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[8px] font-black text-emerald-500 uppercase">Revenue</p>
                      <p className="text-xs font-black text-white">{detailedInsights.financials.cagr.Revenue}%</p>
                    </div>
                    <div>
                      <p className="text-[8px] font-black text-blue-500 uppercase">Net Profit</p>
                      <p className="text-xs font-black text-white">{detailedInsights.financials.cagr.NetProfit}%</p>
                    </div>
                    <div>
                      <p className="text-[8px] font-black text-amber-500 uppercase">Op Profit</p>
                      <p className="text-xs font-black text-white">{detailedInsights.financials.cagr.OperatingProfit}%</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Card title="Shareholding & Sector Compare" icon={PieChart}>
            <div className="space-y-3 pt-2">
              {detailedInsights.shareholding?.map((sh, i) => (
                <div key={i} className="flex justify-between items-center p-2 bg-slate-950 rounded-lg border border-slate-800/50">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{sh.shorttext}</span>
                  <span className={cn(
                    "text-[9px] font-black text-right max-w-[60%]",
                    sh.color === 'positive' ? "text-emerald-400" : sh.color === 'negative' ? "text-rose-400" : "text-slate-300"
                  )}>{sh.longtext}</span>
                </div>
              ))}
              {detailedInsights.industryComparison && (
                <>
                  <div className="h-px bg-slate-800 my-2" />
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">Industry Comparison</p>
                  {detailedInsights.industryComparison.slice(0, 5).map((ic, i) => (
                    <div key={i} className="flex justify-between items-center p-2 bg-slate-950 rounded-lg border border-slate-800/50">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest truncate mr-2">{ic.title}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] font-bold text-white tabular-nums">{ic.value?.toLocaleString()}</span>
                        <span className={cn(
                          "text-[8px] font-black px-1.5 py-0.5 rounded",
                          ic.color === 'positive' ? "bg-emerald-500/10 text-emerald-500" : ic.color === 'negative' ? "bg-rose-500/10 text-rose-500" : "bg-slate-800 text-slate-400"
                        )}>{ic.shortDesc}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Technical Analysis Section */}
      {tech && (
        <Card title={`Technical Analysis (${timeframe === 'D' ? 'Daily' : timeframe === 'W' ? 'Weekly' : 'Monthly'})`} icon={Activity}>
          <div className="space-y-6">
            {/* Sentiment Summary */}
            {tech.sentiments && (
              <div className="grid grid-cols-4 gap-3">
                <div className="col-span-4 p-4 bg-slate-950 rounded-2xl border border-slate-800">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Overall Sentiment</span>
                    <SentimentBadge sentiment={tech.sentiments.indication} />
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-emerald-400 text-xl font-black">{tech.sentiments.totalBullish}</p>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mt-1">Bullish</p>
                    </div>
                    <div>
                      <p className="text-slate-400 text-xl font-black">{tech.sentiments.totalNeutral}</p>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mt-1">Neutral</p>
                    </div>
                    <div>
                      <p className="text-rose-400 text-xl font-black">{tech.sentiments.totalBearish}</p>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mt-1">Bearish</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    {[
                      { label: 'MA', bullish: tech.sentiments.movingAverageSentiment?.bullishCount ?? 0, bearish: tech.sentiments.movingAverageSentiment?.bearishCount ?? 0 },
                      { label: 'Cross', bullish: tech.sentiments.movingAverageCrossOverSentiment?.bullishCount ?? 0, bearish: tech.sentiments.movingAverageCrossOverSentiment?.bearishCount ?? 0 },
                      { label: 'Indicators', bullish: tech.sentiments.indicatorsSentiment?.bullishCount ?? 0, bearish: tech.sentiments.indicatorsSentiment?.bearishCount ?? 0 },
                    ].map(s => (
                      <div key={s.label} className="flex-1 p-2 bg-slate-900 rounded-lg text-center">
                        <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest mb-1">{s.label}</p>
                        <div className="flex justify-center gap-2 text-[10px] font-black">
                          <span className="text-emerald-400">{s.bullish}B</span>
                          <span className="text-slate-600">/</span>
                          <span className="text-rose-400">{s.bearish}B</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Indicators */}
            <div>
              <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Momentum Indicators</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {tech.indicators?.map((ind: any) => (
                  <IndicatorRow key={ind.id} name={ind.displayName} value={ind.value} sentiment={ind.indication} />
                ))}
              </div>
            </div>

            {/* Crossover Signals */}
            {tech.crossover && tech.crossover.length > 0 && (
              <div>
                <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Moving Average Crossovers</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {tech.crossover.map((cross: any) => (
                    <div key={cross.key} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{cross.period}</span>
                        <SentimentBadge sentiment={cross.indication} />
                      </div>
                      <p className="text-[11px] text-slate-300 font-bold">{cross.displayValue}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Pivot Levels */}
      {tech?.pivotLevels && tech.pivotLevels.length > 0 && (
        <Card title="Pivot Levels" icon={Filter}>
          <div className="space-y-4 pt-2">
            {tech.pivotLevels.map((pg: any) => (
              <div key={pg.key} className="p-4 bg-slate-950 rounded-2xl border border-slate-800/50">
                <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-3">{pg.key}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="p-2 bg-slate-900 rounded-lg text-center border border-emerald-500/20">
                    <p className="text-[8px] font-black text-emerald-500 uppercase tracking-widest">R2</p>
                    <p className="text-xs font-black text-white">₹{pg.pivotLevel.r2}</p>
                  </div>
                  <div className="p-2 bg-slate-900 rounded-lg text-center border border-emerald-500/10">
                    <p className="text-[8px] font-black text-emerald-400 uppercase tracking-widest">R1</p>
                    <p className="text-xs font-black text-white">₹{pg.pivotLevel.r1}</p>
                  </div>
                  <div className="p-2 bg-slate-900 rounded-lg text-center border border-blue-500/30 ring-1 ring-blue-500/20">
                    <p className="text-[8px] font-black text-blue-500 uppercase tracking-widest">Pivot</p>
                    <p className="text-xs font-black text-white">₹{pg.pivotLevel.pivotPoint}</p>
                  </div>
                  <div className="p-2 bg-slate-900 rounded-lg text-center border border-rose-500/10">
                    <p className="text-[8px] font-black text-rose-400 uppercase tracking-widest">S1</p>
                    <p className="text-xs font-black text-white">₹{pg.pivotLevel.s1}</p>
                  </div>
                  <div className="p-2 bg-slate-900 rounded-lg text-center border border-rose-500/20">
                    <p className="text-[8px] font-black text-rose-500 uppercase tracking-widest">S2</p>
                    <p className="text-xs font-black text-white">₹{pg.pivotLevel.s2}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Moving Averages */}
      {(!section || section === 'all' || section === 'technical') && tech && (tech.sma?.length > 0 || tech.ema?.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="SMA Levels" icon={TrendingUp}>
            <div className="grid grid-cols-2 gap-2 pt-2">
              {tech.sma?.map((ma: any) => (
                <div key={ma.key} className="flex justify-between items-center p-2.5 bg-slate-950 rounded-xl border border-slate-800/50">
                  <span className="text-[10px] font-black text-slate-500 uppercase">SMA {ma.key}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white tabular-nums">₹{ma.value}</span>
                    <SentimentBadge sentiment={ma.indication} />
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card title="EMA Levels" icon={Activity}>
            <div className="grid grid-cols-2 gap-2 pt-2">
              {tech.ema?.map((ma: any) => (
                <div key={ma.key} className="flex justify-between items-center p-2.5 bg-slate-950 rounded-xl border border-slate-800/50">
                  <span className="text-[10px] font-black text-slate-500 uppercase">EMA {ma.key}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white tabular-nums">₹{ma.value}</span>
                    <SentimentBadge sentiment={ma.indication} />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* SWOT Analysis */}
      {swot && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card title="Strengths & Opportunities" icon={TrendingUp}>
            <div className="space-y-4 pt-2">
              {swot.strengths.length > 0 && (
                <div>
                  <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Strengths ({swot.strengths.length})
                  </p>
                  <div className="space-y-1.5">
                    {swot.strengths.map((s, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 bg-emerald-500/5 rounded-xl border border-emerald-500/10">
                        <span className="text-[9px] text-emerald-400 font-black mt-0.5 shrink-0">✓</span>
                        <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{s}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {swot.opportunities.length > 0 && (
                <div>
                  <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                    <Zap className="w-3 h-3" /> Opportunities ({swot.opportunities.length})
                  </p>
                  <div className="space-y-1.5">
                    {swot.opportunities.map((o, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 bg-blue-500/5 rounded-xl border border-blue-500/10">
                        <Zap className="w-3 h-3 text-blue-500 mt-0.5 shrink-0" />
                        <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{o}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
          <Card title="Weaknesses & Threats" icon={TrendingDown}>
            <div className="space-y-4 pt-2">
              {swot.weaknesses.length > 0 && (
                <div>
                  <p className="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> Weaknesses ({swot.weaknesses.length})
                  </p>
                  <div className="space-y-1.5">
                    {swot.weaknesses.map((w, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 bg-rose-500/5 rounded-xl border border-rose-500/10">
                        <AlertCircle className="w-3 h-3 text-rose-500 mt-0.5 shrink-0" />
                        <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{w}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {swot.threats.length > 0 && (
                <div>
                  <p className="text-[10px] font-black text-amber-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                    <Info className="w-3 h-3" /> Threats ({swot.threats.length})
                  </p>
                  <div className="space-y-1.5">
                    {swot.threats.map((t, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 bg-amber-500/5 rounded-xl border border-amber-500/10">
                        <Info className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                        <span className="text-[11px] text-slate-300 font-medium leading-relaxed">{t}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Price Volume */}
      {pv && (
        <Card title="Price & Volume Performance" icon={BarChart3}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
            <div>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Price Returns</p>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(pv.price || {}).map(([period, val]) => (
                  <div key={period} className="p-2.5 bg-slate-950 rounded-xl border border-slate-800/50 text-center">
                    <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">{period}</p>
                    <p className={cn("text-xs font-black italic", val >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {val >= 0 ? '+' : ''}{val}%
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Volume Profile & Delivery</p>
              <div className="space-y-3">
                {Object.entries(pv.volume || {}).map(([period, v]) => {
                  const deliveryPctMatch = v.delivery_display_text?.match(/\(([\d.]+)%\)/);
                  const deliveryPct = deliveryPctMatch ? parseFloat(deliveryPctMatch[1]) : 0;
                  
                  return (
                    <div key={period} className="p-3 bg-slate-950 rounded-xl border border-slate-800/50 group hover:border-slate-700 transition-all">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{period}</span>
                        <div className="flex flex-col items-end">
                          <span className="text-[11px] font-black text-white italic">{v.cvol_display_text}</span>
                          <span className="text-[8px] font-bold text-slate-500 uppercase tracking-tighter">Total Traded</span>
                        </div>
                      </div>
                      
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center text-[9px]">
                          <span className="text-slate-500 font-bold uppercase">Delivery Volume</span>
                          <span className={cn(
                            "font-black italic",
                            deliveryPct >= 50 ? "text-emerald-400" : 
                            deliveryPct >= 30 ? "text-blue-400" : "text-amber-400"
                          )}>
                            {v.delivery_display_text.split('(')[0].trim()} ({deliveryPct}%)
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden flex">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${deliveryPct}%` }}
                            className={cn(
                              "h-full rounded-full transition-all duration-1000",
                              deliveryPct >= 50 ? "bg-emerald-500" : 
                              deliveryPct >= 30 ? "bg-blue-500" : "bg-amber-500"
                            )}
                          />
                        </div>
                      </div>
                      
                      {(v.cvol_tooltip_text || v.delivery_tooltip_text) && (
                        <div className="mt-2 pt-2 border-t border-slate-900/50 flex gap-2 overflow-hidden">
                           <Info className="w-3 h-3 text-slate-700 shrink-0" />
                           <p className="text-[8px] text-slate-600 font-medium truncate italic">
                             {v.cvol_tooltip_text || v.delivery_tooltip_text}
                           </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Analyst Ratings */}
      {ar && (
        <Card title="Analyst Consensus" icon={Users}>
          <div className="space-y-4 pt-2">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Consensus</span>
              <SentimentBadge sentiment={ar.finalRating} />
            </div>
            <div className="flex items-center gap-2">
              {ar.ratings?.map((r, i) => {
                const val = parseInt(r.value);
                const isBuy = r.name === 'Buy' || r.name === 'Outperform';
                const isSell = r.name === 'Sell' || r.name === 'Underperform';
                return (
                  <div key={i} className="flex-1 text-center p-2 bg-slate-950 rounded-xl border border-slate-800/50">
                    <p className={cn("text-[8px] font-black uppercase tracking-widest", isBuy ? "text-emerald-500" : isSell ? "text-rose-500" : "text-amber-500")}>
                      {r.name}
                    </p>
                    <p className="text-xs font-black text-white mt-0.5">{val}%</p>
                  </div>
                );
              })}
            </div>
            {ar.analystCount && (
              <p className="text-[9px] text-slate-600 italic text-center font-bold uppercase tracking-widest">
                Based on {ar.analystCount} analysts
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Earnings Forecast */}
      {(!section || section === 'all' || section === 'fundamental') && ef && ef.eps && ef.eps.length > 0 && (
        <Card title="Earnings Forecast (EPS)" icon={Activity}>
          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                  <th className="pb-2 pr-3">Period</th>
                  <th className="pb-2 pr-3 text-right">High</th>
                  <th className="pb-2 pr-3 text-right">Avg</th>
                  <th className="pb-2 pr-3 text-right">Low</th>
                  <th className="pb-2 text-right">Actual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {ef.eps.map((row, i) => (
                  <tr key={i} className="text-[11px] font-bold">
                    <td className="py-2 pr-3 text-slate-300">{row.date}</td>
                    <td className="py-2 pr-3 text-right text-slate-300">{row.high || '—'}</td>
                    <td className="py-2 pr-3 text-right text-white">{row.avg || '—'}</td>
                    <td className="py-2 pr-3 text-right text-slate-300">{row.low || '—'}</td>
                    <td className={cn("py-2 text-right", row.actual ? "text-emerald-400" : "text-slate-600")}>{row.actual || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Net Profit Forecast */}
      {ef && ef.netProfit && ef.netProfit.length > 0 && (
        <Card title="Net Profit Forecast (Cr)" icon={BarChart3}>
          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                  <th className="pb-2 pr-3">Period</th>
                  <th className="pb-2 pr-3 text-right">High</th>
                  <th className="pb-2 pr-3 text-right">Avg</th>
                  <th className="pb-2 pr-3 text-right">Low</th>
                  <th className="pb-2 text-right">Actual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {ef.netProfit.map((row, i) => (
                  <tr key={i} className="text-[11px] font-bold">
                    <td className="py-2 pr-3 text-slate-300">{row.date}</td>
                    <td className="py-2 pr-3 text-right text-slate-300">{row.high ? `₹${row.high}` : '—'}</td>
                    <td className="py-2 pr-3 text-right text-white">{row.avg ? `₹${row.avg}` : '—'}</td>
                    <td className="py-2 pr-3 text-right text-slate-300">{row.low ? `₹${row.low}` : '—'}</td>
                    <td className={cn("py-2 text-right", row.actual ? "text-emerald-400" : "text-slate-600")}>{row.actual || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Price Forecast */}
      {pf && (
        <Card title="Price Forecast (Analyst Targets)" icon={TrendingUp}>
          <div className="grid grid-cols-3 gap-4 pt-2">
            <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl text-center">
              <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">High</p>
              <p className="text-xl font-black text-white italic">₹{pf.high}</p>
            </div>
            <div className="p-4 bg-blue-500/5 border border-blue-500/20 rounded-2xl text-center">
              <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest">Mean</p>
              <p className="text-xl font-black text-white italic">₹{pf.mean}</p>
            </div>
            <div className="p-4 bg-rose-500/5 border border-rose-500/20 rounded-2xl text-center">
              <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest">Low</p>
              <p className="text-xl font-black text-white italic">₹{pf.low}</p>
            </div>
          </div>
          {pf.graphData && pf.graphData.length > 0 && (
            <p className="text-[9px] text-slate-600 italic text-center mt-3 font-bold uppercase tracking-widest">
              Forecast data points: {pf.graphData.length}
            </p>
          )}
        </Card>
      )}

      {/* Consensus */}
      {(!section || section === 'all' || section === 'insights') && consensus && (
        <Card title="Analyst Consensus Trend" icon={Users}>
          <div className="space-y-3 pt-2">
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">Rating Distribution Over Time</p>
            <div className="flex flex-wrap gap-2">
              {consensus.categories?.map((cat, i) => (
                <span key={i} className="text-[9px] font-bold text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800">
                  {cat}
                </span>
              ))}
            </div>
            <div className="space-y-2">
              {consensus.graphData?.map((g, i) => {
                const latest = g.data[g.data.length - 1];
                const isPositive = g.name === 'Buy' || g.name === 'Outperform';
                const isNegative = g.name === 'Sell' || g.name === 'Underperform';
                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className={cn("text-[9px] font-black uppercase tracking-widest w-24 shrink-0", isPositive ? "text-emerald-500" : isNegative ? "text-rose-500" : "text-amber-500")}>
                      {g.name}
                    </span>
                    <div className="flex-1 h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${(latest / Math.max(...g.data)) * 100}%` }}
                        className={cn("h-full rounded-full", isPositive ? "bg-emerald-500" : isNegative ? "bg-rose-500" : "bg-amber-500")}
                      />
                    </div>
                    <span className="text-[10px] font-black text-white tabular-nums w-8 text-right">{latest}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* Hits & Misses */}
      {hm && hm.list && hm.list.length > 0 && (
        <Card title="Earnings Hits & Misses" icon={Activity}>
          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                  <th className="pb-2 pr-3">Quarter</th>
                  <th className="pb-2 pr-3 text-right">Actual</th>
                  <th className="pb-2 pr-3 text-right">Estimate</th>
                  <th className="pb-2 text-right">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {hm.list.map((row, i) => (
                  <tr key={i} className="text-[11px] font-bold">
                    <td className="py-2 pr-3 text-slate-300">{row.quarter}</td>
                    <td className="py-2 pr-3 text-right text-white">{row.actual || '—'}</td>
                    <td className="py-2 pr-3 text-right text-slate-300">{row.estimates || '—'}</td>
                    <td className="py-2 text-right">
                      <span className={cn(
                        "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-tighter",
                        row.type === 'positive' ? "bg-emerald-500/10 text-emerald-400" :
                        row.type === 'negative' ? "bg-rose-500/10 text-rose-400" :
                        "bg-slate-800 text-slate-400"
                      )}>{row.type}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Piotroski Score */}
      {detailedInsights?.financials?.piotroskiData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl text-center col-span-1">
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Piotroski Score</p>
            <p className={cn(
              "text-2xl font-black italic",
              parseInt(detailedInsights.financials.piotroskiData.score) >= 7 ? "text-emerald-400" :
              parseInt(detailedInsights.financials.piotroskiData.score) >= 5 ? "text-amber-400" : "text-rose-400"
            )}>{detailedInsights.financials.piotroskiData.score}/9</p>
            <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mt-1">{detailedInsights.financials.piotroskiData.shortDesc}</p>
          </div>
          <div className="md:col-span-2 p-4 bg-slate-950 border border-slate-800 rounded-2xl flex items-center">
            <p className="text-[10px] text-slate-400 italic font-medium">{detailedInsights.financials.piotroskiData.tooltip}</p>
          </div>
        </div>
      )}

      {/* Valuation Table — EPS, PE, BVPS, PB, Analyst Target by year */}
      {valuation?.list && valuation.list.length > 0 && (
        <Card title="Analyst Valuation Estimates" icon={BarChart3}>
          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[9px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-800">
                  <th className="pb-2 pr-3">Period</th>
                  <th className="pb-2 pr-3 text-right">EPS</th>
                  <th className="pb-2 pr-3 text-right">PE</th>
                  <th className="pb-2 pr-3 text-right">BVPS</th>
                  <th className="pb-2 pr-3 text-right">PB</th>
                  <th className="pb-2 text-right">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {valuation.list.map((row, i) => (
                  <tr key={i} className="text-[11px] font-bold hover:bg-slate-900/30 transition-colors">
                    <td className="py-2.5 pr-3 text-blue-400 font-black uppercase tracking-widest">{row.heading}</td>
                    <td className="py-2.5 pr-3 text-right text-white tabular-nums">{row.data?.eps || '—'}</td>
                    <td className="py-2.5 pr-3 text-right text-slate-300 tabular-nums">{row.data?.pe || '—'}</td>
                    <td className="py-2.5 pr-3 text-right text-slate-300 tabular-nums">{row.data?.bvps || '—'}</td>
                    <td className="py-2.5 pr-3 text-right text-slate-300 tabular-nums">{row.data?.pb || '—'}</td>
                    <td className="py-2.5 text-right">
                      {row.data?.analyst ? (
                        <span className="text-emerald-400 font-black">₹{row.data.analyst}</span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {valuation.displayLock === '1' && (
              <p className="text-[9px] text-amber-500/70 font-bold uppercase tracking-widest mt-3 text-center italic">
                Some data requires a MoneyControl Pro subscription
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Technical Rating Summary from V2 endpoint */}
      {(technicalRating || technicalV2) && (() => {
        const rating = technicalRating?.data || technicalRating;
        const v2 = technicalV2?.data || technicalV2;
        const ratingText = rating?.rating || v2?.sentiments?.indication || '';
        const buyCount = rating?.buyCount ?? rating?.buy ?? v2?.sentiments?.totalBullish ?? null;
        const sellCount = rating?.sellCount ?? rating?.sell ?? v2?.sentiments?.totalBearish ?? null;
        const holdCount = rating?.holdCount ?? rating?.hold ?? v2?.sentiments?.totalNeutral ?? null;
        if (!ratingText && buyCount === null) return null;
        const isBull = ratingText.toLowerCase().includes('bullish') || ratingText.toLowerCase().includes('buy');
        const isBear = ratingText.toLowerCase().includes('bearish') || ratingText.toLowerCase().includes('sell');
        return (
          <div className={cn(
            "p-4 rounded-2xl border flex items-center justify-between gap-4",
            isBull ? "bg-emerald-500/5 border-emerald-500/20" :
            isBear ? "bg-rose-500/5 border-rose-500/20" : "bg-slate-950 border-slate-800"
          )}>
            <div className="flex items-center gap-3">
              <Zap className={cn("w-5 h-5", isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-500")} />
              <div>
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">MC Technical Rating ({timeframe === 'D' ? 'Daily' : timeframe === 'W' ? 'Weekly' : 'Monthly'})</p>
                <p className={cn("text-sm font-black uppercase italic", isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-slate-300")}>
                  {ratingText || 'Neutral'}
                </p>
              </div>
            </div>
            {(buyCount !== null || sellCount !== null) && (
              <div className="flex gap-4 text-center">
                {buyCount !== null && (
                  <div>
                    <p className="text-[8px] font-black text-emerald-500 uppercase tracking-widest">Buy</p>
                    <p className="text-lg font-black text-emerald-400">{buyCount}</p>
                  </div>
                )}
                {holdCount !== null && (
                  <div>
                    <p className="text-[8px] font-black text-amber-500 uppercase tracking-widest">Hold</p>
                    <p className="text-lg font-black text-amber-400">{holdCount}</p>
                  </div>
                )}
                {sellCount !== null && (
                  <div>
                    <p className="text-[8px] font-black text-rose-500 uppercase tracking-widest">Sell</p>
                    <p className="text-lg font-black text-rose-400">{sellCount}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Historical Technical Rating — 6-month sentiment trend chart */}
      {historicalRating && (() => {
        // Normalise various possible response shapes from the widget API
        const raw: any[] =
          Array.isArray(historicalRating) ? historicalRating :
          Array.isArray(historicalRating?.data) ? historicalRating.data :
          Array.isArray(historicalRating?.data?.ratingData) ? historicalRating.data.ratingData :
          Array.isArray(historicalRating?.ratingData) ? historicalRating.ratingData : [];

        if (raw.length === 0) return null;

        const chartData = raw.map((d: any) => ({
          date: d.date || d.dt || '',
          bullish: d.bullish ?? d.bullishCount ?? d.buy ?? 0,
          bearish: d.bearish ?? d.bearishCount ?? d.sell ?? 0,
          neutral: d.neutral ?? d.neutralCount ?? d.hold ?? 0,
        })).filter((d: any) => d.date || d.bullish || d.bearish);

        if (chartData.length < 2) return null;

        return (
          <Card title="Historical Technical Rating — 6 Month Trend" icon={Activity}>
            <div className="h-44 mt-3">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 8, fill: '#475569' }}
                    tickFormatter={(v: string) => v?.slice(0, 6) || ''}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 8, fill: '#475569' }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '9px' }}
                    formatter={(v: any, n: string) => [v, n.charAt(0).toUpperCase() + n.slice(1)]}
                    labelFormatter={(l: string) => l}
                  />
                  <Legend wrapperStyle={{ fontSize: '9px', paddingTop: '8px' }} />
                  <Line type="monotone" dataKey="bullish" stroke="#10b981" strokeWidth={2} dot={false} name="bullish" />
                  <Line type="monotone" dataKey="neutral" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="neutral" />
                  <Line type="monotone" dataKey="bearish" stroke="#f43f5e" strokeWidth={2} dot={false} name="bearish" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[8px] text-center text-slate-700 font-bold uppercase tracking-widest mt-2">
              {chartData.length} data points • {timeframe === 'D' ? 'Daily' : timeframe === 'W' ? 'Weekly' : 'Monthly'} period
            </p>
          </Card>
        );
      })()}

      {/* Data source footer */}
      <div className="text-center pt-4 border-t border-slate-800">
        <p className="text-[8px] text-slate-700 font-bold uppercase tracking-widest">
          Data sourced from MoneyControl · Refreshes every 60s
        </p>
      </div>
    </div>
  );
};

export default MCStockInfoPanel;