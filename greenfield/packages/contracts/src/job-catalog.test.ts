import { expect, test } from 'vitest';
import { validateCatalog, type JobCatalogEntry } from './job-catalog.js';

function entry(overrides: Partial<JobCatalogEntry>): JobCatalogEntry {
  return {
    jobId: 'job-a',
    description: 'test job',
    timezone: 'Asia/Kolkata',
    dependsOn: [],
    critical: false,
    postconditions: {},
    enabled: true,
    catalogVersion: 'v1',
    ...overrides,
  };
}

test('a clean catalog has no errors', () => {
  const catalog = [
    entry({ jobId: 'a' }),
    entry({ jobId: 'b', dependsOn: ['a'] }),
  ];
  expect(validateCatalog(catalog)).toEqual([]);
});

test('duplicate job ids are rejected', () => {
  const catalog = [entry({ jobId: 'a' }), entry({ jobId: 'a' })];
  const errors = validateCatalog(catalog);
  expect(errors.some((e) => e.reason.includes('duplicate'))).toBe(true);
});

test('a dependency on an unknown job is rejected', () => {
  const catalog = [entry({ jobId: 'a', dependsOn: ['nonexistent'] })];
  const errors = validateCatalog(catalog);
  expect(errors.some((e) => e.reason.includes('unknown job'))).toBe(true);
});

test('a direct self-dependency is rejected', () => {
  const catalog = [entry({ jobId: 'a', dependsOn: ['a'] })];
  const errors = validateCatalog(catalog);
  expect(errors.some((e) => e.reason.includes('depends_on itself'))).toBe(true);
});

test('a dependency cycle (a -> b -> a) is rejected', () => {
  const catalog = [
    entry({ jobId: 'a', dependsOn: ['b'] }),
    entry({ jobId: 'b', dependsOn: ['a'] }),
  ];
  const errors = validateCatalog(catalog);
  expect(errors.some((e) => e.reason.includes('cycle'))).toBe(true);
});
