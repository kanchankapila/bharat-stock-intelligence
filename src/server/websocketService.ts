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

export class WebSocketSignalService {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private priceThreshold = 0.02; // 2% price move threshold
  private lastPrices: Map<string, number> = new Map();

  /**
   * Initialize WebSocket server attached to HTTP server
   */
  public initialize(httpServer: HttpServer): void {
    this.wss = new WebSocketServer({ server: httpServer });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('[WebSocketService] New client connected');
      this.clients.add(ws);

      ws.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data);
          this.handleClientMessage(ws, msg);
        } catch (err) {
          console.error('[WebSocketService] Invalid message:', err);
        }
      });

      ws.on('close', () => {
        console.log('[WebSocketService] Client disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error('[WebSocketService] WebSocket error:', err);
        this.clients.delete(ws);
      });
    });

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

    if (alert.signal && alert.signal.signalType === 'BUY' && (alert.signal.confidence ?? 0) >= 85) {
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
    if (this.wss) {
      this.wss.close();
      console.log('[WebSocketService] Shutdown complete');
    }
  }
}

// Export singleton instance
export const wsSignalService = new WebSocketSignalService();
