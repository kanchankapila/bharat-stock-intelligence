"""
FIBO alignment — asserted *between* ontologies, never imported.

Decision record (2026-09-21)
----------------------------
FIBO (Financial Industry Business Ontology — EDM Council / OMG, MIT-licensed) was
evaluated as a possible backbone for this layer and deliberately rejected as one, for three
reasons:

1. **Coverage.** FIBO models contracts, parties, instruments and corporate events. The
   overwhelming majority of what makes `bharat_intel` valuable — screener appearances and
   their pre-tracked outcomes, confluence scores, signal outcomes under two different
   labelling rules, HMM regime gating, the adjusted-vs-raw price basis, freshness and
   point-in-time discipline — has no FIBO counterpart at all. In particular the three axes
   that a model consumer actually needs (timing: leading/coincident/lagging, leakage risk,
   and training-use verdict) are outside FIBO's scope entirely. FIBO cannot replace the
   property/card work; it can only annotate a minority of it.
2. **Cost.** The SEC + DER + MD + IND + FND + CAE closure is a large OWL 2 DL graph sitting
   on the OMG Commons modules, and drawing conclusions from it needs a reasoner (HermiT/ELK)
   or a triple store with RDFS/OWL-2-RL inference. This repo has neither, by design; adding
   one to obtain *documentation* is a bad trade.
3. **House rule.** This repo removes dependencies that nothing imports (pytorch-forecasting,
   pytorch-lightning, shap and ipython were all cut after a zero-import audit on 2026-09-11;
   root `requirements.txt` carries a comment saying not to re-add what CI does not pin). A
   multi-megabyte vendored ontology with no consumer is the same error at larger scale.

What *is* worth having is a mapping, which buys three things:
  - exports can be handed to external RDF tooling in FIBO terms (`export.py` emits these as
    `skos:*Match` triple, so GraphDB/Protégé/Stardog can consume the result without this
    repo ever reasoning over FIBO);
  - the ~20 concepts where FIBO genuinely has an equivalent get globally-meaningful IRIs
    instead of local ones, which is the real interop win (and is what makes the FIBO
    exercise worth doing at all);
  - and the boundary is *written down* — `no_counterpart()` names every concept FIBO does
    not cover and why, so nobody burns a sprint trying to force a vendor screener stream
    into `fibo-fbc-fi-fi:FinancialInstrument`.

Evidence discipline
-------------------
Every assertion carries `verified_from`: the URL its target term was confirmed to exist at,
fetched 2026-09-21. A mapping asserted from memory is exactly the class of unverified claim
`.claude/rules/measurement.md` forbids. Assertions whose target could not be confirmed are
kept with `strength="unverified"` and are **excluded from exports by default** — they are
visible for review, never emitted as if they were established.
"""
from dataclasses import dataclass
from typing import Dict, Tuple

# ── Verified FIBO namespaces ──────────────────────────────────────────────────
# Source: published FIBO prefix declarations + FIBO's own IRI space under
# spec.edmcouncil.org. Confirmed 2026-09-21. Note that post-Commons FIBO builds on the OMG
# Commons modules (cmns-*), which is why several assertions below land on Commons rather
# than on a FIBO domain module.

FIBO_BASE = "https://spec.edmcouncil.org/fibo/ontology/"

FIBO_PREFIXES: Dict[str, str] = {
    "fibo-sec-eq-eq": FIBO_BASE + "SEC/Equities/EquityInstruments/",
    "fibo-sec-sec-id": FIBO_BASE + "SEC/Securities/SecuritiesIdentification/",
    "fibo-sec-sec-iss": FIBO_BASE + "SEC/Securities/SecuritiesIssuance/",
    "fibo-sec-sec-lst": FIBO_BASE + "SEC/Securities/SecuritiesListings/",
    "fibo-fbc-fi-fi": FIBO_BASE + "FBC/FinancialInstruments/FinancialInstruments/",
    "fibo-fbc-fct-mkt": FIBO_BASE + "FBC/FunctionalEntities/Markets/",
    "fibo-fnd-acc-cur": FIBO_BASE + "FND/Accounting/CurrencyAmount/",
    "fibo-ind-mkt-bas": FIBO_BASE + "IND/MarketIndices/BasketIndices/",
    "fibo-cae-ce-ca": FIBO_BASE + "CAE/CorporateEvents/CorporateActions/",
    "fibo-der-der-futures": FIBO_BASE + "DER/DerivativesContracts/FuturesAndForwards/",
    "cmns-id": "https://www.omg.org/spec/Commons/Identifiers/",
    "cmns-dt": "https://www.omg.org/spec/Commons/DatesAndTimes/",
    "cmns-qtu": "https://www.omg.org/spec/Commons/QuantitiesAndUnits/",
    "cmns-cds": "https://www.omg.org/spec/Commons/CodesAndCodeSets/",
}


