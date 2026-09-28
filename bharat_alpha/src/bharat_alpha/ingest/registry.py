"""The one list of live connectors. Monitoring (quality.checks) is generated from it."""
from __future__ import annotations

from bharat_alpha.ingest.base import Connector
from bharat_alpha.ingest.sources.investsights import InvestsightsFundamentals
from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
from bharat_alpha.ingest.sources.nse_corporate import NseBoardMeetings, NseInsiderPit, NseSymbolChange
from bharat_alpha.ingest.sources.nse_fo import NseFoBhavcopy
from bharat_alpha.ingest.sources.nse_market import NseFiiDii, NseIndexClose

# Order matters: cash bars create instruments that every other source resolves against.
CONNECTORS: dict[str, type[Connector]] = {
    c.name: c
    for c in (
        NseBhavcopy, NseSymbolChange, NseFoBhavcopy, NseIndexClose, NseFiiDii,
        NseBoardMeetings, NseInsiderPit, InvestsightsFundamentals,
    )
}

EOD_SEQUENCE = ("nse_bhavcopy", "nse_symbol_change", "nse_fo_bhavcopy", "nse_index_close",
                "nse_fii_dii", "nse_board_meetings", "nse_insider_pit")
