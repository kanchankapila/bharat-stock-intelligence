-- Up Migration
--
-- app_settings.ai_signal_min_win_prob (the quant-endorsement floor gating the AI-signal path,
-- see signals.ts's getAISignalMinWinProb/gateOnQuant) had never been seeded anywhere in schema
-- or migrations -- it only ever existed as a one-off `UPDATE app_settings ... WHERE
-- key='ai_signal_min_win_prob'` run by hand against a single running deployment on 2026-08-02,
-- after discovering the code default (0.40) sits exactly on a degenerate calibration plateau
-- (~95% of the universe shares one identical calibrated_win_probability, ~0.4064, on most
-- days) that made the gate a near-no-op. Because that fix was never committed, a fresh/reset DB
-- (a new environment, a disaster-recovery restore, a second deployment) silently reverted to
-- the stale 0.40 default with no error -- which is what caused a burst of 60+ Telegram alerts
-- in a few minutes on 2026-08-06 once a companion fix (fcd8557, 2026-08-05) removed the
-- websocketService.ts confidence>=85 threshold that had been accidentally suppressing Telegram
-- delivery for every AI signal since 2026-07-18 regardless of this gate's real selectivity.
--
-- ON CONFLICT DO NOTHING: never override an operator's own intentional value if one already
-- exists (matches this project's established never-clobber convention for app_settings/gap-fill
-- writes elsewhere). signals.ts's own DEFAULT_AI_SIGNAL_MIN_WIN_PROB=0.42 code fallback is the
-- second, independent line of defense for any environment this migration hasn't reached yet.
-- "updatedAt" is TIMESTAMPTZ (db/schema.postgres.sql) -- now(), not a text literal/cast.
INSERT INTO app_settings ("key", "value", "updatedAt")
VALUES ('ai_signal_min_win_prob', '0.42', now())
ON CONFLICT ("key") DO NOTHING;

-- Down Migration
--
-- Deliberately a no-op: removing this row would drop the seeded value back to whatever
-- signals.ts's code default happens to be (now also 0.42, see the fix above), and if an
-- operator has since intentionally overridden this key, a DOWN migration blindly deleting it
-- would destroy that override. There is nothing safe to automatically undo here.
