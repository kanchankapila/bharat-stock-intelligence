# Design System – Quick Reference

A one-page cheat sheet for the new Claude design system.

## Colors at a Glance

### Backgrounds
- `surface-primary` – Card backgrounds (slate-900/40)
- `surface-secondary` – Nested areas (slate-800/30)  
- `surface-tertiary` – Minimal emphasis (slate-700/20)
- `bg-slate-950` – Page background
- `bg-slate-900/60` – Elevated (sidebar, header)

### Text
- `text-slate-50` – Primary headings
- `text-slate-100` – Body text
- `text-slate-400` – Secondary
- `text-slate-500` – Tertiary
- `text-muted` – Reduced emphasis
- `text-label` – Uppercase labels

### Accents
- `indigo-400/500` – Primary accent
- `emerald-500` – Success
- `rose-500` – Error
- `amber-500` – Warning
- `cyan-400` – Highlight

## Essential Classes

```tsx
// Surfaces
<div className="surface-primary glass-border">...</div>
<div className="surface-secondary glass-border">...</div>

// Glows
<div className="glow-accent">...</div>      // Subtle indigo
<div className="glow-accent-strong">...</div> // Bold indigo
<div className="glow-success">...</div>     // Emerald
<div className="glow-danger">...</div>      // Rose

// Text
<h2 className="text-3xl font-bold text-slate-50">Title</h2>
<p className="text-slate-400 text-sm">Secondary</p>
<span className="text-label">UPPERCASE LABEL</span>

// Interactive
<button className="interactive-base">...</button>

// Animations
<div className="animate-fade-in">...</div>
<div className="animate-slide-up" style={{animationDelay: '0.1s'}}>...</div>
```

## Components

### Card
```tsx
<Card 
  title="Market Data" 
  icon={BarChart2}
  variant="elevated"
  compact={false}
>
  {children}
</Card>
```

**Variants:** default, elevated, accent, success, danger, ghost

### Buttons
```tsx
// Primary action
<button className="px-4 py-2.5 bg-indigo-500/12 hover:bg-indigo-500/18 text-indigo-300 rounded-lg text-sm font-semibold interactive-base border glass-border glow-accent">
  Click
</button>

// Secondary
<button className="px-4 py-2.5 surface-primary text-slate-300 rounded-lg text-sm font-semibold interactive-base border glass-border hover:bg-slate-800/40">
  Click
</button>

// Minimal
<button className="px-4 py-2.5 hover:bg-slate-800/40 text-slate-400 hover:text-slate-200 interactive-base">
  Click
</button>
```

### Badges
```tsx
// Success
<div className="px-3 py-1 bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 rounded-full text-xs font-semibold glow-success">
  Active
</div>

// Danger
<div className="px-3 py-1 bg-rose-500/15 text-rose-300 border border-rose-500/25 rounded-full text-xs font-semibold glow-danger">
  Alert
</div>

// Info
<div className="px-3 py-1 bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 rounded-full text-xs font-semibold glow-accent">
  Info
</div>
```

### Tables
```tsx
<table className="w-full">
  <thead className="border-b glass-border bg-slate-900/40">
    <tr>
      <th className="py-4 px-4 text-label">Column</th>
    </tr>
  </thead>
  <tbody className="divide-y divide-slate-800/30">
    <tr className="hover:bg-slate-800/20 interactive-base">
      <td className="py-4 px-4">Data</td>
    </tr>
  </tbody>
</table>
```

### Navigation
```tsx
<nav className="flex gap-1">
  {items.map(item => (
    <button
      key={item.id}
      className={cn(
        'px-4 py-3 rounded-lg text-sm font-medium interactive-base',
        isActive
          ? 'bg-indigo-500/12 text-indigo-300 glow-accent-strong'
          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
      )}
    >
      {item.label}
    </button>
  ))}
</nav>
```

## Spacing

| Class | Size |
|-------|------|
| `p-4` | 16px |
| `p-6` | 24px |
| `p-8` | 32px |
| `gap-4` | 16px |
| `gap-6` | 24px |
| `gap-8` | 32px |

## Shadows

