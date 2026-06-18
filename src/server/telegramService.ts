import axios from 'axios';
import { dbGet, dbRun } from './dbAsync';

export class TelegramNotificationService {
  private async getSettings(): Promise<{ botToken: string; chatId: string; enabled: boolean }> {
    try {
      const tokenRow = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'") as { value: string } | undefined;
      const chatRow = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_chat_id'") as { value: string } | undefined;
      const enabledRow = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_enabled'") as { value: string } | undefined;

      return {
        botToken: tokenRow?.value || process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: chatRow?.value || process.env.TELEGRAM_CHAT_ID || '',
        enabled: enabledRow ? enabledRow.value === 'true' : true,
      };
    } catch (err) {
      console.error('[TelegramService] Failed to read database configuration:', err);
      return {
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || '',
        enabled: true,
      };
    }
  }

  /**
   * Save Telegram Bot Token and Chat ID to SQLite Database
   */
  public async saveSettings(botToken: string, chatId: string, enabled: boolean): Promise<void> {
    const ts = new Date().toISOString();
    await dbRun(`
      INSERT INTO app_settings (key, value, "updatedAt")
      VALUES ('telegram_bot_token', ?, ?),
             ('telegram_chat_id', ?, ?),
             ('telegram_enabled', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"
    `, [botToken, ts, chatId, ts, enabled ? 'true' : 'false', ts]);
    console.log('[TelegramService] Settings updated successfully in database');
  }

  /**
   * Send custom Markdown message to Telegram Chat
   */
  public async sendMarkdownMessage(text: string): Promise<boolean> {
    const { botToken, chatId, enabled } = await this.getSettings();
    if (!enabled || !botToken || !chatId) {
      console.warn('[TelegramService] Dispatched but botToken/chatId is missing or disabled');
      return false;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
      });
      console.log('[TelegramService] Telegram message sent successfully');
      return true;
    } catch (error: any) {
      console.error('[TelegramService] Failed to dispatch telegram notification:', error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Format and send real-time Signal Alerts
   */
  public async sendSignalNotification(symbol: string, type: 'BUY' | 'SELL' | 'HOLD', entry: number, target: number, stopLoss: number, confidence: number, reasoning: string): Promise<boolean> {
    const emoji = type === 'BUY' ? '🟢' : type === 'SELL' ? '🔴' : '🟡';
    const confidenceStr = confidence != null && confidence > 0 ? `${confidence}%` : 'N/A';
    const text = `
${emoji} *NEW TRADING SIGNAL TRIGGERED*

*Asset:* #${symbol}
*Action:* ${type}
*Confidence:* ${confidenceStr}

📊 *Trade Parameters:*
• *Entry Zone:* ₹${entry?.toFixed(2) ?? 'N/A'}
• *AI Target:* ₹${target?.toFixed(2) ?? 'N/A'}
• *Stop Loss:* ₹${stopLoss?.toFixed(2) ?? 'N/A'}

💡 *AI Analysis & Reasoning:*
_${reasoning}_
    `.trim();

    return this.sendMarkdownMessage(text);
  }

  /**
   * Format and send Price Cross alerts
   */
  public async sendPriceCrossNotification(symbol: string, price: number, level: string): Promise<boolean> {
    const text = `
⚠️ *KEY LEVEL CROSSOVER DETECTED*

*Asset:* #${symbol}
*Current Price:* ₹${price?.toFixed(2) ?? 'N/A'}
*Crossed Level:* ${level}
    `.trim();

    return this.sendMarkdownMessage(text);
  }
}

export const telegramService = new TelegramNotificationService();
