// LM Studio provides OpenAI-compatible API at localhost:1234
// Qwen3-8B model typically requires ~4-5GB VRAM
const LM_STUDIO_BASE_URL = process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1';
const LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL || 'qwen3-8b';

let _aiClient: any = null;
let requestGate: Promise<void> = Promise.resolve();
let nextRequestAt = 0;

function getAiClient() {
  if (!_aiClient) {
    _aiClient = {
      async chatCompletion(messages: any[], options: any = {}) {
        const apiKey = process.env.LM_STUDIO_API_KEY || 'sk-lmstudio';
        
        const payload = {
          model: options.model || LM_STUDIO_MODEL,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.max_tokens,
        };

        const response = await fetch(`${LM_STUDIO_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`LM Studio API error ${response.status}: ${errorText}`);
        }

        return response.json();
      },
      async generateText(prompt: string, options: any = {}) {
        const messages = [
          { role: 'user', content: prompt }
        ];

        const result = await this.chatCompletion(messages, options);
        return {
          text: result.choices?.[0]?.message?.content || '',
          finishReason: result.choices?.[0]?.finish_reason || 'stop',
        };
      },
    };
  }
  return _aiClient;
}

async function rateLimitedGenerateText(args: {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}) {
  const previous = requestGate;
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  requestGate = previous.then(() => turn);
  await previous;

  try {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + 13_000;

    const client = getAiClient();
    return await client.generateText(args.prompt, {
      temperature: args.temperature ?? 0.7,
      maxTokens: args.maxTokens,
      model: args.model || LM_STUDIO_MODEL,
    });
  } finally {
    release();
  }
}
export async function analyzeCompanyProfile(symbol: string, description: string) {
  if (!process.env.LM_STUDIO_BASE_URL) {
    return {
      error: 'LM_STUDIO_BASE_URL not configured',
      high_growth_scope: false,
      in_news_for_growth: false,
      growth_score: 0,
      reasoning: 'Profile analysis is unconfigured (LM Studio not set up).',
    };
  }

  const prompt = `Analyze the following company profile for ${symbol}:
"${description}"

Determine if the company has high growth scope and whether it is in the news for growth. 
Provide a JSON response with: high_growth_scope (boolean), in_news_for_growth (boolean), 
growth_score (number 0-100), and reasoning (1-2 sentences).`;

  try {
    const result = await rateLimitedGenerateText({ prompt });

    if (result.text) {
      try {
        const parsed = JSON.parse(result.text.trim());
        return {
          high_growth_scope: Boolean(parsed.high_growth_scope),
          in_news_for_growth: Boolean(parsed.in_news_for_growth),
          growth_score: Number(parsed.growth_score) || 0,
          reasoning: String(parsed.reasoning || ''),
        };
      } catch {
        return {
          error: 'Failed to parse AI response',
          high_growth_scope: false,
          in_news_for_growth: false,
          growth_score: 0,
          reasoning: result.text,
        };
      }
    }

    return {
      error: 'Failed to parse AI response',
      high_growth_scope: false,
      in_news_for_growth: false,
      growth_score: 0,
      reasoning: '',
    };
  } catch (error: any) {
    console.warn(`[LM_STUDIO] profile analysis unavailable: ${error?.message ?? error}`);

    return {
      error: 'PROFILE_ANALYSIS_FAILED',
      high_growth_scope: false,
      in_news_for_growth: false,
      growth_score: 0,
      reasoning: 'AI profile analysis unavailable after error; prior profile fields were preserved.',
    };
  }
}

export async function generateStockAnalysis(prompt: string): Promise<string> {
  if (!process.env.LM_STUDIO_BASE_URL) {
    return '[AI analysis unavailable - LM Studio not configured]';
  }

  try {
    const result = await rateLimitedGenerateText({ prompt });
    return result.text || '[AI analysis returned empty response]';
  } catch (error: any) {
    console.error('[LM_STUDIO] stock analysis failed:', error?.message ?? error);
    return `[AI analysis failed: ${error?.message ?? 'unknown error'}]`;
  }
}

export async function generateTechnicalAnalysis(symbol: string, technicalData: string): Promise<string> {
  if (!process.env.LM_STUDIO_BASE_URL) {
    return '[AI analysis unavailable - LM Studio not configured]';
  }

  const prompt = `Analyze the technical indicators for ${symbol}:

${technicalData}

Provide a concise technical analysis including:
1. Current trend direction (uptrend/downtrend/sideways)
2. Key support and resistance levels
3. Momentum indicators assessment (RSI, MACD)
4. Trend strength and potential reversal signals
5. Trading recommendation (BUY/HOLD/SELL) with confidence level 0-100`;

  try {
    const result = await rateLimitedGenerateText({ prompt });
    return result.text || '[No technical analysis generated]';
  } catch (error: any) {
    console.error('[LM_STUDIO] technical analysis failed:', error?.message ?? error);
    return `[Technical analysis failed: ${error?.message ?? 'unknown error'}]`;
  }
}

export async function checkLmStudioHealth(): Promise<{ available: boolean; model: string; error?: string }> {
  try {
    const client = getAiClient();
    await client.chatCompletion([
      { role: 'user', content: 'Hello' }
    ], { model: LM_STUDIO_MODEL });
    return { available: true, model: LM_STUDIO_MODEL };
  } catch (error: any) {
    return {
      available: false,
      model: LM_STUDIO_MODEL,
      error: error?.message ?? 'Unable to connect to LM Studio',
    };
  }
}