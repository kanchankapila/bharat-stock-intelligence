#!/usr/bin/env python3
"""
Screener-name → concept-tag decomposition.

Why this exists: `measurement.md` records that all 1,563 screeners tested one-at-a-time
survive neither FDR nor Bonferroni. That is a power problem as much as an edge problem --
a single screener contributes a handful of (symbol, date) rows, so nothing can clear a
1,563-way correction even if it were real. Collapsing the 1,534-name catalog onto ~30
orthogonal, name-derived concept tags turns a sparse 1,563-column membership matrix into a
dense one whose cells have enough observations for `screener_combo_finder.py`'s day-level
t-test to say anything at all. The tags are the unit that combination search should run on;
the individual screener is not.

Pure stdlib and pure function of the name string -- no DB, no network -- so it is testable
without production access and safe to import from any of the three services.

**The polarity a name implies is a HINT and is NOT to be trusted as a direction.**
`measurement.md`: screener sentiment labels are keyword-classified off the name and are
measurably inverted (bullish minus bearish = -0.11pp, t=-4.61), and bullish consensus is
significantly negative (t=-2.36). `polarity_hint()` exists so a caller can *measure* whether
a tag's realized direction agrees with its name, not so a caller can skip measuring.

Run:
    python screener_name_concepts.py --csv screener_names.csv --coverage
"""
from __future__ import annotations

import argparse
import csv
import re
from collections import Counter
from dataclasses import dataclass, field

# ── name normalization ────────────────────────────────────────────────────────────────
# ETnow rows in screener_names.csv carry the screener's description glued directly onto the
# end of its title with no separator ("High Dividend Yield StocksIdentifies stocks with...")
# and some repeat the title verbatim ("IT Enabled Services StocksIT Enabled Services
# Stocks"). Both are upstream artifacts, not real distinct names -- left uncollapsed they
# split one concept across several tag sets and inflate apparent catalog diversity.
_GLUED_BOUNDARY = re.compile(r"(?<=[a-z])(?=[A-Z])")
# Domain terms that are themselves camelCase — YoY, QoQ, MoM, PoP, FnO — all share the shape
# [A-Z][a-z][A-Z], and a naive split lands *inside* them: "Strong QoQ EPS Growth in recent
# results" became "Strong Qo", losing the quarterly/growth/results content of the name
# entirely. Caught by negative-controlling the test, which passed against the broken parser
# because the mangling removed the very tag the test was asserting on.
_CAMEL_TOKEN = re.compile(r"[A-Z][a-z][A-Z]")


# Two different naming systems feed this module. Human screener names (Trendlyne/ETnow/
# MoneyControl) are prose and need the run-on-description de-glue below. The NiftyTrader
# live-screener `filter_key`s -- which ARE screener_combo_finder.py's tier-2 feature set --
# are camelCase identifiers ("todayGapUP", "range52WeekHigh"), where the de-glue's
# split-once-and-keep-the-head rule truncates to "today"/"range52week" and drops the concept
# entirely. Whitespace is the discriminator: prose always has some, an identifier never does.
_IDENT_BOUNDARY = re.compile(
    r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-zA-Z])(?=\d)|(?<=\d)(?=[a-zA-Z])")


def normalize_name(name: str) -> str:
    """Lowercase, split an identifier or de-glue a run-on description, collapse whitespace."""
    if not name:
        return ""
    stripped = name.strip()
    if not re.search(r"\s", stripped):
        return re.sub(r"\s+", " ", _IDENT_BOUNDARY.sub(" ", stripped).lower()).strip()
    head = stripped
    for match in _GLUED_BOUNDARY.finditer(stripped):
        i = match.start()
        if i >= 2 and _CAMEL_TOKEN.match(stripped[i - 2:i + 1]):
            continue  # inside YoY/QoQ/FnO — not a title→description boundary
        # A head this short is a degenerate split, not a real title; keep the whole string
        # rather than a fragment that matches nothing.
        if i >= 4:
            head = stripped[:i]
        break
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9%+.\- ]+", " ", head.lower())).strip()


