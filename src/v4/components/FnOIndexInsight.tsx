import React from 'react';
import { Target } from 'lucide-react';
import IndexFnoOverview from '../../components/IndexFnoOverview';

// Reuses the existing, already-sophisticated per-index F&O analysis engine
// (PCR, max-pain/OI walls, IV skew, buildup commentary — see analyseOI() in
// IndexFnoOverview.tsx) for the two indices an expert trader checks before the
// bell: Nifty and Bank Nifty. Deliberately does NOT re-derive OI/PCR math from
// the raw Moneycontrol feed a second time — that logic already exists and is
// tested; duplicating it here would risk the two views silently disagreeing.
export const FnOIndexInsight: React.FC = () => {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Target className="w-4 h-4 text-indigo-400" />
        <h2 className="text-xs font-black text-slate-200 uppercase tracking-widest">F&amp;O Read — Major Indices</h2>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IndexFnoOverview symbol="NIFTY" />
        <IndexFnoOverview symbol="BANKNIFTY" />
      </div>
    </div>
  );
};

export default FnOIndexInsight;
