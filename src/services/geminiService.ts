import { GoogleGenAI, Type } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAiClient() {
  if (!_ai) {
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _ai;
}

export async function generateStockAnalysis(symbol: string, data: any) {
  const prompt = `
    Analyze the following stock data for ${symbol}:
    ${JSON.stringify(data, null, 2)}

    Provide a concise trading analysis including sentiment, trading signal (BUY/SELL/HOLD), entry, target, and stop-loss prices.
    Include a detailed reasoning for the signal based on the technical data provided.
  `;

  try {
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            sentiment: { type: Type.STRING, description: "Bullish, Bearish, or Neutral" },
            signal: { type: Type.STRING, description: "BUY, SELL, or HOLD" },
            entry: { type: Type.NUMBER },
            target: { type: Type.NUMBER },
            stopLoss: { type: Type.NUMBER },
            reasoning: { type: Type.STRING },
            confidence: { type: Type.NUMBER, description: "0-100" }
          },
          required: ["sentiment", "signal", "entry", "target", "stopLoss", "reasoning", "confidence"]
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
        entry: data.price,
        target: data.price * 1.05,
        stopLoss: data.price * 0.95,
        confidence: 0
      };
    }
    
    return { error: "AI Analysis failed" };
  }
}
