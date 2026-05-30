import db from './db';

export interface Signal {
  id?: number;
  symbol: string;
  type: "BUY" | "SELL" | "HOLD";
  entry: number;
  target: number;
  stopLoss: number;
  confidence: number;
  reasoning: string;
  status: "ACTIVE" | "COMPLETED" | "EXPIRED" | "FAILED";
  createdAt: string;
  updatedAt: string;
  result?: "PROFIT" | "LOSS" | "NEUTRAL";
}

export async function createSignal(signal: Omit<Signal, "id" | "createdAt" | "updatedAt" | "status">) {
  const today = new Date().toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO signals (symbol, type, entry, target, stopLoss, confidence, reasoning, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
  `).run(signal.symbol, signal.type, signal.entry, signal.target, signal.stopLoss, signal.confidence, signal.reasoning);

  db.prepare(`
    INSERT INTO recommendation_log
      (symbol, rec_type, signal_date, generated_at, entry_price, stop_loss,
       target_1, confidence_score, reasoning, source, status, horizon_days)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, 'platform', 'ACTIVE', 15)
    ON CONFLICT DO NOTHING
  `).run(signal.symbol, signal.type, today, signal.entry, signal.stopLoss, signal.target, signal.confidence, signal.reasoning);
}

export async function updateSignalAccuracy(symbol: string, currentPrice: number) {
  const signals = db.prepare('SELECT * FROM signals WHERE symbol = ? AND status = ?')
    .all(symbol, 'ACTIVE') as Signal[];

  const updateStmt = db.prepare(`
    UPDATE signals
    SET status = ?, result = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const runUpdates = db.transaction(() => {
    for (const signal of signals) {
      let newStatus = signal.status;
      let result = signal.result;

      if (signal.type === "BUY") {
        if (currentPrice >= signal.target) {
          newStatus = "COMPLETED";
          result = "PROFIT";
        } else if (currentPrice <= signal.stopLoss) {
          newStatus = "FAILED";
          result = "LOSS";
        }
      } else if (signal.type === "SELL") {
        if (currentPrice <= signal.target) {
          newStatus = "COMPLETED";
          result = "PROFIT";
        } else if (currentPrice >= signal.stopLoss) {
          newStatus = "FAILED";
          result = "LOSS";
        }
      }

      if (newStatus !== "ACTIVE") {
        updateStmt.run(newStatus, result, signal.id);
      }
    }
  });

  runUpdates();
}

