# V1 Design System — Complete Reference

## Philosophy
V1 is a **premium dark equity intelligence dashboard**. Every design choice reflects the subject: real-time data, precision, high stakes, decisive action. No softness, no decoration that doesn't serve clarity.

---

## Color Palette

### Primary Semantic Colors (Direction/Sentiment)
- **Bullish / Up**: `#10b981` (emerald-500, HSL 160° 84% 39%)
- **Bearish / Down**: `#f43f5e` (rose-400, HSL 343° 98% 50%)
- **Neutral / Hold**: `#f59e0b` (amber-400, HSL 38° 92% 50%)
- **Accent / Primary**: `#6366f1` (indigo-500, HSL 262° 80% 50%)

### Neutral Scale (Backgrounds, Borders, Text)
- **Surface (darkest)**: `#050508` (current body bg)
- **Surface-elevated**: `#0d111d` (v1-card base)
- **Border-subtle**: `rgba(255, 255, 255, 0.07)`
- **Border-prominent**: `rgba(255, 255, 255, 0.14)`
- **Text-primary**: `#f1f5f9` (slate-100)
- **Text-secondary**: `#cbd5e1` (slate-300)
- **Text-tertiary**: `#64748b` (slate-500)
- **Text-muted**: `#475569` (slate-700)

### Conviction/Intensity Tiers (from BuyRecommendationsPage pattern)
- **S_ELITE / Strong**: emerald-500 (`#10b981`)
- **A_HIGH / High**: sky-500 (`#0ea5e9`)
- **B_MEDIUM / Medium**: amber-500 (`#f59e0b`)
- **C_LOW / Low**: slate-600 (`#475569`)

---

## Typography

### Typeface Choices
- **Display (headers, emphasis)**: Rajdhani, sans-serif
- **Data (numbers, values)**: Space Mono, monospace
- **Body (body copy, UI)**: Inter, sans-serif (Tailwind default)

### Type Scale & Usage
| Role | Face | Size | Weight | Letter-spacing | Example |
|------|------|------|--------|---|---|
| **Page Title** | Rajdhani | 28px / 2.5rem | 700 (bold) | normal | "Earnings Tracker" |
| **Section Header** | Rajdhani | 20px / 1.25rem | 700 (bold) | normal | "Top Gainers" |
| **Card Title** | Rajdhani | 16px / 1rem | 600 (semibold) | normal | "NIFTY50" |
| **Label/Tag** | Inter | 10px / 0.625rem | 600 (semibold) | widest (0.1em) | "BUY" conviction badge |
| **Value/Data** | Space Mono | 16px / 1rem | 700 (bold) | normal | "+2.45%" |
| **Body** | Inter | 14px / 0.875rem | 400 (normal) | normal | List item text, descriptions |
| **Caption** | Inter | 11px / 0.6875rem | 400 (normal) | normal | Dates, secondary info |

### Font Feature Settings
All text uses: `font-feature-settings: "cv02", "cv03", "cv04", "cv11"`
(Optimizes number rendering in monospace fonts)

---

## Spacing & Sizing

### Spacing Scale (CSS `rem` / pixels at 16px base)
- **xs**: 0.25rem / 4px
- **sm**: 0.5rem / 8px
- **md**: 1rem / 16px
- **lg**: 1.5rem / 24px
- **xl**: 2rem / 32px
- **2xl**: 2.5rem / 40px
- **3xl**: 3rem / 48px

### Page Padding
- **Mobile**: `p-4` (1rem / 16px)
- **Tablet+**: `p-6` (1.5rem / 24px)

### Card Padding
- **Compact**: `p-3` (0.75rem / 12px)
- **Standard**: `p-4` (1rem / 16px)
- **Spacious**: `p-6` (1.5rem / 24px)

### Gap (Grid/Flex spacing)
- **Tight**: `gap-2` (0.5rem / 8px)
- **Standard**: `gap-4` (1rem / 16px)
- **Loose**: `gap-6` (1.5rem / 24px)

---

## Component Styling

### Cards (v1-card system)
**Base class**: `.v1-card` (indigo top border by default)
```
border-top-color: rgba(99, 102, 241, 0.7)
border: 1px solid rgba(255, 255, 255, 0.07)
border-radius: 10px
background: rgba(10, 11, 16, 0.65)
backdrop-filter: blur(20px)
```

**Variants** (swap top-border color):
- `.v1-card-up` → emerald-500
- `.v1-card-down` → rose-400
- `.v1-card-neutral` → amber-400
- `.v1-card-accent` → white/transparent

### Buttons

**Primary action** (CTA, buy/sell confirmation):
```
background: indigo-500 (#6366f1)
text: white
padding: 8px 16px
border-radius: 6px
font: Inter 14px semibold
hover: brightness-110%
focus: focus-visible ring (2px indigo, offset 2px)
```

**Secondary action** (filter, toggle, refresh):
```
background: rgba(71, 85, 105, 0.5) — slate-600/50
text: slate-300
padding: 6px 12px
border-radius: 6px
font: Inter 13px normal
border: 1px solid rgba(255, 255, 255, 0.07)
hover: bg-slate-500/50
```

