import React, { useState, useEffect } from 'react';
import {
  Search, Zap, TrendingUp, TrendingDown, Loader, RefreshCw,
  ChevronRight, Filter, BarChart3, AlertCircle
} from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';

interface TrendlyneStock {
  stockId: string;
  name: string;
  ltp: number;
  change: number;
  changePercent: number;
  screenerName: string;
  screenerType?: string;
  [key: string]: any;
}

interface TrendlyneScreenerData {
  success: boolean;
  data: TrendlyneStock[];
  screenerName?: string;
  totalResults?: number;
}

const TrendlyneScreenerPanel: React.FC = () => {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredStocks, setFilteredStocks] = useState<TrendlyneStock[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'screeners' | 'details'>('screeners');

  // TRPC hooks
  const getTrendlyneScreener = trpc.getTrendlyneScreener.useQuery(
    { stockId: undefined, pageNumber: 0, groupName: selectedCategory },
    { enabled: false }
  );

  const getTrendlyneScreenerNames = trpc.getTrendlyneScreenerNames.useQuery();
  const getTrendlyneCategories = trpc.getTrendlyneCategories.useQuery();

  // Fetch screener data
  const handleFetchScreeners = async () => {
    setIsLoading(true);
    try {
      console.log('📊 Fetching Trendlyne screeners with category:', selectedCategory);
      const result = await getTrendlyneScreener.refetch();
      console.log('📊 Trendlyne response:', result.data);

      if (result.data?.success) {
        const stocks = (result.data.data || []) as TrendlyneStock[];
        console.log(`✅ Received ${stocks.length} stocks from Trendlyne`);

        // Apply search filter
        let filtered = stocks;
        if (searchQuery) {
          filtered = stocks.filter(s =>
            s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            s.screenerName.toLowerCase().includes(searchQuery.toLowerCase())
          );
        }

        setFilteredStocks(filtered);
      } else {
        console.error('❌ Trendlyne API returned unsuccessful:', result.data);
      }
    } catch (error) {
      console.error('❌ Error fetching Trendlyne screeners:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Test API connection
  const testApi = trpc.testTrendlyneApi.useQuery(
    { stockId: '19814' },
    { enabled: false }
  );

  const handleTestApi = async () => {
    console.log('🧪 Testing Trendlyne API...');
    const result = await testApi.refetch();
    console.log('🧪 API Test Result:', result.data);
  };

  // Auto-fetch on category change
  useEffect(() => {
    handleFetchScreeners();
  }, [selectedCategory]);

  // Use dynamic screener names if available, fallback to hardcoded categories
  const dynamicCategories = getTrendlyneScreenerNames.data;
  const categories = (dynamicCategories && dynamicCategories.length > 0)
    ? dynamicCategories
    : (getTrendlyneCategories.data || []);

  const isPositive = (value: number) => value >= 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 rounded-lg border border-slate-700/50 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-6 h-6 text-amber-400" />
              <h2 className="text-2xl font-bold text-white">Trendlyne Screeners</h2>
            </div>
            <p className="text-sm text-slate-400">
              Live technical and fundamental screener data from Trendlyne
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleFetchScreeners}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-400/50 rounded-lg text-amber-400 font-medium transition-all disabled:opacity-50"
            >
              <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
              Refresh
            </button>
            <button
              onClick={handleTestApi}
              className="flex items-center gap-2 px-3 py-2 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded-lg text-slate-400 text-sm font-medium transition-all"
              title="Test API connection"
            >
              🧪 Test API
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-700">
        <button
          onClick={() => setActiveTab('screeners')}
          className={cn(
            "px-4 py-2 font-medium border-b-2 transition-all",
            activeTab === 'screeners'
              ? "border-amber-400 text-amber-400"
              : "border-transparent text-slate-400 hover:text-slate-300"
          )}
        >
          Screeners
        </button>
        <button
          onClick={() => setActiveTab('details')}
          className={cn(
            "px-4 py-2 font-medium border-b-2 transition-all",
            activeTab === 'details'
              ? "border-amber-400 text-amber-400"
              : "border-transparent text-slate-400 hover:text-slate-300"
          )}
        >
          Categories
        </button>
      </div>

      {activeTab === 'screeners' ? (
        <>
          {/* Search and Filter */}
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                placeholder="Search stocks or screener names..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-amber-400/50"
              />
            </div>

            {/* Category Filter */}
            <div className="flex flex-wrap gap-2">
              {getTrendlyneScreenerNames.isLoading && (
                <div className="text-xs text-slate-500 w-full animate-pulse">
                  Loading screener names from API...
                </div>
              )}
              {categories.length === 0 && !getTrendlyneScreenerNames.isLoading && (
                <div className="text-xs text-slate-500 w-full">
                  No categories available. Click "Test API" to debug.
                </div>
              )}
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id)}
                  className={cn(
                    "px-3 py-1 rounded-full text-sm font-medium transition-all border",
                    selectedCategory === cat.id
                      ? "bg-amber-500/20 text-amber-400 border-amber-400/50"
                      : "bg-slate-800/50 text-slate-400 border-slate-700 hover:border-slate-600"
                  )}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {/* Loading State */}
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader className="w-8 h-8 text-amber-400 animate-spin" />
            </div>
          )}

          {/* No Results */}
          {!isLoading && filteredStocks.length === 0 && (
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-8 text-center">
              <AlertCircle className="w-12 h-12 text-slate-500 mx-auto mb-3" />
              <p className="text-slate-400">No screener results found</p>
              <p className="text-sm text-slate-500 mt-1">
                Try adjusting your search or category filters
              </p>
            </div>
          )}

          {/* Stocks Grid */}
          {!isLoading && filteredStocks.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm font-medium text-slate-400 px-2">
                {filteredStocks.length} stocks found
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredStocks.map((stock) => (
                  <div
                    key={`${stock.stockId}-${stock.screenerName}`}
                    className="bg-slate-800/50 border border-slate-700 rounded-lg p-4 hover:border-slate-600 transition-all hover:shadow-lg hover:shadow-amber-500/10 group cursor-pointer"
                  >
                    {/* Stock Header */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <h3 className="font-bold text-white text-base group-hover:text-amber-400 transition-colors">
                          {stock.name}
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">
                          {stock.screenerName}
                        </p>
                      </div>
                      <ChevronRight className="w-5 h-5 text-slate-600 group-hover:text-amber-400 transition-colors" />
                    </div>

                    {/* Price and Change */}
                    <div className="space-y-2 mb-3">
                      <div className="flex items-baseline justify-between">
                        <span className="text-xl font-bold text-white">
                          ₹{stock.ltp.toLocaleString()}
                        </span>
                        <div
                          className={cn(
                            "flex items-center gap-1 text-sm font-medium px-2 py-1 rounded",
                            isPositive(stock.change)
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-rose-500/20 text-rose-400"
                          )}
                        >
                          {isPositive(stock.change) ? (
                            <TrendingUp className="w-3 h-3" />
                          ) : (
                            <TrendingDown className="w-3 h-3" />
                          )}
                          <span>
                            {Math.abs(stock.change).toFixed(2)} ({stock.changePercent.toFixed(2)}%)
                          </span>
                        </div>
                      </div>

                      {/* Screener Type Badge */}
                      {stock.screenerType && (
                        <div className="flex gap-1">
                          <span className="inline-flex items-center gap-1 px-2 py-1 bg-slate-700/50 rounded text-xs text-slate-400">
                            <Zap className="w-3 h-3" />
                            {stock.screenerType}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="pt-3 border-t border-slate-700 flex items-center gap-2 text-slate-500 text-xs group-hover:text-amber-400/70 transition-colors">
                      <Filter className="w-3 h-3" />
                      <span>View details</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Categories Details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className="bg-slate-800/50 border border-slate-700 rounded-lg p-4 hover:border-amber-400/50 transition-all"
              >
                <h3 className="font-bold text-white text-base mb-2">{cat.name}</h3>
                <p className="text-sm text-slate-400">{cat.description}</p>
                <button
                  onClick={() => {
                    setSelectedCategory(cat.id);
                    setActiveTab('screeners');
                  }}
                  className="mt-3 text-amber-400 hover:text-amber-300 text-sm font-medium flex items-center gap-1 transition-colors"
                >
                  View Stocks <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Footer Info */}
      <div className="bg-slate-800/30 border border-slate-700/50 rounded-lg p-3 text-xs text-slate-500 space-y-1">
        <p>
          Data provided by Trendlyne's All-in-One Screener API. Updates every 5 minutes.
        </p>
        <p>
          Categories: {categories.length > 0 ? `${categories.length} loaded` : 'Loading...'} |
          Screeners: {filteredStocks.length} found
        </p>
        {getTrendlyneScreenerNames.isLoading && (
          <p className="text-amber-600">⏳ Fetching screener names from API...</p>
        )}
        {getTrendlyneScreenerNames.error && (
          <p className="text-rose-600">❌ Error loading screeners: {String(getTrendlyneScreenerNames.error)}</p>
        )}
      </div>
    </div>
  );
};

export default TrendlyneScreenerPanel;
