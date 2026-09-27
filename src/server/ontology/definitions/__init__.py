"""
The authored ontology, assembled from one module per concern.

    classes.py      the entity types, grouped by layer, with an explicit abstraction tree
    properties.py   datatype properties carrying semantics (timing, leakage, units)
    bindings.py     the physical mapping: (table, column) -> property
    cards.py        table-level data cards (grain, cadence, caveats, training-use verdict)
    relations.py    typed edges with the table that realizes each one and its graded status
    metrics.py      semantically-named measures with runnable, EXPLAIN-validated SQL

Order matters only for readability; `build_ontology()` assembles and the test suite runs
`Ontology.validate()` over the result, which is what actually enforces coherence.

Conventions used throughout
---------------------------
* Table and column names are copied **verbatim** from the live database. A typo here fails
  `tests/test_ontology_definitions.py` against live `information_schema`, which is the
  intended behaviour: this layer is only useful if it is exactly right.
* Every semantic claim that came from a measurement says where it came from (an audit ID, a
  report section, or a dated live check). Claims that were not measured are marked as
  candidates, never as edges.
"""
from .cards import cards
from .classes import classes
from .bindings import bindings
from .metrics import metrics
from .properties import properties
from .relations import relations

from .. import vocab
from ..model import Ontology


def build_ontology() -> Ontology:
    """Assemble the ontology. Cheap enough to call per test; no I/O, no DB."""
    return Ontology(
        version=vocab.ONTOLOGY_VERSION,
        classes=classes(),
        properties=properties(),
        cards=cards(),
        bindings=bindings(),
        relations=relations(),
        metrics=metrics(),
        vocabularies=vocab.vocabularies(),
    )
