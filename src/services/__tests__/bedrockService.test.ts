import { describe, it, expect, vi, beforeEach } from 'vitest';

// Create mock structures
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => {
      return {
        send: mockSend
      };
    }),
    ConverseCommand: vi.fn().mockImplementation((input) => {
      return { input };
    })
  };
});

import { generateStockAnalysis, analyzeCompanyProfile } from '../bedrockService';

describe('Bedrock AI Service Tests', () => {
  beforeEach(() => {
    mockSend.mockReset();
    process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
    process.env.AWS_REGION = 'us-east-1';
  });

  it('generateStockAnalysis sends prompt to Bedrock and parses JSON output', async () => {
    const mockResponseText = JSON.stringify({
      sentiment: "Bullish",
      signal: "BUY",
      entry: 100,
      target: 120,
      stopLoss: 90,
      reasoning: "Strong technical indicators and high volume support a bullish trend.",
      confidence: 85
    });

    mockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [
            { text: mockResponseText }
          ]
        }
      }
    });

    const data = { price: 100, rsi: 35 };
    const result = await generateStockAnalysis('TCS', data);

    expect(result).toEqual({
      sentiment: "Bullish",
      signal: "BUY",
      entry: 100,
      target: 120,
      stopLoss: 90,
      reasoning: "Strong technical indicators and high volume support a bullish trend.",
      confidence: 85
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('generateStockAnalysis handles markdown code blocks and trims content', async () => {
    const mockResponseText = `\`\`\`json
    {
      "sentiment": "Bearish",
      "signal": "SELL",
      "entry": 200,
      "target": 180,
      "stopLoss": 210,
      "reasoning": "RSI shows overbought conditions and MACD crossover.",
      "confidence": 75
    }
    \`\`\``;

    mockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [
            { text: mockResponseText }
          ]
        }
      }
    });

    const data = { price: 200 };
    const result = await generateStockAnalysis('RELIANCE', data);

    expect(result.sentiment).toBe("Bearish");
    expect(result.signal).toBe("SELL");
    expect(result.entry).toBe(200);
    expect(result.target).toBe(180);
    expect(result.stopLoss).toBe(210);
  });

  it('generateStockAnalysis falls back gracefully on Bedrock API error', async () => {
    mockSend.mockRejectedValueOnce(new Error("Bedrock service limits exceeded"));

    const data = { price: 150 };
    const result = await generateStockAnalysis('INFY', data);

    expect(result.sentiment).toBe("Neutral");
    expect(result.signal).toBe("HOLD");
    expect(result.entry).toBe(150);
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("Amazon Bedrock Claude model encountered an error");
    expect(result.error).toBe("Bedrock service limits exceeded");
  });

  it('analyzeCompanyProfile sends profile to Bedrock and resolves growth parameters', async () => {
    const mockProfileText = JSON.stringify({
      high_growth_scope: true,
      in_news_for_growth: false,
      growth_score: 80,
      reasoning: "TCS expands AI cloud capabilities."
    });

    mockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [
            { text: mockProfileText }
          ]
        }
      }
    });

    const result = await analyzeCompanyProfile('TCS', 'TCS is a global leader in IT consulting and services...');

    expect(result).toEqual({
      high_growth_scope: true,
      in_news_for_growth: false,
      growth_score: 80,
      reasoning: "TCS expands AI cloud capabilities."
    });
  });

  it('analyzeCompanyProfile falls back gracefully on Bedrock API error', async () => {
    mockSend.mockRejectedValueOnce(new Error("AWS Credentials Expired"));

    const result = await analyzeCompanyProfile('TCS', 'TCS profile');

    expect(result.high_growth_scope).toBe(false);
    expect(result.in_news_for_growth).toBe(false);
    expect(result.growth_score).toBe(0);
    expect(result.reasoning).toContain("Amazon Bedrock profile analysis encountered an error");
    expect(result.error).toBe("AWS Credentials Expired");
  });
});
