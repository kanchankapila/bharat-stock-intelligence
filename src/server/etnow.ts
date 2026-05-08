export interface ETnowScreenerResponse {
  searchResult?: {
    searchData?: {
      records?: any[];
      header?: any[];
    }
  };
  status?: string;
}

export async function fetchETnowScreener(screenerId: string, queryCondition: string): Promise<any> {
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
    queryCondition: queryCondition
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "referer": "https://economictimes.indiatimes.com/",
      "accept": "*/*",
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch from ETnow: ${response.statusText}`);
  }

  return response.json();
}
