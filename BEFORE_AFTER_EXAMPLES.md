# Before & After Design Examples

Visual and code comparisons showing the redesign improvements.

## Color & Typography Updates

### Example 1: Page Header

**BEFORE**
```tsx
<div>
  <h2 className="text-2xl font-bold text-slate-100">Market Intelligence</h2>
  <p className="text-slate-400 text-sm mt-1">Real-time quantitative edge for Indian markets.</p>
</div>
```

**AFTER**
```tsx
<div className="space-y-2">
  <h2 className="text-3xl font-bold text-slate-50 tracking-tight">Market Intelligence</h2>
  <p className="text-slate-500 text-base">Real-time quantitative edge for Indian markets</p>
</div>
```

**Changes:**
- Larger heading (text-2xl → text-3xl)
- Lighter color for better contrast (text-slate-100 → text-slate-50)
- Added letter-spacing for elegance
- Improved spacing with utility
- More readable secondary text

---

## Surface & Glass Effects

### Example 2: Card Styling

**BEFORE**
```tsx
<div className="bg-slate-900/50 border border-white/[0.06] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.35)]">
  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Market Data</h3>
  <p className="text-slate-200">{data}</p>
</div>
```

**AFTER**
```tsx
<Card title="Market Data" icon={BarChart2} variant="elevated">
  {data}
</Card>

// OR manually:
<div className="surface-primary glass-border rounded-lg p-6 glow-accent-strong">
  <h3 className="text-label">Market Data</h3>
  <p className="text-slate-100">{data}</p>
</div>
```

**Changes:**
- Use semantic surface utilities
- Refined border with glass-border
- Improved padding (p-5 → p-6)
- Better rounded corners (rounded-2xl → rounded-lg)
- Enhanced glow effect
- Text color consistency

---

## Status Indicators

### Example 3: Up/Down Badges

**BEFORE**
```tsx
{isUp ? (
  <span className="text-emerald-400">↑ +2.5%</span>
) : (
  <span className="text-rose-400">↓ -1.2%</span>
)}
```

**AFTER**
```tsx
<div className={cn(
  'px-3 py-1 rounded-full text-xs font-semibold border',
  isUp
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25 glow-success'
    : 'bg-rose-500/15 text-rose-300 border-rose-500/25 glow-danger'
)}>
  {isUp ? <ArrowUpRight className="inline w-3 h-3 mr-1" /> : <ArrowDownRight className="inline w-3 h-3 mr-1" />}
  {isUp ? '+' : ''}{value}%
</div>
```

**Changes:**
- Better visual prominence with background
- Improved contrast with lighter text
- Added border for definition
- Glow effects for subtle emphasis
- Icon integration
- Professional appearance

---

## Data Tables

### Example 4: Table Headers

**BEFORE**
```tsx
<th className="py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800">
  Stock
</th>
```

**AFTER**
```tsx
<th className="py-4 px-4 text-label border-b glass-border">
  Stock
</th>
```

**Changes:**
- Standardized label styling with text-label
- Better vertical padding (py-3 → py-4)
- Refined border with glass-border
- Consistent spacing across tables

### Example 5: Table Rows

**BEFORE**
```tsx
<tr className="hover:bg-slate-800/40 transition-colors cursor-pointer">
  <td className="py-3 px-4 text-slate-100">{data}</td>
</tr>
```

**AFTER**
```tsx
<tr className="hover:bg-slate-800/20 interactive-base cursor-pointer">
  <td className="py-4 px-4 text-slate-100">{data}</td>
</tr>
```

**Changes:**
- Subtle hover effect (darker → lighter)
- Standardized transition with interactive-base
- Better padding consistency (py-3 → py-4)
- Smoother interaction feedback

---

## Buttons & Interactive Elements

### Example 6: Primary Button

**BEFORE**
```tsx
<button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors">
  Click me
</button>
```

**AFTER**
```tsx
<button className="px-4 py-2.5 bg-indigo-500/12 hover:bg-indigo-500/18 text-indigo-300 rounded-lg text-sm font-semibold interactive-base border glass-border glow-accent">
  Click me
</button>
```

**Changes:**
- Color branding with indigo accent
- Better vertical padding (py-2 → py-2.5)
- Semantic border with glass-border
- Accent glow for visual appeal
- Standardized transitions
- Increased font weight

### Example 7: Filter Buttons

**BEFORE**
```tsx
<button className={cn(
  'px-4 py-2 rounded-lg text-sm font-semibold border transition-all',
  isActive
    ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/40'
    : 'bg-slate-900/50 text-slate-400 border-slate-800 hover:border-slate-600 hover:text-slate-200'
)}>
  {label}
</button>
```

