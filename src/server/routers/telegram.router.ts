import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { telegramService } from "../telegramService";
import { dbGet, dbRun } from "../dbAsync";
import { invalidateNiftyTraderToken } from "../niftytraderService";

export const telegramRouter = router({
  getTelegramSettings: publicProcedure
    .query(async () => {
      try {
        const tokenRow = await dbGet<{ value: string }>("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'");
        const chatRow = await dbGet<{ value: string }>("SELECT value FROM app_settings WHERE key = 'telegram_chat_id'");
        const enabledRow = await dbGet<{ value: string }>("SELECT value FROM app_settings WHERE key = 'telegram_enabled'");

        // Mask token for security in settings UI
        const rawToken = tokenRow?.value || "";
        const maskedToken = rawToken ? `${rawToken.substring(0, 6)}...${rawToken.substring(rawToken.length - 4)}` : "";

        return {
          botToken: maskedToken,
          chatId: chatRow?.value || "",
          enabled: enabledRow ? enabledRow.value === 'true' : true,
          hasToken: !!rawToken,
        };
      } catch (err) {
        return { botToken: "", chatId: "", enabled: false, hasToken: false };
      }
    }),

  saveTelegramSettings: publicProcedure
    .input(z.object({
      botToken: z.string(),
      chatId: z.string(),
      enabled: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      try {
        // If masked token is provided back, preserve the original value
        let actualToken = input.botToken;
        if (input.botToken.includes('...')) {
          const tokenRow = await dbGet<{ value: string }>("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'");
          actualToken = tokenRow?.value || "";
        }

        await telegramService.saveSettings(actualToken, input.chatId, input.enabled);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }),

  testTelegramConnection: publicProcedure
    .mutation(async () => {
      try {
        const ok = await telegramService.sendMarkdownMessage(
          `🔔 *BHARAT STOCK INTELLIGENCE* \n\nConnection test successful! You are now subscribed to real-time institutional alerts.`
        );
        return { success: ok };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }),

  getNiftyTraderToken: publicProcedure
    .query(async () => {
      try {
        const row = await dbGet<{ value: string }>("SELECT value FROM app_settings WHERE key = 'niftytrader_auth_token'");
        const rawToken = row?.value || "";
        const maskedToken = rawToken ? `${rawToken.substring(0, 10)}...${rawToken.substring(rawToken.length - 8)}` : "";
        return {
          token: maskedToken,
          hasToken: !!rawToken,
        };
      } catch (err) {
        return { token: "", hasToken: false };
      }
    }),

  saveNiftyTraderToken: publicProcedure
    .input(z.object({
      token: z.string(),
    }))
    .mutation(async ({ input }) => {
      try {
        let actualToken = input.token.trim();
        if (input.token.includes('...')) {
          const row = await dbGet<{ value: string }>("SELECT value FROM app_settings WHERE key = 'niftytrader_auth_token'");
          actualToken = row?.value || "";
        }
        await dbRun(
          `INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"`,
          ['niftytrader_auth_token', actualToken]
        );
        invalidateNiftyTraderToken();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }),
});
