// Digit-boundary match, not a bare substring: `includes('89')` is satisfied by "891" or
// "1890" anywhere in the doc, so a drifted figure could pass on an unrelated number that
// happens to contain it. A number may legitimately be written with thousands separators,
// so allow those inside the needle's own digits only. A trailing `,` or `.` is sentence
// punctuation unless a digit follows it ("89." matches; "89.5" and "89,000" do not).
export function quotesNumber(hay, needle) {
  const pattern = new RegExp(`(?<![\\d,.])${String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d|[,.]\\d)`);
  return pattern.test(hay);
}

// Lines matching `anchor` that quote "<N> <unit>" with N != expected. The ledger rule was the
// only file checked for the url_endpoints count, so rule/skill copies sat at 830 against 834.
export function driftedCounts(text, anchor, unit, expected) {
  const out = [];
  const re = new RegExp(`(?<![\\d,.])(\\d[\\d,]*) ${unit}\\b`, 'g');
  text.split('\n').forEach((l, i) => {
    if (!anchor.test(l)) return;
    for (const m of l.matchAll(re)) {
      if (Number(m[1].replace(/,/g, '')) !== expected) out.push({ line: i + 1, found: m[1] });
    }
  });
  return out;
}
