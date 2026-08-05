
import React from 'react';
import { RadialBarChart, RadialBar, Legend, Tooltip, ResponsiveContainer, PolarAngleAxis } from 'recharts';
import { QuantScores } from '../../../server/quantService';
import { cn } from '../../../lib/utils';

interface QuantFactorsTabProps {
  scores?: QuantScores;
}

const FactorGauge: React.FC<{ value: number; name: string; color: string }> = ({ value, name, color }) => (
  <div className="flex flex-col items-center">
    <div style={{ width: '100%', height: 120 }}>
      <ResponsiveContainer>
        <RadialBarChart
          innerRadius="70%"
          outerRadius="100%"
          data={[{ name, value, fill: color }]}
          startAngle={90}
          endAngle={-270}
          barSize={10}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
          <RadialBar background dataKey="value" cornerRadius={5} angleAxisId={0} />
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="middle"
            className="text-2xl font-bold fill-current text-slate-100"
          >
            {value.toFixed(0)}
          </text>
          <text
            x="50%"
            y="65%"
            textAnchor="middle"
            dominantBaseline="middle"
            className="text-xs font-bold fill-current text-slate-400 uppercase"
          >
            {name}
          </text>
        </RadialBarChart>
      </ResponsiveContainer>
    </div>
  </div>
);

const MetricItem: React.FC<{ label: string; value: string | number | null | undefined, unit?: string, invertColor?: boolean }> = ({ label, value, unit = '', invertColor = false }) => {
    const displayValue = (typeof value === 'number' && value !== null) ? value.toFixed(2) : value || 'N/A';
    let colorClass = 'text-slate-200';
    if(typeof value === 'number' && value !== null) {
        if(value > 0) colorClass = !invertColor ? 'text-emerald-400' : 'text-rose-400';
        if(value < 0) colorClass = !invertColor ? 'text-rose-400' : 'text-emerald-400';
    }

    return (
        <div className="flex justify-between items-center py-2 border-b border-terminal-border/40 last:border-0">
            <span className="text-xs font-medium text-slate-400">{label}</span>
            <span className={cn("text-sm font-black font-mono", colorClass)}>
                {displayValue}{unit}
            </span>
        </div>
    );
}

export const QuantFactorsTab: React.FC<QuantFactorsTabProps> = ({ scores }) => {
  if (!scores) {
    return (
      <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
        <p className="text-slate-400">No quant scores available for this stock.</p>
      </div>
    );
  }

  const factorData = [
    { name: 'Momentum', value: scores.rank_momentum || 0, color: '#34d399' },
    { name: 'Value', value: scores.rank_value || 0, color: '#f59e0b' },
    { name: 'Quality', value: scores.rank_quality || 0, color: '#8b5cf6' },
  ];

  return (
    <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl animate-in fade-in duration-500">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Left Side: Gauges */}
        <div className="md:col-span-8">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 items-center">
                <div className="col-span-2 lg:col-span-1 flex flex-col items-center justify-center p-4 bg-terminal-panel-header/50 border border-terminal-border rounded-xl">
                    <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Composite Rank</span>
                    <span className="text-6xl font-black text-blue-400 font-mono my-2">
                        { (scores.rank_composite || 0).toFixed(0) }
                    </span>
                    <span className="text-sm font-bold text-blue-400 px-3 py-1 bg-blue-500/10 border border-blue-500/20 rounded-full">
                        {scores.composite_class || 'N/A'}
                    </span>
                </div>
                <div className="col-span-1"><FactorGauge value={scores.rank_momentum || 0} name="Momentum" color="#34d399" /></div>
                <div className="col-span-1"><FactorGauge value={scores.rank_value || 0} name="Value" color="#f59e0b" /></div>
                <div className="col-span-1"><FactorGauge value={scores.rank_quality || 0} name="Quality" color="#8b5cf6" /></div>
            </div>
        </div>

        {/* Right Side: Key Metrics */}
        <div className="md:col-span-4 p-4 bg-terminal-panel-header/50 border border-terminal-border rounded-xl">
             <h4 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-2 font-mono">Key Metrics</h4>
             <div className="space-y-1">
                <MetricItem label="Piotroski F-Score" value={scores.piotroski_f_score} />
                <MetricItem label="Sharpe Ratio (1Y)" value={scores.sharpe_ratio} />
                <MetricItem label="Beta (1Y)" value={scores.beta_1y} invertColor={true}/>
                <MetricItem label="Debt to Equity" value={scores.debt_to_equity} invertColor={true}/>
                <MetricItem label="Return on Equity" value={scores.return_on_equity} unit="%"/>
             </div>
        </div>
      </div>

      {/* Bottom Section: Detailed Tables */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-4 bg-terminal-panel-header/30 border border-terminal-border rounded-xl">
            <h4 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-2 font-mono">Performance</h4>
            <MetricItem label="1W Return" value={scores.return_1w} unit="%" />
            <MetricItem label="1M Return" value={scores.return_1m} unit="%" />
            <MetricItem label="3M Return" value={scores.return_3m} unit="%" />
            <MetricItem label="6M Return" value={scores.return_6m} unit="%" />
            <MetricItem label="12M Return" value={scores.return_12m} unit="%" />
        </div>
        <div className="p-4 bg-terminal-panel-header/30 border border-terminal-border rounded-xl">
            <h4 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-2 font-mono">Value</h4>
            <MetricItem label="Trailing P/E" value={scores.trailing_pe} invertColor={true}/>
            <MetricItem label="Forward P/E" value={scores.forward_pe} invertColor={true}/>
            <MetricItem label="Valuation Score" value={scores.valuation_score} />
            <MetricItem label="Rank (Value)" value={scores.rank_value} />
        </div>
        <div className="p-4 bg-terminal-panel-header/30 border border-terminal-border rounded-xl">
            <h4 className="text-xs font-black text-slate-300 uppercase tracking-widest mb-2 font-mono">Risk</h4>
            <MetricItem label="Annualized Vol." value={scores.annualized_vol} unit="%" invertColor={true} />
            <MetricItem label="Max Drawdown (1Y)" value={scores.max_drawdown_1y} unit="%" invertColor={true}/>
            <MetricItem label="Sortino Ratio" value={scores.sortino_ratio} />
            <MetricItem label="Volatility Rank" value={scores.vol_rank} invertColor={true}/>
        </div>
      </div>
    </div>
  );
};
