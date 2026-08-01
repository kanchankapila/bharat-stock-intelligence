import { z } from "zod";
import { router, publicProcedure, adminProcedure } from "../trpc";
import { telegramService } from "../telegramService";
import { dbGet, dbRun } from "../dbAsync";
import { invalidateNiftyTraderToken } from "../niftytraderService";

// Mutations that write global app credentials (bot token, broker session token) require
// adminProcedure — an authenticated user AND uid ∈ ADMIN_UIDS — since these aren't
// per-user resources, they're shared platform config any signed-in user must not overwrite.
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
        console.error(err);
        return { botToken: "", chatId: "", enabled: false, hasToken: false };
      }
    }),

  saveTelegramSettings: adminProcedure
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
        console.error(err);
        return { success: false, error: err.message };
      }
    }),

  testTelegramConnection: adminProcedure
    .mutation(async () => {
      try {
        const ok = await telegramService.sendMarkdownMessage(
          `🔔 *BHARAT STOCK INTELLIGENCE* \n\nConnection test successful! You are now subscribed to real-time institutional alerts.`
        );
        return { success: ok };
      } catch (err: any) {
        console.error(err);
        return { success: false, error: err.message };
      }
    }),

  /** Send the stock-recommendation digest immediately, outside its 08:15 IST schedule. */
  sendRecommendationsDigest: adminProcedure
    .mutation(async () => {
      try {
        const { sendRecommendationsDigest } = await import('../telegramRecommendations');
        const res = await sendRecommendationsDigest();
        return { success: res.sent, picks: res.picks };
      } catch (err: any) {
        console.error(err);
        return { success: false, error: err.message };
      }
    }),

  /** Preview the digest text without sending it — useful for checking formatting. */
  previewRecommendationsDigest: adminProcedure
    .query(async () => {
      const { buildRecommendationsDigest, renderDigest } = await import('../telegramRecommendations');
      const data = await buildRecommendationsDigest();
      return { text: renderDigest(data), picks: data.longTerm.length + data.intraday.length };
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
        console.error(err);
        return { token: "", hasToken: false };
      }
    }),

  saveNiftyTraderToken: adminProcedure
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
        console.error(err);
        return { success: false, error: err.message };
      }
    }),
});
