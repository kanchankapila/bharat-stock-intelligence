"""Triage every URL in urls.txt against config/source_catalog.yaml."""
from __future__ import annotations

import re
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
        if f.host.search(u.netloc) and f.path.search(u.path + ("?" + u.query if u.query else "")):
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
