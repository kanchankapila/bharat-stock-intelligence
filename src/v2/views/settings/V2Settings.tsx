import React, { useState, useEffect } from 'react';
import { trpc } from '../../../lib/trpc';
import { Send, Settings, Save, AlertCircle, CheckCircle2 } from 'lucide-react';

export const V2Settings: React.FC = () => {
  // Telegram Settings state
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // NiftyTrader Settings state
  const [niftyTraderToken, setNiftyTraderToken] = useState('');
  const [niftyTraderStatus, setNiftyTraderStatus] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const { data: currentSettings, refetch } = trpc.getTelegramSettings.useQuery();
  const saveMutation = trpc.saveTelegramSettings.useMutation();
  const testMutation = trpc.testTelegramConnection.useMutation();

  const { data: ntSettings, refetch: refetchNT } = trpc.getNiftyTraderToken.useQuery();
  const saveNTMutation = trpc.saveNiftyTraderToken.useMutation();

  useEffect(() => {
    if (currentSettings) {
      setBotToken(currentSettings.botToken);
      setChatId(currentSettings.chatId);
      setEnabled(currentSettings.enabled);
    }
  }, [currentSettings]);

  useEffect(() => {
    if (ntSettings) {
      setNiftyTraderToken(ntSettings.token);
    }
  }, [ntSettings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);
    try {
      const res = await saveMutation.mutateAsync({ botToken, chatId, enabled });
      if (res.success) {
        setStatusMessage({ text: 'Settings saved successfully', type: 'success' });
        refetch();
      } else {
        setStatusMessage({ text: res.error || 'Failed to save settings', type: 'error' });
      }
    } catch (err: any) {
      setStatusMessage({ text: err.message || 'Error occurred while saving', type: 'error' });
    }
  };

  const handleSaveNT = async (e: React.FormEvent) => {
    e.preventDefault();
    setNiftyTraderStatus(null);
    try {
      const res = await saveNTMutation.mutateAsync({ token: niftyTraderToken });
      if (res.success) {
        setNiftyTraderStatus({ text: 'NiftyTrader token saved successfully', type: 'success' });
        refetchNT();
      } else {
        setNiftyTraderStatus({ text: res.error || 'Failed to save token', type: 'error' });
      }
    } catch (err: any) {
      setNiftyTraderStatus({ text: err.message || 'Error occurred while saving', type: 'error' });
    }
  };

  const handleTest = async () => {
    setStatusMessage(null);
    try {
      const res = await testMutation.mutateAsync();
      if (res.success) {
        setStatusMessage({ text: 'Test message dispatched to Telegram chat!', type: 'success' });
      } else {
        setStatusMessage({ text: 'Test message failed. Verify Token and Chat ID.', type: 'error' });
      }
    } catch (err: any) {
      setStatusMessage({ text: err.message || 'Error occurred during test connection', type: 'error' });
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">
      <div>
        <h2 className="text-2xl font-black text-slate-100 italic tracking-tighter uppercase font-mono flex items-center gap-2">
          <Settings className="w-6 h-6 text-indigo-400" /> SYSTEM SETTINGS
        </h2>
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Configure institutional integrations & authorization settings</p>
      </div>

      {/* 1. Telegram Settings Panel */}
      <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl space-y-6">
        <div className="flex items-center justify-between border-b border-terminal-border pb-4">
          <div>
            <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider font-mono">Telegram Alerts Bot</h3>
            <p className="text-[10px] text-slate-500 font-medium">Relay all real-time alerts & signals to a Telegram channel/chat.</p>
          </div>
          <button 
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`px-3 py-1.5 rounded-lg text-[9px] font-black tracking-widest border transition-all uppercase ${
              enabled ? 'bg-indigo-600 border-indigo-600 text-white' : 'glass border-slate-800 text-slate-500'
            }`}
          >
            {enabled ? 'Active' : 'Disabled'}
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Telegram Bot Token</label>
            <input 
              type="password" 
              placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              className="w-full bg-terminal-bg border border-terminal-border rounded-xl py-3 px-4 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Chat ID / Channel ID</label>
            <input 
              type="text" 
              placeholder="e.g. -100123456789 or @mychannel"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              className="w-full bg-terminal-bg border border-terminal-border rounded-xl py-3 px-4 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all font-mono"
            />
          </div>

          {statusMessage && (
            <div className={`p-4 rounded-xl border flex items-center gap-3 text-xs font-medium ${
              statusMessage.type === 'success' ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400' : 'bg-rose-500/5 border-rose-500/20 text-rose-400'
            }`}>
              {statusMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              <span>{statusMessage.text}</span>
            </div>
          )}

          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              disabled={saveMutation.isPending}
              className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xs rounded-xl transition-all flex items-center justify-center gap-2 uppercase tracking-widest shadow-lg shadow-indigo-600/20 cursor-pointer"
            >
              <Save className="w-4 h-4" /> Save Configuration
            </button>
            
            <button
              type="button"
              onClick={handleTest}
              disabled={!currentSettings?.hasToken || testMutation.isPending}
              className="px-6 py-3 bg-terminal-panel hover:bg-slate-900 border border-terminal-border text-slate-200 font-black text-xs rounded-xl transition-all flex items-center justify-center gap-2 uppercase tracking-widest cursor-pointer"
            >
              <Send className="w-4 h-4 text-indigo-400" /> Test Connection
            </button>
          </div>
        </form>
      </div>

      {/* 2. NiftyTrader Settings Panel */}
      <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl space-y-6">
        <div className="border-b border-terminal-border pb-4">
          <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider font-mono">NiftyTrader Integration</h3>
          <p className="text-[10px] text-slate-500 font-medium">Configure authorization token for live market screeners & option chain fetching.</p>
        </div>

        <form onSubmit={handleSaveNT} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex justify-between">
              <span>Bearer Authorization Token</span>
            </label>
            <input 
              type="password" 
              placeholder="e.g. Bearer eyJhbGciOiJIUzI1Ni..."
              value={niftyTraderToken}
              onChange={(e) => setNiftyTraderToken(e.target.value)}
              className="w-full bg-terminal-bg border border-terminal-border rounded-xl py-3 px-4 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all font-mono"
            />
            <p className="text-[9px] text-slate-500 leading-normal font-medium mt-1">
              <strong>Instructions:</strong> Log in to niftytrader.in in your browser, open Developer Tools (F12), go to Network, trigger any screener/option request, copy the <code className="font-bold bg-slate-900 px-1 py-0.5 rounded text-[8px] text-slate-300">Authorization</code> header value (including "Bearer "), and paste it here.
            </p>
          </div>

          {niftyTraderStatus && (
            <div className={`p-4 rounded-xl border flex items-center gap-3 text-xs font-medium ${
              niftyTraderStatus.type === 'success' ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400' : 'bg-rose-500/5 border-rose-500/20 text-rose-400'
            }`}>
              {niftyTraderStatus.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              <span>{niftyTraderStatus.text}</span>
            </div>
          )}

          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              disabled={saveNTMutation.isPending}
              className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xs rounded-xl transition-all flex items-center justify-center gap-2 uppercase tracking-widest shadow-lg shadow-indigo-600/20 cursor-pointer"
            >
              <Save className="w-4 h-4" /> Save Token
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
