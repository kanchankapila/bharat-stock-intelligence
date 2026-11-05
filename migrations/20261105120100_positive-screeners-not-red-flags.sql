-- AF-20261105-03: two ETnow screeners describing good news were tagged bearish risk_red_flags, which
-- halved the score of every member through the red-flag veto. Master is updated too, because
-- sync_catalog_bias_from_master copies its sentiment back over the catalog.
SET LOCAL lock_timeout = '5s';

UPDATE screener_catalog
   SET signal_bias = 'bullish', category = 'fundamental_quality', subcategory = 'balance_sheet_quality'
 WHERE screener_name LIKE '18. Low Debt Stocks%' OR screener_name LIKE 'Decreasing Quarterly Losses%';

UPDATE screener_master
   SET inferred_sentiment = 'bullish', inferred_category = 'fundamental_quality'
 WHERE name LIKE '18. Low Debt Stocks%' OR name LIKE 'Decreasing Quarterly Losses%';

-- AF-20261105-05: filings from the three Asian Hotels companies were tagged to all three.
UPDATE news_articles SET symbols = 'AHLEAST' WHERE title LIKE 'Asian Hotels (East)%';
UPDATE news_articles SET symbols = 'AHLWEST' WHERE title LIKE 'Asian Hotels (West)%';
UPDATE news_articles SET symbols = 'ASIANHOTNR' WHERE title LIKE 'Asian Hotels (North)%';
