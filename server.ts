import "dotenv/config";
import express from "express";

import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import * as trpcExpress from "@trpc/server/adapters/express";
import { appRouter } from "./src/server/router";
import { createContext } from "./src/server/context";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { updateSignalAccuracy } from "./src/server/signals";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Background job for signal accuracy tracking (Phase 4)
  setInterval(() => {
    // In a real app, this would iterate through all active signals
    // For demo, we'll just simulate updates for a few stocks
    const symbols = ['RELIANCE', 'TCS', 'HDFCBANK'];
    symbols.forEach(symbol => {
      const mockPrice = 2000 + Math.random() * 2000; // Random price simulation
      updateSignalAccuracy(symbol, mockPrice).catch(console.error);
    });
  }, 30000); // Every 30 seconds

  // JSON body parser
  app.use(express.json());

  // tRPC middleware
  app.use(
    "/api/trpc",
    trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production static files
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
