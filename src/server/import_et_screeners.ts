import fs from 'fs';
import path from 'path';
import db from './db';

/**
 * Script to import ET screeners from the captured JSON.
 * Expects a file named 'et_screeners.json' in the project root.
 */
async function importEtScreeners() {
  const filePath = path.join(process.cwd(), 'et_screeners.json');
  
  if (!fs.existsSync(filePath)) {
    console.error('❌ Error: et_screeners.json not found in project root.');
    console.log('Please save the JSON data you captured to et_screeners.json and run this script again.');
    return;
  }

  try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(rawData);
    const requests = data.requests || [];

    console.log(`🔍 Found ${requests.length} screener definitions in JSON.`);

    const insert = db.prepare(`
      INSERT OR REPLACE INTO etnow_screeners (screener_id, screener_name, query_condition)
      VALUES (?, ?, ?)
    `);

    const cleanup = db.prepare(`DELETE FROM etnow_screeners`);
    
    let count = 0;
    const runImport = db.transaction(() => {
      cleanup.run(); // Start fresh with the 438 definitions
      for (const req of requests) {
        const id = req.screenerId;
        const name = req.label;
        const query = req.request?.postData?.text || JSON.stringify(req.request?.postData || {});
        
        if (id && name) {
          insert.run(id, name, query);
          count++;
        }
      }
    });

    runImport();
    console.log(`✅ Successfully imported ${count} ET screeners into the database.`);
    
  } catch (error) {
    console.error('❌ Error importing screeners:', error);
  }
}

importEtScreeners();
