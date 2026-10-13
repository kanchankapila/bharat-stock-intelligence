-- The endpoint-discovery sweep classified ordinary HTTP GET snapshots as REALTIME_TICK.
-- None of these routes is a streaming/exchange tick feed: the quote routes return one
-- point-in-time payload per poll and techindicator/D|W|M returns periodic indicators.
DO $$
BEGIN
  IF to_regclass('public.market_endpoint_registry') IS NULL THEN
    RETURN;
  END IF;

  UPDATE market_endpoint_registry
     SET update_frequency = CASE
           WHEN target_url ~ '/pricefeed/techindicator/[DWM]/' THEN 'DAILY_EOD'
           ELSE 'INTRADAY_SNAPSHOT'
         END,
         use_case = CASE
           WHEN target_url ~ '/pricefeed/techindicator/[DWM]/'
             THEN 'Returns an HTTP technical-indicator snapshot for a D/W/M interval; not a streaming or exchange tick feed.'
           ELSE 'Returns one HTTP quote snapshot per poll; not a streaming or exchange tick feed.'
         END
   WHERE update_frequency = 'REALTIME_TICK'
     AND target_url LIKE 'https://priceapi.moneycontrol.com/pricefeed/%';
END $$;