# ── concept vocabulary ────────────────────────────────────────────────────────────────
# (tag, facet, pattern). Facets are orthogonal on purpose: a name can and should carry a
# timeframe AND a mechanism AND a flow tag at once, because the whole point is to search
# combinations across facets rather than within one.
CONCEPT_PATTERNS: list[tuple[str, str, str]] = [
    # timeframe
    ("tf_intraday_min", "timeframe", r"\b\d+\s*min\b"),
    ("tf_intraday_hour", "timeframe", r"\b\d\s*h\b|\bhourly\b"),
    ("tf_daily", "timeframe", r"\bday\b|\bdaily\b|\btoday\b|\bintraday\b"),
    ("tf_weekly", "timeframe", r"\bweek\b|\bweekly\b"),
    ("tf_monthly", "timeframe", r"\bmonth\b|\bmonthly\b"),
    ("tf_quarterly", "timeframe", r"\bquarter|\bqoq\b"),
    ("tf_annual", "timeframe", r"\bannual|\byoy\b|\byear\b|\byearly\b"),
    # price mechanism
    # Both orderings occur in the live catalog and mean the same thing: Trendlyne writes
    # "SMA100", ETnow/MoneyControl write "100Day EMA". Matching only one silently drops the
    # other family from combination search -- caught by --coverage, not by reading the regex.
    ("mech_ma_stack", "mechanism", r"\b[se]ma\s*\d+\b|\b\d+\s*-?\s*(day\s*)?[se]ma\b|moving average"),
    ("mech_crossover", "mechanism", r"\bcross(ing|ed|over)?\b|golden cross|death cross"),
    ("mech_breakout", "mechanism", r"breakout|breaking out|\bbreach|new high|\borb\b"),
    ("mech_breakdown", "mechanism", r"breakdown|breaking down|new low"),
    ("mech_gap", "mechanism", r"\bgap\b|\bgaps\b"),
    ("mech_52w_high", "mechanism", r"52\s*-?\s*week high|52w high|all.time high"),
    ("mech_52w_low", "mechanism", r"52\s*-?\s*week low|52w low"),
    # The tier-1 open_eq_high/open_eq_low concept -- a leg of the ONE combination that has
    # survived measurement here (the capitulation triple) -- had no tag at all until the
    # NiftyTrader keys made the gap visible: prose names rarely say it, every live filter set does.
    ("mech_open_extreme", "mechanism", r"\bopen(ed|s)?\s*(=|eq|at)?\s*(the\s+)?(day'?s\s+)?(high|low)\b"),
    ("mech_supertrend", "mechanism", r"supertrend"),
    ("mech_bollinger", "mechanism", r"bollinger|\bbb\b"),
    ("mech_candlestick", "mechanism", r"harami|doji|engulfing|hammer|marubozu|candle|star\b"),
    ("mech_divergence", "mechanism", r"divergence"),
    ("mech_oscillator", "mechanism", r"\brsi\b|\bcci\b|\bmfi\b|williams|stochastic|\bmacd\b|\badx\b|oscillator"),
    ("mech_overbought", "mechanism", r"overbought"),
    ("mech_oversold", "mechanism", r"oversold"),
    ("mech_momentum", "mechanism", r"momentum|trending up|trending down|\btrend\b|higher high|lower low"),
    ("mech_reversal", "mechanism", r"reversal|pullback|bounce|recovery"),
    ("mech_relative_strength", "mechanism", r"relative (out|under)performance|versus (nifty|industry|sector)|outperform|underperform"),
    ("mech_volatility", "mechanism", r"volatil|\batr\b|\bnr\s*7\b|inside day|outside day"),
    ("mech_consolidation", "mechanism", r"consolidat|\brange bound\b|sideways"),
    ("mech_pivot_level", "mechanism", r"\bpivot\b|support level|\bresistance\b|\bsupport\b"),
    # volume / participation
    ("flow_volume_surge", "participation", r"volume (shocker|spike|surge|breakout)|high volume|rising volume|volume gainer"),
    ("flow_delivery", "participation", r"delivery"),
    ("flow_institutional", "participation", r"mutual fund|\bmf\b|\bfii\b|\bdii\b|institution"),
    ("flow_promoter", "participation", r"promoter|pledge"),
    ("flow_shareholding", "participation", r"shareholding|holding (increase|decrease)|public holding"),
    ("flow_insider", "participation", r"insider|bulk deal|block deal"),
    # fundamentals
    ("fund_valuation", "fundamental", r"\bpe\b|price to|valuation|undervalued|overvalued|\bp/[bes]\b|book value|graham|\bpeg\b"),
    ("fund_growth", "fundamental", r"growth|rising (net profit|revenue|sales|operating)|increasing (revenue|profit|sales)"),
    ("fund_quality", "fundamental", r"\broce\b|\broe\b|\brona\b|margin|piotroski|\bdvm\b|quality|strong performer|blue chip"),
    ("fund_dividend", "fundamental", r"dividend|payout|yield"),
    ("fund_debt", "fundamental", r"\bdebt\b|leverage|interest coverage|solvency|altman|\bz-score\b"),
    # events / expectations
    ("event_results", "event", r"\bresult|earnings|announced result|net profit (positive|negative) surprise"),
    ("event_surprise", "event", r"surprise|beat|miss\b"),
    ("event_corporate_action", "event", r"bonus|split|buyback|rights issue|merger|demerger|acquisition|dividend declared"),
    ("event_analyst", "event", r"analyst|forecaster|target price|upgrade|downgrade|estimate|recommendation"),
    # descriptive (NOT a signal -- see below)
    ("desc_sector_theme", "descriptive", r"\bsector\b|\bindustry\b|theme|stocks affected by|connection\b|monsoon|crude"),
    ("desc_market_cap", "descriptive", r"large.?cap|mid.?cap|small.?cap|micro.?cap|penny"),
    ("desc_index_member", "descriptive", r"nifty \d+|sensex|bse \d+|index constituent"),
    ("desc_group_list", "descriptive", r"\bgroup\b|companies list|stocks in india|stock list|surveillance"),
]

