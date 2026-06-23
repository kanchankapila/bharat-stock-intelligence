"""URL -> endpoint template + typed parameter catalog (hybrid structural + entity)."""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from urllib.parse import urlsplit, parse_qsl

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_INT_RE = re.compile(r"^\d+$")
# unix-seconds plausible window: 2001-09-09 .. 2033-05-18
_EPOCH_LO, _EPOCH_HI = 1_000_000_000, 2_000_000_000


@dataclass
class ParamSpec:
    name: str
    location: str            # "path" | "query"
    inferred_type: str       # ticker|date|epoch|int_id|enum|string|const
    is_variable: bool
    distinct_count: int
    sample_values: list[str]


@dataclass
class EndpointTemplate:
    template: str
    host: str
    path_skeleton: str
    query_keys: list[str]
    method: str
    params: list[ParamSpec]
    urls: list[str] = field(default_factory=list)


def classify_value(value: str, universe: set[str]) -> str:
    v = (value or "").strip()
    if not v:
        return "string"
    if v.upper() in universe:
        return "ticker"
    if _DATE_RE.match(v):
        return "date"
    if _INT_RE.match(v):
        n = int(v)
        if len(v) == 10 and _EPOCH_LO <= n <= _EPOCH_HI:
            return "epoch"
        return "int_id"
    return "string"


def _path_segments(path: str) -> list[str]:
    return [s for s in path.split("/") if s != ""]


def _structural_key(host: str, segs: list[str], query_keys: list[str]) -> str:
    """Two URLs share a template if host, path length, and query-key set match."""
    return f"{host}|seglen={len(segs)}|q={','.join(sorted(query_keys))}"


def normalize(urls: list[str], universe: set[str]) -> list[EndpointTemplate]:
    universe = {u.upper() for u in universe}
    groups: dict[str, list[tuple]] = defaultdict(list)
    for raw in urls:
        raw = raw.strip()
        if not raw:
            continue
        sp = urlsplit(raw)
        segs = _path_segments(sp.path)
        q = parse_qsl(sp.query, keep_blank_values=True)
        qkeys = [k for k, _ in q]
        key = _structural_key(sp.netloc, segs, qkeys)
        groups[key].append((raw, sp.netloc, sp.path, segs, dict(q), qkeys))

    endpoints: list[EndpointTemplate] = []
    for members in groups.values():
        host = members[0][1]
        seg_count = len(members[0][3])
        qkeys = members[0][5]

        # Collect values per path index and per query key across members.
        path_vals: dict[int, list[str]] = {i: [] for i in range(seg_count)}
        query_vals: dict[str, list[str]] = {k: [] for k in qkeys}
        for _, _, _, segs, qd, _ in members:
            for i in range(seg_count):
                path_vals[i].append(segs[i])
            for k in qkeys:
                query_vals[k].append(qd.get(k, ""))

        params: list[ParamSpec] = []
        skeleton_segs: list[str] = []
        for i in range(seg_count):
            vals = path_vals[i]
            distinct = sorted(set(vals))
            is_var = len(distinct) > 1
            if is_var:
                itype = classify_value(distinct[0], universe)
                skeleton_segs.append("{" + itype + "}")
                params.append(ParamSpec(f"path_{i}", "path", itype, True,
                                        len(distinct), distinct[:5]))
            else:
                skeleton_segs.append(vals[0])
        path_skeleton = "/" + "/".join(skeleton_segs) + ("/" if seg_count else "")

        for k in qkeys:
            vals = query_vals[k]
            distinct = sorted(set(vals))
            is_var = len(distinct) > 1
            itype = classify_value(distinct[0], universe) if is_var else "const"
            params.append(ParamSpec(k, "query", itype, is_var,
                                    len(distinct), distinct[:5]))

        template = f"https://{host}{path_skeleton}?{'&'.join(sorted(qkeys))}"
        endpoints.append(EndpointTemplate(
            template=template, host=host, path_skeleton=path_skeleton,
            query_keys=sorted(qkeys), method="GET", params=params,
            urls=[m[0] for m in members],
        ))
    return endpoints