**Tertiary action** (cancel, close, less important):
```
background: transparent
text: slate-400
padding: 6px 12px
border-radius: 6px
font: Inter 13px normal
border: 1px solid rgba(255, 255, 255, 0.07)
hover: text-slate-300, bg-slate-700/30
```

**Icon buttons**:
```
size: 32px × 32px (standard)
background: rgba(71, 85, 105, 0.3)
border-radius: 6px
icon: lucide-react, 16px
hover: bg-slate-600/50
```

### Inputs (text, date, search)
```
background: rgba(71, 85, 105, 0.3) — slate-600/30
border: 1px solid rgba(255, 255, 255, 0.07)
border-radius: 6px
padding: 8px 12px
font: Inter 13px
text color: slate-200
placeholder: slate-500
focus: border-emerald-500, outline none
```

### Badges / Tags
**Format**: `<label class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold">`

**Color variants** (use with conviction tier colors):
- **Emerald (S_ELITE)**: `bg-emerald-500/20 border-emerald-500/40 text-emerald-300`
- **Sky (A_HIGH)**: `bg-sky-500/20 border-sky-500/40 text-sky-300`
- **Amber (B_MEDIUM)**: `bg-amber-500/15 border-amber-500/35 text-amber-300`
- **Slate (C_LOW)**: `bg-slate-700/40 border-slate-600/40 text-slate-400`

### Data Pills (compact stat display)
```
class: v1-card p-4
children: 
  - label: Inter 10px, font-semibold, text-slate-400, uppercase, tracking-widest
  - value: Space Mono 20px, font-black, color-semantic (emerald/rose/amber/indigo)
```

---

## Shadows & Effects

### Card Shadow
```
box-shadow: 0 4px 20px rgba(0, 0, 0, 0.02)
transition: transform 0.18s ease-out, box-shadow 0.18s ease-out, border-color 0.18s ease-out
hover: box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22), transform: translateY(-2px)
```

### Glow Effects
**Subtle (default):**
```
box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.18), 0 4px 24px rgba(99, 102, 241, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.04)
```

**Bullish glow:**
```
box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.18), 0 4px 20px rgba(16, 185, 129, 0.06)
```

**Bearish glow:**
```
box-shadow: 0 0 0 1px rgba(244, 63, 94, 0.18), 0 4px 20px rgba(244, 63, 94, 0.06)
```

### Loading Shimmer
Already defined in `index.css` — use class `.shimmer` on skeleton elements.

---

## Motion & Animation

### Page/Card Entrance
```
keyframes v1-card-in: 
  from: opacity 0, translateY(6px)
  to: opacity 1, translateY(0)
duration: 0.35s
easing: ease-out
apply: all .v1-card* elements automatically
```

### Transitions (Hover, State Change)
```
default: 0.18s ease-out
properties: transform, box-shadow, border-color
```

### Disable on Reduced Motion
```
@media (prefers-reduced-motion: reduce) {
  animation: none;
  transition: none;
}
```

---

## Accessibility & Best Practices

### Focus Visibility
- All interactive elements use `:focus-visible` (not `:focus`)
- Ring: 2px indigo (#6366f1), offset 2px
- Applied globally in `index.css` — no per-component override needed

### Keyboard Navigation
- Tab order: natural DOM order (left-to-right, top-to-bottom)
- Skip link at top of page (hidden until focused)
- Use semantic HTML: `<button>` not `<div onclick>`

### Color Contrast
- **WCAG AA compliant** everywhere
- Text-primary (#f1f5f9) on Surface-darkest (#050508): 16:1 contrast ✓
- Text-secondary (#cbd5e1) on Surface-elevated (#0d111d): 13:1 contrast ✓

### Motion
- All animations respect `prefers-reduced-motion`
- No auto-playing video or long-duration loops
- Motion is purposeful (entrance, interaction feedback) not decorative

---

## When to Use What

| Element | Use This | Don't Use | Notes |
|---------|----------|-----------|-------|
| **Page/section heading** | Rajdhani 28px bold | 3xl text-white from Tailwind | Custom font creates visual hierarchy |
| **Card stat value** | Space Mono 20px font-black + semantic color | Tailwind text-sky-300 | Monospace + color conveys "data you can trust" |
| **Action button** | `.v1-btn-primary` (TBD: build this class) | `bg-blue-600 text-white px-4 py-2` | Ensures consistency across 63 pages |
| **Status badge** | `conviction-tier` classes (S/A/B/C) | Custom `bg-emerald-500 px-2` | Centralized color logic |
| **Card container** | `.v1-card` + sentiment variant | `bg-slate-900 border border-slate-700` | Glass effect + animation built-in |
| **Input field** | `.v1-input` (TBD: build this class) | `border border-slate-600 bg-slate-800` | Focus state and hover states unified |

---

## Implementation Checklist

- [ ] Add reusable utility classes for buttons, inputs, badges to `index.css`
- [ ] Audit all 63 pages for style map and inline color overrides
- [ ] Refactor pages to use token system instead of custom colors
- [ ] Build Storybook or component catalog (optional but recommended)
- [ ] Ensure responsive behavior (mobile padding, font sizes, grid cols)
- [ ] Verify keyboard navigation and focus states work everywhere
- [ ] Test reduced-motion preference across pages