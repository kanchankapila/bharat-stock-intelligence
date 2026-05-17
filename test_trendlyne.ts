import { fetchTrendlyneStockMetrics, fetchTrendlyneAdvTechnicalAnalysis } from './src/server/trendlyneService';

async function main() {
  console.log("Testing Trendlyne APIs...");
  const metrics = await fetchTrendlyneStockMetrics("BEL");
  console.log("Metrics:", metrics);

  const ta = await fetchTrendlyneAdvTechnicalAnalysis("BEL", "D");
  console.log("TA:", ta);
}
main();
