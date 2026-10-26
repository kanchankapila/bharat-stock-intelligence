import { describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

describe('tRPC error disclosure', () => {
  it('does not expose server stacks or paths in a public HTTP error', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const { publicProcedure, router } = await import('../trpc');
      const appRouter = router({
        fail: publicProcedure.query(() => {
          throw new Error('Internal failure');
        }),
      });
      const response = await fetchRequestHandler({
        endpoint: '/api/trpc',
        req: new Request('http://localhost/api/trpc/fail'),
        router: appRouter,
        createContext: () => ({}) as never,
      });

      expect(response.status).toBe(500);
      const payload = await response.json();
      expect(payload.error.json.data).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
      expect(payload.error.json.data).not.toHaveProperty('stack');
      expect(JSON.stringify(payload)).not.toContain('trpcErrorDisclosure.test.ts');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
