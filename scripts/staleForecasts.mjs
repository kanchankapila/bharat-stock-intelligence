// A dated forecast in a rule file ("clears ~2026-09-29", "not gradeable before ~2026-10-08") is a
// promise to come back. When the date passes and nobody writes the outcome back, the sentence keeps
// reading as current guidance. On 2026-10-26 measurement.md held three such elapsed forecasts and a
// "re-verified live on 2026-09-10" header (AF-20261026-47).
//
// Convention this enforces: `~YYYY-MM` or `~YYYY-MM-DD` marks a FORECAST. Once that date is past,
// the same line must say what happened (one of RESOLUTION_MARKERS). A historical date is written
// without the `~` ("start around 2026-06-30"), so it is never flagged.

export const RESOLUTION_MARKERS = /ELAPSED|GRADED|SUPERSEDED|WAS ->|RESOLVED|held exactly|CLOSED/i;
const FORECAST = /~\*{0,2}(20\d\d-\d\d(?:-\d\d)?)/g;

function endOf(token) {
  // A month-only forecast ("~2026-10") is not due until that month has ended.
  if (token.length === 7) {
    const [y, m] = token.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  return token;
}

/** Elapsed, unresolved forecasts in `text`, judged against `todayIso` (YYYY-MM-DD). Pure. */
export function findStaleForecasts(text, todayIso) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (RESOLUTION_MARKERS.test(line)) return;
    for (const m of line.matchAll(FORECAST)) {
      if (endOf(m[1]) < todayIso) out.push({ line: i + 1, date: m[1], text: line.trim().slice(0, 140) });
    }
  });
  return out;
}
