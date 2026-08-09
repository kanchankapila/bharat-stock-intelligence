import React, { useEffect, useRef, memo } from 'react';

// --- Helper to generate a unique ID for widgets ---
const generateId = () => `tv-widget-${Math.random().toString(36).substr(2, 9)}`;

// --- Ticker Tape Widget ---
export const TickerTapeWidget: React.FC = memo(() => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // React 18 StrictMode (dev only) runs effect->cleanup->effect synchronously on every mount.
    // Injecting the TradingView <script> immediately means the first pass's script starts loading
    // then has its container ripped out by the immediate cleanup before it finishes -- the
    // external script's own init code then throws "Cannot read properties of null (reading
    // 'querySelector')" trying to find a container that's gone. Deferring the actual injection
    // past a macrotask means the throwaway first pass's `cancelled` flag flips before its inject()
    // ever runs, so only the surviving second pass actually touches the DOM. Confirmed live
    // 2026-08-07 (console-only, doesn't crash the visible UI or trip TabErrorBoundary since it's
    // outside React's render/commit phase -- but real console noise on every dev-mode mount).
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || !container.current) return;

      // Clear container and append the target widget container
      container.current.innerHTML = '<div class="tradingview-widget-container__widget"></div>';

      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js";
      script.type = "text/javascript";
      script.async = true;
      script.innerHTML = JSON.stringify({
        "symbols": [
          { "proName": "NSE:NIFTY", "title": "NIFTY 50" },
          { "proName": "NSE:BANKNIFTY", "title": "BANK NIFTY" },
          { "proName": "NSE:RELIANCE", "title": "RELIANCE" },
          { "proName": "NSE:HDFCBANK", "title": "HDFC BANK" },
          { "proName": "NSE:TCS", "title": "TCS" },
          { "proName": "FOREXCOM:SPX500", "title": "S&P 500" },
          { "proName": "FOREXCOM:NSXUSD", "title": "US 100" },
          { "proName": "FX_IDC:USDINR", "title": "USD/INR" },
          { "proName": "BITSTAMP:BTCUSD", "title": "Bitcoin" }
        ],
        "showSymbolLogo": true,
        "colorTheme": "dark",
        "isTransparent": true,
        "displayMode": "adaptive",
        "locale": "in"
      });
      container.current.appendChild(script);
    }, 0);

    // Cleanup on unmount to prevent duplicate widgets and script conflicts in React StrictMode
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (container.current) {
        container.current.innerHTML = '';
      }
    };
  }, []);

  return (
    <div className="tradingview-widget-container w-full" ref={container} />
  );
});

// --- Technical Analysis Widget ---
interface TechnicalAnalysisWidgetProps {
  symbol: string;
  height?: number;
  width?: string | number;
}

export const TechnicalAnalysisWidget: React.FC<TechnicalAnalysisWidgetProps> = memo(({ symbol, height = 450, width = "100%" }) => {
  const container = useRef<HTMLDivElement>(null);
  const tvSymbol = symbol.includes(':') ? symbol : `NSE:${symbol}`;

  useEffect(() => {
    // See TickerTapeWidget's comment above for why injection is deferred past a macrotask --
    // avoids a StrictMode dev-mode race where the throwaway first mount's script gets its
    // container cleared before it finishes loading.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || !container.current) return;

      container.current.innerHTML = '<div class="tradingview-widget-container__widget"></div>';

      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/external-embedding/embed-widget-technical-analysis.js";
      script.type = "text/javascript";
      script.async = true;
      script.innerHTML = JSON.stringify({
        "interval": "1D",
        "width": width,
        "isTransparent": true,
        "height": height,
        "symbol": tvSymbol,
        "showIntervalTabs": true,
        "locale": "in",
        "colorTheme": "dark"
      });
      container.current.appendChild(script);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (container.current) {
        container.current.innerHTML = '';
      }
    };
  }, [tvSymbol, height, width]);

  return (
    <div className="tradingview-widget-container" ref={container} />
  );
});

