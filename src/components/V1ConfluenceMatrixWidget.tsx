import React from 'react';
import { Cpu, CheckCircle2, ChevronRight, Zap } from 'lucide-react';
import { trpc } from '../lib/trpc';

const FONT_DISPLAY = "'Rajdhani', sans-serif";
const FONT_MONO = "'Space Mono', monospace";
const amber = '#f97316';
const emerald = '#22c55e';

export const V1ConfluenceMatrixWidget: React.FC<{
  onSelectStock: (symbol: string) => void;
}> = ({ onSelectStock }) => {
  const { data: signals, isLoading } = trpc.getConfluenceSignals.useQuery({ limit: 6, minScore: 40 });
  const { data: stats } = trpc.getConfluenceStats.useQuery();

  return (
    <div className="glass border border-slate-800/50 rounded-xl p-4 shadow-md space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800/60 pb-2">
        <div className="flex items-center gap-2">
          <Cpu size={16} style={{ color: amber }} />
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: 2, color: amber, textTransform: 'uppercase' }}>
            QUANT MODEL CONFLUENCE MATRIX
          </span>
        </div>
        {stats && (
          <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: '#94a3b8' }}>
            <span className="text-emerald-400 font-bold">{stats.elite} ELITE</span> / {stats.total} RATED
          </div>
        )}
      </div>

      {/* Signals List */}
      <div className="space-y-2">
        {isLoading ? (
          <div className="py-6 text-center text-xs text-slate-500 font-mono">LOADING MODEL CONFLUENCE...</div>
        ) : signals && signals.length > 0 ? (
          signals.map((sig, idx) => {
            const score = sig.confluence_score ?? sig.score ?? 50;
            const engines = sig.bullish_screener_count ?? sig.screener_count ?? 3;

            return (
              <div
                key={`${sig.symbol}-${idx}`}
                onClick={() => onSelectStock(sig.symbol)}
                className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800/80 hover:border-amber-500/40 transition-all cursor-pointer flex items-center justify-between group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-slate-800/80 border border-slate-700 flex items-center justify-center font-bold text-xs" style={{ fontFamily: FONT_DISPLAY, color: '#f8fafc' }}>
                    #{idx + 1}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span style={{ fontFamily: FONT_DISPLAY, fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>
                        {sig.symbol}
                      </span>
                      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                        sig.conviction_level === 'ELITE' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' :
                        sig.conviction_level === 'STRONG' ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' :
                        'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      }`}>
                        {sig.conviction_level ?? 'STRONG'}
                      </span>
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: '#64748b' }} className="flex items-center gap-2 mt-0.5">
                      <span>{sig.sector ?? 'NSE Stock'}</span>
                      <span>•</span>
                      <span className="text-slate-300">{engines} Models Agreed</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, color: emerald }}>
                      {score.toFixed(0)}%
                    </div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>CONFLUENCE</div>
                  </div>
                  <ChevronRight size={14} className="text-slate-600 group-hover:text-amber-400 transition-colors" />
                </div>
              </div>
            );
          })
        ) : (
          <div className="py-6 text-center text-xs text-slate-500 font-mono">NO CONFLUENCE SIGNALS FOUND</div>
        )}
      </div>
    </div>
  );
};
