# Signal catalog

The ontology (`src/server/ontology`, version in `manifest.json`) says what a column is. This
catalog says what a *signal* is: exact formula, unit, lookback, the earliest moment it was
knowable, source table and column, measured verdict, and which other signals it needs.

- Definitions: `src/server/ontology/signals.py` (copied from each writer; the writer file is named in the text).
- Published, immutable: `v<version>.json`. A changed definition fails `test_ontology_signals.py` until `SIGNAL_CATALOG_VERSION` is bumped and a new file is exported.
- Coverage: `coverage-<date>.json`, generated from Postgres, dated. No count is written into the definitions.

```
cd src/server
python -m ontology signals validate
python -m ontology signals show oi_buildup
python -m ontology signals coverage --out ../../docs/ontology/signal_catalog/coverage-<date>.json
python -m ontology signals export        # refuses to overwrite a published version
```

`coverage` is read-only and exits 1 if a source table or column is missing. A table that times out
falls back to the latest session for symbol counts and says so in `symbols_basis`.

## Reading the relations

`requires`: the signal cannot be computed without that input. `derived_from`: computed from it
(an instrument id such as `option` is allowed, which is how "PCR is options derived" is stated).
`oi_buildup` requires `futures_oi_change`, which requires `futures_open_interest`; `pcr_oi`
requires `option_open_interest`.

## Scope of 1.0.0

Equity, index, future, option. **ETF is declared and not collected**: there is no ETF table.
Concepts: OHLCV, volume, delivery, open interest, implied volatility, corporate actions,
earnings, insider trades, breadth, momentum, mean reversion, volatility, flows, ownership,
regime, ranking. Not exhaustive: index OHLCV, sector series, news sentiment, analyst
estimates and screener signals are not yet in the catalog.

`measured` repeats what `measurement.md` and the ledger recorded, with its date. Nothing in the
catalog is evidence of edge; the ranker has no demonstrated forward-return edge.

## Changelog

- 1.1.0 (2026-11-13): adds `futures_eod` (exchange futures history, `stock_futures_eod_history`). Corrects the unit of `futures_open_interest` from "contracts" to shares (216/216 symbols identical to the exchange file on 2026-11-11). Notes the shared-mcsymbol copies in `stock_futures_oi_history`.
- 1.0.0 (2026-11-13): first release: instruments, concepts, relations; coverage snapshot 2026-11-12.