// --- Economic Calendar Widget ---
export const EconomicCalendarWidget: React.FC = memo(() => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // See TickerTapeWidget's comment above for why injection is deferred past a macrotask.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || !container.current) return;

      container.current.innerHTML = '<div class="tradingview-widget-container__widget"></div>';

      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/external-embedding/embed-widget-events.js";
      script.type = "text/javascript";
      script.async = true;
      script.innerHTML = JSON.stringify({
        "colorTheme": "dark",
        "isTransparent": true,
        "width": "100%",
        "height": "600",
        "locale": "in",
        "importanceFilter": "-1,0,1",
        "currencyFilter": "INR,USD,EUR,GBP"
      });
      container.current.appendChild(script);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (container.current) {
        container.current.innerHTML = '';
      }
    };
  }, []);

  return (
    <div className="tradingview-widget-container" ref={container} />
  );
});

// --- Advanced Real-Time Chart Widget ---
interface AdvancedChartWidgetProps {
  symbol: string;
  height?: number;
}

export const AdvancedChartWidget: React.FC<AdvancedChartWidgetProps> = memo(({ symbol, height = 600 }) => {
  const container = useRef<HTMLDivElement>(null);
  const tvSymbol = symbol.includes(':') ? symbol : `NSE:${symbol}`;

  useEffect(() => {
    // See TickerTapeWidget's comment above for the StrictMode race this guards against. Here the
    // risk is a stale onload firing after a later effect run has already reassigned
    // `container.current.id` -- `initWidget()` would then ask TradingView to mount into an id no
    // longer present in the DOM. `cancelled` prevents any effect instance's own initWidget from
    // running once its cleanup has already fired, regardless of when the shared tv.js's onload
    // (or the immediate synchronous path, if tv.js was already loaded) actually calls it.
    let cancelled = false;

    const widgetId = generateId();

    const initWidget = () => {
      if (cancelled || !(window as any).TradingView || !container.current) return;
      container.current.innerHTML = '';
      container.current.id = widgetId;
      new (window as any).TradingView.widget({
        "width": "100%",
        "height": height,
        "symbol": tvSymbol,
        "interval": "D",
        "timezone": "Asia/Kolkata",
        "theme": "dark",
        "style": "1",
        "locale": "in",
        "toolbar_bg": "#f1f3f6",
        "enable_publishing": false,
        "hide_side_toolbar": false,
        "allow_symbol_change": true,
        "container_id": widgetId
      });
    };

    if ((window as any).TradingView) {
      initWidget();
    } else {
      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/tv.js";
      script.type = "text/javascript";
      script.async = true;
      script.onload = initWidget;
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      if (container.current) {
        container.current.innerHTML = '';
      }
    };
  }, [tvSymbol, height]);

  return (
    <div id="tv-advanced-chart" className="w-full rounded-2xl overflow-hidden border border-slate-800" ref={container} />
  );
});

// --- Market Overview Widget ---
export const MarketOverviewWidget: React.FC = memo(() => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // See TickerTapeWidget's comment above for why injection is deferred past a macrotask.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || !container.current) return;

      container.current.innerHTML = '<div class="tradingview-widget-container__widget"></div>';

      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js";
      script.type = "text/javascript";
      script.async = true;
      script.innerHTML = JSON.stringify({
        "colorTheme": "dark",
        "dateRange": "12M",
        "showChart": true,
        "locale": "in",
        "largeChartByLabels": ["Indices", "Futures", "Currencies"],
        "isTransparent": true,
        "showSymbolLogo": true,
        "showFloatingTooltip": true,
        "width": "100%",
        "height": "600",
        "tabs": [
          {
            "title": "Indices",
            "symbols": [
              { "s": "NSE:NIFTY", "d": "Nifty 50" },
              { "s": "NSE:BANKNIFTY", "d": "Bank Nifty" },
              { "s": "FOREXCOM:SPX500", "d": "S&P 500" },
              { "s": "FOREXCOM:NSXUSD", "d": "Nasdaq 100" },
              { "s": "INDEX:DXY", "d": "US Dollar Index" }
            ]
          },
          {
            "title": "Futures",
            "symbols": [
              { "s": "CME_MINI:ES1!", "d": "S&P 500 Fut" },
              { "s": "CME:6E1!", "d": "Euro Fut" },
              { "s": "COMEX:GC1!", "d": "Gold Fut" },
              { "s": "NYMEX:CL1!", "d": "Crude Oil Fut" }
            ]
          }
        ]
      });
      container.current.appendChild(script);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (container.current) {
        container.current.innerHTML = '';
      }
    };
  }, []);

  return (
    <div className="tradingview-widget-container" ref={container} />
  );
});
