/**
 * Every sidebar entry must lead to a page that exists, and every page must be reachable.
 *
 * Not hypothetical. `NAV_GROUPS` carried `{ label: 'Switch to V5', id: 'v5' }` from the day the
 * v2-v6 shells were retired (2026-08-31, App.tsx's consolidation) until 2026-09-20: `/v5` had no
 * `<Route>`, so the click fell through V1Routes' `path="/*"` catch-all and rendered a blank page.
 * Nothing failed — a nav id and a route path are two hand-maintained lists in two files with no
 * link between them, which is exactly the shape that drifts silently. Same failure mode as the
 * orphaned `/details` route (its only setter, `setSelectedSymbol`, was never called) found the
 * same week.
 *
 * Immunizes by scanning source rather than by an allowlist of ids, so the NEXT page that ships
 * without a nav entry (or the next nav entry that outlives its route) fails here. V1Routes is the
 * single route table and NAV_GROUPS the single nav table — both feed the desktop sidebar, the
 * mobile drawer and CommandPalette, so one check covers all three surfaces.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const appShell = readFileSync(path.join(SRC, 'components', 'AppShell.tsx'), 'utf8');
const v1Routes = readFileSync(path.join(SRC, 'v1', 'V1Routes.tsx'), 'utf8');

/**
 * Routes that are deliberately NOT sidebar entries, each with the reason it cannot be one.
 * Both remaining entries are `<Navigate replace>` redirects — they have no page to show.
 */
const NON_NAV_ROUTES: Record<string, string> = {
  'buy-recs': 'legacy alias — <Navigate to="/alpha" replace>',
  'alpha-cockpit': 'legacy alias — <Navigate to="/alpha" replace>',
};

function navIds(): string[] {
  const block = appShell.slice(
    appShell.indexOf('const NAV_GROUPS'),
    appShell.indexOf('\n];', appShell.indexOf('const NAV_GROUPS')),
  );
  return [...block.matchAll(/id: '([a-z0-9-]+)'/g)].map((m) => m[1]);
}

function routePaths(): string[] {
  return [...v1Routes.matchAll(/path="\/([a-z0-9-]+)"/g)].map((m) => m[1]);
}

describe('sidebar navigation is complete and every entry resolves', () => {
  it('the scan is not vacuous — it still reads both real tables', () => {
    expect(navIds().length).toBeGreaterThan(60);
    expect(routePaths().length).toBeGreaterThan(60);
  });

  it('every sidebar id has a <Route> (this is the check that would have caught /v5)', () => {
    const routes = new Set(routePaths());
    const dangling = navIds().filter((id) => !routes.has(id));
    expect(
      dangling,
      'A sidebar entry navigates to a path with no <Route> in V1Routes. The click falls ' +
      'through the `path="/*"` catch-all and renders a blank page. Add the route, or remove ' +
      'the nav entry — do not leave a nav id pointing at nothing.',
    ).toEqual([]);
  });

  it('every route is reachable from the sidebar, unless it is a documented redirect', () => {
    const nav = new Set(navIds());
    const unreachable = routePaths().filter((p) => !nav.has(p) && !(p in NON_NAV_ROUTES));
    expect(
      unreachable,
      'A page exists and is lazy-imported in V1Routes but no sidebar entry links it — the ' +
      'orphaned-route class. Add a NAV_GROUPS entry (as /details needed), or add the route to ' +
      'NON_NAV_ROUTES with the reason it cannot be a nav entry.',
    ).toEqual([]);
  });

  it('the retired v5 shell entry has not come back', () => {
    // /v5 stopped existing with the shells; a nav id of 'v5' is a dead link by construction.
    expect(navIds()).not.toContain('v5');
    expect(routePaths()).not.toContain('v5');
  });
});
