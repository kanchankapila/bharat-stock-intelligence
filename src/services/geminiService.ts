import { GoogleGenAI, Type } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAiClient() {
  if (!_ai) {
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _ai;
}

// Price levels are NOT requested here: the ATR-barrier engine (src/server/atrBarriers.ts)
// overrides entry/target/stopLoss for every AI signal regardless of what the LLM says, so
// asking for them just burns tokens on a task this model has no volatility context for.
export async function generateStockAnalysis(symbol: string, data: any) {
  const prompt = `
    Analyze the following stock data for ${symbol}:
    ${JSON.stringify(data)}

    Give a trading verdict: sentiment, signal (BUY/SELL/HOLD), and a 1-2 sentence
    reasoning synthesizing the key confirming/conflicting signals. Do not restate the raw data.
  `;

  try {
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 300,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            sentiment: { type: Type.STRING, description: "Bullish, Bearish, or Neutral" },
            signal: { type: Type.STRING, description: "BUY, SELL, or HOLD" },
            reasoning: { type: Type.STRING, description: "1-2 sentences" },
            confidence: { type: Type.NUMBER, description: "0-100" }
          },
          required: ["sentiment", "signal", "reasoning", "confidence"]
        }
      }
    });

    if (response.text) {
      return JSON.parse(response.text.trim());
    }

    return { error: "Failed to parse AI response" };
  } catch (error: any) {
    console.error("GenAI API Error:", error);

    // Specifically handle 429 Resource Exhausted
    if (error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
      return {
        error: "QUOTA_EXCEEDED",
        reasoning: "AI analysis is temporarily unavailable due to high demand. Please try again in 60 seconds.",
        sentiment: "Neutral",
        signal: "HOLD",
        confidence: 0
      };
    }

    return { error: "AI Analysis failed" };
  }
}

export async function analyzeCompanyProfile(symbol: string, description: string) {
  const prompt = `Analyze the following company profile for ${symbol}:
"${description}"

Determine if the company has high growth scope and whether it is in the news for growth.`;

  try {
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 300,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            high_growth_scope: { type: Type.BOOLEAN },
            in_news_for_growth: { type: Type.BOOLEAN },
            growth_score: { type: Type.NUMBER, description: "0-100" },
            reasoning: { type: Type.STRING, description: "1-2 sentences" },
          },
          required: ["high_growth_scope", "in_news_for_growth", "growth_score", "reasoning"]
        }
      }
    });

    if (response.text) {
      const parsed = JSON.parse(response.text.trim());
      return {
        high_growth_scope: Boolean(parsed.high_growth_scope),
        in_news_for_growth: Boolean(parsed.in_news_for_growth),
        growth_score: Number(parsed.growth_score) || 0,
        reasoning: String(parsed.reasoning || ''),
      };
    }

    return { error: "Failed to parse AI response" };
  } catch (error: any) {
    console.error("GenAI Profile API Error:", error);

    if (error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
      return {
        error: "QUOTA_EXCEEDED",
        high_growth_scope: false,
        in_news_for_growth: false,
        growth_score: 0,
        reasoning: "AI analysis is temporarily unavailable due to high demand. Please try again in 60 seconds.",
      };
    }

    return { error: "Profile Analysis failed" };
  }
}
