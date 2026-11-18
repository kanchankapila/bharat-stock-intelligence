import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs gate script
import { unaccepted } from '../securityCheck.mjs';

const adv = (id: string) => ({ source: 1, title: 't', url: `https://github.com/advisories/${id}` });
const audit = (...ids: string[]) => ({ vulnerabilities: { pkg: { via: ids.map(adv) }, dep: { via: ['pkg'] } } });
const accepted = [{ id: 'GHSA-aaaa', until: '2026-12-17', why: 'x' }];

describe('security gate', () => {
  it('passes an accepted advisory and fails any other, with no string-via noise', () => {
    expect(unaccepted(audit('GHSA-aaaa'), accepted, '2026-11-17')).toEqual([]);
    expect(unaccepted(audit('GHSA-aaaa', 'GHSA-bbbb'), accepted, '2026-11-17')).toHaveLength(1);
  });
  it('an expired exception fails again', () => {
    expect(unaccepted(audit('GHSA-aaaa'), accepted, '2026-12-18')).toHaveLength(1);
  });
});
