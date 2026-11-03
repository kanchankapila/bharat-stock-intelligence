import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queuesSource = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');

describe('ml-daily-ops full-universe feature budgets', () => {
  it.each(['sector_global_corr.py', 'hv_features.py'])(
    '%s retains lock-contention headroom',
    (script) => {
      const escaped = script.replace('.', '\\.');
      const match = queuesSource.match(
        new RegExp(`runPython\\('${escaped}', \\[\\], ([^\\n]+)\\)`),
      );

      expect(match, `${script} runPython call not found`).not.toBeNull();
      expect(match![1].trim()).toBe('10 * 60_000');
    },
  );
});
