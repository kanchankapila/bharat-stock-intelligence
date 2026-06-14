import * as fs from 'fs';
import * as path from 'path';

const transcriptPath = 'C:\\Users\\amitk\\.gemini\\antigravity-ide\\brain\\5d736071-2c2b-456d-925c-57883f22debf\\.system_generated\\logs\\transcript.jsonl';
const stocklistPath = path.resolve(import.meta.dirname, '../src/data/stocklist.ts');

async function run() {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  
  let lastUserInput = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.includes('"type":"USER_INPUT"')) {
      const parsed = JSON.parse(line);
      lastUserInput = parsed.content || '';
      break;
    }
  }

  const jsonStart = lastUserInput.indexOf('{"screen"');
  if (jsonStart === -1) {
    console.error('Could not find JSON in user input');
    return;
  }

  const jsonStr = lastUserInput.substring(jsonStart);
  
  const newItems = [];
  const regex = /\{"name":\s*"([^"]+)",\s*"value":\s*"[^"]*",\s*"stockurl":\s*"https:\/\/trendlyne\.com\/equity\/(\d+)\/[^\/]+\/([^\/]+)\/"/g;
  let match;
  while ((match = regex.exec(jsonStr)) !== null) {
      const symbol = match[1];
      const tlid = match[2];
      const tlname = match[3];
      newItems.push({
        name: symbol,
        mcsymbol: '',
        tlid: tlid,
        tlname: tlname,
        isin: '',
        symbol: symbol,
        stockid: '',
        companyid: ''
      });
  }

  console.log(`Successfully extracted ${newItems.length} valid items.`);

  let stocklistContent = fs.readFileSync(stocklistPath, 'utf8');

  // We need to inject these before the closing `];` of the `stockData` array.
  // Find the last `];` or simply replace `\n];\n` or similar.
  // Let's find the closing brace of the array.
  const arrayEndIndex = stocklistContent.lastIndexOf('];');
  if (arrayEndIndex === -1) {
    console.error('Could not find end of stockData array in stocklist.ts');
    return;
  }

  const itemsString = newItems.map(item => `  { name: '${item.name}', mcsymbol: '${item.mcsymbol}', tlid: '${item.tlid}', tlname: '${item.tlname}', isin: '${item.isin}', symbol: '${item.symbol}', stockid: '${item.stockid}', companyid: '${item.companyid}' }`).join(',\n');

  // Insert before the last `];`
  // We need to check if there's already a trailing comma.
  const contentBefore = stocklistContent.substring(0, arrayEndIndex).trimRight();
  const needsComma = !contentBefore.endsWith(',');
  
  const finalContent = contentBefore + (needsComma ? ',\n' : '\n') + itemsString + '\n' + stocklistContent.substring(arrayEndIndex);

  fs.writeFileSync(stocklistPath, finalContent, 'utf8');
  console.log('Successfully updated stocklist.ts');
}

run().catch(console.error);
