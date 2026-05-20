import React, { useEffect, useRef, memo } from 'react';

// --- Helper to generate a unique ID for widgets ---
const generateId = () => `tv-widget-${Math.random().toString(36).substr(2, 9)}`;

// --- Ticker Tape Widget ---
export const TickerTapeWidget: React.FC = memo(() => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    container.current.innerHTML = '';
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      "symbols": [
        { "proName": "FOREXCOM:SPX500", "title": "S&P 500" },
        { "proName": "FOREXCOM:NSXUSD", "title": "US 100" },
        { "proName": "FX_IDC:INRUSD", "title": "INR/USD" },
        { "proName": "BITSTAMP:BTCUSD", "title": "Bitcoin" },
        { "proName": "NSE:NIFTY", "title": "Nifty 50" },
        { "proName": "NSE:BANKNIFTY", "title": "Bank Nifty" },
        { "proName": "NSE:RELIANCE", "title": "Reliance" },
        { "proName": "NSE:HDFCBANK", "title": "HDFC Bank" }
      ],
      "showSymbolLogo": true,
      "colorTheme": "dark",
      "isTransparent": true,
      "displayMode": "adaptive",
      "locale": "in"
    });
    container.current.appendChild(script);
  }, []);

  return (
    <div className="tradingview-widget-container" ref={container}>
      <div className="tradingview-widget-container__widget"></div>
    </div>
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
    if (!container.current) return;
    container.current.innerHTML = '';
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
  }, [tvSymbol, height, width]);

  return (
    <div className="tradingview-widget-container" ref={container}>
      <div className="tradingview-widget-container__widget"></div>
    </div>
  );
});

// --- Economic Calendar Widget ---
export const EconomicCalendarWidget: React.FC = memo(() => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    container.current.innerHTML = '';
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
  }, []);

  return (
    <div className="tradingview-widget-container" ref={container}>
      <div className="tradingview-widget-container__widget"></div>
    </div>
  );
});

// --- Market Heatmap Widget ---
export const MarketHeatmapWidget: React.FC = memo(() => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    container.current.innerHTML = '';
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      "exchanges": ["NSE"],
      "dataSource": "Nifty50",
      "grouping": "sector",
      "blockSize": "market_cap_basic",
      "blockColor": "change",
      "locale": "in",
      "symbolUrl": "",
      "colorTheme": "dark",
      "hasTopBar": true,
      "isTransparent": true,
      "hasSymbolTooltip": true,
      "width": "100%",
      "height": "600"
    });
    container.current.appendChild(script);
  }, []);

  return (
    <div className="tradingview-widget-container" ref={container}>
      <div className="tradingview-widget-container__widget"></div>
    </div>
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
    if (!container.current) return;
    container.current.innerHTML = '';
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.type = "text/javascript";
    script.async = true;
    script.onload = () => {
      if ((window as any).TradingView) {
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
          "container_id": container.current?.id
        });
      }
    };
    const widgetId = generateId();
    container.current.id = widgetId;
    document.head.appendChild(script);
  }, [tvSymbol, height]);

  return (
    <div id="tv-advanced-chart" className="w-full rounded-2xl overflow-hidden border border-slate-800" ref={container} />
  );
});

// --- Market Overview Widget ---
export const MarketOverviewWidget: React.FC = memo(() => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    container.current.innerHTML = '';
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
  }, []);

  return (
    <div className="tradingview-widget-container" ref={container}>
      <div className="tradingview-widget-container__widget"></div>
    </div>
  );
});
