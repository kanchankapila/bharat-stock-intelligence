
export interface MCScreenerItem {
  stkname: string;
  ltp: string;
  perChg: string;
  stkId: string;
  scUrl: string;
  columns: { name: string; value: string }[];
}

export interface MCScreenerResponse {
  success: number;
  data: {
    list: {
      scannerName: string;
      scannerDescription: string;
      scannerDetails: MCScreenerItem[];
      catName: string;
    }
  }
}

export async function fetchMCScreener(type: 'proscanner' | 'techscanner' | 'technical-trends', catId: string | number, scanId: string | number): Promise<MCScreenerResponse> {
  let url = '';
  if (type === 'technical-trends') {
    // catId used as 'trendType' (e.g. uptrend/bullish), scanId used as indexId
    url = `https://api.moneycontrol.com/mcapi/v1/technical-trends/${catId}?ex=N&index=${scanId}&page=1&order=desc&deviceType=W&sort=performance&appVersion=142`;
  } else {
    url = `https://api.moneycontrol.com/mcapi/v1/${type}/scanner-detail?catId=${catId}&scanId=${scanId}`;
  }
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch from Moneycontrol: ${response.statusText}`);
  }
  
  const json = await response.json();
  
  // Normalize technical-trends response to match the scannerDetails structure
  if (type === 'technical-trends' && json.success === 1 && Array.isArray(json.data)) {
    return {
      success: 1,
      data: {
        list: {
          scannerName: catId.toString().split('/').pop()?.toUpperCase() || 'Technical Trend',
          scannerDescription: 'Live technical trends analysis from Moneycontrol Intelligence.',
          catName: 'Technical Trends',
          scannerDetails: json.data.map((item: any) => ({
            stkname: item.companyName || item.ticker,
            ltp: item.last_rate || item.lastPrice,
            perChg: item.percent_change || item.percentageChange,
            stkId: item.scId || item.symbol,
            scUrl: '',
            columns: [
              { name: 'Trend Price', value: item.trendPrice || '-' },
              { name: 'Change Status', value: item.changeStatus || '-' }
            ]
          }))
        }
      }
    };
  }
  
  return json;
}
