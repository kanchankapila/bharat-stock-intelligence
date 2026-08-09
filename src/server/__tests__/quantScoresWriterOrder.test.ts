import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queuesSrc = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
const screenerJobsSrc = readFileSync(join(__dirname, '..', 'jobs', 'screeners.jobs.ts'), 'utf8');

function fnBody(src: string, fnName: string): string {
  const start = src.indexOf(`async function ${fnName}`);
  if (start === -1) throw new Error(`${fnName} not found`);
  // The signature line looks like `async function NAME(...): Promise<{ success: boolean }> {`
  // — the FIRST `{` on the line is inside the `Promise<{...}>` return-type annotation, not the
  // body. The body-opening brace is the LAST `{` on the signature line.
  const firstNewline = src.indexOf('\n', start);
  const sigLine = src.slice(start, firstNewline === -1 ? src.length : firstNewline);
  const braceOnSigLine = sigLine.lastIndexOf('{');
  if (braceOnSigLine === -1) throw new Error(`could not find opening brace for ${fnName}`);
  let depth = 0;
  let i = start + braceOnSigLine;
  let end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return src.slice(start, end);
}

// Finding: quant_scores had three writers. institutional_quant_engine.py (ml-daily-ops,
// 7:30 PM IST) did a full DELETE+re-INSERT and was always clobbered same-night by
// quantScoringService.ts's own upsert (11 PM IST) — its writes never survived to be read.
// multi_factor_scorer.py (also inside ml-daily-ops) claimed in its own comment to depend on
// quantScoringService having already run, but ran 3.5h BEFORE it — always reading yesterday's
// quant factors. See CLAUDE.md / the score-consolidation plan for the full writeup.
describe('quant_scores writer ordering', () => {
  it('ml-daily-ops no longer calls runPython on institutional_quant_engine.py', () => {
    expect(fnBody(queuesSrc, 'processMlDailyOps')).not.toMatch(
      /runPython\(['"]institutional_quant_engine\.py['"]/
    );
  });

  it('ml-daily-ops no longer calls runPython on multi_factor_scorer.py', () => {
    expect(fnBody(queuesSrc, 'processMlDailyOps')).not.toMatch(
      /runPython\(['"]multi_factor_scorer\.py['"]/
    );
  });

  it('ml-daily-ops runs technical_analysis_engine.py in the vacated slot', () => {
    expect(fnBody(queuesSrc, 'processMlDailyOps')).toMatch(
      /runPython\(['"]technical_analysis_engine\.py['"]/
    );
  });

  it('quant-scoring job runs multi_factor_scorer.py after runQuantScoring()', () => {
    const body = fnBody(screenerJobsSrc, 'processQuantScoring');
    const iRun = body.indexOf('runQuantScoring(');
    const iMf = body.search(/runPython\(['"]multi_factor_scorer\.py['"]/);
    expect(iRun).toBeGreaterThan(-1);
    expect(iMf).toBeGreaterThan(-1);
    expect(iMf).toBeGreaterThan(iRun);
  });
});
