type BarItem = {
  label: string;
  value: number | null;
  colorClass?: string;
  suffix?: string;
};

export function V5DeskSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <section className="v5-grid animate-pulse" aria-label="Loading desk data">
      <div className="col-span-12 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="v5-card h-20 bg-[var(--v5-surface-2)]" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="v5-card col-span-12 h-36 bg-[var(--v5-surface-2)] xl:col-span-6" />
      ))}
    </section>
  );
}

export function V5MiniBarChart({
  title,
  items,
  emptyLabel = 'No data available',
}: {
  title: string;
  items: BarItem[];
  emptyLabel?: string;
}) {
  const valid = items.filter((x) => x.value != null && Number.isFinite(x.value));
  const max = valid.length ? Math.max(...valid.map((x) => Math.abs(Number(x.value)))) : 0;

  return (
    <div className="v5-mini-chart">
      <div className="v5-mini-chart-title">{title}</div>
      {items.map((item) => {
        const hasValue = item.value != null && Number.isFinite(item.value);
        const normalized = hasValue && max > 0 ? Math.max(4, (Math.abs(Number(item.value)) / max) * 100) : 0;
        return (
          <div key={item.label} className="v5-mini-row">
            <div className="v5-mini-label">{item.label}</div>
            <div className="v5-mini-track">
              {hasValue ? (
                <div
                  className={`v5-mini-fill ${item.colorClass ?? 'v5-mini-fill-teal'}`}
                  style={{ width: `${normalized}%` }}
                />
              ) : (
                <div className="v5-mini-empty" />
              )}
            </div>
            <div className="v5-mini-value">
              {hasValue ? `${Number(item.value).toFixed(2)}${item.suffix ?? ''}` : '—'}
            </div>
          </div>
        );
      })}
      {!valid.length && <p className="v5-mini-empty-note">{emptyLabel}</p>}
    </div>
  );
}

export function V5InsightPanel({
  title,
  insights,
}: {
  title: string;
  insights: string[];
}) {
  const rows = insights.filter((x) => x.trim().length > 0);
  return (
    <div className="v5-insight-panel">
      <div className="v5-insight-title">{title}</div>
      {rows.length ? (
        <div className="v5-insight-list">
          {rows.map((line, i) => (
            <div key={`${i}-${line}`} className="v5-insight-item">{line}</div>
          ))}
        </div>
      ) : (
        <p className="v5-mini-empty-note">No insight available yet.</p>
      )}
    </div>
  );
}

export function V5Sparkline({
  title,
  values,
  colorClass = 'v5-sparkline-stroke-teal',
  minLabel,
  maxLabel,
}: {
  title: string;
  values: Array<number | null>;
  colorClass?: string;
  minLabel?: string;
  maxLabel?: string;
}) {
  const valid = values
    .map((v) => (v == null || !Number.isFinite(v) ? null : Number(v)))
    .filter((v): v is number => v != null);

  if (!valid.length) {
    return (
      <div className="v5-mini-chart">
        <div className="v5-mini-chart-title">{title}</div>
        <p className="v5-mini-empty-note">No trend data available.</p>
      </div>
    );
  }

  const width = 260;
  const height = 64;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = Math.max(1e-9, max - min);

  const points = values
    .map((v, i) => {
      if (v == null || !Number.isFinite(v)) return null;
      const x = (i / Math.max(1, values.length - 1)) * width;
      const y = height - ((Number(v) - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter((p): p is string => p != null)
    .join(' ');

  return (
    <div className="v5-mini-chart">
      <div className="v5-mini-chart-title">{title}</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="v5-sparkline" role="img" aria-label={title}>
        <polyline className={`v5-sparkline-stroke ${colorClass}`} points={points} fill="none" />
      </svg>
      <div className="v5-sparkline-legend">
        <span>{minLabel ?? `Min ${min.toFixed(2)}`}</span>
        <span>{maxLabel ?? `Max ${max.toFixed(2)}`}</span>
      </div>
    </div>
  );
}

export function V5DecisionSummaryStrip({
  title = 'Decision Summary',
  items,
}: {
  title?: string;
  items: string[];
}) {
  const rows = items.filter((x) => x.trim().length > 0).slice(0, 3);
  if (!rows.length) return null;

  return (
    <div className="v5-decision-strip">
      <div className="v5-decision-title">{title}</div>
      <div className="v5-decision-grid">
        {rows.map((line, i) => (
          <div key={`${i}-${line}`} className="v5-decision-item">{line}</div>
        ))}
      </div>
    </div>
  );
}
