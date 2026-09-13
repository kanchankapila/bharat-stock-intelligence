"""One polite, resumable sample fetch per never-fetched GET catalog template.

Selection: GET templates with no url_fetches history, excluding rows whose
verified_json shows zero HTTP-200 evidence (access-controlled-or-retired — those
need the route-by-route probe from data-sources.md, not another blind GET).
One sample URL per template (a 200-verified member when the evidence file is
supplied). Per-host delay table on top of the base delay; global
consecutive-failure breaker.

After each fetch: url_fetches row, field profile, ticker-keyed correlations vs
trailing-return targets (populates url_fields / url_field_correlations), and
record_health on the catalog row. Re-running only picks up templates that still
have no fetch history, so the pass is resumable and a failed template stays
truthfully failed unless --refetch-failed is passed.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from . import store
from .correlator import correlate_endpoint
from .explore import load_universe
from .fetcher import FetchResult
from .ingest import load_unique_urls, load_verification_evidence, load_json_records
from .normalizer import normalize
from .profiler import profile_endpoint

REPO_ROOT = Path(__file__).resolve().parents[3]

# Hosts with WAF/allowance history get extra spacing (trendlyne WAF allowance in
# memory, moneycontrol throttling, NSE cookie-gating). Everything else rides the base.
HOST_DELAYS = {
    "kayal.trendlyne.com": 2.0,
    "trendlyne.com": 2.0,
    "smartoptions.trendlyne.com": 2.0,
    "api.moneycontrol.com": 1.5,
    "priceapi.moneycontrol.com": 1.5,
    "www.moneycontrol.com": 1.5,
    "appfeeds.moneycontrol.com": 1.5,
    "www.nseindia.com": 2.5,
    "www.ndtvprofit.com": 2.0,
}
BASE_DELAY = 1.0

# Browser-identical request surface, ported from D:/Github/urls-explorer/extract_urls.py
# (+127% JSON fetch success there vs bare requests — many of these hosts verify
# UA/Accept/Referer before answering). curl_cffi keeps the TLS-fingerprint
# impersonation that trendlyne-class WAFs require.
_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                  " (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "Cache-Control": "max-age=0",
    "Pragma": "no-cache",
}


def _domain_headers(url: str) -> dict[str, str]:
    sp = urlsplit(url)
    headers = {}
    if sp.netloc:
        headers["Referer"] = f"https://{sp.netloc}/"
        headers["Origin"] = f"https://{sp.netloc}"
    if any(x in sp.netloc for x in ("indiatimes.com", "finology", "stockedge")):
        headers["X-Requested-With"] = "XMLHttpRequest"
    return headers


_CFFI_SESSION = None


def _session():
    """Persistent impersonated session — cookies accumulate across the whole pass,
    exactly like urls-explorer's requests.Session run (their +127% JSON success)."""
    global _CFFI_SESSION
    if _CFFI_SESSION is None:
        from curl_cffi import requests as cffi
        _CFFI_SESSION = cffi.Session(impersonate="chrome120")
    return _CFFI_SESSION


_URL_SCHEME_RE = re.compile(r"^(https?:)/*", re.IGNORECASE)


def normalize_url(url: str) -> str:
    """urls-explorer's normalize_url_and_method repair step: browser-copied
    https:///host//path forms -> https://host/path (requests/curl reject the rest)."""
    url = _URL_SCHEME_RE.sub(r"\1//", url.strip())
    try:
        parts = urlsplit(url)
        if parts.scheme and parts.netloc:
            path = re.sub(r"/{2,}", "/", parts.path)
            url = urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))
    except ValueError:
        pass
    return url


