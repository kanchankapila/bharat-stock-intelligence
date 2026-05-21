/**
 * Test ETNow API response format
 * Run: npx ts-node test_etnow_api.ts
 */

async function testETnowAPI() {
  console.log('🧪 Testing ETNow API...\n');

  const screenerIds = ['79', '73', '75', '91', '362']; // Zero Debt, Cash Cows, Elite Bluechips, Buy on Dips, RSI Oversold

  for (const screenerId of screenerIds) {
    try {
      console.log(`📍 Fetching screener ${screenerId}...`);
      
      const url = "https://screener.indiatimes.com/screener/v2/screenerByScreenerIdForWeb";
      const body = {
        viewId: 6916,
        sort: [],
        pagesize: 20,
        pageno: 1,
        deviceId: "web",
        filterType: "index",
        filterValue: [],
        screenerId: screenerId,
        queryCondition: ""
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "referer": "https://economictimes.indiatimes.com/",
          "accept": "*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Origin": "https://economictimes.indiatimes.com",
          "Accept-Language": "en-US,en;q=0.9"
        },
        body: JSON.stringify(body)
      });

      const json = await response.json();
      
      console.log(`  Response structure:`, Object.keys(json));
      
      if (json.searchResult) {
        console.log(`    - searchResult keys:`, Object.keys(json.searchResult));
        if (json.searchResult.searchData) {
          console.log(`      - searchData keys:`, Object.keys(json.searchResult.searchData));
          const recordCount = json.searchResult.searchData.records?.length || 0;
          console.log(`      - records count: ${recordCount}`);
          
          if (recordCount > 0) {
            console.log(`      - first record:`, JSON.stringify(json.searchResult.searchData.records[0], null, 2).substring(0, 300));
          }
        }
      }
      
      console.log(`  ✅ Status: ${response.ok}\n`);
      
    } catch (error) {
      console.error(`  ❌ Error: ${error}\n`);
    }
    
    // Delay between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

testETnowAPI().catch(console.error);
