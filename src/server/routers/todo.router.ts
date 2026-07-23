import { z } from "zod";
import { dbAll, dbRun } from "../dbAsync";
import { router, protectedProcedure } from "../trpc";

// Every read/write below is scoped to ctx.uid (the verified token owner) — previously this
// router had no ownership concept at all, so any unauthenticated caller could read, edit, or
// delete every todo in the app.
export const todoRouter = router({
  getTodos: protectedProcedure
    .query(async ({ ctx }) => {
      return dbAll<any>('SELECT * FROM todos WHERE "userId" = ? ORDER BY priority DESC, "createdAt" DESC', [ctx.uid]);
    }),

  addTodo: protectedProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).optional().default('PENDING'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM'),
      category: z.string().optional().default('IDEAS'),
    }))
    .mutation(async ({ input, ctx }) => {
      const info = await dbRun(`
        INSERT INTO todos ("userId", title, description, status, priority, category)
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [ctx.uid, input.title, input.description ?? null, input.status, input.priority, input.category]);
      return { id: info.lastInsertRowid };
    }),

  updateTodo: protectedProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
      category: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...updates } = input;
      const keys = Object.keys(updates);
      if (keys.length === 0) return { success: true };
      // keys come only from the fixed zod schema above, never from arbitrary client keys.
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => (updates as Record<string, unknown>)[k]);
      await dbRun(`UPDATE todos SET ${setClause}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ? AND "userId" = ?`,
        [...values, id, ctx.uid]);
      return { success: true };
    }),

  deleteTodo: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await dbRun('DELETE FROM todos WHERE id = ? AND "userId" = ?', [input.id, ctx.uid]);
      return { success: true };
    }),
});
