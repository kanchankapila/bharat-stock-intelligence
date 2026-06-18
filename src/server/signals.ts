import { dbAll, dbRun, dbTransaction } from './dbAsync';

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

  await dbRun(`
    INSERT INTO signals (symbol, type, entry, target, "stopLoss", confidence, reasoning, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
  `, [signal.symbol, signal.type, signal.entry, signal.target, signal.stopLoss, signal.confidence, signal.reasoning]);

  await dbRun(`
    INSERT INTO recommendation_log
      (symbol, rec_type, signal_date, generated_at, entry_price, stop_loss,
       target_1, confidence_score, reasoning, source, status, horizon_days)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, 'platform', 'ACTIVE', 15)
    ON CONFLICT DO NOTHING
  `, [signal.symbol, signal.type, today, signal.entry, signal.stopLoss, signal.target, signal.confidence, signal.reasoning]);
}

export async function updateSignalAccuracy(symbol: string, currentPrice: number) {
  const signals = await dbAll<Signal>('SELECT * FROM signals WHERE symbol = ? AND status = ?', [symbol, 'ACTIVE']);

  await dbTransaction(async (tx) => {
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
        await tx.run(`
          UPDATE signals
          SET status = ?, result = ?, "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [newStatus, result, signal.id]);
      }
    }
  });
}

