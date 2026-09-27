import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import './theme.css';

/*
 * Route table for the TALA terminal. Every page is lazy so the initial /tala
 * load is the desk home only — the stock page alone pulls in the chart, table
 * and search machinery, and none of that should be in the first paint.
 */
const DeskHome      = lazy(() => import('./pages/DeskHome'));
const PicksPage     = lazy(() => import('./pages/PicksPage'));
const ScreenersPage = lazy(() => import('./pages/ScreenersPage'));
const MarketPage    = lazy(() => import('./pages/MarketPage'));
const IndicesPage   = lazy(() => import('./pages/IndicesPage'));
const NewsPage      = lazy(() => import('./pages/NewsPage'));
const StockPage     = lazy(() => import('./pages/StockPage'));
const EdgePage      = lazy(() => import('./pages/EdgePage'));
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));

function Booting() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-9 place-items-center rounded bg-marigold font-display text-[18px] leading-none font-extrabold text-ink-950">
          त
        </span>
        <span className="tala-live-dot font-mono text-[10px] tracking-[0.3em] text-mark-4 uppercase">
          Opening desk
        </span>
      </div>
    </div>
  );
}

export default function TalaRoutes() {
  return (
    <Suspense fallback={<Booting />}>
      <Routes>
        <Route index element={<DeskHome />} />
        <Route path="picks" element={<PicksPage />} />
        <Route path="screeners" element={<ScreenersPage />} />
        <Route path="market" element={<MarketPage />} />
        <Route path="indices" element={<IndicesPage />} />
        <Route path="news" element={<NewsPage />} />
        <Route path="edge" element={<EdgePage />} />
        <Route path="book" element={<PortfolioPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="stock/:symbol" element={<StockPage />} />
        <Route path="*" element={<DeskHome />} />
      </Routes>
    </Suspense>
  );
}
