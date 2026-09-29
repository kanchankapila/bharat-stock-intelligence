"""The one list of live connectors. Monitoring (quality.checks) is generated from it."""
from __future__ import annotations

from bharat_alpha.ingest.base import Connector
from bharat_alpha.ingest.sources.fred import FredSeries
from bharat_alpha.ingest.sources.investsights import InvestsightsFundamentals
from bharat_alpha.ingest.sources.investsights_estimates import InvestsightsEstimates
from bharat_alpha.ingest.sources.mc_estimates import McEstimates
from bharat_alpha.ingest.sources.mc_global import McGlobal
from bharat_alpha.ingest.sources.mojo_shareholding import MojoShareholding
from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
from bharat_alpha.ingest.sources.nse_constituents import NseConstituents
from bharat_alpha.ingest.sources.nse_corporate import NseBoardMeetings, NseInsiderPit, NseResultsRss, NseSymbolChange
from bharat_alpha.ingest.sources.nse_equity_master import NseEquityMaster
from bharat_alpha.ingest.sources.nse_fo import NseFoBan, NseFoBhavcopy
from bharat_alpha.ingest.sources.nse_market import NseFiiDii, NseIndexClose, NseParticipantOi
from bharat_alpha.ingest.sources.nse_pr import NsePrBundle
from bharat_alpha.ingest.sources.nse_preopen import NsePreopen
from bharat_alpha.ingest.sources.nse_results import NseResults

# Order matters: cash bars create instruments that every other source resolves against.
CONNECTORS: dict[str, type[Connector]] = {
    c.name: c
    for c in (
        NseBhavcopy, NseSymbolChange, NseEquityMaster, NseFoBhavcopy, NseIndexClose, NseFiiDii, NseParticipantOi, NseFoBan, NsePrBundle,
        NseBoardMeetings, NseInsiderPit, NseResultsRss, InvestsightsFundamentals, InvestsightsEstimates, McEstimates, McGlobal, MojoShareholding, NsePreopen, NseConstituents, NseResults, FredSeries,
    )
}

# the listing master reconciles identity (ISINs, missed renames) before other sources resolve symbols
EOD_SEQUENCE = ("nse_bhavcopy", "nse_symbol_change", "nse_equity_master", "nse_fo_bhavcopy", "nse_index_close",
                "nse_fii_dii", "nse_participant_oi", "nse_fo_secban", "nse_pr_bc", "nse_board_meetings", "nse_insider_pit",
                "nse_results_rss")
# Per-stock vendor sweeps (~2 requests x ~2,000 names): run as their own step after EOD so a
# slow vendor cannot delay publication. Failures here never block the DAG.
VENDOR_SEQUENCE = ("mc_estimates", "investsights_fundamentals", "investsights_estimates", "mojo_shareholding", "mc_global", "nse_constituents", "nse_results", "fred_macro")
