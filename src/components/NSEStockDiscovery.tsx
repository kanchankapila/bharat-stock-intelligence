import React, { useState, useEffect, useMemo } from 'react';
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
  const PAGE_SIZE = 60;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [selectedIndustry, setSelectedIndustry] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [displayedStocks, setDisplayedStocks] = useState<NSEStock[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Debounced so typing a symbol/name doesn't re-filter the full (up to thousands-of-rows)
  // stock list on every keystroke -- was firing the useEffect below on each character.
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchQuery(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // TRPC Hooks
  const allStocksQuery = trpc.getAllNSEStocks.useQuery();
  const sectorsQuery = trpc.getAllSectors.useQuery();
  const industriesQuery = trpc.getAllIndustries.useQuery();
  const sectorStocksQuery = trpc.getNSEStocksBySector.useQuery(
    { sector: selectedSector || '' },
    { enabled: !!selectedSector && !debouncedSearchQuery }
  );
  const industryStocksQuery = trpc.getNSEStocksByIndustry.useQuery(
    { industry: selectedIndustry || '' },
    { enabled: !!selectedIndustry && !debouncedSearchQuery && !selectedSector }
  );
  const stockCountQuery = trpc.getNSEStockCount.useQuery();

  // Update displayed stocks based on filters and search
  useEffect(() => {
    let stocks: NSEStock[] = [];

    if (debouncedSearchQuery.length > 0) {
      const lowerQuery = debouncedSearchQuery.toLowerCase();

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
    setVisibleCount(PAGE_SIZE); // reset paging whenever the effective filter set changes
  }, [
    debouncedSearchQuery,
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

  // The unfiltered universe is thousands of rows -- rendering all of them as full card/row DOM
  // subtrees at once (previously: no cap at all) was the first-open freeze/jank flagged in the
  // 2026-08-02 audit. Cap the render to a page at a time instead of pulling in a virtualization
  // library (a new dependency + a bundle-size tradeoff working against the same audit's other
  // goal, and one this sandbox can't visually verify against a live browser).
  const visibleStocks = useMemo(
    () => displayedStocks.slice(0, visibleCount),
    [displayedStocks, visibleCount],
  );
  const hasMore = visibleCount < displayedStocks.length;

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
              <Briefcase className="w-6 h-6 text-blue-400" />
              <h2 className="text-2xl font-bold text-slate-100">NSE Stock Discovery</h2>
            </div>
            <p className="text-sm text-blue-200">
              Browse and search all NSE listed stocks with sector and industry filtering
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-blue-400">{totalStocks}</p>
            <p className="text-xs text-blue-200">Total Stocks</p>
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search by symbol or company name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-4 py-2 bg-slate-800 border border-slate-800/30 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-400/50"
        />
      </div>

      {/* Filters Section */}
      <div className="space-y-4">
        {/* Sector Filter */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Filter className="w-4 h-4" />
              Sector
            </label>
            {selectedSector && (
              <button
                onClick={() => setSelectedSector(null)}
                className="text-xs text-blue-400 hover:text-blue-300"
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
                    ? 'bg-blue-500/20 text-blue-400 border-blue-400/50'
                    : 'bg-slate-800/50 text-slate-400 border-slate-800/30 hover:border-slate-600'
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
              <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                <Filter className="w-4 h-4" />
                Industry
              </label>
              {selectedIndustry && (
                <button
                  onClick={() => setSelectedIndustry(null)}
                  className="text-xs text-blue-400 hover:text-blue-300"
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
                        ? 'bg-blue-500/20 text-blue-400 border-blue-400/50'
                        : 'bg-slate-800/50 text-slate-400 border-slate-800/30 hover:border-slate-600'
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
            className="text-sm text-slate-400 hover:text-slate-300 underline"
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
              ? 'bg-blue-500/20 text-blue-400 border-blue-400/50'
              : 'bg-slate-800/50 text-slate-400 border-slate-800/30 hover:border-slate-600'
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
              ? 'bg-blue-500/20 text-blue-400 border-blue-400/50'
              : 'bg-slate-800/50 text-slate-400 border-slate-800/30 hover:border-slate-600'
          )}
          title="List View"
        >
          <List className="w-4 h-4" />
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader className="w-8 h-8 text-blue-400 animate-spin" />
        </div>
      )}

      {/* No Results */}
      {!isLoading && displayedStocks.length === 0 && (
        <div className="bg-slate-800/50 border border-slate-800/30 rounded-lg p-8 text-center">
          <TrendingUp className="w-12 h-12 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-400">No stocks found</p>
          <p className="text-sm text-slate-400 mt-1">
            Try adjusting your search or filters
          </p>
        </div>
      )}

      {/* Stocks Grid View */}
      {!isLoading && displayedStocks.length > 0 && viewMode === 'grid' && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-slate-400 px-2">
            {displayedStocks.length} stocks found
            {selectedSector && ` in ${selectedSector}`}
            {selectedIndustry && ` • ${selectedIndustry}`}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleStocks.map((stock) => (
              <div
                key={stock.symbol}
                onClick={() => onSelectStock && stock.symbol && onSelectStock(stock.symbol)}
                className="bg-slate-800/50 border border-slate-800/30 rounded-lg p-4 hover:border-slate-600 transition-all hover:shadow-lg hover:shadow-blue-500/10 group cursor-pointer"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="font-bold text-slate-100 text-base group-hover:text-blue-400 transition-colors">
                      {stock.symbol}
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                      {stock.name}
                    </p>
                  </div>
                </div>

                <div className="space-y-2 mb-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Sector:</span>
                    <span className="text-slate-300 font-medium">{stock.sector}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Industry:</span>
                    <span className="text-slate-300 font-medium">{stock.industry}</span>
                  </div>
                  {stock.isin && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">ISIN:</span>
                      <span className="text-slate-300 font-mono">{stock.isin}</span>
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-800/30 flex items-center gap-2 text-slate-400 text-xs group-hover:text-blue-400/70 transition-colors">
                  <TrendingUp className="w-3 h-3" />
                  <span>View Details</span>
                </div>
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
              className="w-full py-3 bg-slate-800/50 border border-slate-800/30 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:border-slate-600 transition-all"
            >
              Load {Math.min(PAGE_SIZE, displayedStocks.length - visibleCount)} more ({displayedStocks.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}

      {/* Stocks List View */}
      {!isLoading && displayedStocks.length > 0 && viewMode === 'list' && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-slate-400 px-2">
            {displayedStocks.length} stocks found
          </div>
          <div className="bg-slate-800/30 rounded-lg overflow-hidden border border-slate-800/30">
            <div className="grid grid-cols-12 gap-4 p-4 bg-slate-800/50 border-b border-slate-800/30 font-medium text-xs text-slate-400">
              <div className="col-span-2">Symbol</div>
              <div className="col-span-4">Company Name</div>
              <div className="col-span-3">Sector</div>
              <div className="col-span-3">Industry</div>
            </div>
            {visibleStocks.map((stock) => (
              <div
                key={stock.symbol}
                onClick={() => onSelectStock && stock.symbol && onSelectStock(stock.symbol)}
                className="grid grid-cols-12 gap-4 p-4 border-b border-slate-800/30 hover:bg-slate-800/50 transition-colors cursor-pointer group"
              >
                <div className="col-span-2">
                  <span className="font-bold text-slate-100 group-hover:text-blue-400 transition-colors">
                    {stock.symbol}
                  </span>
                </div>
                <div className="col-span-4">
                  <p className="text-sm text-slate-300 line-clamp-1">{stock.name}</p>
                </div>
                <div className="col-span-3">
                  <span className="text-xs bg-slate-700/30 px-2 py-1 rounded text-slate-300">
                    {stock.sector}
                  </span>
                </div>
                <div className="col-span-3">
                  <span className="text-xs bg-slate-700/30 px-2 py-1 rounded text-slate-300">
                    {stock.industry}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
              className="w-full py-3 bg-slate-800/50 border border-slate-800/30 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:border-slate-600 transition-all"
            >
              Load {Math.min(PAGE_SIZE, displayedStocks.length - visibleCount)} more ({displayedStocks.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}

      {/* Footer Info */}
      <div className="bg-slate-800/30 border border-slate-800/30 rounded-lg p-3 text-xs text-slate-400 space-y-1">
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
