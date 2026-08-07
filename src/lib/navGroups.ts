import type { ComponentType } from 'react';
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
  Crosshair, Search, History, PieChart, Bookmark, Users, Globe, CheckCircle2,
  Star, TrendingUp, Radio, Settings2, Briefcase, Calendar, Sparkles,
  FlaskConical, Layers, MonitorDot, ChartLine, MessageSquare, Gauge, FileDown,
  Settings, Flame,
} from 'lucide-react';

export interface NavItem { icon: ComponentType<{ className?: string }>; label: string; id: string; }
export interface NavGroup { label: string; items: NavItem[]; }

/**
 * Single source of truth for the app's nav, shared by every shell (AppShell.tsx, V2AppShell.tsx,
 * V6Shell.tsx, and any future one). Extracted 2026-08-07 specifically to close a recurring bug
 * class: the 2026-08-04 nav restructuring (see the section-header history below) landed in
 * AppShell.tsx with a comment claiming it was mirrored into V2AppShell.tsx -- it wasn't, so the
 * fix never reached the default (v2/v3) shell most users actually saw. Found and fixed once on
 * 2026-08-07; a THIRD shell being added the same week made it obvious this needed to stop being
 * two independently-maintained copies. Every id here must have a real, working route in App.tsx's
 * shared <Routes> tree -- verified against that file directly, not assumed.
 *
 * Nav restructuring history (2026-08-04 UX audit follow-up): the old flat 18-item "Intelligence"
 * group mixed the canonical cross-engine ranking (unified_recommendations, via unified_ranker.py
 * -- see CLAUDE.md's "Scoring Authority" section) with several independent/alternative scoring
 * models and pure diagnostics tools, with no visual signal for which to trust first. Split into
 * three groups by what each tab actually is, verified against each page's own backend query and
 * on-page copy (several -- Best Picks, Strategy -- already self-label "independent scoring model,
 * not the unified cross-engine model" in their own UI; that framing is now reflected in the nav
 * itself instead of only showing up once you've already opened the page):
 *   - "Top Picks": canonical, unified_recommendations-backed. Placed right after Markets.
 *   - "Alternative Screens": independent scoring models -- a different lens, not a duplicate.
 *   - "Signal Tools": logs/diagnostics/research, not ranked "buy this" lists at all.
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
      { icon: Gauge,           label: 'Market Command',     id: 'market-command'        },
      { icon: Search,          label: 'Stock Intelligence', id: 'stock-intelligence-hub' },
      { icon: LayoutDashboard, label: 'Dashboard',  id: 'dashboard'   },
      { icon: BarChart2,       label: 'Indices',    id: 'indices'     },
      { icon: Activity,        label: 'Market Map', id: 'market-map'  },
      { icon: Flame,           label: 'Intraday',   id: 'intraday'    },
    ],
  },
  {
    label: 'Top Picks',
    items: [
      { icon: Zap,        label: 'Alpha',         id: 'alpha'         },
      { icon: Sparkles,   label: 'Trade Cockpit', id: 'trade-cockpit' },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { icon: Filter,  label: 'Screener',   id: 'screener'    },
      { icon: Filter,  label: 'Live Screener', id: 'live-screener' },
      { icon: Filter,  label: 'EOD Screener',  id: 'eod-screener'  },
      { icon: Target,  label: 'F&O Intel',  id: 'fno-scanners'},
      { icon: TrendingUp, label: 'Options Intel', id: 'options' },
      { icon: Zap,     label: 'Trendlyne',  id: 'trendlyne'   },
      { icon: Star,    label: 'Premium Screeners', id: 'premium-screeners' },
      { icon: Search,     label: 'Discover',    id: 'discover'    },
      { icon: Briefcase,  label: 'Smart Money', id: 'smart-money' },
      { icon: Users,      label: 'Money Flow',  id: 'money-flow'  },
      { icon: Calendar,   label: 'Earnings',    id: 'earnings'    },
    ],
  },
  {
    label: 'Alternative Screens',
    items: [
      { icon: Crosshair, label: 'Best Picks',           id: 'best-picks'            },
      { icon: Trophy,    label: 'Top Rated',            id: 'top-rated'             },
      { icon: Star,      label: 'Strategy',             id: 'strategy'              },
      { icon: Target,    label: 'Strategy Builder',     id: 'strategy-builder'      },
      { icon: Layers,    label: 'Signal Intel',         id: 'signal-intelligence'   },
      { icon: BarChart2, label: 'Screener Intel',       id: 'screener-intelligence' },
      { icon: Zap,       label: 'Early Spotter',        id: 'early-spotter'         },
      { icon: Zap,       label: "Today's Picks",        id: 'todays-picks'          },
    ],
  },
  {
    label: 'Signal Tools',
    items: [
      { icon: Radio,        label: 'Signal Ledger',      id: 'signal-tracking'    },
      { icon: Radio,        label: 'Signals',            id: 'signals'            },
      { icon: ChartLine,    label: 'Signal Report Card', id: 'signal-report-card' },
      { icon: Activity,     label: 'Sentiment',          id: 'sentiment'          },
      { icon: History,      label: 'Backtest',           id: 'backtest'           },
      { icon: Settings2,    label: 'ML Builder',         id: 'builder'            },
      { icon: FlaskConical, label: 'Research',           id: 'research'           },
    ],
  },
  {
    label: 'Portfolio',
    items: [
      { icon: PieChart,  label: 'Portfolio',  id: 'portfolio'  },
      { icon: Bookmark,  label: 'Watchlist',  id: 'watchlist'  },
      { icon: Users,     label: 'Superstars', id: 'superstars' },
      { icon: Star,      label: 'My Profile', id: 'profile'    },
    ],
  },
  {
    label: 'Agent Intelligence',
    items: [
      { icon: BarChart2,   label: 'Data Scientist', id: 'agent-data-scientist' },
      { icon: Target,      label: 'Strategist',     id: 'agent-strategist'     },
      { icon: Activity,    label: 'Auditor',        id: 'agent-auditor'        },
      { icon: Settings2,   label: 'Optimizer',      id: 'agent-optimizer'      },
    ],
  },
  {
    label: 'Tools',
    items: [
      { icon: MessageSquare, label: 'AI Chat',    id: 'chat'      },
      { icon: Globe,         label: 'Economics',  id: 'economics' },
      { icon: CheckCircle2,  label: 'ToDo',       id: 'todo'      },
      { icon: MonitorDot,    label: 'System Monitor', id: 'monitor'   },
      { icon: Calendar,      label: 'Job Console',    id: 'jobs'      },
      { icon: FileDown,      label: 'Export Portfolio', id: 'export-picks' },
      { icon: Settings,      label: 'Settings',   id: 'settings'  },
    ],
  },
];
