import { mergeRouters } from "./trpc";

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
import { telegramRouter }     from "./routers/telegram.router";
import { confluenceRouter }   from "./routers/confluence.router";
import { monitorRouter }      from "./routers/monitor.router";
import { agentsRouter }         from "./routers/agents.router";
import { commandCenterRouter }  from "./routers/commandCenter.router";
import { riskRouter }           from "./routers/risk.router";

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
  telegramRouter,
  confluenceRouter,
  monitorRouter,
  agentsRouter,
  commandCenterRouter,
  riskRouter,
);

export type AppRouter = typeof appRouter;
export { router, publicProcedure } from "./trpc";
