import React from 'react';
import { Outlet } from 'react-router-dom';
import { V7Shell } from './V7Shell';

/**
 * V7Layout: the v7 shell wrapping the flat /v7-* routes registered in V1Routes as a pathless
 * layout route — the shell persists across v7 page navigation exactly like AppShell does for
 * v1, while App.tsx skips the outer AppShell chrome entirely on /v7-* paths (see isV7 there),
 * so exactly one sidebar is ever on screen.
 */
export const V7Layout: React.FC = () => (
  <V7Shell>
    <Outlet />
  </V7Shell>
);

export default V7Layout;
