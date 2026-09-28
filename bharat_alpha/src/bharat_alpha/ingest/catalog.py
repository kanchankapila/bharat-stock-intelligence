"""Triage every URL in urls.txt against config/source_catalog.yaml, and audit the whole repo
(URL corpus + every URL written in the legacy codebase) for data hosts nobody has evaluated."""
from __future__ import annotations

import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import yaml

CATALOG = Path(__file__).resolve().parents[3] / "config" / "source_catalog.yaml"


@dataclass(frozen=True)
class Family:
    id: str
    host: re.Pattern
    path: re.Pattern
    verdict: str
    category: str
    pit: str
    rationale: str
    connector: str | None


def load_catalog(path: Path = CATALOG) -> list[Family]:
    data = yaml.safe_load(path.read_text())
    return [Family(f["id"], re.compile(f["host"]), re.compile(f["path"]), f["verdict"], f["category"],
                   str(f.get("pit")), f["rationale"], f.get("connector")) for f in data["families"]]


def normalise(url: str) -> str:
    url = url.strip()
    url = re.sub(r"^(https?:)/+", r"\1//", url)                 # 'https:////host//a//b' in the corpus
    scheme, _, rest = url.partition("//")
    return scheme + "//" + re.sub(r"/{2,}", "/", rest)


def classify(url: str, families: list[Family]) -> Family | None:
    u = urlparse(normalise(url))
    for f in families:
        if f.host.search(u.netloc) and f.path.search((u.path or "/") + ("?" + u.query if u.query else "")):
            return f
    return None


def triage(urls: list[str], families: list[Family] | None = None) -> tuple[Counter, list[str]]:
    families = families or load_catalog()
    counts: Counter = Counter()
    unmatched = []
    for url in urls:
        if not url.strip():
            continue
        f = classify(url, families)
        if f is None:
            unmatched.append(url)
        else:
            counts[f.id] += 1
    return counts, unmatched


URL_RE = re.compile(r"https?://[A-Za-z0-9._~:/?#@!$&'()*+,;=%{}-]+")
# Hosts that are not data sources: specs and schemas, CDNs and fonts, UI embeds, local services,
# test placeholders, and the repo's own domain. Anything else unclassified is a finding.
NON_DATA_HOST = re.compile(
    r"(^|\.)(w3\.org|openxmlformats\.org|edmcouncil\.org|omg\.org|purl\.org|qudt\.org|schema\.org|xbrl\.org|"
    r"iso\.org|opencypher\.org|graphdrawing\.org|microsoft\.com|googleapis\.com|gstatic\.com|"
    r"googletagmanager\.com|jsdelivr\.net|cloudflare\.com|bootstrapcdn\.com|tailwindcss\.com|cloudfront\.net|"
    r"tradingview\.com|github\.com|pytorch\.org|telegram\.org|nousresearch\.com|vitest\.dev|x\.com|"
    r"example\.(com|test|invalid)|fixture\.invalid|bharat-stock-intelligence\.dev)$"
    r"|^(localhost|127\.0\.0\.1|host)(:|$)|^images\.|^stat\d*\.|^[^.]*$|[{}$]"
    r"|^([a-dxy]|ex|ok)\.(com|example)$|\.(test|example|mc)$|^www\.mone$|\.\.|[^a-z0-9.:-]")   # test placeholders
SKIP_PATHS = re.compile(r"^(node_modules|graphify-out|\.claude/worktrees|bharat_alpha)/|package-lock\.json$")


def extract_urls(text: str) -> set[str]:
    return {re.sub(r"[)'\",;.]+$", "", u) for u in URL_RE.findall(text)}


def audit(repo: Path, families: list[Family] | None = None) -> dict:
    """Every URL in the corpus files and in git-tracked legacy files -> its family; unclassified
    URLs on a real (non-NON_DATA_HOST) host are returned as `unevaluated`."""
    families = families or load_catalog()
    files = subprocess.run(["git", "ls-files"], cwd=repo, capture_output=True, text=True, check=True).stdout.split()
    urls: set[str] = set()
    for f in files:
        if SKIP_PATHS.search(f):
            continue
        try:
            urls |= extract_urls((repo / f).read_bytes().decode("utf-8", "ignore"))
        except OSError:
            continue
    by_verdict: Counter = Counter()
    by_family: Counter = Counter()
    unevaluated: dict[str, list[str]] = {}
    for u in sorted(urls):
        fam = classify(u, families)
        if fam is not None:
            by_verdict[fam.verdict] += 1
            by_family[fam.id] += 1
            continue
        host = urlparse(normalise(u)).netloc.lower()
        if not host or NON_DATA_HOST.search(host):
            continue
        unevaluated.setdefault(host, []).append(u)
    return {"urls": len(urls), "by_verdict": dict(by_verdict), "by_family": dict(by_family), "unevaluated": unevaluated}
