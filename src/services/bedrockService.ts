import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

let _bedrockClient: BedrockRuntimeClient | null = null;

function getBedrockClient() {
  if (!_bedrockClient) {
    const config: any = {
      region: process.env.AWS_REGION || "us-east-1",
    };

    // If explicit environment variables are provided, use them.
    // Otherwise, the SDK will automatically check IAM roles, task roles, etc.
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
      };
    }

    _bedrockClient = new BedrockRuntimeClient(config);
  }
  return _bedrockClient;
}

const CLAUDE_MODEL_ID = process.env.BEDROCK_CLAUDE_MODEL || "anthropic.claude-3-5-sonnet-20241022-v2:0";

export interface StockAnalysis {
  sentiment: string;
  signal: "BUY" | "SELL" | "HOLD";
  entry: number;
  target: number;
  stopLoss: number;
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
  const prompt = `
You are a senior Indian equity analyst. Analyze the following data for ${symbol} and produce a trading recommendation.

DATA:
${JSON.stringify(data, null, 2)}

INTERPRETATION GUIDE (use fields present; skip absent ones):
- rsi: >70 overbought, <30 oversold, 40-60 neutral
- macd vs macd_signal: macd > signal = bullish momentum, macd < signal = bearish
- above_sma200: true = long-term uptrend confirmed
- volume_ratio: >1.5 = unusual volume (conviction), <0.7 = weak participation
- pe_ratio / forward_pe: compare to sector average; lower forward PE = cheaper
- price_to_book: <1 = undervalued relative to assets
- debt_to_equity: >2 = high leverage risk
- roe_pct: >15% = strong returns on equity
- revenue_growth_pct / earnings_growth_pct: positive = growing business
- piotroski_f_score: 7-9 = financially strong, 0-2 = financially weak
- factor_scores (0-100): relative strength across technical/fundamental/momentum/valuation/news
- quant_class: Strong Buy / Buy / Hold / Avoid / Sell (quant model classification)
- recent_news: weight BULLISH + HIGH impact heavily; BEARISH + HIGH impact is a risk flag
- week52_high / week52_low: price relative to annual range shows momentum context

RULES:
- entry, target, stopLoss MUST be realistic price levels near current price
- target should imply a risk:reward ratio ≥ 1.5:1 vs stopLoss
- confidence should reflect data quality and signal confluence (more confirming signals = higher)
- reasoning must synthesise the key signals, not just list them

Respond ONLY with valid JSON matching exactly this structure:
{
  "sentiment": "Bullish" | "Bearish" | "Neutral",
  "signal": "BUY" | "SELL" | "HOLD",
  "entry": number,
  "target": number,
  "stopLoss": number,
  "reasoning": "string (2-4 sentences explaining the key confluence)",
  "confidence": number (0-100)
}
  `;

  try {
    const client = getBedrockClient();
    const command = new ConverseCommand({
      modelId: CLAUDE_MODEL_ID,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: {
        maxTokens: 1000,
        temperature: 0.1,
      },
    });

    const response = await client.send(command);
    const content = response.output?.message?.content?.[0]?.text;
    if (!content) {
      throw new Error("Empty response from Bedrock Converse API");
    }

    let cleanJson = content.trim();
    // Remove markdown code block wrappers if any
    cleanJson = cleanJson.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(cleanJson);
  } catch (error: any) {
    console.error("Bedrock API Error (generateStockAnalysis):", error);
    
    // Fallback in case of failure (matches aiService.ts local fallback)
    return {
      error: error?.message || "AI Analysis failed via Bedrock",
      sentiment: "Neutral",
      signal: "HOLD",
      entry: data.price || 0,
      target: (data.price || 0) * 1.05,
      stopLoss: (data.price || 0) * 0.95,
      reasoning: `Amazon Bedrock Claude model encountered an error: ${error?.message || error}`,
      confidence: 0,
    };
  }
}

export async function analyzeCompanyProfile(symbol: string, description: string): Promise<ProfileAnalysis> {
  const prompt = `Analyze the following company profile for ${symbol}:
"${description}"

Determine if the company has high growth scope and whether it is in the news for growth.

Respond ONLY with valid JSON:
{
  "high_growth_scope": boolean,
  "in_news_for_growth": boolean,
  "growth_score": number (0 to 100),
  "reasoning": "2-3 sentence explanation."
}`;

  try {
    const client = getBedrockClient();
    const command = new ConverseCommand({
      modelId: CLAUDE_MODEL_ID,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: {
        maxTokens: 500,
        temperature: 0.1,
      },
    });

    const response = await client.send(command);
    const content = response.output?.message?.content?.[0]?.text;
    if (!content) {
      throw new Error("Empty response from Bedrock Converse API");
    }

    let cleanJson = content.trim();
    cleanJson = cleanJson.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(cleanJson);
    return {
      high_growth_scope: Boolean(parsed.high_growth_scope),
      in_news_for_growth: Boolean(parsed.in_news_for_growth),
      growth_score: Number(parsed.growth_score) || 0,
      reasoning: String(parsed.reasoning || ''),
    };
  } catch (error: any) {
    console.error("Bedrock API Error (analyzeCompanyProfile):", error);
    
    return {
      error: error?.message || "Profile Analysis failed via Bedrock",
      high_growth_scope: false,
      in_news_for_growth: false,
      growth_score: 0,
      reasoning: `Amazon Bedrock profile analysis encountered an error: ${error?.message || error}`,
    };
  }
}
