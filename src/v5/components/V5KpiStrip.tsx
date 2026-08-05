type KpiItem = {
  label: string;
  value: string;
  tone?: 'neutral' | 'positive' | 'negative' | 'warning';
};

function toneClass(tone: KpiItem['tone']): string {
  if (tone === 'positive') return 'text-teal-700';
  if (tone === 'negative') return 'text-rose-700';
  if (tone === 'warning') return 'text-amber-700';
  return 'text-slate-900';
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
