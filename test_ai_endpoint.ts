import { appRouter } from './src/server/routers/_app';
import db from './src/server/db';

async function test() {
  const caller = appRouter.createCaller({});
  
  // Insert a dummy row to test
  db.prepare(`
    INSERT INTO company_profiles (symbol, company_name, description, high_growth_scope, in_news_for_growth, growth_score, ai_analysis)
    VALUES ('RELIANCE', 'Reliance Ind', 'Big company', 1, 1, 95, 'High growth potential')
    ON CONFLICT DO NOTHING
  `).run();

  const res = await caller.fundamentals.getCompanyProfileAnalysis({ symbol: 'RELIANCE' });
  console.log('Test Result:', res);
}

test().catch(console.error);
