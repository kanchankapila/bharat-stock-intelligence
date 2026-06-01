import axios from 'axios';
import Database from 'better-sqlite3';
import path from 'path';

const DATABASE_URL = process.env.DATABASE_URL || 'database.sqlite';
const dbPath = DATABASE_URL === ':memory:' ? ':memory:' : path.resolve(process.cwd(), DATABASE_URL);
const db = new Database(dbPath);

export class TelegramNotificationService {
  private getSettings(): { botToken: string; chatId: string; enabled: boolean } {
    try {
      const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'").get() as { value: string } | undefined;
      const chatRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_chat_id'").get() as { value: string } | undefined;
      const enabledRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_enabled'").get() as { value: string } | undefined;

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
  public saveSettings(botToken: string, chatId: string, enabled: boolean): void {
    const ts = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value, updatedAt)
      VALUES ('telegram_bot_token', ?, ?),
             ('telegram_chat_id', ?, ?),
             ('telegram_enabled', ?, ?)
    `).run(botToken, ts, chatId, ts, enabled ? 'true' : 'false', ts);
    console.log('[TelegramService] Settings updated successfully in database');
  }

  /**
   * Send custom Markdown message to Telegram Chat
   */
  public async sendMarkdownMessage(text: string): Promise<boolean> {
    const { botToken, chatId, enabled } = this.getSettings();
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
    const text = `
${emoji} *NEW TRADING SIGNAL TRIGGERED*

*Asset:* $${symbol}
*Action:* ${type}
*Confidence:* ${confidence}%

📊 *Trade Parameters:*
• *Entry Zone:* ₹${entry.toFixed(2)}
• *AI Target:* ₹${target.toFixed(2)}
• *Stop Loss:* ₹${stopLoss.toFixed(2)}

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

*Asset:* $${symbol}
*Current Price:* ₹${price.toFixed(2)}
*Crossed Level:* ${level}
    `.trim();

    return this.sendMarkdownMessage(text);
  }
}

export const telegramService = new TelegramNotificationService();
