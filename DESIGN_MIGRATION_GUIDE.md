# Design System Migration Guide

This guide helps migrate components from the old design to the new Claude-inspired design system.

## Quick Reference

### Color Updates

| Old | New | Usage |
|-----|-----|-------|
| `bg-slate-900/50` | `surface-primary` | Card backgrounds |
| `bg-slate-900/70` | `surface-secondary` | Nested containers |
| `border border-white/[0.06]` | `glass-border` | Borders on glass surfaces |
| `border border-slate-800` | `glass-border` | Alternative border |
| `bg-slate-900/50 border border-indigo-500/20` | `surface-primary glass-border glow-accent` | Accent cards |

### Text Updates

| Old | New | Usage |
|-----|-----|-------|
| `text-slate-100` | `text-slate-50` | Primary headings |
| `text-slate-200` | `text-slate-100` | Body text |
| `text-slate-400` | `text-slate-500` or `text-muted` | Secondary text |
| Inline uppercase styles | `text-label` | Labels and headers |

### Spacing Updates

| Old | New |
|-----|-----|
| `p-5` | `p-6` |
| `px-5 py-3.5` | `px-6 py-4` |
| `gap-4` (sections) | `gap-6` or `gap-8` |
| `rounded-2xl` | `rounded-lg` (for cards) |

### Shadow Updates

| Old | New |
|-----|-----|
| `shadow-[0_2px_12px_rgba(0,0,0,0.35)]` | `shadow-sm-soft` |
| `shadow-[0_8px_32px_rgba(0,0,0,0.5)]` | `shadow-md-soft` |
| `shadow-[0_16px_48px_rgba(0,0,0,0.55)]` | `shadow-lg-soft` |

### Glow Effects Updates

| Old | New | When |
|-----|-----|------|
| `glow-accent` | `glow-accent` | Indigo accent (unchanged) |
| None | `glow-accent-strong` | Emphasized indigo |
| `glow-up` | `glow-success` | Success states |
| `glow-down` | `glow-danger` | Error states |

### Animation Updates

| Old | New |
|-----|-----|
| `animate-in fade-in slide-in-from-bottom-4 duration-500` | `animate-fade-in` |
| `animate-pulse` | `animate-pulse-soft` |
| Custom stagger | Use `style={{ animationDelay: '0.Xs' }}` |

## Component Migration Checklist

### Card Components
```tsx
// BEFORE
<div className="bg-slate-900/50 border border-white/[0.06] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.35)]">
  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Title</h3>
  <p className="text-slate-200">{content}</p>
</div>

// AFTER
<Card title="Title" variant="default">
  {content}
</Card>

// OR with custom styling
<div className="surface-primary glass-border rounded-lg p-6 glow-accent">
  <h3 className="text-label">Title</h3>
  <p className="text-slate-100">{content}</p>
</div>
```

### Page Headers
```tsx
// BEFORE
<div>
  <h2 className="text-2xl font-bold text-slate-100">Title</h2>
  <p className="text-slate-400 text-sm mt-1">Description</p>
</div>

// AFTER
<div className="space-y-2">
  <h2 className="text-3xl font-bold text-slate-50 tracking-tight">Title</h2>
  <p className="text-slate-500 text-base">Description</p>
</div>
```

### Navigation Items
```tsx
// BEFORE
<button className="px-3 py-2.5 rounded-lg text-sm font-medium bg-slate-800/50 hover:bg-slate-700 text-slate-300 transition-colors">
  Label
</button>

// AFTER
<button className="px-4 py-3 rounded-lg text-sm font-medium interactive-base bg-slate-800/40 hover:bg-slate-700/50 text-slate-400 hover:text-slate-200">
  Label
</button>
```

### Status Badges
```tsx
// BEFORE
<span className="text-xs px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
  Active
</span>

// AFTER
<div className="px-3 py-1 bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 rounded-full text-xs font-semibold glow-success">
  Active
</div>
```

### Data Tables
```tsx
// BEFORE
<table className="w-full">
  <thead className="border-b border-slate-800 bg-slate-900/80">
    <tr>
      <th className="py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">Header</th>
    </tr>
  </thead>
  <tbody className="divide-y divide-slate-800/50">
    <tr className="hover:bg-slate-800/40">
      <td className="py-3 px-4">Data</td>
    </tr>
  </tbody>
</table>

// AFTER
<table className="w-full">
  <thead className="border-b glass-border bg-slate-900/40">
    <tr>
      <th className="py-4 px-4 text-label">Header</th>
    </tr>
  </thead>
  <tbody className="divide-y divide-slate-800/30">
    <tr className="hover:bg-slate-800/20 interactive-base">
      <td className="py-4 px-4">Data</td>
    </tr>
  </tbody>
</table>
```

