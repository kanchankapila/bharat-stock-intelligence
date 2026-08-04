import { useState, useEffect } from 'react';
import { notifyAlert } from '../lib/browserNotify';

export interface AlertMessage {
  id: string;
  type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  title: string;
  message: string;
  timestamp: string;
}

export function useAlerts(userId?: string) {
  const [alerts, setAlerts] = useState<AlertMessage[]>([]);

  useEffect(() => {
    const url = userId ? `/api/stream?userId=${encodeURIComponent(userId)}` : '/api/stream';
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') return;

        const newAlert: AlertMessage = {
          id: data.id || Math.random().toString(36).substring(7),
          type: data.type || 'INFO',
          title: data.title || 'Notification',
          message: data.message || 'System update',
          timestamp: new Date().toISOString(),
        };

        setAlerts((prev) => [newAlert, ...prev].slice(0, 10)); // keep last 10
        notifyAlert(newAlert.title, newAlert.message);
      } catch (e) {
        console.error('Failed to parse SSE message', e);
      }
    };

    eventSource.onerror = () => {
      console.warn('SSE connection lost, reconnecting...');
    };

    return () => {
      eventSource.close();
    };
  }, [userId]);

  const removeAlert = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  return { alerts, removeAlert };
}
