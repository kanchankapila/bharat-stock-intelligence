"""Fetch every URL and record what actually came back, not just the status code.

The verify_live_urls.py script records HTTP status only. This repo's own incident
history (2026-07-23 URL-as-symbol corruption; the NSE bulk insider endpoint that
returns 200 with silently-stale data) says a 200 proves nothing. This probe records
payload shape, emptiness, and freshness so an endpoint can be judged usable or not.
"""
import json
import re
import datetime
import concurrent.futures
import requests

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
}
TIMEOUT = 25

# Repo convention: URLs in the source file carry doubled slashes from the capture tool.
def normalize(url):
    if not url:
        return url
    m = re.match(r'^(https?:)/*(.*)$', url)
    if not m:
        return url
    scheme, rest = m.groups()
    # collapse runs of slashes in the path, but preserve the // after scheme
    if '?' in rest:
        path, q = rest.split('?', 1)
        return f"{scheme}//{re.sub(r'/{2,}', '/', path)}?{q}"
    return f"{scheme}//{re.sub(r'/{2,}', '/', rest)}"


JSONP = re.compile(r'^[A-Za-z_$][\w$.]*\s*\(\s*(.*?)\s*\)\s*;?\s*$', re.S)


def parse_body(text, ctype):
    """Return (kind, obj). Handles JSON, JSONP callbacks, and HTML."""
    t = (text or '').strip()
    if not t:
        return 'empty', None
    try:
        return 'json', json.loads(t)
    except Exception:
        pass
    m = JSONP.match(t)
    if m:
        try:
            return 'jsonp', json.loads(m.group(1))
        except Exception:
            pass
    if t[:1] == '<':
        return 'html', None
    return 'text', None


def shape(obj, depth=0):
    """Compact structural summary of a parsed payload."""
    if depth > 2:
        return '...'
    if isinstance(obj, dict):
        return {k: shape(v, depth + 1) for k, v in list(obj.items())[:25]}
    if isinstance(obj, list):
        if not obj:
            return '[](0)'
        return [shape(obj[0], depth + 1), f'...x{len(obj)}']
    return type(obj).__name__


def count_records(obj):
    """Best-effort count of the primary record collection."""
    if isinstance(obj, list):
        return len(obj)
    if isinstance(obj, dict):
        best = 0
        for k, v in obj.items():
            if isinstance(v, list):
                best = max(best, len(v))
            elif isinstance(v, dict):
                best = max(best, count_records(v))
        return best
    return 0


DATE_RE = re.compile(
    r'(20[12]\d)[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])'
    r'|(0[1-9]|[12]\d|3[01])[-/](0[1-9]|1[0-2])[-/](20[12]\d)'
)


def latest_date(text, cap=400_000):
    """Newest plausible ISO/DMY date appearing anywhere in the payload."""
    found = []
    for m in DATE_RE.finditer(text[:cap]):
        if m.group(1):
            y, mo, d = m.group(1), m.group(2), m.group(3)
        else:
            d, mo, y = m.group(4), m.group(5), m.group(6)
        try:
            found.append(datetime.date(int(y), int(mo), int(d)))
        except ValueError:
            pass
    today = datetime.date.today()
    found = [f for f in found if f <= today]
    return max(found).isoformat() if found else None


def probe(item):
    raw = item.get('url')
    url = normalize(raw)
    out = {
        'url': raw,
        'normalized': url if url != raw else None,
        'description': item.get('description'),
    }
    if not url:
        out['status'] = 'no_url'
        return out
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        out['status'] = r.status_code
        out['content_type'] = (r.headers.get('Content-Type') or '')[:60]
        text = r.text
        out['bytes'] = len(r.content)
        kind, obj = parse_body(text, out['content_type'])
        out['kind'] = kind
        out['records'] = count_records(obj) if obj is not None else 0
        out['latest_date'] = latest_date(text)
        if obj is not None:
            out['shape'] = shape(obj)
        out['sample'] = text[:700]
    except requests.exceptions.Timeout:
        out['status'] = 'timeout'
    except requests.exceptions.RequestException as e:
        out['status'] = f'error: {type(e).__name__}'
    return out


def main():
    data = json.load(open('updated_urls_verified.json', encoding='utf-8'))
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(probe, it): it for it in data}
        for i, f in enumerate(concurrent.futures.as_completed(futs), 1):
            try:
                results.append(f.result())
            except Exception as e:
                results.append({'url': futs[f].get('url'), 'status': f'probe_error: {e}'})
            if i % 100 == 0:
                print(f'  {i}/{len(data)}', flush=True)
    with open('payload_probe.json', 'w', encoding='utf-8') as fh:
        json.dump(results, fh, indent=1)
    print('wrote payload_probe.json', len(results))


if __name__ == '__main__':
    main()
