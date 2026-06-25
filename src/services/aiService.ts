import ollama from 'ollama';
import { generateStockAnalysis as generateGeminiStockAnalysis } from './geminiService';

const OLLAMA_SIGNAL_MODEL  = process.env.OLLAMA_SIGNAL_MODEL  || process.env.OLLAMA_MODEL || 'mistral';
const OLLAMA_PROFILE_MODEL = process.env.OLLAMA_PROFILE_MODEL || process.env.OLLAMA_MODEL || 'qwen3:30b';

export async function releaseOllamaModel(): Promise<void> {
  const models = [...new Set([OLLAMA_SIGNAL_MODEL, OLLAMA_PROFILE_MODEL])];
  await Promise.allSettled(
    models.map(async (model) => {
      try {
        await ollama.generate({ model, prompt: '', keep_alive: 0 } as any);
        console.log(`[OLLAMA] Model ${model} unloaded from memory`);
      } catch {
        // non-critical
      }
    })
  );
}

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
  if (process.env.GEMINI_API_KEY) {
    console.log(`[AI] Routing stock analysis for ${symbol} to Google Gemini`);
    return generateGeminiStockAnalysis(symbol, data) as any;
  }

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

  const FAST_OPTIONS = { temperature: 0.1, top_k: 20, num_predict: 500, num_ctx: 3072 };

  let response;

  try {
    try {
      response = await ollama.chat({
        model: OLLAMA_SIGNAL_MODEL,
        messages: [{ role: 'user', content: prompt }],
        format: 'json',
        keep_alive: 0,
        options: FAST_OPTIONS,
      } as any) as any;
    } catch (error: any) {
      const errorStr = String(error.message || error.error || "");
      if (errorStr.includes('CUDA') || errorStr.includes('allocate') || errorStr.includes('runner process has terminated')) {
        console.warn(`[AI] Ollama CUDA error detected for ${symbol}, retrying with CPU fallback...`);
        response = await ollama.chat({
          model: OLLAMA_SIGNAL_MODEL,
          messages: [{ role: 'user', content: prompt }],
          format: 'json',
          keep_alive: 0,
          options: { ...FAST_OPTIONS, num_gpu: 0 },
        } as any) as any;
      } else if (errorStr.includes('does not support chat') || errorStr.includes('does not support')) {
        // Model is a base/generate-only model (e.g. mistral) — fall back to generate API
        const gen = await ollama.generate({
          model: OLLAMA_SIGNAL_MODEL,
          prompt,
          format: 'json',
          keep_alive: 0,
          options: FAST_OPTIONS,
        } as any) as any;
        response = { message: { content: gen.response } };
      } else {
        throw error;
      }
    }


    if (response.message.content) {
      let content = response.message.content.trim();
      // Remove markdown code blocks if present
      content = content.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      return JSON.parse(content);
    }

    
    throw new Error("Empty response from Ollama");
  } catch (error: any) {
    console.error("Ollama API Error:", error);
    
    // Fallback/Error handling
    return { 
      error: "AI Analysis failed",
      sentiment: "Neutral",
      signal: "HOLD",
      entry: data.price || 0,
      target: (data.price || 0) * 1.05,
      stopLoss: (data.price || 0) * 0.95,
      reasoning: "Local AI analysis encountered an error. Please ensure Ollama is running.",
      confidence: 0
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

  const PROFILE_OPTIONS = { temperature: 0.1, top_k: 20, num_predict: 600, num_ctx: 4096 };

  const messages = [
    { role: 'user' as const, content: prompt },
  ];

  let response;

  try {
    try {
      response = await ollama.chat({
        model: OLLAMA_PROFILE_MODEL,
        messages,
        format: 'json',
        keep_alive: 0,
        options: PROFILE_OPTIONS,
      } as any) as any;
    } catch (error: any) {
      const errorStr = String(error.message || error.error || "");
      if (errorStr.includes('CUDA') || errorStr.includes('allocate') || errorStr.includes('runner process has terminated')) {
        console.warn(`[AI] Ollama CUDA error detected for ${symbol} profile analysis, retrying with CPU fallback...`);
        response = await ollama.chat({
          model: OLLAMA_PROFILE_MODEL,
          messages,
          format: 'json',
          keep_alive: 0,
          options: { ...PROFILE_OPTIONS, num_gpu: 0 },
        } as any) as any;
      } else if (errorStr.includes('does not support chat') || errorStr.includes('does not support')) {
        const gen = await ollama.generate({
          model: OLLAMA_PROFILE_MODEL,
          prompt,
          format: 'json',
          keep_alive: 0,
          options: PROFILE_OPTIONS,
        } as any) as any;
        response = { message: { content: gen.response } };
      } else {
        throw error;
      }
    }

    if (response.message.content) {
      let content = response.message.content.trim();
      content = content.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(content);
      return {
        high_growth_scope: Boolean(parsed.high_growth_scope),
        in_news_for_growth: Boolean(parsed.in_news_for_growth),
        growth_score: Number(parsed.growth_score) || 0,
        reasoning: String(parsed.reasoning || ''),
      };
    }
    
    throw new Error("Empty response from Ollama");
  } catch (error: any) {
    console.error("Ollama Profile API Error:", error);
    
    return { 
      error: "Profile Analysis failed",
      high_growth_scope: false,
      in_news_for_growth: false,
      growth_score: 0,
      reasoning: "Failed to analyze profile. Ensure Ollama is running."
    };
  }
}
