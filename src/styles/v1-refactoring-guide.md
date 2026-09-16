# V1 Design System — Refactoring Guide for All 63 Pages

## The Transformation Goal

**Before**: Pages have scattered Tailwind colors, inline style maps, inconsistent typography, and mixed patterns
**After**: All pages use the centralized v1-* utility classes from `index.css`

## Three Simple Rules

1. **Replace inline color classes with semantic utility classes**
   - ❌ `text-emerald-400` / `bg-emerald-500/20`
   - ✅ `v1-text-bullish` / `v1-badge-s`

2. **Use v1-* component utilities instead of hand-rolled styles**
   - ❌ `className="px-4 py-2 rounded-lg bg-slate-700/50 border border-slate-600 text-slate-300 hover:bg-slate-600/50"`
   - ✅ `className="v1-btn-secondary"`

3. **Standardize typography with Rajdhani for headers, Space Mono for values**
   - ❌ `<h1 className="text-2xl font-black text-white">`
   - ✅ `<h1 className="v1-title-page">`

---

## Before / After Examples

### Example 1: Page Header (every page uses this pattern)

**BEFORE** (EarningsPage.tsx:60-64):
```tsx
<div className="flex items-center justify-between flex-wrap gap-3">
  <div>
    <h1 className="text-2xl font-black text-white">Earnings Tracker</h1>
    <p className="text-sm text-slate-400 mt-0.5">Q-results, beat/miss analysis and price shockers</p>
  </div>
  {/* ...actions on the right... */}
</div>
```

**AFTER**:
```tsx
<div className="v1-header">
  <div className="v1-header-left">
    <h1 className="v1-title-page">Earnings Tracker</h1>
    <p className="text-sm text-slate-400 mt-0.5">Q-results, beat/miss analysis and price shockers</p>
  </div>
  <div className="v1-header-actions">
    {/* ...actions... */}
  </div>
</div>
```

---

### Example 2: Button Styling

**BEFORE** (EarningsPage.tsx:82-87):
```tsx
<button
  onClick={() => refetch()}
  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/50 text-slate-300 hover:bg-slate-600/50 text-xs transition-colors"
>
  <RefreshCw className="w-3 h-3" /> Refresh
</button>
```

**AFTER**:
```tsx
<button className="v1-btn-secondary text-xs">
  <RefreshCw className="w-3 h-3" /> Refresh
</button>
```

---

### Example 3: Conviction Badge (the most common pattern)

**BEFORE** (BuyRecommendationsPage.tsx:26-31 + 96-98):
```tsx
const CONV = {
  S_ELITE:  { label: 'S', bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  A_HIGH:   { label: 'A', bg: 'bg-sky-500/20',     border: 'border-sky-500/40',     text: 'text-sky-300',     dot: 'bg-sky-400'     },
  B_MEDIUM: { label: 'B', bg: 'bg-amber-500/15',   border: 'border-amber-500/35',   text: 'text-amber-300',   dot: 'bg-amber-400'   },
  C_LOW:    { label: 'C', bg: 'bg-slate-700/40',   border: 'border-slate-600/40',   text: 'text-slate-400',   dot: 'bg-slate-500'   },
} as const;

{/* Later in component: */}
<span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', style.text, style.border)}>
  {style.label}
</span>
```

**AFTER** (no style map needed, logic is implicit):
```tsx
const convictionClass = {
  S_ELITE: 'v1-badge-s',
  A_HIGH: 'v1-badge-a',
  B_MEDIUM: 'v1-badge-b',
  C_LOW: 'v1-badge-c',
}[conviction_level];

<span className={cn('v1-badge', convictionClass)}>
  {conviction_level[0]}
</span>
```

---

### Example 4: Data Value Display

**BEFORE** (mixed classes for data):
```tsx
<div className="text-lg font-semibold text-white">
  {p.livePrice != null ? `₹${p.livePrice.toFixed(0)}` : '—'}
</div>
<span className={cn('text-xs font-medium', pctColor(p.changePercent))}>
  {pctFmt(p.changePercent)}
</span>
```

**AFTER** (semantic classes, Space Mono applied globally):
```tsx
<div className="v1-data-value">
  {p.livePrice != null ? `₹${p.livePrice.toFixed(0)}` : '—'}
</div>
<span className={cn('v1-data-value text-xs', pctColor(p.changePercent))}>
  {pctFmt(p.changePercent)}
</span>
```

---

### Example 5: Input Field

**BEFORE** (EarningsPage.tsx:68-74):
```tsx
<input
  type="text"
  placeholder="Filter Symbol..."
  value={searchSymbol}
  onChange={e => setSearchSymbol(e.target.value)}
  className="pl-9 pr-3 py-1.5 rounded-lg bg-slate-700/50 border border-slate-600 text-slate-200 text-xs focus:outline-none focus:border-emerald-500 w-32"
/>
```

**AFTER**:
```tsx
<input
  type="text"
  placeholder="Filter Symbol..."
  value={searchSymbol}
  onChange={e => setSearchSymbol(e.target.value)}
  className="v1-input w-32 text-xs pl-9"
/>
```

---

### Example 6: Stat Pills (Info Cards)

