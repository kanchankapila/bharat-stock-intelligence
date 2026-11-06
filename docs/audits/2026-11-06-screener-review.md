# Screener re-review, 2026-11-06

Disposition: the broad semantic candidate is review-only. No bulk relabeling, risk-veto removal,
oscillator-policy resolution or screener weight change is supported by these results.
Tracking: AF-20261106-01 and AF-20261106-02 in `docs/audit-findings.md`.

**Correction, 2026-11-06: the archived v3 replay is INVALID as policy evidence.** AF-20261106-04
confirmed that its timestamped capture omits long-running memberships. The archived numbers below
must not be used to accept or reject a policy or quantify predictive performance. The original
bytes are retained for traceability; the measurement script now reports INVALID-CAPTURE, and
bulk application remains blocked. The independently measured risk-veto decision in AF-20261105-03
is preserved. Correcting the capture and rerunning are tracked in AF-20261106-04.

## The six reported problems

1. **Low Price to Sales:** confirmed a candidate rule defect. Low price-to-sales is a valuation
   condition ([CFA Institute valuation framework](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/market-based-valuation-price-enterprise-value-multiples));
   it does not say sales are falling. The candidate now returns bullish/valuation,
   with empirical direction explicitly unproven. Cheapness alone cannot establish a profitable
   purchase; peer valuation, margins, growth and financial risk still matter.
