import fs from 'fs';
import path from 'path';
import { dbTransaction } from './dbAsync';

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

    const insertSql = `
      INSERT INTO etnow_screeners (screener_id, screener_name, query_condition)
      VALUES (?, ?, ?)
      ON CONFLICT(screener_id) DO UPDATE SET
        screener_name = excluded.screener_name,
        query_condition = excluded.query_condition
    `;

    let count = 0;
    await dbTransaction(async (tx) => {
      await tx.run(`DELETE FROM etnow_screeners`); // Start fresh with the 438 definitions
      for (const req of requests) {
        const id = req.screenerId;
        const name = req.label;
        const query = req.request?.postData?.text || JSON.stringify(req.request?.postData || {});

        if (id && name) {
          await tx.run(insertSql, [id, name, query]);
          count++;
        }
      }
    });
    console.log(`✅ Successfully imported ${count} ET screeners into the database.`);
    
  } catch (error) {
    console.error('❌ Error importing screeners:', error);
  }
}

importEtScreeners();
