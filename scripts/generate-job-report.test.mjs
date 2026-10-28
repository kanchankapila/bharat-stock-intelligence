import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync, strFromU8 } from 'fflate';

const require = createRequire(import.meta.url);
const { generateJobReport } = require('./generate-job-report.cjs');
const a = require('./job-data-a.cjs');
const { b, p } = require('./job-data-b.cjs');
const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true }); });

describe('job report without the vulnerable xlsx dependency', () => {
  it('writes the same seven worksheets, all job rows and provider references to a valid XLSX archive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsi-report-')); temporary.push(dir);
    const outputPath = join(dir, 'report.xlsx');
    const result = await generateJobReport({ outputPath, now: new Date('2026-10-26T00:00:00Z') });
    expect(result).toMatchObject({ outputPath, jobCount: a.length + b.length + p.length });
    const entries = unzipSync(readFileSync(outputPath));
    const xml = name => strFromU8(entries[name]);
    expect(xml('[Content_Types].xml')).toContain('spreadsheetml.sheet.main+xml');
    const workbook = xml('xl/workbook.xml');
    for (const name of ['All Jobs Summary', 'Intraday', 'Screener Syncs', 'ML and DL', 'Sync and Research', 'PM2 Cron', 'Data Sources']) {
      expect(workbook).toContain(`name="${name}"`);
    }
    expect((workbook.match(/<sheet /g) ?? []).length).toBe(7);
    const summary = xml('xl/worksheets/sheet1.xml');
    expect((summary.match(/<row\b/g) ?? []).length).toBe(a.length + b.length + p.length + 4);
    const strings = xml('xl/sharedStrings.xml');
    for (const job of [...a, ...b, ...p]) expect(strings).toContain(job.name);
    expect(strings).toContain('MoneyControl');
    expect(strings).toContain('26/10/2026');
    expect(summary).toContain('width="28"');
  });

  it('rejects a failed file write instead of reporting a successful export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsi-report-')); temporary.push(dir);
    await expect(generateJobReport({ outputPath: join(dir, 'absent', 'report.xlsx') })).rejects.toThrow();
  });

  it('writes formula-shaped metadata as literal text and escapes XML characters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsi-report-')); temporary.push(dir);
    const outputPath = join(dir, 'literal.xlsx');
    a.push({ ...a[0], name: '=1+1', label: 'A <B> & C' });
    try {
      await generateJobReport({ outputPath });
      const entries = unzipSync(readFileSync(outputPath));
      const strings = strFromU8(entries['xl/sharedStrings.xml']);
      expect(strings).toContain('=1+1');
      expect(strings).toContain('A &lt;B&gt; &amp; C');
      expect(strFromU8(entries['xl/worksheets/sheet1.xml'])).not.toMatch(/<f[ >]/);
    } finally { a.pop(); }
  });
});
