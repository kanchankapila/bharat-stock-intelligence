import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { Card } from './Card';
import { Play, Settings2, ShieldCheck, Target, Zap } from 'lucide-react';
import { motion } from 'motion/react';

export default function StrategyBuilder() {
  const [evalDays, setEvalDays] = useState(15);
  const [iterations, setIterations] = useState(10);
  const [strategies, setStrategies] = useState('Momentum, Value');

  const optimizeMutation = trpc.optimizeScreenerWeights.useMutation();

  const handleRunOptimizer = () => {
    optimizeMutation.mutate({
      horizonDays: evalDays === 5 ? 5 : 15,
      iterations: Math.max(50, iterations),
      apply: true
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-pink-500">
          Visual Strategy Builder
        </h2>
        <p className="text-gray-400 text-sm mt-1">Configure ML optimization cycles to fine-tune AI scoring weights dynamically.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="p-6 bg-gray-900 border border-white/10">
            <h3 className="text-lg font-semibold text-white mb-6 flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-blue-400" />
              Optimization Parameters
            </h3>
            
            <div className="space-y-6">
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm font-medium text-gray-300">Evaluation Horizon (Days)</label>
                  <span className="text-blue-400 font-mono">{evalDays}</span>
                </div>
                <input 
                  type="range" 
                  min="5" 
                  max="60" 
                  value={evalDays}
                  onChange={(e) => setEvalDays(Number(e.target.value))}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm font-medium text-gray-300">Evolution Iterations (Generations)</label>
                  <span className="text-purple-400 font-mono">{iterations}</span>
                </div>
                <input 
                  type="range" 
                  min="5" 
                  max="50" 
                  value={iterations}
                  onChange={(e) => setIterations(Number(e.target.value))}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Target Strategies</label>
                <input 
                  type="text" 
                  value={strategies}
                  onChange={(e) => setStrategies(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-white/10">
              <button
                onClick={handleRunOptimizer}
                disabled={optimizeMutation.isPending}
                className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white rounded-lg font-bold transition-all disabled:opacity-50"
              >
                {optimizeMutation.isPending ? (
                  <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1 }} className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full" />
                ) : (
                  <Play className="w-5 h-5" />
                )}
                {optimizeMutation.isPending ? 'Optimizer Running in Background...' : 'Deploy ML Optimizer'}
              </button>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-6 bg-gradient-to-br from-indigo-900/50 to-purple-900/50 border border-purple-500/20">
            <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
              <Zap className="w-5 h-5 text-yellow-400" />
              Live Impact
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              Running the optimizer will trigger the Differential Evolution engine to test thousands of weight combinations against historical data.
            </p>
            <p className="text-sm text-gray-400">
              When complete, the best weights will be applied automatically, and a system alert will notify you.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