**BEFORE** (EarningsPage.tsx:93-101):
```tsx
{[
  { label: 'Reporting Today',  value: dashboard.totalResults || dashboard.todayCount || '—', color: 'text-indigo-400',  card: 'v1-card' as const },
  { label: 'Beat Estimates',   value: dashboard.beat || '—',                                  color: 'text-emerald-400', card: 'v1-card-up' as const },
  { label: 'Missed Estimates', value: dashboard.miss || dashboard.missed || '—',              color: 'text-rose-400',    card: 'v1-card-down' as const },
  { label: 'In Line',          value: dashboard.inline || dashboard.neutral || '—',           color: 'text-amber-400',   card: 'v1-card-neutral' as const },
].map((card, i) => (
  <div key={i} className={cn(card.card, 'p-4')}>
    <div className={cn('text-2xl font-black', card.color)}>{card.value}</div>
    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">{card.label}</div>
  </div>
))}
```

**AFTER**:
```tsx
{[
  { label: 'Reporting Today',  value: dashboard.totalResults || '—', cardClass: 'v1-stat-pill' },
  { label: 'Beat Estimates',   value: dashboard.beat || '—',          cardClass: 'v1-stat-pill v1-stat-pill-up' },
  { label: 'Missed Estimates', value: dashboard.miss || '—',          cardClass: 'v1-stat-pill v1-stat-pill-down' },
  { label: 'In Line',          value: dashboard.inline || '—',         cardClass: 'v1-stat-pill v1-stat-pill-neutral' },
].map((card, i) => (
  <div key={i} className={card.cardClass}>
    <div className="v1-data-value v1-text-accent">{card.value}</div>
    <div className="v1-data-label">{card.label}</div>
  </div>
))}
```

---

## Complete Checklist: 63 Pages to Refactor

Remove these patterns from EVERY page:

- [ ] Delete custom style maps (CONV, COLOR, REGIME_COLOR, etc.) — use v1-badge-* instead
- [ ] Replace `text-emerald-400` / `text-rose-400` with `v1-text-bullish` / `v1-text-bearish`
- [ ] Replace hand-rolled buttons with `v1-btn-primary` / `v1-btn-secondary` / `v1-btn-ghost`
- [ ] Replace hand-rolled inputs with `v1-input`
- [ ] Replace `bg-slate-900 border border-slate-700 rounded` with `v1-card`
- [ ] Replace page title classes with `v1-title-page`
- [ ] Replace section headers with `v1-title-section`
- [ ] Replace card titles with `v1-title-card`
- [ ] Use `v1-header` / `v1-header-left` / `v1-header-actions` for page headers
- [ ] Replace grids with `v1-grid`, `v1-grid-2`, `v1-grid-3`, `v1-grid-4`
- [ ] Use `v1-page` for top-level page container
- [ ] Audit text colors: replace all `text-slate-*` with semantic classes (`v1-text-secondary`, `v1-text-muted`)

---

## Strategy: Refactor in Stages

### Stage 1: System Pages (highest traffic)
1. DashboardPage.tsx ✅ (already premium)
2. BuyRecommendationsPage.tsx
3. HighConvictionPage.tsx
4. IndicesPage.tsx

### Stage 2: Intelligence Pages
5. EarningsPage.tsx
6. ScreenerIntelligencePage.tsx
7. SmartMoneyPage.tsx

### Stage 3: Agent/Monitor Pages
8. AgentAuditorPage.tsx
9. AgentStrategistPage.tsx
10. SystemMonitorPage.tsx

### Stage 4: All others
11-63. Remaining pages

Each stage builds on the classes, so later stages will be faster.

---

## Validation Checklist After Refactoring

For each page after refactoring:
- [ ] Run `npx tsc --noEmit` (TypeScript compiles with no errors)
- [ ] Run `npm run dev` and visually inspect the page
- [ ] Check responsive behavior at 640px, 768px, 1024px breakpoints
- [ ] Tab through interactive elements (keyboard focus ring must be visible)
- [ ] Open in browser DevTools, reduce motion: `prefers-reduced-motion: reduce`, verify animations disable
- [ ] Color contrast: text-primary on surface-dark should be 16:1+

---

## Git Commit Message Template

```
refactor: v1 design system unification for [PAGE_NAME]

- Removed custom color maps in favor of v1-badge-* utility classes
- Replaced hand-rolled button styles with v1-btn-primary/secondary/ghost
- Applied v1-* utility classes for consistent typography and spacing
- Standardized page header layout with v1-header component
- No functional changes, styling only
```

---

## FAQ

**Q: Will this break existing functionality?**
A: No. All classes are purely styling. The JSX and logic remain exactly the same.

**Q: Do I need to update component props or state?**
A: No. Only change the `className` attributes.

**Q: What if a page has custom styling it needs?**
A: Extend the v1-* classes with additional Tailwind utilities (e.g., `className="v1-btn-primary w-full"`). Only create new classes if a pattern appears 3+ times across the codebase.

**Q: How long will this take?**
A: ~15 mins per page for simple pages, ~30 mins for complex ones. Parallelizable if multiple people work on it.

**Q: Should I test before committing?**
A: Yes. Visually inspect on desktop and mobile, verify focus states with keyboard tab, check in dark mode.