// The pass/pending/fail decision behind scripts/check_deploy_drift.mjs, extracted as a pure
// function so it can be tested without executing the script.
//
// Deliberately a separate module rather than an `import.meta.url === argv[1]` guard inside the
// script: pm2 launches that script in fork mode with `interpreter: 'node'`
// (ecosystem.config.cjs), and if such a guard ever evaluated false there, the check would
// silently become a no-op — a critical monitor that reports nothing while looking registered
// and healthy is strictly worse than the noise this change exists to fix. The script keeps
// calling main() unconditionally; only the decision moved.

// How long HEAD is allowed to sit ahead of the running process before that counts as a finding.
//
// Why a grace window exists at all: the original check was `if (head.committedAt >
// proc.startedAt)` with no tolerance, so it went red the instant anyone committed and stayed red
// until the next restart. On any active development day that is red BY CONSTRUCTION, on an entry
// marked `critical: true` — and `.claude/rules/recurring-bugs.md` is explicit that a check which
// cries wolf on correct data stops being read. Losing attention on this one would cost the real
// finding it exists for (AF-14, "server N commits behind HEAD", historically only ever caught
// late by a human noticing).
//
// Keyed on how long HEAD has been AHEAD (now - committedAt), NOT on the commit-vs-restart gap.
// That gap is frozen the moment the commit lands, so it can never express "how long has this
// been sitting undeployed" — the only question that separates "someone is mid-session, the
// restart is coming" from "a merged fix has been dead for hours".
export const DEPLOY_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * How long an undeployed commit may sit before the check STOPS alerting and STARTS fixing.
 *
 * History: the check used to fail past the grace window and stay red until a human noticed
 * and ran `pm2 restart bharat-server`. Measured over its first week (digest, 2026-08-25):
 * 167/530 runs failing — every commit turned it red 2h later, and the restart always
 * eventually happened but only after hours of red on a critical monitor. The failure mode it
 * exists to catch ("a merged fix has been dead for hours", AF-14) is one pm2 command away
 * from fixed, and that command is idempotent and side-effect-free beyond the restart itself:
 * the server re-reads HEAD from disk on boot. So past the grace window the script now runs
 * the restart itself (self-healing) and stamps the heartbeat with what it did; the drift
 * still surfaces in run history via the `auto_restarted` marker rather than as a red row.
 *
 * Kill switch: DEPLOY_DRIFT_AUTO_RESTART=0 restores pure alert-only behaviour (e.g. if you
 * want to pin a specific running build during an incident).
 */
export const AUTO_RESTART_AFTER_MS = 4 * 60 * 60 * 1000;

/**
 * @param {{sha: string, committedAt: Date}} head
 * @param {{running: boolean, status?: string, error?: string, startedAt?: Date|null}} proc
 * @param {Date} now
 * @param {number} graceMs
 * @returns {{status: 'pass'|'pending'|'fail', detail: string}}
 */
export function driftVerdict(head, proc, now = new Date(), graceMs = DEPLOY_GRACE_MS) {
  if (!proc.running) {
    return {
      status: 'fail',
      detail: `bharat-server is not online under pm2 (${proc.error ?? proc.status ?? 'unknown'}).`,
    };
  }
  if (!(head.committedAt > proc.startedAt)) {
    return {
      status: 'pass',
      detail: 'bharat-server was started at or after the current HEAD commit.',
    };
  }

  const sha = head.sha.slice(0, 12);
  const behindHrs = ((head.committedAt.getTime() - proc.startedAt.getTime()) / 3_600_000).toFixed(1);
  const undeployedMs = now.getTime() - head.committedAt.getTime();
  const undeployedHrs = (undeployedMs / 3_600_000).toFixed(1);

  // Clock skew or a commit dated in the future would make undeployedMs negative; treat that as
  // "just landed" rather than letting a negative sail past the grace comparison as a finding.
  if (undeployedMs < graceMs) {
    return {
      status: 'pending',
      detail: `HEAD (${sha}) is ${behindHrs}h newer than bharat-server's last restart, but was ` +
              `committed only ${undeployedHrs}h ago — inside the ` +
              `${(graceMs / 3_600_000).toFixed(1)}h deploy grace window. Not a finding yet; ` +
              `restart bharat-server to pick it up.`,
    };
  }

  // Past the grace window the drift is real, but it is also one idempotent pm2 command from
  // fixed — so the verdict reports 'restart' (the caller self-heals and stamps the heartbeat
  // as a success carrying the auto_restarted marker) instead of holding a critical monitor
  // red for the hours until a human runs the same command. Callers that want the old
  // alert-only behaviour treat 'restart' exactly like 'fail'.
  const autoRestart = undeployedMs >= AUTO_RESTART_AFTER_MS;
  return {
    status: autoRestart ? 'restart' : 'fail',
    detail: `HEAD (${sha}, committed ${head.committedAt.toISOString()}) is newer than ` +
            `bharat-server's last restart (${proc.startedAt.toISOString()}) by ${behindHrs}h, ` +
            `and has been undeployed for ${undeployedHrs}h (grace: ` +
            `${(graceMs / 3_600_000).toFixed(1)}h).` +
            (autoRestart ? ' Auto-restart eligible (past 4.0h).' : ' Run: pm2 restart bharat-server.'),
  };
}
