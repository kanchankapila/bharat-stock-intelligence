import { fetchTrendlyneStockMetrics, fetchTrendlyneAdvTechnicalAnalysis } from './src/server/trendlyneService.js';

async function main() {
    console.log("Fetching Metrics for BEL...");
    const m = await fetchTrendlyneStockMetrics('BEL');
    console.log("Metrics:", m ? "SUCCESS" : "FAILED");
    
    console.log("Fetching TA for BEL...");
    const ta = await fetchTrendlyneAdvTechnicalAnalysis('BEL');
    console.log("TA:", ta ? "SUCCESS" : "FAILED");
}
main();
