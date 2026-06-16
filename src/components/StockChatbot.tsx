import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, Bot, Wifi, WifiOff, Loader2, X } from 'lucide-react';
import { cn } from '../lib/utils';

const CHATBOT_BASE = 'http://localhost:8001';

const QUICK_QUERIES = [
  'What is the current market mood and regime?',
  'Fundamentally strong but undervalued stocks',
  'Top stocks by screener conviction today',
  'Which sector is outperforming this month?',
  'Stocks with upcoming results + positive signals',
  'What are the FII DII flows recently?',
  'How accurate are the BUY signals?',
  'Best momentum stocks above SMA 200',
];

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  streaming?: boolean;
}

interface HealthStatus {
  status: string;
  llm: string;
  graph_ready: boolean;
}

export default function StockChatbot() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthChecking, setHealthChecking] = useState(true);
  const [sessionId] = useState(() => crypto.randomUUID());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const checkHealth = useCallback(async () => {
    setHealthChecking(true);
    try {
      const res = await fetch(`${CHATBOT_BASE}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) setHealth(await res.json());
      else setHealth(null);
    } catch {
      setHealth(null);
    } finally {
      setHealthChecking(false);
    }
  }, []);

  // Initial check on mount
  useEffect(() => { checkHealth(); }, [checkHealth]);

  // Auto-retry every 10s while offline so the UI recovers without a page reload
  const isOnlineRef = useRef(false);
  isOnlineRef.current = !!(health?.status === 'ok' && health?.graph_ready);
  useEffect(() => {
    if (isOnlineRef.current) return;
    const id = setInterval(() => { if (!isOnlineRef.current) checkHealth(); }, 10000);
    return () => clearInterval(id);
  }, [health, checkHealth]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    const userMsg: Message = { role: 'user', content: trimmed };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }]);

    abortRef.current = new AbortController();

    try {
      const res = await fetch(`${CHATBOT_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, session_id: sessionId }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let sources: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;

          try {
            const parsed = JSON.parse(raw);
            if (parsed.token) {
              accumulated += parsed.token;
            }
            if (parsed.sources) {
              sources = parsed.sources;
            }
            if (parsed.answer) {
              accumulated = parsed.answer;
              sources = parsed.sources ?? sources;
            }
            setMessages(prev => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: 'assistant',
                content: accumulated,
                sources,
                streaming: true,
              };
              return updated;
            });
          } catch {
            // non-JSON SSE line, skip
          }
        }
      }

      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: accumulated || 'No response received.',
          sources,
          streaming: false,
        };
        return updated;
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: '_Response cancelled._',
            streaming: false,
          };
          return updated;
        });
      } else {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: `**Error:** Could not reach chatbot service at \`${CHATBOT_BASE}\`. Make sure \`npm run chatbot\` is running.\n\n_${err.message}_`,
            streaming: false,
          };
          return updated;
        });
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }, [isLoading, messages.length, sessionId]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  function stopStreaming() {
    abortRef.current?.abort();
  }

  const isOnline = health?.status === 'ok' && health?.graph_ready;

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-80px)] bg-slate-950/40 rounded-2xl border border-slate-800/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800/50 bg-slate-900/60 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-indigo-600/20 flex items-center justify-center">
            <Bot className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-100 leading-none">Bharat Stock AI</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Powered by {health?.llm ?? 'LangGraph'}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {healthChecking ? (
            <span className="flex items-center gap-1 text-[10px] text-slate-500">
              <Loader2 className="w-3 h-3 animate-spin" /> Connecting…
            </span>
          ) : isOnline ? (
            <span className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">
              <Wifi className="w-3 h-3" /> Online
            </span>
          ) : (
            <button
              onClick={checkHealth}
              className="flex items-center gap-1.5 text-[10px] font-semibold text-rose-400 bg-rose-400/10 px-2 py-1 rounded-full hover:bg-rose-400/20 transition-colors"
              title="Click to retry"
            >
              <WifiOff className="w-3 h-3" /> Offline — retry
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin scrollbar-track-slate-900 scrollbar-thumb-slate-700">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-12">
            <div className="w-16 h-16 rounded-2xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center">
              <Bot className="w-8 h-8 text-indigo-400" />
            </div>
            <div>
              <p className="text-slate-300 font-semibold text-base">Ask me anything about Indian stocks</p>
              <p className="text-slate-500 text-xs mt-1">I have access to live data, fundamentals, signals, and the web</p>
            </div>

            {/* Quick query chips */}
            <div className="flex flex-wrap gap-2 justify-center max-w-lg mt-2">
              {QUICK_QUERIES.map(q => (
                <button
                  key={q}
                  onClick={() => sendMessage(q)}
                  disabled={isLoading || !isOnline}
                  className="text-[11px] px-3 py-1.5 rounded-full border border-indigo-500/30 text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 hover:border-indigo-400/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            {msg.role === 'assistant' && (
              <div className="w-6 h-6 rounded-lg bg-indigo-600/20 flex items-center justify-center shrink-0 mt-1 mr-2">
                <Bot className="w-3 h-3 text-indigo-400" />
              </div>
            )}
            <div
              className={cn(
                'max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-sm'
                  : 'bg-slate-800/80 text-slate-200 rounded-bl-sm border border-slate-700/50',
              )}
            >
              {msg.role === 'assistant' ? (
                <>
                  <div className="prose prose-sm prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 prose-table:text-xs">
                    <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
                  </div>
                  {msg.streaming && !msg.content && (
                    <span className="flex gap-1 mt-1">
                      <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:300ms]" />
                    </span>
                  )}
                  {!msg.streaming && msg.sources && msg.sources.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-slate-700/40">
                      {msg.sources.map((src, si) => (
                        <span key={si} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-400 font-mono">
                          {src}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <span>{msg.content}</span>
              )}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Quick chips (shown when there are messages) */}
      {messages.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-800/30 flex gap-2 overflow-x-auto shrink-0 scrollbar-none">
          {QUICK_QUERIES.slice(0, 4).map(q => (
            <button
              key={q}
              onClick={() => sendMessage(q)}
              disabled={isLoading || !isOnline}
              className="text-[10px] px-2.5 py-1 rounded-full border border-slate-700/50 text-slate-400 bg-slate-800/40 hover:bg-slate-700/50 hover:text-slate-200 transition-all shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div className="px-4 py-3 border-t border-slate-800/50 bg-slate-900/40 shrink-0">
        <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/50 rounded-xl px-4 py-2.5 focus-within:border-indigo-500/50 transition-colors">
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isOnline ? 'Ask about any Indian stock…' : 'Chatbot offline — start with npm run chatbot'}
            disabled={!isOnline}
            className="flex-1 bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none disabled:opacity-50"
          />
          {isLoading ? (
            <button
              onClick={stopStreaming}
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 transition-colors shrink-0"
              title="Stop"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || !isOnline}
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Send"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <p className="text-[10px] text-slate-600 mt-1.5 text-center">
          AI may be inaccurate. Not financial advice. Session: {sessionId.slice(0, 8)}…
        </p>
      </div>
    </div>
  );
}