def referer_fallbacks(url: str) -> list[str]:
    """urls-explorer's portal-specific referer ladder for 403-walled endpoints."""
    domain = urlsplit(url).netloc.lower()
    referers = [f"https://{domain}/"]
    if "finology.in" in domain:
        referers += ["https://ticker.finology.in/",
                     "https://ticker.finology.in/company/WIPRO",
                     "https://www.finology.in/"]
    elif "moneycontrol.com" in domain:
        referers += ["https://www.moneycontrol.com/",
                     "https://www.moneycontrol.com/stocksmarketsindia/"]
    elif "tickertape.in" in domain:
        referers += ["https://www.tickertape.in/",
                     "https://www.tickertape.in/stocks/"]
    return list(dict.fromkeys(referers))


def _fetch_once(url: str):
    r = _session().get(url, headers={**_BROWSER_HEADERS, **_domain_headers(url)},
                       timeout=20, allow_redirects=True)
    return r.status_code, r.text, r.headers.get("content-type", "")


def make_fetch_fn(retries: int = 4, once=_fetch_once):
    """urls-explorer's fetch ladder (extract_urls.py), ported:
    1. normalize_url repairs browser-copied https:///host//path forms
    2. patient retries on transport/429/5xx with exponential-ish backoff
       (their HTTPAdapter: Retry(5, backoff 0.5, forcelist 500/502/503/504))
    3. a definitive 403 gets the portal-specific referer fallback ladder with
       X-Requested-With before giving up (4xx otherwise = measurement, no retry)
    GET uses injectable once(); everything rides the shared impersonated session
    so cookies persist across the pass."""
    def _send(method: str, url: str, headers: dict, payload=None):
        s = _session()
        if method == "POST":
            r = s.post(url, json=payload if payload is not None else {},
                       headers=headers, timeout=20, allow_redirects=True)
        else:
            r = s.get(url, headers=headers, timeout=20, allow_redirects=True)
        return (r.status_code, r.text, r.headers.get("content-type", ""))

    def fetch(attempt: dict):
        url = normalize_url(attempt["url"])
        method = (attempt.get("method") or "GET").upper()
        payload = attempt.get("payload")
        last = (0, "", "")
        for i in range(retries + 1):
            try:
                if method == "POST":
                    h = {**_BROWSER_HEADERS, **_domain_headers(url),
                         **(attempt.get("headers") or {})}
                    h.setdefault("Content-Type", "application/json")
                    h.setdefault("X-Requested-With", "XMLHttpRequest")
                    status, body, ctype = _send(method, url, h, payload)
                else:
                    status, body, ctype = once(url)
            except Exception as e:  # noqa: BLE001 — transport failure is recorded data
                status, body, ctype = 0, "", str(e)
            if 200 <= status < 300 or (400 <= status < 500 and status != 429):
                if status == 403:
                    for ref in referer_fallbacks(url):
                        rsp = urlsplit(ref)
                        h = {**_BROWSER_HEADERS, **_domain_headers(url),
                             "Referer": ref, "Origin": f"{rsp.scheme}://{rsp.netloc}",
                             "X-Requested-With": "XMLHttpRequest",
                             "Accept-Encoding": "gzip, deflate"}
                        try:
                            st2, b2, c2 = _send(method, url, h, payload)
                        except Exception:  # noqa: BLE001
                            continue
                        if 200 <= st2 < 300:
                            return st2, b2, c2
                        status, body, ctype = st2, b2, c2
                return status, body, ctype
            last = (status, body, ctype)
            if i < retries:
                time.sleep(min(3.0, 0.5 * (2 ** i)))
        return last
    return fetch


def unwrap_payload(body: str) -> str:
    """Normalize a response body into JSON text for the profiler: strip BOM,
    unwrap JSONP callbacks, extract __NEXT_DATA__ from HTML pages."""
    if not body:
        return body
    text = body.lstrip("﻿").strip()
    if text[:1] in "{[":
        return text
    m = re.match(r"^\s*[$A-Za-z_][\w$.]*\s*\(\s*(.*)\s*\)\s*;?\s*$", text, re.DOTALL)
    if m:
        return m.group(1).rstrip(";")
    m = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', body, re.DOTALL)
    if m:
        return m.group(1)
    return body


