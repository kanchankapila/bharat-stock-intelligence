// Digit-boundary match, not a bare substring: `includes('89')` is satisfied by "891" or
// "1890" anywhere in the doc, so a drifted figure could pass on an unrelated number that
// happens to contain it. A number may legitimately be written with thousands separators,
// so allow those inside the needle's own digits only. A trailing `,` or `.` is sentence
// punctuation unless a digit follows it ("89." matches; "89.5" and "89,000" do not).
export function quotesNumber(hay, needle) {
  const pattern = new RegExp(`(?<![\\d,.])${String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d|[,.]\\d)`);
  return pattern.test(hay);
}