```tsx
// Subtle
<div className="shadow-sm-soft">...</div>

// Medium
<div className="shadow-md-soft">...</div>

// Large
<div className="shadow-lg-soft">...</div>
```

## Animations

```tsx
// Fade in
<div className="animate-fade-in">...</div>

// Slide up
<div className="animate-slide-up" style={{animationDelay: '0.1s'}}>...</div>

// Soft pulse
<div className="animate-pulse-soft">...</div>

// Stagger multiple items
{items.map((item, i) => (
  <div key={i} className="animate-slide-up" style={{animationDelay: `${i * 0.1}s`}}>
    {item}
  </div>
))}
```

## Common Layouts

### Page Header
```tsx
<div className="space-y-2">
  <h2 className="text-3xl font-bold text-slate-50 tracking-tight">Title</h2>
  <p className="text-slate-500 text-base">Description</p>
</div>
```

### Stats Grid
```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
  {stats.map(stat => (
    <div key={stat.id} className="surface-primary glass-border rounded-lg p-6 glow-accent">
      <span className="text-label">{stat.label}</span>
      <p className="text-2xl font-bold text-slate-50 mt-2">{stat.value}</p>
    </div>
  ))}
</div>
```

### Card Grid
```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {items.map(item => (
    <Card key={item.id} title={item.title} variant="elevated">
      {item.content}
    </Card>
  ))}
</div>
```

## Form Inputs

```tsx
<input
  type="text"
  placeholder="Search..."
  className="px-4 py-2.5 surface-primary glass-border rounded-lg text-slate-100 placeholder:text-slate-600 focus-visible:outline-indigo-500 focus-visible:outline-offset-2"
/>

<select className="px-4 py-2.5 surface-primary glass-border rounded-lg text-slate-100">
  <option>Option 1</option>
  <option>Option 2</option>
</select>

<textarea className="px-4 py-3 surface-primary glass-border rounded-lg text-slate-100 resize-none" />
```

## Status Colors

```tsx
// Up/Success
<span className="text-emerald-400">+2.5%</span>

// Down/Error  
<span className="text-rose-400">-1.2%</span>

// Neutral
<span className="text-slate-500">—</span>

// Active
<span className="text-indigo-400">Active</span>
```

## Icons

All icons from lucide-react:
- Color with `className="w-4 h-4 text-slate-400"`
- Size: `w-3 h-3` (12px), `w-4 h-4` (16px), `w-5 h-5` (20px), `w-6 h-6` (24px)

```tsx
<BarChart2 className="w-4 h-4 text-slate-400" />
<TrendingUp className="w-4 h-4 text-emerald-400" />
<AlertTriangle className="w-4 h-4 text-rose-400" />
```

## Accessibility

```tsx
// Keyboard accessible button
<button 
  className="interactive-base"
  onClick={handleClick}
  aria-label="Close dialog"
>
  ×
</button>

// Focus visible (automatic)
// Outline appears on Tab key navigation

// Color not only indicator
<span className="flex items-center gap-2">
  <span className="w-2 h-2 rounded-full bg-emerald-400" />
  <span>Active</span>
</span>
```

## Common Mistakes to Avoid

❌ `bg-slate-900` – Use `surface-primary` instead  
❌ `border border-white/5` – Use `glass-border` instead  
❌ Excessive animations – Animate containers, not individual elements  
❌ Hard-coded colors – Use color classes consistently  
❌ `p-5` inconsistent – Use `p-4`, `p-6`, `p-8` for consistency  
❌ `rounded-2xl` on small cards – Use `rounded-lg` instead  

## Tips & Tricks

1. **Stagger animations** – Add `animationDelay` for visual flow
2. **Hover state** – Use `hover:bg-slate-800/40 hover:border-slate-600/20`
3. **Disabled state** – Use `disabled:opacity-50 disabled:cursor-not-allowed`
4. **Focus state** – Automatic with `:focus-visible`
5. **Loading** – Use `animate-pulse-soft` on skeleton loaders
6. **Transitions** – All use `duration-200 ease-out` by default

## Resources

- Full docs: `DESIGN_SYSTEM.md`
- Migration guide: `DESIGN_MIGRATION_GUIDE.md`
- CSS utilities: `src/index.css`
- Design examples: Updated component files
