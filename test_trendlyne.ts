import { fetchTrendlyneStockMetrics, fetchTrendlyneAdvTechnicalAnalysis } from './src/server/trendlyneService';

async function main() {
  console.log("Testing Trendlyne APIs for RELIANCE...");
  const metrics = await fetchTrendlyneStockMetrics("RELIANCE");
  console.log("Metrics:", metrics);

  const ta = await fetchTrendlyneAdvTechnicalAnalysis("RELIANCE", "D");
  console.log("TA:", ta);
}
main();