_COMPILED = [(tag, facet, re.compile(pat)) for tag, facet, pat in CONCEPT_PATTERNS]

# Tags that describe WHAT A COMPANY IS rather than what its price is doing. `scoring_engine.py`
# scored these as bearish evidence for months (see recurring-bugs.md's neutral-tag entry);
# they carry no same-day directional content and must never be treated as a signal leg. They
# are still useful as a CONTROL/interaction (does a mechanism behave differently inside a sector?).
DESCRIPTIVE_FACETS = frozenset({"descriptive"})

_UP_PATTERNS = re.compile(
    r"\bbullish\b|\bbuy\b|\bup\b|rising|increas|gain|outperform|breakout|golden cross|"
    r"above\b|positive|strong|surge|higher high|oversold|accumulat|upgrade")
_DOWN_PATTERNS = re.compile(
    r"\bbearish\b|\bsell\b|\bdown\b|falling|decreas|loss|underperform|breakdown|death cross|"
    r"below\b|negative|weak|slump|lower low|overbought|declin|downgrade|red flag")


@dataclass
class ConceptTags:
    name: str
    normalized: str
    tags: list[str] = field(default_factory=list)
    facets: dict[str, list[str]] = field(default_factory=dict)
    polarity_hint: int = 0
    same_day_relevant: bool = False

    @property
    def signal_tags(self) -> list[str]:
        """Tags excluding purely descriptive ones -- the legs a combination may use."""
        descriptive = {t for f in DESCRIPTIVE_FACETS for t in self.facets.get(f, [])}
        return [t for t in self.tags if t not in descriptive]


def polarity_hint(normalized: str) -> int:
    """+1 / -1 / 0 implied by the name's wording. UNVALIDATED BY CONSTRUCTION -- this is the
    exact keyword heuristic `measurement.md` measured as inverted. Use it as a variable to
    test against realized returns, never as a direction to trade."""
    up, down = len(_UP_PATTERNS.findall(normalized)), len(_DOWN_PATTERNS.findall(normalized))
    return 0 if up == down else (1 if up > down else -1)


