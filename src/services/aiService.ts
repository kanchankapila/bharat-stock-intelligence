import {
  generateStockAnalysis as generateGeminiStockAnalysis,
  analyzeCompanyProfile as analyzeGeminiCompanyProfile,
} from './geminiService';
import {
  generateStockAnalysis as generateBedrockStockAnalysis,
  analyzeCompanyProfile as analyzeBedrockCompanyProfile
} from './bedrockService';

// ponytail: Ollama removed 2026-08-20 (local model didn't fit this box's 8GB VRAM, and the
// AI-sourced signal path measured net-negative anyway — see measurement.md). No third local
// option was added back in; bedrock/gemini are the only two providers now.
const AI_PROVIDER = process.env.AI_PROVIDER || (
  (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ? 'bedrock' : 'gemini'
);

export interface StockAnalysis {
  sentiment: string;
  signal: "BUY" | "SELL" | "HOLD";
  entry?: number;
  target?: number;
  stopLoss?: number;
  reasoning: string;
  confidence: number;
  error?: string;
}

export interface ProfileAnalysis {
  high_growth_scope: boolean;
  in_news_for_growth: boolean;
  growth_score: number;
  reasoning: string;
  error?: string;
}

export async function generateStockAnalysis(symbol: string, data: any): Promise<StockAnalysis> {
  if (AI_PROVIDER === 'bedrock') {
    console.log(`[AI] Routing stock analysis for ${symbol} to Amazon Bedrock (Claude)`);
    return generateBedrockStockAnalysis(symbol, data);
  }
  console.log(`[AI] Routing stock analysis for ${symbol} to Google Gemini`);
  return generateGeminiStockAnalysis(symbol, data) as any;
}

export async function analyzeCompanyProfile(symbol: string, description: string): Promise<ProfileAnalysis> {
  if (AI_PROVIDER === 'bedrock') {
    console.log(`[AI] Routing profile analysis for ${symbol} to Amazon Bedrock (Claude)`);
    return analyzeBedrockCompanyProfile(symbol, description);
  }
  console.log(`[AI] Routing profile analysis for ${symbol} to Google Gemini`);
  return analyzeGeminiCompanyProfile(symbol, description) as any;
}
