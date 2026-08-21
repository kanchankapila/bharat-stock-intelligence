/**
 * scripts/lib/deployDriftVerdict.mjs — the deploy-drift grace window.
 *
 * Why this exists: the original check was `if (head.committedAt > proc.startedAt)` with no
 * tolerance at all, so it went red the instant anyone committed and stayed red until the next
 * restart. Measured live 2026-08-21 on the real prod host: 61 failures across 198 runs (31%),
 * on an entry marked `critical: true` in dataQualityChecks.ts. That is red by construction on
 * any active development day, and `.claude/rules/recurring-bugs.md` is explicit that a check
 * which cries wolf on correct data stops being read — which would cost us the real AF-14
 * finding ("server N commits behind HEAD") the check exists for.
 *
 * The grace window must key on how long HEAD has been AHEAD (now - committedAt), never on the
 * commit-vs-restart gap: that gap is frozen the moment the commit lands, so it cannot express
 * "how long has this been sitting undeployed" — the only question separating "mid-session,
 * restart coming" from "a merged fix has been dead for hours".
 */
import { describe, it, expect } from 'vitest';
// Plain .mjs helper — a separate module rather than a guarded block inside the script; see its
// header for why (a guard that mis-evaluated under pm2 would silently disable the monitor).
import { driftVerdict, DEPLOY_GRACE_MS } from '../../../scripts/lib/deployDriftVerdict.mjs';

const HEAD = { sha: 'f21e8d9ac5f4abcd', committedAt: new Date('2026-08-21T14:04:21Z') };
const ago = (from: Date, ms: number) => new Date(from.getTime() - ms);
const after = (from: Date, ms: number) => new Date(from.getTime() + ms);

const online = (startedAt: Date) => ({ running: true, startedAt });

describe('driftVerdict', () => {
  it('passes when the server was restarted at or after HEAD', () => {
    const v = driftVerdict(HEAD, online(after(HEAD.committedAt, 60_000)), new Date());
    expect(v.status).toBe('pass');
  });

  it('passes on an exact tie (restart timestamp === commit timestamp)', () => {
    const v = driftVerdict(HEAD, online(new Date(HEAD.committedAt)), new Date());
    expect(v.status).toBe('pass');
  });

  it('is PENDING, not a finding, for a commit that landed moments ago', () => {
    // The noise case: someone is mid-session and the restart is coming.
    const now = after(HEAD.committedAt, 4 * 60_000);
    const v = driftVerdict(HEAD, online(ago(HEAD.committedAt, 47 * 60_000)), now);
    expect(v.status).toBe('pending');
    expect(v.detail).toContain('grace window');
  });

  it('FAILS once HEAD has been undeployed past the grace window', () => {
    // The real AF-14 case. The live state on 2026-08-21 was this exact shape: f21e8d9 committed
    // 14:04Z against a bharat-server started 13:17Z, still undeployed 4.6h later (well past the
    // 2h grace). 10h is used here purely to make the asserted string unambiguous.
    const now = after(HEAD.committedAt, 10 * 3_600_000);
    const v = driftVerdict(HEAD, online(new Date('2026-08-21T13:17:01.957Z')), now);
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('pm2 restart bharat-server');
    expect(v.detail).toContain('undeployed for 10.0h');
  });

  it('flips from pending to fail exactly at the grace boundary', () => {
    const proc = online(ago(HEAD.committedAt, 60 * 60_000));
    const justInside = after(HEAD.committedAt, DEPLOY_GRACE_MS - 1_000);
    const justOutside = after(HEAD.committedAt, DEPLOY_GRACE_MS + 1_000);
    expect(driftVerdict(HEAD, proc, justInside).status).toBe('pending');
    expect(driftVerdict(HEAD, proc, justOutside).status).toBe('fail');
  });

  it('a stopped server is always a failure, regardless of the grace window', () => {
    // Grace is about an undeployed commit, never about the process being down.
    const now = after(HEAD.committedAt, 60_000);
    const v = driftVerdict(HEAD, { running: false, status: 'stopped' }, now);
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('not online under pm2');
  });

  it('does not let a future-dated commit (clock skew) read as long-undeployed', () => {
    // now - committedAt goes NEGATIVE here. A naive `undeployedMs > graceMs` would be false and
    // land on pending by luck, but a naive `Math.abs(...)` or a flipped comparison would report
    // a large positive age and fire a critical alert on a commit that has not happened yet.
    const now = ago(HEAD.committedAt, 3 * 3_600_000);
    const v = driftVerdict(HEAD, online(ago(HEAD.committedAt, 5 * 3_600_000)), now);
    expect(v.status).toBe('pending');
  });

  it('honours an explicit graceMs override', () => {
    const now = after(HEAD.committedAt, 30 * 60_000);
    const proc = online(ago(HEAD.committedAt, 60 * 60_000));
    expect(driftVerdict(HEAD, proc, now, 60 * 60_000).status).toBe('pending');
    expect(driftVerdict(HEAD, proc, now, 10 * 60_000).status).toBe('fail');
  });

  it('defaults the grace window to 2h', () => {
    expect(DEPLOY_GRACE_MS).toBe(2 * 60 * 60 * 1000);
  });
});
