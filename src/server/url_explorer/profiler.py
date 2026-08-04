"""Flatten JSON responses into a per-field profile with NSE-universe overlap."""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass


@dataclass
class FieldProfile:
    field_path: str
    dtype: str
    fill_rate: float
    cardinality: int
    num_min: float | None
    num_max: float | None
    num_mean: float | None
    universe_overlap_pct: float
    changed_vs_last: bool


def flatten(obj, prefix: str = "") -> list[tuple[str, object]]:
    out: list[tuple[str, object]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.extend(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(obj, list):
        for item in obj:
            out.extend(flatten(item, prefix))
    else:
        out.append((prefix, obj))
    return out


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def profile_endpoint(results, universe, prev_paths):
    universe = {u.upper() for u in universe}
    ok = [r for r in results if r.ok and r.body]
    n_resp = len(ok) or 1

    values: dict[str, list] = defaultdict(list)
    present_in: dict[str, int] = defaultdict(int)
    for r in ok:
        try:
            payload = json.loads(r.body)
        except (ValueError, TypeError):
            continue
        seen_paths = set()
        for path, val in flatten(payload):
            values[path].append(val)
            seen_paths.add(path)
        for p in seen_paths:
            present_in[p] += 1

    profiles: list[FieldProfile] = []
    for path, vals in values.items():
        nums = [v for v in vals if _is_num(v)]
        strs = [str(v).upper() for v in vals if isinstance(v, str)]
        if nums and len(nums) >= len(strs):
            dtype = "numeric"
            nmin, nmax = float(min(nums)), float(max(nums))
            nmean = float(sum(nums) / len(nums))
        else:
            dtype = "string" if strs else "other"
            nmin = nmax = nmean = None
        overlap = (sum(1 for s in strs if s in universe) / len(strs)) if strs else 0.0
        profiles.append(FieldProfile(
            field_path=path, dtype=dtype,
            fill_rate=present_in[path] / n_resp,
            cardinality=len(set(map(str, vals))),
            num_min=nmin, num_max=nmax, num_mean=nmean,
            universe_overlap_pct=overlap,
            changed_vs_last=(path not in prev_paths) if prev_paths else False,
        ))
    return profiles
