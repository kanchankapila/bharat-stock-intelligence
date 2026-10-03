// Collapse intraday candles (epoch-second `time`, `close` or `c`) to one close per IST trading
// day, keeping the last `n` days. getOHLCData(dur '1M') returns 30-minute bars, so slicing the
// last 30 candles gave ~2 sessions under a "30D" label (AF-20260930-45).
const istDate = (epochSec: number) =>
  new Date((epochSec + 5.5 * 3600) * 1000).toISOString().slice(0, 10);

export function dailyCloses(candles: any[], n: number): Array<{ date: string; value: number }> {
  const byDay = new Map<string, { t: number; value: number }>();
  for (const c of candles ?? []) {
    const t = Number(c?.time);
    const v = Number(c?.close ?? c?.c);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    const day = istDate(t);
    const prev = byDay.get(day);
    if (!prev || t >= prev.t) byDay.set(day, { t, value: v });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-n)
    .map(([date, { value }]) => ({ date, value }));
}
