import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseChecklistHtml } from '../trendlyneChecklistParser';

const fixtureHtml = readFileSync(
  join(__dirname, 'fixtures', 'trendlyne_checklist_sample.html'),
  'utf-8',
);

describe('parseChecklistHtml', () => {
  test('parses a real checklist response into the expected shape', () => {
    const result = parseChecklistHtml(fixtureHtml);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(23);
    expect(result!.yesCount).toBe(17);
    expect(result!.score).toBeCloseTo(73.9, 1);
    expect(Object.keys(result!.checklistData).sort()).toEqual(
      ['Financials', 'Ownership', 'Peer Comparison', 'Value And Momentum'].sort(),
    );
    expect(result!.checklistData['Financials']).toHaveLength(8);
    expect(result!.checklistData['Financials'].every(i => i.answer)).toBe(true);
    expect(result!.checklistData['Peer Comparison']).toHaveLength(3);
    expect(result!.checklistData['Peer Comparison'].filter(i => i.answer)).toHaveLength(2);
  });

  test('decodes HTML entities in question text', () => {
    const result = parseChecklistHtml(fixtureHtml);
    const allQuestions = Object.values(result!.checklistData).flat().map(i => i.question);
    expect(allQuestions.some(q => q.includes("Company's sales growth is better"))).toBe(true);
  });

  test('extracts a specific known question correctly', () => {
    const result = parseChecklistHtml(fixtureHtml);
    const item = result!.checklistData['Financials'][0];
    expect(item.question).toBe('Company has seen consistent profit growth in the last eight quarters?');
    expect(item.answer).toBe(true);
  });

  test('returns null for HTML with no checklist content', () => {
    expect(parseChecklistHtml('<div class="tl-checklist"></div>')).toBeNull();
    expect(parseChecklistHtml('<html><body>Not found</body></html>')).toBeNull();
  });
});
