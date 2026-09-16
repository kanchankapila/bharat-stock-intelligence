import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';

const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

// No authorization header -> protectedProcedure's verifyIdToken must reject.
const anonCaller = createCallerFactory(appRouter)({ req: { headers: {} } } as any);

async function errorCodeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'NO_ERROR';
  } catch (e) {
    return e instanceof TRPCError ? e.code : `NON_TRPC:${(e as Error).name}`;
  }
}

describe('syncUser requires a verified token', () => {
  // Until 2026-08-22 syncUser was a publicProcedure taking a client-supplied `id`, so an
  // unauthenticated caller could overwrite ANY user's row (email/name/photoURL) by posting
  // that user's Firebase uid. Every sibling in user.router.ts already derived ctx.uid from
  // the verified token; this one did not.
  //
  // These assert UNAUTHORIZED specifically, not merely "it threw". A bare rejects.toThrow()
  // passes against the vulnerable code too -- zod rejects the now-absent `id` with
  // BAD_REQUEST, which looks identical to a caller. Verified: the first version of this test
  // did exactly that and passed the negative control.
  it('rejects an unauthenticated call with UNAUTHORIZED, not a validation error', async () => {
    expect(await errorCodeOf(anonCaller.syncUser({
      email: 'attacker@example.com',
      name: 'attacker',
      photoURL: null,
    }))).toBe('UNAUTHORIZED');
  });

  it('rejects a spoofed `id` with UNAUTHORIZED — auth is checked before input shape', async () => {
    expect(await errorCodeOf(anonCaller.syncUser({
      id: 'some-other-users-uid',
      email: 'attacker@example.com',
      name: 'attacker',
      photoURL: null,
    } as any))).toBe('UNAUTHORIZED');
  });
});
