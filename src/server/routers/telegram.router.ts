import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { telegramService } from "../telegramService";
import db from "../db";

export const telegramRouter = router({
  getTelegramSettings: publicProcedure
    .query(async () => {
      try {
        const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'").get() as { value: string } | undefined;
        const chatRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_chat_id'").get() as { value: string } | undefined;
        const enabledRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_enabled'").get() as { value: string } | undefined;

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
          const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'").get() as { value: string } | undefined;
          actualToken = tokenRow?.value || "";
        }

        telegramService.saveSettings(actualToken, input.chatId, input.enabled);
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
});
