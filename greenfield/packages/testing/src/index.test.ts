import { expect, test } from 'vitest';
import { withScratchTransaction } from './index.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

test('withScratchTransaction leaves no trace after rollback', async () => {
  await withScratchTransaction(async (client) => {
    await client.query(
      `INSERT INTO security (symbol, name, exchange, status) VALUES ('ZZZSCRATCH', 'Scratch Co', 'NSE', 'listed')`,
    );
    const { rows } = await client.query('SELECT symbol FROM security WHERE symbol = $1', ['ZZZSCRATCH']);
    expect(rows).toHaveLength(1);
  });

  // New connection, outside the rolled-back transaction: the row must be gone.
  await withScratchTransaction(async (client) => {
    const { rows } = await client.query('SELECT symbol FROM security WHERE symbol = $1', ['ZZZSCRATCH']);
    expect(rows).toHaveLength(0);
  });
});