**AFTER**
```tsx
<button className={cn(
  'px-4 py-2.5 rounded-lg text-sm font-semibold interactive-base border',
  isActive
    ? 'bg-indigo-500/15 text-indigo-300 glow-accent-strong'
    : 'surface-primary text-slate-400 glass-border hover:text-slate-200'
)}>
  {label}
</button>
```

**Changes:**
- Consistent padding (py-2 → py-2.5)
- Semantic active state styling
- Refined inactive state
- Better hover affordance
- Glow effects for emphasis
- Smoother transitions

---

## Stat Cards / KPIs

### Example 8: Metric Card

**BEFORE**
```tsx
<div className="rounded-xl p-4 border border-slate-800 bg-slate-900/50 flex flex-col gap-1">
  <div className="flex items-center gap-2">
    <Activity className="w-4 h-4 text-slate-500" />
    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Adv / Dec</span>
  </div>
  <p className="text-xl font-black text-emerald-400 tabular-nums">1.2</p>
  <p className="text-[11px] text-slate-500">advance / decline ratio</p>
</div>
```

**AFTER**
```tsx
<div className="rounded-lg p-5 surface-primary glass-border glow-success flex flex-col gap-2">
  <div className="flex items-center gap-2">
    <Activity className="w-4 h-4 text-slate-500" />
    <span className="text-label">Adv / Dec</span>
  </div>
  <p className="text-2xl font-bold text-emerald-400 tabular-nums">1.2</p>
  <p className="text-xs text-slate-500">advance / decline ratio</p>
</div>
```

**Changes:**
- Semantic surface and border styling
- Better padding (p-4 → p-5)
- Improved spacing (gap-1 → gap-2)
- Larger, bolder metric (text-xl → text-2xl)
- Success glow for visual emphasis
- Consistent typography utilities
- Better visual hierarchy

---

## Animations & Transitions

### Example 9: Page Entry

**BEFORE**
```tsx
<div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
  {/* Content */}
</div>
```

**AFTER**
```tsx
<div className="space-y-8 animate-fade-in">
  {/* Content */}
</div>

// With staggered child animations:
{items.map((item, i) => (
  <div key={i} className="animate-slide-up" style={{ animationDelay: `${i * 0.1}s` }}>
    {item}
  </div>
))}
```

**Changes:**
- Cleaner animation naming
- Staggered animations for visual flow
- Consistent spacing (gap-6 → gap-8)
- Better rhythm and pacing
- More professional entrance

---

## Layout & Spacing

### Example 10: Grid Layout

**BEFORE**
```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
  {/* Items */}
</div>
```

**AFTER**
```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
  {/* Items */}
</div>

// For section-level spacing:
<div className="space-y-8">
  <h2 className="text-3xl font-bold">Section</h2>
  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
    {/* Cards */}
  </div>
</div>
```

**Changes:**
- Better breakpoint strategy (md → sm)
- Improved section spacing
- Consistent grid gaps
- Better visual rhythm

---

## Summary of Key Improvements

| Aspect | Change | Benefit |
|--------|--------|---------|
| **Colors** | Refined palette with semantic naming | Consistency, easier to maintain |
| **Typography** | Improved hierarchy and sizes | Better readability, visual clarity |
| **Spacing** | Standardized padding/margins | Professional appearance, alignment |
| **Borders** | glass-border utility | Modern, refined look |
| **Shadows** | Soft shadows (new system) | Subtle depth without harshness |
| **Glows** | Context-aware glow effects | Visual feedback, status indication |
| **Animations** | Smooth, staggered entrances | Professional, engaging feel |
| **Buttons** | Branded, semantic states | Better affordance, clarity |
| **Forms** | Consistent input styling | Improved UX, accessibility |
| **Tables** | Refined headers and rows | Better data presentation |

---

## Migration Tips

1. **Start with typography** – Update headings and text first
2. **Then surfaces** – Update card and container styling
3. **Then interactive** – Update buttons and links
4. **Finally animations** – Add smooth entrances

Each change is backwards compatible and can be done incrementally.

## Testing the Changes

After updating a component, verify:
- ✅ Layout responsive (mobile, tablet, desktop)
- ✅ Colors accessible (WCAG AA contrast)
- ✅ Animations smooth (no jank on slow devices)
- ✅ Functionality preserved (all features work)
- ✅ Performance acceptable (fast load time)
