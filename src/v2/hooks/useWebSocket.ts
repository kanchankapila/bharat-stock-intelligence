import { useState, useEffect, useRef } from 'react';

// Defines the shape of the incoming signal from WebSocketSignalService
export interface SignalAlert {
  type: 'new_signal' | 'price_cross' | 'technical_breakthrough' | 'portfolio_move';
  symbol: string;
  timestamp: string;
  price?: number;
  level?: string;
  indicator?: string;
  value?: number;
  source?: string;
  generatedAt?: string;
  signal?: {
    signalType: string;
    entryPrice: number;
    targetPrice: number;
    stopLoss: number;
    confidence: number;
    reasoning: string;
  };
}

interface UseWebSocketProps {
  url: string;
  onMessage?: (message: SignalAlert) => void;
  reconnectAttempts?: number;
  reconnectInterval?: number; // in ms
}

export function useWebSocket({ 
  url, 
  onMessage, 
  reconnectAttempts = 5, 
  reconnectInterval = 3000 
}: UseWebSocketProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<SignalAlert | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [url]);

  const connect = () => {
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log(`[WebSocket] Connected to ${url}`);
        setIsConnected(true);
        reconnectCountRef.current = 0; // Reset reconnects on success
      };

      ws.onmessage = (event) => {
        try {
          const data: SignalAlert = JSON.parse(event.data);
          setLastMessage(data);
          if (onMessage) {
            onMessage(data);
          }
        } catch (err) {
          console.error('[WebSocket] Failed to parse message', err);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        console.log('[WebSocket] Disconnected');
        attemptReconnect();
      };

      ws.onerror = (error) => {
        console.error('[WebSocket] Error observed:', error);
        // onerror is usually followed by onclose, which handles reconnect
      };

    } catch (err) {
      console.error('[WebSocket] Failed to initialize connection', err);
      attemptReconnect();
    }
  };

  const attemptReconnect = () => {
    if (reconnectCountRef.current < reconnectAttempts) {
      reconnectCountRef.current += 1;
      console.log(`[WebSocket] Reconnecting in ${reconnectInterval}ms... (Attempt ${reconnectCountRef.current}/${reconnectAttempts})`);
      
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, reconnectInterval);
    } else {
      console.error('[WebSocket] Max reconnect attempts reached. Giving up.');
    }
  };

  // Helper to send messages (e.g. subscribe) if needed
  const sendMessage = (msg: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      console.warn('[WebSocket] Cannot send message, not connected');
    }
  };

  return { isConnected, lastMessage, sendMessage };
}
