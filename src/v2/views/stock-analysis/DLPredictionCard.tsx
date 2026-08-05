
import React from 'react';
import { Card } from '../../../components/Card';
import { TrendingUp, TrendingDown } from 'lucide-react';

export const DLPredictionCard = ({ prediction }: { prediction: any }) => {
  const isBullish = prediction.prob_up_5d > prediction.prob_dn_5d;

  return (
    <Card className="bg-slate-800/40 border-slate-700/50">
      <div className="flex flex-row items-center justify-between pb-2">
        <span className="text-sm font-medium text-slate-300">{prediction.model_name}</span>
        <div className={`flex items-center text-xs font-bold ${isBullish ? 'text-green-500' : 'text-red-500'}`}>
          {isBullish ? <TrendingUp className="mr-2 h-4 w-4" /> : <TrendingDown className="mr-2 h-4 w-4" />}
          {isBullish ? 'Bullish' : 'Bearish'}
        </div>
      </div>
      <div className="text-lg font-bold text-white">5-Day Outlook</div>
      <p className="text-xs text-slate-400">
        Probability of moving up: <span className="font-bold text-green-500">{(prediction.prob_up_5d * 100).toFixed(2)}%</span>
      </p>
      <p className="text-xs text-slate-400">
        Probability of moving down: <span className="font-bold text-red-500">{(prediction.prob_dn_5d * 100).toFixed(2)}%</span>
      </p>
      <p className="text-xs text-slate-400 mt-2">
        Expected Return: <span className="font-bold text-white">{(prediction.exp_ret_5d * 100).toFixed(2)}%</span>
      </p>
    </Card>
  );
};
