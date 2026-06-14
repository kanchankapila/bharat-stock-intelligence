import { syncAndAnalyzeCompanyProfiles } from './src/server/companyProfileSyncService';

async function test() {
  console.log('Testing company profile sync...');
  // For safety, we only want to test one stock, but the script runs for all. Let's just run it!
  const res = await syncAndAnalyzeCompanyProfiles();
  console.log('Test Result:', res);
}

test().catch(console.error);