def fibo(curie: str) -> str:
    """Expand a FIBO CURIE, e.g. `fibo-sec-eq-eq:Equity`."""
    if ":" not in curie:
        return curie
    prefix, local = curie.split(":", 1)
    ns = FIBO_PREFIXES.get(prefix)
    return ns + local if ns else curie


@dataclass(frozen=True)
class AlignmentAssertion:
    """One asserted relationship between a local concept and an external one."""

    subject: str            # "bsi:Equity" or "bsip:close" or "bsiv:timeframe"
    predicate: str          # "skos:exactMatch" | "skos:closeMatch" | "skos:broadMatch"
    object: str             # FIBO/Commons CURIE
    rationale: str
    strength: str = "exact"        # exact | close | broad | narrow | unverified
    verified_from: str = ""

    @property
    def emitted(self) -> bool:
        """Unverified assertions exist for review but are never exported as fact."""
        return self.strength != "unverified"


# ── assertions ──

_MODULES_VERIFIED_FROM = (
    "https://github.com/edmcouncil/fibo (published prefix declarations) + FIBO IRI space "
    "under spec.edmcouncil.org; class symbols cross-checked against declared FIBO type "
    "stereotypes. Fetched 2026-09-21."
)


def assertions() -> Tuple[AlignmentAssertion, ...]:
    """Local concept -> external concept, with the strength of the claim made explicit."""

    def a(subject, predicate, obj, rationale, strength="close", verified=""):
        return AlignmentAssertion(subject, predicate, obj, rationale, strength, verified)

    out = [
        a("bsi:Instrument", "skos:closeMatch", "fibo-fbc-fi-fi:FinancialInstrument",
          "FIBO's root of the instrument hierarchy. Our hierarchy is shallower: one class "
          "per physical table rather than per contractual concept.", "close",
          _MODULES_VERIFIED_FROM),
        a("bsi:Equity", "skos:closeMatch", "fibo-sec-eq-eq:Equity",
          "CAUTION — GRANULARITY MISMATCH, and the most useful finding of this alignment. "
          "FIBO separates Equity (instrument), Share (ownership unit) and Listing "
          "(admission to an exchange). `stock_master` is keyed on the exchange ticker "
          "(`symbol`), so our `Equity` is really a *Listing*: one row per (instrument, "
          "exchange). A mapping that ignores this duplicates a company listed on both NSE "
          "and BSE. FIBO's ISIN-first keying is why the platform's ISIN coverage is a "
          "prerequisite for any real instrument master.", "close", _MODULES_VERIFIED_FROM),
        a("bsi:Equity", "skos:closeMatch", "fibo-sec-sec-lst:ListedSecurity",
          "The closer of the two FIBO classes to what `stock_master` actually stores, "
          "because row identity is the exchange ticker, not the instrument.",
          "close", _MODULES_VERIFIED_FROM),
        a("bsi:Exchange", "skos:closeMatch", "fibo-fbc-fct-mkt:Exchange",
          "NSE / BSE. FIBO's Exchange is a market operator; ours is a two-value dimension "
          "column, so the alignment is nominal.", "exact", _MODULES_VERIFIED_FROM),
        a("bsi:CompanyProfile", "skos:closeMatch", "fibo-fbc-fi-fi:Issuer",
          "The legal person behind the listing. Our description is free text; FIBO would "
          "carry structured legal-entity attributes.", "close", _MODULES_VERIFIED_FROM),
        a("bsi:CorporateAction", "skos:closeMatch", "fibo-cae-ce-ca:CorporateAction",
          "Our `action_type` is a flat vocabulary (DIVIDEND, SPLIT, BONUS, ...). FIBO "
          "expresses the same distinctions as an explicit subclass hierarchy with mandatory "
          "dates and ratios — adequate for price adjustment, insufficient for contractual "
          "reporting.", "close", _MODULES_VERIFIED_FROM),
        a("bsi:Index", "skos:closeMatch", "fibo-ind-mkt-bas:MarketIndex",
          "NIFTY 50 / BANK NIFTY / SENSEX. `fibo-ind-mkt-bas` (BasketIndices) is confirmed "
          "as the right module for index concepts.", "close", _MODULES_VERIFIED_FROM),
        a("bsi:FuturesPositioning", "skos:closeMatch", "fibo-der-der-futures:FinancialFuture",
          "NOT CONFIRMED — the DER module path was not checked against FIBO's published "
          "catalog during this build. Kept at 'unverified': visible for review, excluded "
          "from exports until someone confirms the IRI exists.", "unverified", ""),
        a("bsi:OptionChainRow", "skos:closeMatch", "fibo-der-der-options:Option",
          "NOT CONFIRMED — same reason as the futures assertion above. FIBO does model "
          "options; the exact IRI was not verified in this session.", "unverified", ""),

        # ── properties: where the payoff actually is ──
        a("bsip:symbol", "skos:closeMatch", "fibo-sec-sec-id:TickerSymbol",
          "Ours is simultaneously the ticker AND the platform's primary join key across "
          "~40 tables. FIBO treats a ticker as one identifier among several on a listing, "
          "which is why FIBO-correct joins key on the instrument rather than the ticker.",
          "exact", _MODULES_VERIFIED_FROM),
        a("bsip:close", "skos:closeMatch", "fibo-sec-eq-eq:PricePerShare",
          "Per-share closing price. The gap that matters: FIBO's price carries a currency; "
          "ours carries an implicit INR plus a separate `adjustment_basis` column "
          "(nse_bhavcopy_raw | split_only | split_dividend). FIBO has no property-level "
          "raw-vs-adjusted distinction, so `adjustment_basis` is a local extension this "
          "alignment cannot supply — and the basis trap is a live bug class in this repo.",
          "exact", _MODULES_VERIFIED_FROM),
        a("bsip:market_cap", "skos:closeMatch", "fibo-ind-mkt-bas:MarketCapitalization",
          "Highest-confidence mapping in the file. The stored unit is declared nowhere in "
          "the schema; FIBO would force an explicit MonetaryAmount with a currency.",
          "exact", _MODULES_VERIFIED_FROM),
        a("bsip:value_cr", "skos:closeMatch", "fibo-fnd-acc-cur:MonetaryAmount",
          "Block-deal value held in CRORES as a bare float. FIBO requires amount plus "
          "currency; our column carries neither, so a consumer must know the multiplier "
          "out of band. Exactly the ambiguity this alignment exists to surface.",
          "exact", _MODULES_VERIFIED_FROM),
        a("bsip:value_inr", "skos:closeMatch", "fibo-fnd-acc-cur:MonetaryAmount",
          "Insider-transaction value in rupees, again as a bare number with no currency "
          "term attached.", "exact", _MODULES_VERIFIED_FROM),
    ]
    return tuple(out)


