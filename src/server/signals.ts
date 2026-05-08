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
  const stmt = db.prepare(`
    INSERT INTO signals (symbol, type, entry, target, stopLoss, confidence, reasoning, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
  `);
  stmt.run(
    signal.symbol,
    signal.type,
    signal.entry,
    signal.target,
    signal.stopLoss,
    signal.confidence,
    signal.reasoning
  );
}

export async function updateSignalAccuracy(symbol: string, currentPrice: number) {
  const signals = db.prepare('SELECT * FROM signals WHERE symbol = ? AND status = ?')
    .all(symbol, 'ACTIVE') as Signal[];

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
      const updateStmt = db.prepare(`
        UPDATE signals 
        SET status = ?, result = ?, updatedAt = CURRENT_TIMESTAMP 
        WHERE id = ?
      `);
      updateStmt.run(newStatus, result, signal.id);
    }
  }
}