def build_template_members(universe) -> dict[str, list[str]]:
    records = load_json_records()
    records.extend(load_unique_urls()[0])
    from .ingest import load_ue_successes, split_url_line
    records.extend(load_ue_successes())  # urls-explorer's proven-200 requests
    corpus: list[str] = []
    from .ingest import split_url_line
    for r in records:
        # Repair at the member level too: a raw `https:////...` form from one source
        # otherwise forms its own empty-host template group and can be selected as
        # a sample (curl rejects it — seen in the 2026-09-13 pilot).
        corpus.extend(split_url_line(r.url)[0])
    members: dict[str, list[str]] = {}
    for ep in normalize([u for u in corpus if u], universe):
        if ep.urls:
            members[ep.template] = ep.urls
    return members


def select_post_targets(refetch_failed: bool = False) -> list[tuple[int, str]]:
    from db_compat import query_all
    fail_cond = "AND f.ok = 1" if refetch_failed else ""
    rows = query_all(
        "SELECT e.id, e.template, e.verified_json FROM url_endpoints e"
        " WHERE e.method = 'POST'"
        " AND NOT EXISTS (SELECT 1 FROM url_fetches f"
        f" WHERE f.endpoint_id = e.id {fail_cond})")
    out: list[tuple[int, str]] = []
    for r in rows:
        v = None
        if r["verified_json"]:
            try:
                v = json.loads(r["verified_json"])
            except ValueError:
                v = None
        if v and v.get("ok", 0) == 0:
            continue  # zero-200 evidence — access-controlled-or-retired
        out.append((int(r["id"]), r["template"]))
    return out


def load_post_instances() -> dict[str, list[dict]]:
    from db_compat import query_all
    try:
        rows = query_all(
            "SELECT provider, scan_id, name, endpoint, query_condition"
            " FROM screener_instances")
    except Exception:
        return {}
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["endpoint"], []).append(dict(r))
    return out


def _decode_query_condition(qc: str):
    """ETnow query_condition is double-JSON-encoded (a JSON string containing JSON)."""
    try:
        payload = json.loads(qc)
    except (TypeError, ValueError):
        return None
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return None
    return payload if isinstance(payload, dict) else None


def _provider_post_headers(endpoint: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json",
               "Referer": f"https://{urlsplit(endpoint).netloc}/",
               "Origin": f"https://{urlsplit(endpoint).netloc}"}
    if "indiatimes" in endpoint:
        headers["Referer"] = "https://economictimes.indiatimes.com/"
        headers["Origin"] = "https://economictimes.indiatimes.com"
    return headers


def select_targets(refetch_failed: bool = False) -> tuple[list[tuple[int, str, int]], int]:
    from db_compat import query_all
    fail_cond = "AND f.ok = 1" if refetch_failed else ""
    rows = query_all(
        "SELECT e.id, e.template, e.verified_json FROM url_endpoints e"
        " WHERE e.method = 'GET'"
        " AND NOT EXISTS (SELECT 1 FROM url_fetches f"
        f" WHERE f.endpoint_id = e.id {fail_cond})")
    targets: list[tuple[int, str, int]] = []
    excluded_dead = 0
    for r in rows:
        tier = 2  # no evidence — measure it
        if r["verified_json"]:
            try:
                v = json.loads(r["verified_json"])
            except ValueError:
                v = None
            if v and v.get("ok", 0) == 0:
                excluded_dead += 1
                continue
            if v and v.get("ok"):
                tier = 1  # external evidence says alive — try these first
        targets.append((int(r["id"]), r["template"], tier))
    return targets, excluded_dead


