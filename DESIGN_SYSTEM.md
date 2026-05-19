# Claude Design System – AlphaQuant V3

A modern, refined design system based on Claude design principles. Clean typography, minimal visual noise, and refined interactions.

## 🎨 Design Principles

1. **Clarity First** – Clear information hierarchy with refined typography
2. **Minimal Friction** – Smooth transitions, predictable interactions
3. **Refined Elegance** – Subtle colors, careful use of depth and contrast
4. **Accessibility** – WCAG AA compliant, keyboard navigation support
5. **Performance** – Hardware-accelerated transitions, optimized rendering

## 📐 Typography

### Font Stack
- **Sans-serif**: Inter (system fallback: ui-sans-serif)
- **Monospace**: JetBrains Mono (system fallback: ui-monospace)

### Text Utilities

| Class | Usage | Example |
|-------|-------|---------|
| `text-label` | Uppercase labels | Card titles, section headers |
| `text-label-active` | Active state labels | Selected nav items |
| `text-caption` | Small metadata | Timestamps, secondary info |
| `text-muted` | Reduced emphasis | Descriptions, placeholder text |

### Font Sizes & Weights

```
h1: text-3xl font-bold (page titles)
h2: text-2xl font-bold (section titles)
h3: text-lg font-semibold (subsection)
label: text-xs font-semibold uppercase
body: text-sm/base font-normal
caption: text-xs font-normal
```

## 🎭 Color System

### Background Palette
- **slate-950**: Primary background
- **slate-900/60**: Elevated surfaces (sidebar, header)
- **slate-900/40**: Surface primary (cards, containers)
- **slate-800/30**: Surface secondary (nested areas)
- **slate-700/20**: Surface tertiary (accent areas)

### Text Colors
- **slate-50**: Primary text (headings)
- **slate-100**: Body text
- **slate-400**: Secondary text
- **slate-500**: Tertiary text (captions)

### Accent Colors
- **indigo-400/500**: Primary accent (active states)
- **emerald-500**: Success/positive
- **rose-500**: Danger/negative
- **amber-500**: Warning/attention
- **cyan-400**: Highlights

## 🪟 Surface Utilities

### Glass Effect (Frosted Glass)
```tsx
// Subtle glass
<div className="glass">...</div>

// Strong glass (header, modals)
<div className="glass-strong">...</div>

// Glass border only
<div className="glass-border">...</div>
```

### Surface Layers
```tsx
// Primary surface (cards, containers)
<div className="surface-primary">...</div>

// Secondary surface (nested containers)
<div className="surface-secondary">...</div>

// Tertiary surface (minimal emphasis)
<div className="surface-tertiary">...</div>
```

### Shadow System

| Class | Purpose |
|-------|---------|
| `shadow-sm-soft` | Subtle elevation |
| `shadow-md-soft` | Medium elevation |
| `shadow-lg-soft` | Strong elevation |

## ✨ Glow Effects

### Accent Glow (Indigo)
```tsx
<div className="glow-accent">...</div>           // Subtle
<div className="glow-accent-strong">...</div>    // Emphasized
```

### Success Glow (Emerald)
```tsx
<div className="glow-success">...</div>
<div className="glow-success-strong">...</div>
```

### Danger Glow (Rose)
```tsx
<div className="glow-danger">...</div>
<div className="glow-danger-strong">...</div>
```

## 📦 Component Patterns

### Card Component

**Basic Card**
```tsx
<Card title="Market Data" icon={BarChart2}>
  {children}
</Card>
```

**Card Variants**
```tsx
// Subtle
<Card variant="default">...</Card>

// Elevated with shadow
<Card variant="elevated">...</Card>

// With accent border
<Card variant="accent">...</Card>

// Success state
<Card variant="success">...</Card>

// Error state
<Card variant="danger">...</Card>

// Minimal
<Card variant="ghost">...</Card>
```

**Compact Card**
```tsx
<Card title="Data" compact>
  {children}
</Card>
```

### Button States

**Interactive Base**
```tsx
// All interactive elements
<button className="interactive-base interactive-hover interactive-active">
  Click me
</button>
```

### Navigation Items

```tsx
<button className={cn(
  'px-4 py-3 rounded-lg text-sm font-medium interactive-base',
  isActive 
    ? 'bg-indigo-500/12 text-indigo-300 glow-accent-strong'
    : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
)}>
  {label}
</button>
```

## 🎬 Animations

### Fade In
```tsx
<div className="animate-fade-in">...</div>
```

### Slide Up
```tsx
<div className="animate-slide-up" style={{ animationDelay: '0.1s' }}>...</div>
```

