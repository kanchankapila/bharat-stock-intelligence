import ollama from 'ollama';

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';

export async function releaseOllamaModel(): Promise<void> {
  try {
    await ollama.generate({ model: OLLAMA_MODEL, prompt: '', keep_alive: 0 } as any);
    console.log(`[OLLAMA] Model ${OLLAMA_MODEL} unloaded from memory`);
  } catch {
    // non-critical
  }
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
  const prompt = `
    Analyze the following stock data for ${symbol}:
    ${JSON.stringify(data, null, 2)}

    Provide a concise trading analysis including sentiment, trading signal (BUY/SELL/HOLD), entry, target, and stop-loss prices.
    Include a detailed reasoning for the signal based on the technical data provided.
    
    Response MUST be in valid JSON format with the following structure:
    {
      "sentiment": "Bullish/Bearish/Neutral",
      "signal": "BUY/SELL/HOLD",
      "entry": number,
      "target": number,
      "stopLoss": number,
      "reasoning": "string",
      "confidence": number (0-100)
    }
  `;

  let response;

  try {
    try {
      response = await ollama.chat({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        format: 'json',
        keep_alive: 0,
      } as any);
    } catch (error: any) {
      const errorStr = String(error.message || error.error || "");
      if (errorStr.includes('CUDA') || errorStr.includes('allocate') || errorStr.includes('runner process has terminated')) {
        console.warn(`[AI] Ollama CUDA error detected for ${symbol}, retrying with CPU fallback...`);
        response = await ollama.chat({
          model: OLLAMA_MODEL,
          messages: [{ role: 'user', content: prompt }],
          format: 'json',
          keep_alive: 0,
          options: { num_gpu: 0 },
        } as any);
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
  const prompt = `
    Analyze the following company profile and description for ${symbol}:
    "${description}"

    Determine if the company has a high scope of growth based on the provided text, and whether it is in the news or belongs to a sector in news for high growth.
    
    Response MUST be in valid JSON format with the following structure:
    {
      "high_growth_scope": boolean,
      "in_news_for_growth": boolean,
      "growth_score": number (0 to 100),
      "reasoning": "Detailed 2-3 sentence explanation."
    }
  `;

  let response;

  try {
    try {
      response = await ollama.chat({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        format: 'json',
      });
    } catch (error: any) {
      const errorStr = String(error.message || error.error || "");
      if (errorStr.includes('CUDA') || errorStr.includes('allocate') || errorStr.includes('runner process has terminated')) {
        console.warn(`[AI] Ollama CUDA error detected for ${symbol} profile analysis, retrying with CPU fallback...`);
        response = await ollama.chat({
          model: OLLAMA_MODEL,
          messages: [{ role: 'user', content: prompt }],
          format: 'json',
          options: { num_gpu: 0 },
        });
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
