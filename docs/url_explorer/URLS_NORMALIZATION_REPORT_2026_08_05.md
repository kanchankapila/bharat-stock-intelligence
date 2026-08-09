# URLs Normalization Report (2026-08-05)

Input: urls.txt
Output: urls.normalized.txt
Changes log: docs/url_explorer/urls_normalization_changes_2026_08_05.tsv

## Summary

- input_lines: 1983
- output_lines: 1983
- empty_lines_removed: 0
- non_http_lines_removed: 0
- changed_lines: 32
- malformed_https_slashes_before: 15
- malformed_https_slashes_after: 0
- unique_urls_before: 1983
- unique_urls_after: 1980

## What Was Normalized

- Fixed malformed scheme slashes: `https:////...` -> `https://...`
- Collapsed repeated path slashes: `//path//segment//` -> `/path/segment/`
- Normalized host/scheme casing and removed default ports if present.
- Preserved query strings and fragments.

## Duplicate Reduction Signal

Normalization converged 3 entries to canonical duplicates:

- https://appfeeds.moneycontrol.com/jsonapi/market/graph&format=json&ind_id=38&range=1d&type=line
- https://appfeeds.moneycontrol.com/jsonapi/market/graph&format=json&ind_id=38&range=1d&type=ohlc
- https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/in%3BNSX

## Representative Before/After Changes

- `https:////api.moneycontrol.com//mcapi//v1//swot//details?scId=BE03&type=all`
  -> `https://api.moneycontrol.com/mcapi/v1/swot/details?scId=BE03&type=all`
- `https://priceapi.moneycontrol.com//pricefeed//techindicator//W//in%3Bnbx`
  -> `https://priceapi.moneycontrol.com/pricefeed/techindicator/W/in%3Bnbx`
- `https://frapi.marketsmojo.com/market_events/getData?`
  -> `https://frapi.marketsmojo.com/market_events/getData`

## Repeatable Command

`npm run urls:normalize`
