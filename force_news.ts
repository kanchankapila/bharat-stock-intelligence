import { runNewsSentimentCycle } from './src/server/newsSentimentService';

async function run() {
  console.log("Triggering News Sentiment Cycle...");
  await runNewsSentimentCycle();
  console.log("Done!");
  process.exit(0);
}

run();
