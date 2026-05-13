const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(process.cwd(), 'database.sqlite');
const db = new Database(dbPath);

const SEED_NEWS = [
  {
    id: 'n1',
    title: 'Reliance Industries Q4 Results: Profit surges by 15%',
    summary: 'Strong performance across O2C and retail segments drives growth.',
    source: 'Economic Times',
    sentiment: 'Positive',
    category: 'Stock',
    symbols: 'RELIANCE'
  },
  {
    id: 'n2',
    title: 'HDFC Bank Gross NPAs decline to 1.2%',
    summary: 'Asset quality improves significantly in the latest quarter.',
    source: 'Moneycontrol',
    sentiment: 'Positive',
    category: 'Stock',
    symbols: 'HDFCBANK'
  },
  {
    id: 'n3',
    title: 'Infosys issues cautious guidance for FY25',
    summary: 'Macroeconomic headwinds in US and Europe impact discretionary spending.',
    source: 'Reuters',
    sentiment: 'Negative',
    category: 'Stock',
    symbols: 'INFY'
  },
  {
    id: 'n4',
    title: 'Tata Motors hits record high on Jaguar Land Rover sales',
    summary: 'Premium segment demand remains robust in global markets.',
    source: 'Bloomberg',
    sentiment: 'Positive',
    category: 'Stock',
    symbols: 'TATAMOTORS'
  },
  {
    id: 'n5',
    title: 'Wipro CEO resigns, stock falls 4%',
    summary: 'Unexpected leadership change raises concerns among investors.',
    source: 'CNBC-TV18',
    sentiment: 'Negative',
    category: 'Stock',
    symbols: 'WIPRO'
  }
];

const insert = db.prepare(`
  INSERT OR REPLACE INTO news_articles (id, title, summary, source, sentiment, category, symbols)
  VALUES (@id, @title, @summary, @source, @sentiment, @category, @symbols)
`);

db.transaction(() => {
  for (const news of SEED_NEWS) {
    insert.run(news);
  }
})();

console.log('Seed news inserted.');
