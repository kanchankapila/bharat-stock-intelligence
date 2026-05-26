import { trpc } from '../lib/trpc';
import { motion } from 'motion/react';
import { Brain, AlertTriangle } from 'lucide-react';

export default function DLDashboard() {
  const { data: perf } = trpc.getDLModelPerformance.useQuery({ days: 30 });
  const { data: regime } = trpc.getMarketRegime.useQuery({});

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="p-4 space-y-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <Brain className="w-5 h-5 text-violet-400" />
        <h2 className="text-lg font-bold text-white">Deep Learning Engine</h2>
      </div>

      {/* Current Regime */}
      <div className="glass rounded-xl p-4">
        <div className="text-[10px] text-slate-400 uppercase tracking-widest font-black mb-2">Current Market Regime</div>
        {regime ? (
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-bold ${
              regime.regime === 'BULL'     ? 'text-emerald-400' :
              regime.regime === 'BEAR'     ? 'text-rose-400' :
              regime.regime === 'CRASH'    ? 'text-red-300' :
              regime.regime === 'HIGH_VOL' ? 'text-amber-400' : 'text-slate-300'
            }`}>{regime.regime}</span>
            <span className="text-slate-500 text-sm">
              {((regime.regime_prob ?? 0) * 100).toFixed(0)}% confidence
            </span>
          </div>
        ) : (
          <span className="text-slate-500 text-sm">No regime data yet — run regime_detector.py</span>
        )}
      </div>

      {/* Model Performance */}
      <div className="glass rounded-xl p-4">
        <div className="text-[10px] text-slate-400 uppercase tracking-widest font-black mb-3">Model Performance (30d)</div>
        {perf && (perf as any[]).length > 0 ? (
          <div className="space-y-2">
            {(perf as any[]).slice(0, 10).map((row: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-slate-400">{row.eval_date}</span>
                <span className="text-slate-300">
                  Acc: {row.directional_accuracy != null ? `${(row.directional_accuracy * 100).toFixed(1)}%` : '—'}
                </span>
                <span className="text-slate-300">
                  AUC: {row.roc_auc != null ? row.roc_auc.toFixed(3) : '—'}
                </span>
                <span className={`text-[10px] ${row.drift_score != null && row.drift_score > 0.25 ? 'text-amber-400' : 'text-slate-500'}`}>
                  PSI: {row.drift_score != null ? row.drift_score.toFixed(3) : '—'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-slate-500 text-sm">No performance data yet — run dl_trainer.py first</span>
        )}
      </div>

      <div className="glass rounded-xl p-4 border border-slate-700/50">
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          DL engine populates after first training run:
          <code className="text-xs text-violet-300 ml-1">python dl_trainer.py --trigger scheduled</code>
        </div>
      </div>
    </motion.div>
  );
}