# ── the boundary: where FIBO does not help ────────────────────────────────────
#
# This is the half of the alignment that saves work. Each entry names a local concept FIBO
# cannot carry, and why, so nobody tries to force a screener-appearance stream into
# `fibo-fbc-fi-fi:FinancialInstrument` or model a 9.2M-row outcome ledger as a contract.
#
# reason values:
#   platform_specific — a concept of this platform's own construction
#   out_of_scope      — belongs to a different ontology family (PROV-O, DCAT, news/NLP)
#   gap               — FIBO would cover it, but this repo's data does not support it yet
#   unconfirmed       — might be covered; not verified in this session


def no_counterpart() -> Tuple[Tuple[str, str, str], ...]:
    """(local concept, reason, explanation) for every concept deliberately left unaligned."""
    return (
        ("bsi:ScreenerAppearance", "platform_specific",
         "A vendor screener's membership stream with forward outcomes pre-tracked at "
         "surfacing time. A data-vendor artifact, not a financial concept."),
        ("bsi:ScreenerOutcome", "platform_specific",
         "The pre-tracked forward returns attached to those appearances (9.2M rows). No "
         "external ontology models 'what happened after a screener surfaced a name'."),
        ("bsi:EdgeReading", "platform_specific",
         "`factor_edge_history` is this platform's own measurement ledger — rank-IC and AUC "
         "per factor, regime and horizon, with an independent-observation guard. FIBO has no "
         "concept of evidence quality over a date panel."),
        ("bsi:Recommendation", "platform_specific",
         "`unified_score` is a composite of this platform's engines with a tracked per-engine "
         "track record. FIBO's nearest analogue is a research recommendation — a different "
         "object with a different lifecycle and no track record."),
        ("bsi:SignalOutcome", "platform_specific",
         "Our labels come from two non-comparable rules (`path_barrier` vs "
         "`terminal_pct2`). That distinction is internal and load-bearing; no external "
         "vocabulary carries it."),
        ("bsi:FeatureVector", "platform_specific",
         "`feature_store` columns are re-expressed price and vendor data — features, not "
         "financial concepts. Mapping them outward would create false semantic weight and "
         "invite a model to treat a derived column as an observed fact."),
        ("bsi:RegimeState", "platform_specific",
         "HMM state plus a weight-gate role: derived market state on this platform, not an "
         "externally-defined regime."),
        ("bsi:BreadthObservation", "platform_specific",
         "Breadth statistics are context filters computed over this platform's own universe "
         "definition."),
        ("bsi:EventTrigger", "platform_specific",
         "Composite trigger classes (SCREENER_SUPPORT_FADING, CROWDED_NEWS) are internal "
         "detector output with inline thresholds."),
        ("bsi:NewsItem", "out_of_scope",
         "News sentiment belongs to a news/NLP vocabulary. FIBO's agent classes do not model "
         "sentiment scores."),
        ("bsi:JobRun", "out_of_scope",
         "Operational provenance — PROV-O is the right family (already in this ontology's "
         "namespace map), not FIBO."),
        ("bsi:DataQualityCheck", "out_of_scope",
         "Data-governance concept, not a financial one."),
        ("bsi:Endpoint", "out_of_scope",
         "The 3,408-row discovery registry is a scraping/provenance asset; DCAT or an "
         "API-description vocabulary fits, FIBO does not."),
        ("bsi:BlockDeal", "unconfirmed",
         "Securities transactions may exist in a FIBO module not checked this session. Left "
         "unaligned rather than asserted from memory."),
        ("bsi:InsiderTransaction", "unconfirmed",
         "Insider/regulatory transaction reporting is outside FIBO's confirmed scope; a "
         "regulatory-reporting vocabulary would be the better target."),
    )


