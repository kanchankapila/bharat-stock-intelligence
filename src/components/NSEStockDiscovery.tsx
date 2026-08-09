import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Filter, TrendingUp, Briefcase, Grid3x3, List as ListIcon, Loader } from 'lucide-react';
import { List, Grid, type RowComponentProps, type CellComponentProps } from 'react-window';
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

interface StockListRowProps {
  stocks: NSEStock[];
  onSelectStock?: (symbol: string) => void;
}

/** One virtualized row for the List view. Fixed height (see LIST_ROW_HEIGHT below) so
 * react-window can compute scroll geometry without measuring every row up front -- the whole
 * point of virtualizing a list that can be thousands of rows long. */
function StockListRow({ index, style, stocks, onSelectStock }: RowComponentProps<StockListRowProps>): React.ReactElement | null {
  const stock = stocks[index];
  if (!stock) return null;
  return (
    <div
      style={style}
      onClick={() => onSelectStock && stock.symbol && onSelectStock(stock.symbol)}
      className="grid grid-cols-12 gap-4 p-4 border-b border-slate-800/30 hover:bg-slate-800/50 transition-colors cursor-pointer group items-center"
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
  );
}

const LIST_ROW_HEIGHT = 68;
const LIST_VIEWPORT_HEIGHT = 640;

interface StockGridCellProps {
  stocks: NSEStock[];
  columnCount: number;
  onSelectStock?: (symbol: string) => void;
}

/** One virtualized cell for the Grid view. Fixed row height (see GRID_ROW_HEIGHT below), sized
 * generously enough that a 2-line company name plus the ISIN row never clips -- shorter cards
 * just leave a little blank space, which is the standard tradeoff for a fixed-height virtualized
 * grid and not a layout regression. Column count is measured from the Grid's own rendered width
 * (see columnCountForWidth) rather than a fixed number, so it still adapts responsively. */
function StockGridCell({ columnIndex, rowIndex, style, stocks, columnCount, onSelectStock, ariaAttributes }: CellComponentProps<StockGridCellProps>): React.ReactElement | null {
  const stock = stocks[rowIndex * columnCount + columnIndex];
  if (!stock) return <div style={style} {...ariaAttributes} />;
  return (
    <div style={style} {...ariaAttributes} className="p-2">
      <div
        onClick={() => onSelectStock && stock.symbol && onSelectStock(stock.symbol)}
        className="h-full bg-slate-800/50 border border-slate-800/30 rounded-lg p-4 hover:border-slate-600 transition-all hover:shadow-lg hover:shadow-blue-500/10 group cursor-pointer overflow-hidden"
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
            <span className="text-slate-300 font-medium truncate ml-2">{stock.sector}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Industry:</span>
            <span className="text-slate-300 font-medium truncate ml-2">{stock.industry}</span>
          </div>
          {stock.isin && (
            <div className="flex justify-between">
              <span className="text-slate-400">ISIN:</span>
              <span className="text-slate-300 font-mono truncate ml-2">{stock.isin}</span>
            </div>
          )}
        </div>

        <div className="pt-3 border-t border-slate-800/30 flex items-center gap-2 text-slate-400 text-xs group-hover:text-blue-400/70 transition-colors">
          <TrendingUp className="w-3 h-3" />
          <span>View Details</span>
        </div>
      </div>
    </div>
  );
}

const GRID_ROW_HEIGHT = 240;
const GRID_VIEWPORT_HEIGHT = 720;
// Mirrors the Tailwind breakpoints the old CSS grid used (grid-cols-1 md:grid-cols-2 lg:grid-cols-3),
// but measured off the Grid's own rendered width rather than the viewport -- correct even when a
// sidebar or narrower parent container means the two diverge.
function columnCountForWidth(width: number): number {
  if (width >= 1024) return 3;
  if (width >= 768) return 2;
  return 1;
}

const NSEStockDiscovery: React.FC<{
  onSelectStock?: (symbol: string) => void;
}> = ({ onSelectStock }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [selectedIndustry, setSelectedIndustry] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [displayedStocks, setDisplayedStocks] = useState<NSEStock[]>([]);
  // Percentage-string columnWidth (e.g. "33.33%") silently resolves to 0px in this react-window
  // version -- verified live, every cell collapsed into column 0. Track the Grid's actual pixel
  // width instead and compute a numeric columnWidth from it, the codepath that's proven to work
  // (rowHeight, a plain number, always rendered correctly).
  const [gridWidth, setGridWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1024));
  const gridColumnCount = columnCountForWidth(gridWidth);
  const handleGridResize = useCallback((size: { width: number; height: number }) => {
    if (size.width > 0) setGridWidth(size.width);
  }, []);

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

  // Both views now render the FULL filtered set virtualized (no page cap, no "Load more" click).
  // Grid's fixed GRID_ROW_HEIGHT (see StockGridCell above) is what makes this safe despite the
  // underlying cards having slightly variable content -- react-window only needs a column count
  // and a row height, not truly uniform content, and gridColumnCount is measured off the Grid's
  // own rendered width via handleGridResize rather than assumed.
  const gridRowCount = Math.max(1, Math.ceil(displayedStocks.length / gridColumnCount));
  const gridCellProps = useMemo<StockGridCellProps>(
    () => ({ stocks: displayedStocks, columnCount: gridColumnCount, onSelectStock }),
    [displayedStocks, gridColumnCount, onSelectStock],
  );

  const listRowProps = useMemo<StockListRowProps>(
    () => ({ stocks: displayedStocks, onSelectStock }),
    [displayedStocks, onSelectStock],
  );

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
          <ListIcon className="w-4 h-4" />
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

      {/* Stocks Grid View -- virtualized, renders the full filtered set regardless of count */}
      {!isLoading && displayedStocks.length > 0 && viewMode === 'grid' && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-slate-400 px-2">
            {displayedStocks.length} stocks found
            {selectedSector && ` in ${selectedSector}`}
            {selectedIndustry && ` • ${selectedIndustry}`}
          </div>
          <Grid
            cellComponent={StockGridCell}
            cellProps={gridCellProps}
            columnCount={gridColumnCount}
            columnWidth={Math.max(1, Math.floor(gridWidth / gridColumnCount))}
            defaultWidth={gridWidth}
            rowCount={gridRowCount}
            rowHeight={GRID_ROW_HEIGHT}
            onResize={handleGridResize}
            style={{ height: Math.min(GRID_VIEWPORT_HEIGHT, gridRowCount * GRID_ROW_HEIGHT), width: '100%' }}
          />
        </div>
      )}

      {/* Stocks List View -- virtualized, renders the full filtered set regardless of count */}
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
            <List
              rowComponent={StockListRow}
              rowCount={displayedStocks.length}
              rowHeight={LIST_ROW_HEIGHT}
              rowProps={listRowProps}
              defaultHeight={LIST_VIEWPORT_HEIGHT}
              style={{ height: Math.min(LIST_VIEWPORT_HEIGHT, displayedStocks.length * LIST_ROW_HEIGHT) }}
            />
          </div>
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
