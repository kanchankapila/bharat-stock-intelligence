import { mergeRouters } from "./trpc";
import db from "./db";

// Ensure todos table exists (created before routers load)
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT CHECK(status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')) DEFAULT 'PENDING',
    category TEXT DEFAULT 'IDEAS',
    priority TEXT CHECK(status IN ('LOW', 'MEDIUM', 'HIGH')) DEFAULT 'MEDIUM',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

import { userRouter }         from "./routers/user.router";
import { todoRouter }         from "./routers/todo.router";
import { marketRouter }       from "./routers/market.router";
import { indicesRouter }      from "./routers/indices.router";
import { stocksRouter }       from "./routers/stocks.router";
import { signalsRouter }      from "./routers/signals.router";
import { scoringRouter }      from "./routers/scoring.router";
import { technicalsRouter }   from "./routers/technicals.router";
import { mlRouter }           from "./routers/ml.router";
import { fundamentalsRouter } from "./routers/fundamentals.router";
import { moneycontrolRouter } from "./routers/moneycontrol.router";
import { trendlyneRouter }    from "./routers/trendlyne.router";
import { screenersRouter }    from "./routers/screeners.router";
import { fnoRouter }          from "./routers/fno.router";
import { sentimentRouter }    from "./routers/sentiment.router";
import { miscRouter }         from "./routers/misc.router";
import { researchRouter }     from "./routers/research.router";
import { dlRouter }           from "./routers/dl.router";

export const appRouter = mergeRouters(
  userRouter,
  todoRouter,
  marketRouter,
  indicesRouter,
  stocksRouter,
  signalsRouter,
  scoringRouter,
  technicalsRouter,
  mlRouter,
  fundamentalsRouter,
  moneycontrolRouter,
  trendlyneRouter,
  screenersRouter,
  fnoRouter,
  sentimentRouter,
  miscRouter,
  researchRouter,
  dlRouter,
);

export type AppRouter = typeof appRouter;
export { router, publicProcedure } from "./trpc";