def build_plan(universe, catalog_path: str | None = None,
               refetch_failed: bool = False,
               post_samples: int = 20) -> tuple[list[dict], dict]:
    members = build_template_members(universe)
    verified = {}
    if catalog_path:
        verified, _ = load_verification_evidence(Path(catalog_path))
    targets, excluded_dead = select_targets(refetch_failed)
    # urls-explorer's proven-200 URLs: sample these first when a template has one —
    # they are requests that verifiably worked from this codebase's lineage.
    from .ingest import load_ue_successes
    ue_ok = {r.url for r in load_ue_successes()}
    plan: list[dict] = []
    needs_id = junk_host = valueless = 0
    for eid, template, tier in targets:
        urls = members.get(template)
        if not urls:
            if "{" in template:
                needs_id += 1  # registry-only template; needs stocklist rendering
                continue
            if "." not in urlsplit(template).netloc:
                junk_host += 1  # e.g. the pre-session test row https://h/p/?x
                continue
            urls = [template]  # concrete registry template, no id placeholders

        def _usable(u: str) -> bool:
            # A URL with query keys but every value empty is a catalog definition,
            # not a request — GETting it verbatim just harvests 404s (pilot, 2026-09-13).
            q = parse_qsl(urlsplit(u).query, keep_blank_values=True)
            return not q or any(v.strip() for _, v in q)

        ranked = sorted(urls, key=lambda u: (u not in ue_ok,
                                             verified.get(u) != 200, not _usable(u)))
        sample = ranked[0]
        if not _usable(sample) or "." not in urlsplit(sample).netloc:
            valueless += 1
            continue
        plan.append({"endpoint_id": eid, "template": template,
                     "attempts": [{"url": sample}], "tier": tier})
    post_rows = select_post_targets(refetch_failed)
    post_instances = load_post_instances()
    post_no_instances = 0
    for eid, template in post_rows:
        instances = post_instances.get(template) or []
        attempts = []
        for inst in instances[:post_samples]:
            payload = _decode_query_condition(inst.get("query_condition") or "")
            if payload is None:
                continue
            if "pagesize" in payload:
                # urls-explorer's bulk-extraction recipe: widen the page, same filter
                payload["pagesize"] = 250
            attempts.append({"url": inst["endpoint"], "method": "POST",
                             "payload": payload,
                             "headers": _provider_post_headers(inst["endpoint"])})
        if not attempts:
            post_no_instances += 1
            continue
        plan.append({"endpoint_id": eid, "template": template,
                     "attempts": attempts, "tier": 1})

    stats = {"targets": len(plan), "excluded_zero_200": excluded_dead,
             "skipped_needs_id": needs_id, "skipped_junk_host": junk_host,
             "skipped_valueless": valueless, "post_families": len(post_rows),
             "post_no_instances": post_no_instances}
    # Host-interleave so the global breaker can't sit on one host's dead cluster,
    # evidence-alive tiers first within each host.
    by_host: dict[str, list[dict]] = {}
    for item in sorted(plan, key=lambda x: x["tier"]):
        by_host.setdefault(urlsplit(item["attempts"][0]["url"]).netloc.lower(), []).append(item)
    interleaved: list[dict] = []
    while any(by_host.values()):
        for q in by_host.values():
            if q:
                interleaved.append(q.pop(0))
    return interleaved, stats


def _host_delay(url: str, base: float = BASE_DELAY) -> float:
    return HOST_DELAYS.get(urlsplit(url).netloc.lower(), base)


def load_trailing_return_targets(windows=(5, 20)) -> dict[str, dict[str, float]]:
    """Same shape as returns.load_return_targets, computed from the last N closes
    per symbol instead of pulling all 10.2M stock_ohlcv rows through the ORM."""
    from db_compat import query_all
    max_w = max(windows)
    rows = query_all(
        f"""SELECT symbol, close FROM (
              SELECT symbol, close,
                     ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
              FROM stock_ohlcv WHERE close IS NOT NULL AND close > 0
            ) t WHERE rn <= {int(max_w) + 1} ORDER BY symbol, rn DESC""")
    series: dict[str, list[float]] = {}
    for r in rows:
        series.setdefault(r["symbol"], []).append(float(r["close"]))
    targets: dict[str, dict[str, float]] = {}
    for w in windows:
        trail = {}
        for sym, closes in series.items():
            if len(closes) > w and closes[w] > 0:
                trail[sym] = closes[0] / closes[w] - 1.0
        targets[f"trailing_ret_{w}d"] = trail
    return targets


