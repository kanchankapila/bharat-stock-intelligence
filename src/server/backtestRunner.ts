import { dbGet, dbRun } from './dbAsync';
import { computeTimeframeScores } from './scoringService';

interface BacktestOpts {
  runId?: string;
  screenerId?: string;
  timeframe?: 'intraday'|'short'|'medium'|'long';
  horizonDays?: number; // exit after this many days
  topN?: number;
  runName?: string;
  slippagePct?: number;
  commissionPct?: number;
}

function dayAdd(dateStr: string, days: number) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0,10);
}

async function getOhlcvOnOrAfter(symbol: string, targetDate: string) {
  return dbGet<any>(
    'SELECT date, open, close FROM stock_ohlcv WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT 1',
    [symbol, targetDate]
  );
}

export async function runBacktest(opts: BacktestOpts) {
  const timeframe = opts.timeframe || 'short';
  const horizon = opts.horizonDays ?? (timeframe === 'intraday' ? 0 : timeframe === 'short' ? 7 : timeframe === 'medium' ? 30 : 180);
  const topN = opts.topN || 100;
  const slippagePct = opts.slippagePct ?? 0.0015;
  const commissionPct = opts.commissionPct ?? 0.0003;

  const scores = await computeTimeframeScores({ runId: opts.runId, screenerId: opts.screenerId, timeframe: timeframe as any, topN });

  const runName = opts.runName || `bt:${opts.screenerId || opts.runId || 'manual'}:${timeframe}:${new Date().toISOString()}`;
  const tradeLog: any[] = [];
  let wins = 0, losses = 0, totalNetRet = 0, totalGrossRet = 0, trades = 0;

  let runDate: string | null = null;
  if (opts.runId) {
    const r = await dbGet<any>('SELECT run_ts FROM screener_runs WHERE run_id = ?', [opts.runId]);
    if (r) runDate = (r.run_ts || new Date().toISOString()).slice(0,10);
  }
  if (!runDate) runDate = new Date().toISOString().slice(0,10);

  let totalPositive = 0;
  let totalNegative = 0;

  for (const item of scores) {
    const symbol = item.symbol;
    const entryTarget = dayAdd(runDate, 1);
    const exitTarget = dayAdd(entryTarget, horizon);

    const entryRow = await getOhlcvOnOrAfter(symbol, entryTarget);
    const exitRow = await getOhlcvOnOrAfter(symbol, exitTarget);
    if (!entryRow || !exitRow) continue;

    const grossEntry = entryRow.open;
    const grossExit = exitRow.close;
    const entryPrice = grossEntry * (1 + slippagePct);
    const exitPrice = grossExit * (1 - slippagePct);
    const commissionCost = (grossEntry + grossExit) * commissionPct;
    const grossReturnPct = ((grossExit - grossEntry) / grossEntry) * 100;
    const netReturnPct = ((exitPrice - entryPrice - commissionCost) / entryPrice) * 100;
    trades += 1;
    totalGrossRet += grossReturnPct;
    totalNetRet += netReturnPct;
    if (netReturnPct > 0) {
      wins += 1;
      totalPositive += netReturnPct;
    } else {
      losses += 1;
      totalNegative += Math.abs(netReturnPct);
    }

    tradeLog.push({
      symbol,
      score: item.score,
      entry_date: entryRow.date,
      entry_price: Number(entryPrice.toFixed(4)),
      exit_date: exitRow.date,
      exit_price: Number(exitPrice.toFixed(4)),
      gross_entry: Number(grossEntry.toFixed(4)),
      gross_exit: Number(grossExit.toFixed(4)),
      gross_return_pct: Number(grossReturnPct.toFixed(4)),
      net_return_pct: Number(netReturnPct.toFixed(4)),
      commission_pct: commissionPct,
      slippage_pct: slippagePct,
    });
  }

  const winRate = trades === 0 ? 0 : wins / trades;
  const avgGrossReturn = trades === 0 ? 0 : totalGrossRet / trades;
  const avgNetReturn = trades === 0 ? 0 : totalNetRet / trades;
  const profitFactor = totalNegative === 0 ? null : totalPositive / totalNegative;

  const equityCurve = tradeLog.reduce((curve: number[], trade, index) => {
    const prev = index === 0 ? 10000 : curve[index - 1];
    return [...curve, prev * (1 + (trade.net_return_pct / 100))];
  }, []);

  const summary = {
    run_name: runName,
    strategy_config_json: JSON.stringify({ screener: opts.screenerId, runId: opts.runId, timeframe, slippagePct, commissionPct }),
    start_date: runDate,
    end_date: dayAdd(runDate, horizon),
    symbols_count: tradeLog.length,
    total_trades: trades,
    win_rate: winRate,
    total_return_pct: Number(totalNetRet.toFixed(4)),
    cagr_pct: null,
    sharpe_ratio: null,
    max_drawdown_pct: null,
    avg_trade_return_pct: Number(avgNetReturn.toFixed(4)),
    profit_factor: profitFactor,
    monthly_returns_json: JSON.stringify([]),
    equity_curve_json: JSON.stringify(equityCurve),
    trade_log_json: JSON.stringify(tradeLog)
  };

  const info = await dbRun(`INSERT INTO backtesting_runs (
    run_name, strategy_config_json, start_date, end_date, symbols_count, total_trades, win_rate, total_return_pct, avg_trade_return_pct, profit_factor, monthly_returns_json, equity_curve_json, trade_log_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
    summary.run_name,
    summary.strategy_config_json,
    summary.start_date,
    summary.end_date,
    summary.symbols_count,
    summary.total_trades,
    summary.win_rate,
    summary.total_return_pct,
    summary.avg_trade_return_pct,
    summary.profit_factor,
    summary.monthly_returns_json,
    summary.equity_curve_json,
    summary.trade_log_json
  ]);

  return { insertedId: info.lastInsertRowid, summary };
}

export default { runBacktest };
