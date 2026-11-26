import { z } from "zod";
import { router, publicProcedure, adminProcedure } from "../trpc";
import { telegramService } from "../telegramService";
import { dbAll, dbGet, dbRun } from "../dbAsync";
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

  /** 15-minute Telegram plan-level alerts (stop/target hits) + target-vs-stop success %. */
  getTelegram15mAlertFeed: publicProcedure
    .input(z.object({
      days: z.number().int().min(0).max(90).default(7),
      outcomeFilter: z.enum(['ALL', 'TARGET', 'STOP', 'BOTH']).default('ALL'),
      limit: z.number().int().min(10).max(500).default(200),
    }).optional())
    .query(async ({ input }) => {
      const days = input?.days ?? 7;
      const outcomeFilter = input?.outcomeFilter ?? 'ALL';
      const limit = input?.limit ?? 200;

      const windowClause = days > 0
        ? `AND GREATEST(COALESCE(target_alerted_at, '-infinity'::timestamptz), COALESCE(stop_alerted_at, '-infinity'::timestamptz)) >= now() - make_interval(days => ?)`
        : '';
      const windowParams = days > 0 ? [days] : [];

      const summaryRow = await dbGet<{
        target_hits: string | number;
        stop_hits: string | number;
        both_hits: string | number;
        today_target_hits: string | number;
        today_stop_hits: string | number;
        today_both_hits: string | number;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE target_alerted_at IS NOT NULL AND stop_alerted_at IS NULL) AS target_hits,
           COUNT(*) FILTER (WHERE stop_alerted_at IS NOT NULL AND target_alerted_at IS NULL) AS stop_hits,
           COUNT(*) FILTER (WHERE target_alerted_at IS NOT NULL AND stop_alerted_at IS NOT NULL) AS both_hits,
           COUNT(*) FILTER (WHERE target_alerted_at IS NOT NULL AND stop_alerted_at IS NULL AND (target_alerted_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS today_target_hits,
           COUNT(*) FILTER (WHERE stop_alerted_at IS NOT NULL AND target_alerted_at IS NULL AND (stop_alerted_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS today_stop_hits,
           COUNT(*) FILTER (WHERE target_alerted_at IS NOT NULL AND stop_alerted_at IS NOT NULL AND (GREATEST(target_alerted_at, stop_alerted_at) AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS today_both_hits
         FROM recommendation_log
         WHERE (stop_alerted_at IS NOT NULL OR target_alerted_at IS NOT NULL)
           ${windowClause}`,
        windowParams,
      );

      const targetHits = Number(summaryRow?.target_hits ?? 0);
      const stopHits = Number(summaryRow?.stop_hits ?? 0);
      const bothHits = Number(summaryRow?.both_hits ?? 0);
      const decided = targetHits + stopHits;
      const successPct = decided > 0 ? Number(((targetHits / decided) * 100).toFixed(1)) : null;

      const todayTargetHits = Number(summaryRow?.today_target_hits ?? 0);
      const todayStopHits = Number(summaryRow?.today_stop_hits ?? 0);
      const todayBothHits = Number(summaryRow?.today_both_hits ?? 0);
      const todayDecided = todayTargetHits + todayStopHits;
      const todaySuccessPct = todayDecided > 0 ? Number(((todayTargetHits / todayDecided) * 100).toFixed(1)) : null;

      const filterClause =
        outcomeFilter === 'TARGET' ? 'AND target_alerted_at IS NOT NULL AND stop_alerted_at IS NULL' :
        outcomeFilter === 'STOP' ? 'AND stop_alerted_at IS NOT NULL AND target_alerted_at IS NULL' :
        outcomeFilter === 'BOTH' ? 'AND target_alerted_at IS NOT NULL AND stop_alerted_at IS NOT NULL' : '';

      const alertRows = await dbAll<{
        id: number;
        symbol: string;
        rec_type: string;
        signal_date: string;
        generated_at: string | null;
        timeframe: string | null;
        source: string | null;
        status: string | null;
        outcome: string | null;
        entry_price: number | null;
        stop_loss: number | null;
        trailing_stop: number | null;
        target_1: number | null;
        actual_exit_price: number | null;
        actual_return_pct: number | null;
        stop_alerted_at: string | null;
        target_alerted_at: string | null;
      }>(
        `SELECT id, symbol, rec_type, signal_date::text AS signal_date,
                generated_at::text AS generated_at, timeframe, source, status, outcome,
                entry_price, stop_loss, trailing_stop, target_1,
                actual_exit_price, actual_return_pct,
                stop_alerted_at::text AS stop_alerted_at,
                target_alerted_at::text AS target_alerted_at
           FROM recommendation_log
          WHERE (stop_alerted_at IS NOT NULL OR target_alerted_at IS NOT NULL)
            ${windowClause}
            ${filterClause}
          ORDER BY GREATEST(
            COALESCE(target_alerted_at, '-infinity'::timestamptz),
            COALESCE(stop_alerted_at, '-infinity'::timestamptz)
          ) DESC
          LIMIT ?`,
        [...windowParams, limit],
      );

      const dispatches = await dbAll<{
        id: number;
        sent_at: string;
        ok: boolean;
        text: string;
      }>(
        `SELECT id, sent_at::text AS sent_at, ok, text
           FROM telegram_report_log
          WHERE (text LIKE '%Plan levels touched%' OR text LIKE '%Published plans changed%' OR text LIKE '%Market-Open Actionable Check%')
          ORDER BY sent_at DESC
          LIMIT 25`,
      ).catch(() => []);

      return {
        summary: {
          totalAlerts: targetHits + stopHits + bothHits,
          targetHits,
          stopHits,
          bothHits,
          successPct,
          todayTargetHits,
          todayStopHits,
          todayBothHits,
          todaySuccessPct,
        },
        alerts: alertRows.map((r) => {
          const hitKind =
            r.target_alerted_at && r.stop_alerted_at ? 'BOTH' as const :
            r.target_alerted_at ? 'TARGET' as const : 'STOP' as const;
          const hitAt =
            hitKind === 'TARGET' ? r.target_alerted_at :
            hitKind === 'STOP' ? r.stop_alerted_at :
            (r.target_alerted_at && r.stop_alerted_at && r.target_alerted_at > r.stop_alerted_at
              ? r.target_alerted_at : r.stop_alerted_at);
          return {
            id: Number(r.id),
            symbol: r.symbol,
            recType: r.rec_type,
            signalDate: r.signal_date,
            generatedAt: r.generated_at ?? r.signal_date,
            timeframe: r.timeframe,
            source: r.source,
            status: r.status,
            outcome: r.outcome,
            entryPrice: r.entry_price,
            stopLoss: r.stop_loss,
            trailingStop: r.trailing_stop,
            target1: r.target_1,
            actualExitPrice: r.actual_exit_price,
            actualReturnPct: r.actual_return_pct,
            stopAlertedAt: r.stop_alerted_at,
            targetAlertedAt: r.target_alerted_at,
            hitKind,
            hitAt,
          };
        }),
        dispatches,
      };
    }),
});
