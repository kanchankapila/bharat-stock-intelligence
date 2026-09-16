import { useState, useEffect, useRef } from 'react';

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
}

const BASE_DELAY_MS  = 1_000;
const MAX_DELAY_MS   = 30_000;

export function useWebSocket({ url, onMessage }: UseWebSocketProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<SignalAlert | null>(null);

  const wsRef               = useRef<WebSocket | null>(null);
  const reconnectCountRef   = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyedRef        = useRef(false);
  const onMessageRef        = useRef(onMessage);
  onMessageRef.current      = onMessage;

  useEffect(() => {
    destroyedRef.current    = false;
    reconnectCountRef.current = 0;
    connect();

    return () => {
      destroyedRef.current = true;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const connect = () => {
    if (destroyedRef.current) return;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (destroyedRef.current) { ws.close(); return; }
        setIsConnected(true);
        reconnectCountRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data: SignalAlert = JSON.parse(event.data as string);
          // Ignore server-side ping frames
          if ((data as any).type === '__ping__') return;
          setLastMessage(data);
          onMessageRef.current?.(data);
        } catch { /* malformed frame — ignore */ }
      };

      ws.onclose = () => {
        setIsConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onerror is always followed by onclose — let onclose handle the reconnect
      };
    } catch {
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (destroyedRef.current) return;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap), 30s, 30s, …
    const delay = Math.min(BASE_DELAY_MS * 2 ** reconnectCountRef.current, MAX_DELAY_MS);
    reconnectCountRef.current += 1;
    reconnectTimeoutRef.current = setTimeout(connect, delay);
  };

  const sendMessage = (msg: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  };

  return { isConnected, lastMessage, sendMessage };
}
