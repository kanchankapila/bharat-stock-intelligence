import Database from 'better-sqlite3';

const db = new Database('./database.sqlite');

const etnowCount = db.prepare('SELECT COUNT(*) as count FROM etnow_screener_stocks').get() as any;
const mcCount = db.prepare('SELECT COUNT(*) as count FROM moneycontrol_screener_stocks').get() as any;
const tlCount = db.prepare('SELECT COUNT(*) as count FROM trendlyne_screener_stocks').get() as any;

console.log('Screener stocks table populations:');
console.log(`- ETNow: ${etnowCount.count} rows`);
console.log(`- MoneyControl: ${mcCount.count} rows`);
console.log(`- Trendlyne: ${tlCount.count} rows`);

// Also check screener definitions
const etnowScreeners = db.prepare('SELECT COUNT(*) as count FROM etnow_screeners').get() as any;
console.log(`\n- ETNow screener definitions: ${etnowScreeners.count}`);

db.close();
