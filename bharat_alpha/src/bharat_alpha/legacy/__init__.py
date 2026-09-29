"""Bridge from the legacy platform's data to this engine, driven by the legacy ONTOLOGY.

The legacy repo already has the semantic mapping this needs: `src/server/ontology/` binds 729
(table, column) pairs to properties that say whether each column is a feature, a label, a
probability, a vendor opinion or a leak, with its timing class and point-in-time notes, and
gives each table a card (grain, freshness column, expected lag, training verdict, caveats).
Nothing in the legacy training code consumes it — ml_ensemble.py hand-lists its columns.

This module turns that ontology into an explicit, reviewable import map
(config/legacy_feature_map.yaml):
  * only columns the ontology itself calls trainable (PropertyDef.is_feature: never a label,
    probability, text/json, or high/target leakage) on cards whose verdict is 'allowed' or
    'caution' — derived from the ontology, never a hand-kept list;
  * each entry states HOW it becomes point-in-time: the capture timestamp when the card has
    one, the row's own timestamp for event tables, or the row's date + the card's expected
    publication lag;
  * shapes the importer cannot map one-row-per-(symbol, date) (per-strike, per-expiry, per-id)
    are listed as `needs_spec`, not silently flattened;
  * legacy MODEL outputs (derivation 'platform') are listed but disabled by default: stacking
    another engine's score couples this one to that engine staying alive, and those scores
    measured ~no edge in the legacy harness.
"""
from __future__ import annotations

import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

MAP_PATH = Path(__file__).resolve().parents[3] / "config" / "legacy_feature_map.yaml"
DEFAULT_ONTOLOGY_ROOT = Path(__file__).resolve().parents[4] / "src" / "server"

SYMBOL_COLS = ("symbol",)
DATE_COLS = ("date", "as_of_date", "trade_date", "date_iso")
TIMESTAMP_COLS = ("computed_at",)
CAPTURE_COLS = ("captured_at", "fetched_at", "ingested_at")
DEFAULT_EOD_LAG_HOURS = 3.0          # 15:30 close + 3h = 18:30, same as the bhavcopy's knowable time
NUMERIC = ("integer", "decimal", "boolean")
# Legacy tables this engine already sources first-hand (exchange files / its own importer):
# importing them again would double-count one fact under two names.
SUPERSEDED = {
    "stock_ohlcv": "prices come from the NSE bhavcopy connector",
    "stock_delivery_data": "delivery % comes from the NSE bhavcopy connector",
    "stock_delivery_volume": "delivery % comes from the NSE bhavcopy connector",
    "analyst_estimates_history": "imported point-in-time by `bqa import-estimates`",
}


@dataclass
class MapEntry:
    table: str
    column: str
    symbol_col: str | None
    date_col: str | None
    knowable: str                     # 'capture:<col>' | 'timestamp:<col>' | 'eod_plus:<hours>'
    derivation: str
    training_use: str
    timing: str
    status: str                       # 'ready' | 'needs_spec'
    enabled: bool
    note: str

    @property
    def source(self) -> str:
        return f"legacy:{self.table}"

    @property
    def feature_name(self) -> str:
        return f"x_{self.table}__{self.column}"


def load_ontology(root: Path = DEFAULT_ONTOLOGY_ROOT):
    root = Path(root)
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from ontology.definitions import build_ontology    # stdlib-only package in the legacy repo

    return build_ontology()


def _pk_cols(grain: str) -> list[str]:
    return [c.strip() for c in grain.strip("() ").split(",") if c.strip()]


def generate_map(onto) -> list[MapEntry]:
    out: list[MapEntry] = []
    for card in onto.cards:
        if card.training_use not in ("allowed", "caution"):
            continue
        feats = card.feature_columns(onto)
        props = {b.column: onto.property_by_name(b.property) for b in onto.bindings_for_table(card.table)}
        # a table whose trainable columns are mostly legacy MODEL output is a model-output table:
        # its rows exist only for names that model picked (selection), so none of it is enabled
        platform_share = (sum(1 for c in feats if props[c] and props[c].derivation == "platform") / len(feats)) if feats else 0
        model_output = platform_share > 0.5
        pk = _pk_cols(card.grain)
        sym = next((c for c in pk if c in SYMBOL_COLS), None)
        date = next((c for c in pk if c in DATE_COLS), None)
        ts = next((c for c in pk if c in TIMESTAMP_COLS), None)
        extra = [c for c in pk if c not in (sym, date, ts) and c not in ("timeframe", "source")]
        cols_in_table = {b.column for b in onto.bindings_for_table(card.table)}
        capture = next((c for c in CAPTURE_COLS if c == card.freshness_column or c in cols_in_table), None)
        if sym and ts and not date:
            knowable, date_col, status, note = f"timestamp:{ts}", ts, "ready", "event table: the row's own timestamp"
        elif sym and date and capture:
            knowable, date_col, status, note = f"capture:{capture}", date, "ready", "snapshot: the capture timestamp"
        elif sym and date:
            lag = card.expected_lag_hours if card.expected_lag_hours is not None else DEFAULT_EOD_LAG_HOURS
            knowable, date_col, status, note = f"eod_plus:{lag}", date, "ready", f"close + {lag}h publication lag"
        else:
            knowable, date_col, status, note = "", date or ts, "needs_spec", f"grain {card.grain} is not one row per (symbol, date)"
        if status == "ready" and extra:
            status, note = "needs_spec", f"grain {card.grain} has extra key(s) {extra}: needs an aggregation rule"
        if "timeframe" in pk and status == "ready":
            note += "; filter timeframe before use"
        for col in feats:
            prop = props.get(col)
            if prop is None or prop.datatype not in NUMERIC or col in (sym, date, ts) or col in CAPTURE_COLS:
                continue
            why = note
            enabled = status == "ready" and prop.derivation in ("raw", "vendor")
            if card.table in SUPERSEDED:
                enabled, why = False, f"superseded: {SUPERSEDED[card.table]}"
            elif model_output:
                enabled, why = False, f"legacy model-output table ({platform_share:.0%} platform columns); {note}"
            out.append(MapEntry(card.table, col, sym, date_col, knowable, prop.derivation, card.training_use,
                                prop.timing, status, enabled,
                                why + (f"; caveats: {len(card.caveats)}" if card.caveats else "")))
    return out


def write_map(entries: list[MapEntry], path: Path = MAP_PATH) -> None:
    header = ("# GENERATED by `bqa legacy-map generate` from the legacy ontology (src/server/ontology).\n"
              "# Review before enabling more: `enabled` defaults to raw/vendor columns whose table maps one row\n"
              "# per (symbol, date). Legacy model outputs (derivation: platform) are listed, disabled.\n")
    path.write_text(header + yaml.safe_dump({"entries": [asdict(e) for e in entries]}, sort_keys=False, width=120))


def read_map(path: Path = MAP_PATH) -> list[MapEntry]:
    if not path.exists():
        return []
    return [MapEntry(**e) for e in (yaml.safe_load(path.read_text()) or {}).get("entries", [])]
