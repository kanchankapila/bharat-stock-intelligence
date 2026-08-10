import type { ComponentType, CSSProperties } from 'react';
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
  Crosshair, Search, History, PieChart, Bookmark, Users, Globe, CheckCircle2,
  Star, TrendingUp, Radio, Settings2, Briefcase, Calendar, Sparkles,
  FlaskConical, Layers, MonitorDot, MessageSquare, Gauge,
  Settings, Flame, BookOpen, BarChart3, Cpu,
} from 'lucide-react';

// V6Shell's nav render passes `style` (theme-token colors) alongside `className` -- lucide-react
// icons accept both, so the type needs to say so or every themed icon usage fails tsc.
export interface NavItem { icon: ComponentType<{ className?: string; style?: CSSProperties }>; label: string; id: string; }
export interface NavGroup { label: string; items: NavItem[]; }

/**
 * Nav source of truth for V6Shell.tsx. Extracted
 * 2026-08-07 specifically to close a recurring bug class: the 2026-08-04 nav restructuring (see
 * the section-header history below) landed in AppShell.tsx with a comment claiming it was
 * mirrored into V2AppShell.tsx -- it wasn't, so the fix never reached the default (v2/v3) shell
 * most users actually saw. AppShell.tsx and V2AppShell.tsx still keep their own local copies
 * (not yet migrated onto this file) -- and as of Phase 2, this file's content has deliberately
 * DIVERGED from theirs, not just duplicated it: v6 shows one consolidated "Signal Review" entry
 * where the older shells still show three separate pages, and a "Risk" entry the older shells
 * don't have a nav link for (though the /risk route itself works everywhere -- see App.tsx).
 * Migrating AppShell.tsx/V2AppShell.tsx onto a shared file needs a parameterized version of this
 * one (which items differ per shell), not a straight import, now that the difference is
 * intentional rather than accidental drift. Every id here must have a real, working route in
 * App.tsx's shared <Routes> tree -- verified against that file directly, not assumed.
 *
 * The navigation separates canonical picks, screeners, analysis, and model diagnostics so
 * independent scores are not presented as equivalent to unified_recommendations. Older shells
 * intentionally keep their own version-specific groups; do not replace them with this array
 * without preserving those differences.
 * "Top Picks" is capped at exactly the 2 pages worth trusting for a real decision -- Alpha
 * (CommandCenterDashboard) and Buy Recs/Alpha Cockpit all ran the literal same query
 * (getBuyRecommendations -> unified_recommendations) under three different names; the latter two
 * now redirect to /alpha in App.tsx rather than exist as separate nav entries. Top Rated moved
 * out -- it renders stock_scores only (one INPUT to the canonical blend, not the merge itself)
 * and already carries its own LegacyScoreBanner -- it belongs beside Strategy/Strategy Builder in
 * Alternative Screens, not implying equal standing with the canonical page.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Markets',
    items: [
      { icon: Gauge,           label: 'Market Command',     id: 'market-command'         },
      { icon: Search,          label: 'Stock Intelligence', id: 'stock-intelligence-hub' },
      { icon: LayoutDashboard, label: 'Dashboard',          id: 'dashboard'              },
      { icon: Calendar,        label: 'Pre-Market',         id: 'premarket'              },
      { icon: BarChart2,       label: 'Indices',            id: 'indices'                },
      { icon: Activity,        label: 'Market Map',         id: 'market-map'             },
      { icon: Flame,           label: 'Intraday',           id: 'intraday'               },
    ],
  },
  {
    label: 'Top Picks',
    items: [
      { icon: Zap,      label: 'Alpha',         id: 'alpha'         },
      { icon: Sparkles, label: 'Trade Cockpit', id: 'trade-cockpit' },
    ],
  },
  {
    label: 'Screeners',
    items: [
      { icon: Filter,          label: 'Screener Browser', id: 'screener'          },
      { icon: Flame,           label: 'Live Screener',    id: 'live-screener'     },
      { icon: BarChart3,       label: 'EOD Screener',     id: 'eod-screener'      },
      { icon: Star,            label: 'Premium Screens',  id: 'premium-screeners' },
      { icon: Zap,             label: 'Trendlyne',        id: 'trendlyne'         },
      { icon: Search,          label: 'Discover',         id: 'discover'          },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { icon: Target,    label: 'F&O Intel',    id: 'fno-scanners' },
      { icon: TrendingUp, label: 'Options',     id: 'options'      },
      { icon: Briefcase,  label: 'Smart Money', id: 'smart-money'  },
      { icon: Users,      label: 'Money Flow',  id: 'money-flow'   },
      { icon: Calendar,   label: 'Earnings',    id: 'earnings'     },
      { icon: Activity,   label: 'Sentiment',   id: 'sentiment'    },
    ],
  },
  {
    label: 'Models & Signals',
    items: [
      { icon: Crosshair,  label: 'Best Picks',      id: 'best-picks'            },
      { icon: Trophy,     label: 'Top Rated',       id: 'top-rated'             },
      { icon: BookOpen,   label: 'Strategy',        id: 'strategy'              },
      { icon: Settings2,  label: 'Strategy Builder', id: 'strategy-builder'      },
      { icon: Layers,     label: 'Screener Intel',  id: 'screener-intelligence' },
      // SignalReviewPage consolidates Signal Ledger + Report Card + Queue stats
      { icon: Radio,      label: 'Signal Review',   id: 'signal-tracking'       },
      { icon: History,    label: 'Backtest',        id: 'backtest'              },
    ],
  },
  {
    label: 'Portfolio',
    items: [
      { icon: PieChart,   label: 'Portfolio',  id: 'portfolio'  },
      { icon: Bookmark,   label: 'Watchlist',  id: 'watchlist'  },
      { icon: TrendingUp, label: 'Risk',       id: 'risk'       },
      { icon: Users,      label: 'Superstars', id: 'superstars' },
    ],
  },
  {
    label: 'AI & Research',
    items: [
      { icon: MessageSquare, label: 'AI Chat',        id: 'chat'                 },
      { icon: Cpu,           label: 'Data Scientist', id: 'agent-data-scientist' },
      { icon: Target,        label: 'Strategist',    id: 'agent-strategist'     },
      { icon: FlaskConical,  label: 'Research',      id: 'research'             },
    ],
  },
  {
    label: 'Tools',
    items: [
      { icon: Globe,         label: 'Economics',       id: 'economics'    },
      { icon: CheckCircle2,  label: 'ToDo',            id: 'todo'         },
      { icon: MonitorDot,    label: 'System Monitor',  id: 'monitor'      },
      { icon: Settings,      label: 'Settings',        id: 'settings'     },
      { icon: Star,          label: 'My Profile',      id: 'profile'      },
    ],
  },
];
