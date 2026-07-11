# Codebase Review Report — SUPERSEDED

**Original run:** 2026-06-29 via Amazon Bedrock (`anthropic.claude-3-5-sonnet-20241022-v2:0`).
**Status:** dead artifact — every file review in that run failed with
`The security token included in the request is invalid.` (expired/invalid Bedrock
credentials). No usable findings were produced.

**Use these instead** (real, completed reviews):

- **`docs/superpowers/plans/audit-findings/synthesis.md`** — the 5-agent codebase health audit
  (TS API, TS infra, TS services, Python fetchers, Python core). 34 auto-fixed items + 5 flagged
  correctness items (fake index fallback, max-bullish news fallback, `{success:true}`-on-failure
  job reporting, reward-engine N+1, etc.). This is the authoritative code-quality review.
- **`ACTION_ITEMS.md`** — the live backlog distilled from that audit plus the ongoing accuracy /
  reliability work; kept current (last refresh 2026-07-11).
- **`docs/FETCHER_HEALTH_TRACKER.md`** — per-fetcher health, last swept 2026-07-11.
- **`docs/DATA_GAP_MANIFEST.md`** — the accuracy / data-feed program and its current ceiling.

Regenerate a fresh full-file LLM review only with valid credentials; until then this file is a
redirect, not a report.
