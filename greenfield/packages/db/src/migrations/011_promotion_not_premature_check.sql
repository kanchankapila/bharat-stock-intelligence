-- Up Migration
-- Task 5.2's own Verify requirement #2 / one of Task 5.6's four Stage 5 dq
-- checks: "is_publishable = true never exists before min_dates shadow
-- sessions have accumulated". Registered now (ahead of the rest of Task 5.6)
-- because Task 5.2 itself cannot be verified without it.
--
-- Deliberately no `spec` threshold here the way Stage 4's checks use one
-- (queryDqCheckSpec) -- the ONLY legitimate source for min_dates is the
-- preregistered `shadow_period_preregistration` row in audit_metric (Task
-- 5.2), which is append-only and, by this check's own read order (earliest
-- row wins), cannot be loosened by a later insert. A `dq_check.spec` column
-- is ordinary mutable config; sourcing the threshold from it would open
-- exactly the "edit the bar after seeing why it failed" path spec invariant
-- 13/26 exist to close off.
INSERT INTO dq_check (check_id, label, category, target_table, severity, trading_day_aware, warn_days, fail_days, spec) VALUES
  ('promotion-not-premature', 'is_publishable=true never appears before the preregistered min_dates shadow sessions have accumulated', 'gating', 'recommendation', 'fail', false, NULL, NULL, '{}'::jsonb);

-- Down Migration
DELETE FROM dq_check WHERE check_id = 'promotion-not-premature';
