/**
 * Real-time WebSocket Signal Alert System (PHASE 3.2)
 * 
 * Broadcasts real-time alerts when:
 * - New technical signals generated
 * - Price crosses key levels (support/resistance)
 * - Technical indicators breakthrough (RSI > 70 or < 30)
 * - Portfolio-relevant price movements
 * 
 * Frontend subscribes to WebSocket endpoint and receives alerts in real-time.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { telegramService } from './telegramService';

export interface SignalAlert {
  type: 'new_signal' | 'price_cross' | 'technical_breakthrough' | 'portfolio_move';
  symbol: string;
  timestamp: string;
  price?: number;
  level?: string;  // support/resistance/indicator level
  indicator?: string;  // RSI, MACD, etc.
  value?: number;  // RSI value, MACD value, etc.
  source?: string;  // 'AI', 'TECHNICAL', 'QUANT'
  generatedAt?: string;  // ISO timestamp when signal was generated
  signal?: {
    signalType: string;
    entryPrice: number;
    targetPrice: number;
    stopLoss: number;
    confidence: number;
    reasoning: string;
  };
}

const PING_INTERVAL_MS = 25_000; // below typical NAT/firewall 30s idle timeout

export class WebSocketSignalService {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private priceThreshold = 0.02; // 2% price move threshold
  private lastPrices: Map<string, number> = new Map();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Initialize WebSocket server attached to HTTP server
   */
  public initialize(httpServer: HttpServer): void {
    this.wss = new WebSocketServer({ server: httpServer });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleClientMessage(ws, msg);
        } catch {
          // ignore malformed frames
        }
      });

      ws.on('pong', () => {
        // client is alive — mark it so the ping sweep doesn't drop it
        (ws as any).__alive = true;
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    // Heartbeat sweep: ping every client; drop any that didn't respond since last ping
    this.pingTimer = setInterval(() => {
      for (const ws of this.clients) {
        try {
          if ((ws as any).__alive === false) {
            this.clients.delete(ws);
            ws.terminate();
            continue;
          }
          (ws as any).__alive = false;
          ws.ping();
        } catch (e) {
          console.warn('[WebSocketService] ping sweep error on stale client, skipping', e);
          this.clients.delete(ws);
        }
      }
    }, PING_INTERVAL_MS);

    console.log('[WebSocketService] Initialized on ws://localhost:3000/signals');
  }

  /**
   * Handle incoming messages from clients (e.g., subscribe to symbol)
   */
  private handleClientMessage(ws: WebSocket, msg: any): void {
    if (msg.type === 'subscribe') {
      console.log(`[WebSocketService] Client subscribed to ${msg.symbol}`);
      ws.send(JSON.stringify({
        type: 'subscribed',
        symbol: msg.symbol,
        status: 'ok',
      }));
    }
  }

  /**
   * Broadcast new signal alert to all connected clients
   */
  public broadcastNewSignal(alert: SignalAlert): void {
    this.broadcast({
      ...alert,
      type: 'new_signal',
      timestamp: new Date().toISOString(),
    });

    // FIXED 2026-08-05: this threshold was effectively unreachable and had not fired since
    // 2026-07-18. `confidence` here is the quant win_probability x100 (commit 0609a49 replaced
    // the LLM's self-reported 85-98 confidence with it); win_probability peaks around 0.41
    // across the universe, so `>= 85` never passed. Note this only ever gated a *legacy
    // per-signal* Telegram ping nested inside this function -- `this.broadcast()` two lines up
    // (the actual WebSocket push to connected frontend clients) was NEVER gated by this check
    // and has always fired for every AI/technical signal reaching this function; the dead
    // threshold only silenced this secondary Telegram notification, not real-time delivery.
    //
    // Dropped the redundant absolute-confidence floor rather than re-tuning it to a new magic
    // number: `processAISignal` (queues.ts) already gates on getAISignalMinConfidence() (win
    // probability >= ~0.40-0.42, ~14/2264 stocks/day) BEFORE this function is ever called with
    // source: 'AI' -- re-checking an absolute value here a second time, on a scale this
    // function doesn't own, is exactly what broke last time the scale changed underneath it.
    // Scoped to source === 'AI' specifically so the canonical unified_ranker broadcast wired
    // in via broadcastCanonicalPicks() (unifiedSignalBroadcast.ts, source: 'UNIFIED') does NOT
    // also trigger this -- telegramRecommendations.ts's once-daily digest is already the
    // canonical Telegram delivery path for those picks; firing both would double-notify.
    if (alert.source === 'AI' && alert.signal && alert.signal.signalType === 'BUY') {
      telegramService.sendSignalNotification(
        alert.symbol,
        'BUY',
        alert.signal.entryPrice,
        alert.signal.targetPrice,
        alert.signal.stopLoss,
        alert.signal.confidence,
        alert.signal.reasoning
      ).catch(err => console.error('[WebSocketService] Telegram alert failed:', err));
    }
  }

  /**
   * Broadcast price level crossing alert
   */
  public broadcastPriceCross(symbol: string, price: number, level: number, levelType: string): void {
    const levelStr = `${levelType} (${level.toFixed(2)})`;
    this.broadcast({
      type: 'price_cross',
      symbol,
      price,
      level: levelStr,
      timestamp: new Date().toISOString(),
    } as SignalAlert);

    telegramService.sendPriceCrossNotification(symbol, price, levelStr)
      .catch(err => console.error('[WebSocketService] Telegram price cross failed:', err));
  }

  /**
   * Broadcast technical indicator breakthrough (e.g., RSI > 70)
   */
  public broadcastTechnicalBreakthrough(symbol: string, indicator: string, value: number, threshold: string): void {
    this.broadcast({
      type: 'technical_breakthrough',
      symbol,
      indicator,
      value,
      level: threshold,
      timestamp: new Date().toISOString(),
    } as SignalAlert);
  }

  /**
   * Broadcast portfolio-relevant price move
   */
  public broadcastPortfolioMove(symbol: string, price: number, priceChange: number): void {
    this.broadcast({
      type: 'portfolio_move',
      symbol,
      price,
      level: `${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%`,
      timestamp: new Date().toISOString(),
    } as SignalAlert);
  }

  /**
   * Check for price threshold crossing and broadcast if needed
   * Called from liveStockData.detectAndQueueSignalUpdates()
   */
  public checkAndBroadcastPriceMove(symbol: string, currentPrice: number): void {
    const lastPrice = this.lastPrices.get(symbol);
    
    if (!lastPrice) {
      this.lastPrices.set(symbol, currentPrice);
      return;
    }

    const priceChange = Math.abs((currentPrice - lastPrice) / lastPrice);
    if (priceChange >= this.priceThreshold) {
      const changePercent = ((currentPrice - lastPrice) / lastPrice) * 100;
      this.broadcastPortfolioMove(symbol, currentPrice, changePercent);
      this.lastPrices.set(symbol, currentPrice);
    }
  }

  /**
   * Internal broadcast to all connected clients
   */
  private broadcast(alert: SignalAlert): void {
    if (!this.wss) return;

    const message = JSON.stringify(alert);
    let sentCount = 0;

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        sentCount++;
      }
    }

    if (sentCount > 0) {
      console.log(
        `[WebSocketService] Broadcast ${alert.type} for ${alert.symbol} to ${sentCount} clients`
      );
    }
  }

  /**
   * Get number of connected clients
   */
  public getConnectedClientCount(): number {
    return this.clients.size;
  }

  /**
   * Shutdown WebSocket server
   */
  public shutdown(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.wss) {
      this.wss.close();
      console.log('[WebSocketService] Shutdown complete');
    }
  }
}

// Export singleton instance
export const wsSignalService = new WebSocketSignalService();
