import React from 'react';
import { cn } from '../../lib/utils';

export interface V1PageFrameProps {
  /**
   * Page title in the Dashboard's display font (Rajdhani via `.v1-title-page`).
   * Omit for chrome-only framing — used when a page already renders its own
   * complete v1 header internally, so the two never stack.
   */
  title?: string;
  /** Small uppercase mono label above the title — the Dashboard's saffron kicker idiom. */
  kicker?: string;
  /** Right-aligned header slot (buttons, tabs, filters). */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * The single v1 page chrome. Every route V1Routes mounts renders inside this
 * frame so all pages share DashboardPage's look-and-feel: the Rajdhani display
 * title, the saffron uppercase kicker, and the standard `.v1-page` padding and
 * spacing rhythm (utilities defined in src/index.css's @layer utilities).
 *
 * Pages imported from other generations (v4 command center, v5 desks, v6
 * browser/tracker, v2 settings) already inherit the bridged color theme via
 * AppShell's `.v6-root` wrapper — this frame adds the missing typography and
 * page-header rhythm on top, which is the last visible difference between
 * them and v1-native pages.
 */
export function V1PageFrame({
  title,
  kicker,
  actions,
  children,
  className,
  contentClassName,
}: V1PageFrameProps) {
  const showHeader = Boolean(title || kicker || actions);
  return (
    <div className={cn('v1-page', className)}>
      {showHeader && (
        <header className="v1-header">
          <div className="v1-header-left min-w-0">
            {kicker && (
              <div className="v1-data-label text-orange-500 tracking-[0.2em] mb-1">{kicker}</div>
            )}
            {title && <h1 className="v1-title-page truncate m-0">{title}</h1>}
          </div>
          {actions ? <div className="v1-header-actions shrink-0">{actions}</div> : null}
        </header>
      )}
      <div className={contentClassName}>{children}</div>
    </div>
  );
}

export default V1PageFrame;
