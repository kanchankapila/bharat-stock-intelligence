import { z } from "zod";
import db from "../db";
import { router, publicProcedure } from "../trpc";

export const todoRouter = router({
  getTodos: publicProcedure
    .query(() => {
      return db.prepare('SELECT * FROM todos ORDER BY priority DESC, createdAt DESC').all() as any[];
    }),

  addTodo: publicProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).optional().default('PENDING'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM'),
      category: z.string().optional().default('IDEAS'),
    }))
    .mutation(({ input }) => {
      const info = db.prepare(`
        INSERT INTO todos (title, description, status, priority, category)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.title, input.description ?? null, input.status, input.priority, input.category);
      return { id: info.lastInsertRowid };
    }),

  updateTodo: publicProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
      category: z.string().optional(),
    }))
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      const keys = Object.keys(updates);
      if (keys.length === 0) return { success: true };
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => (updates as Record<string, unknown>)[k]);
      db.prepare(`UPDATE todos SET ${setClause}, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...values, id);
      return { success: true };
    }),

  deleteTodo: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(({ input }) => {
      db.prepare('DELETE FROM todos WHERE id = ?').run(input.id);
      return { success: true };
    }),
});