def _same_day_relevant(facets: dict[str, list[str]]) -> bool:
    """Can this screener's concept plausibly resolve within one session?

    A same-day trade cannot be informed by a screener whose only content is an annual or
    quarterly fundamental fact -- that membership is near-constant week to week, so it
    contributes a stock that "qualifies" every day and predicts nothing about *which* day.
    Timeframe tokens in the name are the cheapest honest filter for this."""
    timeframes = set(facets.get("timeframe", []))
    if timeframes & {"tf_intraday_min", "tf_intraday_hour", "tf_daily"}:
        return True
    if timeframes & {"tf_quarterly", "tf_annual"} and not timeframes & {"tf_weekly", "tf_monthly"}:
        return False
    mechanisms = set(facets.get("mechanism", [])) | set(facets.get("participation", []))
    return bool(mechanisms)


def decompose(name: str) -> ConceptTags:
    normalized = normalize_name(name)
    facets: dict[str, list[str]] = {}
    tags: list[str] = []
    for tag, facet, pattern in _COMPILED:
        if pattern.search(normalized):
            tags.append(tag)
            facets.setdefault(facet, []).append(tag)
    return ConceptTags(
        name=name, normalized=normalized, tags=tags, facets=facets,
        polarity_hint=polarity_hint(normalized),
        same_day_relevant=_same_day_relevant(facets),
    )


def decompose_catalog(rows: list[dict]) -> list[tuple[dict, ConceptTags]]:
    """rows need `screener_name`; `source` is lowercased on the way through because
    `screener_catalog` carries the same source under several casings (recurring-bugs.md's
    screener_catalog case-collision entry) and any join keyed on it must normalize first."""
    out = []
    for row in rows:
        row = dict(row)
        if row.get("source"):
            row["source"] = row["source"].strip().lower()
        out.append((row, decompose(row.get("screener_name", ""))))
    return out


def _coverage_report(path: str, show_uncovered: int) -> None:
    """Honest self-audit: which names does the vocabulary actually match, and which does it
    silently miss? An uncovered name contributes no tag and vanishes from combination search
    without erroring -- exactly the class of silent gap this repo keeps getting bitten by."""
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    decomposed = decompose_catalog(rows)

    tag_counts, facet_counts = Counter(), Counter()
    uncovered, same_day = [], 0
    for row, concept in decomposed:
        if not concept.signal_tags:
            uncovered.append(row.get("screener_name", ""))
        tag_counts.update(concept.tags)
        facet_counts.update(concept.facets.keys())
        same_day += concept.same_day_relevant

    n = len(decomposed)
    print(f"catalog: {n} screeners from {path}")
    print(f"covered by >=1 signal tag: {n - len(uncovered)} ({(n - len(uncovered)) / n:.1%})")
    print(f"same-day relevant:         {same_day} ({same_day / n:.1%})")
    print(f"distinct tags fired:       {len(tag_counts)} of {len(CONCEPT_PATTERNS)}\n")

    print(f"{'tag':<26} {'facet':<14} {'screeners':>9}")
    for tag, facet, _ in CONCEPT_PATTERNS:
        print(f"{tag:<26} {facet:<14} {tag_counts.get(tag, 0):>9}")

    never = [t for t, _, _ in CONCEPT_PATTERNS if not tag_counts.get(t)]
    if never:
        print(f"\nTAGS THAT NEVER FIRE ({len(never)}) -- dead vocabulary, fix or drop: {', '.join(never)}")
    if uncovered and show_uncovered:
        print(f"\nUNCOVERED NAMES ({len(uncovered)}), first {show_uncovered}:")
        for name in uncovered[:show_uncovered]:
            print(f"  {name[:100]}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Decompose screener names into concept tags")
    parser.add_argument("--csv", default="screener_names.csv")
    parser.add_argument("--coverage", action="store_true")
    parser.add_argument("--show-uncovered", type=int, default=25)
    parser.add_argument("--name", help="decompose a single name and exit")
    args = parser.parse_args()

    if args.name:
        c = decompose(args.name)
        print(f"normalized:       {c.normalized}")
        print(f"tags:             {', '.join(c.tags) or '(none)'}")
        print(f"signal tags:      {', '.join(c.signal_tags) or '(none)'}")
        print(f"polarity hint:    {c.polarity_hint}  (UNVALIDATED -- measure, do not trade)")
        print(f"same-day relevant:{c.same_day_relevant}")
    else:
        _coverage_report(args.csv, args.show_uncovered)
