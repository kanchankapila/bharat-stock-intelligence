import os
import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "live_datasource: hits a real external API/URL for one real ticker/screener and "
        "checks the response + DB storage. Skipped by default (network-dependent, not run "
        "in CI) — opt in with RUN_LIVE_DATASOURCE_TESTS=1.",
    )


def pytest_collection_modifyitems(config, items):
    if os.environ.get("RUN_LIVE_DATASOURCE_TESTS") == "1":
        return
    skip_live = pytest.mark.skip(
        reason="live_datasource test skipped — set RUN_LIVE_DATASOURCE_TESTS=1 to run "
               "(hits a real external URL, not run by default or in CI)"
    )
    for item in items:
        if "live_datasource" in item.keywords:
            item.add_marker(skip_live)
