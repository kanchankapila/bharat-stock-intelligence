import React from 'react';
import { Zap } from 'lucide-react';
import { trpc } from '../lib/trpc';

const FONT_DISPLAY = "'Rajdhani', sans-serif";
const FONT_MONO = "'Space Mono', monospace";
const amber = '#f97316';
const emerald = '#22c55e';
const rose = '#ef4444';

export const V1MacroRegimeHeader: React.FC<{
  onSelectStock?: (symbol: string) => void;
}> = ({ onSelectStock }) => {
  const { data: regimeData } = trpc.getRegimeSummary.useQuery();
  const { data: macroTiles } = trpc.getMacroSnapshot.useQuery();
  const { data: instFlows } = trpc.getInstitutionalFlows.useQuery();
  const { data: premarket } = trpc.getPreMarketMovers.useQuery({ limit: 3 });

  const regime = regimeData?.current;
  const fiiDii = instFlows?.data?.institutionalDetails ?? [];
  const fiiRow = fiiDii.find(d => d.category.includes('FII'));
  const diiRow = fiiDii.find(d => d.category.includes('DII'));

  const vixTile = macroTiles?.find(t => t.symbol === 'INDIAVIX');
  const usdTile = macroTiles?.find(t => t.symbol === 'USDINR');
  const crudeTile = macroTiles?.find(t => t.symbol === 'CRUDE' || t.symbol === 'BRENT');
  const giftTile = macroTiles?.find(t => t.symbol === 'GIFT_NIFTY');

  return (
    <div className="glass border border-slate-800/50 rounded-xl p-3 shadow-md space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/60 pb-2">
        <div className="flex items-center gap-2">
          <div className="px-2.5 py-1 rounded bg-amber-500/10 border border-amber-500/30 flex items-center gap-1.5">
            <span>{regime?.guidance?.icon ?? '🛡️'}</span>
            <div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#94a3b8' }}>REGIME</div>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 13, fontWeight: 700, color: '#f8fafc' }}>
                {regime?.regime ?? 'ACTIVE'} {regime?.prob ? `(${(regime.prob * 100).toFixed(0)}%)` : ''}
              </div>
            </div>
          </div>
          {regime?.guidance && (
            <div className="hidden sm:flex items-center gap-1 px-2 py-1 rounded bg-slate-900 border border-slate-800">
              <Zap size={11} style={{ color: amber }} />
              <span style={{ fontFamily: FONT_DISPLAY, fontSize: 11, color: '#cbd5e1' }}>{regime.guidance.action}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs">
          {fiiRow && (
            <div>
              <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>FII </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700 }} className={Number(fiiRow.netBuySell) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {fiiRow.netBuySell}Cr
              </span>
            </div>
          )}
          {diiRow && (
            <div>
              <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>DII </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700 }} className={Number(diiRow.netBuySell) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {diiRow.netBuySell}Cr
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        <div className="p-1.5 rounded bg-slate-900/60 border border-slate-800">
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>INDIA VIX</span>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: '#f1f5f9' }}>{vixTile?.close ? vixTile.close.toFixed(2) : '13.40'}</div>
        </div>
        <div className="p-1.5 rounded bg-slate-900/60 border border-slate-800">
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>USD/INR</span>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: '#f1f5f9' }}>{usdTile?.close ? usdTile.close.toFixed(2) : '83.95'}</div>
        </div>
        <div className="p-1.5 rounded bg-slate-900/60 border border-slate-800">
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>CRUDE</span>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: '#f1f5f9' }}>{crudeTile?.close ? `$${crudeTile.close.toFixed(1)}` : '$76.5'}</div>
        </div>
        <div className="p-1.5 rounded bg-slate-900/60 border border-slate-800">
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>GIFT NIFTY</span>
          <div style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: '#f1f5f9' }}>{giftTile?.close ? giftTile.close.toFixed(0) : '24,580'}</div>
        </div>
        {premarket?.gapUp?.[0] && (
          <div onClick={() => onSelectStock?.(premarket.gapUp[0].symbol)} className="p-1.5 rounded bg-emerald-950/30 border border-emerald-800/40 cursor-pointer">
            <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: emerald }}>GAP UP</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 11, fontWeight: 700, color: emerald }}>{premarket.gapUp[0].symbol} +{premarket.gapUp[0].iepGapPct.toFixed(1)}%</div>
          </div>
        )}
        {premarket?.gapDown?.[0] && (
          <div onClick={() => onSelectStock?.(premarket.gapDown[0].symbol)} className="p-1.5 rounded bg-rose-950/30 border border-rose-800/40 cursor-pointer">
            <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: rose }}>GAP DOWN</span>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 11, fontWeight: 700, color: rose }}>{premarket.gapDown[0].symbol} {premarket.gapDown[0].iepGapPct.toFixed(1)}%</div>
          </div>
        )}
      </div>
    </div>
  );
};
