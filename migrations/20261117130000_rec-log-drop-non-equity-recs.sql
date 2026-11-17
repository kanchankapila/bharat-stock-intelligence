-- AF-20261117-21: technicalSignalsService logged index symbols as BUY recommendations (no
-- tradeable-universe filter; fixed in code the same day). Live 2026-11-17: exactly 3 such rows
-- (NIFTYIT 2026-11-11 and 11-13, NIFTYPHARMA 2026-11-17), all source = 'technical_scan'. Only
-- symbols with no equity row in nse_stocks at all are removed; recommendations for since-delisted
-- equities were valid when written and stay.
SET LOCAL lock_timeout = '5s';

DELETE FROM recommendation_log r
 WHERE r.source = 'technical_scan'
   AND NOT EXISTS (SELECT 1 FROM nse_stocks n
                    WHERE n.symbol = r.symbol AND COALESCE(n.instrument_type, 'equity') = 'equity');
