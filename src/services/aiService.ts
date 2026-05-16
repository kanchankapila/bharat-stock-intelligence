import ollama from 'ollama';

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

  const model = process.env.OLLAMA_MODEL || 'mistral';
  let response;

  try {
    try {
      response = await ollama.chat({
        model,
        messages: [{ role: 'user', content: prompt }],
        format: 'json',
      });
    } catch (error: any) {
      const errorStr = String(error.message || error.error || "");
      if (errorStr.includes('CUDA') || errorStr.includes('allocate') || errorStr.includes('runner process has terminated')) {
        console.warn(`[AI] Ollama CUDA error detected for ${symbol}, retrying with CPU fallback...`);
        response = await ollama.chat({
          model,
          messages: [{ role: 'user', content: prompt }],
          format: 'json',
          options: {
            num_gpu: 0, // Force CPU
          }
        });
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
