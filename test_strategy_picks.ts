import Database from 'better-sqlite3';

const db = new Database('./database.sqlite');

const latestPriceCte = `
  WITH latest_prices AS (
    SELECT o.symbol, o.close
    FROM stock_ohlcv o
    JOIN (
      SELECT symbol, MAX(date) AS max_date
      FROM stock_ohlcv
      GROUP BY symbol
    ) latest ON latest.symbol = o.symbol AND latest.max_date = o.date
  )
`;

// Check ETNow count
const etnowCount = db.prepare('SELECT COUNT(*) as count FROM etnow_screener_stocks').get() as any;
console.log(`ETNow screener_stocks count: ${etnowCount.count}\n`);

// Try the fallback query for investment picks
const mcValueScreeners = ['146', '181', '178'];
const invRows = db.prepare(`${latestPriceCte}
  SELECT n.symbol, n.name as companyName, n.sector, lp.close as currentPrice,
         COUNT(DISTINCT ms.scan_id) as screener_count,
         GROUP_CONCAT(DISTINCT ms.scan_id) as mc_screeners
  FROM nse_stocks n
  JOIN moneycontrol_screener_stocks ms ON n.symbol = ms.symbol
  LEFT JOIN latest_prices lp ON lp.symbol = n.symbol
  WHERE ms.scan_id IN (?, ?, ?)
  GROUP BY n.symbol
  ORDER BY screener_count DESC, n.symbol
  LIMIT 50
`).all(mcValueScreeners[0], mcValueScreeners[1], mcValueScreeners[2]) as any[];

console.log(`Investment Picks (using MC fallback): ${invRows.length} stocks found\n`);
console.log('Top 10 Investment Picks:');
invRows.slice(0, 10).forEach((r: any) => {
  const score = Math.min(100, 50 + (r.screener_count * 20));
  console.log(`  ${r.symbol.padEnd(8)} - ${r.companyName?.substring(0, 30)?.padEnd(30)} [Score: ${score}]`);
});

// Try intraday query
const intradayRows = db.prepare(`${latestPriceCte}
  SELECT n.symbol, n.name as companyName, n.sector, lp.close as currentPrice,
         COUNT(DISTINCT ts.screener_id) as tl_count,
         COUNT(DISTINCT ms.scan_id) as mc_count
  FROM nse_stocks n
  JOIN trendlyne_screener_stocks ts ON n.symbol = ts.symbol
  LEFT JOIN trendlyne_screeners tls ON tls.screener_id = ts.screener_id
  LEFT JOIN moneycontrol_screener_stocks ms ON n.symbol = ms.symbol
  LEFT JOIN latest_prices lp ON lp.symbol = n.symbol
  WHERE (tls.timeframe = 'intraday' OR tls.timeframe LIKE '%intraday%')
  GROUP BY n.symbol
  HAVING tl_count >= 1
  ORDER BY (tl_count + mc_count * 0.5) DESC
  LIMIT 50
`).all() as any[];

console.log(`\n\nIntraday Picks: ${intradayRows.length} stocks found\n`);
console.log('Top 10 Intraday Picks:');
intradayRows.slice(0, 10).forEach((r: any) => {
  const score = Math.min(100, 50 + (r.tl_count * 12) + (r.mc_count * 8));
  console.log(`  ${r.symbol.padEnd(8)} - ${r.companyName?.substring(0, 30)?.padEnd(30)} [Score: ${score}] (TL: ${r.tl_count}, MC: ${r.mc_count})`);
});

db.close();
