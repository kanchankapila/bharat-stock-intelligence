"""Verify the endpoint corpus by what actually came back -- not just the status code.

WHY THIS WAS REWRITTEN
----------------------
The original version recorded `response.status_code` and nothing else. The 2026-07-31
endpoint-corpus review (docs/audit-2026-07-31/ENDPOINT_DATA_REVIEW_AND_QUANT_VALUE.md §1.1-1.5)
showed that criterion is insufficient in BOTH directions, and this repo has been burned by it
twice already:

  * 2026-07-23 -- a Trendlyne screener endpoint returned 200 and the parser wrote profile URLs
    into the `symbol` column. 2.1M rows across 7 tables were corrupted before a human noticed.
  * 2026-07-31 -- NSE's bulk insider endpoint returns 200 with data silently frozen at May.
    Swapping to it would have replaced live data with a 3-month-old snapshot.

Re-running the 919-URL corpus with payload inspection moved the count both ways:
  +15 recovered -- "InvalidURL" failures are doubled slashes from the capture tool
                   (https:////api...//v1//), which collapse cleanly.
  -10 exposed   -- trendlyne.com/futures-options/api-filter/* return 200 with a full
                   `tableHeaders` array and `"body":{}`. A naive row counter scores the
                   HEADERS as records. Zero rows, scored as success.

The four §1.5 changes are implemented here:
  1. Normalize `//` -> `/` in the path before requesting.
  2. Record bytes, parsed kind, row count of the PRIMARY COLLECTION (not headers), and the
     newest date found in the body.
  3. Fail a 200-with-zero-rows as `empty_ok`, distinct from `ok`.
  4. Flag any URL carrying a date/expiry in its path or query as `needs_live_param` -- it
     cannot be called verified until re-tested with a live value.

Parsing/normalization helpers are IMPORTED from probe_endpoint_payloads.py rather than
reimplemented. A second copy of a parser that drifts from the first is precisely how the
2026-07-23 corruption survived undetected.

Run:  python scripts/verify_live_urls.py
      python scripts/verify_live_urls.py --in updated_urls.json --out updated_urls_verified.json
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import re
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_endpoint_payloads import (  # noqa: E402  single source of truth for parsing
    HEADERS,
    count_records,
    latest_date,
    normalize,
    parse_body,
)

REQUEST_TIMEOUT = 25

# Anything that pins a point in time into the URL. Such an endpoint can return a confident 200
# carrying a dead contract's frozen final state (verified: smartoptions expDate=2026-05-26 gave
# 200 with 200 rows, real OI/price, IV all NULL and every Greek exactly 0.0 -- which passes a
# row-count check, a non-empty check AND a null-coverage check).
DATE_PARAM_RE = re.compile(
    r'(?:'
    r'exp(?:iry)?_?date|expdate|from_?date|to_?date|start_?date|end_?date|as_?on|asondate'
    r'|trade_?date|[?&]date=|[?&]dt='
    r')',
    re.I,
)
# A literal date embedded anywhere in the URL: 2021-01-01, 2021/01/01, 30-sep-2021.
DATE_LITERAL_RE = re.compile(
    r'(?:20[12]\d[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01]))'
    r'|(?:\d{1,2}-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-20[12]\d)',
    re.I,
)
# Undelimited 8-digit runs, which are ambiguous: NSE's own bhavcopy archive uses DDMMYYYY
# (sec_bhavdata_full_04012021.csv) while other providers use YYYYMMDD. A bare regex over
# \d{8} would also flag ordinary numeric ids, so each candidate is PARSED and only counts if
# it is a real calendar date in one of the two orders (12345678 fails both: year 1234 is out
# of range, and dd=12/mm=34 is not a month).
DIGIT8_RE = re.compile(r'(?<!\d)(\d{8})(?!\d)')


def _is_real_date8(s: str) -> bool:
    for y, m, d in ((s[0:4], s[4:6], s[6:8]), (s[4:8], s[2:4], s[0:2])):
        try:
            year = int(y)
            if 2000 <= year <= 2099:
                datetime.date(year, int(m), int(d))
                return True
        except ValueError:
            continue
    return False

# Beyond this, a payload's newest date is old enough to be worth a human look. Deliberately
# generous: quarterly financials and one-off corporate actions are legitimately old, so this
# is a flag for triage, not a failure.
STALE_AFTER_DAYS = 120

AUTH_CODES = {401, 402, 403, 407, 444, 451}


def has_pinned_date(url: str) -> bool:
    """True if the URL hardcodes a point in time, via a known param name or a literal date."""
    if not url:
        return False
    if DATE_PARAM_RE.search(url) or DATE_LITERAL_RE.search(url):
        return True
    return any(_is_real_date8(m.group(1)) for m in DIGIT8_RE.finditer(url))


def classify(status, kind, records, latest, url) -> str:
    """Turn an observed response into a verdict.

    Order matters: a transport failure outranks everything; an auth wall is distinct from a
    bad URL; and `empty_ok`/`needs_live_param` exist so a 200 can still be judged unusable.
    """
    if not isinstance(status, int):
        return str(status)                      # timeout / error:ClassName / no_url
    if status in AUTH_CODES:
        return 'auth_blocked'
    if status >= 400:
        return f'http_{status}'
    if status >= 300:
        return f'redirect_{status}'

    if kind in ('empty', None):
        return 'empty_ok'
    if kind == 'html':
        return 'not_json'                       # a JSON endpoint serving HTML is a soft failure
    if kind in ('json', 'jsonp') and not records:
        return 'empty_ok'                       # §1.3 -- 200 with zero rows is NOT success

    if has_pinned_date(url):
        # Data came back, but the URL pins a date, so what came back may be a frozen snapshot
        # of a dead window. Cannot be called verified without a live-value re-test.
        return 'needs_live_param'

    if latest:
        try:
            age = (datetime.date.today() - datetime.date.fromisoformat(latest)).days
            if age > STALE_AFTER_DAYS:
                return 'stale'
        except ValueError:
            pass
    return 'ok'


def verify_url(item: dict) -> dict:
    raw = item.get('url')
    out = dict(item)
    out['verification_timestamp'] = datetime.datetime.now(datetime.timezone.utc).isoformat()

    if not raw:
        out['verification_status'] = 'no_url'
        out['verdict'] = 'no_url'
        return out

    url = normalize(raw)
    out['normalized_url'] = url if url != raw else None

    try:
        r = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        status = r.status_code
        text = r.text
        ctype = (r.headers.get('Content-Type') or 'unknown')[:80]
        kind, obj = parse_body(text, ctype)
        records = count_records(obj) if obj is not None else 0
        latest = latest_date(text)

        out['verification_status'] = status
        out['verification_contentType'] = ctype
        out['bytes'] = len(r.content)
        out['kind'] = kind
        out['records'] = records
        out['latest_date'] = latest
    except requests.exceptions.Timeout:
        out['verification_status'] = 'timeout'
        status = kind = latest = None
        records = 0
    except requests.exceptions.RequestException as e:
        out['verification_status'] = f'error: {type(e).__name__}'
        status = kind = latest = None
        records = 0

    out['verdict'] = classify(
        out['verification_status'], out.get('kind'), out.get('records', 0),
        out.get('latest_date'), url,
    )
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--in', dest='infile', default='updated_urls.json')
    ap.add_argument('--out', dest='outfile', default='updated_urls_verified.json')
    ap.add_argument('--workers', type=int, default=12)
    args = ap.parse_args()

    try:
        with open(args.infile, 'r', encoding='utf-8') as f:
            urls_data = json.load(f)
    except FileNotFoundError:
        print(f"Error: {args.infile} not found.")
        return 1
    except json.JSONDecodeError as e:
        print(f"Error: could not decode JSON from {args.infile}: {e}")
        return 1

    start = time.time()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(verify_url, item): i for i, item in enumerate(urls_data)}
        for n, fut in enumerate(concurrent.futures.as_completed(futures), 1):
            idx = futures[fut]
            try:
                results.append((idx, fut.result()))
            except Exception as exc:
                bad = dict(urls_data[idx])
                bad['verification_status'] = f'error: {exc}'
                bad['verdict'] = f'error: {exc}'
                results.append((idx, bad))
            if n % 100 == 0:
                print(f'  {n}/{len(urls_data)}', flush=True)

    # Preserve input order for a clean diff between runs.
    ordered = [r for _, r in sorted(results, key=lambda x: x[0])]

    try:
        with open(args.outfile, 'w', encoding='utf-8') as f:
            json.dump(ordered, f, indent=2)
    except IOError as e:
        print(f"Error writing {args.outfile}: {e}")
        return 1

    counts = {}
    for r in ordered:
        counts[r.get('verdict', '?')] = counts.get(r.get('verdict', '?'), 0) + 1
    recovered = sum(1 for r in ordered if r.get('normalized_url'))

    print(f"\nVerification complete -> {args.outfile} ({time.time() - start:.1f}s)")
    print(f"  URLs normalized (doubled slashes collapsed): {recovered}")
    for verdict, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {verdict:20s} {n}")
    print("\n  'ok' is the only verdict that means usable. `empty_ok` returned 200 with zero "
          "rows;\n  `needs_live_param` pins a date in the URL and must be re-tested with a "
          "live value.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