def execute_pass(plan, fetch_fn, returns_by_target, universe,
                 delay_base: float = BASE_DELAY, progress_every: int = 25,
                 host_fail_cap: int = 10, transport_breaker: int = 15) -> dict:
    run_at = datetime.now(timezone.utc).isoformat()
    endpoints_ok = endpoints_fail = attempts_ok = attempts_fail = 0
    n_fields = n_corr = skipped_capped = 0
    host_consec: dict[str, int] = {}
    capped_hosts: set[str] = set()
    transport_consec = 0
    host_fails: dict[str, int] = {}
    for i, item in enumerate(plan, 1):
        first_host = urlsplit(item["attempts"][0]["url"]).netloc.lower()
        if first_host in capped_hosts:
            skipped_capped += len(item["attempts"])
            continue
        eid = item["endpoint_id"]
        results = []
        any_ok = False
        last_err = None
        for att in item["attempts"]:
            url = att["url"]
            time.sleep(_host_delay(url, delay_base) * (0.7 + 0.6 * random.random()))
            t0 = time.time()
            try:
                status, body, ctype = fetch_fn(att)
                ok = 200 <= status < 300 and body is not None
                err = None if ok else f"http {status}"
            except Exception as e:  # noqa: BLE001 — a fetch failure is recorded data, not a crash
                status, body, ctype, ok, err = 0, "", "", False, str(e)
            latency = int((time.time() - t0) * 1000)

            params_json = json.dumps(att["payload"]) if att.get("payload") else "{}"
            store.insert_fetch(eid, url, params_json, status, latency, ok,
                               len(body or ""), body, err)
            results.append(FetchResult(None, url, status, latency, ok,
                                       unwrap_payload(body) if body else body,
                                       ctype, err))
            host = urlsplit(url).netloc.lower()
            if ok:
                any_ok = True
                attempts_ok += 1
                host_consec[host] = 0
                transport_consec = 0
            else:
                attempts_fail += 1
                last_err = err
                host_fails[host] = host_fails.get(host, 0) + 1
                host_consec[host] = host_consec.get(host, 0) + 1
                if host_consec[host] >= host_fail_cap:
                    capped_hosts.add(host)
                # 404/403 on a synthetic endpoint is a measurement, not a network problem.
                # Only transport-level failures (unreachable, throttling) trip the breaker.
                if status == 0 or status in (429, 503):
                    transport_consec += 1
        prev = store.last_run_field_paths(eid)
        profiles = profile_endpoint(results, universe, prev)
        for p in profiles:
            store.insert_field(eid, run_at, p)
        cors = []
        if any_ok and returns_by_target:
            cors = correlate_endpoint(results, profiles, returns_by_target, universe)
            for c in cors:
                store.insert_correlation(eid, run_at, c)
        n_fields += len(profiles)
        n_corr += len(cors)
        if any_ok:
            endpoints_ok += 1
        else:
            endpoints_fail += 1
        store.record_health(eid, any_ok, last_err)
        if i % progress_every == 0:
            print(f"[FETCH-PASS] {i}/{len(plan)} eps_ok={endpoints_ok}"
                  f" eps_fail={endpoints_fail} att_ok={attempts_ok}"
                  f" att_fail={attempts_fail} fields={n_fields} corr={n_corr}",
                  flush=True)
        if transport_consec >= transport_breaker:
            print(f"[FETCH-PASS] transport breaker: {transport_consec} consecutive"
                  f" unreachable/throttled responses — stopping; re-run resumes",
                  flush=True)
            break
    return {"endpoints_ok": endpoints_ok, "endpoints_fail": endpoints_fail,
            "attempts_ok": attempts_ok, "attempts_fail": attempts_fail,
            "fields": n_fields, "correlations": n_corr, "host_fails": host_fails,
            "skipped_host_cap": skipped_capped, "capped_hosts": sorted(capped_hosts)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Polite sample-fetch pass over never-fetched GET catalog templates.")
    ap.add_argument("--dry", action="store_true", help="list the plan, fetch nothing")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--catalog", default=None,
                    help="datasource_catalog.md path; prefers 200-verified sample URLs")
    ap.add_argument("--refetch-failed", action="store_true",
                    help="also retry templates whose only fetches failed")
    ap.add_argument("--post-samples", type=int, default=20,
                    help="POST instances sampled per screener family")
    ap.add_argument("--host-fail-cap", type=int, default=10,
                    help="consecutive same-host failures before skipping that host")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    universe = load_universe()
    plan, stats = build_plan(universe, args.catalog, args.refetch_failed,
                             post_samples=args.post_samples)
    host_fail_cap = args.host_fail_cap
    if args.limit:
        plan = plan[:args.limit]
    print(f"[FETCH-PASS] plan: {len(plan)} targets (excluded zero-200:"
          f" {stats['excluded_zero_200']}, needs-id: {stats['skipped_needs_id']},"
          f" junk-host: {stats['skipped_junk_host']},"
          f" valueless-template: {stats['skipped_valueless']})", flush=True)
    if args.dry:
        for item in plan[:30]:
            print(f"  {item['template']}")
        if len(plan) > 30:
            print(f"  … +{len(plan) - 30} more")
        return 0
    if not plan:
        print("[FETCH-PASS] nothing to fetch", flush=True)
        return 0
    returns_by_target = load_trailing_return_targets()
    print("[FETCH-PASS] return targets:"
          f" {[(t, len(r)) for t, r in returns_by_target.items()]}", flush=True)

    summary = execute_pass(plan, make_fetch_fn(), returns_by_target, universe,
                           host_fail_cap=host_fail_cap)
    print(f"[FETCH-PASS] done: endpoints ok={summary['endpoints_ok']}"
          f" fail={summary['endpoints_fail']}; attempts ok={summary['attempts_ok']}"
          f" fail={summary['attempts_fail']}; fields={summary['fields']}"
          f" correlations={summary['correlations']}", flush=True)
    if summary["capped_hosts"]:
        print(f"[FETCH-PASS] hosts capped after repeated failures"
              f" ({summary['skipped_host_cap']} targets skipped):"
              f" {', '.join(summary['capped_hosts'])}", flush=True)
    for host, n in sorted(summary["host_fails"].items(), key=lambda kv: -kv[1])[:10]:
        print(f"  failures {host}: {n}", flush=True)

    out = Path(args.out) if args.out else (
        REPO_ROOT / "docs" / "url_explorer"
        / f"fetch_pass_{datetime.now(timezone.utc).date().isoformat()}.md")
    out.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"# Fetch pass — {datetime.now(timezone.utc).date().isoformat()}",
             "",
             f"- endpoints ok: {summary['endpoints_ok']} / fail: {summary['endpoints_fail']}"
             f" (attempts ok {summary['attempts_ok']} / fail {summary['attempts_fail']})",
             f"- field profiles written: {summary['fields']}",
             f"- correlations written: {summary['correlations']}",
             "", "## Failures by host", ""]
    if summary["host_fails"]:
        lines += [f"- {host}: {n}" for host, n
                  in sorted(summary["host_fails"].items(), key=lambda kv: -kv[1])]
    else:
        lines.append("- none")
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[FETCH-PASS] summary -> {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

