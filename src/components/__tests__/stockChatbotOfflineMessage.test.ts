import { describe, expect, it } from 'vitest';
import { offlineMessage } from '../StockChatbot';

// A chatbot that is running but has no LLM key answers /health with 503 + llm "unavailable".
// Telling the user to start a service that is already running sends them the wrong way.
describe('StockChatbot offline message', () => {
  it('names the missing LLM key when the service is up but has no LLM', () => {
    expect(offlineMessage({ status: 'degraded', llm: 'unavailable', graph_ready: true }))
      .toMatch(/GEMINI_API_KEY/);
  });

  it('says the service is not running when /health is unreachable', () => {
    expect(offlineMessage(null)).toMatch(/not running/i);
  });
});
