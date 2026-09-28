# bharat_alpha

A point-in-time, self-grading prediction engine for NSE equities. It is a from-scratch rewrite
of this repository's platform, designed around the failure modes that repository recorded in
`.claude/rules/`.

- Design and the list of legacy failures it closes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Data sources and the triage of all 1,995 URLs in `urls.txt`: [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)

## What to expect from it

It ranks the liquid NSE universe for 5- and 21-session horizons. It records every prediction,
grades it against what happened, reweights and recalibrates itself from those grades,
retrains on schedule or when it degrades, and publishes an `edge_status` next to every ranking.

It does **not** promise high accuracy. The legacy platform's own measurements put the
achievable cross-sectional edge at roughly rank IC 0.05, and most factors turned negative after
costs. This system's job is to find whatever edge exists, prove it, and refuse to present an
unproven ranking as trustworthy. On the synthetic market in `sim.py`:

- with a planted edge, it passes the gate (out-of-fold IC 0.078, Newey–West t = 8.1, net
  excess after costs t = 3.1);
- on pure noise, it refuses (IC t = 1.3, net t = −0.3).

Both runs are regression tests.

## Quickstart

```bash
pip install -e '.[dev]'
export BQA_DATABASE_URL=postgresql://user:pass@host:5432/db     # required; there is no fallback
bqa init-db                                    # migrations + schema verification

# history: either import the legacy database (fast) …
bqa import-legacy "$LEGACY_DSN" 2021-01-01 2026-09-25
# … or pull exchange files directly
bqa ingest nse_bhavcopy --start 2021-01-01
bqa ingest nse_index_close --start 2021-01-01
bqa ingest nse_fo_bhavcopy --start 2024-07-01
bqa prepare                                    # suspect flags + corporate-action factors

bqa train --horizon 21                         # walk-forward, cost-aware report, gate
bqa train --horizon 5
bqa daily                                      # one session end to end
bqa scheduler &                                # every evening from 19:00 IST, with catch-up
bqa serve --host 0.0.0.0                       # /recommendations /stock/{sym} /models /health
```

To run everything offline on the synthetic market (this wipes schema `alpha`): `bqa demo`.

`docker compose up` runs Postgres, the scheduler and the API (set `BQA_DB_PASSWORD`).

## Tests

```bash
pytest -q                                      # real, empty Postgres per session (BQA_TEST_ADMIN_DSN)
RUN_LIVE_DATASOURCE_TESTS=1 pytest tests/test_live_sources.py   # hits NSE / InvestSights
```

## Cutover from the legacy platform

1. Run it alongside the legacy platform on the same Postgres instance. It only touches schema
   `alpha`.
2. `bqa import-legacy` for history, then `bqa train` for both horizons, then start the
   scheduler.
3. Let the ledger accumulate at least 20 effective dates (about 100 sessions at h=5). Then
   compare its realised track record (`/models`, `/recommendations` → `realized_track_record`)
   with the legacy `unified_recommendations` over the same dates, using the panel spec in
   `.claude/rules/measurement.md`.
4. Only then point consumers at `/recommendations`. Two earlier rebuilds (`greenfield/`,
   `bharatquant/`) were never wired in, so a rebuild is not finished until it is running and
   graded in production.
