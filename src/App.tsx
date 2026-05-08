import React, { useState, useEffect } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  AreaChart, Area, BarChart, Bar, ReferenceLine, PieChart as RePieChart, Pie, Cell,
  ComposedChart, ReferenceArea
} from 'recharts';
import { 
  TrendingUp, TrendingDown, Search, BarChart3, PieChart, Info, 
  AlertCircle, ArrowUpRight, ArrowDownRight, Activity, Zap, 
  LayoutDashboard, Filter, History, User, LogIn, Plus, Heart, Share2, Download,
  ArrowLeft, Eye, ChevronUp, ChevronDown, Save, Bookmark, BrainCircuit, CheckCircle2,
  Users, Trophy, Bookmark as WatchlistIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { cn } from './lib/utils';
import { auth } from './lib/firebase';
import { 
  signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User as FirebaseUser 
} from 'firebase/auth';

import { useMarketData, getIndexData, MarketData } from './services/marketService';

import { trpc } from './lib/trpc';
import { useNewsFeed, NewsArticle } from './services/newsService';
import { detectCandlestickPatterns, Candlestick } from './lib/candlestickUtils';

// --- Types ---

interface Toast {
  id: string;
  title: string;
  message: string;
  type: 'BUY' | 'SELL';
  confidence: number;
}

interface IndexBarProps {
  name: string;
  value: number;
  change: number;
  isUp: boolean;
}

// --- Components ---

const IndexBar: React.FC<IndexBarProps> = ({ name, value, change, isUp }) => (
  <div className="flex items-center gap-3 px-4 py-2 border-r border-slate-800 last:border-0 min-w-fit">
    <span className="text-slate-400 font-medium text-xs tracking-wider uppercase">{name}</span>
    <span className="text-white font-bold tabular-nums">{value.toLocaleString()}</span>
    <div className={cn(
      "flex items-center text-xs font-semibold",
      isUp ? "text-emerald-400" : "text-rose-400"
    )}>
      {isUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {Math.abs(change).toFixed(2)}%
    </div>
  </div>
);

const Navbar: React.FC<{ 
  user: FirebaseUser | null; 
  onLogin: () => void; 
  activeTab: string; 
  setActiveTab: (tab: string) => void;
  stocks: MarketData[];
  onSelectStock: (symbol: string) => void;
}> = ({ user, onLogin, activeTab, setActiveTab, stocks, onSelectStock }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showResults, setShowResults] = useState(false);

  const searchResults = searchQuery.length > 0 
    ? stocks.filter(s => 
        s.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || 
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
      ).slice(0, 8)
    : [];

  return (
    <nav className="h-16 border-b border-slate-800 bg-slate-950 flex items-center justify-between px-6 sticky top-0 z-50">
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setActiveTab('dashboard')}>
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Zap className="text-white w-5 h-5 fill-white" />
          </div>
          <span className="text-xl font-black text-white tracking-tight">BHARAT<span className="text-blue-500">STOCK</span></span>
        </div>
        
        <div className="hidden md:flex items-center gap-6">
          {[
            { icon: LayoutDashboard, label: 'Dashboard', id: 'dashboard' },
            { icon: Activity, label: 'Market Map', id: 'market-map' },
            { icon: Filter, label: 'Screener', id: 'screener' },
            { icon: History, label: 'Backtest', id: 'backtest' },
            { icon: PieChart, label: 'Portfolio', id: 'portfolio' },
            { icon: WatchlistIcon, label: 'Watchlist', id: 'watchlist' },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={cn(
                "flex items-center gap-2 text-sm font-medium transition-colors",
                activeTab === item.id ? "text-blue-500" : "text-slate-400 hover:text-white"
              )}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative search-container">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input 
            type="text" 
            placeholder="Search symbols..." 
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setShowResults(true);
            }}
            onFocus={() => setShowResults(true)}
            className="bg-slate-900 border border-slate-800 rounded-full py-1.5 pl-10 pr-4 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500 w-48 lg:w-64"
          />
          
          <AnimatePresence>
            {showResults && searchResults.length > 0 && (
              <>
                <div 
                  className="fixed inset-0 z-[-1]" 
                  onClick={() => setShowResults(false)} 
                />
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute top-full mt-2 w-full bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl z-[60]"
                >
                  {searchResults.map(s => (
                    <button
                      key={s.symbol}
                      onClick={() => {
                        onSelectStock(s.symbol);
                        setSearchQuery('');
                        setShowResults(false);
                      }}
                      className="w-full px-4 py-3 hover:bg-slate-800 flex items-center justify-between transition-colors border-b border-slate-800/50 last:border-0"
                    >
                      <div className="text-left">
                        <div className="text-xs font-black text-white italic tracking-tighter uppercase">{s.symbol}</div>
                        <div className="text-[10px] text-slate-500 italic uppercase">{s.name}</div>
                      </div>
                      <div className={cn(
                        "text-[10px] font-black tabular-nums",
                        s.changePct >= 0 ? "text-emerald-400" : "text-rose-400"
                      )}>
                        {s.changePct > 0 ? '+' : ''}{s.changePct}%
                      </div>
                    </button>
                  ))}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

      {user ? (
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full border border-slate-800 p-0.5">
            <img src={user.photoURL || ''} alt="avatar" className="w-full h-full rounded-full" />
          </div>
        </div>
      ) : (
        <button 
          onClick={onLogin}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-full text-sm font-semibold transition-all"
        >
          <LogIn className="w-4 h-4" />
          Login
        </button>
      )}
    </div>
  </nav>
  );
};

const Card: React.FC<{ children: React.ReactNode; className?: string; title?: string; icon?: any }> = ({ children, className, title, icon: Icon }) => (
  <div className={cn("bg-slate-900/50 border border-slate-800 rounded-2xl overflow-hidden", className)}>
    {title && (
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-300 flex items-center gap-2 italic uppercase tracking-wider">
          {Icon && <Icon className="w-4 h-4 text-blue-500" />}
          {title}
        </h3>
        <Info className="w-4 h-4 text-slate-600 cursor-help" />
      </div>
    )}
    <div className="p-5">
      {children}
    </div>
  </div>
);

const MomentumIntelligence: React.FC<{ watchlist: string[]; onToggle: (symbol: string) => void }> = ({ watchlist, onToggle }) => {
  const { data: bullish } = trpc.getTechnicalTrends.useQuery({ type: 'bullish' });
  const { data: bearish } = trpc.getTechnicalTrends.useQuery({ type: 'bearish' });

  const bullishList = bullish?.data?.tableDataList?.slice(0, 5) || [];
  const bearishList = bearish?.data?.tableDataList?.slice(0, 5) || [];

  return (
    <Card title="Momentum Intelligence" icon={Zap} className="col-span-12">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-2">
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <h3 className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.2em]">Institutional Accumulation</h3>
          </div>
          {bullishList.map((stock: any) => (
            <div key={stock.stockId} className="flex justify-between items-center p-3 bg-slate-950/50 rounded-xl border border-emerald-500/10 hover:border-emerald-500/30 transition-all group">
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => onToggle(stock.shortName)}
                  className={cn(
                    "p-1.5 rounded-lg transition-all",
                    watchlist.includes(stock.shortName) ? "bg-amber-500/20 text-amber-500" : "text-slate-700 hover:text-slate-400"
                  )}
                >
                  <WatchlistIcon className={cn("w-3.5 h-3.5", watchlist.includes(stock.shortName) && "fill-amber-500")} />
                </button>
                <div>
                  <p className="text-xs font-black text-white group-hover:text-emerald-400 transition-colors uppercase">{stock.shortName}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] font-bold text-slate-500 tabular-nums">₹{stock.lastPrice}</span>
                    <span className="text-[9px] font-black text-slate-600 uppercase tracking-tighter bg-slate-900 px-1.5 py-0.5 rounded italic">RSI: {stock.rsi}</span>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded-lg">+{stock.percentChange}%</span>
                <p className="text-[9px] font-bold text-slate-600 mt-1 uppercase tracking-widest">{stock.trend}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            <h3 className="text-[10px] font-black text-rose-500 uppercase tracking-[0.2em]">Distribution Pressure</h3>
          </div>
          {bearishList.map((stock: any) => (
            <div key={stock.stockId} className="flex justify-between items-center p-3 bg-slate-950/50 rounded-xl border border-rose-500/10 hover:border-rose-500/30 transition-all group">
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => onToggle(stock.shortName)}
                  className={cn(
                    "p-1.5 rounded-lg transition-all",
                    watchlist.includes(stock.shortName) ? "bg-amber-500/20 text-amber-500" : "text-slate-700 hover:text-slate-400"
                  )}
                >
                  <WatchlistIcon className={cn("w-3.5 h-3.5", watchlist.includes(stock.shortName) && "fill-amber-500")} />
                </button>
                <div>
                  <p className="text-xs font-black text-white group-hover:text-rose-400 transition-colors uppercase">{stock.shortName}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] font-bold text-slate-500 tabular-nums">₹{stock.lastPrice}</span>
                    <span className="text-[9px] font-black text-slate-600 uppercase tracking-tighter bg-slate-900 px-1.5 py-0.5 rounded italic">RSI: {stock.rsi}</span>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-black text-rose-500 bg-rose-500/10 px-2 py-1 rounded-lg">{stock.percentChange}%</span>
                <p className="text-[9px] font-bold text-slate-600 mt-1 uppercase tracking-widest">{stock.trend}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};

const InstitutionalInsights: React.FC = () => {
  const { data: mfData } = trpc.getMFInvestments.useQuery({ symbol: 'RELIANCE' });
  const mfs = mfData?.Table || [];

  return (
    <Card title="Institutional Velocity" icon={Users} className="col-span-12 lg:col-span-4">
      <div className="space-y-4 pt-2">
        <div className="p-4 bg-blue-600/10 border border-blue-500/20 rounded-2xl">
          <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Top Active Insight</p>
          <p className="text-xs text-slate-300 italic leading-relaxed">
            Institutional activity tracks heavy volume inflows into index leaders. Reliability: <span className="text-white font-black">94%</span>
          </p>
        </div>
        
        <div className="space-y-3">
          <h4 className="text-[9px] font-black text-slate-600 uppercase tracking-[0.2em] mb-2">Major MF Positions</h4>
          {mfs.slice(0, 5).map((mf: any, idx: number) => (
            <div key={idx} className="flex justify-between items-center p-3 bg-slate-950 rounded-xl border border-slate-800/50">
              <div className="flex-1 mr-4">
                <p className="text-[10px] font-black text-white line-clamp-1 uppercase tracking-tight">{mf.schemeName}</p>
                <p className="text-[9px] font-bold text-slate-500 mt-0.5">{mf.marketValue} Cr held</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-black text-white italic">{mf.percentToAum}%</p>
                <p className="text-[9px] font-bold text-slate-600 uppercase tracking-tighter">of AUM</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};

const PennyStockIntelligence: React.FC<{ 
  watchlist: string[]; 
  onToggleWatchlist: (symbol: string) => void;
  onSelectStock: (symbol: string) => void;
}> = ({ watchlist, onToggleWatchlist, onSelectStock }) => {
  const { data: pennyData } = trpc.getETPennyStocks.useQuery();
  const pennies = pennyData?.searchResult?.searchData?.records?.slice(0, 5) || [];

  return (
    <Card title="Micro-Cap Opportunity" icon={Trophy} className="col-span-12 lg:col-span-8">
      <div className="overflow-x-auto pt-2">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="pb-3 text-left text-[9px] font-black text-slate-500 uppercase tracking-widest">Symbol</th>
              <th className="pb-3 text-right text-[9px] font-black text-slate-500 uppercase tracking-widest">Price</th>
              <th className="pb-3 text-right text-[9px] font-black text-slate-500 uppercase tracking-widest">Wk %</th>
              <th className="pb-3 text-right text-[9px] font-black text-slate-500 uppercase tracking-widest">Vol Chg</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {pennies.map((stock: any) => (
              <tr key={stock.fincode || stock.symbol} className="group hover:bg-slate-900/50 transition-colors">
                <td className="py-4">
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => onToggleWatchlist(stock.symbol)}
                      className={cn(
                        "p-1.5 rounded-lg transition-all",
                        watchlist.includes(stock.symbol) ? "bg-amber-500/20 text-amber-500" : "text-slate-600 hover:text-slate-400"
                      )}
                    >
                      <WatchlistIcon className={cn("w-3.5 h-3.5", watchlist.includes(stock.symbol) && "fill-amber-500")} />
                    </button>
                    <div>
                      <p className="text-xs font-black text-white group-hover:text-amber-400 transition-colors uppercase cursor-pointer" onClick={() => onSelectStock(stock.symbol)}>{stock.symbol}</p>
                      <p className="text-[9px] font-bold text-slate-600 line-clamp-1">{stock.companyName || stock.name}</p>
                    </div>
                  </div>
                </td>
                <td className="py-4 text-right">
                  <p className="text-xs font-black text-white tabular-nums">₹{stock.currentPrice}</p>
                </td>
                <td className="py-4 text-right">
                  <span className={cn(
                    "text-[10px] font-black px-2 py-0.5 rounded",
                    parseFloat(stock.weekPercentChange) >= 0 ? "text-emerald-500 bg-emerald-500/10" : "text-rose-500 bg-rose-500/10"
                  )}>
                    {stock.weekPercentChange}%
                  </span>
                </td>
                <td className="py-4 text-right">
                  <p className="text-[10px] font-bold text-slate-500">{stock.volumeChange}x</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

const Watchlist: React.FC<{ 
  watchlist: string[]; 
  stocks: MarketData[]; 
  onSelectStock: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}> = ({ watchlist, stocks, onSelectStock, onRemove }) => {
  const watchlistStocks = stocks.filter(s => watchlist.includes(s.symbol));

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-3xl font-black text-white italic tracking-tighter uppercase flex items-center gap-3">
            <WatchlistIcon className="w-8 h-8 text-blue-500" />
            My Watchlist
          </h2>
          <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1">Efficiently tracking your custom selected assets</p>
        </div>
      </div>

      {watchlistStocks.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {watchlistStocks.map(stock => {
            const isUp = stock.changePct >= 0;
            return (
              <Card key={stock.symbol} className="group hover:border-blue-500/30 transition-all cursor-pointer relative overflow-hidden" onClick={() => onSelectStock(stock.symbol)}>
                <div className="absolute top-0 right-0 p-4 z-10">
                  <button 
                    onClick={(e) => { e.stopPropagation(); onRemove(stock.symbol); }}
                    className="p-1.5 bg-slate-900/50 backdrop-blur-md rounded-lg text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-lg border border-slate-800"
                  >
                    <Plus className="w-3.5 h-3.5 rotate-45" />
                  </button>
                </div>
                
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h4 className="text-xs font-black text-white tracking-widest uppercase italic">{stock.symbol}</h4>
                    <p className="text-[10px] text-slate-500 font-bold uppercase truncate max-w-[120px]">{stock.name}</p>
                  </div>
                  <div className={cn(
                    "px-2 py-1 rounded text-[10px] font-black italic",
                    isUp ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                  )}>
                    {isUp ? '+' : ''}{stock.changePct}%
                  </div>
                </div>
                
                <div className="mt-4 flex items-end justify-between">
                   <div>
                      <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">Live Price</p>
                      <p className="text-xl font-black text-white tabular-nums italic tracking-tighter">₹{stock.price.toLocaleString()}</p>
                   </div>
                   <div className="h-8 w-20">
                      <ResponsiveContainer width="100%" height="100%">
                         <BarChart data={Array.from({length: 8}, () => ({ v: Math.random() }))}>
                            <Bar dataKey="v" fill={isUp ? "#10b981" : "#f43f5e"} opacity={0.3} radius={[2, 2, 0, 0]} />
                         </BarChart>
                      </ResponsiveContainer>
                   </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="py-32 flex flex-col items-center justify-center bg-slate-900/30 rounded-3xl border border-slate-800 border-dashed">
          <WatchlistIcon className="w-16 h-16 text-slate-800 mb-6 animate-pulse" />
          <h3 className="text-white font-black text-2xl uppercase italic tracking-tighter mb-2">Your Watchlist is Empty</h3>
          <p className="text-slate-500 text-xs uppercase font-bold tracking-widest max-w-xs text-center leading-loose">
            Start tracking high-conviction assets to build your institutional-grade perspective.
          </p>
        </div>
      )}
    </div>
  );
};

// --- Sector Heatmap Component ---
const SectorHeatmap: React.FC<{ indexId?: string }> = ({ indexId }) => {
  const { data: sectors, isLoading } = trpc.getSectorPerformance.useQuery({ indexId }, {
    refetchInterval: 10000,
  });

  if (isLoading || !sectors) return <div className="h-40 bg-slate-900/50 animate-pulse rounded-2xl" />;

  return (
    <Card title="Sector Heatmap" icon={PieChart}>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 pt-2">
        {sectors.map((sector) => (
          <div 
            key={sector.name}
            className={cn(
              "p-3 rounded-xl border flex flex-col justify-between transition-all hover:scale-[1.02]",
              sector.change >= 0 
                ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400" 
                : "bg-rose-500/5 border-rose-500/20 text-rose-400"
            )}
          >
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{sector.name}</span>
            <div className="flex items-end justify-between mt-2">
              <span className="text-lg font-black italic tracking-tighter truncate">
                {sector.change >= 0 ? '+' : ''}{sector.change.toFixed(2)}%
              </span>
              <span className="text-[8px] font-bold text-slate-500">{sector.stocks} Stocks</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

// --- Sector Performance Component ---
const SectorPerformance: React.FC = () => {
  const { data, isLoading } = trpc.getMarketMapData.useQuery({ indId: '38' }); // Energy by default

  if (isLoading || !data) return <div className="h-40 bg-slate-900/50 animate-pulse rounded-2xl" />;

  const sectors = (data as any)?.item || [];

  return (
    <Card title="Market Map (Sectors)" icon={PieChart}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {sectors.slice(0, 8).map((s: any) => (
          <div key={s.id} className="p-4 bg-slate-950 border border-slate-800 rounded-2xl hover:border-slate-700 transition-all">
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{s.shortname}</p>
            <div className="flex items-center justify-between">
              <p className={cn(
                "text-lg font-black italic tracking-tighter",
                s.direction === "1" ? "text-emerald-400" : "text-rose-400"
              )}>
                {s.percentchange}%
              </p>
              <div className={cn(
                "p-1 rounded",
                s.direction === "1" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
              )}>
                {s.direction === "1" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              </div>
            </div>
            <p className="text-[8px] text-slate-600 font-bold uppercase mt-2">Cap: ₹{s.mktcap} Cr</p>
          </div>
        ))}
      </div>
    </Card>
  );
};

// --- Index Overview Component ---
const IndexOverview: React.FC = () => {
  const { data: indices, isLoading } = trpc.getAllIndices.useQuery(undefined, {
    refetchInterval: 30000, // Refresh every 30s
  });

  if (isLoading || !indices) return <div className="h-40 bg-slate-900/50 animate-pulse rounded-2xl" />;

  // Mapping the API response to the UI format
  // Moneycontrol indices API usually returns { success: 1, data: [...] } or { data: { indexList: [...] } }
  const rawData = (indices as any)?.data;
  const indicesList = Array.isArray(rawData) ? rawData : (rawData?.indexList || [
    { indexName: 'NIFTY 50', lastPrice: '22453.20', percentChange: '0.84', direction: '1' },
    { indexName: 'SENSEX', lastPrice: '73845.54', percentChange: '0.72', direction: '1' },
    { indexName: 'NIFTY BANK', lastPrice: '47285.30', percentChange: '1.24', direction: '1' },
    { indexName: 'INDIA VIX', lastPrice: '14.82', percentChange: '2.40', direction: '-1' }
  ]);

  return (
    <Card title="Market Watch" icon={Activity}>
       <div className="space-y-4 pt-2">
         {indicesList.slice(4, 10).map((idx: any) => (
           <div key={idx.indexName} className="flex justify-between items-center p-3 bg-slate-950 rounded-xl border border-slate-800/50 hover:border-slate-700 transition-all">
             <div>
               <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{idx.indexName}</p>
               <p className="text-sm font-black text-white tabular-nums mt-0.5">₹{idx.lastPrice}</p>
             </div>
             <div className="text-right">
               <div className={cn(
                 "flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded",
                 idx.direction === "1" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
               )}>
                 {idx.direction === "1" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                 {idx.percentChange}%
               </div>
             </div>
           </div>
         ))}
       </div>
    </Card>
  );
};

const MarketIndices: React.FC = () => {
  const { data: indices, isLoading } = trpc.getMarketOverview.useQuery(undefined, {
    refetchInterval: 10000,
  });

  if (isLoading || !indices) return (
    <div className="col-span-12 grid grid-cols-1 md:grid-cols-3 gap-6 mb-2">
      {[1, 2, 3].map(i => (
        <div key={i} className="h-32 bg-slate-900 border border-slate-800 rounded-3xl animate-pulse" />
      ))}
    </div>
  );

  const displayItems = [
    { name: 'NIFTY 50', ...indices.nifty50 },
    { name: 'SENSEX', ...indices.sensex },
    { name: 'BANK NIFTY', ...indices.bankNifty },
  ];

  return (
    <div className="col-span-12 grid grid-cols-1 md:grid-cols-3 gap-6 mb-2">
      {displayItems.map((item, idx) => (
        <motion.div
          key={item.name}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: idx * 0.1 }}
          className="bg-slate-900 border border-slate-800 p-6 rounded-[2.5rem] relative overflow-hidden group hover:border-blue-500/30 transition-all shadow-2xl"
        >
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
            <TrendingUp className={cn("w-24 h-24", item.change >= 0 ? "text-emerald-500" : "text-rose-500")} />
          </div>
          
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-4">
               <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">{item.name}</span>
               <div className={cn(
                 "px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest",
                 item.change >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
               )}>
                 {item.change >= 0 ? 'Bullish' : 'Bearish'}
               </div>
            </div>

            <div className="flex items-end gap-3">
               <h2 className="text-3xl font-black text-white tabular-nums tracking-tighter italic">
                 {item.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
               </h2>
               <div className={cn(
                 "flex items-center gap-1 mb-1.5",
                 item.change >= 0 ? "text-emerald-400" : "text-rose-400"
               )}>
                 <span className="text-sm font-black tabular-nums">
                   {item.change >= 0 ? '+' : ''}{item.change.toFixed(2)}
                 </span>
                 <span className="text-[10px] font-black opacity-60">
                   ({item.changePct >= 0 ? '+' : ''}{item.changePct.toFixed(2)}%)
                 </span>
               </div>
            </div>

            <div className="mt-4 flex gap-2">
               <div className="h-1 flex-1 bg-slate-800 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${60 + Math.random() * 30}%` }}
                    className={cn("h-full", item.change >= 0 ? "bg-emerald-500" : "bg-rose-500")}
                  />
               </div>
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
};

const GlobalMarkets: React.FC = () => {
  const { data: globalData, isLoading } = trpc.getGlobalIndices.useQuery(undefined, {
    refetchInterval: 30000,
  });

  if (isLoading || !globalData) return (
    <Card title="Global Markets" icon={Activity} className="col-span-12 lg:col-span-4 h-full">
      <div className="space-y-4 animate-pulse pt-2">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-12 bg-slate-800 rounded-xl" />
        ))}
      </div>
    </Card>
  );

  const getRawIndices = () => {
    if (Array.isArray(globalData)) return globalData;
    if (Array.isArray(globalData?.data)) return globalData.data;
    if (globalData?.data && typeof globalData.data === 'object') return Object.values(globalData.data).flat();
    return [];
  };

  const rawIndices = getRawIndices() as any[];
  
  const importantIndices = ['S&P 500', 'Nasdaq', 'FTSE 100', 'Nikkei 225', 'DAX', 'Hang Seng'];
  const filteredIndices = Array.isArray(rawIndices) ? rawIndices.filter((idx: any) => 
    idx && idx.indexName && importantIndices.some(name => idx.indexName.includes(name))
  ) : [];

  return (
    <Card title="Global Intelligence" icon={Activity} className="col-span-12 lg:col-span-4">
      <div className="space-y-3 pt-2">
        {filteredIndices.slice(0, 6).map((idx: any) => (
          <div key={idx.indexName} className="flex justify-between items-center p-3 bg-slate-950 rounded-xl border border-slate-800/50 hover:border-slate-700 transition-all group">
            <div>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest group-hover:text-slate-400 transition-colors">{idx.indexName}</p>
              <p className="text-sm font-black text-white tabular-nums mt-0.5">{idx.lastPrice}</p>
            </div>
            <div className="text-right">
              <div className={cn(
                "flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-lg",
                idx.direction === "1" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-400"
              )}>
                {idx.direction === "1" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {idx.percentChange}%
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

// --- Signal History Modal Component ---
const SignalHistoryModal: React.FC<{ symbol: string; onClose: () => void }> = ({ symbol, onClose }) => {
  const { data: history, isLoading } = trpc.getSignalHistory.useQuery({ symbol });

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/90 backdrop-blur-md"
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative w-full max-w-3xl bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]"
      >
        <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/50 backdrop-blur-xl">
           <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-center">
                 <History className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <h3 className="text-xl font-black text-white italic tracking-tighter uppercase">{symbol} Signal History</h3>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-0.5">Historical AI Performance Tracking</p>
              </div>
           </div>
           <button onClick={onClose} className="p-2 text-slate-500 hover:text-white transition-colors">
              <Plus className="w-6 h-6 rotate-45" />
           </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 hide-scrollbar">
           {isLoading ? (
             <div className="py-20 flex flex-col items-center justify-center">
                <Activity className="w-10 h-10 text-blue-500/20 animate-pulse mb-4" />
                <p className="text-slate-500 text-xs font-bold uppercase tracking-widest animate-pulse">Syncing with history logs...</p>
             </div>
           ) : history && history.length > 0 ? (
             <div className="space-y-4">
               {history.map((sig: any) => (
                 <div key={sig.id} className="p-4 bg-slate-950 rounded-2xl border border-slate-800/50 hover:border-slate-700 transition-all flex flex-col gap-4 group">
                    <div className="flex justify-between items-start">
                       <div className="flex items-center gap-3">
                          <div className={cn(
                            "px-3 py-1 rounded text-[10px] font-black tracking-widest uppercase",
                            sig.type === 'BUY' ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" : "bg-rose-500/10 text-rose-500 border border-rose-500/20"
                          )}>
                            {sig.type}
                          </div>
                          <div>
                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-0.5">
                              {sig.createdAt?.seconds ? format(new Date(sig.createdAt.seconds * 1000), 'MMM dd, HH:mm') : 'Recent'}
                            </p>
                            <p className="text-xs text-white/70 italic line-clamp-1">"{sig.reasoning || sig.summary}"</p>
                          </div>
                       </div>
                       <div className="text-right">
                          <div className={cn(
                            "px-2 py-0.5 rounded text-[9px] font-black tracking-widest uppercase",
                            sig.status === 'COMPLETED' ? "bg-emerald-500 text-emerald-950" : 
                            sig.status === 'FAILED' ? "bg-rose-500 text-rose-950" : "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                          )}>
                            {sig.status}
                          </div>
                          {sig.result && (
                            <p className={cn(
                              "text-[10px] font-black mt-1 uppercase italic",
                              sig.result === 'PROFIT' ? "text-emerald-400" : "text-rose-400"
                            )}>
                              {sig.result}
                            </p>
                          )}
                       </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                       <div className="bg-slate-900/50 p-2 rounded-xl border border-slate-800/50 text-center">
                          <span className="text-[8px] font-black text-slate-500 uppercase block tracking-widest mb-0.5">Entry</span>
                          <span className="text-xs font-black text-white">₹{sig.entry}</span>
                       </div>
                       <div className="bg-slate-900/50 p-2 rounded-xl border border-slate-800/50 text-center">
                          <span className="text-[8px] font-black text-blue-500 uppercase block tracking-widest mb-0.5">Target</span>
                          <span className="text-xs font-black text-white">₹{sig.target}</span>
                       </div>
                       <div className="bg-slate-900/50 p-2 rounded-xl border border-slate-800/50 text-center">
                          <span className="text-[8px] font-black text-rose-500 uppercase block tracking-widest mb-0.5">Exit Price</span>
                          <span className="text-xs font-black text-white">
                             {sig.status === 'ACTIVE' ? (
                               <span className="text-slate-600 italic">Pending</span>
                             ) : (
                               `₹${sig.exitPrice || (sig.result === 'PROFIT' ? sig.target : sig.stopLoss)}`
                             )}
                          </span>
                       </div>
                       <div className="bg-slate-900/50 p-2 rounded-xl border border-slate-800/50 text-center">
                          <span className="text-[8px] font-black text-amber-500 uppercase block tracking-widest mb-0.5">Outcome</span>
                          <span className={cn(
                             "text-[10px] font-black uppercase tracking-tighter",
                             sig.result === 'PROFIT' ? "text-emerald-400" : 
                             sig.result === 'LOSS' ? "text-rose-400" : "text-slate-500"
                          )}>
                             {sig.result ? sig.result : (sig.status === 'ACTIVE' ? 'Running' : 'Closed')}
                          </span>
                       </div>
                    </div>
                 </div>
               ))}
             </div>
           ) : (
             <div className="py-20 flex flex-col items-center justify-center opacity-50">
                <Zap className="w-12 h-12 text-slate-800 mb-4" />
                <p className="text-slate-600 font-black text-lg uppercase italic tracking-tighter">No historical signals found</p>
                <p className="text-slate-500 text-[10px] uppercase font-bold tracking-widest mt-2 text-center">This asset hasn't been significantly tracked by AI yet.</p>
             </div>
           )}
        </div>
      </motion.div>
    </div>
  );
};

const Dashboard: React.FC<{ 
  stocks: MarketData[]; 
  onNewSignal: (signal: any) => void; 
  onSelectStock: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string) => void;
}> = ({ stocks, onNewSignal, onSelectStock, watchlist, onToggleWatchlist }) => {
  const news = useNewsFeed();
  const [newsFilter, setNewsFilter] = useState('All');
  const [aiSignals, setAiSignals] = useState<any[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedSignal, setSelectedSignal] = useState<any | null>(null);
  const [historySymbol, setHistorySymbol] = useState<string | null>(null);
  
  const filteredNews = news.filter(item => 
    newsFilter === 'All' ? true : item.category === newsFilter
  );

  const [graphData] = useState(
    Array.from({ length: 20 }, (_, i) => ({
      time: i,
      value: 22000 + Math.random() * 500,
    }))
  );

  const saveSignalMutation = trpc.saveSignal.useMutation();
  const getAIAnalysisMutation = trpc.getAIAnalysis.useMutation();

  const handleGenerateSignals = async () => {
    setIsGenerating(true);
    try {
      const topStocks = stocks.slice(0, 3);
      const newSignals = [];
      
      for (const stock of topStocks) {
        try {
          const analysis = await getAIAnalysisMutation.mutateAsync({ symbol: stock.symbol, data: stock });
          
          const dataPoints = 20;
          let currentPrice = stock.price * 0.95;
          const history = Array.from({ length: dataPoints }, (_, i) => {
            const change = currentPrice * (Math.random() - 0.5) * 0.02;
            currentPrice += change;
            return { time: i, price: currentPrice };
          });

          const signal = {
            symbol: stock.symbol,
            type: analysis.signal as "BUY" | "SELL" | "HOLD",
            entry: analysis.entry,
            target: analysis.target,
            stopLoss: analysis.stopLoss,
            confidence: analysis.confidence,
            reasoning: analysis.reasoning,
          };

          await saveSignalMutation.mutateAsync(signal);

          const signalWithHistory = {
            ...signal,
            signal: signal.type,
            history
          };
          
          if ((signal.type === 'BUY' || signal.type === 'SELL') && signal.confidence > 70) {
            onNewSignal(signalWithHistory);
          }
          
          newSignals.push(signalWithHistory);
        } catch (err) {
          console.error(`Failed to analyze ${stock.symbol}:`, err);
        }
      }

      setAiSignals(newSignals);
    } catch (error) {
      console.error("Failed to generate signals:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    // Initial generation - only if we don't have signals and aren't already generating
    if (aiSignals.length === 0 && stocks.length > 0 && !isGenerating) {
      handleGenerateSignals();
    }
    // We only want this to run once on mount or when stocks first become available
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stocks.length > 0]);

  return (
    <div className="p-6 grid grid-cols-12 gap-6 relative">
      <MarketIndices />
      
      {/* High-level Overview */}
      <div className="col-span-12 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 flex flex-col gap-6">
          <IndexOverview />
          <GlobalMarkets />
        </div>
        <div className="lg:col-span-8 flex flex-col gap-6">
          <SectorHeatmap />
          <SectorPerformance />
        </div>
      </div>

      <div className="col-span-12 grid grid-cols-12 gap-6">
        <MomentumIntelligence watchlist={watchlist} onToggle={onToggleWatchlist} />
        <InstitutionalInsights />
        <PennyStockIntelligence watchlist={watchlist} onToggleWatchlist={onToggleWatchlist} onSelectStock={onSelectStock} />
      </div>

      <AnimatePresence>
        {historySymbol && (
          <SignalHistoryModal symbol={historySymbol} onClose={() => setHistorySymbol(null)} />
        )}
      </AnimatePresence>

      {/* Signal Details Modal */}
      <AnimatePresence>
        {selectedSignal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedSignal(null)}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="p-8">
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 bg-slate-950 border border-slate-800 rounded-2xl flex items-center justify-center">
                       <Zap className="w-8 h-8 text-blue-500 fill-blue-500/20" />
                    </div>
                    <div>
                      <h2 className="text-3xl font-black text-white tracking-tighter uppercase italic">{selectedSignal.symbol} Analysis</h2>
                      <div className="flex gap-2 mt-1">
                        <span className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-black tracking-widest uppercase",
                          selectedSignal.signal === 'BUY' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                        )}>
                          {selectedSignal.signal} SIGNAL
                        </span>
                        <span className="text-[10px] font-bold text-slate-500 bg-slate-950 px-2 py-0.5 rounded border border-slate-800 tracking-widest">{selectedSignal.confidence}% CONFIDENCE</span>
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={() => setSelectedSignal(null)}
                    className="p-2 text-slate-500 hover:text-white transition-colors"
                  >
                    <Plus className="w-6 h-6 rotate-45" />
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-4 mb-8">
                   <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800">
                      <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1 text-center">Entry Price</p>
                      <p className="text-xl font-black text-white text-center">₹{selectedSignal.entry}</p>
                   </div>
                   <div className="p-4 bg-slate-950 rounded-2xl border border-blue-500/30 ring-1 ring-blue-500/10">
                      <p className="text-[9px] font-black text-blue-500 uppercase tracking-widest mb-1 text-center">AI Target</p>
                      <p className="text-xl font-black text-white text-center">₹{selectedSignal.target}</p>
                   </div>
                   <div className="p-4 bg-slate-950 rounded-2xl border border-rose-500/30">
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest mb-1 text-center">Stop Loss</p>
                      <p className="text-xl font-black text-white text-center">₹{selectedSignal.stopLoss}</p>
                   </div>
                </div>

                <div className="mb-8">
                   <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                     <Info className="w-3 h-3" />
                     Strategy Reasoning
                   </h4>
                   <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800 relative overflow-hidden">
                      <Zap className="absolute -right-4 -bottom-4 w-24 h-24 text-blue-500/5 rotate-12" />
                      <p className="text-sm text-slate-300 leading-relaxed font-medium italic">
                        "{selectedSignal.reasoning}"
                      </p>
                   </div>
                </div>

                <div className="h-56 mb-8 bg-slate-950 rounded-3xl border border-slate-800 p-6 relative overflow-hidden group/modalchart">
                  <div className="absolute top-6 left-6 z-10">
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Signal Visualization</p>
                    <div className="flex items-center gap-2">
                       <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                       <span className="text-xs font-bold text-white uppercase italic">Real-time Analysis</span>
                    </div>
                  </div>
                  
                  <div className="absolute top-6 right-6 z-10 flex gap-3">
                     <div className="flex items-center gap-1.5">
                        <div className="w-2 h-0.5 bg-emerald-500" />
                        <span className="text-[8px] font-black text-slate-500 uppercase">Target</span>
                     </div>
                     <div className="flex items-center gap-1.5">
                        <div className="w-2 h-0.5 bg-rose-500" />
                        <span className="text-[8px] font-black text-slate-500 uppercase">Stop Loss</span>
                     </div>
                  </div>

                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={selectedSignal.history || []} margin={{ top: 40, right: 0, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="modalGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={selectedSignal.signal === 'BUY' ? "#10b981" : "#f43f5e"} stopOpacity={0.2}/>
                          <stop offset="95%" stopColor={selectedSignal.signal === 'BUY' ? "#10b981" : "#f43f5e"} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <Tooltip 
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            return (
                              <div className="bg-slate-900 border border-slate-800 p-2 rounded-lg shadow-xl">
                                <p className="text-[10px] font-black text-white">₹{payload[0].value?.toFixed(2)}</p>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="price" 
                        stroke={selectedSignal.signal === 'BUY' ? "#10b981" : "#f43f5e"} 
                        strokeWidth={3} 
                        fill="url(#modalGradient)" 
                        animationDuration={1500}
                      />
                      <ReferenceLine y={selectedSignal.entry} stroke="#94a3b8" strokeDasharray="5 5" label={{ position: 'right', value: 'ENTRY', fill: '#94a3b8', fontSize: 8, fontWeight: 900 }} />
                      <ReferenceLine y={selectedSignal.target} stroke="#10b981" strokeDasharray="3 3" label={{ position: 'right', value: 'TARGET', fill: '#10b981', fontSize: 8, fontWeight: 900 }} />
                      <ReferenceLine y={selectedSignal.stopLoss} stroke="#f43f5e" strokeDasharray="3 3" label={{ position: 'right', value: 'STOP LOSS', fill: '#f43f5e', fontSize: 8, fontWeight: 900 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                <button 
                  onClick={() => setSelectedSignal(null)}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl transition-all shadow-[0_10px_30px_rgba(37,99,235,0.2)]"
                >
                  ACKNOWLEDGE SIGNAL
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Chart Section */}
      <div className="col-span-12 lg:col-span-8 space-y-6">
        <Card title="Market Sentiment" icon={Activity}>
          <div className="h-64 mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={graphData}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Area type="monotone" dataKey="value" stroke="#3b82f6" fillOpacity={1} fill="url(#colorValue)" strokeWidth={3} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-between items-center mt-6 p-4 bg-slate-950 rounded-xl border border-slate-800">
            <div>
              <p className="text-slate-500 text-xs font-bold uppercase tracking-widest">Nifty 50 Rank</p>
              <p className="text-xl font-black text-white">22,453.20</p>
            </div>
            <div className="text-right">
              <p className="text-slate-500 text-xs font-bold uppercase tracking-widest">Day Range</p>
              <div className="w-32 h-1.5 bg-slate-800 rounded-full mt-2 relative">
                 <div className="absolute left-[40%] w-2 h-2 -top-0.5 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
              </div>
              <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-bold">
                <span>22,380</span>
                <span>22,510</span>
              </div>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="Top Movers (Live)" icon={TrendingUp}>
             <div className="space-y-4 pt-2">
              {stocks.slice(0, 5).map((stock) => (
                <div 
                  key={stock.symbol} 
                  onClick={() => onSelectStock(stock.symbol)}
                  className="flex items-center justify-between group hover:bg-slate-800/40 p-2 rounded-xl transition-all cursor-pointer border border-transparent hover:border-slate-700"
                >
                  <div>
                    <p className="text-white font-bold text-sm tracking-tight">{stock.symbol}</p>
                    <p className="text-slate-500 text-[10px] font-medium tracking-wider">Vol: {stock.volume}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-white font-black text-sm tabular-nums">₹{stock.price.toLocaleString()}</p>
                    <p className={cn(
                      "text-[10px] font-bold tabular-nums",
                      stock.changePct >= 0 ? "text-emerald-400" : "text-rose-400"
                    )}>
                      {stock.changePct >= 0 ? '+' : ''}{stock.changePct}%
                    </p>
                  </div>
                </div>
              ))}
             </div>
          </Card>
          <Card title="AI Intelligence Hub" icon={Zap}>
             <div className="space-y-4 pt-2 min-h-[180px]">
                {aiSignals.length > 0 ? aiSignals.map((signal) => (
                  <div 
                    key={signal.symbol} 
                    onClick={() => onSelectStock(signal.symbol)}
                    className="p-4 bg-slate-950 rounded-2xl border border-slate-800 flex flex-col gap-4 hover:border-slate-700 transition-all cursor-pointer group relative overflow-hidden"
                  >
                    <div className="flex justify-between items-start relative z-10">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black text-white italic tracking-tighter uppercase">{signal.symbol}</span>
                          <div className={cn(
                            "px-2 py-0.5 rounded text-[8px] font-black tracking-widest uppercase",
                            signal.signal === 'BUY' ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" : 
                            signal.signal === 'SELL' ? "bg-rose-500/10 text-rose-500 border border-rose-500/20" : "bg-slate-500/10 text-slate-500 border border-slate-500/20"
                          )}>
                            {signal.signal} Signal
                          </div>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1 italic line-clamp-1 leading-relaxed">
                          {signal.reasoning}
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-black text-white tracking-widest mb-1">{signal.confidence}% <span className="text-slate-500">CONF.</span></div>
                        <div className="w-16 h-1 bg-slate-900 rounded-full overflow-hidden border border-slate-800 ml-auto">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${signal.confidence}%` }}
                            className={cn(
                              "h-full",
                              signal.signal === 'BUY' ? "bg-emerald-500" : 
                              signal.signal === 'SELL' ? "bg-rose-500" : "bg-slate-500"
                            )}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="h-20 w-full relative group/chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={signal.history}>
                          <defs>
                            <linearGradient id={`gradient-${signal.symbol}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={signal.signal === 'BUY' ? "#10b981" : "#f43f5e"} stopOpacity={0.1}/>
                              <stop offset="95%" stopColor={signal.signal === 'BUY' ? "#10b981" : "#f43f5e"} stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <Area 
                            type="monotone" 
                            dataKey="price" 
                            stroke={signal.signal === 'BUY' ? "#10b981" : "#f43f5e"} 
                            strokeWidth={2} 
                            fill={`url(#gradient-${signal.symbol})`} 
                            dot={false}
                          />
                          <ReferenceLine y={signal.entry} stroke="#94a3b8" strokeDasharray="3 3" opacity={0.3} />
                          <ReferenceLine y={signal.target} stroke="#3b82f6" strokeDasharray="3 3" opacity={0.3} />
                          <ReferenceLine y={signal.stopLoss} stroke="#f43f5e" strokeDasharray="3 3" opacity={0.3} />
                        </AreaChart>
                      </ResponsiveContainer>
                      
                      {/* Floating Labels on Hover */}
                      <div className="absolute inset-0 flex flex-col justify-between opacity-0 group-hover/chart:opacity-100 transition-opacity pointer-events-none p-1">
                         <div className="flex justify-between items-center bg-slate-900/40 backdrop-blur-[2px] rounded px-1.5 py-0.5 border border-white/5 w-fit">
                            <span className="text-[8px] font-black text-blue-400 uppercase tracking-tighter">TGT: ₹{signal.target}</span>
                         </div>
                         <div className="flex justify-between items-center bg-slate-900/40 backdrop-blur-[2px] rounded px-1.5 py-0.5 border border-white/5 w-fit">
                            <span className="text-[8px] font-black text-rose-400 uppercase tracking-tighter">SL: ₹{signal.stopLoss}</span>
                         </div>
                      </div>
                    </div>

                    <div className="flex justify-between items-center text-[9px] font-black uppercase tracking-widest text-slate-500 border-t border-slate-900 pt-3">
                      <div className="flex gap-4">
                        <span>Entry: <span className="text-white">₹{signal.entry}</span></span>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setHistorySymbol(signal.symbol);
                          }}
                          className="px-3 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-400 hover:text-white flex items-center gap-1.5 transition-all group/hist shadow-lg"
                        >
                          <History className="w-3 h-3 group-hover/hist:rotate-[-45deg] transition-transform text-blue-500" /> 
                          View History
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSignal(signal);
                          }}
                          className="px-3 py-1 bg-blue-500/10 hover:bg-blue-500 border border-blue-500/20 hover:border-blue-500 rounded-lg text-blue-500 hover:text-white flex items-center gap-1.5 transition-all shadow-lg"
                        >
                          Deep Insight <ArrowUpRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="flex flex-col items-center justify-center py-8">
                     <Activity className="w-8 h-8 text-slate-800 animate-pulse mb-2" />
                     <p className="text-slate-600 text-[10px] font-bold uppercase tracking-widest">Ready to analyze market data...</p>
                  </div>
                )}
             </div>
             <button 
                onClick={handleGenerateSignals}
                disabled={isGenerating}
                className={cn(
                    "w-full mt-4 py-2 border border-slate-800 rounded-xl text-xs font-bold transition-all uppercase tracking-widest flex items-center justify-center gap-2",
                    isGenerating ? "bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed" : "text-blue-500 hover:text-white hover:bg-blue-600 hover:border-blue-600"
                )}
             >
                {isGenerating ? (
                    <>
                        <Activity className="w-3 h-3 animate-spin" />
                        Analyzing via Local LLM...
                    </>
                ) : (
                    <>
                        <Zap className="w-3 h-3" />
                        Regenerate Signals
                    </>
                )}
             </button>
          </Card>
        </div>
      </div>

      {/* Sidebar Section */}
      <div className="col-span-12 lg:col-span-4 space-y-6">
        <Card title="Market Heatmap" icon={Filter}>
            <div className="grid grid-cols-4 gap-1 h-32">
                {stocks.map(s => (
                    <div 
                        key={s.symbol} 
                        onClick={() => onSelectStock(s.symbol)}
                        className={cn(
                            "rounded-sm transition-all duration-500 cursor-pointer hover:ring-2 hover:ring-white/20 select-none",
                            s.changePct > 2 ? "bg-emerald-600" : 
                            s.changePct > 0 ? "bg-emerald-900" : 
                            s.changePct < -2 ? "bg-rose-600" : "bg-rose-900"
                        )}
                        title={`${s.symbol}: ${s.changePct}%`}
                    />
                ))}
            </div>
            <div className="flex justify-between text-[10px] font-bold text-slate-500 mt-2">
                <span>BEARISH</span>
                <span>BULLISH</span>
            </div>
        </Card>

        <Card title="Live Market News" icon={Activity}>
            <div className="flex gap-2 mb-4 overflow-x-auto hide-scrollbar pb-1">
                {['All', 'Market', 'Stock', 'Economy'].map(cat => (
                    <button 
                        key={cat}
                        onClick={() => setNewsFilter(cat)}
                        className={cn(
                            "px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-tighter border transition-all shrink-0",
                            newsFilter === cat ? "bg-blue-600 border-blue-600 text-white" : "bg-slate-950 border-slate-800 text-slate-500 hover:text-white"
                        )}
                    >
                        {cat}
                    </button>
                ))}
            </div>
            <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 hide-scrollbar">
                {filteredNews.map((item) => (
                    <div key={item.id} className="group cursor-pointer">
                        <div className="flex gap-2 items-center mb-1">
                            <span className={cn(
                                "text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter",
                                item.category === 'Economy' ? "bg-amber-500/10 text-amber-500" :
                                item.category === 'Stock' ? "bg-blue-500/10 text-blue-500" : "bg-purple-500/10 text-purple-500"
                            )}>
                                {item.category}
                            </span>
                            <span className="text-[8px] font-bold text-slate-600 uppercase tracking-widest">{item.time}</span>
                            <span className="text-[8px] font-black text-slate-800 mx-1">•</span>
                            <span className="text-[8px] font-black text-blue-500/70 uppercase tracking-widest">{item.source}</span>
                        </div>
                        <h4 className="text-xs font-bold text-slate-200 leading-snug group-hover:text-blue-400 transition-colors line-clamp-2">
                            {item.title}
                        </h4>
                        <p className="text-[10px] text-slate-500 line-clamp-2 mt-1 italic leading-relaxed">
                            {item.summary}
                        </p>
                        <div className="flex gap-1 mt-2 flex-wrap">
                            {item.relatedSymbols?.map(symbol => (
                                <span key={symbol} className="text-[8px] font-black text-slate-500 bg-slate-950 px-1 border border-slate-800 rounded">
                                    ${symbol}
                                </span>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            <button className="w-full mt-6 py-2 border border-slate-800 rounded-xl text-xs font-bold text-slate-500 hover:text-white hover:border-slate-700 transition-all uppercase tracking-widest">
                Browse News Hub
            </button>
        </Card>

        <Card title="Portfolio Snapshot" icon={PieChart}>
           <div className="text-center py-4">
              <h4 className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-1">Unrealized Gain</h4>
              <p className="text-3xl font-black text-white">₹12,450.40</p>
              <div className="flex items-center justify-center gap-2 mt-2 text-emerald-400 font-bold text-sm">
                <ArrowUpRight className="w-4 h-4" />
                +₹450.20 (3.20%)
              </div>
           </div>
           <div className="mt-4 border-t border-slate-800 pt-4 space-y-3">
             <div className="flex justify-between text-xs">
               <span className="text-slate-500 font-medium tracking-tight">Invested Value</span>
               <span className="text-white font-bold">₹380,000.00</span>
             </div>
             <div className="flex justify-between text-xs">
               <span className="text-slate-500 font-medium tracking-tight">Daily Change</span>
               <span className="text-emerald-400 font-bold">+₹1,240</span>
             </div>
           </div>
        </Card>

        <div className="relative group cursor-pointer overflow-hidden rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-800 p-6 shadow-2xl">
           <div className="relative z-10">
             <h3 className="text-white font-black text-xl leading-tight">ADVANCED BACKTESTING<br/>ENGINE</h3>
             <p className="text-blue-100/70 text-[10px] font-bold mt-2 uppercase tracking-widest">Test strategies against 10yr NSE history</p>
             <button className="mt-6 bg-white text-blue-900 text-xs font-black px-4 py-2 rounded-lg items-center inline-flex gap-2 group-hover:gap-3 transition-all">
                TRY BETA <ArrowUpRight className="w-3 h-3" />
             </button>
           </div>
           <History className="absolute -right-4 -bottom-4 w-32 h-32 text-white/10 -rotate-12 group-hover:scale-110 transition-transform" />
        </div>
      </div>
    </div>
  );
};
 const Screener: React.FC<{ 
  onSelectStock: (symbol: string) => void; 
  watchlist: string[]; 
  onToggleWatchlist: (symbol: string) => void;
}> = ({ onSelectStock, watchlist, onToggleWatchlist }) => {
  const [filter, setFilter] = useState('All');
  const [activeScanner, setActiveScanner] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<string>('symbol');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [activeTab, setActiveTab] = useState<'fundamental' | 'technical'>('fundamental');
  
  // Specific Fundamental Filters
  const [minPe, setMinPe] = useState<number | undefined>(undefined);
  const [maxPe, setMaxPe] = useState<number | undefined>(undefined);
  const [minRoe, setMinRoe] = useState<number | undefined>(undefined);
  const [maxPb, setMaxPb] = useState<number | undefined>(undefined);
  const [maxDe, setMaxDe] = useState<number | undefined>(undefined);
  
  // Advanced Screener Filters
  const [minVolume, setMinVolume] = useState<number>(0);
  const [minMktCap, setMinMktCap] = useState<number>(0);
  const [selectedSector, setSelectedSector] = useState<string>('All');
  const [selectedTimeframes, setSelectedTimeframes] = useState<string[]>(['1h', 'D']);

  const { data: stocks, isLoading: stocksLoading } = trpc.getScreenerResults.useQuery(
    { 
      filter, 
      sector: selectedSector,
      minPe,
      maxPe,
      minRoe,
      maxPb,
      maxDe
    },
    { enabled: filter !== 'External' && activeTab === 'fundamental' }
  );

  const { data: scannerGroups } = trpc.getMarketScanners.useQuery();
  
  const { data: marketData, isLoading: marketLoading } = trpc.fetchMarketData.useQuery(
    { 
      provider: activeScanner?.provider, 
      params: activeScanner?.provider === 'mc' ? {
        type: activeScanner.type, catId: activeScanner.catId, scanId: activeScanner.scanId
      } : activeScanner?.provider === 'custom' ? {
        timeframes: selectedTimeframes,
        minVolume,
        minMktCap,
        sector: selectedSector
      } : {
        screenerId: activeScanner?.screenerId, queryCondition: activeScanner?.queryCondition
      }
    },
    { enabled: !!activeScanner && activeTab === 'technical' }
  );

  const handleScannerSelect = (scanner: any) => {
    setFilter('External');
    setActiveScanner(scanner);
    setActiveTab('technical');
  };

  const isLoading = (activeTab === 'fundamental' && stocksLoading) || (activeTab === 'technical' && marketLoading);

  // Process data based on provider
  let displayStocks: any[] = [];
  let displayColumns: string[] = [];

  if (activeTab === 'technical' && activeScanner?.provider === 'mc') {
    displayStocks = marketData?.data?.list?.scannerDetails || [];
    displayColumns = displayStocks[0]?.columns?.map((c: any) => c.name) || [];
  } else if (activeTab === 'technical' && activeScanner?.provider === 'custom') {
    displayStocks = marketData?.data?.list?.scannerDetails || [];
    displayColumns = ['timeframesMet', 'momentum', 'pattern', 'mktCap'];
  } else if (activeTab === 'technical' && activeScanner?.provider === 'et') {
    displayStocks = marketData?.searchResult?.searchData?.records || [];
    // ETnow usually returns column names in a header or we can skip and show basic info
    const firstStock = displayStocks[0];
    if (firstStock) {
      displayColumns = Object.keys(firstStock).filter(k => 
        !['stkId', 'stkname', 'ltp', 'perChg', 'scUrl', 'symbol', 'name', 'companyName', 'recoid', 'id'].includes(k)
      ).slice(0, 4); // Limit to key columns
    }
  } else if (activeTab === 'fundamental') {
    displayStocks = stocks || [];
    displayColumns = ['pe', 'roe', 'pb', 'debtEquity'];
  }

  const processedStocks = displayStocks.filter(s => {
    const symbol = s.symbol || s.stkId || s.ticker || "";
    const name = s.name || s.stkname || s.companyName || "";
    const matchesSearch = symbol.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  }).sort((a, b) => {
    let aVal: any, bVal: any;
    
    if (activeTab === 'fundamental') {
      aVal = (a as any)[sortField];
      bVal = (b as any)[sortField];
    } else {
      // For external, we mostly sort by price or change if available
      if (sortField === 'ltp' || sortField === 'price') {
         aVal = parseFloat(a.ltp || a.price || a.lastPrice || 0);
         bVal = parseFloat(b.ltp || b.price || b.lastPrice || 0);
      } else if (sortField === 'perChg' || sortField === 'changePct') {
         aVal = parseFloat(a.perChg || a.changePct || a.percentageChange || 0);
         bVal = parseFloat(b.perChg || b.changePct || b.percentageChange || 0);
      } else {
         aVal = (a.stkname || a.companyName || a.symbol || "").toLowerCase();
         bVal = (b.stkname || b.companyName || b.symbol || "").toLowerCase();
      }
    }

    if (aVal === undefined || aVal === null) return 1;
    if (bVal === undefined || bVal === null) return -1;
    
    if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <Card 
        title={activeScanner ? `Market Intelligence: ${activeScanner.name}` : "Elite Stock Discovery"} 
        icon={Filter}
      >
        <div className="flex flex-col gap-10 mb-8">
           {activeScanner && (
             <div className="p-5 bg-emerald-500/5 border border-emerald-500/20 rounded-3xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 blur-3xl -mr-16 -mt-16 group-hover:bg-emerald-500/20 transition-colors" />
                <div className="relative z-10">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <h3 className="text-base font-black text-white italic tracking-tight uppercase">
                      {activeScanner.provider === 'mc' ? (marketData?.data?.list?.scannerName || activeScanner.name) : activeScanner.name}
                    </h3>
                  </div>
                  <p className="text-xs text-slate-500 font-medium leading-relaxed italic max-w-2xl">
                    {activeScanner.provider === 'mc' ? (marketData?.data?.list?.scannerDescription || "Advanced technical analysis for professional trading.") : "Strategic fundamental screening powered by Economic Times Intelligence."}
                  </p>
                </div>
             </div>
           )}

           <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              <div className="lg:col-span-3 space-y-6">
                <div className="space-y-4">
                  <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Zap className="w-3 h-3 text-blue-500" /> System Presets
                  </h4>
                  <div className="flex flex-col gap-2">
                    {['All', 'Gainers', 'Losers', 'High ROE', 'Low Debt', 'Near 52W High', 'Near 52W Low'].map(tag => (
                      <button 
                          key={tag} 
                          onClick={() => { setFilter(tag); setActiveScanner(null); }}
                          className={cn(
                              "px-4 py-2.5 rounded-xl text-[10px] font-black tracking-widest transition-all border uppercase text-left",
                              (filter === tag && !activeScanner) ? "bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20" : "bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-white"
                          )}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-800/50">
                  <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Filter className="w-3 h-3 text-emerald-500" /> Fundamental Gears
                  </h4>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Max P/E Ratio</label>
                       <input 
                          type="range" min="0" max="60" step="5" 
                          value={maxPe || 60} 
                          onChange={(e) => setMaxPe(parseInt(e.target.value))}
                          className="w-full accent-blue-500 h-1 bg-slate-900 rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-500"><span>0</span><span>{maxPe || 60}</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Min ROE %</label>
                       <input 
                          type="range" min="0" max="40" step="5" 
                          value={minRoe || 0} 
                          onChange={(e) => setMinRoe(parseInt(e.target.value))}
                          className="w-full accent-emerald-500 h-1 bg-slate-900 rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-500"><span>0</span><span>{minRoe || 0}%</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Max P/B Ratio</label>
                       <input 
                          type="range" min="0" max="15" step="1" 
                          value={maxPb || 15} 
                          onChange={(e) => setMaxPb(parseInt(e.target.value))}
                          className="w-full accent-indigo-500 h-1 bg-slate-900 rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-500"><span>0</span><span>{maxPb || 15}</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Max D/E Ratio</label>
                       <input 
                          type="range" min="0" max="3" step="0.5" 
                          value={maxDe || 3} 
                          onChange={(e) => setMaxDe(parseFloat(e.target.value))}
                          className="w-full accent-rose-500 h-1 bg-slate-900 rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-500"><span>0</span><span>{maxDe || 3.0}</span></div>
                    </div>
                    <button 
                       onClick={() => { setMaxPe(undefined); setMinRoe(undefined); setMaxDe(undefined); setMaxPb(undefined); }}
                       className="w-full py-2 bg-slate-950 border border-slate-800 rounded-lg text-[8px] font-black text-slate-500 uppercase tracking-widest hover:border-slate-700 hover:text-slate-300 transition-all"
                    >
                       Reset Gears
                    </button>
                  </div>
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-800/50">
                  <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                    <TrendingUp className="w-3 h-3 text-rose-500" /> Breakout & Trend
                  </h4>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Min Market Cap (Cr)</label>
                       <select 
                          value={minMktCap}
                          onChange={(e) => setMinMktCap(parseInt(e.target.value))}
                          className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-[10px] font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                       >
                          <option value="0">All Caps</option>
                          <option value="500">500 Cr+</option>
                          <option value="2000">2,000 Cr+</option>
                          <option value="10000">10,000 Cr+</option>
                          <option value="50000">50,000 Cr+</option>
                       </select>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Sector Focus</label>
                       <select 
                          value={selectedSector}
                          onChange={(e) => setSelectedSector(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-[10px] font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                       >
                          <option value="All">All Sectors</option>
                          <option value="Energy">Energy</option>
                          <option value="IT">IT</option>
                          <option value="Banking">Banking</option>
                          <option value="Auto">Auto</option>
                          <option value="Healthcare">Healthcare</option>
                       </select>
                    </div>
                    <div className="space-y-2">
                       <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Timeframe Multi-Select</label>
                       <div className="grid grid-cols-2 gap-2">
                          {['15m', '1h', '4h', 'D', 'W'].map(tf => (
                            <button 
                              key={tf}
                              onClick={() => {
                                if (selectedTimeframes.includes(tf)) {
                                  setSelectedTimeframes(selectedTimeframes.filter(t => t !== tf));
                                } else {
                                  setSelectedTimeframes([...selectedTimeframes, tf]);
                                }
                              }}
                              className={cn(
                                "px-2 py-1.5 rounded-lg text-[9px] font-black tracking-widest border transition-all",
                                selectedTimeframes.includes(tf) ? "bg-blue-600 border-blue-600 text-white" : "bg-slate-950 border-slate-800 text-slate-500"
                              )}
                            >
                              {tf}
                            </button>
                          ))}
                       </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-9 space-y-8">
                {activeTab === 'technical' && scannerGroups?.map((group) => (
                  <div key={group.category} className="space-y-4">
                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">{group.category}</h4>
                    <div className="flex flex-wrap gap-2">
                      {group.items.map(scanner => (
                        <button 
                            key={scanner.id} 
                            onClick={() => handleScannerSelect(scanner)}
                            className={cn(
                                "px-4 py-2 rounded-xl text-[10px] font-black tracking-widest transition-all border uppercase",
                                activeScanner?.id === scanner.id ? "bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-500/20" : "bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-white"
                            )}
                        >
                          {scanner.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between pt-6 border-t border-slate-800/50">
              <div className="flex flex-col gap-4 w-full">
                <div className="flex items-center gap-3">
                   <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Quick Technical Screener:</h4>
                   <div className="flex flex-wrap gap-2">
                      {[
                        { name: 'Bullish BO', id: 'mc-25-BPBULL' },
                        { name: 'RSI Power', id: 'mc-25-RSIPOWBO' },
                        { name: '52W High', id: 'mc-17-52HIGH' },
                        { name: '52W Low', id: 'mc-17-52LOW' }
                      ].map(iq => (
                        <button 
                          key={iq.id}
                          onClick={() => {
                            const scanner = (scannerGroups as any)?.flatMap((g: any) => g.items).find((i: any) => i.id === iq.id);
                            if (scanner) handleScannerSelect(scanner);
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-lg text-[9px] font-bold tracking-tight uppercase border transition-all",
                            activeScanner?.id === iq.id ? "bg-blue-600 border-blue-600 text-white" : "bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700 hover:text-white"
                          )}
                        >
                          {iq.name}
                        </button>
                      ))}
                   </div>
                </div>
                
                <div className="relative w-full md:w-96">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input 
                    type="text" 
                    placeholder="Deep search assets..." 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-2xl py-3.5 pl-10 pr-4 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500 w-full transition-all"
                  />
                </div>
              </div>
              <div className="flex gap-3 shrink-0">
                <div className="flex bg-slate-950 border border-slate-800 p-1 rounded-2xl">
                   <button 
                    onClick={() => { setActiveTab('fundamental'); setFilter('All'); setActiveScanner(null); }}
                    className={cn(
                      "px-5 py-2.5 rounded-xl text-[10px] font-black tracking-widest uppercase transition-all",
                      activeTab === 'fundamental' ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300"
                    )}
                   >Fundamental</button>
                   <button 
                    onClick={() => setActiveTab('technical')}
                    className={cn(
                      "px-5 py-2.5 rounded-xl text-[10px] font-black tracking-widest uppercase transition-all",
                      activeTab === 'technical' ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300"
                    )}
                   >Technical</button>
                </div>
                <button className="flex items-center gap-2 bg-slate-950 text-slate-400 border border-slate-800 px-5 py-3 rounded-2xl text-[10px] font-black tracking-widest transition-all hover:text-white hover:border-slate-700 uppercase">
                  <Download className="w-3 h-3" />
                  Extract
                </button>
              </div>
         </div>

        <div className="overflow-x-auto rounded-3xl border border-slate-800/50 bg-slate-950/50 backdrop-blur-sm">
          {isLoading ? (
            <div className="py-48 flex flex-col items-center justify-center space-y-6">
              <div className="relative w-12 h-12">
                <div className="absolute inset-0 border-2 border-blue-500/20 rounded-full" />
                <div className="absolute inset-0 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] animate-pulse">Synchronizing Intelligence...</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-900/50 backdrop-blur-xl">
                  <th 
                    className="px-6 py-6 font-black text-[9px] text-slate-500 uppercase tracking-[0.25em] border-b border-slate-800 cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('symbol')}
                  >
                    Asset {sortField === 'symbol' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th 
                    className="px-6 py-6 font-black text-[9px] text-slate-500 uppercase tracking-[0.25em] border-b border-slate-800 text-right cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('price')}
                  >
                    LTP {sortField === 'price' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th 
                    className="px-6 py-6 font-black text-[9px] text-slate-500 uppercase tracking-[0.25em] border-b border-slate-800 text-center cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('changePct')}
                  >
                    Momentum {sortField === 'changePct' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  {displayColumns.map(col => (
                    <th key={col} className="px-6 py-6 font-black text-[9px] text-slate-500 uppercase tracking-[0.25em] border-b border-slate-800 text-center">{col}</th>
                  ))}
                  <th className="px-6 py-6 font-black text-[9px] text-slate-500 uppercase tracking-[0.25em] border-b border-slate-800 text-right">Direct</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {processedStocks.map((row: any, idx: number) => {
                  const symbol = row.symbol || row.stkId || row.ticker;
                  const name = row.name || row.stkname || row.companyName || "";
                  const ltp = row.price || row.ltp || row.lastPrice || 0;
                  const perChg = row.changePct || row.perChg || row.percentageChange || 0;
                  
                  return (
                    <tr 
                      key={idx} 
                      onClick={() => onSelectStock(symbol)}
                      className="hover:bg-slate-800/20 group transition-all cursor-pointer"
                    >
                      <td className="px-6 py-6" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-3">
                          <button 
                            onClick={() => onToggleWatchlist(symbol)}
                            className={cn(
                              "p-2 rounded-xl border transition-all",
                              watchlist.includes(symbol) ? "bg-amber-500/10 border-amber-500/20 text-amber-500" : "bg-slate-900/50 border-slate-800 text-slate-700 hover:text-slate-400"
                            )}
                          >
                            <WatchlistIcon className={cn("w-3.5 h-3.5", watchlist.includes(symbol) && "fill-amber-500")} />
                          </button>
                          <div className="cursor-pointer" onClick={() => onSelectStock(symbol)}>
                            <div className="font-black text-white text-xs tracking-tight group-hover:text-blue-400 transition-colors uppercase">{symbol}</div>
                            <div className="text-[8px] text-slate-600 font-bold tracking-widest mt-1 uppercase italic truncate max-w-[150px]">{name}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-6 text-right font-black text-xs tabular-nums text-white">₹{parseFloat(ltp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      <td className="px-6 py-6 text-center">
                        <span className={cn(
                          "font-black text-[10px] tabular-nums px-3 py-1.5 rounded-lg border",
                          parseFloat(perChg) >= 0 ? "text-emerald-400 bg-emerald-400/5 border-emerald-400/10" : "text-rose-400 bg-rose-400/5 border-rose-400/10"
                        )}>
                          {parseFloat(perChg) >= 0 ? '+' : ''}{parseFloat(perChg).toFixed(2)}%
                        </span>
                      </td>
                      {activeTab === 'fundamental' ? (
                        ['pe', 'roe', 'pb', 'debtEquity'].map(f => (
                          <td key={f} className="px-6 py-6 text-center font-bold text-[10px] text-slate-400 uppercase tracking-widest">
                            {row[f]?.toFixed(2) || '-'}
                          </td>
                        ))
                      ) : (
                        (row.columns || displayColumns.map(c => ({ name: c, value: row[c] }))).map((c: any, cidx: number) => (
                          <td key={cidx} className="px-6 py-6 text-center font-bold text-[10px] text-slate-300 uppercase italic">
                            {c.value || '-'}
                          </td>
                        ))
                      )}
                      <td className="px-6 py-6 text-right">
                         <button className="p-2.5 bg-slate-900 border border-slate-800 rounded-xl text-slate-500 hover:text-white hover:border-slate-600 transition-all">
                            <ArrowUpRight className="w-4 h-4" />
                         </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  </div>
</Card>
</div>
);
};

const OptionChain: React.FC<{ symbol: string; stockPrice: number }> = ({ symbol, stockPrice }) => {
  const { data: fno } = trpc.getFnOSignals.useQuery({ symbol });
  
  // Generate strikes around current price
  const baseStrike = Math.round(stockPrice / 50) * 50;
  const strikes = Array.from({ length: 11 }, (_, i) => baseStrike + (i - 5) * 50);

  // Stats for the stock from signal data or defaults
  const ivRank = fno?.marketSentiment.ivRank || 42;
  const ivPercentile = fno?.marketSentiment.ivPercentile || 68;

  const getGreeks = (strike: number, type: 'CALL' | 'PUT') => {
    const isCall = type === 'CALL';
    const itm = isCall ? stockPrice > strike : stockPrice < strike;
    const diff = Math.abs(stockPrice - strike) / stockPrice;
    
    // Mock calculations
    const delta = isCall 
      ? (itm ? 0.5 + (1 - diff) * 0.4 : 0.5 - diff * 0.4)
      : (itm ? -0.5 - (1 - diff) * 0.4 : -0.5 + diff * 0.4);
    
    const gamma = 0.002 * (1 - diff * 5);
    const theta = -15 * (1 + diff);
    const vega = 0.12 * (1 - diff * 3);
    const iv = 18 + diff * 20;

    return {
      delta: delta.toFixed(2),
      gamma: gamma.toFixed(4),
      theta: theta.toFixed(2),
      vega: vega.toFixed(3),
      iv: iv.toFixed(1) + '%',
      oi: Math.round(Math.random() * 50000).toLocaleString(),
      vol: Math.round(Math.random() * 200000).toLocaleString(),
      bid: (itm ? (Math.abs(stockPrice - strike) + 5) : 5 + Math.random() * 5).toFixed(2),
      ask: (itm ? (Math.abs(stockPrice - strike) + 6) : 6 + Math.random() * 5).toFixed(2),
    };
  };

  return (
    <div className="space-y-6">
      {/* IV Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">IV Rank</p>
            <p className="text-2xl font-black text-white italic">{ivRank}</p>
          </div>
          <div className="w-16 h-16 relative">
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie
                  data={[{ value: ivRank }, { value: 100 - ivRank }]}
                  innerRadius="80%"
                  outerRadius="100%"
                  paddingAngle={0}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                >
                  <Cell fill="#3b82f6" />
                  <Cell fill="#1e293b" />
                </Pie>
              </RePieChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">IV Percentile</p>
            <p className="text-2xl font-black text-emerald-400 italic">{ivPercentile}%</p>
          </div>
          <div className="w-16 h-16 relative">
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie
                  data={[{ value: ivPercentile }, { value: 100 - ivPercentile }]}
                  innerRadius="80%"
                  outerRadius="100%"
                  paddingAngle={0}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                >
                  <Cell fill="#10b981" />
                  <Cell fill="#1e293b" />
                </Pie>
              </RePieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Option Chain Table */}
      <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/50">
        <table className="w-full text-left border-collapse min-w-[1000px]">
          <thead>
            <tr className="bg-slate-900">
              <th colSpan={4} className="px-4 py-2 text-center text-[10px] font-black uppercase text-blue-500 border-b border-slate-800">Calls</th>
              <th className="px-4 py-2 text-center text-[10px] font-black uppercase text-slate-400 border-b border-slate-800">Strike</th>
              <th colSpan={4} className="px-4 py-2 text-center text-[10px] font-black uppercase text-rose-500 border-b border-slate-800">Puts</th>
            </tr>
            <tr className="bg-slate-900/50">
              {['OI', 'Delta', 'IV', 'Vol', 'Bid/Ask'].map(h => (
                <th key={`c-${h}`} className="px-3 py-3 text-[8px] font-black uppercase text-slate-500 tracking-widest text-center">{h}</th>
              ))}
              <th className="px-3 py-3 text-[8px] font-black uppercase text-white tracking-widest text-center bg-slate-800">Price</th>
              {['Bid/Ask', 'Vol', 'IV', 'Delta', 'OI'].map(h => (
                <th key={`p-${h}`} className="px-3 py-3 text-[8px] font-black uppercase text-slate-500 tracking-widest text-center">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {strikes.map(strike => {
              const call = getGreeks(strike, 'CALL');
              const put = getGreeks(strike, 'PUT');
              const isAtTheMoney = Math.abs(stockPrice - strike) < 25;

              return (
                <tr key={strike} className={cn(
                  "hover:bg-slate-900/40 transition-colors text-center",
                  isAtTheMoney && "bg-blue-600/5"
                )}>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-500">{call.oi}</td>
                  <td className="px-3 py-4 text-[10px] font-bold text-emerald-400">{call.delta}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{call.iv}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{call.vol}</td>
                  <td className="px-3 py-4 text-[10px] font-bold text-white tracking-tighter">
                    {call.bid} <span className="text-slate-600">/</span> {call.ask}
                  </td>
                  <td className="px-3 py-4 text-xs font-black text-white bg-slate-800/30 border-x border-slate-800 tabular-nums">₹{strike}</td>
                  <td className="px-3 py-4 text-[10px] font-bold text-white tracking-tighter">
                    {put.bid} <span className="text-slate-600">/</span> {put.ask}
                  </td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{put.vol}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{put.iv}</td>
                  <td className="px-3 py-4 text-[10px] font-bold text-rose-400">{put.delta}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-500">{put.oi}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Card title="Greeks Analysis (Portfolio Impact)" icon={Activity}>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={strikes.map(s => ({ 
              strike: s, 
              delta: parseFloat(getGreeks(s, 'CALL').delta),
              theta: Math.abs(parseFloat(getGreeks(s, 'CALL').theta)) / 30, // normalized
              vega: parseFloat(getGreeks(s, 'CALL').vega) * 8 // scaled
            }))}>
              <XAxis dataKey="strike" hide />
              <YAxis hide />
              <Tooltip 
                contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                itemStyle={{ fontSize: '11px', fontWeight: 'bold' }}
              />
              <Area type="monotone" dataKey="delta" stroke="#10b981" fill="#10b981" fillOpacity={0.1} name="Delta" />
              <Area type="monotone" dataKey="theta" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.1} name="Theta" />
              <Area type="monotone" dataKey="vega" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} name="Vega" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="grid grid-cols-4 gap-4 mt-6">
           {['Delta', 'Gamma', 'Theta', 'Vega'].map(g => (
             <div key={g} className="text-center p-3 bg-slate-950 rounded-xl border border-slate-800">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{g}</p>
                <div className={cn(
                  "h-1 rounded-full mb-1",
                  g === 'Delta' ? 'bg-emerald-500' : g === 'Theta' ? 'bg-rose-500' : 'bg-blue-500'
                )} />
                <p className="text-[10px] font-bold text-slate-300">
                  {g === 'Gamma' ? '0.0024' : Math.random().toFixed(2)}
                </p>
             </div>
           ))}
        </div>
      </Card>
    </div>
  );
};

const MarketMap: React.FC = () => {
  const [activeInd, setActiveInd] = useState('9'); // Nifty 50 default index
  const { data: indices } = trpc.getAllIndices.useQuery();
  const { data: indicesOverview } = trpc.getMarketOverview.useQuery();

  const handleIndChange = (val: string) => {
    setActiveInd(val);
  };

  const indexList = indices?.data?.indexList || [];
  const quickIndices = [
    { id: '9', name: 'Nifty 50' },
    { id: '4', name: 'Sensex' },
    { id: '23', name: 'Bank Nifty' },
    { id: '27', name: 'Midcap 100' },
    { id: '7', name: 'Nifty 500' },
  ];

  const currentIndexData = indexList.find((i: any) => i.indId === activeInd);
  const selectedIndexName = quickIndices.find(i => i.id === activeInd)?.name || 
                           currentIndexData?.name || 'Index';

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
        <div>
          <h2 className="text-3xl font-black text-white italic tracking-tighter uppercase flex items-center gap-3">
            <PieChart className="w-8 h-8 text-blue-500" />
            Market Intelligence Map
          </h2>
          <div className="flex items-center gap-3 mt-1">
             <p className="text-slate-500 text-xs font-bold uppercase tracking-widest italic">
               Analyzing sector rotation within <span className="text-white">{selectedIndexName}</span> context
             </p>
             {currentIndexData && (
                <div className="flex items-center gap-2 bg-slate-900 px-3 py-1 rounded-lg border border-slate-800">
                   <span className="text-xs font-black text-white tabular-nums">{parseFloat(currentIndexData.lastprice).toLocaleString()}</span>
                   <span className={cn(
                      "text-[10px] font-bold flex items-center gap-0.5",
                      parseFloat(currentIndexData.percentchange) >= 0 ? "text-emerald-400" : "text-rose-400"
                   )}>
                      {parseFloat(currentIndexData.percentchange) >= 0 ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {Math.abs(parseFloat(currentIndexData.percentchange)).toFixed(2)}%
                   </span>
                </div>
             )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {quickIndices.map(idx => (
            <button
              key={idx.id}
              onClick={() => handleIndChange(idx.id)}
              className={cn(
                "px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all",
                activeInd === idx.id 
                  ? "bg-blue-600 border-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]" 
                  : "bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700"
              )}
            >
              {idx.name}
            </button>
          ))}
          <div className="w-[1px] h-8 bg-slate-800 mx-2 hidden md:block" />
          <select 
            value={activeInd} 
            onChange={(e) => handleIndChange(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">More Indices...</option>
            {indexList.map((idx: any) => (
              <option key={idx.indId} value={idx.indId}>{idx.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <SectorHeatmap indexId={activeInd} />
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Card title="Distribution Analysis" icon={BarChart3}>
            <div className="h-48 pt-4">
              <ResponsiveContainer width="100%" height="100%">
                 <BarChart data={[{ name: 'Bullish', val: 65 }, { name: 'Neutral', val: 20 }, { name: 'Bearish', val: 15 }]}>
                    <XAxis dataKey="name" hide />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b' }} />
                    <Bar dataKey="val" fill="#3b82f6" radius={[8, 8, 0, 0]}>
                       <Cell fill="#10b981" />
                       <Cell fill="#3b82f6" />
                       <Cell fill="#f43f5e" />
                    </Bar>
                 </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between mt-4">
               <div className="text-center">
                  <p className="text-[9px] font-black text-emerald-500 uppercase">Advancing</p>
                  <p className="text-lg font-black text-white italic">32</p>
               </div>
               <div className="text-center">
                  <p className="text-[9px] font-black text-rose-500 uppercase">Declining</p>
                  <p className="text-lg font-black text-white italic">18</p>
               </div>
               <div className="text-center">
                  <p className="text-[9px] font-black text-slate-500 uppercase">Unchanged</p>
                  <p className="text-lg font-black text-white italic">0</p>
               </div>
            </div>
          </Card>

          <Card title="Market Sentiment" icon={BrainCircuit}>
             <div className="space-y-6 pt-4">
                <div className="flex items-center gap-4">
                   <div className="relative w-20 h-20">
                      <svg className="w-full h-full" viewBox="0 0 100 100">
                         <circle className="text-slate-800" strokeWidth="8" stroke="currentColor" fill="transparent" r="40" cx="50" cy="50" />
                         <circle className="text-blue-500" strokeWidth="8" strokeDasharray="251.2" strokeDashoffset={251.2 * (1 - 0.72)} strokeLinecap="round" stroke="currentColor" fill="transparent" r="40" cx="50" cy="50" />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                         <span className="text-lg font-black text-white italic">72%</span>
                      </div>
                   </div>
                   <div>
                      <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest">Greed/Fear Index</p>
                      <h4 className="text-xl font-black text-white italic tracking-tighter uppercase whitespace-nowrap">Extreme Optimism</h4>
                   </div>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed italic font-medium">
                  The current sector rotation suggests institutional accumulation in defensive pockets like Healthcare while IT remains volatile.
                </p>
             </div>
          </Card>

          <Card title="Top Sector Insights" icon={Zap}>
             <div className="space-y-4 pt-2">
                <div className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl flex justify-between items-center">
                   <div>
                      <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">Leader</p>
                      <p className="text-sm font-black text-white italic tracking-tight">Nifty Auto</p>
                   </div>
                   <TrendingUp className="text-emerald-500 w-5 h-5" />
                </div>
                <div className="p-3 bg-rose-500/5 border border-rose-500/20 rounded-xl flex justify-between items-center">
                   <div>
                      <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest">Laggard</p>
                      <p className="text-sm font-black text-white italic tracking-tight">Nifty IT</p>
                   </div>
                   <TrendingDown className="text-rose-500 w-5 h-5" />
                </div>
             </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

const Backtest: React.FC = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<any>(null);
  const [symbol, setSymbol] = useState('RELIANCE');
  const [timeframe, setTimeframe] = useState('Daily Candlesticks');
  
  // Strategy Parameters
  const [rsiUpper, setRsiUpper] = useState(70);
  const [rsiLower, setRsiLower] = useState(30);
  const [emaShort, setEmaShort] = useState(20);
  const [emaLong, setEmaLong] = useState(50);
  const [strategyName, setStrategyName] = useState('');
  const [showSaveModal, setShowSaveModal] = useState(false);

  const utils = trpc.useContext();
  const { data: savedStrategies } = trpc.getBacktestStrategies.useQuery();

  const backtestMutation = trpc.runBacktest.useMutation({
    onSuccess: (data) => {
      setResults(data);
      setIsRunning(false);
    },
    onError: () => {
      setIsRunning(false);
    }
  });

  const saveStrategyMutation = trpc.saveBacktestStrategy.useMutation({
    onSuccess: () => {
      utils.getBacktestStrategies.invalidate();
      setShowSaveModal(false);
      setStrategyName('');
    }
  });

  const startBacktest = () => {
    setIsRunning(true);
    setResults(null);
    backtestMutation.mutate({ 
      symbol, 
      strategy: 'Custom RSI+EMA', 
      period: timeframe === 'Daily Candlesticks' ? '1D' : timeframe === '1H Momentum' ? '1H' : '15M',
      params: { rsiUpper, rsiLower, emaShort, emaLong }
    });
  };

  const handleSaveStrategy = () => {
    if (!strategyName) return;
    saveStrategyMutation.mutate({
      name: strategyName,
      symbol,
      timeframe,
      params: { rsiUpper, rsiLower, emaShort, emaLong }
    });
  };

  const loadStrategy = (s: any) => {
    setSymbol(s.symbol);
    setTimeframe(s.timeframe);
    setRsiUpper(s.params.rsiUpper);
    setRsiLower(s.params.rsiLower);
    setEmaShort(s.params.emaShort);
    setEmaLong(s.params.emaLong);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 space-y-6">
          <Card title="Strategy Parameters" icon={Filter}>
            <div className="space-y-5">
               <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Target Symbol</label>
                 <input 
                    type="text" 
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500 uppercase"
                    placeholder="e.g. RELIANCE"
                 />
               </div>

               <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Timeframe</label>
                 <select 
                    value={timeframe}
                    onChange={(e) => setTimeframe(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                 >
                   <option>Daily Candlesticks</option>
                   <option>1H Momentum</option>
                   <option>15M Scalping</option>
                 </select>
               </div>

               <div className="pt-4 border-t border-slate-800/50 space-y-4">
                  <h4 className="text-[10px] font-black text-blue-500 uppercase tracking-[0.2em] mb-2">Technical Indicators</h4>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">RSI Upper (Sell)</label>
                      <input 
                        type="number" value={rsiUpper} onChange={(e) => setRsiUpper(parseInt(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">RSI Lower (Buy)</label>
                      <input 
                        type="number" value={rsiLower} onChange={(e) => setRsiLower(parseInt(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">EMA Short Period</label>
                      <input 
                        type="number" value={emaShort} onChange={(e) => setEmaShort(parseInt(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest">EMA Long Period</label>
                      <input 
                        type="number" value={emaLong} onChange={(e) => setEmaLong(parseInt(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-bold text-white"
                      />
                    </div>
                  </div>
               </div>

               <div className="pt-6 flex gap-2">
                 <button 
                   onClick={startBacktest}
                   disabled={isRunning}
                   className={cn(
                     "flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl text-[10px] tracking-widest uppercase transition-all shadow-lg shadow-blue-500/20",
                     isRunning && "opacity-50 cursor-not-allowed"
                   )}
                 >
                   {isRunning ? "Running..." : "Run Backtest"}
                 </button>
                 <button 
                   onClick={() => setShowSaveModal(true)}
                   className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-slate-400 hover:text-white hover:border-slate-700 transition-all"
                   title="Save Strategy"
                 >
                   <Save className="w-4 h-4" />
                 </button>
               </div>
            </div>
          </Card>

          {savedStrategies && savedStrategies.length > 0 && (
            <Card title="Saved Strategies" icon={Bookmark}>
              <div className="space-y-3 pt-2">
                {savedStrategies.map((s: any) => (
                  <button
                    key={s.id}
                    onClick={() => loadStrategy(s)}
                    className="w-full text-left p-3 bg-slate-950 border border-slate-800 rounded-xl hover:border-blue-500 transition-all group"
                  >
                    <p className="text-xs font-black text-white italic group-hover:text-blue-400 uppercase tracking-tight">{s.name}</p>
                    <div className="flex gap-2 mt-1">
                      <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">{s.symbol}</span>
                      <span className="text-[8px] font-bold text-slate-700 uppercase tracking-widest">•</span>
                      <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">{s.timeframe}</span>
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="lg:col-span-8">
          <Card title="Simulation Analysis" icon={Activity} className="h-full">
            {!results && (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center p-12 text-center relative overflow-hidden">
                <div className="w-24 h-24 bg-blue-600/10 rounded-full flex items-center justify-center mb-6">
                  <Activity className={cn("text-blue-500 w-12 h-12", isRunning && "animate-pulse")} />
                </div>
                <h4 className="text-white font-black text-2xl italic uppercase tracking-tighter">AI Scenario Simulation</h4>
                <p className="text-slate-500 text-sm mt-3 max-w-sm mx-auto leading-relaxed">
                  {isRunning ? "Simulating thousands of trade paths across 10 years of market data history..." : "Adjust your strategy parameters on the left and initiate the simulation to validate your edge."}
                </p>
                {isRunning && (
                  <div className="mt-8 w-48 h-1 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                    <motion.div 
                      initial={{ left: '-100%' }}
                      animate={{ left: '100%' }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                      className="absolute top-0 h-1 w-1/3 bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.8)]"
                    />
                  </div>
                )}
              </div>
            )}

            {results && (
              <div className="space-y-8 animate-in fade-in duration-500">
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                   {[
                     { label: 'Returns', value: `+${results.totalReturn}%`, icon: TrendingUp, color: 'text-emerald-400' },
                     { label: 'Profit Factor', value: results.profitFactor, icon: Activity, color: 'text-blue-400' },
                     { label: 'Win Rate', value: `${results.winRate}%`, icon: Zap, color: 'text-amber-400' },
                     { label: 'Max DD', value: `${results.maxDrawdown}%`, icon: ArrowDownRight, color: 'text-rose-400' },
                   ].map(stat => (
                     <div key={stat.label} className="p-5 bg-slate-950 border border-slate-800 rounded-2xl relative overflow-hidden group">
                       <stat.icon className="w-4 h-4 text-slate-800 absolute -right-1 -top-1 scale-[300%] rotate-12 opacity-50 group-hover:scale-[400%] transition-transform" />
                       <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest relative z-10">{stat.label}</p>
                       <p className={cn("text-2xl font-black mt-2 relative z-10 tracking-tighter", stat.color)}>{stat.value}</p>
                     </div>
                   ))}
                 </div>

                 <div className="p-6 bg-slate-950 rounded-3xl border border-slate-800">
                   <div className="flex justify-between items-center mb-8">
                     <div>
                       <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Equity Growth</h5>
                       <p className="text-sm font-black text-white italic">Backtest Period: 2014 - 2024</p>
                     </div>
                     <div className="flex gap-6">
                        <div className="flex items-center gap-2">
                           <div className="w-2.5 h-2.5 bg-blue-500 rounded-full" />
                           <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Portfolio</span>
                        </div>
                        <div className="flex items-center gap-2">
                           <div className="w-2.5 h-2.5 bg-rose-500/20 border border-rose-500 rounded-full" />
                           <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Drawdown</span>
                        </div>
                     </div>
                   </div>
                   <div className="h-80">
                     <ResponsiveContainer width="100%" height="100%">
                       <AreaChart data={results.history}>
                         <defs>
                           <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                             <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                             <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                           </linearGradient>
                           <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
                             <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.1}/>
                             <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                           </linearGradient>
                         </defs>
                         <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                         <XAxis dataKey="day" hide />
                         <YAxis yAxisId="left" hide domain={['auto', 'auto']} />
                         <YAxis yAxisId="right" hide orientation="right" domain={[-20, 0]} />
                         <Tooltip 
                           contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                           labelStyle={{ color: '#64748b', fontSize: '10px', fontWeight: 'bold' }}
                           itemStyle={{ fontSize: '12px', fontWeight: 'bold', color: '#fff' }}
                         />
                         <Area yAxisId="left" type="monotone" dataKey="equity" stroke="#3b82f6" fillOpacity={1} fill="url(#equityGradient)" strokeWidth={3} />
                         <Area yAxisId="right" type="monotone" dataKey="drawdown" stroke="#f43f5e" fillOpacity={1} fill="url(#drawdownGradient)" strokeWidth={1} strokeDasharray="3 3" />
                       </AreaChart>
                     </ResponsiveContainer>
                   </div>
                 </div>

                 <div className="p-6 bg-blue-500/10 border border-blue-500/20 rounded-3xl flex flex-col md:flex-row items-center justify-between gap-6 overflow-hidden relative">
                    <div className="absolute top-0 right-0 p-4 opacity-5">
                       <Zap className="w-32 h-32 text-blue-500" />
                    </div>
                    <div className="flex items-center gap-4 relative z-10">
                        <div className="w-12 h-12 bg-blue-500 text-blue-950 rounded-2xl flex items-center justify-center font-black italic">
                           AI
                        </div>
                        <div>
                            <h5 className="text-white font-black text-lg tracking-tight uppercase italic mb-1">Adaptive Strategy Intelligence</h5>
                            <p className="text-slate-400 font-medium text-xs max-w-md">Gemini has analyzed this strategy and recommends tightening the stop-loss during high volatility regimes to preserve the alpha generated.</p>
                        </div>
                    </div>
                    <button 
                      onClick={startBacktest}
                      className="px-6 py-3 bg-white text-blue-900 font-black rounded-xl text-[10px] tracking-widest uppercase hover:bg-blue-50 transition-all relative z-10"
                    >
                      Optimize Strategy
                    </button>
                 </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      <AnimatePresence>
        {showSaveModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSaveModal(false)}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl"
            >
              <h3 className="text-xl font-black text-white italic tracking-tighter uppercase mb-6">Name Your Strategy</h3>
              <div className="space-y-4">
                <input 
                  type="text" 
                  value={strategyName}
                  onChange={(e) => setStrategyName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-4 text-xs font-bold text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="e.g. Aggressive RSI Scalper"
                  autoFocus
                />
                <div className="flex gap-3 mt-4">
                  <button 
                    onClick={() => setShowSaveModal(false)}
                    className="flex-1 py-3 bg-slate-950 border border-slate-800 text-slate-500 font-black rounded-xl text-[10px] tracking-widest uppercase transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleSaveStrategy}
                    disabled={!strategyName}
                    className="flex-1 py-3 bg-blue-600 text-white font-black rounded-xl text-[10px] tracking-widest uppercase transition-all disabled:opacity-50"
                  >
                    Confirm Save
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

// --- Stock Details Page ---

const TechnicalAnalysis: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: tech, isLoading } = trpc.getTechnicalDetails.useQuery({ symbol });
  const { data: technicalScan, isLoading: scanLoading } = trpc.getTechnicalScan.useQuery({ symbol });
  const { data: ohlcData, isLoading: ohlcLoading } = trpc.getOHLCData.useQuery({ symbol, dur: '1y' });

  if (isLoading || scanLoading || ohlcLoading) return <div className="p-20 text-center animate-pulse text-slate-500">Processing signals...</div>;

  const indicators = tech?.data?.indicators || [];
  const movingAverages = tech?.data?.movingAverages || [];
  const macdData = indicators.find((i: any) => i.name === 'MACD') || { value: 'N/A', sentiment: 'Neutral' };

  // Map OHLC to Candlestick format for detection
  const candles: Candlestick[] = ohlcData?.data?.map((d: any) => ({
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
    timestamp: d.time
  })) || [];

  const detectedPatterns = detectCandlestickPatterns(candles);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Momentum Indicators" icon={Activity}>
           <div className="space-y-4">
              {indicators.slice(0, 6).map((ind: any) => (
                <div key={ind.name} className="flex justify-between items-center p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                  <div>
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{ind.name}</p>
                    <p className="text-xs font-bold text-white mt-0.5">{ind.value}</p>
                  </div>
                  <span className={cn(
                    "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-tighter",
                    ind.sentiment === 'Bullish' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                  )}>
                    {ind.sentiment}
                  </span>
                </div>
              ))}
           </div>
        </Card>
        <Card title="MACD Analysis" icon={Zap}>
           <div className="space-y-5">
              <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl">
                 <div className="flex justify-between items-end mb-4">
                    <div>
                       <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Momentum Oscillator</p>
                       <h4 className="text-xl font-black text-white italic tracking-tighter">MACD Line</h4>
                    </div>
                    <span className={cn(
                       "text-[10px] font-black px-3 py-1 rounded uppercase italic tracking-tighter",
                       macdData.sentiment === 'Bullish' ? "bg-emerald-500/20 text-emerald-500 border border-emerald-500/30" : "bg-rose-500/20 text-rose-500 border border-rose-500/30"
                    )}>
                       {macdData.sentiment}
                    </span>
                 </div>
                 
                 <div className="space-y-3">
                    <div className="flex justify-between text-[11px] font-bold">
                       <span className="text-slate-400">Current Value:</span>
                       <span className="text-white">{macdData.value}</span>
                    </div>
                    <div className="flex justify-between text-[11px] font-bold">
                       <span className="text-slate-400">Signal Crossover:</span>
                       <span className={macdData.sentiment === 'Bullish' ? "text-emerald-400" : "text-rose-400"}>
                          {macdData.sentiment === 'Bullish' ? 'Bullish Crossover' : 'Bearish Crossover'}
                       </span>
                    </div>
                 </div>

                 <div className="mt-5 pt-5 border-t border-slate-900">
                    <div className="flex items-start gap-3">
                       <Info className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
                       <p className="text-[11px] text-slate-400 leading-relaxed italic">
                          MACD is a trend-following momentum indicator. A <span className="text-white font-bold">Bullish Crossover</span> occurs when the MACD line passes above the signal line.
                       </p>
                    </div>
                 </div>
              </div>

              <div className="space-y-3">
                 <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Scanner Insights</h5>
                 {technicalScan?.signals?.filter((s: any) => s.type === 'MACD').map((signal: any, idx: number) => (
                    <div key={idx} className="p-3 bg-blue-500/5 border border-blue-500/10 rounded-xl">
                       <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">{signal.label}</p>
                       <p className="text-[11px] text-slate-400 leading-relaxed italic">{signal.description}</p>
                    </div>
                 ))}
              </div>
           </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Moving Averages" icon={TrendingUp}>
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {movingAverages.map((ma: any) => (
                 <div key={ma.name} className="flex justify-between items-center p-3 bg-slate-950 rounded-xl border border-slate-800/50">
                    <div>
                      <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{ma.name}</p>
                      <p className="text-xs font-bold text-white mt-0.5">₹{ma.value}</p>
                    </div>
                    <span className={cn(
                      "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-tighter",
                      ma.sentiment === 'Bullish' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                    )}>
                      {ma.sentiment}
                    </span>
                 </div>
              ))}
           </div>
        </Card>

        <Card title="Live Technical Scanner" icon={Zap}>
           <div className="space-y-4">
              {/* Custom patterns detected from chart data */}
              {detectedPatterns.length > 0 && (
                <div className="space-y-3">
                  <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Chart Patterns Identified</h5>
                  {detectedPatterns.map((pattern, idx) => (
                    <div key={idx} className={cn(
                      "p-4 bg-slate-950 border rounded-2xl relative overflow-hidden",
                      pattern.sentiment === 'bullish' ? 'border-emerald-500/20' : pattern.sentiment === 'bearish' ? 'border-rose-500/20' : 'border-slate-800'
                    )}>
                      <div className="absolute top-0 right-0 p-2 opacity-10">
                        {pattern.sentiment === 'bullish' ? <TrendingUp className="text-emerald-500 w-12 h-12" /> : <TrendingDown className="text-rose-500 w-12 h-12" />}
                      </div>
                      <div className="relative z-10">
                        <div className="flex items-center gap-2 mb-2">
                           <Zap className={cn("w-3 h-3", pattern.sentiment === 'bullish' ? 'text-emerald-400' : 'text-rose-400')} />
                           <span className={cn("text-[9px] font-black uppercase tracking-[0.2em]", pattern.sentiment === 'bullish' ? 'text-emerald-400' : 'text-rose-400')}>
                             {pattern.sentiment} SIGNAL (Confidence: {pattern.confidence})
                           </span>
                        </div>
                        <h4 className="text-lg font-black text-white italic tracking-tighter mb-1 uppercase">
                           {pattern.name} Identified
                        </h4>
                        <p className="text-[11px] text-slate-400 leading-relaxed italic font-medium">
                           {pattern.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="p-4 bg-slate-950 border border-emerald-500/20 rounded-2xl relative overflow-hidden">
                 <div className="absolute top-0 right-0 p-2 opacity-10">
                    <Activity className="w-12 h-12 text-emerald-500" />
                 </div>
                 <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-3">
                       <Zap className="w-4 h-4 text-emerald-400" />
                       <span className="text-[10px] font-black text-emerald-400 uppercase tracking-[0.2em]">Real-time Analysis</span>
                    </div>
                    <h4 className="text-lg font-black text-white italic tracking-tighter mb-2">
                       {technicalScan?.candlestickAnalysis?.pattern}
                    </h4>
                    <p className="text-xs text-slate-400 leading-relaxed italic font-medium">
                       {technicalScan?.candlestickAnalysis?.explanation}
                    </p>
                 </div>
              </div>

              <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl">
                 <div className="flex justify-between items-center mb-1">
                    <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Volatility Status</span>
                    <span className="text-[10px] font-black text-white uppercase">{technicalScan?.volatility?.label}</span>
                 </div>
                 <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                    <motion.div 
                       initial={{ width: 0 }}
                       animate={{ width: `${technicalScan?.volatility?.score}%` }}
                       className="h-full bg-blue-500"
                    />
                 </div>
                 <p className="text-[9px] text-slate-600 mt-2 italic uppercase tracking-tighter">{technicalScan?.volatility?.description}</p>
              </div>
           </div>
        </Card>
      </div>

      <Card title="Pivot Levels (Standard)" icon={Filter}>
         <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { label: 'R2', val: (tech as any)?.data?.pivotPoints?.r2 || '---' },
              { label: 'R1', val: (tech as any)?.data?.pivotPoints?.r1 || '---' },
              { label: 'Pivot', val: (tech as any)?.data?.pivotPoints?.pivot || '---' },
              { label: 'S1', val: (tech as any)?.data?.pivotPoints?.s1 || '---' },
              { label: 'S2', val: (tech as any)?.data?.pivotPoints?.s2 || '---' },
            ].map(p => (
              <div key={p.label} className="p-4 bg-slate-950 rounded-2xl border border-slate-800 text-center">
                 <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{p.label}</p>
                 <p className="text-sm font-black text-white italic">₹{p.val}</p>
              </div>
            ))}
         </div>
      </Card>
    </div>
  );
};

const MoneycontrolInsights: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: response, isLoading, error } = trpc.getInsights.useQuery({ symbol });
  const insights = response?.success ? response.data : null;

  if (isLoading) return (
    <div className="animate-pulse space-y-4">
      <div className="h-24 bg-slate-800/50 rounded-2xl" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-32 bg-slate-800/50 rounded-2xl" />
        <div className="h-32 bg-slate-800/50 rounded-2xl" />
      </div>
    </div>
  );

  if (!insights) return null;

  return (
    <div className="space-y-6">
      <div className={cn(
        "p-6 rounded-3xl border relative overflow-hidden",
        insights.classification.color === "green" ? "bg-emerald-500/5 border-emerald-500/20" : 
        insights.classification.color === "red" ? "bg-rose-500/5 border-rose-500/20" : "bg-slate-800/30 border-slate-700/50"
      )}>
        <div className="absolute top-0 right-0 p-8 opacity-5">
          <BrainCircuit className="w-32 h-32" />
        </div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest bg-slate-900/50 px-2 py-0.5 rounded border border-slate-800">MC Intelligence</span>
            <div className="text-[10px] font-black uppercase text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">Score: {insights.classification.stockScore}</div>
          </div>
          <h3 className="text-2xl font-black text-white italic tracking-tighter uppercase mb-2">
            Analysis: {insights.classification.name}
          </h3>
          <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
            {insights.classification.longDesc}
          </p>
        </div>
      </div>

      {insights.swot && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card title="Strengths & Opportunities" icon={TrendingUp}>
            <div className="space-y-4">
              <div className="space-y-2">
                <h5 className="text-[10px] font-black text-emerald-500 uppercase tracking-widest pl-1">Strengths</h5>
                {insights.swot.s.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 bg-emerald-500/5 rounded-xl border border-emerald-500/10">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5" />
                    <span className="text-xs text-slate-300 font-medium">{s}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <h5 className="text-[10px] font-black text-blue-500 uppercase tracking-widest pl-1">Opportunities</h5>
                {insights.swot.o.map((o, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 bg-blue-500/5 rounded-xl border border-blue-500/10">
                    <Zap className="w-4 h-4 text-blue-500 mt-0.5" />
                    <span className="text-xs text-slate-300 font-medium">{o}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card title="Weaknesses & Threats" icon={TrendingDown}>
            <div className="space-y-4">
              <div className="space-y-2">
                <h5 className="text-[10px] font-black text-rose-500 uppercase tracking-widest pl-1">Weaknesses</h5>
                {insights.swot.w.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 bg-rose-500/5 rounded-xl border border-rose-500/10">
                    <AlertCircle className="w-4 h-4 text-rose-500 mt-0.5" />
                    <span className="text-xs text-slate-300 font-medium">{w}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <h5 className="text-[10px] font-black text-amber-500 uppercase tracking-widest pl-1">Threats</h5>
                {insights.swot.t.map((t, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 bg-amber-500/5 rounded-xl border border-amber-500/10">
                    <Info className="w-4 h-4 text-amber-500 mt-0.5" />
                    <span className="text-xs text-slate-300 font-medium">{t}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

const FundamentalInsights: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: funds, isLoading: loadingFunds } = trpc.getTrendlyneFundamentals.useQuery({ symbol });
  const { data: ratios, isLoading: loadingRatios } = trpc.getRatios.useQuery({ symbol });
  const { data: shareholding, isLoading: loadingShareholding } = trpc.getShareholding.useQuery({ symbol });
  const { data: actions, isLoading: loadingActions } = trpc.getCorporateActions.useQuery({ symbol });

  if (loadingFunds || loadingRatios || loadingShareholding || loadingActions) return <div className="p-20 text-center animate-pulse text-slate-500">Auditing financials...</div>;

  // Extract key ratios if available
  const ratioItems = (ratios as any)?.item || [];
  const getRatio = (name: string) => {
    const row = ratioItems.find((r: any) => r.label?.toLowerCase().includes(name.toLowerCase()));
    return row ? row.value : 'N/A';
  };

  const displayRatios = [
    { label: 'Debt/Equity', name: 'debt-equity', icon: Filter },
    { label: 'Current Ratio', name: 'current ratio', icon: Activity },
    { label: 'Quick Ratio', name: 'quick ratio', icon: TrendingUp },
    { label: 'Interest Coverage', name: 'interest coverage', icon: Activity },
  ];

  const shData = (shareholding as any)?.data || {};
  const promoters = shData.promoters || 0;
  const fii = shData.fii || 0;
  const dii = shData.dii || 0;
  const publicHolding = shData.public || 0;

  const corpActions = (actions as any)?.corporate_actions || [];

  return (
    <div className="space-y-6">
       {/* Financial Ratios Section */}
       <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {displayRatios.map(ratio => (
            <div key={ratio.label} className="p-4 bg-slate-900 border border-slate-800 rounded-2xl">
               <div className="flex justify-between items-start mb-2">
                  <ratio.icon className="w-4 h-4 text-blue-400" />
                  <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest border border-slate-800 px-1.5 py-0.5 rounded">Ratios</span>
               </div>
               <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{ratio.label}</p>
               <p className="text-xl font-black text-white italic tracking-tighter mt-1">{getRatio(ratio.name)}</p>
            </div>
          ))}
       </div>

       <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Shareholding Pattern */}
          <Card title="Shareholding Pattern" icon={PieChart}>
             <div className="space-y-4 mt-2">
                {[
                  { type: 'Promoter', val: promoters },
                  { type: 'FII', val: fii },
                  { type: 'DII', val: dii },
                  { type: 'Public', val: publicHolding }
                ].map(item => (
                  <div key={item.type} className="space-y-1.5">
                    <div className="flex justify-between text-[10px] font-black uppercase tracking-widest">
                       <span className="text-slate-400">{item.type}</span>
                       <span className="text-white">{item.val}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800/30">
                       <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${item.val}%` }}
                          className="h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                       />
                    </div>
                  </div>
                ))}
                <p className="text-[9px] text-slate-600 italic mt-4 font-bold text-center uppercase tracking-tighter">
                  Promoter pledging: {shData.promoterPledging || '0.00'}%
                </p>
             </div>
          </Card>

          {/* Corporate Actions */}
          <Card title="Corporate Actions" icon={History}>
             <div className="space-y-3 mt-2 max-h-[250px] overflow-y-auto pr-2 custom-scrollbar">
                {corpActions.length > 0 ? corpActions.map((action: any, i: number) => (
                  <div key={i} className="flex justify-between items-center p-3 bg-slate-950 rounded-xl border border-slate-800/50 hover:border-slate-700 transition-colors">
                     <div>
                        <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest">{action.purpose || 'Action'}</p>
                        <p className="text-xs font-bold text-slate-200 mt-0.5">{action.details || 'N/A'}</p>
                     </div>
                     <span className="text-[9px] font-black text-slate-500 bg-slate-900 px-2 py-1 rounded">
                       {action.date || action.ex_date || 'TBA'}
                     </span>
                  </div>
                )) : (
                  <p className="text-center py-10 text-slate-600 italic text-xs font-bold uppercase tracking-widest">No recent actions recorded</p>
                )}
             </div>
          </Card>
       </div>

       <Card title="Quarterly Performance" icon={BarChart3}>
          <div className="h-64 mt-4">
             <ResponsiveContainer width="100%" height="100%">
                <BarChart data={Array.from({ length: 4 }, (_, i) => ({ q: `Q${i+1}`, revenue: 1000 + Math.random() * 500, profit: 200 + Math.random() * 100 }))}>
                   <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                   <XAxis dataKey="q" />
                   <YAxis hide />
                   <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b' }} />
                   <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                   <Bar dataKey="profit" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
             </ResponsiveContainer>
          </div>
       </Card>
    </div>
  );
};

const MFAnalysis: React.FC<{ symbol: string }> = ({ symbol }) => {
  return (
    <div className="space-y-6">
       <Card title="Top Mutual Fund Holders" icon={PieChart}>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
             <table className="w-full text-left">
                <thead className="bg-slate-900">
                   <tr>
                      {['Fund Name', 'Shares Held', 'Value (Cr)', 'Trend'].map(h => (
                        <th key={h} className="px-4 py-3 text-[9px] font-black uppercase text-slate-500 tracking-widest">{h}</th>
                      ))}
                   </tr>
                </thead>
                <tbody className="bg-slate-950 divide-y divide-slate-800">
                   {[1, 2, 3, 4, 5].map(i => (
                     <tr key={i} className="hover:bg-slate-900 transition-colors">
                        <td className="px-4 py-3 font-bold text-white text-xs whitespace-nowrap uppercase italic">HDFC Top 100 Fund</td>
                        <td className="px-4 py-3 text-slate-400 text-xs font-bold tabular-nums">2,450,000</td>
                        <td className="px-4 py-3 text-slate-400 text-xs font-bold tabular-nums">₹412.5</td>
                        <td className="px-4 py-3">
                           <span className="text-emerald-400 text-[9px] font-black uppercase">Increased</span>
                        </td>
                     </tr>
                   ))}
                </tbody>
             </table>
          </div>
       </Card>

       <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="FII/DII Trends" icon={Activity}>
             <div className="h-48 mt-4">
                <ResponsiveContainer width="100%" height="100%">
                   <AreaChart data={Array.from({ length: 6 }, (_, i) => ({ month: i, fii: 15 + Math.random() * 5, dii: 12 + Math.random() * 5 }))}>
                      <XAxis dataKey="month" hide />
                      <YAxis hide />
                      <Area type="monotone" dataKey="fii" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} />
                      <Area type="monotone" dataKey="dii" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.1} />
                   </AreaChart>
                </ResponsiveContainer>
             </div>
             <p className="text-[10px] text-slate-600 mt-4 italic text-center font-bold">Consolidated inflow trend across last 6 months</p>
          </Card>

          <Card title="SIP Return Explorer" icon={TrendingUp}>
             <div className="space-y-6">
                <div>
                   <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">SIP Return (3Y Ann.)</p>
                   <p className="text-3xl font-black text-emerald-400 italic tracking-tighter">18.4%</p>
                </div>
                <div className="pt-4 border-t border-slate-800">
                   <p className="text-[10px] text-slate-400 leading-relaxed font-medium italic">
                     Historical SIP performance if invested ₹10,000 monthly since 2021.
                   </p>
                </div>
             </div>
          </Card>
       </div>
    </div>
  );
};

const FnOSignals: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: fno, isLoading } = trpc.getFnOSignals.useQuery({ symbol });

  if (isLoading) return <div className="p-10 text-center animate-pulse text-slate-500">Scanning F&O Activity...</div>;
  if (!fno || !fno.success) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Put-Call Ratio (PCR)</p>
          <p className={cn(
            "text-xl font-black italic",
            fno.marketSentiment.pcr > 1 ? "text-emerald-400" : "text-rose-400"
          )}>{fno.marketSentiment.pcr.toFixed(2)}</p>
          <p className="text-[8px] text-slate-600 font-bold uppercase mt-1">{fno.marketSentiment.pcr > 1.2 ? 'Bullish Sentiment' : fno.marketSentiment.pcr < 0.8 ? 'Bearish Sentiment' : 'Neutral Zone'}</p>
        </div>
        <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Max Pain Strike</p>
          <p className="text-xl font-black text-white italic">₹{fno.marketSentiment.maxPain}</p>
          <p className="text-[8px] text-slate-600 font-bold uppercase mt-1">Expected Expiry Zone</p>
        </div>
        <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Overall OI Trend</p>
          <p className="text-xl font-black text-blue-400 italic uppercase">{fno.marketSentiment.oiTrend}</p>
          <p className="text-[8px] text-slate-600 font-bold uppercase mt-1">Positioning Analysis</p>
        </div>
        <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Active Signals</p>
          <p className="text-xl font-black text-white italic">{fno.signals.length}</p>
          <p className="text-[8px] text-slate-600 font-bold uppercase mt-1">Institutional Alerts</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Unusual Options Activity" icon={Zap}>
          <div className="space-y-3 pt-2">
            {fno.signals.filter(s => s.type === 'UNUSUAL_VOLUME' || s.type === 'PCR_SIGNAL').map((sig, idx) => (
              <div key={idx} className="p-4 bg-slate-900/50 border border-slate-800/80 rounded-2xl group hover:border-blue-500/30 transition-all">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      sig.sentiment === 'bullish' ? "bg-emerald-500" : "bg-rose-500"
                    )} />
                    <h5 className="text-[10px] font-black text-white uppercase tracking-widest">{sig.value}</h5>
                  </div>
                  <span className={cn(
                    "text-[8px] font-black px-2 py-0.5 rounded uppercase tracking-widest",
                    sig.confidence === 'high' ? "bg-blue-500/20 text-blue-400" : "bg-slate-800 text-slate-500"
                  )}>{sig.confidence} Confidence</span>
                </div>
                <p className="text-[11px] text-slate-400 font-medium leading-relaxed italic">{sig.description}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Significant OI Shifts" icon={Activity}>
           <div className="space-y-3 pt-2">
            {fno.signals.filter(s => s.type === 'OI_SPIKE' || s.type === 'BUILDUP').map((sig, idx) => (
              <div key={idx} className="p-4 bg-slate-900/50 border border-slate-800/80 rounded-2xl group hover:border-purple-500/30 transition-all">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      sig.sentiment === 'bullish' ? "bg-emerald-500" : "bg-rose-500"
                    )} />
                    <h5 className="text-[10px] font-black text-white uppercase tracking-widest">{sig.value}</h5>
                  </div>
                  <span className="text-[8px] font-black px-2 py-0.5 rounded bg-slate-800 text-slate-500 uppercase tracking-widest">{sig.type}</span>
                </div>
                <p className="text-[11px] text-slate-400 font-medium leading-relaxed italic">{sig.description}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

const StockSWOT: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: insights, isLoading } = trpc.getStockInsights.useQuery({ symbol });

  if (isLoading) return <div className="p-10 animate-pulse bg-slate-900 rounded-2xl border border-slate-800" />;
  if (!insights || !(insights as any).swot) return null;

  const { strengths, weaknesses, opportunities, threats } = (insights as any).swot;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl">
        <h5 className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-3 flex items-center gap-2">
          <TrendingUp className="w-3 h-3" /> Strengths
        </h5>
        <ul className="space-y-2">
          {strengths.map((s, i) => (
            <li key={i} className="text-[11px] text-slate-400 font-bold italic leading-relaxed">• {s}</li>
          ))}
        </ul>
      </div>
      <div className="p-4 bg-rose-500/5 border border-rose-500/20 rounded-2xl">
        <h5 className="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-3 flex items-center gap-2">
          <TrendingDown className="w-3 h-3" /> Weaknesses
        </h5>
        <ul className="space-y-2">
          {weaknesses.map((s, i) => (
            <li key={i} className="text-[11px] text-slate-400 font-bold italic leading-relaxed">• {s}</li>
          ))}
        </ul>
      </div>
      <div className="p-4 bg-blue-500/5 border border-blue-500/20 rounded-2xl">
        <h5 className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-3 flex items-center gap-2">
          <Zap className="w-3 h-3" /> Opportunities
        </h5>
        <ul className="space-y-2">
          {opportunities.map((s, i) => (
            <li key={i} className="text-[11px] text-slate-400 font-bold italic leading-relaxed">• {s}</li>
          ))}
        </ul>
      </div>
      <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-2xl">
        <h5 className="text-[10px] font-black text-amber-500 uppercase tracking-widest mb-3 flex items-center gap-2">
          <AlertCircle className="w-3 h-3" /> Threats
        </h5>
        <ul className="space-y-2">
          {threats.map((s, i) => (
            <li key={i} className="text-[11px] text-slate-400 font-bold italic leading-relaxed">• {s}</li>
          ))}
        </ul>
      </div>
    </div>
  );
};

const FundamentalEssentials: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: insights, isLoading } = trpc.getStockInsights.useQuery({ symbol });

  if (isLoading) return <div className="grid grid-cols-2 md:grid-cols-6 gap-4 p-4 animate-pulse" />;
  if (!insights || !(insights as any).essentials) return null;

  const { pe, sectorPe, pb, dividendYield, marketCap, faceValue } = (insights as any).essentials;

  const items = [
    { label: 'P/E Ratio', value: pe, sub: `Sector: ${sectorPe}` },
    { label: 'P/B Ratio', value: pb },
    { label: 'Div Yield', value: `${dividendYield}%` },
    { label: 'Market Cap', value: marketCap },
    { label: 'Face Value', value: faceValue },
    { label: 'Trend', value: (insights as any).technicalTrend, color: (insights as any).technicalTrend === 'BULLISH' ? 'text-emerald-400' : 'text-rose-400' }
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {items.map((item, i) => (
        <div key={i} className="p-4 bg-slate-950 border border-slate-800 rounded-2xl">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{item.label}</p>
          <p className={cn("text-lg font-black italic tracking-tighter", item.color || "text-white")}>{item.value}</p>
          {item.sub && <p className="text-[8px] text-slate-600 font-bold uppercase mt-1">{item.sub}</p>}
        </div>
      ))}
    </div>
  );
};

const NewsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const allNews = useNewsFeed();
  const news = allNews.filter(n => n.relatedSymbols?.includes(symbol));

  if (news.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 bg-slate-950 rounded-2xl border border-slate-800 border-dashed">
         <Activity className="w-12 h-12 text-slate-800 animate-pulse mb-4" />
         <h3 className="text-slate-500 font-black text-lg uppercase tracking-tighter italic text-center">No Targeted News Found</h3>
         <p className="text-slate-600 text-[10px] uppercase font-bold tracking-widest mt-2">{symbol} section under observation</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card title={`${symbol} Intel Feed`} icon={Activity}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
          {news.map((item) => (
            <div key={item.id} className="p-5 bg-slate-950 border border-slate-800 rounded-2xl hover:border-blue-500/30 transition-all group">
              <div className="flex gap-3 items-center mb-3">
                <span className={cn(
                  "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-widest",
                  item.category === 'Economy' ? "bg-amber-500/20 text-amber-500" :
                  item.category === 'Stock' ? "bg-blue-500/20 text-blue-500" : "bg-purple-500/20 text-purple-500"
                )}>
                  {item.category}
                </span>
                <span className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">{item.time}</span>
                <span className="text-[9px] font-black text-slate-700 mx-1">•</span>
                <span className="text-[9px] font-black text-blue-500/80 uppercase tracking-widest">{item.source}</span>
              </div>
              <h4 className="text-lg font-black text-white italic tracking-tighter leading-tight mb-2 group-hover:text-blue-400 transition-colors">
                {item.title}
              </h4>
              <p className="text-[11px] text-slate-500 font-medium leading-relaxed italic mb-4 line-clamp-3">
                {item.summary}
              </p>
              <div className="flex justify-between items-center">
                <div className="flex gap-2">
                  {item.relatedSymbols?.map(sym => (
                    <span key={sym} className="text-[9px] font-black text-slate-400 bg-slate-900 px-2 py-0.5 border border-slate-800 rounded uppercase tracking-tighter">
                      ${sym}
                    </span>
                  ))}
                </div>
                <button className="text-[9px] font-black text-blue-500 uppercase tracking-widest hover:text-white transition-colors">
                  READ ARTICLE →
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

const StockDetails: React.FC<{ 
  symbol: string; 
  stock?: MarketData; 
  onBack: () => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string) => void;
}> = ({ symbol, stock, onBack, watchlist, onToggleWatchlist }) => {
  const news = useNewsFeed().filter(n => n.relatedSymbols?.includes(symbol));
  const [activeTab, setActiveTab] = useState('insights');
  const [report, setReport] = useState<any>(null);

  const reportMutation = trpc.generateTrendReport.useMutation({
    onSuccess: (data) => {
      setReport(data);
    }
  });
  
  // Synthetic high-fidelity candlestick data
  const [chartData] = useState(() => {
    const base = stock?.price || 1000;
    let currentPrice = base;
    return Array.from({ length: 40 }, (_, i) => {
      const open = currentPrice;
      const volatility = base * 0.015;
      const close = currentPrice + (Math.random() - 0.48) * volatility;
      const high = Math.max(open, close) + Math.random() * (volatility * 0.5);
      const low = Math.min(open, close) - Math.random() * (volatility * 0.5);
      
      currentPrice = close;
      
      const vwap = close * 0.99;
      const stdDev = base * 0.02;
      const upperBand = close + stdDev;
      const lowerBand = close - stdDev;

      return { 
        time: `${10 + Math.floor(i/10)}:${(i%10)*6}`, 
        open,
        high,
        low,
        close,
        price: close, 
        vwap, 
        bollinger: [lowerBand, upperBand],
        volume: Math.random() * 100000 
      };
    });
  });

  const patterns = React.useMemo(() => {
    const candles = chartData.map(d => ({
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      timestamp: d.time
    }));
    return detectCandlestickPatterns(candles);
  }, [chartData]);

  const levels = React.useMemo(() => {
    if (!chartData.length) return { support: 0, resistance: 0 };
    const prices = chartData.map(d => d.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    
    // Simple logic for robust levels
    return {
      support: min + range * 0.1,
      resistance: max - range * 0.1,
      min,
      max
    };
  }, [chartData]);

  if (!stock) return <div className="p-20 text-center text-slate-500">Stock data missing</div>;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button 
            onClick={onBack}
            className="p-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 hover:text-white transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-black text-white italic tracking-tighter uppercase">{stock.symbol}</h1>
              <span className="text-slate-500 font-bold text-sm bg-slate-900 px-3 py-1 rounded-lg border border-slate-800">{stock.name}</span>
              <button 
                onClick={() => onToggleWatchlist(symbol)}
                className={cn(
                  "p-2 rounded-xl border transition-all",
                  watchlist.includes(symbol) ? "bg-amber-500/10 border-amber-500/20 text-amber-500" : "bg-slate-900 border-slate-800 text-slate-600 hover:text-slate-400"
                )}
              >
                <WatchlistIcon className={cn("w-5 h-5", watchlist.includes(symbol) && "fill-amber-500")} />
              </button>
            </div>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-2xl font-black text-white tabular-nums">₹{stock.price.toLocaleString()}</span>
              <span className={cn(
                "font-bold text-sm flex items-center gap-1",
                stock.changePct >= 0 ? "text-emerald-400" : "text-rose-400"
              )}>
                {stock.changePct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {stock.changePct >= 0 ? '+' : ''}{stock.changePct}%
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex gap-3">
          <button className="flex-1 md:flex-none bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-2xl font-black text-sm transition-all shadow-[0_10px_20px_rgba(37,99,235,0.2)] uppercase tracking-widest">
            Invest Now
          </button>
          <button className="p-3 bg-slate-900 border border-slate-800 rounded-2xl text-slate-400 hover:text-white transition-all">
            <Heart className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-800 pb-px overflow-x-auto hide-scrollbar">
        {[
          { id: 'insights', label: 'Overview' },
          { id: 'technicals', label: 'Technical' },
          { id: 'fundamentals', label: 'Fundamental' },
          { id: 'mf', label: 'MF Insights' },
          { id: 'fno', label: 'F&O Insights' },
          { id: 'news', label: 'News Feed' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap border-b-2",
              activeTab === tab.id ? "border-blue-500 text-blue-500" : "border-transparent text-slate-500 hover:text-white"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Main Content Area */}
        <div className="col-span-12 lg:col-span-8 space-y-6">
          {activeTab === 'insights' && (
            <div className="space-y-6">
              <FundamentalEssentials symbol={symbol} />
              <MoneycontrolInsights symbol={symbol} />
              
              {/* Real-time Candlestick Pattern Recognition */}
              {patterns.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 bg-slate-950 border border-blue-500/20 rounded-2xl relative overflow-hidden"
                >
                  <div className="absolute top-0 right-0 p-3 opacity-10">
                    <Activity className="w-16 h-16 text-blue-500" />
                  </div>
                  <div className="relative z-10 flex items-start gap-4">
                    <div className="p-3 bg-blue-500/10 rounded-xl">
                      <Zap className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-black text-blue-400 uppercase tracking-widest">AI Pattern Recognition Engine</span>
                        <div className="flex gap-1">
                           <div className="w-1 h-1 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                           <div className="w-1 h-1 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '200ms' }} />
                           <div className="w-1 h-1 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '400ms' }} />
                        </div>
                      </div>
                      <h4 className="text-lg font-black text-white italic tracking-tighter uppercase">
                        Current Pattern: {patterns[patterns.length - 1].name}
                      </h4>
                      <p className="text-xs text-slate-400 font-medium italic mt-1 leading-relaxed">
                        {patterns[patterns.length - 1].description}
                      </p>
                      <div className="flex items-center gap-4 mt-3">
                         <div className="flex items-center gap-1.5">
                            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Sentiment:</span>
                            <span className={cn(
                              "text-[9px] font-black uppercase px-2 py-0.5 rounded",
                              patterns[patterns.length - 1].sentiment === 'bullish' ? "bg-emerald-500/10 text-emerald-400" :
                              patterns[patterns.length - 1].sentiment === 'bearish' ? "bg-rose-500/10 text-rose-400" : "bg-slate-800 text-slate-400"
                            )}>
                              {patterns[patterns.length - 1].sentiment}
                            </span>
                         </div>
                         <div className="flex items-center gap-1.5">
                            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Confidence:</span>
                            <span className="text-[9px] font-black text-white uppercase">{patterns[patterns.length - 1].confidence}</span>
                         </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              <StockSWOT symbol={symbol} />
              
              <Card title="Interactive Technical Chart" icon={Activity}>
                <div className="flex gap-4 mb-6 overflow-x-auto pb-2 hide-scrollbar">
                    {['1m', '5m', '15m', '1H', '1D', '1W'].map(tf => (
                      <button key={tf} className={cn(
                        "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all border",
                        tf === '15m' ? "bg-blue-600 border-blue-600 text-white" : "bg-slate-950 border-slate-800 text-slate-500 hover:text-white"
                      )}>
                        {tf}
                      </button>
                    ))}
                </div>
                
                <div className="h-[400px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData}>
                        <defs>
                          <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1}/>
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="time" hide />
                        <YAxis hide domain={['auto', 'auto']} />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)' }}
                          itemStyle={{ fontSize: '10px', fontWeight: '900', textTransform: 'uppercase' }}
                          labelStyle={{ color: '#64748b', fontSize: '10px', fontWeight: 'bold', marginBottom: '4px' }}
                          content={({ active, payload }) => {
                            if (active && payload && payload.length) {
                              const data = payload[0].payload;
                              return (
                                <div className="bg-slate-950 border border-slate-800 p-3 rounded-xl shadow-2xl backdrop-blur-md">
                                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 border-b border-slate-800 pb-1">{data.time}</p>
                                  <div className="space-y-1.5">
                                    <div className="flex justify-between gap-4">
                                      <span className="text-[10px] font-bold text-slate-400">O:</span>
                                      <span className="text-[10px] font-black text-white">₹{data.open.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <span className="text-[10px] font-bold text-slate-400">H:</span>
                                      <span className="text-[10px] font-black text-emerald-400">₹{data.high.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <span className="text-[10px] font-bold text-slate-400">L:</span>
                                      <span className="text-[10px] font-black text-rose-400">₹{data.low.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <span className="text-[10px] font-bold text-slate-400">C:</span>
                                      <span className="text-[10px] font-black text-white">₹{data.close.toFixed(2)}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Area 
                          type="monotone" 
                          dataKey="bollinger" 
                          stroke="none" 
                          fill="#3b82f6" 
                          fillOpacity={0.05} 
                          name="Volatility Band" 
                        />
                        <Bar 
                          dataKey="price" 
                          fill="#3b82f6" 
                          opacity={0.1} 
                          barSize={2} 
                        />
                        <Line type="monotone" dataKey="price" stroke="#fff" strokeWidth={2} dot={false} name="Price" activeDot={{ r: 4, fill: '#3b82f6', stroke: '#fff', strokeWidth: 2 }} />
                        <Line type="monotone" dataKey="vwap" stroke="#ec4899" strokeWidth={1} dot={false} name="VWAP" strokeDasharray="3 3" />
                        
                        <ReferenceLine 
                          y={levels.resistance} 
                          stroke="#f43f5e" 
                          strokeWidth={1.5} 
                          strokeDasharray="4 4" 
                        />
                        <ReferenceLine 
                          y={levels.support} 
                          stroke="#10b981" 
                          strokeWidth={1.5} 
                          strokeDasharray="4 4" 
                        />

                        {patterns.length > 0 && patterns[patterns.length - 1].sentiment !== 'neutral' && (
                          <ReferenceArea 
                            {...({
                              x1: chartData[chartData.length - 3].time,
                              x2: chartData[chartData.length - 1].time,
                              fill: patterns[patterns.length - 1].sentiment === 'bullish' ? '#10b981' : '#f43f5e',
                              fillOpacity: 0.08,
                              stroke: patterns[patterns.length - 1].sentiment === 'bullish' ? '#10b981' : '#f43f5e',
                              strokeOpacity: 0.2,
                              strokeDasharray: "3 3"
                            } as any)}
                          />
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                </div>

                <div className="mt-6 flex flex-col md:flex-row gap-4">
                  <div className="flex-1 p-4 bg-slate-900/50 border border-slate-800/80 rounded-2xl">
                    <div className="flex items-center gap-2 mb-2">
                       <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                       <h4 className="text-[10px] font-black text-white uppercase tracking-widest">Resistance Level: ₹{levels.resistance.toFixed(2)}</h4>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed italic">
                      Price has struggled to break above this ceiling. A strong breakout with volume could signal a bullish reversal or trend continuation.
                    </p>
                  </div>
                  <div className="flex-1 p-4 bg-slate-900/50 border border-slate-800/80 rounded-2xl">
                    <div className="flex items-center gap-2 mb-2">
                       <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                       <h4 className="text-[10px] font-black text-white uppercase tracking-widest">Support Level: ₹{levels.support.toFixed(2)}</h4>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed italic">
                      Buyers have historically entered the market at this floor. Holding this level is critical to maintain current trend integrity.
                    </p>
                  </div>
                </div>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card title="Volume Insights" icon={BarChart3}>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData.slice(0, 20)}>
                        <Bar dataKey="volume" fill="#1e293b" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
                <Card title="Market Summary" icon={Info}>
                   <div className="space-y-4">
                      <p className="text-xs text-slate-400 leading-relaxed italic">
                        {stock.name} is currently showing a {stock.changePct > 0 ? 'bullish' : 'bearish'} bias with volumes trending {Math.random() > 0.5 ? 'above' : 'below'} the 20-day average. The Relative Strength Index (RSI) is sitting at 58.4, indicating neutral momentum.
                      </p>
                      <div className="flex gap-4">
                         <div className="flex-1 p-3 bg-slate-950 rounded-xl border border-slate-800">
                            <span className="text-[8px] font-black text-slate-500 uppercase block mb-1">Mkt Cap</span>
                            <span className="text-xs font-bold text-white">₹18.42T</span>
                         </div>
                         <div className="flex-1 p-3 bg-slate-950 rounded-xl border border-slate-800">
                            <span className="text-[8px] font-black text-slate-500 uppercase block mb-1">52W High</span>
                            <span className="text-xs font-bold text-white">₹{stock.high + 100}</span>
                         </div>
                      </div>
                   </div>
                </Card>
              </div>

              {/* AI Analyst Report Component */}
              <div className="mt-8">
                 <Card title="AI Strategic Analyst Report" icon={Zap} className="border-blue-500/20">
                    {!report ? (
                      <div className="py-12 flex flex-col items-center justify-center text-center">
                        <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mb-4">
                          <Activity className="w-8 h-8 text-blue-500 animate-pulse" />
                        </div>
                        <h4 className="text-lg font-black text-white italic uppercase tracking-tighter mb-2">Detailed Report Not Generated</h4>
                        <p className="text-slate-500 text-xs max-w-md mb-6 uppercase font-bold tracking-widest leading-loose">
                          Harness the power of Bharat Stock AI to generate a high-fidelity intelligence report including fundamental analysis, technical positioning, and risk scoring.
                        </p>
                        <button 
                          onClick={() => reportMutation.mutate({ symbol: stock.symbol })}
                          disabled={reportMutation.isPending}
                          className={cn(
                            "px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl transition-all shadow-lg flex items-center gap-2 uppercase text-xs tracking-widest",
                            reportMutation.isPending && "opacity-50 cursor-not-allowed"
                          )}
                        >
                          {reportMutation.isPending ? <Activity className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                          {reportMutation.isPending ? 'Generating Intelligence...' : 'Generate AI Report'}
                        </button>
                      </div>
                    ) : (
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="space-y-8"
                      >
                        <div className="flex flex-col md:flex-row justify-between items-start gap-4 pb-6 border-b border-slate-800">
                          <div>
                            <h3 className="text-2xl font-black text-white italic tracking-tighter uppercase mb-1">{report.title}</h3>
                            <div className="flex items-center gap-4">
                              <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-1">
                                <Bookmark className="w-3 h-3" />
                                Institutional Grade
                              </span>
                              <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                                Timestamp: {report.generatedAt ? format(new Date(report.generatedAt), 'MMM dd, yyyy HH:mm') : 'Live'}
                              </span>
                            </div>
                          </div>
                          <div className={cn(
                            "px-4 py-2 rounded-xl border flex items-center gap-3",
                            report.outlook === 'BULLISH' ? "bg-emerald-500/10 border-emerald-500/20" : "bg-rose-500/10 border-rose-500/20"
                          )}>
                             <div className="text-right">
                               <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Overall Outlook</p>
                               <p className={cn(
                                 "text-sm font-black italic",
                                 report.outlook === 'BULLISH' ? "text-emerald-400" : "text-rose-400"
                               )}>{report.outlook}</p>
                             </div>
                             {report.outlook === 'BULLISH' ? <TrendingUp className="text-emerald-400 w-5 h-5" /> : <TrendingDown className="text-rose-400 w-5 h-5" />}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                           <div className="lg:col-span-2 space-y-6">
                              <div>
                                <h5 className="text-[11px] font-black text-slate-300 uppercase tracking-widest border-l-2 border-blue-500 pl-3 mb-3">Executive Summary</h5>
                                <p className="text-sm text-slate-400 leading-relaxed italic font-medium">
                                  {report.summary}
                                </p>
                              </div>
                              
                              <div>
                                <h5 className="text-[11px] font-black text-slate-300 uppercase tracking-widest border-l-2 border-pink-500 pl-3 mb-3">Investment Thesis</h5>
                                <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800 relative overflow-hidden">
                                  <div className="absolute top-0 right-0 p-4 opacity-5">
                                    <Activity className="w-24 h-24 text-slate-400" />
                                  </div>
                                  <p className="text-sm text-slate-300 leading-relaxed font-medium italic relative z-10">
                                    {report.investmentThesis}
                                  </p>
                                </div>
                              </div>
                           </div>

                           <div className="space-y-6">
                              <div>
                                <h5 className="text-[11px] font-black text-slate-300 uppercase tracking-widest border-l-2 border-rose-500 pl-3 mb-3">Risk Assessment</h5>
                                <div className="space-y-3">
                                  {report.riskFactors.map((risk: string, i: number) => (
                                    <div key={i} className="flex gap-3 p-3 bg-slate-950 rounded-xl border border-rose-500/10 group hover:border-rose-500/20 transition-all">
                                      <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
                                      <p className="text-[11px] text-slate-500 font-bold leading-snug">{risk}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              <div className="p-4 bg-blue-500/5 border border-blue-500/10 rounded-2xl">
                                <h6 className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                                  <Zap className="w-3 h-3 fill-blue-400" />
                                  AI Probability Core
                                </h6>
                                <p className="text-[10px] text-slate-500 font-bold leading-relaxed">
                                  Based on current volatility bands and historical earnings surprises, our core engine predicts a 68.4% probability of {report.outlook.toLowerCase()} continuation over the next 22 trading sessions.
                                </p>
                              </div>
                           </div>
                        </div>
                      </motion.div>
                    )}
                 </Card>
              </div>
            </div>
          )}

          {activeTab === 'technicals' && <TechnicalAnalysis symbol={symbol} />}
          {activeTab === 'fundamentals' && <FundamentalInsights symbol={symbol} />}
          {activeTab === 'mf' && <MFAnalysis symbol={symbol} />}
          {activeTab === 'news' && <NewsTab symbol={symbol} />}

           {activeTab === 'fno' && (
            <div className="space-y-6">
               <OptionChain symbol={symbol} stockPrice={stock.price} />
               <FnOSignals symbol={symbol} />

               <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Card title="Institutional Flow (FII/DII)" icon={TrendingUp}>
                     <div className="space-y-4">
                        <div className="flex justify-between items-center p-3 bg-slate-950 rounded-xl border border-slate-800">
                           <span className="text-xs font-bold text-slate-400">Net FII Position</span>
                           <span className="text-emerald-400 font-black">+₹4,250 Cr</span>
                        </div>
                        <div className="flex justify-between items-center p-3 bg-slate-950 rounded-xl border border-slate-800">
                           <span className="text-xs font-bold text-slate-400">DII Activity</span>
                           <span className="text-rose-400 font-black">-₹1,120 Cr</span>
                        </div>
                        <p className="text-[9px] text-slate-600 italic text-center uppercase tracking-widest mt-2 font-bold">Update: 15 mins ago</p>
                     </div>
                  </Card>
               </div>
            </div>
          )}

          {/* Other tabs can be implemented similarly */}
          {activeTab !== 'insights' && activeTab !== 'fno' && activeTab !== 'technicals' && activeTab !== 'fundamentals' && activeTab !== 'mf' && activeTab !== 'news' && (
            <div className="flex flex-col items-center justify-center py-20 bg-slate-950 rounded-2xl border border-slate-800 border-dashed">
               <Activity className="w-12 h-12 text-slate-800 animate-pulse mb-4" />
               <h3 className="text-slate-500 font-black text-lg uppercase tracking-tighter italic">Coming to Bharat Stock Pro</h3>
               <p className="text-slate-600 text-[10px] uppercase font-bold tracking-widest mt-2">{activeTab} section under maintenance</p>
            </div>
          )}
        </div>

        {/* Sidebar Insights */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
          <Card title="Technical Scorecard" icon={Activity}>
             <div className="space-y-6 pt-2">
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">RSI (14)</span>
                    <span className="text-amber-400 font-bold text-xs uppercase tracking-tighter">Neutral (58.4)</span>
                  </div>
                  <div className="w-full h-2 bg-slate-950 rounded-full relative overflow-hidden border border-slate-800">
                    <div className="absolute inset-y-0 left-[30%] right-[70%] bg-blue-500/10 border-x border-blue-500/20" />
                    <div className="absolute top-0 h-full w-1 bg-amber-400 left-[58.4%]" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                    <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">MACD</p>
                    <p className="text-xs font-bold text-emerald-400 italic">Bullish Crossover</p>
                  </div>
                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                    <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">Bollinger</p>
                    <p className="text-xs font-bold text-slate-300 italic">Upper Band Touch</p>
                  </div>
                </div>

                <div className="space-y-2">
                   <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest pl-1">Pivot Points (Standard)</p>
                   <div className="space-y-1">
                      {[
                        { label: 'R2', val: stock.high + 10, color: 'text-emerald-400' },
                        { label: 'R1', val: stock.high, color: 'text-emerald-500' },
                        { label: 'PP', val: stock.price, color: 'text-white' },
                        { label: 'S1', val: stock.low, color: 'text-rose-500' },
                        { label: 'S2', val: stock.low - 10, color: 'text-rose-400' },
                      ].map(p => (
                        <div key={p.label} className="flex justify-between items-center px-4 py-2 bg-slate-950 rounded-lg border border-slate-800/50">
                           <span className={cn("text-[9px] font-black uppercase tracking-widest", p.color)}>{p.label}</span>
                           <span className="text-xs font-bold tabular-nums text-slate-300">₹{p.val}</span>
                        </div>
                      ))}
                   </div>
                </div>

                <div className="pt-2">
                  {report ? (
                    <div className="p-4 bg-slate-950 border border-blue-500/30 rounded-xl space-y-3">
                      <h6 className="text-[10px] font-black text-blue-400 uppercase italic">Intelligence Report Ready</h6>
                      <p className="text-[11px] text-white/80 leading-relaxed italic">"{report.summary}"</p>
                      <div className="flex justify-between items-center bg-blue-500/10 p-2 rounded">
                        <span className="text-[9px] font-black text-blue-400 uppercase">Outlook</span>
                        <span className="text-xs font-bold text-white uppercase italic">{report.outlook}</span>
                      </div>
                    </div>
                  ) : (
                    <button 
                      onClick={() => reportMutation.mutate({ symbol: stock.symbol })}
                      disabled={reportMutation.isPending}
                      className={cn(
                        "w-full py-3 rounded-xl border font-black text-[10px] uppercase tracking-widest transition-all",
                        reportMutation.isPending ? "bg-slate-900 border-slate-800 text-slate-600" : "bg-blue-600 border-blue-600 text-white hover:bg-blue-700 shadow-[0_5px_15px_rgba(37,99,235,0.3)]"
                      )}
                    >
                      {reportMutation.isPending ? 'Crunching Data...' : 'Generate Analyst Report'}
                    </button>
                  )}
                </div>
             </div>
          </Card>

          <Card title={`Latest ${stock.symbol} News`} icon={Info}>
             <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 hide-scrollbar">
                {news.length > 0 ? news.map(item => (
                   <div key={item.id} className="group cursor-pointer">
                      <p className="text-[8px] font-bold text-slate-600 uppercase tracking-widest mb-1">{item.time}</p>
                      <h4 className="text-xs font-bold text-slate-300 leading-snug group-hover:text-white transition-colors">
                        {item.title}
                      </h4>
                      <div className="mt-2 text-[9px] text-blue-500 font-black uppercase tracking-tighter group-hover:underline">Read Full Insight</div>
                   </div>
                )) : (
                  <div className="text-center py-8">
                     <p className="text-[10px] text-slate-600 font-bold uppercase tracking-widest italic">No specific news for {symbol}</p>
                  </div>
                )}
             </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stocks = useMarketData();
  const indices = getIndexData();
  const { data: realIndices } = trpc.getAllIndices.useQuery();
  
  const rawIndexData = realIndices?.data;
  const indexSource = Array.isArray(rawIndexData) ? rawIndexData : (rawIndexData?.indexList || []);
  
  const displayIndices = indexSource.length > 0 ? indexSource.map((idx: any) => ({
    name: idx.indexName || idx.name,
    value: parseFloat(idx.lastPrice),
    change: parseFloat(idx.percentChange),
    isUp: parseFloat(idx.percentChange) >= 0
  })) : indices;

  const addToast = (signal: any) => {
    const id = Math.random().toString(36).substring(2, 9);
    const newToast: Toast = {
      id,
      title: `${signal.signal} ALERT: ${signal.symbol}`,
      message: signal.reasoning,
      type: signal.signal as 'BUY' | 'SELL',
      confidence: signal.confidence
    };
    setToasts(prev => [...prev, newToast]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const { data: watchlistData } = trpc.getWatchlist.useQuery({ userId: user?.uid || '' }, { enabled: !!user });
  
  useEffect(() => {
    if (watchlistData) {
      setWatchlist(watchlistData);
    } else if (!user) {
      setWatchlist([]);
    }
  }, [watchlistData, user]);

  const addToWatchlistMutation = trpc.addToWatchlist.useMutation();
  const removeFromWatchlistMutation = trpc.removeFromWatchlist.useMutation();

  const toggleWatchlist = async (symbol: string) => {
    if (!user) {
      handleLogin();
      return;
    }

    const isInWatchlist = watchlist.includes(symbol);

    try {
      if (isInWatchlist) {
        await removeFromWatchlistMutation.mutateAsync({ userId: user.uid, symbol });
        setWatchlist(prev => prev.filter(s => s !== symbol));
      } else {
        await addToWatchlistMutation.mutateAsync({ userId: user.uid, symbol });
        setWatchlist(prev => [...prev, symbol]);
      }
    } catch (error) {
      console.error("Watchlist update failed:", error);
    }
  };

  const syncUserMutation = trpc.syncUser.useMutation();

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      
      await syncUserMutation.mutateAsync({
        id: result.user.uid,
        email: result.user.email,
        name: result.user.displayName,
        photoURL: result.user.photoURL
      });

    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  if (loading) return (
    <div className="h-screen w-screen bg-slate-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Zap className="text-blue-500 w-12 h-12 fill-blue-500 animate-pulse" />
        <span className="text-slate-400 text-xs font-black uppercase tracking-[0.4em] animate-pulse italic">Connecting to NSE Gateway...</span>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-blue-500/30 selection:text-white">
      {/* Top Banner Indices */}
      <div className="bg-slate-900 h-10 border-b border-slate-800 overflow-hidden flex items-center overflow-x-auto hide-scrollbar">
        {displayIndices.map((idx: any) => <IndexBar key={idx.name} {...idx} />)}
      </div>

      <Navbar 
        user={user} 
        onLogin={handleLogin} 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        stocks={stocks}
        onSelectStock={(s) => { setSelectedSymbol(s); setActiveTab('details'); }}
      />

      <main className="max-w-7xl mx-auto pb-20">
        <AnimatePresence mode="wait">
          {activeTab === 'watchlist' ? (
            <motion.div
              key="watchlist"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <Watchlist 
                watchlist={watchlist} 
                stocks={stocks} 
                onSelectStock={(s) => { setSelectedSymbol(s); setActiveTab('details'); }}
                onRemove={toggleWatchlist}
              />
            </motion.div>
          ) : (
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              {activeTab === 'dashboard' && <Dashboard stocks={stocks} onNewSignal={addToast} onSelectStock={(s) => { setSelectedSymbol(s); setActiveTab('details'); }} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />}
              {activeTab === 'market-map' && <MarketMap />}
              {activeTab === 'screener' && <Screener stocks={stocks} onSelectStock={(s) => { setSelectedSymbol(s); setActiveTab('details'); }} watchlist={watchlist} onToggleWatchlist={toggleWatchlist} />}
              {activeTab === 'details' && selectedSymbol && (
                <StockDetails 
                  symbol={selectedSymbol} 
                  stock={stocks.find(s => s.symbol === selectedSymbol)} 
                  onBack={() => setActiveTab('dashboard')} 
                  watchlist={watchlist}
                  onToggleWatchlist={toggleWatchlist}
                />
              )}
              {activeTab === 'backtest' && <Backtest stocks={stocks} />}
              {activeTab === 'portfolio' && (
                <div className="p-6">
                   <Card title="Wealth Intelligence" icon={PieChart}>
                      <div className="py-24 text-center">
                         <div className="relative inline-block mb-8">
                              <PieChart className="text-slate-800 w-24 h-24" />
                              <motion.div 
                                  animate={{ rotate: 360 }}
                                  transition={{ duration: 10, repeat: Infinity, ease: 'linear' }}
                                  className="absolute inset-0 border-2 border-dashed border-blue-500/20 rounded-full"
                              />
                         </div>
                         <h3 className="text-white font-black text-2xl italic tracking-tighter uppercase tracking-widest text-blue-500 text-center">Elite Wealth Engine</h3>
                         <p className="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mt-3">Advanced tracking is deploying soon</p>
                      </div>
                   </Card>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Notifications Portal */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.95 }}
              className={cn(
                "w-72 bg-slate-900 border-l-4 p-4 rounded-xl shadow-2xl pointer-events-auto flex gap-3",
                toast.type === 'BUY' ? "border-emerald-500" : "border-rose-500"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                toast.type === 'BUY' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
              )}>
                {toast.type === 'BUY' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <h5 className="text-[10px] font-black uppercase tracking-widest text-slate-400">{toast.title}</h5>
                  <span className="text-[9px] font-black text-slate-500 bg-slate-950 px-1 border border-slate-800 rounded">{toast.confidence}% Conf.</span>
                </div>
                <p className="text-[11px] text-white font-bold line-clamp-2 leading-relaxed italic opacity-90">
                  {toast.message}
                </p>
              </div>
              <button 
                onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
                className="text-slate-600 hover:text-white transition-colors ml-auto"
              >
                <Plus className="w-4 h-4 rotate-45" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <footer className="py-12 border-t border-slate-900 bg-slate-950 text-center relative">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-slate-950 px-4">
             <div className="w-10 h-10 bg-slate-900 rounded-full border border-slate-800 flex items-center justify-center">
                 <Zap className="text-blue-500 w-5 h-5 fill-blue-500" />
             </div>
        </div>
        <div className="flex items-center justify-center gap-2 mb-4 mt-4">
          <span className="text-xl font-black text-white tracking-tight">BHARAT<span className="text-blue-500">STOCK</span></span>
        </div>
        <p className="text-slate-600 text-[10px] font-bold uppercase tracking-[0.4em] mb-6">Trade with the edge of AI Intelligence</p>
        <div className="flex justify-center gap-10 text-slate-500 mb-8">
           <a href="#" className="flex items-center gap-2 text-xs font-bold hover:text-white transition-colors"><Share2 className="w-3 h-3" /> Community</a>
           <a href="#" className="flex items-center gap-2 text-xs font-bold hover:text-white transition-colors"><Download className="w-3 h-3" /> Documentation</a>
           <a href="#" className="flex items-center gap-2 text-xs font-bold hover:text-white transition-colors"><Info className="w-4 h-4" /> Legal</a>
        </div>
        <p className="text-slate-800 text-[8px] font-black uppercase tracking-widest px-6 max-w-2xl mx-auto">
            Investment in securities market are subject to market risks. Read all the related documents carefully before investing. AI signals are research representations and not advisory.
        </p>
      </footer>
    </div>
  );
}