2. **Risk vetoes:** confirmed the proposed policy could remove them. Restored bearish/risk
   treatment for ASM/GSM, low DVM, exercise caution, distressed operations and operations
   unsuccessful. Existing production write policies remain active. Any remaining veto removal
   causes the bulk apply transaction to refuse execution. Surveillance is a risk attribute:
   [NSE ASM](https://www.nseindia.com/static/regulations/additional-surveillance-measure) and
   [NSE GSM](https://www.nseindia.com/static/regulations/graded-surveillance-measure) describe
   surveillance and trading controls, rather than a measured forecast of negative returns.
3. **Trading activity with negative weekly returns:** confirmed description splitting caused
   inconsistent family labels. The candidate now recognizes the condition before appended
   descriptions across Large, Mid and Micro Cap variants and returns bearish/direction.
4. **Logged oscillator conflict:** confirmed the earlier candidate work improperly replaced a
   pinned decision. Restored the original regression, including its explanation and the explicit
   disagreement between the write path and measured NLP override (AF-20260829-11/12). Candidate
   oscillator neutrality is an experiment; production behavior is unchanged. Recorded the
   paired replay below and in the shared ledger.
5. **Negation:** confirmed. “Not low debt” now abstains as neutral/unresolved in the candidate.
   This is conservative handling of negated conditions, not a complete language parser.
6. **Moving code and missing export:** the support-filter test belongs to this work. Its missing
   export existed during development; `normalizeEtSupportFilter` is now exported and tested.
   A subsequent restoration edit exposed a different misplaced sentiment declaration, which was
   fixed; the Trendlyne module was then restored to its original implementation. A fresh
   typecheck and the four focused TypeScript suites passed. Versioned artifacts refuse overwrite;
   applying requires exact policy and manifest hashes plus adequate promotion evidence.

## Frozen candidate

The full per-row review, including all existing neutral rows, is in
`2026-11-06-screener-bias-review-v3-display.csv`. Only whitespace within displayed vendor criteria
is normalized in that export. The raw v3 CSV remains a local capture; earlier CSVs are superseded
development captures. Git preserves the exact frozen manifest bytes and pins the policy to LF,
so the hashes below survive Windows and Linux checkouts (AF-20261106-03).
The exact JSON application manifest is `research/out/screener-bias-review-20261106-v3.json`.

- Captured at 2026-11-05 18:45:27 UTC (2026-11-06 00:15:27 IST).
- Policy SHA-256: `1447de3f631f3d0d6a3a8606b137667dffc66434afe029b35d787fc0446df932`.
- Manifest SHA-256: `5f1e008c39988da6c0e7bce669fd76101ca413e5490087df4fa4d31c1d68f0e9`.
- Catalog: 2,542 rows; 802 candidate changes, including 111 bullish/bearish flips.
- Existing catalog neutrals: 714; candidate retains 406, proposes 185 bullish and 123 bearish.
- Remaining risk-veto removals: 35 names, including 14 currently Sell/Strong Sell, 2 Hold and
  19 without a rating in the latest batch. Causes are Low Debt Stocks (18) and Decreasing
  Quarterly Losses (17), with categories held constant. These are counterfactual changes,
  not applied removals. Related independent work is tracked in AF-20261105-03.

All decisions distinguish the condition's meaning from predictive evidence. Neutral includes
participation, directionless trend strength, volatility, events, thematic universes, mixed
conditions and unresolved criteria. These features can help liquidity selection, risk controls,
event timing and interaction research without becoming automatic buy/sell votes.

## Archived measurement — invalidated

`2026-11-06-screener-replay-v3.json` records five timestamped capture dates and four graded
next-session open-to-close outcomes (decision dates October 30 and November 2–4).
The candidate combines label changes, neutral contribution zero and alias deduplication; this
does not isolate the contribution of any one change or measure canonical recommendation P&L.

- Paired Spearman IC delta: +0.00434; daily t = 0.67.
- Paired top-50 net excess return delta: **-0.08395 percentage points per date**;
  daily t = -2.16. Candidate net excess was negative on every graded date.
- Cost assumption: 0.32 percentage points per basket return; equal-universe benchmark.
- Equal-universe zero control was numerically zero on each date.

Original verdict: LOW-DATA. **Superseding verdict: INVALID-CAPTURE; no policy inference or promotion.**
The three-day entry window omitted active, longer-running memberships (AF-20261106-04).
Current template metadata and current suspect-price flags
were used; historical filter versions and historical quarantine state were not reconstructed.
This is a short diagnostic, with possible hindsight in today's metadata/flags, not an independent
out-of-sample result. No claim of improved prediction or recommendations is supported.

## Independently verified source defect

Three ET negative-breakout support definitions used Above. Paired live provider probes confirmed
the reversed condition. Corrected Below predicates receive new identities; legacy identities and
history are retained, with legacy catalog/master labels neutralized.

Live SQL readback: first `659ef18b`, second `fc8a2825`, third `cd78af2f` each has 100 captured rows;
all 100 prices in each are below the appropriate stored support level. New master/catalog labels
are bearish; the three old Above identities are neutral. This source-data correction has been
applied. Persistent service code has not been restarted from this concurrently edited checkout.

## Verification

Final pre-commit checks on the isolated snapshot based on `034feb61` passed:

- `tsc --noEmit`: exit 0.
- Full Vitest: 2,339 passed, 46 skipped, no failures.
- Full Python gate: 4,141 passed, 271 skipped, 80 existing warnings, exit 0.
- Findings/backlog, document inventory, recurring-bug checks and staged whitespace checks passed.

The frozen policy, manifest and replay hashes agree and survive a fresh checkout. The hash
regression failed on the incorrect policy line endings before the correction. The risk-veto
regression passed; disabling its guard in an in-memory negative control caused failure.
The invalid-capture evidence test passed even with 99 purported graded dates: the apply path
refuses it before reading an application manifest or issuing a label update.

Earlier attempts encountered test timeouts and host-memory stops. The complete runs above
supersede their incomplete verification status. No threshold was weakened. Code files were
unchanged during the final run; only the verification record was updated afterward.

Code validation does not validate the archived replay or activate the candidate. AF-20261106-01
and AF-20261106-04 retain the measurement work. The ET source-code deployment and persistent
service readback remain DEPLOY-PENDING under AF-20261106-02.

## Deployment verification, 2026-11-06

Code commit `0f8f6e1d` was pushed to main and deployed using the repository deploy-and-verify
skill. Production frontend build passed. The production migration runner found no pending
migrations; live schema drift passed. The measured risk-veto restoration is applied: the three
previously bearish rows read risk_red_flags/bearish.

bharat-server restarted from D:/Github/bharat-stock-intelligence after the code commit and
remained online with HTTP 200 health. A live getScreenerDetail request for ETnow screener 713
returned biasAnalysis with policy_version semantic-v2-review-20261106 and empirical_direction
unproven. The modified canonical ranker ran as a fresh Python subprocess through its worker.
The persistent Python API services were unchanged by this deployment.

The scoped ET sync completed 3/3 screeners without failures. Each corrected Below identity
contains 100 freshly seen rows on November 6, all below its stated support; legacy Above
identities remain neutral. The restarted worker computed 4,430 fresh confluence rows, with zero
legacy support IDs. It then completed the canonical ranker with 2,367 published recommendations
and 2,367 complete penalty records, including 334 red-flag records.

Independent readback over the 2,374 eligible confluence reference names matched 2,354 stored
confluence percentiles exactly (MAE and maximum error 0.0). Reference membership precedes the
final publication skips; the 2,367 published names are not the percentile denominator. This
checks implementation and provenance, not predictive edge.

Exact code-commit CI passed: https://github.com/kanchankapila/bharat-stock-intelligence/actions/runs/42150428531
The local Node dependency audit reports zero vulnerabilities. The GitHub LangGraph alert
references versions below 1.2.14; both the manifest and installed environment contain 1.2.14.

AF-20261106-02 and AF-20261105-02 are closed on this evidence. AF-20261106-01 remains review-only;
the incomplete-capture issue and invalid archived replay remain tracked in AF-20261106-04.
