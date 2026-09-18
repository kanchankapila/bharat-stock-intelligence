import type { Variants } from 'motion/react';

// ─── Layout & Entrance ─────────────────────────────────────────────────

export const fadeInUp: Variants = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
  exit:    { opacity: 0, y: -10, transition: { duration: 0.2, ease: 'easeIn' } },
};

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.3, ease: 'easeOut' } },
  exit:    { opacity: 0, transition: { duration: 0.2, ease: 'easeIn' } },
};

export const slideInFromLeft: Variants = {
  initial: { opacity: 0, x: -20 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.3, ease: 'easeOut' } },
  exit:    { opacity: 0, x: 20, transition: { duration: 0.2, ease: 'easeIn' } },
};

export const staggerContainer = (
  delayChildren = 0.05,
  startDelay = 0,
): Variants => ({
  initial: {},
  animate: {
    transition: {
      staggerChildren: delayChildren,
      delayChildren: startDelay,
    },
  },
  exit: {},
});

export const cardEntrance = (index = 0): Variants => ({
  initial: { opacity: 0, y: 20 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      delay: index * 0.04,
      type: 'spring',
      stiffness: 260,
      damping: 20,
    },
  },
  exit: { opacity: 0, y: -10 },
});

export const expandDown = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: { duration: 0.3, ease: 'easeOut' } },
  exit:    { height: 0, opacity: 0, transition: { duration: 0.2, ease: 'easeIn' } },
};

// ─── Micro-interactions ──────────────────────────────────────────────────

export const scaleTap = {
  whileTap: { scale: 0.97 },
  transition: { type: 'spring', stiffness: 400, damping: 25 },
};

export const scaleHover = {
  whileHover: { scale: 1.02 },
  transition: { type: 'spring', stiffness: 400, damping: 25 },
};

export const rotateChevron = {
  open: { rotate: 180, transition: { duration: 0.2 } },
  closed: { rotate: 0, transition: { duration: 0.2 } },
};

// ─── Price / Value Animations ────────────────────────────────────────────

export const priceSpring = {
  type: 'spring' as const,
  stiffness: 300,
  damping: 25,
};

export const pulseSpring = {
  type: 'spring' as const,
  stiffness: 400,
  damping: 20,
};

// ─── Tab / Panel Transitions ────────────────────────────────────────────

export const tabPanelTransition = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
  exit:    { opacity: 0, y: -10, transition: { duration: 0.2, ease: 'easeIn' } },
};

export const drawerSlide = {
  initial: { x: '100%' },
  animate: { x: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } },
  exit:    { x: '100%', transition: { type: 'spring', stiffness: 300, damping: 25 } },
};

export const backdropFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit:    { opacity: 0, transition: { duration: 0.2 } },
};

// ─── Chart Element Animations ───────────────────────────────────────────

export const barGrow = (delay = 0) => ({
  initial: { scaleY: 0, transformOrigin: 'bottom' },
  animate: { scaleY: 1, transition: { duration: 0.6, ease: 'easeOut', delay } },
  exit:    { scaleY: 0, transition: { duration: 0.3, ease: 'easeIn' } },
});

export const pathDraw = {
  initial: { pathLength: 0, opacity: 0 },
  animate: { pathLength: 1, opacity: 1, transition: { duration: 1.2, ease: 'easeInOut' } },
  exit:    { pathLength: 0, opacity: 0, transition: { duration: 0.5 } },
};

export const countUp = (from = 0, to = 100, duration = 1.5) => ({
  initial: { opacity: 0, y: 10 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration, ease: 'easeOut' },
  },
});

// ─── Shared spring config ───────────────────────────────────────────────

export const SPRING_SMOOTH = { type: 'spring' as const, stiffness: 260, damping: 20 };
export const SPRING_BOUNCE = { type: 'spring' as const, stiffness: 400, damping: 15 };
