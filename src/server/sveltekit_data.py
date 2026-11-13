"""Decode a SvelteKit ``__data.json`` page-data response (the ``devalue`` wire format).

Sites built on SvelteKit serve the data behind every page at ``<page-url>/__data.json``. It is the
same JSON the site's own front end loads, it needs no credentials, and it is not the metered API.
Tapetide's stock page (``https://tapetide.com/stocks/<SYMBOL>/__data.json``) carries the three
sections our old ``api.tapetide.com/api/v1/companies/*`` routes used to return (score, analyst
ratings, forecasts) plus fundamentals, shareholding, pledge, financials and peers.

Wire format: ``{"type": "data", "nodes": [node, ...]}``. A node is ``{"type": "skip"}`` (a layout
whose data the client already has), ``{"type": "data", "data": [...]}`` or an error. ``data`` is
devalue's flat array: element 0 is the root; objects map keys to INDEXES into the array, plain
arrays are lists of indexes, and tagged arrays (``["Date", iso]``, ``["Set", i, ...]``,
``["Map", k, v, ...]``, ``["BigInt", "123"]``, ``["null", ...]``) carry the rarer types. An element
that is a number is just that number; only a number used AS A REFERENCE is an index, with the
negative values -1 .. -6 reserved for undefined, hole, NaN, +inf, -inf and -0.
"""
from __future__ import annotations

import json
import math
from typing import Any

UNDEFINED, HOLE, NAN, POS_INF, NEG_INF, NEG_ZERO = -1, -2, -3, -4, -5, -6


class SvelteKitRedirect(Exception):
    """The route answered with a redirect instead of data (e.g. /company/BEL -> /stocks/BEL)."""

    def __init__(self, location: str):
        super().__init__(f"redirect to {location}")
        self.location = location


def unflatten(flat: list) -> Any:
    """Rebuild the value encoded in devalue's flat array (element 0 is the root)."""
    if not isinstance(flat, list) or not flat:
        raise ValueError("devalue payload must be a non-empty list")
    hydrated: dict[int, Any] = {}

    def hydrate(index: int) -> Any:
        if index == UNDEFINED or index == HOLE:
            return None
        if index == NAN:
            return math.nan
        if index == POS_INF:
            return math.inf
        if index == NEG_INF:
            return -math.inf
        if index == NEG_ZERO:
            return -0.0
        if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= len(flat):
            raise ValueError(f"bad devalue reference {index!r}")
        if index in hydrated:
            return hydrated[index]
        value = flat[index]
        if isinstance(value, list):
            if value and isinstance(value[0], str):
                tag = value[0]
                if tag == "Date":
                    out: Any = value[1]
                elif tag == "Set":
                    out = [hydrate(i) for i in value[1:]]
                elif tag == "Map":
                    it = iter(value[1:])
                    out = {str(hydrate(k)): hydrate(v) for k, v in zip(it, it)}
                elif tag == "BigInt":
                    out = int(value[1])
                elif tag == "null":
                    out = {}
                    hydrated[index] = out
                    for key, ref in zip(value[1::2], value[2::2]):
                        out[key] = hydrate(ref)
                elif tag == "Object":
                    out = hydrate(value[1])
                else:
                    raise ValueError(f"unsupported devalue tag {tag!r}")
                hydrated[index] = out
                return out
            arr: list = []
            hydrated[index] = arr
            for ref in value:
                arr.append(hydrate(ref))
            return arr
        if isinstance(value, dict):
            obj: dict = {}
            hydrated[index] = obj
            for key, ref in value.items():
                obj[key] = hydrate(ref)
            return obj
        hydrated[index] = value
        return value

    return hydrate(0)


def decode_data_json(payload: str | bytes | dict) -> dict:
    """Decode a whole ``__data.json`` response into one dict (later nodes override earlier ones).

    Raises SvelteKitRedirect for a redirect response and ValueError when no node carries data, so a
    caller can tell "the site moved the route" from "the stock has no data".
    """
    doc = json.loads(payload) if isinstance(payload, (str, bytes)) else payload
    if not isinstance(doc, dict):
        raise ValueError("__data.json must be a JSON object")
    if doc.get("type") == "redirect":
        raise SvelteKitRedirect(str(doc.get("location", "")))
    if doc.get("type") != "data" or not isinstance(doc.get("nodes"), list):
        raise ValueError(f"unexpected __data.json envelope: type={doc.get('type')!r}")
    merged: dict = {}
    seen = False
    for node in doc["nodes"]:
        if not isinstance(node, dict) or node.get("type") != "data":
            continue
        seen = True
        value = unflatten(node["data"])
        if isinstance(value, dict):
            merged.update(value)
    if not seen:
        raise ValueError("no data node in __data.json")
    return merged


# --- Tapetide: one page, three endpoint payloads -------------------------------------------------

TAPETIDE_PAGE_URL = "https://tapetide.com/stocks/{symbol}/__data.json"

# endpoint name -> (section key under ``sections``, flag name under ``sections.flags``)
TAPETIDE_SECTIONS = {
    "tapetide_score": ("score", "score"),
    "tapetide_analyst_ratings": ("analystRatings", "analyst_ratings"),
    "tapetide_forecasts": ("forecasts", "forecasts"),
}


def tapetide_payloads(decoded: dict, symbol: str) -> dict[str, dict]:
    """Split a decoded Tapetide stock page into the payloads stored per endpoint name.

    ``tapetide_score`` keeps the exact shape the parser reads (``{"data": {"score": ...}}``);
    the other two are wrapped as ``{"data": ...}``. A section the page flags as unavailable, or
    that is missing, is skipped rather than stored as an empty payload. A page whose company is not
    the requested symbol raises, so a redirect-to-another-stock cannot be filed under this one.
    """
    company = decoded.get("company") or {}
    got = str(company.get("nse_symbol") or company.get("symbol") or "").upper()
    if got != symbol.upper():
        raise ValueError(f"tapetide page is for {got or 'unknown'}, not {symbol}")
    sections = decoded.get("sections") or {}
    flags = sections.get("flags") or {}
    out: dict[str, dict] = {}
    for endpoint, (key, flag) in TAPETIDE_SECTIONS.items():
        section = sections.get(key)
        if section in (None, {}, []):
            continue
        if (flags.get(flag) or {}).get("available") is False:
            continue
        out[endpoint] = section if (endpoint == "tapetide_score" and "data" in section) else {"data": section}
    return out
