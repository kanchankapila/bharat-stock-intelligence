
import React from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';

// --- Page Fallback ---
import { PageFallback } from '../components/PageFallback';
import { V1PageFrame } from '../components/v1/V1PageFrame';
import { Globe, Activity } from 'lucide-react';


// --- Lazy-loaded V1 page components ---
const TrendlyneScreenerPanel = React.lazy(() => import('../components/TrendlyneScreenerPanel'));
const PremiumScreenersPage  = React.lazy(() => import('../components/PremiumScreenersPage'));
const LiveMarketScreener      = React.lazy(() => import('../components/LiveMarketScreener').then(m => ({ default: m.LiveMarketScreener })));
const EODMarketScreener       = React.lazy(() => import('../components/EODMarketScreener').then(m => ({ default: m.EODMarketScreener })));
const NSEStockDiscovery       = React.lazy(() => import('../components/NSEStockDiscovery'));
const TopRatedStocks          = React.lazy(() => import('../components/TopRatedStocks'));
const FnOIntelligenceCenter   = React.lazy(() => import('../components/FnOIntelligenceCenter'));
const OptionsIntelligence     = React.lazy(() => import('../components/OptionsIntelligence'));
const PortfolioAnalytics      = React.lazy(() => import('../components/PortfolioAnalytics'));
const StrategyBuilder         = React.lazy(() => import('../components/StrategyBuilder'));
const ExportPortfolioView     = React.lazy(() => import('../components/ExportPortfolioView'));
const SystemMonitorPage       = React.lazy(() => import('../components/SystemMonitorPage'));
const ProfilePage             = React.lazy(() => import('../components/ProfilePage'));
const DashboardPage           = React.lazy(() => import('../components/DashboardPage'));
const SuperstarPortfolio      = React.lazy(() => import('../components/SuperstarPortfolio'));
const SmartMoneyPage          = React.lazy(() => import('../components/SmartMoneyPage'));
const EarningsPage            = React.lazy(() => import('../components/EarningsPage'));
const TradeDecisionCockpit    = React.lazy(() => import('../components/TradeDecisionCockpit'));
const HedgeFundResearch       = React.lazy(() => import('../components/HedgeFundResearch'));
const SignalIntelligence      = React.lazy(() => import('../components/SignalIntelligence'));
const SignalReportCard        = React.lazy(() => import('../components/SignalReportCard').then(m => ({ default: m.SignalReportCard })));
const DLDashboard             = React.lazy(() => import('../components/DLDashboard'));
const TodaysPicks             = React.lazy(() => import('../components/TodaysPicks').then(m => ({ default: m.TodaysPicks })));
const ScreenerIntelligencePage = React.lazy(() => import('../components/ScreenerIntelligencePage').then(m => ({ default: m.ScreenerIntelligencePage })));
const AgentDataScientistPage   = React.lazy(() => import('../components/AgentDataScientistPage').then(m => ({ default: m.AgentDataScientistPage })));
const AgentStrategistPage      = React.lazy(() => import('../components/AgentStrategistPage').then(m => ({ default: m.AgentStrategistPage })));
const AgentAuditorPage         = React.lazy(() => import('../components/AgentAuditorPage').then(m => ({ default: m.AgentAuditorPage })));
const AgentOptimizerPage       = React.lazy(() => import('../components/AgentOptimizerPage').then(m => ({ default: m.AgentOptimizerPage })));
const CommandCenterDashboard   = React.lazy(() => import('../components/CommandCenterDashboard').then(m => ({ default: m.CommandCenterDashboard })));
const ToDoPage           = React.lazy(() => import('../components/ToDoPage').then(m => ({ default: m.ToDoPage })));
const InvestmentStrategy = React.lazy(() => import('../components/InvestmentStrategy').then(m => ({ default: m.InvestmentStrategy })));
const IndicesPage        = React.lazy(() => import('../components/IndicesPage').then(m => ({ default: m.IndicesPage })));
const StrategyIntelligence = React.lazy(() => import('../components/StrategyIntelligence').then(m => ({ default: m.StrategyIntelligence })));
const HighConvictionPage = React.lazy(() => import('../components/HighConvictionPage').then(m => ({ default: m.HighConvictionPage })));
const EtCallsPage = React.lazy(() => import('../components/EtCallsPage').then(m => ({ default: m.EtCallsPage })));
const UltimateDecisionMatrix = React.lazy(() => import('../components/UltimateDecisionMatrix').then(m => ({ default: m.UltimateDecisionMatrix })));
const DailySignals       = React.lazy(() => import('../components/DailySignals').then(m => ({ default: m.DailySignals })));
const SentimentIntelligence = React.lazy(() => import('../components/SentimentIntelligence').then(m => ({ default: m.SentimentIntelligence })));
const SignalTracking     = React.lazy(() => import('../components/SignalTracking').then(m => ({ default: m.SignalTracking })));
const StockChatbot       = React.lazy(() => import('../components/StockChatbot'));
const JobsDashboardPage   = React.lazy(() => import('../components/JobsDashboardPage'));
const EarlyHoursSpotter   = React.lazy(() => import('../components/EarlyHoursSpotter'));
const IntradayPage       = React.lazy(() => import('../components/IntradayPage'));
const MoneyFlowPage      = React.lazy(() => import('../components/MoneyFlowPage').then(m => ({ default: m.MoneyFlowPage })));
const V1Backtest            = React.lazy(() => import('../components/V1Backtest').then(m => ({ default: m.V1Backtest })));
const V1Screener            = React.lazy(() => import('../components/V1Screener').then(m => ({ default: m.V1Screener })));
const V1StockDetails        = React.lazy(() => import('../components/V1StockDetails').then(m => ({ default: m.V1StockDetails })));