### Buttons
```tsx
// BEFORE
<button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-semibold transition-colors">
  Click
</button>

// AFTER
<button className="px-4 py-2.5 bg-indigo-500/12 hover:bg-indigo-500/18 text-indigo-300 rounded-lg text-sm font-semibold interactive-base border glass-border glow-accent">
  Click
</button>
```

### Form Inputs
```tsx
// BEFORE
<input className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 focus:border-indigo-500 focus:outline-none" />

// AFTER
<input className="px-4 py-2.5 surface-primary glass-border rounded-lg text-slate-100 focus-visible:outline-indigo-500 focus-visible:outline-offset-2" />
```

## File-by-File Migration

### `src/index.css` ✓ DONE
- Updated typography base
- Added new color utilities
- Added new shadow utilities
- Added new glow effects
- Added animation keyframes

### `src/v3/AlphaQuantV3.tsx` ✓ DONE
- Updated sidebar styling
- Updated header styling
- Refined spacing

### `src/components/Card.tsx` ✓ DONE
- Added new variants (success, danger)
- Added compact mode
- Improved accessibility

### `src/v3/pages/DashboardPage.tsx` ✓ DONE
- Updated typography
- Added staggered animations
- Improved button styling

### `src/v3/components/widgets/MarketOverviewWidget.tsx` ✓ DONE
- Updated card styling
- Improved glow effects

### `src/v3/pages/TopPicksPage.tsx` ✓ DONE
- Updated header styling
- Updated stat cards
- Updated filter buttons
- Updated table styling

### Files Still Needing Updates

These files should be updated to match the new design system:

1. **TradeCockpitPage.tsx** – Update card styling, buttons, and form inputs
2. **FnoIntelligencePage.tsx** – Update card layouts and spacing
3. **DiscoveryPage.tsx** – Update screener styling
4. **SentimentPage.tsx** – Update chart cards
5. **TopMoversWidget.tsx** – Update list styling
6. **ScreenerWidget.tsx** – Update screener UI
7. **DerivativesIntelligenceWidget.tsx** – Update chart styling
8. **FiiDiiStrip.tsx** – Update strip styling
9. **All `components/v2/*.tsx`** – Update as needed
10. **App.tsx** (legacy v1) – Update basic styling

## Common Patterns

### Animated Stagger
```tsx
{items.map((item, i) => (
  <div key={i} className="animate-slide-up" style={{ animationDelay: `${i * 0.1}s` }}>
    {item}
  </div>
))}
```

### Status Color State
```tsx
const statusColor = isUp ? 'text-emerald-400' : 'text-rose-400';
const statusGlow = isUp ? 'glow-success' : 'glow-danger';

<div className={`${statusGlow} surface-primary glass-border rounded-lg p-6`}>
  <span className={statusColor}>Status</span>
</div>
```

### Interactive Hover State
```tsx
<button className="interactive-base hover:bg-slate-800/40 hover:border-slate-600/20">
  Hover me
</button>
```

### Loading Skeleton
```tsx
<div className="h-20 rounded-lg surface-primary glass-border animate-pulse" />
```

## Testing Checklist

After migrating a component:

- [ ] Test on mobile (responsive)
- [ ] Test keyboard navigation (Tab, Enter, Space)
- [ ] Test color contrast (WCAG AA)
- [ ] Test animations (smooth, no jank)
- [ ] Verify all functionality preserved
- [ ] Check spacing consistency
- [ ] Verify hover/active states work
- [ ] Test on slow 3G (performance)

## Performance Tips

1. **Avoid over-animating** – Use `animate-fade-in` and `animate-slide-up` sparingly
2. **Use `will-change` carefully** – Add only on heavy animations
3. **Lazy load heavy components** – Use React.lazy() for modals, charts
4. **Minimize rerenders** – Use `useMemo` for expensive computations
5. **Hardware acceleration** – Use `transform` instead of `top/left` for animations

## Questions or Issues?

Refer to:
- `DESIGN_SYSTEM.md` – Full design system documentation
- `src/index.css` – All CSS utilities and variables
- Updated component examples above

## Version Control

Track changes with:
```bash
git diff -- src/index.css
git log --oneline -- "*.tsx" | head -20
```
