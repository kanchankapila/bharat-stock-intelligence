import React, { useState, useEffect } from 'react';
import { Search, Filter, TrendingUp, Briefcase, Grid3x3, List, Loader } from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import stockData from '../data/stocklist';

interface NSEStock {
  id?: number;
  symbol?: string;
  name?: string;
  sector?: string;
  industry?: string;
  isin?: string;
  listing_date?: string | null;
  exchange?: string;
  status?: string;
  market_cap?: number | null;
  pe_ratio?: number | null;
  dividend_yield?: number | null;
  last_updated?: string;
}

type ViewMode = 'grid' | 'list';

const NSEStockDiscovery: React.FC<{
  onSelectStock?: (symbol: string) => void;
}> = ({ onSelectStock }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [selectedIndustry, setSelectedIndustry] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [displayedStocks, setDisplayedStocks] = useState<NSEStock[]>([]);

  // TRPC Hooks
  const allStocksQuery = trpc.getAllNSEStocks.useQuery();
  const sectorsQuery = trpc.getAllSectors.useQuery();
  const industriesQuery = trpc.getAllIndustries.useQuery();
  const sectorStocksQuery = trpc.getNSEStocksBySector.useQuery(
    { sector: selectedSector || '' },
    { enabled: !!selectedSector && !searchQuery }
  );
  const industryStocksQuery = trpc.getNSEStocksByIndustry.useQuery(
    { industry: selectedIndustry || '' },
    { enabled: !!selectedIndustry && !searchQuery && !selectedSector }
  );
  const stockCountQuery = trpc.getNSEStockCount.useQuery();

  // Update displayed stocks based on filters and search
  useEffect(() => {
    let stocks: NSEStock[] = [];

    if (searchQuery.length > 0) {
      const lowerQuery = searchQuery.toLowerCase();
      
      if (allStocksQuery.data?.stocks) {
        stocks = allStocksQuery.data.stocks.filter((s) =>
          (s.name && s.name.toLowerCase().includes(lowerQuery)) ||
          (s.symbol && s.symbol.toLowerCase().includes(lowerQuery))
        );
      }
    } else if (selectedSector && sectorStocksQuery.data?.stocks) {
      stocks = sectorStocksQuery.data.stocks;
    } else if (selectedIndustry && industryStocksQuery.data?.stocks) {
      stocks = industryStocksQuery.data.stocks;
    } else if (allStocksQuery.data?.stocks) {
      stocks = allStocksQuery.data.stocks;
    }

    setDisplayedStocks(stocks);
  }, [
    searchQuery,
    selectedSector,
    sectorStocksQuery.data,
    selectedIndustry,
    industryStocksQuery.data,
    allStocksQuery.data
  ]);

  const isLoading =
    allStocksQuery.isLoading ||
    (selectedSector && sectorStocksQuery.isLoading) ||
    (selectedIndustry && industryStocksQuery.isLoading);

  const sectors = sectorsQuery.data || [];
  const industries = industriesQuery.data || [];
  const totalStocks = stockCountQuery.data || 0;

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedSector(null);
    setSelectedIndustry(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-900 via-blue-800 to-blue-900 rounded-lg border border-blue-700/50 p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Briefcase className="w-6 h-6 text-violet-400" />
              <h2 className="text-2xl font-bold text-white">NSE Stock Discovery</h2>
            </div>
            <p className="text-sm text-blue-200">
              Browse and search all NSE listed stocks with sector and industry filtering
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-violet-400">{totalStocks}</p>
            <p className="text-xs text-blue-200">Total Stocks</p>
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input
          type="text"
          placeholder="Search by symbol or company name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-4 py-2 bg-white/[0.08] border border-white/[0.1] rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-400/50"
        />
      </div>

      {/* Filters Section */}
      <div className="space-y-4">
        {/* Sector Filter */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Filter className="w-4 h-4" />
              Sector
            </label>
            {selectedSector && (
              <button
                onClick={() => setSelectedSector(null)}
                className="text-xs text-violet-400 hover:text-blue-300"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {sectors.map((sector) => (
              <button
                key={sector}
                onClick={() => {
                  setSelectedSector(selectedSector === sector ? null : sector);
                  setSelectedIndustry(null);
                }}
                className={cn(
                  'px-3 py-1 rounded-full text-sm font-medium transition-all border',
                  selectedSector === sector
                    ? 'bg-blue-500/20 text-violet-400 border-blue-400/50'
                    : 'bg-white/[0.08]/50 text-zinc-400 border-white/[0.1] hover:border-slate-600'
                )}
              >
                {sector}
              </button>
            ))}
          </div>
        </div>

        {/* Industry Filter */}
        {selectedSector && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                <Filter className="w-4 h-4" />
                Industry
              </label>
              {selectedIndustry && (
                <button
                  onClick={() => setSelectedIndustry(null)}
                  className="text-xs text-violet-400 hover:text-blue-300"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {industries
                .filter((ind) =>
                  sectorStocksQuery.data?.stocks?.some((s) => s.industry === ind)
                )
                .map((industry) => (
                  <button
                    key={industry}
                    onClick={() => setSelectedIndustry(selectedIndustry === industry ? null : industry)}
                    className={cn(
                      'px-3 py-1 rounded-full text-sm font-medium transition-all border',
                      selectedIndustry === industry
                        ? 'bg-blue-500/20 text-violet-400 border-blue-400/50'
                        : 'bg-white/[0.08]/50 text-zinc-400 border-white/[0.1] hover:border-slate-600'
                    )}
                  >
                    {industry}
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Clear All Button */}
        {(searchQuery || selectedSector || selectedIndustry) && (
          <button
            onClick={clearFilters}
            className="text-sm text-zinc-400 hover:text-zinc-300 underline"
          >
            Clear all filters
          </button>
        )}
      </div>

      {/* View Mode Toggle */}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => setViewMode('grid')}
          className={cn(
            'p-2 rounded-lg transition-all border',
            viewMode === 'grid'
              ? 'bg-blue-500/20 text-violet-400 border-blue-400/50'
              : 'bg-white/[0.08]/50 text-zinc-400 border-white/[0.1] hover:border-slate-600'
          )}
          title="Grid View"
        >
          <Grid3x3 className="w-4 h-4" />
        </button>
        <button
          onClick={() => setViewMode('list')}
          className={cn(
            'p-2 rounded-lg transition-all border',
            viewMode === 'list'
              ? 'bg-blue-500/20 text-violet-400 border-blue-400/50'
              : 'bg-white/[0.08]/50 text-zinc-400 border-white/[0.1] hover:border-slate-600'
          )}
          title="List View"
        >
          <List className="w-4 h-4" />
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader className="w-8 h-8 text-violet-400 animate-spin" />
        </div>
      )}

      {/* No Results */}
      {!isLoading && displayedStocks.length === 0 && (
        <div className="bg-white/[0.08]/50 border border-white/[0.1] rounded-lg p-8 text-center">
          <TrendingUp className="w-12 h-12 text-zinc-500 mx-auto mb-3" />
          <p className="text-zinc-400">No stocks found</p>
          <p className="text-sm text-zinc-500 mt-1">
            Try adjusting your search or filters
          </p>
        </div>
      )}

      {/* Stocks Grid View */}
      {!isLoading && displayedStocks.length > 0 && viewMode === 'grid' && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-zinc-400 px-2">
            {displayedStocks.length} stocks found
            {selectedSector && ` in ${selectedSector}`}
            {selectedIndustry && ` • ${selectedIndustry}`}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {displayedStocks.map((stock) => (
              <div
                key={stock.symbol}
                onClick={() => onSelectStock && stock.symbol && onSelectStock(stock.symbol)}
                className="bg-white/[0.08]/50 border border-white/[0.1] rounded-lg p-4 hover:border-slate-600 transition-all hover:shadow-lg hover:shadow-blue-500/10 group cursor-pointer"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="font-bold text-white text-base group-hover:text-violet-400 transition-colors">
                      {stock.symbol}
                    </h3>
                    <p className="text-xs text-zinc-500 mt-1 line-clamp-2">
                      {stock.name}
                    </p>
                  </div>
                </div>

                <div className="space-y-2 mb-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Sector:</span>
                    <span className="text-zinc-300 font-medium">{stock.sector}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Industry:</span>
                    <span className="text-zinc-300 font-medium">{stock.industry}</span>
                  </div>
                  {stock.isin && (
                    <div className="flex justify-between">
                      <span className="text-zinc-500">ISIN:</span>
                      <span className="text-zinc-300 font-mono">{stock.isin}</span>
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-white/[0.1] flex items-center gap-2 text-zinc-500 text-xs group-hover:text-violet-400/70 transition-colors">
                  <TrendingUp className="w-3 h-3" />
                  <span>View Details</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stocks List View */}
      {!isLoading && displayedStocks.length > 0 && viewMode === 'list' && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-zinc-400 px-2">
            {displayedStocks.length} stocks found
          </div>
          <div className="bg-white/[0.05] rounded-lg overflow-hidden border border-white/[0.1]">
            <div className="grid grid-cols-12 gap-4 p-4 bg-white/[0.08]/50 border-b border-white/[0.1] font-medium text-xs text-zinc-400">
              <div className="col-span-2">Symbol</div>
              <div className="col-span-4">Company Name</div>
              <div className="col-span-3">Sector</div>
              <div className="col-span-3">Industry</div>
            </div>
            {displayedStocks.map((stock) => (
              <div
                key={stock.symbol}
                onClick={() => onSelectStock && stock.symbol && onSelectStock(stock.symbol)}
                className="grid grid-cols-12 gap-4 p-4 border-b border-white/[0.1]/50 hover:bg-white/[0.08]/50 transition-colors cursor-pointer group"
              >
                <div className="col-span-2">
                  <span className="font-bold text-white group-hover:text-violet-400 transition-colors">
                    {stock.symbol}
                  </span>
                </div>
                <div className="col-span-4">
                  <p className="text-sm text-zinc-300 line-clamp-1">{stock.name}</p>
                </div>
                <div className="col-span-3">
                  <span className="text-xs bg-slate-700/30 px-2 py-1 rounded text-zinc-300">
                    {stock.sector}
                  </span>
                </div>
                <div className="col-span-3">
                  <span className="text-xs bg-slate-700/30 px-2 py-1 rounded text-zinc-300">
                    {stock.industry}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer Info */}
      <div className="bg-white/[0.05] border border-white/[0.1]/50 rounded-lg p-3 text-xs text-zinc-500 space-y-1">
        <p>
          Comprehensive NSE stock database with {totalStocks} listed companies across {sectors.length} sectors.
        </p>
        {displayedStocks.length > 0 && (
          <p>
            Showing {displayedStocks.length} of {totalStocks} stocks
            {searchQuery && ` matching "${searchQuery}"`}
            {selectedSector && ` in ${selectedSector}`}
            {selectedIndustry && ` • ${selectedIndustry}`}
          </p>
        )}
      </div>
    </div>
  );
};

export default NSEStockDiscovery;
