import React, { useEffect } from 'react';

/**
 * Shared accessibility primitives for the shell chrome.
 *
 * This file exists because the six dashboards coexist behind FOUR different shells -- AppShell
 * (v1), V2AppShell (v2/v3/v4), V5App (v5), V6Shell (v6, the default a fresh visitor lands on) --
 * and this repo's history says a chrome fix applied to one shell reliably fails to reach the
 * others. `.claude/rules/` and the 2026-08-14 shell-parity-audit both record real instances: a
 * screener disclaimer that landed on v5/v6's pages but not the v1/v2/v3/v6-routed page reading
 * the same data, and a nav change whose commit message claimed a mirroring that had not happened.
 *
 * Four copies of the same five-line useEffect is exactly the shape that drifts. Importing one
 * implementation means a future correction cannot silently land in only one shell.
 *
 * The purely visual half of this (the :focus-visible ring, .skip-link's hidden/focused styling)
 * lives in src/index.css, which is the one stylesheet every shell already loads.
 */

/**
 * Close an overlay on Escape. Pointer-only dismissal (backdrop click, an X button) leaves a
 * keyboard user with no way out of an opened drawer.
 *
 * `active` gates the listener so a closed drawer isn't holding a window-level handler.
 */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onEscape(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onEscape]);
}

/**
 * Visually-hidden-until-focused jump to the page's <main>. Must be the first tabbable element in
 * the shell, or it cannot do its job: without it, reaching page content by keyboard means tabbing
 * through the entire sidebar nav (60+ items in some of these shells) on every single page load.
 *
 * Pairs with `id={MAIN_CONTENT_ID}` on the shell's own <main>.
 */
export const MAIN_CONTENT_ID = 'main-content';

export const SkipLink: React.FC = () => (
  <a href={`#${MAIN_CONTENT_ID}`} className="skip-link">Skip to main content</a>
);
