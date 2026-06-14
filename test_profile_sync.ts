import { syncAndAnalyzeCompanyProfiles } from '../src/server/companyProfileSyncService';
import db from '../src/server/db';
import { fetchCompanyOverview } from '../src/server/trendlyneService';
import { analyzeCompanyProfile } from '../src/services/aiService';

async function testSingle() {
    console.log("Fetching Trendlyne overview for RELIANCE...");
    const overview = await fetchCompanyOverview('RELIANCE');
    const description = overview?.companyProfileData?.companyDescription;
    
    if (description) {
        console.log("Description found (first 100 chars):", description.substring(0, 100));
        console.log("Running Ollama analysis...");
        const result = await analyzeCompanyProfile('RELIANCE', description);
        console.log("Ollama Analysis Result:", result);
    } else {
        console.log("No description found for RELIANCE.");
    }
}

testSingle().catch(console.error);