const Watchlist               = React.lazy(() => import('../components/Watchlist').then(m => ({ default: m.Watchlist })));
const PriceAlertsPanel        = React.lazy(() => import('../components/PriceAlertsPanel').then(m => ({ default: m.PriceAlertsPanel })));
const MarketCommandCenter = React.lazy(() => import('../components/v4/views/MarketCommandCenter').then(m => ({ default: m.MarketCommandCenter })));
const StockIntelligencePage = React.lazy(() => import('../components/v4/views/StockIntelligencePage').then(m => ({ default: m.StockIntelligencePage })));
const SectorPerformance = React.lazy(() => import('../components/SectorIntelligence').then(m => ({ default: m.SectorPerformance })));
const SectorHeatmap = React.lazy(() => import('../components/SectorIntelligence').then(m => ({ default: m.SectorHeatmap })));
const SectorAdvanceDecline = React.lazy(() => import('../components/SectorIntelligence').then(m => ({ default: m.SectorAdvanceDecline })));
const SectorConstituents = React.lazy(() => import('../components/SectorIntelligence').then(m => ({ default: m.SectorConstituents })));
const MacroDashboard = React.lazy(() => import('../components/MacroDashboard').then(m => ({ default: m.MacroDashboard })));
const CorporateEventsPanel = React.lazy(() => import('../components/CorporateEventsPanel').then(m => ({ default: m.CorporateEventsPanel })));
const Card = React.lazy(() => import('../components/Card').then(m => ({ default: m.Card })));
const EconomicCalendarWidget = React.lazy(() => import('../components/TradingViewWidgets').then(m => ({ default: m.EconomicCalendarWidget })));
const MarketOverviewWidget = React.lazy(() => import('../components/TradingViewWidgets').then(m => ({ default: m.MarketOverviewWidget })));

// v6-native (2 pages that were exclusive to V6Shell) and v5-desk retrofits (previously reachable
// only under dashboardVersion==='v6'/'v7'/'v8' -- see App.tsx) -- v1's own nav now links all 8.
const PreMarketBriefing        = React.lazy(() => import('../components/v4/components/PreMarketBriefing'));
const ScreenerBrowserPage      = React.lazy(() => import('../components/v6/pages/ScreenerBrowserPage'));
const PortfolioTrackerPage     = React.lazy(() => import('../components/v6/pages/PortfolioTrackerPage'));
const OptionsDeskPage          = React.lazy(() => import('../components/v5/pages/OptionsDeskPage').then(m => ({ default: m.OptionsDeskPage })));
const InstitutionalFlowDeskPage = React.lazy(() => import('../components/v5/pages/InstitutionalFlowDeskPage').then(m => ({ default: m.InstitutionalFlowDeskPage })));
const EarningsPulseDeskPage    = React.lazy(() => import('../components/v5/pages/EarningsPulseDeskPage').then(m => ({ default: m.EarningsPulseDeskPage })));
const RiskDeskPage             = React.lazy(() => import('../components/v5/pages/RiskDeskPage').then(m => ({ default: m.RiskDeskPage })));
const SignalReviewPage         = React.lazy(() => import('../components/v5/pages/SignalReviewPage').then(m => ({ default: m.SignalReviewPage })));
const V2Settings               = React.lazy(() => import('../components/v2/views/settings/V2Settings').then(m => ({ default: m.V2Settings })));


