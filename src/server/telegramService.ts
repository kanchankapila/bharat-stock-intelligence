import axios from 'axios';
import { dbGet, dbRun } from './dbAsync';

/**
 * Telegram's legacy Markdown parser aborts the whole message on an unbalanced entity, so any
 * free-text field (AI reasoning, a screener/level name) containing a stray `_`/`*`/`` ` ``/`[`
 * silently drops the entire message ("can't parse entities: Can't find end of the entity...").
 * Strip rather than backslash-escape: these strings are display-only and the markers carry no
 * formatting meaning here, and legacy Markdown's escaping rules are inconsistent across clients.
 */
export function sanitizeMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/[_*`[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

export class TelegramNotificationService {
  private _settingsCache: { botToken: string; chatId: string; enabled: boolean } | null = null;

  private async getSettings(): Promise<{ botToken: string; chatId: string; enabled: boolean }> {
    if (this._settingsCache) return this._settingsCache;
    try {
      const tokenRow = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'") as { value: string } | undefined;
      const chatRow = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_chat_id'") as { value: string } | undefined;
      const enabledRow = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_enabled'") as { value: string } | undefined;

      this._settingsCache = {
        botToken: tokenRow?.value || process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: chatRow?.value || process.env.TELEGRAM_CHAT_ID || '',
        enabled: enabledRow ? enabledRow.value === 'true' : true,
      };
      return this._settingsCache;
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
    this._settingsCache = null;  // invalidate before writing
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
    text = balanceMarkdownEntities(text);
    const { botToken, chatId, enabled } = await this.getSettings();
    if (!enabled || !botToken || !chatId) {
      console.warn('[TelegramService] Dispatched but botToken/chatId is missing or disabled');
      return false;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const MAX_LEN = 4000;
    const chunks: string[] = [];
    if (text.length <= MAX_LEN) {
      chunks.push(text);
    } else {
      let current = '';
      const flush = () => { if (current) { chunks.push(current); current = ''; } };
      for (const line of text.split('\n')) {
        // A single line longer than MAX_LEN can't be appended whole -- slicing off just the
        // first MAX_LEN chars and discarding the remainder would silently drop content, the
        // exact failure this chunking exists to prevent. Split it into its own MAX_LEN pieces.
        if (line.length > MAX_LEN) {
          flush();
          for (let i = 0; i < line.length; i += MAX_LEN) {
            chunks.push(line.slice(i, i + MAX_LEN));
          }
          continue;
        }
        if ((current + '\n' + line).length > MAX_LEN) {
          flush();
          current = line;
        } else {
          current = current ? current + '\n' + line : line;
        }
      }
      flush();
    }

    let allSuccess = true;
    for (const chunk of chunks) {
      try {
        await axios.post(url, {
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        });
        console.log('[TelegramService] Telegram message chunk sent successfully');
      } catch (error: any) {
        console.error('[TelegramService] Failed to dispatch telegram notification:', error.response?.data || error.message);
        // Fallback: If Telegram rejected Markdown formatting (e.g. unescaped underscores/asterisks),
        // retry once sending as plain text so the notification is never dropped.
        const desc = error.response?.data?.description || '';
        if (desc.includes("can't parse entities") || desc.includes("entity")) {
          try {
            await axios.post(url, {
              chat_id: chatId,
              text: chunk,
            });
            console.log('[TelegramService] Telegram message chunk sent via plain-text fallback');
            continue;
          } catch (retryErr: any) {
            console.error('[TelegramService] Plain-text fallback also failed:', retryErr.response?.data || retryErr.message);
          }
        }
        allSuccess = false;
      }
    }
    return allSuccess;
  }

  /**
   * Format and send real-time Signal Alerts
   */
  public async sendSignalNotification(symbol: string, type: 'BUY' | 'SELL' | 'HOLD', entry: number, target: number, stopLoss: number, confidence: number, reasoning: string): Promise<boolean> {
    const emoji = type === 'BUY' ? '🟢' : type === 'SELL' ? '🔴' : '🟡';
    const confidenceStr = confidence != null && confidence > 0 ? `${confidence}%` : 'N/A';
    const text = `
${emoji} *NEW TRADING SIGNAL TRIGGERED*

*Asset:* #${sanitizeMarkdown(symbol)}
*Action:* ${type}
*Confidence:* ${confidenceStr}

📊 *Trade Parameters:*
• *Entry Zone:* ₹${entry?.toFixed(2) ?? 'N/A'}
• *AI Target:* ₹${target?.toFixed(2) ?? 'N/A'}
• *Stop Loss:* ₹${stopLoss?.toFixed(2) ?? 'N/A'}

💡 *AI Analysis & Reasoning:*
_${sanitizeMarkdown(reasoning)}_
    `.trim();

    return this.sendMarkdownMessage(text);
  }

  /**
   * Format and send Price Cross alerts
   */
  public async sendPriceCrossNotification(symbol: string, price: number, level: string): Promise<boolean> {
    const text = `
⚠️ *KEY LEVEL CROSSOVER DETECTED*

*Asset:* #${sanitizeMarkdown(symbol)}
*Current Price:* ₹${price?.toFixed(2) ?? 'N/A'}
*Crossed Level:* ${sanitizeMarkdown(level)}
    `.trim();

    return this.sendMarkdownMessage(text);
  }
}

export const telegramService = new TelegramNotificationService();

/**
 * Neutralises UNTERMINATED Telegram legacy-Markdown entities, leaving balanced ones intact.
 *
 * Telegram rejects a message with an unclosed entity: HTTP 400 "can't parse entities: Can't
 * find end of the entity starting at byte offset N". Live 2026-09-05 14:08:08 the ml-daily-ops
 * completion notice read `19 ok, 1 failed: analyst_revision` -- one underscore, read as the
 * start of an italic run that never closes. Every job step, table and script name here is
 * snake_case, so any notification naming one is a coin flip on whether the count is even.
 *
 * There is already a plain-text retry, so nothing is ever LOST -- which is exactly why this
 * went unfixed: the cost is a permanent error-level log line plus silently dropped formatting
 * in precisely the messages that report failures. Same shape as recurring-bugs.md's
 * "a monitor that fires on every run", one layer down: a recurring error nobody can act on
 * trains you to ignore the error level.
 *
 * Escaping only on an ODD count is deliberate: a blanket escape would destroy the intentional
 * `*bold*` headers every digest uses, and Telegram honours backslash escapes for these
 * characters in legacy Markdown.
 */
export function balanceMarkdownEntities(text: string): string {
  let out = text;
  for (const d of ['`', '*', '_']) {
    const unescaped = new RegExp(`(^|[^\\\\])\\${d}`, 'g');
    const count = (out.match(unescaped) || []).length;
    if (count % 2 === 1) out = out.replace(unescaped, (_m, p) => `${p}\\${d}`);
  }
  // A link is `[label](url)`: an opening bracket with no matching `](` can never terminate.
  const opens = (out.match(/(^|[^\\])\[/g) || []).length;
  const closes = (out.match(/\]\(/g) || []).length;
  if (opens !== closes) out = out.replace(/(^|[^\\])\[/g, (_m, p) => `${p}\\[`);
  return out;
}