### Soft Pulse
```tsx
<div className="animate-pulse-soft">...</div>
```

### Staggered Animations
```tsx
{items.map((item, i) => (
  <div key={i} className="animate-slide-up" style={{ animationDelay: `${i * 0.1}s` }}>
    {item}
  </div>
))}
```

## 🧩 Layout System

### Spacing Scale
```
xs: 0.5rem (8px)
sm: 1rem (16px)
md: 1.5rem (24px)
lg: 2rem (32px)
xl: 2.5rem (40px)
2xl: 3rem (48px)
```

### Sidebar Layout
```tsx
<div className="flex h-screen bg-slate-950">
  {/* Sidebar: w-64 */}
  <aside className="w-64 bg-slate-900/60 backdrop-blur border-r glass-border">
    {/* Content */}
  </aside>
  
  {/* Main: flex-1 */}
  <main className="flex-1 flex flex-col">
    {/* Header */}
    {/* Content */}
  </main>
</div>
```

### Content Padding
```
Page content: p-8 (32px)
Card padding: p-6 (24px) or p-4 (compact)
Section gap: gap-8 (32px)
Element gap: gap-4 (16px)
```

## 🎯 Interactive States

### Hover State
```tsx
className="hover:bg-slate-800/40 hover:border-slate-600/20"
```

### Active State
```tsx
className="bg-indigo-500/12 text-indigo-300 glow-accent-strong"
```

### Focus State
```tsx
// Automatic from :focus-visible in CSS
outline: 2px solid rgba(99, 102, 241, 0.5)
outline-offset: 2px
```

## 🔄 Transitions

All transitions use `duration-200 ease-out` by default via `interactive-base`:
```tsx
className="interactive-base"
```

Override as needed:
```tsx
className="transition-all duration-300 ease-in-out"
```

## 📱 Responsive Design

### Grid Layouts
```tsx
// Dashboard grid
<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
  <div className="lg:col-span-2">Main</div>
  <div className="lg:col-span-1">Side</div>
</div>
```

### Mobile-First
- Default: single column
- `lg:`: desktop layout (1024px+)
- Maintain readable line lengths on mobile

## ♿ Accessibility

### Keyboard Navigation
- All interactive elements: `focus-visible` ring
- Buttons support Enter/Space keys
- Tab order follows visual flow
- Focus visible outline: `2px solid rgba(99, 102, 241, 0.5)`

### Color Contrast
- Text on backgrounds: WCAG AA compliant (4.5:1 minimum)
- Interactive elements: clearly distinct
- No information conveyed by color alone

### ARIA Labels
```tsx
<button 
  aria-label="Close dialog"
  onClick={handleClose}
>
  ×
</button>
```

## 🎨 Component Examples

### Market Data Card
```tsx
<Card 
  title="Market Overview" 
  icon={BarChart2}
  variant="elevated"
>
  <div className="space-y-3">
    <div className="flex items-center justify-between">
      <span className="text-muted">NIFTY 50</span>
      <span className="font-semibold text-emerald-400">+2.5%</span>
    </div>
  </div>
</Card>
```

### Navigation Item
```tsx
<button
  onClick={() => setActive('dashboard')}
  className={cn(
    'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium interactive-base',
    isActive
      ? 'bg-indigo-500/12 text-indigo-300 glow-accent-strong'
      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
  )}
>
  <Icon className="w-4 h-4" />
  <span>{label}</span>
</button>
```

### Status Badge
```tsx
<div className="px-3 py-1 bg-emerald-500/12 text-emerald-300 border border-emerald-500/25 rounded-full text-xs font-semibold glow-success">
  Active
</div>
```

## 🚀 Usage Checklist

When building new components:

- [ ] Use `interactive-base` on all clickable elements
- [ ] Use `text-label` for uppercase labels
- [ ] Apply `glass` or `glass-strong` for elevated surfaces
- [ ] Use appropriate glow effects (`glow-accent`, `glow-success`, `glow-danger`)
- [ ] Implement staggered animations with `animationDelay`
- [ ] Test keyboard navigation with Tab key
- [ ] Verify color contrast with WCAG AA
- [ ] Add `:focus-visible` styles (automatic)
- [ ] Use consistent padding: p-6 (cards), p-8 (pages)
- [ ] Implement proper spacing: gap-6 (sections), gap-4 (elements)

## 📚 References

- **Tailwind CSS**: Core utility-first framework
- **Motion**: Smooth animations and transitions
- **Lucide React**: Icon library
- **Recharts**: Chart components with refined styling
