type KpiItem = {
  label: string;
  value: string;
  tone?: 'neutral' | 'positive' | 'negative' | 'warning';
};

// These map to CSS variables (v5.css) rather than hardcoded Tailwind text colors -- the
// hardcoded classes this replaced (text-slate-900, text-teal-700, etc.) don't respond to
// .v6-root's bridged theme at all, since Tailwind utility classes never reference a custom
// property; they'd stay dark-on-dark under V6Shell's dark mode regardless of what v5.css itself
// does. See v6-theme.css for the bridge and v5.css's header comment for the full story.
function toneClass(tone: KpiItem['tone']): string {
  if (tone === 'positive') return 'v5-kpi-value-positive';
  if (tone === 'negative') return 'v5-kpi-value-negative';
  if (tone === 'warning') return 'v5-kpi-value-warning';
  return 'v5-kpi-value-neutral';
}

export function V5KpiStrip({ items }: { items: KpiItem[] }) {
  return (
    <div className="v5-kpi-strip">
      {items.map((item) => (
        <div key={item.label} className="v5-kpi-item">
          <div className="v5-kpi-label">{item.label}</div>
          <div className={`v5-kpi-value ${toneClass(item.tone)}`}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}
