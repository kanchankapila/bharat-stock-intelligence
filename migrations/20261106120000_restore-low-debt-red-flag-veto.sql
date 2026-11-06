-- AF-20261105-03 reversed: 20261105120100 relabelled these two ETnow screeners bullish, which removed
-- the x0.5 red-flag veto from their members. Replayed over 45 batches (2026-09-01..11-04) the vetoed
-- names trailed the Hold cohort they would have joined by -0.33%/day (t -2.91), so the veto stays
-- until a measurement says otherwise. Restores only the rows that were bearish before 20261105120100;
-- the slug row for Decreasing Quarterly Losses was already bullish and is left alone. The prior
-- subcategory was not recorded; the classifier's risk rule value is used (the ranker ignores it).
SET LOCAL lock_timeout = '5s';

UPDATE screener_catalog
   SET signal_bias = 'bearish', category = 'risk_red_flags', subcategory = 'financial_or_governance_risk'
 WHERE (source = 'ETnow' AND screener_id IN ('8486', '8651'))
    OR (source = 'etnow' AND screener_id LIKE '18-low-debt-stocks%');

UPDATE screener_master
   SET inferred_sentiment = 'bearish', inferred_category = 'risk_red_flags'
 WHERE source = 'ETnow' AND scan_id IN ('8486', '8651');
