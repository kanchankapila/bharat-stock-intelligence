import { monitorRouter } from './src/server/routers/monitor.router';
import db from './src/server/db';

async function test() {
  const caller = monitorRouter.createCaller({});
  console.log('Testing monitor.getSystemStatus...');
  try {
    const res = await caller.getSystemStatus();
    console.log('Success! Items count:', res.length);
    // Find our new script
    const syncScript = res.find((r: any) => r.id === 'company-profiles-sync');
    console.log('company-profiles-sync script:', syncScript);
  } catch (err: any) {
    console.error('Failed!', err.message);
  }
}

test().catch(console.error);