// This component will receive all the props App.tsx was passing down
const V1Routes = ({
    stocks,
    watchlist,
    watchlistDetails,
    onToggleWatchlist,
    onSelectStock,
    addToast,
    setSelectedIndex,
    selectedIndex,
    selectedSymbol,
    researchSubTab,
    setResearchSubTab,
    userId,
}) => {
    const location = useLocation();
    const navigate = useNavigate();
    const pathParts = location.pathname.split('/').filter(Boolean);
    const activeTab = pathParts[0] || 'dashboard';

    // The V1 shell has a different structure, so we need to handle the watchlist route separately
    // and then have a catch-all for the rest of the pages which are children of the AppShell.
    return (
        <Routes location={location} key={activeTab}>
            <Route path="/watchlist" element={
                <motion.div
                    key="watchlist"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                >
                    <React.Suspense fallback={<PageFallback />}>
                        <Watchlist
                            watchlist={watchlist}
                            stocks={stocks}
                            watchlistDetails={watchlistDetails || []}
                            onSelectStock={onSelectStock}
                            onRemove={onToggleWatchlist}
                            userId={userId}
                        />
                        <PriceAlertsPanel userId={userId} />
                    </React.Suspense>
                </motion.div>
            } />
            <Route path="/*" element={
                <motion.div
                    key={activeTab}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    className="pb-10"
                >
                    <React.Suspense fallback={<PageFallback />}>
                        <Routes>
                            <Route path="/" element={<DashboardPage stocks={stocks} onNewSignal={addToast} onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }} />} />
                            <Route path="/dashboard" element={<DashboardPage stocks={stocks} onNewSignal={addToast} onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }} />} />
                            <Route path="/market-command" element={
                                <V1PageFrame title="Market Command" kicker="LIVE MARKET INTELLIGENCE">
                                    <MarketCommandCenter
                                        onSelectStock={onSelectStock}
                                        onSelectIndex={(id, name) => { setSelectedIndex({ id, name }); navigate('/indices'); }}
                                    />
                                </V1PageFrame>
                            } />
                            <Route path="/stock-intelligence-hub" element={
                                <V1PageFrame title="Stock Intelligence" kicker="SYMBOL DEEP DIVE">
                                    <StockIntelligencePage
                                        initialSymbol={selectedSymbol}
                                        watchlist={watchlist}
                                        onToggleWatchlist={onToggleWatchlist}
                                    />
                                </V1PageFrame>
                            } />
                            <Route path="/decision-matrix" element={<UltimateDecisionMatrix onSelectStock={onSelectStock} onToggleWatchlist={onToggleWatchlist} watchlist={watchlist} />} />
                            <Route path="/alpha" element={<CommandCenterDashboard onSelectStock={(s) => { onSelectStock(s); navigate('/trade-cockpit'); }} />} />
                            <Route path="/buy-recs" element={<Navigate to="/alpha" replace />} />
                            <Route path="/money-flow" element={<MoneyFlowPage />} />
                            <Route path="/top-rated" element={<TopRatedStocks onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />} />
                            <Route path="/intraday" element={<IntradayPage onSelectStock={onSelectStock} />} />
                            <Route path="/premarket" element={
                                <V1PageFrame title="Pre-Market Briefing" kicker="BEFORE THE BELL">
                                    <PreMarketBriefing />
                                </V1PageFrame>
                            } />
                            <Route path="/indices" element={<IndicesPage onSelectStock={onSelectStock} selectedIndex={selectedIndex} setSelectedIndex={setSelectedIndex} />} />
                            <Route path="/market-map" element={
                                <V1PageFrame title="Market Map" kicker="SECTOR INTELLIGENCE">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <SectorPerformance />
                                        <SectorHeatmap />
                                    </div>
                                    <SectorAdvanceDecline />
                                    <SectorConstituents onSelectStock={onSelectStock} />
                                </V1PageFrame>
                            } />
                            <Route path="/screener" element={<V1Screener stocks={stocks} onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />} />
                            <Route path="/screener-browser" element={
                                <V1PageFrame title="Screener Browser" kicker="ALL SOURCES · ONE CATALOG">
                                    <ScreenerBrowserPage onSelectStock={onSelectStock} />
                                </V1PageFrame>
                            } />
                            <Route path="/trendlyne" element={<TrendlyneScreenerPanel onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />} />
                            <Route path="/premium-screeners" element={<PremiumScreenersPage onSelectStock={onSelectStock} />} />
                            <Route path="/live-screener" element={<LiveMarketScreener onSelectStock={onSelectStock} />} />
                            <Route path="/eod-screener" element={<EODMarketScreener onSelectStock={onSelectStock} />} />
                            <Route path="/discover" element={<NSEStockDiscovery onSelectStock={onSelectStock} />} />
                            <Route path="/smart-money" element={<SmartMoneyPage onSelectStock={onSelectStock} />} />
                            <Route path="/institutional-flow" element={
                                <V1PageFrame title="Institutional Flow" kicker="FII · DII · BLOCK DEALS">
                                    <InstitutionalFlowDeskPage />
                                </V1PageFrame>
                            } />
                            <Route path="/earnings" element={<EarningsPage onSelectStock={onSelectStock} />} />
                            <Route path="/earnings-desk" element={
                                <V1PageFrame title="Earnings Pulse" kicker="RESULTS · ESTIMATES · SURPRISES">
                                    <EarningsPulseDeskPage onSelectSymbol={onSelectStock} />
                                </V1PageFrame>
                            } />
                            <Route path="/fno-scanners" element={<FnOIntelligenceCenter onSelectStock={onSelectStock} />} />
                            <Route path="/options" element={<OptionsIntelligence />} />
                            <Route path="/options-desk" element={
                                <V1PageFrame title="Options Desk" kicker="DERIVATIVES INTELLIGENCE">
                                    <OptionsDeskPage onSelectSymbol={onSelectStock} />
                                </V1PageFrame>
                            } />
                            <Route path="/risk" element={
                                <V1PageFrame title="Risk Desk" kicker="PORTFOLIO RISK & REGIMES">
                                    <RiskDeskPage onSelectSymbol={onSelectStock} />
                                </V1PageFrame>
                            } />
                            <Route path="/todays-picks" element={<TodaysPicks onSelectStock={onSelectStock} />} />
                            <Route path="/et-calls" element={<EtCallsPage onSelectStock={onSelectStock} />} />
                            <Route path="/early-spotter" element={<EarlyHoursSpotter onSelectStock={onSelectStock} />} />
                            <Route path="/screener-intelligence" element={<ScreenerIntelligencePage />} />
                            <Route path="/agent-data-scientist" element={<AgentDataScientistPage />} />
                            <Route path="/agent-strategist" element={<AgentStrategistPage />} />
                            <Route path="/agent-auditor" element={<AgentAuditorPage />} />
                            <Route path="/agent-optimizer" element={<AgentOptimizerPage />} />
                            <Route path="/trade-cockpit" element={<TradeDecisionCockpit onSelectStock={onSelectStock} />} />
                            <Route path="/details" element={selectedSymbol ? (
                                <V1StockDetails
                                    key={selectedSymbol}
                                    symbol={selectedSymbol}
                                    stock={stocks.find(s => s.symbol === selectedSymbol)}
                                    onBack={() => navigate('/dashboard')}
                                    watchlist={watchlist}
                                    onToggleWatchlist={onToggleWatchlist}
                                    onSelectStock={onSelectStock}
                                />
                            ) : <div className="p-6">Select a stock to view details</div>} />
                            <Route path="/backtest" element={<V1Backtest stocks={stocks} />} />
                            <Route path="/signals" element={<DailySignals onSelectStock={onSelectStock} watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} />} />
                            <Route path="/signal-tracking" element={<SignalTracking />} />
                            <Route path="/signal-intelligence" element={<SignalIntelligence />} />
                            <Route path="/signal-report-card" element={<SignalReportCard />} />
                            <Route path="/signal-review" element={
                                <V1PageFrame title="Signal Review" kicker="OUTCOME POST-MORTEM">
                                    <SignalReviewPage onSelectSymbol={onSelectStock} />
                                </V1PageFrame>
                            } />
                            <Route path="/research" element={
                                <V1PageFrame title="Research" kicker="HEDGE FUND RESEARCH">
                                    <div className="flex gap-2 px-4 py-2 border-b border-slate-800">
                                        <button
                                            onClick={() => setResearchSubTab('overview')}
                                            className={`text-xs px-3 py-1 rounded-full transition-colors ${researchSubTab === 'overview' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}
                                        >Overview</button>
                                        <button
                                            onClick={() => setResearchSubTab('deep-learning')}
                                            className={`text-xs px-3 py-1 rounded-full transition-colors ${researchSubTab === 'deep-learning' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}
                                        >Deep Learning</button>
                                    </div>
                                    {researchSubTab === 'overview' ? <HedgeFundResearch onAddWatchlist={onToggleWatchlist} /> : <DLDashboard />}
                                </V1PageFrame>
                            } />
                            <Route path="/strategy" element={<StrategyIntelligence onSelectStock={onSelectStock} />} />
                            <Route path="/best-picks" element={<HighConvictionPage onSelectStock={onSelectStock} />} />
                            <Route path="/strategy-builder" element={<InvestmentStrategy onSelectStock={onSelectStock} />} />
                            <Route path="/sentiment" element={<SentimentIntelligence onSelectStock={onSelectStock} />} />
                            <Route path="/economics" element={
                                <V1PageFrame title="Economics & Macro" kicker="GLOBAL MACRO · EVENTS · SENTIMENT">
                                    <MacroDashboard />
                                    <CorporateEventsPanel onSelectStock={onSelectStock} />
                                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                                        <div className="lg:col-span-2">
                                            <Card title="Global Economic Calendar" icon={Globe}>
                                                <div className="pt-2"><EconomicCalendarWidget /></div>
                                            </Card>
                                        </div>
                                        <div>
                                            <Card title="Market Sentiment Overview" icon={Activity}>
                                                <div className="pt-2"><MarketOverviewWidget /></div>
                                            </Card>
                                        </div>
                                    </div>
                                </V1PageFrame>
                            } />
                            <Route path="/superstars" element={<SuperstarPortfolio />} />
                            <Route path="/todo" element={<ToDoPage />} />
                            <Route path="/monitor" element={<SystemMonitorPage />} />
                            <Route path="/jobs" element={<JobsDashboardPage />} />
                            <Route path="/profile" element={<ProfilePage />} />
                            <Route path="/portfolio" element={<V1PageFrame><PortfolioAnalytics /></V1PageFrame>} />
                            <Route path="/portfolio-tracker" element={<V1PageFrame title="Portfolio Tracker" kicker="POSITIONS · ENTRY · P&L"><PortfolioTrackerPage userId={userId} onSelectStock={onSelectStock} /></V1PageFrame>} />
                            <Route path="/builder" element={<V1PageFrame><StrategyBuilder /></V1PageFrame>} />
                            <Route path="/export-picks" element={<V1PageFrame><ExportPortfolioView /></V1PageFrame>} />
                            <Route path="/settings" element={
                                <V1PageFrame title="Settings" kicker="CONFIGURATION">
                                    <V2Settings />
                                </V1PageFrame>
                            } />
                            <Route path="/chat" element={
                                <V1PageFrame>
                                    <div className="p-4"><StockChatbot /></div>
                                </V1PageFrame>
                            } />
                            <Route path="/alpha-cockpit" element={<Navigate to="/alpha" replace />} />
                        </Routes>
                    </React.Suspense>
                </motion.div>
            } />
        </Routes>
    );
};

export default V1Routes;
