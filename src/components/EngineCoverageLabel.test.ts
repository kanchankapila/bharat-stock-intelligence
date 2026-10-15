import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('engine coverage labels', () => {
  it('never present the active-engine count over the eight configured slots', () => {
    for (const file of ['CommandCenterDashboard.tsx', 'MCStockInfoPanel.tsx']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/engine_coverage_count\}\/8/);
      expect(source, file).not.toContain("ranker's 8 component engines");
    }
  });
});
