
import React from 'react';
import { Card } from '../../../components/Card';
import { TrendingUp, Thermometer, BarChart, Calendar } from 'lucide-react';
import { trpc } from '../../../lib/trpc';

export const MarketDashboard = () => {
  const { data: marketBreadth } = trpc.getMarketBreadth.useQuery();
  // Shares its cache entry with every other getFiiDiiFlow({days:10}) caller in the app
  // (AlphaCockpit, TradeDecisionCockpit, MoneyFlowPulseWidget, ...) -- see 2026-08-02 perf pass.
  const { data: fiiDiiHistory } = trpc.getFiiDiiFlow.useQuery({ days: 10 });
  const fiiDiiFlow = fiiDiiHistory?.[0] as any;
  const { data: marketRegime } = trpc.getMarketRegime.useQuery();
  const { data: economicCalendar } = trpc.getEconomicCalendar.useQuery();

  return (
    <div className="p-6 space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Market Breadth */}
        <Card>
          <div className="flex flex-row items-center justify-between pb-2">
            <span className="text-sm font-medium">Market Breadth</span>
            <BarChart className="h-4 w-4 text-slate-500" />
          </div>
          <div className="text-2xl font-bold">{marketBreadth?.adv_decline_ratio?.toFixed(2)}</div>
          <p className="text-xs text-slate-500">{marketBreadth?.advances} Advances, {marketBreadth?.declines} Declines</p>
        </Card>

        {/* FII/DII Flow */}
        <Card>
          <div className="flex flex-row items-center justify-between pb-2">
            <span className="text-sm font-medium">FII/DII Flow (Today)</span>
            <TrendingUp className="h-4 w-4 text-green-500" />
          </div>
          <div className={`text-2xl font-bold ${fiiDiiFlow?.fii_net == null ? 'text-slate-400' : fiiDiiFlow.fii_net >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {fiiDiiFlow?.fii_net == null ? '—' : `${fiiDiiFlow.fii_net > 0 ? '+' : ''}₹${fiiDiiFlow.fii_net.toLocaleString('en-IN')} Cr`}
          </div>
          <p className="text-xs text-slate-500">
            FII: {fiiDiiFlow?.fii_net == null ? '—' : `${fiiDiiFlow.fii_net > 0 ? '+' : ''}₹${fiiDiiFlow.fii_net.toLocaleString('en-IN')} Cr`},
            {' '}DII: {fiiDiiFlow?.dii_net == null ? '—' : `${fiiDiiFlow.dii_net > 0 ? '+' : ''}₹${fiiDiiFlow.dii_net.toLocaleString('en-IN')} Cr`}
          </p>
        </Card>

        {/* Market Regime */}
        <Card>
          <div className="flex flex-row items-center justify-between pb-2">
            <span className="text-sm font-medium">Market Regime</span>
            <Thermometer className="h-4 w-4 text-orange-500" />
          </div>
          <div className="text-2xl font-bold text-orange-500">{marketRegime?.regime}</div>
          <p className="text-xs text-slate-500">High volatility expected</p>
        </Card>

        {/* Upcoming Events */}
        <Card>
          <div className="flex flex-row items-center justify-between pb-2">
            <span className="text-sm font-medium">Upcoming Events</span>
            <Calendar className="h-4 w-4 text-slate-500" />
          </div>
          {economicCalendar?.map((event: any) => (
            <div key={event.calendar_id} className="text-lg font-bold">{event.event_name}</div>
          ))}
          <p className="text-xs text-slate-500">Tomorrow, 8:00 PM</p>
        </Card>
      </div>

      {/* Placeholder for Sector Heatmap */}
      <Card title="Sector Heatmap">
        <div className="h-96 bg-slate-800/50 rounded-lg flex items-center justify-center">
          <p className="text-slate-500">Sector Heatmap will be here</p>
        </div>
      </Card>
    </div>
  );
};