#: Property-level boundary records — the same discipline as `no_counterpart()`, but
#: for datatype properties. Kept as a separate table because the class-level boundary
#: (and its export test) tracks classes; these ride into the artifacts as
#: `bsi:noExternalCounterpart` in exactly the same way.
def property_boundary() -> Tuple[Tuple[str, str, str], ...]:
    """(property, reason, explanation) for properties deliberately left unaligned."""
    return (
        ("bsip:win_probability", "platform_specific",
         "Isotonic-banded model output. Must never be read as a FIBO-style quoted rate "
         "or as the probability of a contractual event."),
        ("bsip:sector", "gap",
         "FIBO classifies entities through industry schemes. The platform stores sector "
         "as free text written fetcher-side and populated only downstream — not alignable "
         "until a scheme is settled."),
    )


def emitted_assertions() -> Tuple[AlignmentAssertion, ...]:
    """Assertions strong enough to export — everything except `unverified`."""
    return tuple(x for x in assertions() if x.emitted)


def alignment_summary() -> Dict[str, int]:
    """How much of the ontology FIBO can even speak to. Reported by `coverage`."""
    by_strength: Dict[str, int] = {}
    for x in assertions():
        by_strength[x.strength] = by_strength.get(x.strength, 0) + 1
    by_strength["no_counterpart"] = len(no_counterpart())
    return by_strength
