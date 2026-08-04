"""Render the usefulness report as markdown."""
from __future__ import annotations

from datetime import date


def render_report(items) -> str:
    if not items:
        return "# URL Explorer Report\n\nNo endpoints processed.\n"

    lines = [f"# URL Explorer Report — {date.today().isoformat()}", ""]
    lines += ["## Endpoints", "", "| Endpoint | URLs | Fetch OK | Fields | Ticker-keyed |",
              "|---|---|---|---|---|"]
    for it in items:
        ep = it["endpoint"]
        ticker_keyed = any(p.dtype == "string" and p.universe_overlap_pct >= 0.5
                           for p in it["profiles"])
        lines.append(f"| `{ep.template}` | {len(ep.urls)} | {it['n_ok']}/{it['n_total']} "
                     f"| {len(it['profiles'])} | {'yes' if ticker_keyed else 'no'} |")

    for it in items:
        ep = it["endpoint"]
        lines += ["", f"### `{ep.template}`", ""]
        top = sorted(it["profiles"], key=lambda p: (-p.fill_rate, -p.universe_overlap_pct))[:15]
        lines += ["**Fields (top by coverage):**", "",
                  "| field | dtype | fill | cardinality | universe% |", "|---|---|---|---|---|"]
        for p in top:
            lines.append(f"| {p.field_path} | {p.dtype} | {p.fill_rate:.2f} "
                         f"| {p.cardinality} | {p.universe_overlap_pct:.2f} |")
        if it["correlations"]:
            lines += ["", "**Correlations (|value| ranked):**", "",
                      "| field | target | n | pearson | spearman |", "|---|---|---|---|---|"]
            for c in sorted(it["correlations"], key=lambda c: -abs(c.pearson))[:15]:
                lines.append(f"| {c.field_path} | {c.target} | {c.n} "
                             f"| {c.pearson:.2f} | {c.spearman:.2f} |")
    return "\n".join(lines) + "\n"
